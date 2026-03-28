/**
 * handlers/navigate.ts - Pure navigate handlers (DAG: no circular dependencies).
 *
 * Each handler takes params + deps, returns McpToolResponse.
 * ZERO side effects beyond engine/parser calls.
 * Heartbeat wrapping is the router's responsibility.
 */

import path from "path";
import type Parser from "web-tree-sitter";
import type { McpToolResponse, NavigateParams, RouterDependencies } from "../router.js";
import { Embedder } from "../embedder.js";
import { safePath } from "../utils/path-jail.js";
import { readSource } from "../utils/read-source.js";
import {
    findDefinition,
    findReferences,
    getFileSymbols,
    type SymbolKind,
    type ReferenceResult,
} from "../ast-navigator.js";
import { getPinnedText, listPins } from "../pin-memory.js";
import { extractDependencies, cleanSignature, isSensitiveSignature, escapeRegExp } from "../utils/imports.js";
import { logger } from "../utils/logger.js";

// ─── Search ─────────────────────────────────────────────────────────

export async function handleSearch(
    params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    const query = params.query ?? "";

    const stats = engine.getStats();
    if (stats.filesIndexed === 0) {
        await engine.indexDirectory(process.cwd());
    }

    const limit = typeof params.limit === "number" ? Math.min(50, Math.max(1, params.limit)) : 10;
    const include_raw = params.include_raw === true;

    const results = await engine.search(query, limit);

    if (results.length === 0) {
        return {
            content: [{
                type: "text" as const,
                text:
                    `No results found for: "${query}"\n\n` +
                    `Indexed ${engine.getStats().filesIndexed} files with ${engine.getStats().totalChunks} chunks.\n` +
                    `Try a broader query or index more directories.\n\n` +
                    `[NREKI saved ~0 tokens on this query]`,
            }],
        };
    }

    const formatted = results.map((r, i) => {
        const cleanPath = path.relative(process.cwd(), r.path).replace(/\\/g, "/");
        const header = `### ${i + 1}. ${cleanPath}:L${r.startLine}-L${r.endLine}`;

        let ext = path.extname(r.path).slice(1).toLowerCase();
        let lang = ext;
        let commentPrefix = "//";

        if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) { lang = 'typescript'; commentPrefix = '//'; }
        else if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) { lang = 'javascript'; commentPrefix = '//'; }
        else if (ext === 'py') { lang = 'python'; commentPrefix = '#'; }
        else if (ext === 'go') { lang = 'go'; commentPrefix = '//'; }
        else if (!lang) { lang = 'typescript'; commentPrefix = '//'; }

        let sensoryTag = "";
        if (r.topology && r.topology.tier !== "orphan") {
            if (r.topology.isEpicenter && r.topology.inDegree > 0) {
                const alert = r.topology.tier === "core" ? "☢️ CRITICAL CORE" : "⚠️ LOGIC HUB";
                const depsStr = r.topology.dependents && r.topology.dependents.length > 0 ? ` (Imports: ${r.topology.dependents.join(", ")}...)` : "";
                sensoryTag = `${commentPrefix} [EPICENTER | BLAST RADIUS: ${r.topology.inDegree} dependents | ${alert}]${depsStr}\n`;
            } else if (r.topology.isBlastRadius) {
                sensoryTag = `${commentPrefix} [COUPLED CONSUMER | Affected by changes to search target]\n`;
            } else if (r.topology.inDegree > 0) {
                sensoryTag = `${commentPrefix} [DEPENDENCIES: ${r.topology.inDegree} files rely on this]\n`;
            }
        }

        const shorthand = `\`\`\`${lang}\n${sensoryTag}${r.shorthand}\n\`\`\``;

        const rawSection = include_raw
            ? `\n<details><summary>Full source</summary>\n\n\`\`\`${lang}\n${r.rawCode}\n\`\`\`\n</details>`
            : "";
        const score = `Score: ${r.score.toFixed(4)} | Type: ${r.nodeType}`;
        return `${header}\n${shorthand}\n${score}${rawSection}`;
    });

    const seenFiles = new Set<string>();
    let grepEstimate = 0;
    for (const r of results) {
        if (!seenFiles.has(r.path)) {
            seenFiles.add(r.path);
            grepEstimate += Embedder.estimateTokens(r.rawCode) * 5;
        }
    }

    const resultText = `## NREKI Search: "${query}"\n` +
        `Found ${results.length} results across ${new Set(results.map(r => r.path)).size} files.\n\n` +
        formatted.join("\n\n");

    const searchTokens = Embedder.estimateTokens(resultText);
    const saved = Math.max(0, grepEstimate - searchTokens);

    const finalText = resultText + `\n\n[NREKI saved ~${saved.toLocaleString()} tokens on this query (estimated)]`;

    engine.logUsage("nreki_search", searchTokens, searchTokens, saved);

    return {
        content: [{
            type: "text" as const,
            text: finalText,
        }],
    };
}

