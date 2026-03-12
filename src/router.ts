/**
 * router.ts — Central dispatcher for TokenGuard v3.1.1 router tools.
 *
 * Maps {toolName, action} pairs to existing handler functions.
 * All business logic remains in the original modules — this file
 * only wires up the routing and formats MCP responses.
 *
 * v3.0.1: Flat parameter schemas (no more generic `options` bag),
 * file-level mutex on edits, terminal renamed to filter_output.
 *
 * 3 router tools replace 16 individual tools:
 *   tg_navigate → search, definition, references, outline, map
 *   tg_code     → read, compress, edit, undo, filter_output
 *   tg_guard    → pin, unpin, status, report
 */

import fs from "fs";
import path from "path";

import { TokenGuardEngine } from "./engine.js";
import { TokenMonitor } from "./monitor.js";
import { Embedder } from "./embedder.js";
import { safePath } from "./utils/path-jail.js";
import { shouldProcess } from "./utils/file-filter.js";
import { filterTerminalOutput } from "./terminal-filter.js";
import {
    findDefinition,
    findReferences,
    getFileSymbols,
    type SymbolKind,
    type ReferenceResult,
} from "./ast-navigator.js";
import { AstSandbox } from "./ast-sandbox.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { semanticEdit, type EditMode } from "./semantic-edit.js";
import { addPin, removePin, listPins, getPinnedText } from "./pin-memory.js";
import { readSource } from "./utils/read-source.js";
import { restoreBackup } from "./undo.js";
import { validateBeforeWrite } from "./middleware/validator.js";
import { wrapWithCircuitBreaker } from "./middleware/circuit-breaker.js";
import { acquireFileLock, releaseFileLock } from "./middleware/file-lock.js";
import { PreToolUseHook } from "./hooks/preToolUse.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface McpToolResponse {
    [key: string]: unknown;
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}

export interface RouterDependencies {
    engine: TokenGuardEngine;
    monitor: TokenMonitor;
    sandbox: AstSandbox;
    circuitBreaker: CircuitBreaker;
    hook?: PreToolUseHook;
}

/** Flat params for tg_navigate (replaces target + options bag). */
export interface NavigateParams {
    action: string;
    query?: string;
    symbol?: string;
    path?: string;
    limit?: number;
    include_raw?: boolean;
    kind?: string;
    signatures?: boolean;
    refresh?: boolean;
}

/** Flat params for tg_code (replaces path + options bag). */
export interface CodeParams {
    action: string;
    path?: string;
    symbol?: string;
    new_code?: string;
    compress?: boolean;
    level?: string;
    focus?: string;
    tier?: number;
    output?: string;
    max_lines?: number;
    mode?: string;
}

/** Flat params for tg_guard (replaces options bag). */
export interface GuardParams {
    action: string;
    text?: string;
    index?: number;
    id?: string;
}

// ─── tg_navigate ────────────────────────────────────────────────────

export async function handleNavigate(
    action: string,
    params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    switch (action) {
        case "search":
            return handleSearch(params, deps);
        case "definition":
            return handleDefinition(params, deps);
        case "references":
            return handleReferences(params, deps);
        case "outline":
            return handleOutline(params, deps);
        case "map":
            return handleMap(params, deps);
        default:
            return {
                content: [{
                    type: "text" as const,
                    text: `Unknown tg_navigate action: "${action}". Valid actions: search, definition, references, outline, map.`,
                }],
                isError: true,
            };
    }
}

// ─── tg_code ────────────────────────────────────────────────────────

export async function handleCode(
    action: string,
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    switch (action) {
        case "read":
            return handleRead(params, deps);
        case "compress":
            return handleCompress(params, deps);
        case "edit":
            return handleEdit(params, deps);
        case "undo":
            return handleUndo(params, deps);
        case "filter_output":
            return handleFilterOutput(params, deps);
        default: {
            const hint = action === "terminal"
                ? ' (Note: "terminal" was renamed to "filter_output" in v3.0.1)'
                : "";
            return {
                content: [{
                    type: "text" as const,
                    text: `Unknown tg_code action: "${action}"${hint}. Valid actions: read, compress, edit, undo, filter_output.`,
                }],
                isError: true,
            };
        }
    }
}

