/**
 * handlers/navigate.ts - Pure navigate handlers (DAG: no circular dependencies).
 *
 * Each handler takes params + deps, returns McpToolResponse.
 * ZERO side effects beyond engine/parser calls.
 * Heartbeat wrapping is the router's responsibility.
 */

import crypto from "crypto";
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
import { getPinnedText } from "../pin-memory.js";
import { repoMapToText } from "../repo-map.js";
import { extractDependencies, cleanSignature, isSensitiveSignature, escapeRegExp } from "../utils/imports.js";
import { logger } from "../utils/logger.js";
import { runDefectRadar } from "../utils/defect-radar.js";

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
        logger.info("First-time project indexing — this may take a moment for large repos.");
        await engine.indexDirectory(engine.getProjectRoot());
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
                    `Try a broader query or index more directories.`,
            }],
        };
    }

    const formatted = results.map((r, i) => {
        const cleanPath = path.relative(engine.getProjectRoot(), r.path).replace(/\\/g, "/");
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

    const fileCount = new Set(results.map(r => r.path)).size;
    const resultText = `Search "${query}": ${results.length} results in ${fileCount} files\n\n` +
        formatted.join("\n\n");

    const searchTokens = Embedder.estimateTokens(resultText);
    const saved = Math.max(0, grepEstimate - searchTokens);

    const finalText = resultText;

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
                    (kind !== "any" ? ` (kind: ${kind})` : ""),
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
                autoContextBlock,
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
                text: `No references found for: "${symbol}"`,
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
                formatted.join("\n"),
        }],
    };
}

// ─── Outline ────────────────────────────────────────────────────────