// ─── Definition ─────────────────────────────────────────────────────

export async function handleDefinition(
    params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    const symbol = params.symbol ?? "";
    const root = engine.getProjectRoot();
    const parser = engine.getParser();
    const kind = typeof params.kind === "string" ? params.kind : "any";
    const results = await findDefinition(root, parser, symbol, kind as SymbolKind);

    if (results.length === 0) {
        return {
            content: [{
                type: "text" as const,
                text:
                    `No definition found for symbol: "${symbol}"` +
                    (kind !== "any" ? ` (kind: ${kind})` : "") +
                    `\n\n[NREKI saved ~0 tokens]`,
            }],
        };
    }

    const formatted = results.map((r, i) => {
        const exported = r.exportedAs ? ` [exported: ${r.exportedAs}]` : "";
        return (
            `### ${i + 1}. ${r.filePath}:L${r.startLine}-L${r.endLine} (${r.kind}${exported})\n` +
            `**Signature:** \`${r.signature}\`\n` +
            `\`\`\`\n${r.body}\n\`\`\``
        );
    });

    const bodyTokens = results.reduce(
        (sum, r) => sum + Embedder.estimateTokens(r.body), 0,
    );

    const autoContext = params.auto_context !== false;
    let autoContextBlock = "";
    let extraTokens = 0;

    if (autoContext && results.length > 0) {
        try {
            const targetResult = results[0];
            const ext = path.extname(targetResult.filePath).toLowerCase();
            const fileContent = readSource(safePath(root, targetResult.filePath));

            const allImports = extractDependencies(fileContent, ext);

            const usedDeps = allImports.filter(d => {
                const safeName = escapeRegExp(d.localName);
                const regex = new RegExp(`(^|[^a-zA-Z0-9_$])${safeName}(?=[^a-zA-Z0-9_$]|$)`);
                return results.some(r => regex.test(r.body));
            });

            if (usedDeps.length > 0) {
                const rawSignatures = engine.resolveImportSignatures(usedDeps.slice(0, 10));
                const safeSigs = rawSignatures
                    .map(s => `- \`${cleanSignature(s.raw)}\` (from ${path.basename(s.path)})`)
                    .filter(s => !isSensitiveSignature(s));

                if (safeSigs.length > 0) {
                    autoContextBlock =
                        `\n\n### Related Signatures (auto-detected, may be incomplete)\n` +
                        `NREKI resolved these external dependencies used in the definition:\n` +
                        safeSigs.join("\n");
                    extraTokens = Embedder.estimateTokens(autoContextBlock);
                    engine.incrementAutoContext();
                }
            }
        } catch {
            // Never crash the tool on auto-context failure
        }
    }

    engine.logUsage("nreki_navigate:definition", bodyTokens + extraTokens, bodyTokens + extraTokens, 0);

    return {
        content: [{
            type: "text" as const,
            text:
                `## Definition: ${symbol}\n` +
                `Found ${results.length} definition(s).\n\n` +
                formatted.join("\n\n") +
                autoContextBlock +
                `\n\n[NREKI: ${(bodyTokens + extraTokens).toLocaleString()} tokens - exact AST lookup, no search overhead]`,
        }],
    };
}

// ─── References ─────────────────────────────────────────────────────