// ─── tg_guard ───────────────────────────────────────────────────────

export async function handleGuard(
    action: string,
    params: GuardParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    switch (action) {
        case "pin":
            return handlePin(params, deps);
        case "unpin":
            return handleUnpin(params, deps);
        case "status":
            return handleStatus(deps);
        case "report":
            return handleReport(deps);
        case "reset":
            return handleReset(deps);
        default:
            return {
                content: [{
                    type: "text" as const,
                    text: `Unknown tg_guard action: "${action}". Valid actions: pin, unpin, status, report, reset.`,
                }],
                isError: true,
            };
    }
}

async function handleReset(
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { circuitBreaker } = deps;
    const state = circuitBreaker.getState();

    if (state.escalationLevel === 0 && !state.tripped) {
        return {
            content: [{
                type: "text" as const,
                text: "## Circuit Breaker: ALREADY CLEAR\n\nNo active trip to reset.",
            }],
        };
    }

    const prevLevel = state.escalationLevel;
    circuitBreaker.reset();

    return {
        content: [{
            type: "text" as const,
            text:
                `## Circuit Breaker: RESET\n\n` +
                `**Previous level:** ${prevLevel}\n` +
                `**Status:** All clear. You may retry the edit. ` +
                `If you get stuck again, the breaker starts fresh from Level 1.\n\n` +
                `[TokenGuard: circuit breaker reset by human]`,
        }],
    };
}

// ─── Navigate Handlers ──────────────────────────────────────────────

async function handleSearch(
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
                    `[TokenGuard saved ~0 tokens on this query]`,
            }],
        };
    }

    const formatted = results.map((r, i) => {
        const header = `### ${i + 1}. ${path.relative(process.cwd(), r.path)}:L${r.startLine}-L${r.endLine}`;
        const shorthand = `\`\`\`\n${r.shorthand}\n\`\`\``;
        const rawSection = include_raw
            ? `\n<details><summary>Full source</summary>\n\n\`\`\`\n${r.rawCode}\n\`\`\`\n</details>`
            : "";
        const score = `Score: ${r.score.toFixed(4)} | Type: ${r.nodeType}`;
        return `${header}\n${shorthand}\n${score}${rawSection}`;
    });

    const grepEstimate =
        results.reduce((sum, r) => sum + Embedder.estimateTokens(r.rawCode), 0) * 3;
    const searchTokens = results.reduce(
        (sum, r) => sum + Embedder.estimateTokens(r.shorthand), 0,
    );
    const saved = Math.max(0, grepEstimate - searchTokens);

    engine.logUsage("tg_search", searchTokens, searchTokens, saved);

    return {
        content: [{
            type: "text" as const,
            text:
                `## TokenGuard Search: "${query}"\n` +
                `Found ${results.length} results across ${new Set(results.map(r => r.path)).size} files.\n\n` +
                formatted.join("\n\n") +
                `\n\n[TokenGuard saved ~${saved.toLocaleString()} tokens on this query]`,
        }],
    };
}

async function handleDefinition(
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
                    `\n\n[TokenGuard saved ~0 tokens]`,
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

    engine.logUsage("tg_def", bodyTokens, bodyTokens, 0);

    return {
        content: [{
            type: "text" as const,
            text:
                `## Definition: ${symbol}\n` +
                `Found ${results.length} definition(s).\n\n` +
                formatted.join("\n\n") +
                `\n\n[TokenGuard: ${bodyTokens.toLocaleString()} tokens — exact AST lookup, no search overhead]`,
        }],
    };
}

async function handleReferences(
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
                text: `No references found for: "${symbol}"\n\n[TokenGuard saved ~0 tokens]`,
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
    for (const [file, refs] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        formatted.push(`### ${file} (${refs.length} reference${refs.length > 1 ? "s" : ""})`);
        for (const ref of refs) {
            formatted.push(`**L${ref.line}:**`);
            formatted.push(`\`\`\`\n${ref.context}\n\`\`\``);
        }
    }

    const refTokens = results.reduce(
        (sum, r) => sum + Embedder.estimateTokens(r.context), 0,
    );

    engine.logUsage("tg_refs", refTokens, refTokens, 0);

    return {
        content: [{
            type: "text" as const,
            text:
                `## References: ${symbol}\n` +
                `Found ${results.length} reference(s) across ${byFile.size} file(s).\n\n` +
                formatted.join("\n") +
                `\n\n[TokenGuard: ${refTokens.toLocaleString()} tokens]`,
        }],
    };
}