function computeTriageRisk(name: string, rawCode: string, linesCount: number): string {
    if (!rawCode) return "[LOW]";
    let score = 0;
    const reasons: string[] = [];
    if (linesCount <= 3) { score -= 2; }
    else if (linesCount > 50) { score += 3; reasons.push(">50L"); }
    else if (linesCount > 20) { score += 1; }
    const cleanCode = rawCode
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "")
        .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "");
    const branches = (cleanCode.match(/\b(if|else|switch|case|catch|for|while)\b/g) || []).length +
                     (cleanCode.match(/(?<!\?)\?(?!\.|:|\?)/g) || []).length;
    if (branches > 6) { score += 3; reasons.push(`${branches} branches`); }
    else if (branches > 2) { score += 1; }
    const calls = (cleanCode.match(/\b[a-zA-Z_]\w*\s*\(/g) || []).length;
    if (calls > 15) { score += 1; reasons.push("ext deps"); }
    const mutations = (cleanCode.match(/\+=|-=|\*=|\/=|%=|\+\+|--|\.push\(|\.pop\(|\.shift\(|\.unshift\(|\.splice\(|\.set\(|\.delete\(|\.clear\(|\.add\(/g) || []).length;
    if (mutations > 2) { score += 2; reasons.push("state mutation"); }
    else if (mutations > 0) { score += 1; reasons.push("mutates state"); }
    if (/calculate|validate|process|compute|handle|update|sync|transform|parse|execute|mutate|match/i.test(name)) {
        score += 2;
        reasons.push("biz logic");
    }
    if (/pnl|price|volume|amount|balance|margin|risk|vwap|liquidation|drawdown|position|order|fill|iceberg|trade/i.test(name)) {
        score += 2;
        reasons.push("critical domain");
    }
    const mathOps = (cleanCode.match(/(?:\w|\]|\))\s*(?:[-+*/%](?![=+*-]))\s*(?:\w|\(|\[)/g) || []).length;
    if (mathOps > 3) {
        score += 2;
        reasons.push("math heavy");
    } else if (mathOps > 0) {
        score += 1;
    }
    if (/\bas\s+any\b|:\s*any\b/.test(cleanCode)) {
        score += 2;
        reasons.push("type gap");
    }
    if (score >= 5) return `[HIGH \u2014 ${reasons.slice(0, 3).join(", ")}]`;
    if (score >= 3) return `[MED \u2014 ${reasons.slice(0, 2).join(", ")}]`;
    return `[LOW]`;
}

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
                text: `Security error: ${(err as Error).message}`,
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
                    `(File may be empty, unsupported, or contain no declarations.)`,
            }],
        };
    }

    const relPath = path.relative(root, resolvedPath).replace(/\\/g, "/");
    const lines = [`## Outline: ${relPath}`, `${symbols.length} symbol(s)`, ""];

    const engrams = deps.engine.getEngramsForFile(resolvedPath);
    let invalidatedCount = 0;

    const lowRiskSymbols: string[] = [];

    // v10.7.0 (NREKI Way): Ghost Oracle pre-fetch. Entry files are exempt —
    // they're referenced by the runtime/test-runner, not by the import graph,
    // so a 0-ref result would be a false positive on them.
    const isEntryFile = /^(index|main|app|setup|server|cli|vite-env)\./i.test(path.basename(resolvedPath)) ||
                        /^(.*\.)?config\./i.test(path.basename(resolvedPath)) ||
                        /\.(test|spec)\./i.test(resolvedPath);

    const ghostCache = new Map<string, boolean>();
    const symbolsToGhostCheck = Array.from(new Set(
        symbols
            .filter(s => s.exportedAs && s.kind !== "type" && s.kind !== "interface" && !s.name.startsWith("_") && !isEntryFile)
            .map(s => s.name)
    ));
    await Promise.all(symbolsToGhostCheck.map(async (name) => {
        const candidateFiles = await deps.engine.searchFilesBySymbol(name);
        const hasExt = candidateFiles.some((f: string) => path.relative(root, f).replace(/\\/g, "/") !== relPath);
        ghostCache.set(name, hasExt);
    }));

    for (const sym of symbols) {
        const exported = sym.exportedAs ? ` [${sym.exportedAs}]` : "";
        const linesCount = sym.endLine - sym.startLine + 1;
        const riskTag = computeTriageRisk(sym.name, sym.body, linesCount);

        const memory = engrams.get(sym.name);
        let engramLine: string | null = null;
        let hasValidEngram = false;
        if (memory) {
            const currentHash = crypto.createHash("sha256").update(sym.body).digest("hex");
            // v10.7.0: engrams whose insight starts with "ASSERT" (case-insensitive)
            // are immortal — they survive AST hash mutation. Ideal for pinning
            // invariants that apply to the role of the symbol, not its body.
            const isImmortal = memory.insight.toUpperCase().startsWith("ASSERT");
            if (currentHash === memory.astHash || isImmortal) {
                engramLine = `  [Engram]: ${memory.insight}`;
                hasValidEngram = true;
            } else {
                deps.engine.deleteEngram(resolvedPath, sym.name);
                invalidatedCount++;
                engramLine = `  [Engram invalidated: code mutated since memory was saved]`;
            }
        }

        // v10.7.0: parasitic defect radar + ghost tag rendered inline.
        const defects = runDefectRadar(sym.body);
        const defectTag = defects.length > 0
            ? ` ⚠️ [${defects.map(d => d.label).join(", ")}]`
            : "";
        const ghostTag = ghostCache.get(sym.name) === false
            ? " 👻 [0 ext refs]"
            : "";

        if (riskTag === "[LOW]" && !hasValidEngram && !params.signatures && defects.length === 0 && !ghostTag) {
            lowRiskSymbols.push(sym.name);
            continue;
        }

        lines.push(
            `- **${sym.kind}** \`${sym.name}\`${exported} ${riskTag}${defectTag}${ghostTag} - L${sym.startLine}-L${sym.endLine}`,
        );
        lines.push(`  \`${sym.signature}\``);
        if (engramLine) lines.push(engramLine);
    }

    if (invalidatedCount > 0) {
        lines.push(`\nNote: ${invalidatedCount} obsolete engram(s) automatically deleted because their underlying code changed.`);
    }

    if (lowRiskSymbols.length > 0) {
        lines.push("");
        lines.push(`--- ${lowRiskSymbols.length} LOW-risk symbols (trivial, not shown — pass signatures:true to expand) ---`);
        lines.push(lowRiskSymbols.join(", "));
    }

    if (symbols.length > 3) {
        lines.push("");
        lines.push(`*Tip: Read multiple high-risk symbols in one call: nreki_code action:"compress" focus:"func1, func2, func3"*`);
    }

    const highRiskSymbols = symbols.filter((sym) => {
        const linesCount = sym.endLine - sym.startLine + 1;
        const tag = computeTriageRisk(sym.name, sym.body, linesCount);
        return tag.startsWith("[HIGH");
    });

    // ─── DYNAMIC RISK EXPANSION (v10.x) ───
    const MAX_EXPAND_TOKENS = 6000;

    const expandable = highRiskSymbols
        .filter((sym) => (sym.endLine - sym.startLine + 1) <= 150)
        .sort((a, b) => (b.endLine - b.startLine) - (a.endLine - a.startLine));

    const autoExpanded: typeof expandable = [];
    const omittedHighRisk: string[] = [];
    let expandedTokens = 0;

    for (const sym of expandable) {
        const symTokens = Embedder.estimateTokens(sym.body);
        if (expandedTokens + symTokens > MAX_EXPAND_TOKENS) {
            omittedHighRisk.push(sym.name);
            continue;
        }
        autoExpanded.push(sym);
        expandedTokens += symTokens;
    }

    if (autoExpanded.length > 0) {
        lines.push("");
        lines.push(`--- AUTO-EXPANDED HIGH-RISK CODE (${autoExpanded.length} symbols, ~${expandedTokens.toLocaleString()} tokens) ---`);

        autoExpanded.sort((a, b) => a.startLine - b.startLine);

        for (const sym of autoExpanded) {
            lines.push("");
            lines.push(`### ${sym.name} (L${sym.startLine}-L${sym.endLine})`);
            lines.push("```typescript");
            lines.push(sym.body);
            lines.push("```");
        }
    }

    if (omittedHighRisk.length > 0) {
        lines.push("");
        lines.push(`[BUDGET LIMIT REACHED] ${omittedHighRisk.length} HIGH-risk symbols were not expanded to save context.`);
        lines.push(`If auditing, you MUST run: nreki_code action:"compress" focus:"${omittedHighRisk.slice(0, 8).join(", ")}"`);
    }

    const outlineTokens = Embedder.estimateTokens(lines.join("\n"));

    try {
        const fullContent = readSource(resolvedPath);
        const fullTokens = Embedder.estimateTokens(fullContent);
        const saved = Math.max(0, fullTokens - outlineTokens);

        engine.logUsage("nreki_outline", outlineTokens, outlineTokens, saved);

    } catch {
        engine.logUsage("nreki_outline", outlineTokens, outlineTokens, 0);
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
        logger.info("First-time project indexing — this may take a moment for large repos.");
        await engine.indexDirectory(engine.getProjectRoot());
    }

    const refresh = params.refresh === true;
    const { text: cachedText, map } = await engine.getRepoMap(refresh);

    // Depth selection: skeleton (default) or full. Pressure >0.7 forces skeleton unless explicitly full.
    const depth = (params.depth === "full") ? "full" : "skeleton";
    const pressure = deps.pressure ?? 0;
    const effectiveDepth = (pressure > 0.7 && params.depth !== "full") ? "skeleton" as const : depth as "skeleton" | "full";

    // If full depth requested, regenerate text from map (cached text is always skeleton)
    const text = effectiveDepth === "full" ? repoMapToText(map, "full", pressure) : cachedText;

    const pinnedText = getPinnedText(engine.getProjectRoot());
    const fullText = text + (pinnedText ? "\n" + pinnedText : "");
    const tokens = Embedder.estimateTokens(fullText);

    engine.logUsage("nreki_map", tokens, tokens, 0);

    return {
        content: [{
            type: "text" as const,
            text: fullText,
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
                const targetFile = safePath(deps.engine.getProjectRoot(), defs[0].filePath);
                const br = deps.kernel.predictBlastRadius(targetFile, symbolName);

                const jitWarning = deps.chronos ? deps.chronos.getContextWarnings(targetFile) : "";

                const lines: string[] = [
                    `## Refactor Simulator: \`${symbolName}\``,
                    `**Source:** \`${defs[0].filePath}\` (L${defs[0].startLine})\n`,
                    jitWarning,
                    br.report,
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
            fullPath = safePath(deps.engine.getProjectRoot(), filePath);
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

// ─── Orphan Candidates Oracle (Transitive Sweep) ────────────────────

export async function handleOrphanOracle(
    _params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    const stats = engine.getStats();
    if (stats.filesIndexed === 0) {
        logger.info("First-time project indexing — this may take a moment for large repos.");
        await engine.indexDirectory(engine.getProjectRoot());
    }

    const { map } = await engine.getRepoMap();
    const graph = await engine.getDependencyGraph();

    const ROOT_PATTERNS = [
        /^(index|main|app|setup|server|cli|vite-env)\./i,
        /^(next|vite|webpack|rollup|jest|vitest|tailwind|eslint|babel|playwright|cypress)\.config\./i,
        /[/\\](pages|app|api|routes|bin|scripts|test|__tests__|tests|e2e)[/\\]/i,
        /\.(test|spec|cy)\./i,
        /^(middleware|instrumentation)\./i,
        /\.(stories|story)\./i,
        /[/\\](migrations?|seeds?|fixtures)[/\\]/i,
        /^(sw|service-worker)\./i,
    ];

    const reachable = new Set<string>();
    const roots: string[] = [];

    // O(E) Forward graph from importedBy inversion
    const forwardGraph = new Map<string, string[]>();
    for (const entry of map.entries) {
        forwardGraph.set(entry.filePath, []);
    }
    for (const [target, consumers] of graph.importedBy.entries()) {
        for (const consumer of consumers) {
            const depsList = forwardGraph.get(consumer) || [];
            depsList.push(target);
            forwardGraph.set(consumer, depsList);
        }
    }

    // 1. Identify structural roots
    for (const entry of map.entries) {
        const file = entry.filePath;
        const base = path.basename(file);
        if (ROOT_PATTERNS.some(p => p.test(file)) || base.endsWith(".d.ts")) {
            roots.push(file);
            reachable.add(file);
        }
    }

    // 2. DFS Reachability (Mark)
    const stack = [...roots];
    while (stack.length > 0) {
        const current = stack.pop()!;
        const neighbors = forwardGraph.get(current) || [];
        for (const n of neighbors) {
            if (!reachable.has(n)) {
                reachable.add(n);
                stack.push(n);
            }
        }
    }

    // 3. Sweep: unreachable files with exports = orphan candidates
    const orphanFiles: Array<{ file: string; lines: number; exports: string[] }> = [];
    let savedLines = 0;

    for (const entry of map.entries) {
        if (!reachable.has(entry.filePath) && entry.exports.length > 0) {
            orphanFiles.push({
                file: entry.filePath,
                lines: entry.lineCount,
                exports: entry.exports,
            });
            savedLines += entry.lineCount;
        }
    }

    if (orphanFiles.length === 0) {
        return {
            content: [{
                type: "text" as const,
                text: `Orphan Review\n\nTransitive reachability analysis complete. ` +
                    `Your architecture is lean. No statically isolated modules found.`,
            }],
        };
    }

    orphanFiles.sort((a, b) => b.lines - a.lines);
    const formatted = orphanFiles.map(df =>
        `- \`${df.file}\` (${df.lines} lines)\n  *Exports:* ` +
        `${df.exports.slice(0, 4).join(", ")}${df.exports.length > 4 ? "..." : ""}`
    );

    return {
        content: [{
            type: "text" as const,
            text: `Orphan Candidates Oracle (Zero Static Reachability)\n\n` +
                `Mark-and-Sweep reachability analysis from framework roots.\n` +
                `Found **${orphanFiles.length} files** that export logic but are ` +
                `completely unreachable via static imports ` +
                `(including transitive barrel sweeps).\n\n` +
                `⚠️ **CRITICAL WARNING:**\n` +
                `Static analysis cannot detect:\n` +
                `1. Dynamic imports (\`await import()\`).\n` +
                `2. Dependency Injection or Reflection.\n\n` +
                `**Review manually before deleting.** ` +
                `Potential savings: **~${savedLines} lines**.\n\n` +
                `*Tip: Use \`nreki_code action:"batch_edit"\` to safely ` +
                `tombstone them with \`new_code: null\`.*\n\n` +
                `### Candidates:\n${formatted.join("\n")}`,
        }],
    };
}

// ─── Type Shape Oracle ───────────────────────────────────────────────

export async function handleTypeShape(
    params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    if (!deps.kernel || deps.nrekiMode === "syntax") {
        return {
            content: [{ type: "text" as const, text: "Error: type_shape requires a TypeScript project with tsconfig.json." }],
            isError: true,
        };
    }

    if (!deps.kernel.isBooted()) {
        return {
            content: [{ type: "text" as const, text: "Error: TypeScript kernel not booted. Ensure tsconfig.json exists and retry." }],
            isError: true,
        };
    }

    const symbol = params.symbol ?? "";
    const file = params.path ?? "";
    if (!symbol || !file) {
        return {
            content: [{ type: "text" as const, text: "Error: type_shape requires both path and symbol." }],
            isError: true,
        };
    }

    const root = deps.engine.getProjectRoot();
    let resolvedPath: string;
    try {
        resolvedPath = safePath(root, file);
    } catch (err) {
        return {
            content: [{ type: "text" as const, text: `Security error: ${(err as Error).message}` }],
            isError: true,
        };
    }

    const shape = deps.kernel.getTypeShape(resolvedPath, symbol);
    if (!shape) {
        return {
            content: [{ type: "text" as const, text: `Oracle: type shape for \`${symbol}\` not found in ${file}. Ensure the symbol is exported or declared at the top level.` }],
            isError: true,
        };
    }

    return {
        content: [{
            type: "text" as const,
            text: `Oracle: Type Shape for \`${symbol}\`\n\n\`\`\`typescript\ntype ${symbol} = ${shape}\n\`\`\``,
        }],
    };
}