export async function handleReferences(
    params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    const symbol = params.symbol ?? "";
    const root = engine.getProjectRoot();
    const parser = engine.getParser();
    const results = await findReferences(root, parser, symbol);

    if (results.length === 0) {
        return {
            content: [{
                type: "text" as const,
                text: `No references found for: "${symbol}"\n\n[NREKI saved ~0 tokens]`,
            }],
        };
    }

    const byFile = new Map<string, ReferenceResult[]>();
    for (const ref of results) {
        const arr = byFile.get(ref.filePath) || [];
        arr.push(ref);
        byFile.set(ref.filePath, arr);
    }

    const formatted: string[] = [];
    for (const [file, refs] of [...byFile.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
        formatted.push(`### ${file} (${refs.length} reference${refs.length > 1 ? "s" : ""})`);
        for (const ref of refs) {
            formatted.push(`**L${ref.line}:**`);
            formatted.push(`\`\`\`\n${ref.context}\n\`\`\``);
        }
    }

    const refTokens = results.reduce(
        (sum, r) => sum + Embedder.estimateTokens(r.context), 0,
    );

    engine.logUsage("nreki_refs", refTokens, refTokens, 0);

    return {
        content: [{
            type: "text" as const,
            text:
                `## References: ${symbol}\n` +
                `Found ${results.length} reference(s) across ${byFile.size} file(s).\n\n` +
                formatted.join("\n") +
                `\n\n[NREKI: ${refTokens.toLocaleString()} tokens]`,
        }],
    };
}

// ─── Outline ────────────────────────────────────────────────────────

export async function handleOutline(
    params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    const file = params.path ?? "";
    const root = engine.getProjectRoot();
    let resolvedPath: string;
    try {
        resolvedPath = safePath(root, file);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}\n\n[NREKI saved ~0 tokens]`,
            }],
        };
    }

    const parser = engine.getParser();
    const symbols = await getFileSymbols(resolvedPath, parser, root);

    if (symbols.length === 0) {
        return {
            content: [{
                type: "text" as const,
                text:
                    `No symbols found in: ${file}\n` +
                    `(File may be empty, unsupported, or contain no declarations.)\n\n` +
                    `[NREKI saved ~0 tokens]`,
            }],
        };
    }

    const relPath = path.relative(root, resolvedPath).replace(/\\/g, "/");
    const lines = [`## Outline: ${relPath}`, `${symbols.length} symbol(s)`, ""];

    for (const sym of symbols) {
        const exported = sym.exportedAs ? ` [${sym.exportedAs}]` : "";
        lines.push(
            `- **${sym.kind}** \`${sym.name}\`${exported} - L${sym.startLine}-L${sym.endLine}`,
        );
        lines.push(`  \`${sym.signature}\``);
    }

    const outlineTokens = Embedder.estimateTokens(lines.join("\n"));

    try {
        const fullContent = readSource(resolvedPath);
        const fullTokens = Embedder.estimateTokens(fullContent);
        const saved = Math.max(0, fullTokens - outlineTokens);

        engine.logUsage("nreki_outline", outlineTokens, outlineTokens, saved);

        lines.push("");
        lines.push(`[NREKI saved ~${saved.toLocaleString()} tokens vs reading full file]`);
    } catch {
        engine.logUsage("nreki_outline", outlineTokens, outlineTokens, 0);
        lines.push("");
        lines.push(`[NREKI: ${outlineTokens.toLocaleString()} tokens]`);
    }

    return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
    };
}

// ─── Map ────────────────────────────────────────────────────────────

export async function handleMap(
    params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    const stats = engine.getStats();
    if (stats.filesIndexed === 0) {
        await engine.indexDirectory(process.cwd());
    }

    const refresh = params.refresh === true;
    const { text, fromCache } = await engine.getRepoMap(refresh);

    const pinnedText = getPinnedText(process.cwd());
    const fullText = text + (pinnedText ? "\n" + pinnedText : "");
    const tokens = Embedder.estimateTokens(fullText);

    engine.logUsage("nreki_map", tokens, tokens, 0);

    return {
        content: [{
            type: "text" as const,
            text:
                fullText +
                `\n[NREKI repo map: ${tokens.toLocaleString()} tokens | ` +
                `${fromCache ? "from cache (prompt-cacheable)" : "freshly generated"} | ` +
                `${pinnedText ? `${listPins(process.cwd()).length} pinned rules | ` : ""}` +
                `This text is deterministic - place it early in context for Anthropic prompt caching]`,
        }],
    };
}

// ─── Prepare Refactor ───────────────────────────────────────────────

/** Node types that are dangerous for automated refactoring (strings, comments, keys). */
const DANGEROUS_REFACTOR_NODES = new Set([
    "string", "string_fragment", "string_content",
    "template_string", "template_substitution",
    "interpreted_string_literal", "raw_string_literal",
    "concatenated_string",
    "comment", "line_comment", "block_comment",
    "jsx_text",
    "property_identifier", "shorthand_property_identifier",
]);

/** Parent types that represent key-value pairs (left child = key). */
const KV_PARENTS = new Set(["pair", "dictionary", "keyed_element", "property_assignment"]);