async function handleOutline(
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
                text: `Security error: ${(err as Error).message}\n\n[TokenGuard saved ~0 tokens]`,
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
                    `[TokenGuard saved ~0 tokens]`,
            }],
        };
    }

    const relPath = path.relative(root, resolvedPath).replace(/\\/g, "/");
    const lines = [`## Outline: ${relPath}`, `${symbols.length} symbol(s)`, ""];

    for (const sym of symbols) {
        const exported = sym.exportedAs ? ` [${sym.exportedAs}]` : "";
        lines.push(
            `- **${sym.kind}** \`${sym.name}\`${exported} — L${sym.startLine}-L${sym.endLine}`,
        );
        lines.push(`  \`${sym.signature}\``);
    }

    const outlineTokens = Embedder.estimateTokens(lines.join("\n"));

    try {
        const fullContent = readSource(resolvedPath);
        const fullTokens = Embedder.estimateTokens(fullContent);
        const saved = Math.max(0, fullTokens - outlineTokens);

        engine.logUsage("tg_outline", outlineTokens, outlineTokens, saved);

        lines.push("");
        lines.push(`[TokenGuard saved ~${saved.toLocaleString()} tokens vs reading full file]`);
    } catch {
        engine.logUsage("tg_outline", outlineTokens, outlineTokens, 0);
        lines.push("");
        lines.push(`[TokenGuard: ${outlineTokens.toLocaleString()} tokens]`);
    }

    return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
    };
}

async function handleMap(
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

    engine.logUsage("tg_map", tokens, tokens, 0);

    return {
        content: [{
            type: "text" as const,
            text:
                fullText +
                `\n[TokenGuard repo map: ${tokens.toLocaleString()} tokens | ` +
                `${fromCache ? "from cache (prompt-cacheable)" : "freshly generated"} | ` +
                `${pinnedText ? `${listPins(process.cwd()).length} pinned rules | ` : ""}` +
                `This text is deterministic — place it early in context for Anthropic prompt caching]`,
        }],
    };
}

// ─── Code Handlers ──────────────────────────────────────────────────

