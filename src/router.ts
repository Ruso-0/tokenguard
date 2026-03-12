/**
 * router.ts — Central dispatcher for TokenGuard v3.3.0 router tools.
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
 *   tg_guard    → pin, unpin, status, report, reset, set_plan, memorize
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
import { extractDependencies, cleanSignature, isSensitiveSignature, escapeRegExp } from "./utils/imports.js";
import type { CompressionLevel } from "./compressor-advanced.js";

// ─── Neural State Consolidation ─────────────────────────────────────

/**
 * Neural State Consolidation — Adaptive Anti-Amnesia Heartbeat.
 *
 * Re-injects a 4-layer cognitive state every ~15 tool calls to survive
 * Claude Code's context compaction. Uses the "Attention Sandwich" pattern:
 * memory ABOVE, tool result BELOW (respects U-shaped attention curve).
 *
 * Psychological Filter: Only fires during context-gathering actions
 * (read, search, map, status, definition, references, outline).
 * Never fires during edit, undo, or filter_output.
 *
 * Layers:
 * 1. Cortex — Master Plan (PLAN.md, schemas, constraints)
 * 2. Working Memory — Claude's scratchpad notes
 * 3. Hippocampus — Recent successful edits (spatial awareness)
 * 4. Executive Attention — Circuit Breaker emergencies
 */
function applyAntiAmnesiaHeartbeat(
    action: string,
    response: McpToolResponse,
    deps: RouterDependencies,
): McpToolResponse {
    if (response.isError || !response.content || response.content[0]?.type !== "text") {
        return response;
    }

    try {
        const currentCalls = deps.circuitBreaker.getStats().totalToolCalls;
        let lastInjectCalls = parseInt(
            deps.engine.getMetadata("tg_plan_last_inject") || "0",
            10,
        );

        // FIX: Session restart detection — if counter reset, reset the injection marker
        if (currentCalls < lastInjectCalls) {
            lastInjectCalls = 0;
            deps.engine.setMetadata("tg_plan_last_inject", "0");
        }

        if (currentCalls - lastInjectCalls >= 15) {
            const safeActions = [
                "read", "search", "map", "status",
                "definition", "references", "outline",
            ];

            if (safeActions.includes(action)) {
                let memoryPayload = "";

                // LAYER 1: Cortex — Master Plan
                const planPath = deps.engine.getMetadata("tg_master_plan");
                if (planPath && fs.existsSync(planPath)) {
                    const planContent = readSource(planPath);
                    if (planContent.length < 15000) {
                        memoryPayload +=
                            `=== MASTER PLAN (${path.basename(planPath)}) ===\n` +
                            `${planContent}\n\n`;
                    }
                }

                // LAYER 2: Working Memory — Scratchpad
                const scratchpad = deps.engine.getMetadata("tg_scratchpad");
                if (scratchpad) {
                    memoryPayload +=
                        `=== ACTIVE SCRATCHPAD (Your Notes) ===\n` +
                        `${scratchpad}\n\n`;
                }

                // LAYER 2b: Pinned Rules
                try {
                    const pinnedText = getPinnedText(process.cwd());
                    if (pinnedText) {
                        memoryPayload += `${pinnedText}\n\n`;
                    }
                } catch {
                    // getPinnedText may fail — skip gracefully
                }

                // LAYER 3: Hippocampus — Recent Successful Edits
                const history = deps.circuitBreaker.getState().history;
                const recentEdits = new Set<string>();
                const scanWindow = Math.max(0, history.length - 15);
                for (let i = history.length - 1; i >= scanWindow; i--) {
                    const record = history[i];
                    if (
                        record.filePath &&
                        !record.errorHash
                    ) {
                        recentEdits.add(path.basename(record.filePath));
                    }
                }
                if (recentEdits.size > 0) {
                    memoryPayload +=
                        `=== SPATIAL AWARENESS (Recent Edits) ===\n` +
                        `You recently modified: ${Array.from(recentEdits).join(", ")}.\n\n`;
                }

                // LAYER 4: Executive Attention — Circuit Breaker State
                const cbState = deps.circuitBreaker.getState();
                if (cbState.escalationLevel > 0) {
                    const target =
                        cbState.lastTrippedSymbol ||
                        cbState.lastTrippedFile ||
                        "a critical component";
                    memoryPayload +=
                        `=== EMERGENCY FOCUS (CIRCUIT BREAKER LEVEL ${cbState.escalationLevel}) ===\n` +
                        `You are executing a "Break & Build" strategy on \`${target}\`.\n` +
                        `Do not deviate until this is resolved.\n\n`;
                }

                // ATTENTION SANDWICH: Memory ABOVE, tool result BELOW
                if (memoryPayload.trim().length > 0) {
                    const header =
                        `=================================================================\n` +
                        ` [TOKENGUARD NEURAL SYNC: STATE CONSOLIDATION]\n` +
                        ` Context compaction detected. Restoring cognitive state:\n` +
                        `=================================================================\n\n`;

                    const footer =
                        `=================================================================\n` +
                        `[END NEURAL SYNC] Proceed with the tool result below:\n` +
                        `=================================================================\n\n`;

                    const newResponse = {
                        ...response,
                        content: [...response.content],
                    };
                    const originalText = response.content[0].text;

                    newResponse.content[0] = {
                        type: "text" as const,
                        text: header + memoryPayload + footer + originalText,
                    };

                    deps.engine.setMetadata(
                        "tg_plan_last_inject",
                        String(currentCalls),
                    );

                    return newResponse;
                }
            }
        }
    } catch {
        // Fail silently — never break the core tool response
    }

    return response;
}

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
    auto_context?: boolean;
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
    auto_context?: boolean;
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
    let response: McpToolResponse;
    switch (action) {
        case "search": response = await handleSearch(params, deps); break;
        case "definition": response = await handleDefinition(params, deps); break;
        case "references": response = await handleReferences(params, deps); break;
        case "outline": response = await handleOutline(params, deps); break;
        case "map": response = await handleMap(params, deps); break;
        default:
            return {
                content: [{
                    type: "text" as const,
                    text: `Unknown tg_navigate action: "${action}". Valid actions: search, definition, references, outline, map.`,
                }],
                isError: true,
            };
    }
    return applyAntiAmnesiaHeartbeat(action, response, deps);
}