function classifyRefactorConfidence(
    node: Parser.SyntaxNode,
): "high" | "review" {
    const nodeType = node.type;
    const parentType = node.parent?.type || "";

    if (DANGEROUS_REFACTOR_NODES.has(nodeType) || DANGEROUS_REFACTOR_NODES.has(parentType)) {
        return "review";
    }

    if (KV_PARENTS.has(parentType) && node.parent?.child(0) === node) {
        return "review";
    }

    return "high";
}

export async function handlePrepareRefactor(
    params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    const symbolName = params.symbol;
    if (!symbolName) {
        return {
            content: [{ type: "text" as const, text: 'Error: "symbol" is required for prepare_refactor.' }],
            isError: true,
        };
    }

    // ─── NREKI LAYER 2: TYPE-SAFE PREDICTIVE BLAST RADIUS ───
    if (deps.kernel?.isBooted()) {
        try {
            const parser = engine.getParser();
            const root = engine.getProjectRoot();
            const defs = await findDefinition(root, parser, symbolName, "any");

            if (defs.length > 0) {
                const targetFile = safePath(process.cwd(), defs[0].filePath);
                const t0 = performance.now();
                const br = deps.kernel.predictBlastRadius(targetFile, symbolName);
                const latency = (performance.now() - t0).toFixed(2);

                const jitWarning = deps.chronos ? deps.chronos.getContextWarnings(targetFile) : "";

                const lines: string[] = [
                    `## 🎯 Refactor Simulator: \`${symbolName}\``,
                    `**Source:** \`${defs[0].filePath}\` (L${defs[0].startLine})\n`,
                    jitWarning,
                    br.report,
                    `\n[NREKI: Type-safe blast radius computed via LanguageService in ${latency}ms]`,
                ];

                return {
                    content: [{ type: "text" as const, text: lines.join("\n") }],
                };
            }
        } catch (err) {
            logger.error("Predictive Blast Radius failed:", err);
            // Fallthrough to Layer 1 (AST heuristics)
        }
    }
    // ─── LAYER 1: HEURISTIC AST FALLBACK ───

    const parser = engine.getParser();

    const candidatePaths = await engine.searchFilesBySymbol(symbolName);
    const candidateFiles = new Set(candidatePaths);

    const highConfidence: Array<{ file: string; line: number; context: string }> = [];
    const reviewManually: Array<{ file: string; line: number; context: string; reason: string }> = [];

    for (const filePath of candidateFiles) {
        let fullPath: string;
        try {
            fullPath = safePath(process.cwd(), filePath);
        } catch { continue; }

        let content: string;
        try {
            content = readSource(fullPath);
        } catch { continue; }

        const contentLines = content.split("\n");
        const fp = filePath;

        await parser.parseRaw(fullPath, content, (tree: Parser.Tree) => {
            function visit(node: Parser.SyntaxNode) {
                if (
                    (node.type === "identifier" || node.type === "type_identifier" ||
                     node.type === "property_identifier" || node.type === "shorthand_property_identifier") &&
                    node.text === symbolName
                ) {
                    const line = node.startPosition.row + 1;
                    const lineContent = contentLines[node.startPosition.row]?.trim() || "";
                    const confidence = classifyRefactorConfidence(node);

                    if (confidence === "high") {
                        highConfidence.push({ file: fp, line, context: lineContent });
                    } else {
                        reviewManually.push({
                            file: fp, line, context: lineContent,
                            reason: `parent: ${node.parent?.type || "unknown"}`,
                        });
                    }
                }
                for (let i = 0; i < node.childCount; i++) {
                    visit(node.child(i)!);
                }
            }
            visit(tree.rootNode);
        });
    }

    const lines: string[] = [
        `## Prepare Refactor: \`${symbolName}\``,
        "",
    ];

    if (highConfidence.length > 0) {
        lines.push(`### HIGH CONFIDENCE (${highConfidence.length} - structural usage)`);
        for (const m of highConfidence) {
            lines.push(`  ${m.file}:L${m.line} - \`${m.context}\``);
        }
        lines.push("");
    }

    if (reviewManually.length > 0) {
        lines.push(`### REVIEW MANUALLY (${reviewManually.length} - may be string/key/comment)`);
        for (const m of reviewManually) {
            lines.push(`  ${m.file}:L${m.line} - \`${m.context}\` (${m.reason})`);
        }
        lines.push("");
    }

    if (highConfidence.length === 0 && reviewManually.length === 0) {
        lines.push(`No occurrences of \`${symbolName}\` found in the project.`);
    } else {
        lines.push(
            `Use \`nreki_code action:"batch_edit"\` to rename the high-confidence matches. ` +
            `Review manually before including any marked for review.`
        );
    }

    return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
    };
}