async function handleRead(
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    const file_path = params.path ?? "";
    let resolvedPath: string;
    try {
        resolvedPath = safePath(process.cwd(), file_path);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}\n\n[TokenGuard saved ~0 tokens]`,
            }],
        };
    }

    try {
        const stat = fs.statSync(resolvedPath);

        const filterResult = shouldProcess(resolvedPath, stat.size);
        if (!filterResult.process) {
            return {
                content: [{
                    type: "text" as const,
                    text: `File skipped: ${filterResult.reason}\n\n[TokenGuard saved ~0 tokens]`,
                }],
            };
        }

        // Skip compression for small files (< 1KB)
        if (stat.size < 1024) {
            const content = readSource(resolvedPath);
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## ${path.basename(resolvedPath)} (raw — ${stat.size} bytes, below 1KB threshold)\n\n` +
                        `\`\`\`\n${content}\n\`\`\`\n\n` +
                        `[TokenGuard: file too small to compress]`,
                }],
            };
        }

        const compress = params.compress !== false;
        const level = (typeof params.level === "string" &&
            ["light", "medium", "aggressive"].includes(params.level))
            ? params.level as "light" | "medium" | "aggressive"
            : "medium";

        if (!compress) {
            const content = readSource(resolvedPath);

            // Mark as safely read (removes from Danger Zones)
            engine.markFileRead(resolvedPath);

            // Behavioral advisor: teach Claude to use compression next time
            let advice = "";
            if (deps.hook) {
                const intercept = deps.hook.evaluateFileRead(resolvedPath, content);
                if (intercept.shouldIntercept) {
                    advice = `\n\n${intercept.suggestion}`;
                }
            }

            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## ${path.basename(resolvedPath)} (raw)\n\n` +
                        `\`\`\`\n${content}\n\`\`\`\n\n` +
                        `[TokenGuard: raw read, no compression applied]${advice}`,
                }],
            };
        }

        const result = await engine.compressFileAdvanced(resolvedPath, level);
        engine.markFileRead(resolvedPath);
        const saved = result.tokensSaved;

        engine.logUsage(
            "tg_read",
            Embedder.estimateTokens(result.compressed),
            Embedder.estimateTokens(result.compressed),
            saved,
        );

        const sessionReport = engine.getSessionReport();

        const mapHint = level === "aggressive"
            ? "See tg_navigate action:\"map\" for full project structure. Showing only the requested code:\n\n"
            : "";

        return {
            content: [{
                type: "text" as const,
                text:
                    `## ${path.basename(resolvedPath)} (${level} compression)\n` +
                    `${result.originalSize.toLocaleString()} → ${result.compressedSize.toLocaleString()} chars ` +
                    `(${(result.ratio * 100).toFixed(1)}% reduction)\n\n` +
                    mapHint +
                    `\`\`\`\n${result.compressed}\n\`\`\`\n\n` +
                    `[TokenGuard saved ~${saved.toLocaleString()} tokens | ` +
                    `Session: ~${sessionReport.totalTokensSaved.toLocaleString()} tokens saved]`,
            }],
        };
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Error reading ${file_path}: ${(err as Error).message}\n\n[TokenGuard saved ~0 tokens]`,
            }],
        };
    }
}

async function handleCompress(
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    const file_path = params.path ?? "";
    let resolvedPath: string;
    try {
        resolvedPath = safePath(process.cwd(), file_path);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}\n\n[TokenGuard saved ~0 tokens on this query]`,
            }],
        };
    }

    try {
        const compression_level = typeof params.level === "string" &&
            ["light", "medium", "aggressive"].includes(params.level)
            ? params.level as "light" | "medium" | "aggressive"
            : undefined;

        const focus = typeof params.focus === "string" ? params.focus : undefined;

        // Advanced compression path
        if (compression_level) {
            const result = await engine.compressFileAdvanced(resolvedPath, compression_level);
            const saved = result.tokensSaved;
            const sessionReport = engine.getSessionReport();

            engine.logUsage(
                "tg_compress",
                Embedder.estimateTokens(result.compressed),
                Embedder.estimateTokens(result.compressed),
                saved,
            );

            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## TokenGuard Advanced Compress: ${path.basename(resolvedPath)}\n` +
                        `Level: ${compression_level} | ` +
                        `${result.originalSize.toLocaleString()} → ${result.compressedSize.toLocaleString()} chars ` +
                        `(${(result.ratio * 100).toFixed(1)}% reduction)\n` +
                        `  Preprocessing: -${result.breakdown.preprocessingReduction.toLocaleString()} chars\n` +
                        `  Token filtering: -${result.breakdown.tokenFilterReduction.toLocaleString()} chars\n` +
                        `  Structural: -${result.breakdown.structuralReduction.toLocaleString()} chars\n\n` +
                        `\`\`\`\n${result.compressed}\n\`\`\`\n\n` +
                        `[TokenGuard saved ~${saved.toLocaleString()} tokens | ` +
                        `Session total: ~${sessionReport.totalTokensSaved.toLocaleString()} tokens ` +
                        `($${sessionReport.savedUsdSonnet.toFixed(3)} Sonnet / $${sessionReport.savedUsdOpus.toFixed(3)} Opus)]`,
                }],
            };
        }

        // Classic tier-based compression path (backward compat)
        const tier = typeof params.tier === "number"
            ? Math.min(3, Math.max(1, params.tier)) as 1 | 2 | 3
            : 1;

        const result = await engine.compressFile(resolvedPath, tier, focus);
        const saved = result.tokensSaved;

        engine.logUsage(
            "tg_compress",
            Embedder.estimateTokens(result.compressed),
            Embedder.estimateTokens(result.compressed),
            saved,
        );

        return {
            content: [{
                type: "text" as const,
                text:
                    `## TokenGuard Compressed: ${path.basename(resolvedPath)}\n` +
                    `Tier ${tier} | ${result.chunksFound} chunks | ` +
                    `${result.originalSize.toLocaleString()} → ${result.compressedSize.toLocaleString()} chars ` +
                    `(${(result.ratio * 100).toFixed(1)}% reduction)\n\n` +
                    `\`\`\`\n${result.compressed}\n\`\`\`\n\n` +
                    `[TokenGuard saved ~${saved.toLocaleString()} tokens on this query]`,
            }],
        };
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Error compressing ${file_path}: ${(err as Error).message}\n\n[TokenGuard saved ~0 tokens on this query]`,
            }],
        };
    }
}

async function handleEdit(
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine, sandbox } = deps;
    await engine.initialize();

    const file = params.path ?? "";
    const symbol = typeof params.symbol === "string" ? params.symbol : "";
    const new_code = typeof params.new_code === "string" ? params.new_code : "";

    if (!symbol || !new_code) {
        return {
            content: [{
                type: "text" as const,
                text: `Error: "symbol" and "new_code" are required for the edit action.\n\n[TokenGuard saved ~0 tokens]`,
            }],
        };
    }

    let resolvedPath: string;
    try {
        resolvedPath = safePath(process.cwd(), file);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}\n\n[TokenGuard saved ~0 tokens]`,
            }],
            isError: true,
        };
    }

    // Acquire file-level mutex to prevent concurrent edit corruption
    const lockResult = acquireFileLock(resolvedPath, "tg_code:edit");
    if (!lockResult.acquired) {
        return {
            content: [{
                type: "text" as const,
                text:
                    `## Semantic Edit: BLOCKED\n\n` +
                    `File is currently locked by a concurrent edit (${lockResult.heldBy}, ${lockResult.heldForMs}ms ago).\n` +
                    `Wait for the current edit to complete and retry.\n\n` +
                    `[TokenGuard saved ~0 tokens]`,
            }],
            isError: true,
        };
    }

    try {
        const parser = engine.getParser();
        const mode = (typeof params.mode === "string" && ["replace", "insert_before", "insert_after"].includes(params.mode))
            ? params.mode as EditMode
            : "replace";
        const result = await semanticEdit(
            resolvedPath,
            symbol,
            new_code,
            parser,
            sandbox,
            mode,
        );

        if (!result.success) {
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## Semantic Edit: FAILED\n\n` +
                        `**Symbol:** ${symbol}\n` +
                        `**File:** ${file}\n\n` +
                        `${result.error}\n\n` +
                        `[TokenGuard saved ~0 tokens]`,
                }],
                isError: true,
            };
        }

        engine.logUsage(
            "tg_semantic_edit",
            Embedder.estimateTokens(new_code),
            Embedder.estimateTokens(new_code),
            result.tokensAvoided,
        );

        return {
            content: [{
                type: "text" as const,
                text:
                    `## Semantic Edit: SUCCESS\n\n` +
                    `**Symbol:** ${symbol}\n` +
                    `**File:** ${file}\n` +
                    `**Lines:** ${result.oldLines} → ${result.newLines}\n` +
                    `**Syntax:** validated ✓\n\n` +
                    `[TokenGuard saved ~${result.tokensAvoided.toLocaleString()} tokens vs full file rewrite]`,
            }],
        };
    } finally {
        releaseFileLock(resolvedPath);
    }
}