// ─── tg_code ────────────────────────────────────────────────────────

export async function handleCode(
    action: string,
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    let response: McpToolResponse;
    switch (action) {
        case "read": response = await handleRead(params, deps); break;
        case "compress": response = await handleCompress(params, deps); break;
        case "edit": response = await handleEdit(params, deps); break;
        case "undo": response = await handleUndo(params, deps); break;
        case "filter_output": response = await handleFilterOutput(params, deps); break;
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
    return applyAntiAmnesiaHeartbeat(action, response, deps);
}

// ─── tg_guard ───────────────────────────────────────────────────────

export async function handleGuard(
    action: string,
    params: GuardParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    let response: McpToolResponse;
    switch (action) {
        case "pin": response = await handlePin(params, deps); break;
        case "unpin": response = await handleUnpin(params, deps); break;
        case "status": response = await handleStatus(deps); break;
        case "report": response = await handleReport(deps); break;
        case "reset": response = await handleReset(deps); break;
        case "set_plan": response = await handleSetPlan(params, deps); break;
        case "memorize": response = await handleMemorize(params, deps); break;
        default:
            return {
                content: [{
                    type: "text" as const,
                    text: `Unknown tg_guard action: "${action}". Valid actions: pin, unpin, status, report, reset, set_plan, memorize.`,
                }],
                isError: true,
            };
    }
    return applyAntiAmnesiaHeartbeat(action, response, deps);
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

    // Estimate: grep would read entire files, not just matched functions.
    // Count each unique file's raw code once (conservative estimate).
    const seenFiles = new Set<string>();
    let grepEstimate = 0;
    for (const r of results) {
        if (!seenFiles.has(r.path)) {
            seenFiles.add(r.path);
            // Estimate full file as ~5x the matched chunk (conservative)
            grepEstimate += Embedder.estimateTokens(r.rawCode) * 5;
        }
    }
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
                `\n\n[TokenGuard saved ~${saved.toLocaleString()} tokens on this query (estimated)]`,
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

    // Auto-Context: resolve signatures of imported dependencies used in the body
    const autoContext = params.auto_context !== false;
    let autoContextBlock = "";
    let extraTokens = 0;

    if (autoContext && results.length > 0) {
        try {
            const targetResult = results[0];
            const ext = path.extname(targetResult.filePath).toLowerCase();
            const fileContent = readSource(safePath(root, targetResult.filePath));

            const allImports = extractDependencies(fileContent, ext);

            // THE GOLD FILTER: Only inject deps that are actually USED in the body.
            // Uses localName (alias) for matching, symbol (original) for search.
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
                        `TokenGuard resolved these external dependencies used in the definition:\n` +
                        safeSigs.join("\n");
                    extraTokens = Embedder.estimateTokens(autoContextBlock);
                    engine.incrementAutoContext();
                }
            }
        } catch {
            // Never crash the tool on auto-context failure
        }
    }

    engine.logUsage("tg_def", bodyTokens + extraTokens, bodyTokens + extraTokens, 0);

    return {
        content: [{
            type: "text" as const,
            text:
                `## Definition: ${symbol}\n` +
                `Found ${results.length} definition(s).\n\n` +
                formatted.join("\n\n") +
                autoContextBlock +
                `\n\n[TokenGuard: ${(bodyTokens + extraTokens).toLocaleString()} tokens — exact AST lookup, no search overhead]`,
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

        // Read file ONCE — reused for auto-context extraction and compression
        const rawContent = readSource(resolvedPath);

        // Auto-Context extraction (runs before compress/raw branch)
        const autoContext = params.auto_context !== false;
        let autoContextBlock = "";
        let extraTokens = 0;

        if (autoContext) {
            try {
                const ext = path.extname(resolvedPath).toLowerCase();
                const depsList = extractDependencies(rawContent, ext);

                if (depsList.length > 0) {
                    const rawSignatures = engine.resolveImportSignatures(depsList.slice(0, 15));
                    const safeSigs = rawSignatures
                        .map(s => `- \`${cleanSignature(s.raw)}\` (from ${path.basename(s.path)})`)
                        .filter(s => !isSensitiveSignature(s));

                    if (safeSigs.length > 0) {
                        autoContextBlock =
                            `\n\n### Related Signatures (auto-detected, may be incomplete)\n` +
                            `TokenGuard resolved these external dependencies imported in this file:\n` +
                            safeSigs.join("\n");
                        extraTokens = Embedder.estimateTokens(autoContextBlock);
                        engine.incrementAutoContext();
                    }
                }
            } catch {
                // Never crash on auto-context failure
            }
        }

        // Skip compression for small files (< 1KB)
        if (stat.size < 1024) {
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## ${path.basename(resolvedPath)} (raw — ${stat.size} bytes, below 1KB threshold)\n\n` +
                        `\`\`\`\n${rawContent}\n\`\`\`\n\n` +
                        autoContextBlock +
                        `[TokenGuard: file too small to compress]`,
                }],
            };
        }

        const compress = params.compress !== false;
        const level: CompressionLevel = (typeof params.level === "string" &&
            ["light", "medium", "aggressive"].includes(params.level))
            ? params.level as CompressionLevel
            : "medium";

        if (!compress) {
            // Mark as safely read (removes from Danger Zones)
            engine.markFileRead(resolvedPath);

            // Behavioral advisor: teach Claude to use compression next time
            let advice = "";
            if (deps.hook) {
                const intercept = deps.hook.evaluateFileRead(resolvedPath, rawContent);
                if (intercept.shouldIntercept) {
                    advice = `\n\n${intercept.suggestion}`;
                }
            }

            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## ${path.basename(resolvedPath)} (raw)\n\n` +
                        `\`\`\`\n${rawContent}\n\`\`\`\n\n` +
                        autoContextBlock +
                        `[TokenGuard: raw read, no compression applied]${advice}`,
                }],
            };
        }

        const result = await engine.compressFileAdvanced(resolvedPath, level, rawContent);
        engine.markFileRead(resolvedPath);
        const saved = result.tokensSaved;

        engine.logUsage(
            "tg_read",
            Embedder.estimateTokens(result.compressed) + extraTokens,
            Embedder.estimateTokens(result.compressed) + extraTokens,
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
                    autoContextBlock +
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
            ? params.level as CompressionLevel
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
        `|  Context Injections:      ${pad(sessionReport.autoContextInjections, 16)}    |`,
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

// ─── Heartbeat Handlers ─────────────────────────────────────────────

async function handleSetPlan(
    params: GuardParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    await deps.engine.initialize();

    if (!params.text) {
        return {
            content: [{ type: "text" as const, text: "Error: provide the file path to your plan via 'text'." }],
            isError: true,
        };
    }

    let resolvedPath: string;
    try {
        resolvedPath = safePath(process.cwd(), params.text);
        if (!fs.existsSync(resolvedPath)) throw new Error("File does not exist.");
    } catch (err) {
        return {
            content: [{ type: "text" as const, text: `## Set Plan: FAILED\n\n${(err as Error).message}` }],
            isError: true,
        };
    }

    const planContent = readSource(resolvedPath);
    const planTokens = Embedder.estimateTokens(planContent);

    // Bankruptcy Shield: reject plans that would burn too much context per heartbeat
    if (planTokens > 4000) {
        return {
            content: [{
                type: "text" as const,
                text:
                    `## Set Plan: REJECTED (Too Large)\n\n` +
                    `Your plan is estimated at **~${planTokens.toLocaleString()} tokens**.\n` +
                    `TokenGuard injects this every ~15 tool calls. A plan this large will burn ` +
                    `context rapidly and accelerate compaction instead of preventing it.\n\n` +
                    `**Action:** Summarize your \`${path.basename(resolvedPath)}\` into strict ` +
                    `bullet points (aim for < 1,500 tokens), then try again.`,
            }],
            isError: true,
        };
    }

    deps.engine.setMetadata("tg_master_plan", resolvedPath);
    deps.engine.setMetadata(
        "tg_plan_last_inject",
        String(deps.circuitBreaker.getStats().totalToolCalls),
    );

    return {
        content: [{
            type: "text" as const,
            text:
                `## Master Plan Anchored\n\n` +
                `**Path:** ${resolvedPath}\n` +
                `**Cost:** ~${planTokens.toLocaleString()} tokens per heartbeat\n\n` +
                `TokenGuard's Anti-Amnesia Protocol is now ACTIVE. It will silently re-inject ` +
                `these constraints every ~15 tool calls during context-gathering operations.\n\n` +
                `*Tip: Use \`tg_guard action:"memorize"\` as you progress to leave notes for your future self.*`,
        }],
    };
}

async function handleMemorize(
    params: GuardParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    await deps.engine.initialize();

    if (!params.text) {
        return {
            content: [{ type: "text" as const, text: "Error: provide thoughts to memorize via 'text'." }],
            isError: true,
        };
    }

    // Limit scratchpad size to prevent context bloat
    if (params.text.length > 5000) {
        return {
            content: [{ type: "text" as const, text: "Error: scratchpad text too long (max 5,000 chars). Summarize your notes." }],
            isError: true,
        };
    }

    deps.engine.setMetadata("tg_scratchpad", params.text);

    return {
        content: [{
            type: "text" as const,
            text:
                `## Memory Saved\n\n` +
                `TokenGuard has written your thoughts to the Active Scratchpad. ` +
                `If context compaction occurs, these notes will be automatically ` +
                `re-injected so you don't lose your train of thought.`,
        }],
    };
}