async function handleUndo(
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const file = params.path ?? "";
    let resolvedPath: string;
    try {
        resolvedPath = safePath(process.cwd(), file);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}\n\n[TokenGuard saved ~0 tokens]`,
            }],
        };
    }

    try {
        const message = restoreBackup(process.cwd(), resolvedPath);
        return {
            content: [{
                type: "text" as const,
                text: `## tg_undo: SUCCESS\n\n${message}\n\n[TokenGuard: file restored]`,
            }],
        };
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `## tg_undo: FAILED\n\n${(err as Error).message}\n\n[TokenGuard saved ~0 tokens]`,
            }],
        };
    }
}

async function handleFilterOutput(
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine, circuitBreaker } = deps;

    const output = typeof params.output === "string" ? params.output : "";
    const max_lines = typeof params.max_lines === "number"
        ? Math.min(1000, Math.max(1, params.max_lines))
        : 100;

    if (!output) {
        return {
            content: [{
                type: "text" as const,
                text: `Error: "output" is required for the filter_output action.\n\n[TokenGuard saved ~0 tokens]`,
            }],
        };
    }

    const result = filterTerminalOutput(output, max_lines);

    engine.logUsage(
        "tg_filter_output",
        result.filtered_tokens,
        result.filtered_tokens,
        Math.max(0, result.original_tokens - result.filtered_tokens),
    );

    // Feed errors to circuit breaker for loop detection
    let circuitWarning = "";
    if (result.error_summary.errorCount > 0) {
        const loopCheck = circuitBreaker.recordToolCall(
            "tg_filter_output",
            output,
            result.error_summary.affectedFiles[0] ?? undefined,
        );
        if (loopCheck.tripped) {
            circuitWarning =
                "\n\n## ⚠️ CIRCUIT BREAKER TRIPPED\n" +
                `**${loopCheck.reason}**\n` +
                "**STOP all fix attempts and ask the human for guidance.**\n";
        }
    }

    const summaryLines = [
        `## Terminal Filter Results`,
        `${result.original_tokens.toLocaleString()} → ${result.filtered_tokens.toLocaleString()} tokens ` +
        `(${result.reduction_percent}% reduction)`,
        "",
    ];

    if (result.error_summary.errorCount > 0) {
        summaryLines.push(`### Error Summary`);
        summaryLines.push(`${result.error_summary.summary}`);
        summaryLines.push("");
        if (result.error_summary.uniqueErrors.length > 0) {
            summaryLines.push(`**Unique errors (${result.error_summary.uniqueErrors.length}):**`);
            for (const err of result.error_summary.uniqueErrors.slice(0, 20)) {
                summaryLines.push(`- ${err}`);
            }
            summaryLines.push("");
        }
        if (result.error_summary.affectedFiles.length > 0) {
            summaryLines.push(`**Affected files:** ${result.error_summary.affectedFiles.join(", ")}`);
            summaryLines.push("");
        }
    }

    summaryLines.push("### Filtered Output");
    summaryLines.push("```");
    summaryLines.push(result.filtered_text);
    summaryLines.push("```");

    const saved = Math.max(0, result.original_tokens - result.filtered_tokens);
    summaryLines.push("");
    summaryLines.push(`[TokenGuard saved ~${saved.toLocaleString()} tokens on this filter]`);

    return {
        content: [{
            type: "text" as const,
            text: summaryLines.join("\n") + circuitWarning,
        }],
    };
}

// ─── Guard Handlers ─────────────────────────────────────────────────

async function handlePin(
    params: GuardParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const projectRoot = process.cwd();
    const text = typeof params.text === "string" ? params.text : "";

    if (!text) {
        return {
            content: [{
                type: "text" as const,
                text: "Error: `text` is required for the pin action.\n\n[TokenGuard saved ~0 tokens]",
            }],
        };
    }

    const result = addPin(projectRoot, text, "claude");
    if (!result.success) {
        return {
            content: [{
                type: "text" as const,
                text: `## Pin: FAILED\n\n${result.error}\n\n[TokenGuard saved ~0 tokens]`,
            }],
        };
    }

    const pins = listPins(projectRoot);
    return {
        content: [{
            type: "text" as const,
            text:
                `## Pin: ADDED\n\n` +
                `**ID:** ${result.pin.id}\n` +
                `**Rule:** ${result.pin.text}\n` +
                `**Total pins:** ${pins.length}/${10}\n\n` +
                `This rule will appear in every tg_navigate action:"map" response.\n\n` +
                `[TokenGuard saved ~0 tokens]`,
        }],
    };
}

async function handleUnpin(
    params: GuardParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const projectRoot = process.cwd();
    const index = typeof params.index === "number" ? params.index : undefined;
    const id = typeof params.id === "string" ? params.id : undefined;

    const pinId = id ?? (typeof index === "number" ? `pin_${String(index).padStart(3, "0")}` : undefined);

    if (!pinId) {
        return {
            content: [{
                type: "text" as const,
                text: "Error: `index` or `id` is required for the unpin action.\n\n[TokenGuard saved ~0 tokens]",
            }],
        };
    }

    const removed = removePin(projectRoot, pinId);
    if (!removed) {
        return {
            content: [{
                type: "text" as const,
                text: `## Pin: NOT FOUND\n\nNo pin with id "${pinId}" exists.\n\n[TokenGuard saved ~0 tokens]`,
            }],
        };
    }

    return {
        content: [{
            type: "text" as const,
            text: `## Pin: REMOVED\n\n**ID:** ${pinId}\n\nThis rule will no longer appear in tg_navigate action:"map" responses.\n\n[TokenGuard saved ~0 tokens]`,
        }],
    };
}

async function handleStatus(
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine, monitor } = deps;

    const report = monitor.generateReport();
    const prediction = monitor.predictExhaustion();

    const stats = engine.getStats();
    const indexSection = [
        "",
        "───────────────────────────────────────────",
        "  📁 Index Status:",
        `     Files:       ${stats.filesIndexed}`,
        `     Chunks:      ${stats.totalChunks}`,
        `     Compression: ${(stats.compressionRatio * 100).toFixed(1)}%`,
        `     Watched:     ${stats.watchedPaths.join(", ")}`,
        "═══════════════════════════════════════════",
    ].join("\n");

    // Danger Zones: heaviest unread files
    const heavyFiles = engine.getTopHeavyFiles(5);
    let dangerZones = "";
    if (heavyFiles.length > 0) {
        dangerZones = [
            "",
            "───────────────────────────────────────────",
            "  ☢️ DANGER ZONES (Heaviest unread files):",
            "  Do NOT read these raw. Use tg_code action:\"compress\".",
            ...heavyFiles.map(f =>
                `     - ${path.relative(process.cwd(), f.path)} (~${f.estimated_tokens.toLocaleString()} tokens)`
            ),
            "───────────────────────────────────────────",
        ].join("\n");
    }

    let recommendations = "";
    if (prediction.alertLevel === "critical") {
        recommendations =
            "\n\n⚠️ RECOMMENDATIONS:\n" +
            "  1. Switch to aggressive compression for all file reads\n" +
            "  2. Use tg_navigate action:\"search\" instead of reading files directly\n" +
            "  3. Minimize output length — emit only patches\n" +
            "  4. Consider starting a new session soon";
    } else if (prediction.alertLevel === "warning") {
        recommendations =
            "\n\n💡 RECOMMENDATIONS:\n" +
            "  1. Use tg_code action:\"compress\" for files > 100 lines\n" +
            "  2. Prefer tg_navigate action:\"search\" over grep/glob\n" +
            "  3. Keep responses concise";
    }

    const saved = Embedder.estimateTokens(report + indexSection + dangerZones);

    return {
        content: [{
            type: "text" as const,
            text:
                report +
                indexSection +
                dangerZones +
                recommendations +
                `\n\n[TokenGuard saved ~${saved.toLocaleString()} tokens on this query]`,
        }],
    };
}

async function handleReport(
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine, monitor, circuitBreaker } = deps;

    const sessionReport = engine.getSessionReport();
    const burnRate = monitor.computeBurnRate();
    const prediction = monitor.predictExhaustion();
    const usageStats = engine.getUsageStats();
    const cbStats = circuitBreaker.getStats();
    const pins = listPins(process.cwd());

    const fileTypeRows = sessionReport.byFileType.length > 0
        ? sessionReport.byFileType.map(ft =>
            `  ${ft.ext.padEnd(6)} — ${ft.count} files, ` +
            `avg ${(ft.ratio * 100).toFixed(0)}% compression, ` +
            `${ft.tokensSaved.toLocaleString()} tokens saved`,
        ).join("\n")
        : "  (no compressions yet)";

    let trendMsg = "Stable";
    if (burnRate.tokensPerMinute > 0) {
        trendMsg = burnRate.tokensPerMinute > 3000
            ? "High (consider aggressive compression)"
            : burnRate.tokensPerMinute > 1000
                ? "Moderate"
                : "Low (efficient usage)";
    }

    let modelRec = "No recommendation yet (insufficient data).";
    if (sessionReport.totalTokensSaved > 0) {
        const sonnetSavings = sessionReport.savedUsdSonnet;
        const opusSavings = sessionReport.savedUsdOpus;
        if (opusSavings > 0.50) {
            modelRec = `Consider Sonnet for exploration to save ~$${(opusSavings - sonnetSavings).toFixed(2)}/session. Use Opus for final implementation.`;
        } else {
            modelRec = `Current usage is efficient. TokenGuard has saved $${sonnetSavings.toFixed(3)} (Sonnet) / $${opusSavings.toFixed(3)} (Opus).`;
        }
    }

    const modelName = burnRate.estimatedCostUsd > 0
        ? (burnRate.estimatedCostUsd / Math.max(1, burnRate.totalConsumed) > 0.01
            ? "Opus" : "Sonnet")
        : "Unknown";

    const pad = (v: string | number, w: number) => String(v).padStart(w);
    const usdStr = Math.max(
        sessionReport.savedUsdSonnet,
        sessionReport.savedUsdOpus,
    ).toFixed(2);

    const receipt = [
        "",
        "+--------------------------------------------------+",
        "|          TOKENGUARD SESSION RECEIPT               |",
        "+--------------------------------------------------+",
        `|  Input Tokens Saved:      ${pad(sessionReport.totalTokensSaved.toLocaleString(), 16)}    |`,
        `|  Output Tokens Avoided:   ${pad(usageStats.total_saved.toLocaleString(), 16)}    |`,
        `|  Search Queries:          ${pad(usageStats.tool_calls, 16)}    |`,
        `|  Surgical Edits:          ${pad(cbStats.totalToolCalls, 16)}    |`,
        `|  Syntax Errors Blocked:   ${pad(cbStats.loopsPrevented, 16)}    |`,
        `|  Doom Loops Prevented:    ${pad(cbStats.loopsDetected, 16)}    |`,
        `|  Breaker Redirects:      ${pad(cbStats.redirectsIssued, 16)}    |`,
        `|  Redirects Recovered:    ${pad(cbStats.redirectsSuccessful, 16)}    |`,
        `|  Pinned Rules Active:     ${pad(pins.length, 16)}    |`,
        "+--------------------------------------------------+",
        `|  ESTIMATED SAVINGS:       ${pad("$" + usdStr, 16)}    |`,
        `|  MODEL:                   ${pad(modelName, 16)}    |`,
        `|  TOOLS USED:              ${pad(usageStats.tool_calls + " calls", 16)}    |`,
        "+--------------------------------------------------+",
        "",
        "💡 Did TokenGuard save your session?",
        "   Share this receipt → https://github.com/Ruso-0/TokenGuard/discussions",
    ].join("\n");

    const report = [
        "===================================================",
        "  TokenGuard — Session Report",
        "===================================================",
        "",
        `  Session Duration:     ${sessionReport.durationMinutes} min`,
        `  Total Tokens Saved:   ${sessionReport.totalTokensSaved.toLocaleString()}`,
        `  Total Processed:      ${sessionReport.totalOriginalTokens.toLocaleString()}`,
        `  Overall Compression:  ${(sessionReport.overallRatio * 100).toFixed(1)}%`,
        "",
        "  USD Saved (estimated):",
        `    Sonnet ($3/M input):   $${sessionReport.savedUsdSonnet.toFixed(3)}`,
        `    Opus ($15/M input):    $${sessionReport.savedUsdOpus.toFixed(3)}`,
        "",
        "  Per-File-Type Breakdown:",
        fileTypeRows,
        "",
        `  Burn Rate:            ${burnRate.tokensPerMinute.toLocaleString()} tok/min`,
        `  Trend:                ${trendMsg}`,
        `  Prediction:           ${prediction.message}`,
        "",
        `  Model Recommendation: ${modelRec}`,
        "===================================================",
    ].join("\n");

    return {
        content: [{
            type: "text" as const,
            text: report + receipt,
        }],
    };
}
