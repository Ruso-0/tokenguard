/**
 * router.ts - Central dispatcher for NREKI router tools.
 *
 * Maps {toolName, action} pairs to existing handler functions.
 * All business logic remains in the original modules - this file
 * only wires up the routing and formats MCP responses.
 *
 * v3.0.1: Flat parameter schemas (no more generic `options` bag),
 * file-level mutex on edits, terminal renamed to filter_output.
 *
 * 3 router tools replace 16 individual tools:
 *   nreki_navigate → search, definition, references, outline, map, prepare_refactor
 *   nreki_code     → read, compress, edit, batch_edit, undo, filter_output
 *   nreki_guard    → pin, unpin, status, report, reset, set_plan, memorize
 */

import fs from "fs";
import path from "path";

import { NrekiEngine } from "./engine.js";
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
import { semanticEdit, batchSemanticEdit, detectSignatureChange, type EditMode, type BatchEditOp } from "./semantic-edit.js";
import { addPin, removePin, listPins, getPinnedText } from "./pin-memory.js";
import { readSource } from "./utils/read-source.js";
import { restoreBackup, saveBackup } from "./undo.js";
import { NrekiKernel, type NrekiInterceptResult, type TypeRegression } from "./kernel/nreki-kernel.js";
import { acquireFileLock, releaseFileLock } from "./middleware/file-lock.js";
import { PreToolUseHook } from "./hooks/preToolUse.js";
import { ChronosMemory } from "./chronos-memory.js";
import { extractDependencies, cleanSignature, isSensitiveSignature, escapeRegExp } from "./utils/imports.js";
import type { CompressionLevel } from "./compressor-advanced.js";


// ─── JIT Holography Helper ──────────────────────────────────────────
/**
 * Ensure hologram mode is ready (JIT or eager fallback).
 * Called before kernel.boot() when no pre-computed shadows exist.
 */
async function ensureHologramReady(kernel: NrekiKernel, nrekiMode: string): Promise<void> {
    if (nrekiMode !== "hologram" || kernel.hasShadows() || kernel.hasJitHologram()) return;
    try {
        const Parser = (await import("web-tree-sitter")).default;
        await Parser.init();
        const jitParser = new Parser();
        const wasmDir = path.join(
            path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1")),
            "..", "wasm",
        );
        const tsLangPath = path.join(wasmDir, "tree-sitter-typescript.wasm").replace(/\\/g, "/");
        const tsLanguage = await Parser.Language.load(tsLangPath);
        jitParser.setLanguage(tsLanguage);
        const { classifyAndGenerateShadow } = await import("./hologram/shadow-generator.js");
        kernel.setJitParser(jitParser, tsLanguage);
        kernel.setJitClassifier(classifyAndGenerateShadow);
        console.error("[NREKI] JIT Holography: parser loaded on-demand.");
    } catch (err) {
        console.error(`[NREKI] JIT init failed: ${(err as Error).message}. Falling back to eager scan.`);
        const { ParserPool } = await import("./parser-pool.js");
        const { scanProject } = await import("./hologram/shadow-generator.js");
        const pool = new ParserPool(4);
        const scanResult = await scanProject(process.cwd(), pool);
        kernel.setShadows(scanResult.prunable, scanResult.unprunable, scanResult.ambientFiles);
    }
}

// ─── Context Heartbeat ──────────────────────────────────────────────

/**
 * Context Heartbeat - Session State Re-injection.
 *
 * Re-injects a 4-layer session state every ~15 tool calls to survive
 * Claude Code's context compaction. Injects memory ABOVE the tool result
 * (respects U-shaped attention curve in transformer models).
 *
 * Only fires during read-only actions (read, search, map, status,
 * definition, references, outline). Never during edit, undo, or filter_output.
 *
 * Layers:
 * 1. Plan File - Anchored plan document (PLAN.md, schemas, constraints)
 * 2. Scratchpad - Claude's progress notes
 * 3. Recent Edits - Files modified in this session
 * 4. Circuit Breaker - Active escalation alerts
 */
export function applyContextHeartbeat(
    action: string,
    response: McpToolResponse,
    deps: RouterDependencies,
): McpToolResponse {
    if (response.isError || !response.content || response.content[0]?.type !== "text") {
        return response;
    }

    // C4: Don't inject heartbeat during active circuit breaker escalation
    if (deps.circuitBreaker.getState().escalationLevel >= 2) {
        return response;
    }

    try {
        const currentCalls = deps.circuitBreaker.getStats().totalToolCalls;
        let lastInjectCalls = parseInt(
            deps.engine.getMetadata("nreki_plan_last_inject") || "0",
            10,
        );

        // FIX: Session restart detection - if counter reset, reset the injection marker
        if (currentCalls < lastInjectCalls) {
            lastInjectCalls = 0;
            deps.engine.setMetadata("nreki_plan_last_inject", "0");
        }

        if (currentCalls - lastInjectCalls >= 15) {
            const safeActions = [
                "read", "search", "map", "status",
                "definition", "references", "outline",
            ];

            if (safeActions.includes(action)) {
                let memoryPayload = "";

                // LAYER 1: Plan File
                const planPath = deps.engine.getMetadata("nreki_master_plan");
                if (planPath && fs.existsSync(planPath)) {
                    const planContent = readSource(planPath);
                    if (planContent.length < 15000) {
                        memoryPayload +=
                            `=== PLAN FILE (${path.basename(planPath)}) ===\n` +
                            `${planContent}\n\n`;
                    } else {
                        memoryPayload +=
                            `=== PLAN FILE ===\n` +
                            `[WARNING: Your plan file "${path.basename(planPath)}" exceeds 15,000 characters (${planContent.length.toLocaleString()} chars). ` +
                            `NREKI skipped injection to protect your context window. ` +
                            `Summarize it or split it into smaller files, then re-anchor with: ` +
                            `nreki_guard action:"set_plan" text:"<shorter_plan_file>"]\n\n`;
                    }
                }

                // LAYER 2: Scratchpad
                const scratchpad = deps.engine.getMetadata("nreki_scratchpad");
                if (scratchpad) {
                    memoryPayload +=
                        `=== SCRATCHPAD (Your Notes) ===\n` +
                        `${scratchpad}\n\n`;
                }

                // LAYER 2b: Pinned Rules
                try {
                    const pinnedText = getPinnedText(process.cwd());
                    if (pinnedText) {
                        memoryPayload += `${pinnedText}\n\n`;
                    }
                } catch {
                    // getPinnedText may fail - skip gracefully
                }

                // LAYER 3: Recent Edits
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
                        `=== RECENT EDITS ===\n` +
                        `You recently modified: ${Array.from(recentEdits).join(", ")}.\n\n`;
                }

                // LAYER 4: Circuit Breaker Alert
                const cbState = deps.circuitBreaker.getState();
                if (cbState.escalationLevel > 0) {
                    const target =
                        cbState.lastTrippedSymbol ||
                        cbState.lastTrippedFile ||
                        "a critical component";
                    memoryPayload +=
                        `=== CIRCUIT BREAKER ALERT (LEVEL ${cbState.escalationLevel}) ===\n` +
                        `You are executing a "Break & Build" strategy on \`${target}\`.\n` +
                        `Do not deviate until this is resolved.\n\n`;
                }

                // TOP-INJECTION: State ABOVE, tool result BELOW
                if (memoryPayload.trim().length > 0) {
                    const header =
                        `=================================================================\n` +
                        ` [NREKI CONTEXT HEARTBEAT]\n` +
                        ` Context compaction detected. Restoring session state:\n` +
                        `=================================================================\n\n`;

                    const footer =
                        `=================================================================\n` +
                        `[END CONTEXT HEARTBEAT] Proceed with tool result below:\n` +
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
                        "nreki_plan_last_inject",
                        String(currentCalls),
                    );

                    return newResponse;
                }
            }
        }
    } catch {
        // Fail silently - never break the core tool response
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
    engine: NrekiEngine;
    monitor: TokenMonitor;
    sandbox: AstSandbox;
    circuitBreaker: CircuitBreaker;
    hook?: PreToolUseHook;
    kernel?: NrekiKernel;
    chronos?: ChronosMemory;
    nrekiMode?: "syntax" | "file" | "project" | "hologram";
}

/** Flat params for nreki_navigate (replaces target + options bag). */
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

/** Flat params for nreki_code (replaces path + options bag). */
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
    edits?: Array<{ path: string; symbol: string; new_code: string; mode?: string }>;
}

/** Flat params for nreki_guard (replaces options bag). */
export interface GuardParams {
    action: string;
    text?: string;
    index?: number;
    id?: string;
}

// ─── nreki_navigate ────────────────────────────────────────────────────

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
        case "prepare_refactor": response = await handlePrepareRefactor(params, deps); break;
        default:
            return {
                content: [{
                    type: "text" as const,
                    text: `Unknown nreki_navigate action: "${action}". Valid actions: search, definition, references, outline, map, prepare_refactor.`,
                }],
                isError: true,
            };
    }
    return applyContextHeartbeat(action, response, deps);
}

// ─── nreki_code ────────────────────────────────────────────────────────

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
        case "batch_edit": response = await handleBatchEdit(params, deps); break;
        case "undo": response = await handleUndo(params, deps); break;
        case "filter_output": response = await handleFilterOutput(params, deps); break;
        default: {
            const hint = action === "terminal"
                ? ' (Note: "terminal" was renamed to "filter_output" in v3.0.1)'
                : "";
            return {
                content: [{
                    type: "text" as const,
                    text: `Unknown nreki_code action: "${action}"${hint}. Valid actions: read, compress, edit, batch_edit, undo, filter_output.`,
                }],
                isError: true,
            };
        }
    }
    return applyContextHeartbeat(action, response, deps);
}

// ─── nreki_guard ───────────────────────────────────────────────────────

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
                    text: `Unknown nreki_guard action: "${action}". Valid actions: pin, unpin, status, report, reset, set_plan, memorize.`,
                }],
                isError: true,
            };
    }
    return applyContextHeartbeat(action, response, deps);
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
                `[NREKI: circuit breaker reset by human]`,
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
                    `[NREKI saved ~0 tokens on this query]`,
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

    engine.logUsage("nreki_search", searchTokens, searchTokens, saved);

    return {
        content: [{
            type: "text" as const,
            text:
                `## NREKI Search: "${query}"\n` +
                `Found ${results.length} results across ${new Set(results.map(r => r.path)).size} files.\n\n` +
                formatted.join("\n\n") +
                `\n\n[NREKI saved ~${saved.toLocaleString()} tokens on this query (estimated)]`,
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

// ─── Sniper Refactor ─────────────────────────────────────────────────

import type Parser from "web-tree-sitter";

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

/**
 * Classify an AST node for refactoring confidence.
 * "high" = structural usage (safe to rename), "review" = might be string/comment/key.
 */
function classifyRefactorConfidence(
    node: Parser.SyntaxNode,
): "high" | "review" {
    const nodeType = node.type;
    const parentType = node.parent?.type || "";

    if (DANGEROUS_REFACTOR_NODES.has(nodeType) || DANGEROUS_REFACTOR_NODES.has(parentType)) {
        return "review";
    }

    // Left side of key-value pair
    if (KV_PARENTS.has(parentType) && node.parent?.child(0) === node) {
        return "review";
    }

    return "high";
}

async function handlePrepareRefactor(
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
            console.error("[NREKI] Predictive Blast Radius failed:", err);
            // Fallthrough to Layer 1 (AST heuristics)
        }
    }
    // ─── LAYER 1: HEURISTIC AST FALLBACK ───

    const parser = engine.getParser();

    // Exhaustive search: scan raw_code for 100% coverage (not just signatures)
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
        const fp = filePath; // capture for closure

        await parser.parseRaw(fullPath, content, (tree: Parser.Tree) => {
            // Walk tree for all identifier nodes matching the symbol
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

    // Format response
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
                text: `Security error: ${(err as Error).message}\n\n[NREKI saved ~0 tokens]`,
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
                    text: `File skipped: ${filterResult.reason}\n\n[NREKI saved ~0 tokens]`,
                }],
            };
        }

        // Read file ONCE - reused for auto-context extraction and compression
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
                            `NREKI resolved these external dependencies imported in this file:\n` +
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
            const jitWarning = deps.chronos ? deps.chronos.getContextWarnings(resolvedPath) : "";

            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## ${path.basename(resolvedPath)} (raw - ${stat.size} bytes, below 1KB threshold)\n\n` +
                        jitWarning +
                        `\`\`\`\n${rawContent}\n\`\`\`\n\n` +
                        autoContextBlock +
                        `[NREKI: file too small to compress]`,
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

            // CHRONOS: Marcar lectura descomprimida para desbloquear edición
            if (deps.chronos) deps.chronos.markReadUncompressed(resolvedPath);

            // Behavioral advisor: teach Claude to use compression next time
            let advice = "";
            if (deps.hook) {
                const intercept = deps.hook.evaluateFileRead(resolvedPath, rawContent);
                if (intercept.shouldIntercept) {
                    advice = `\n\n${intercept.suggestion}`;
                }
            }

            const jitWarning = deps.chronos ? deps.chronos.getContextWarnings(resolvedPath) : "";

            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## ${path.basename(resolvedPath)} (raw)\n\n` +
                        jitWarning +
                        `\`\`\`\n${rawContent}\n\`\`\`\n\n` +
                        autoContextBlock +
                        `[NREKI: raw read, no compression applied]${advice}`,
                }],
            };
        }

        const result = await engine.compressFileAdvanced(resolvedPath, level, rawContent);
        engine.markFileRead(resolvedPath);
        const saved = result.tokensSaved;

        engine.logUsage(
            "nreki_read",
            Embedder.estimateTokens(result.compressed) + extraTokens,
            Embedder.estimateTokens(result.compressed) + extraTokens,
            saved,
        );

        const sessionReport = engine.getSessionReport();

        const mapHint = level === "aggressive"
            ? "See nreki_navigate action:\"map\" for full project structure. Showing only the requested code:\n\n"
            : "";

        const jitWarning = deps.chronos ? deps.chronos.getContextWarnings(resolvedPath) : "";

        return {
            content: [{
                type: "text" as const,
                text:
                    `## ${path.basename(resolvedPath)} (${level} compression)\n` +
                    `${result.originalSize.toLocaleString()} → ${result.compressedSize.toLocaleString()} chars ` +
                    `(${(result.ratio * 100).toFixed(1)}% reduction)\n\n` +
                    mapHint +
                    jitWarning +
                    `\`\`\`\n${result.compressed}\n\`\`\`\n\n` +
                    autoContextBlock +
                    `[NREKI saved ~${saved.toLocaleString()} tokens | ` +
                    `Session: ~${sessionReport.totalTokensSaved.toLocaleString()} tokens saved]`,
            }],
        };
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Error reading ${file_path}: ${(err as Error).message}\n\n[NREKI saved ~0 tokens]`,
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
                text: `Security error: ${(err as Error).message}\n\n[NREKI saved ~0 tokens on this query]`,
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
                "nreki_compress",
                Embedder.estimateTokens(result.compressed),
                Embedder.estimateTokens(result.compressed),
                saved,
            );

            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## NREKI Advanced Compress: ${path.basename(resolvedPath)}\n` +
                        `Level: ${compression_level} | ` +
                        `${result.originalSize.toLocaleString()} → ${result.compressedSize.toLocaleString()} chars ` +
                        `(${(result.ratio * 100).toFixed(1)}% reduction)\n` +
                        `  Preprocessing: -${result.breakdown.preprocessingReduction.toLocaleString()} chars\n` +
                        `  Token filtering: -${result.breakdown.tokenFilterReduction.toLocaleString()} chars\n` +
                        `  Structural: -${result.breakdown.structuralReduction.toLocaleString()} chars\n\n` +
                        `\`\`\`\n${result.compressed}\n\`\`\`\n\n` +
                        `[NREKI saved ~${saved.toLocaleString()} tokens | ` +
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
            "nreki_compress",
            Embedder.estimateTokens(result.compressed),
            Embedder.estimateTokens(result.compressed),
            saved,
        );

        return {
            content: [{
                type: "text" as const,
                text:
                    `## NREKI Compressed: ${path.basename(resolvedPath)}\n` +
                    `Tier ${tier} | ${result.chunksFound} chunks | ` +
                    `${result.originalSize.toLocaleString()} → ${result.compressedSize.toLocaleString()} chars ` +
                    `(${(result.ratio * 100).toFixed(1)}% reduction)\n\n` +
                    `\`\`\`\n${result.compressed}\n\`\`\`\n\n` +
                    `[NREKI saved ~${saved.toLocaleString()} tokens on this query]`,
            }],
        };
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Error compressing ${file_path}: ${(err as Error).message}\n\n[NREKI saved ~0 tokens on this query]`,
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
                text: `Error: "symbol" and "new_code" are required for the edit action.\n\n[NREKI saved ~0 tokens]`,
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
                text: `Security error: ${(err as Error).message}\n\n[NREKI saved ~0 tokens]`,
            }],
            isError: true,
        };
    }

    // Acquire file-level mutex to prevent concurrent edit corruption
    const lockResult = acquireFileLock(resolvedPath, "nreki_code:edit");
    if (!lockResult.acquired) {
        return {
            content: [{
                type: "text" as const,
                text:
                    `## Semantic Edit: BLOCKED\n\n` +
                    `File is currently locked by a concurrent edit (${lockResult.heldBy}, ${lockResult.heldForMs}ms ago).\n` +
                    `Wait for the current edit to complete and retry.\n\n` +
                    `[NREKI saved ~0 tokens]`,
            }],
            isError: true,
        };
    }

    // CHRONOS HARD BLOCK: high-friction file requires uncompressed read first
    if (deps.chronos && deps.chronos.isHighFriction(resolvedPath)) {
        if (!deps.chronos.hasReadUncompressed(resolvedPath)) {
            releaseFileLock(resolvedPath);
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## Edit Blocked - High Friction File\n\n` +
                        `File \`${path.basename(resolvedPath)}\` has high historical error rate (high Cognitive Friction Index).\n` +
                        `You attempted a blind edit without mapping its full logic into your context.\n\n` +
                        `**ACTION REQUIRED**: Run \`nreki_code action:"read" compress:false path:"${file}"\` first.\n` +
                        `NREKI will unlock the edit once you have read the uncompressed code.\n\n` +
                        `[NREKI: Chronos edit gating active]`,
                }],
                isError: true,
            };
        }
    }

    try {
        const parser = engine.getParser();
        const mode = (typeof params.mode === "string" && ["replace", "insert_before", "insert_after"].includes(params.mode))
            ? params.mode as EditMode
            : "replace";

        // Deferred boot: kernel boots on first edit, not at startup
        let useKernel = false;
        if (deps.kernel && deps.nrekiMode !== "syntax") {
            if (!deps.kernel.isBooted()) {
                console.error(
                    `[NREKI] Booting kernel (${deps.nrekiMode} mode). First edit will be slower.`
                );
                try {
                    await ensureHologramReady(deps.kernel, deps.nrekiMode ?? "");
                    deps.kernel.boot(
                        process.cwd(),
                        deps.nrekiMode as "file" | "project" | "hologram",
                    );
                } catch (err) {
                    console.error(
                        `[NREKI] Kernel boot failed: ${(err as Error).message}. Falling back to Layer 1.`
                    );
                }
            }
            useKernel = deps.kernel.isBooted();
        }

        const result = await semanticEdit(
            resolvedPath,
            symbol,
            new_code,
            parser,
            sandbox,
            mode,
            useKernel, // dryRun=true if kernel is active (ZERO DISK TOUCH)
        );

        if (!result.success || (useKernel && !result.newContent)) {
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## Semantic Edit: FAILED\n\n` +
                        `**Symbol:** ${symbol}\n` +
                        `**File:** ${file}\n\n` +
                        `${result.error}\n\n` +
                        `[NREKI saved ~0 tokens]`,
                }],
                isError: true,
            };
        }

        // ─── NREKI Layer 2: Cross-file semantic verification ─────────
        let kernelResult: NrekiInterceptResult | undefined;
        let ttrdFeedback = "";
        if (useKernel && deps.kernel) {
            // TOPOLOGICAL: compute dependents for hologram mode
            let dependentsToInject: string[] = [];
            if (deps.nrekiMode === "hologram") {
                try {
                    const relPath = path.relative(process.cwd(), resolvedPath).replace(/\\/g, "/");
                    const allDependents = await engine.findDependents(relPath);
                    if (allDependents.length <= 50) {
                        dependentsToInject = allDependents;
                    } else {
                        // Too many dependents - check if signature changed
                        const oldContent = fs.readFileSync(resolvedPath, "utf-8");
                        const newContent = result.newContent!;
                        const oldExports = oldContent.split("\n").filter(l => l.trim().startsWith("export")).join("\n");
                        const newExports = newContent.split("\n").filter(l => l.trim().startsWith("export")).join("\n");
                        if (oldExports !== newExports) {
                            // Signature changed + >50 dependents = too risky
                            releaseFileLock(resolvedPath);
                            return {
                                content: [{
                                    type: "text" as const,
                                    text: `[NREKI] Edit blocked: signature change affects ${allDependents.length} files. ` +
                                        `Validating this cascade exceeds safe limits. ` +
                                        `Use batch_edit to migrate callers explicitly.`
                                }],
                                isError: true
                            };
                        }
                        // Signature unchanged, safe to skip dependents
                        dependentsToInject = [];
                    }
                } catch {
                    // Engine not ready, proceed without dependents
                    dependentsToInject = [];
                }
            }

            try {
                // Pre-write validation in RAM. NO ZOMBIE TIMEOUT (Fix A3).
                kernelResult = await deps.kernel.interceptAtomicBatch([
                    { targetFile: resolvedPath, proposedContent: result.newContent! },
                ], dependentsToInject);

                if (!kernelResult.safe) {
                    // FP-2 + A5: Filter node_modules errors with path segment regex
                    const agentErrors = kernelResult.structured?.filter(e =>
                        !e.file.match(/[/\\]node_modules[/\\]/)
                    ) || [];

                    if (agentErrors.length === 0) {
                        // All errors from node_modules - agent's edit is fine
                        console.error(
                            `[NREKI] Warning: ${kernelResult.structured?.length} error(s) in node_modules ignored.`
                        );
                        try { saveBackup(process.cwd(), resolvedPath); } catch {}
                        await deps.kernel.commitToDisk();
                    } else {
                        // CHRONOS: Castigar los archivos donde ESTALLAN los errores (las víctimas)
                        if (deps.chronos) {
                            const errorByFile = new Map<string, string>();
                            for (const e of agentErrors) {
                                if (!errorByFile.has(e.file)) errorByFile.set(e.file, e.message);
                            }
                            for (const [fragileFile, firstMsg] of errorByFile.entries()) {
                                deps.chronos.recordSemanticError(fragileFile, firstMsg);
                            }
                        }

                        // REJECTED: Purge RAM. DISK WAS NEVER TOUCHED. ZERO RESTORES.
                        await deps.kernel.rollbackAll();

                        const structuredInfo = "\n\nSemantic errors:\n" +
                            agentErrors.map(e =>
                                `  → ${path.relative(process.cwd(), e.file)} (${e.line},${e.column}): ${e.code} - ${e.message}`
                            ).join("\n");

                        return {
                            content: [{
                                type: "text" as const,
                                text:
                                    `## Semantic Edit: BLOCKED BY NREKI (Layer 2)\n\n` +
                                    `**Symbol:** ${symbol}\n` +
                                    `**File:** ${file}\n\n` +
                                    `Layer 1 (syntax) passed, but Layer 2 (cross-file semantics) detected errors.\n` +
                                    `🛡️ **DISK UNTOUCHED: Caught in RAM. File not modified.**${structuredInfo}\n\n` +
                                    `Fix the type errors and retry. If you changed a function signature, ` +
                                    `use \`nreki_code action:"batch_edit"\` to update all callers in one atomic transaction.\n\n` +
                                    `[NREKI: validated in ${kernelResult.latencyMs}ms]`,
                            }],
                            isError: true,
                        };
                    }
                } else {
                    // MATHEMATICALLY SAFE: Kernel commits via two-phase atomic write
                    try { saveBackup(process.cwd(), resolvedPath); } catch {}

                    // L3.3: Backup archivos extra que el Auto-Healer tocó (para nreki_undo)
                    if (kernelResult.healedFiles) {
                        for (const hf of kernelResult.healedFiles) {
                            try { saveBackup(process.cwd(), path.resolve(process.cwd(), hf)); } catch {}
                            // CHRONOS: Rastrear auto-heals
                            if (deps.chronos) deps.chronos.recordHeal(hf);
                        }
                    }

                    await deps.kernel.commitToDisk();

                    // TTRD: Record regressions and check debt payments
                    if (deps.chronos && kernelResult.postContracts) {
                        // Record new regressions
                        if (kernelResult.regressions && kernelResult.regressions.length > 0) {
                            const byFile = new Map<string, TypeRegression[]>();
                            for (const r of kernelResult.regressions) {
                                const arr = byFile.get(r.filePath) || [];
                                arr.push(r);
                                byFile.set(r.filePath, arr);
                            }

                            const penaltyList: string[] = [];
                            for (const [fPath, regs] of byFile.entries()) {
                                deps.chronos.recordRegressions(path.resolve(process.cwd(), fPath), regs);
                                for (const r of regs) {
                                    penaltyList.push(`  - \`${r.symbol}\` in \`${path.basename(fPath)}\`: \`${r.oldType}\` -> \`${r.newType}\``);
                                }
                            }

                            ttrdFeedback += `\n\n**TYPE REGRESSION DETECTED**\n` +
                                `The edit compiled successfully, but weakened the type safety of the project:\n` +
                                `${penaltyList.join("\n")}\n` +
                                `This technical debt has been logged. Restore strict typing instead of using any/unknown.`;
                        }

                        // Check if previous debts were paid
                        const posixResolved = deps.kernel.resolvePosixPath(resolvedPath);
                        const fileContracts = kernelResult.postContracts.get(posixResolved);
                        const paidDebts = deps.chronos.assessDebtPayments(resolvedPath, fileContracts);
                        if (paidDebts.length > 0) {
                            ttrdFeedback += `\n\n**TYPE DEBT PAID**\n` +
                                `Strict typing restored for: ${paidDebts.map(s => `\`${s}\``).join(", ")}.\n` +
                                `Friction score reduced.`;
                        }

                        // Success reward only for files without regressions in this edit
                        const hasRegressionHere = kernelResult.regressions?.some(
                            r => r.filePath === posixResolved
                        );
                        if (!hasRegressionHere) {
                            deps.chronos.recordSuccess(resolvedPath);
                        }

                        deps.chronos.syncTechDebt(
                            deps.kernel.getInitialErrorCount(),
                            deps.kernel.getCurrentErrorCount(),
                        );
                    } else if (deps.chronos) {
                        // Fallback when no postContracts (non-TS files, etc.)
                        deps.chronos.recordSuccess(resolvedPath);
                        deps.chronos.syncTechDebt(
                            deps.kernel.getInitialErrorCount(),
                            deps.kernel.getCurrentErrorCount(),
                        );
                    }
                }

            } catch (kernelError) {
                // Graceful degradation: kernel crashed, fall back to direct write
                console.error(`[NREKI] Kernel error during edit verification: ${kernelError}`);
                try { saveBackup(process.cwd(), resolvedPath); } catch {}
                fs.writeFileSync(resolvedPath, result.newContent!, "utf-8");
                // A-06: Await rollback to prevent stale VFS on next intercept
                try { await deps.kernel.rollbackAll(); } catch (e) {
                    console.error(`[NREKI] Rollback after kernel crash also failed: ${e}`);
                }
            }
        }
        // ─── End NREKI Layer 2 ───────────────────────────────────────

        engine.logUsage(
            "nreki_code:edit",
            Embedder.estimateTokens(new_code),
            Embedder.estimateTokens(new_code),
            result.tokensAvoided,
        );

        // Blast radius detection using oldRawCode from semanticEdit result
        let blastRadiusWarning = "";
        if (result.oldRawCode && mode === "replace") {
            try {
                const sigChanged = detectSignatureChange(result.oldRawCode, new_code);
                if (sigChanged) {
                    const relPath = path.relative(process.cwd(), resolvedPath).replace(/\\/g, "/");
                    const dependents = await engine.findDependents(relPath);
                    if (dependents.length > 0) {
                        const depList = dependents.map(d => `  - ${d}`).join("\n");
                        blastRadiusWarning =
                            `\n\n**[BLAST RADIUS]** Signature of \`${symbol}\` changed.\n` +
                            `This file is imported by:\n${depList}\n\n` +
                            `If you altered parameters or return types, use \`nreki_code action:"batch_edit"\` ` +
                            `to update those files before running tests.`;
                    }
                }
            } catch { /* non-fatal */ }
        }

        return {
            content: [{
                type: "text" as const,
                text:
                    `## Semantic Edit: SUCCESS\n\n` +
                    `**Symbol:** ${symbol}\n` +
                    `**File:** ${file}\n` +
                    `**Lines:** ${result.oldLines} → ${result.newLines}\n` +
                    `**Syntax:** validated ✓\n\n` +
                    `[NREKI saved ~${result.tokensAvoided.toLocaleString()} tokens vs native read+edit]` +
                    (kernelResult?.errorText ? `\n\n${kernelResult.errorText}` : "") +
                    ttrdFeedback +
                    blastRadiusWarning,
            }],
        };
    } finally {
        releaseFileLock(resolvedPath);
    }
}

async function handleBatchEdit(
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine, sandbox } = deps;
    await engine.initialize();

    const edits = params.edits;
    if (!edits || edits.length === 0) {
        return {
            content: [{
                type: "text" as const,
                text: `Error: "edits" array is required for batch_edit.\n\n[NREKI saved ~0 tokens]`,
            }],
            isError: true,
        };
    }

    // Validate all edits have required fields
    for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        if (!e.path || !e.symbol || !e.new_code) {
            return {
                content: [{
                    type: "text" as const,
                    text: `Error: edit[${i}] missing required fields (path, symbol, new_code).\n\n[NREKI saved ~0 tokens]`,
                }],
                isError: true,
            };
        }
    }

    // Two-Phase Locking: acquire all file locks or abort
    const uniquePaths: string[] = [];
    for (const e of edits) {
        try {
            const resolved = safePath(process.cwd(), e.path);
            if (!uniquePaths.includes(resolved)) uniquePaths.push(resolved);
        } catch (err) {
            return {
                content: [{ type: "text" as const, text: `Security error in edit path "${e.path}": ${(err as Error).message}` }],
                isError: true,
            };
        }
    }

    // BUG C: Sort lock paths to prevent deadlocks
    uniquePaths.sort();
    const acquiredLocks: string[] = [];
    for (const p of uniquePaths) {
        const lock = acquireFileLock(p, "nreki_code:batch_edit");
        if (!lock.acquired) {
            // Rollback: release all locks acquired so far
            for (const rp of acquiredLocks) releaseFileLock(rp);
            return {
                content: [{ type: "text" as const, text:
                    `## Batch Edit: BLOCKED\n\n` +
                    `File \`${path.relative(process.cwd(), p)}\` is locked by another edit (${lock.heldBy}, ${lock.heldForMs}ms).\n` +
                    `Wait for it to finish, then resend the full batch.\n\n[NREKI saved ~0 tokens]`
                }],
                isError: true,
            };
        }
        acquiredLocks.push(p);
    }

    // CHRONOS HARD BLOCK: Check all files in batch
    if (deps.chronos) {
        for (const p of uniquePaths) {
            if (deps.chronos.isHighFriction(p) && !deps.chronos.hasReadUncompressed(p)) {
                for (const rp of acquiredLocks) releaseFileLock(rp);
                return {
                    content: [{
                        type: "text" as const,
                        text:
                            `## Edit Blocked - High Friction File\n\n` +
                            `File \`${path.relative(process.cwd(), p)}\` has high historical error rate.\n` +
                            `You MUST read it uncompressed before including it in a batch edit.\n\n` +
                            `**ACTION REQUIRED**: Run \`nreki_code action:"read" compress:false path:"${path.relative(process.cwd(), p)}"\` first.\n\n` +
                            `[NREKI: Chronos edit gating active]`,
                    }],
                    isError: true,
                };
            }
        }
    }

    try {
        const parser = engine.getParser();
        const batchOps: BatchEditOp[] = edits.map(e => ({
            path: e.path,
            symbol: e.symbol,
            new_code: e.new_code,
            mode: (e.mode && ["replace", "insert_before", "insert_after"].includes(e.mode))
                ? e.mode as EditMode
                : "replace",
        }));

        // Deferred boot: kernel boots on first edit, not at startup
        let useKernel = false;
        if (deps.kernel && deps.nrekiMode !== "syntax") {
            if (!deps.kernel.isBooted()) {
                console.error(
                    `[NREKI] Booting kernel (${deps.nrekiMode} mode). First edit will be slower.`
                );
                try {
                    await ensureHologramReady(deps.kernel, deps.nrekiMode ?? "");
                    deps.kernel.boot(
                        process.cwd(),
                        deps.nrekiMode as "file" | "project" | "hologram",
                    );
                } catch (err) {
                    console.error(
                        `[NREKI] Kernel boot failed: ${(err as Error).message}. Falling back to Layer 1.`
                    );
                }
            }
            useKernel = deps.kernel.isBooted();
        }

        const result = await batchSemanticEdit(batchOps, parser, sandbox, process.cwd(), useKernel);

        if (!result.success || (useKernel && !result.vfs)) {
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## Batch Edit: TRANSACTION ABORTED\n\n` +
                        `**Edits requested:** ${result.editCount}\n` +
                        `**Files involved:** ${result.fileCount}\n\n` +
                        `${result.error}\n\n` +
                        `No files were modified.\n\n` +
                        `[NREKI saved ~0 tokens]`,
                }],
                isError: true,
            };
        }

        // ─── NREKI Layer 2: Cross-file semantic verification ─────────
        let batchTtrdFeedback = "";
        if (useKernel && deps.kernel) {
            try {
                // Inject VFS virtual state into kernel
                const kernelEdits: Array<{ targetFile: string; proposedContent: string | null }> = [];
                for (const [filePath, content] of result.vfs!.entries()) {
                    kernelEdits.push({ targetFile: filePath, proposedContent: content });
                }

                // TOPOLOGICAL: compute dependents for hologram batch
                let batchDependents: string[] = [];
                if (deps.nrekiMode === "hologram" && result.oldRawCodes) {
                    try {
                        const changedFiles = new Set<string>();
                        for (const edit of batchOps) {
                            if (edit.mode && edit.mode !== "replace") continue;
                            const key = `${edit.path}::${edit.symbol}`;
                            const oldRaw = result.oldRawCodes.get(key);
                            if (oldRaw && detectSignatureChange(oldRaw, edit.new_code)) {
                                changedFiles.add(
                                    path.relative(process.cwd(), safePath(process.cwd(), edit.path)).replace(/\\/g, "/")
                                );
                            }
                        }
                        if (changedFiles.size > 0) {
                            const allDepSet = new Set<string>();
                            for (const fp of changedFiles) {
                                const fileDeps2 = await engine.findDependents(fp);
                                for (const d of fileDeps2) allDepSet.add(d);
                            }
                            // Remove files already in the batch
                            for (const fp of result.files) {
                                allDepSet.delete(fp);
                            }
                            if (allDepSet.size <= 50) {
                                batchDependents = [...allDepSet];
                            }
                            // >50 dependents: skip injection (too risky for batch)
                        }
                    } catch { /* non-fatal */ }
                }

                if (kernelEdits.length > 0) {
                    const kernelResult = await deps.kernel.interceptAtomicBatch(kernelEdits, batchDependents);

                    if (!kernelResult.safe) {
                        // FP-2 + A5: Filter node_modules errors with path segment regex
                        const agentErrors = kernelResult.structured?.filter(e =>
                            !e.file.match(/[/\\]node_modules[/\\]/)
                        ) || [];

                        if (agentErrors.length === 0) {
                            console.error(
                                `[NREKI] Warning: ${kernelResult.structured?.length} error(s) in node_modules ignored.`
                            );
                            for (const filePath of result.vfs!.keys()) {
                                try { saveBackup(process.cwd(), filePath); } catch {}
                            }
                            await deps.kernel.commitToDisk();
                        } else {
                            // CHRONOS: Castigar los archivos donde ESTALLAN los errores (las víctimas)
                            if (deps.chronos) {
                                const errorByFile = new Map<string, string>();
                                for (const e of agentErrors) {
                                    if (!errorByFile.has(e.file)) errorByFile.set(e.file, e.message);
                                }
                                for (const [fragileFile, firstMsg] of errorByFile.entries()) {
                                    deps.chronos.recordSemanticError(fragileFile, firstMsg);
                                }
                            }

                            // ATOMIC CIRCUIT BREAK: NO FILES WERE WRITTEN.
                            await deps.kernel.rollbackAll();

                            const structuredInfo = "\n\nSemantic errors:\n" +
                                agentErrors.map(e =>
                                    `  → ${path.relative(process.cwd(), e.file)} (${e.line},${e.column}): ${e.code} - ${e.message}`
                                ).join("\n");

                            return {
                                content: [{
                                    type: "text" as const,
                                    text:
                                        `## Batch Edit: BLOCKED BY NREKI (Layer 2)\n\n` +
                                        `**Edits attempted:** ${result.editCount}\n` +
                                        `**Files involved:** ${result.fileCount}\n\n` +
                                        `Layer 1 (syntax) passed for all files, but Layer 2 (cross-file semantics) detected errors.\n` +
                                        `🛡️ **DISK UNTOUCHED: Transaction aborted in RAM. No files were modified.**${structuredInfo}\n\n` +
                                        `If you changed a function signature, include ALL callers in the same batch.\n\n` +
                                        `[NREKI: RAM validated in ${kernelResult.latencyMs}ms]`,
                                }],
                                isError: true,
                            };
                        }
                    } else {
                        // SAFE: COMMIT TO DISK via two-phase atomic write
                        for (const filePath of result.vfs!.keys()) {
                            try { saveBackup(process.cwd(), filePath); } catch {}
                        }

                        // L3.3: Backup archivos extra que el Auto-Healer tocó
                        if (kernelResult.healedFiles) {
                            for (const hf of kernelResult.healedFiles) {
                                try { saveBackup(process.cwd(), path.resolve(process.cwd(), hf)); } catch {}
                                // CHRONOS: Rastrear auto-heals
                                if (deps.chronos) deps.chronos.recordHeal(hf);
                            }
                        }

                        await deps.kernel.commitToDisk();

                        // TTRD: Record regressions and check debt payments
                        if (deps.chronos && kernelResult.postContracts) {
                            // Record regressions grouped by file
                            if (kernelResult.regressions && kernelResult.regressions.length > 0) {
                                const byFile = new Map<string, TypeRegression[]>();
                                for (const r of kernelResult.regressions) {
                                    const arr = byFile.get(r.filePath) || [];
                                    arr.push(r);
                                    byFile.set(r.filePath, arr);
                                }

                                const penaltyList: string[] = [];
                                for (const [fPath, regs] of byFile.entries()) {
                                    deps.chronos.recordRegressions(path.resolve(process.cwd(), fPath), regs);
                                    for (const r of regs) {
                                        penaltyList.push(`  - \`${r.symbol}\` in \`${path.basename(fPath)}\`: \`${r.oldType}\` -> \`${r.newType}\``);
                                    }
                                }

                                batchTtrdFeedback += `\n\n**TYPE REGRESSION DETECTED**\n` +
                                    `The batch compiled successfully, but weakened type safety:\n` +
                                    `${penaltyList.join("\n")}\n` +
                                    `This technical debt has been logged. Restore strict typing.`;
                            }

                            // Check debt payments for all files in the batch
                            const allPaid: string[] = [];
                            for (const filePath of result.vfs!.keys()) {
                                const posixPath = deps.kernel.resolvePosixPath(filePath);
                                const fileContracts = kernelResult.postContracts.get(posixPath);
                                const paid = deps.chronos.assessDebtPayments(filePath, fileContracts);
                                if (paid.length > 0) {
                                    allPaid.push(`\`${path.basename(filePath)}\`: ${paid.join(", ")}`);
                                }

                                // Success reward only for files without regressions
                                const hasRegressionHere = kernelResult.regressions?.some(
                                    r => r.filePath === posixPath
                                );
                                if (!hasRegressionHere) {
                                    deps.chronos.recordSuccess(filePath);
                                }
                            }

                            if (allPaid.length > 0) {
                                batchTtrdFeedback += `\n\n**TYPE DEBT PAID**\n` +
                                    `Strict typing restored:\n` +
                                    `${allPaid.join("\n")}\n` +
                                    `Friction score reduced.`;
                            }

                            deps.chronos.syncTechDebt(
                                deps.kernel.getInitialErrorCount(),
                                deps.kernel.getCurrentErrorCount(),
                            );
                        } else if (deps.chronos) {
                            for (const filePath of result.vfs!.keys()) {
                                deps.chronos.recordSuccess(filePath);
                            }
                            deps.chronos.syncTechDebt(
                                deps.kernel.getInitialErrorCount(),
                                deps.kernel.getCurrentErrorCount(),
                            );
                        }
                    }
                }
            } catch (kernelError) {
                // Graceful degradation: kernel crashed, fall back to direct write
                console.error(`[NREKI] Kernel error during batch verification: ${kernelError}`);
                for (const [filePath, content] of result.vfs!.entries()) {
                    try { saveBackup(process.cwd(), filePath); } catch {}
                    fs.writeFileSync(filePath, content, "utf-8");
                }
                // A-06: Await rollback to prevent stale VFS on next intercept
                try { await deps.kernel.rollbackAll(); } catch (e) {
                    console.error(`[NREKI] Rollback after kernel crash also failed: ${e}`);
                }
            }
        }
        // ─── End NREKI Layer 2 ───────────────────────────────────────

        const fileList = result.files.map(f => `  - ${f}`).join("\n");

        // Blast radius detection for batch edits
        let blastRadiusWarning = "";
        if (result.oldRawCodes) {
            try {
                const changedSymbols: string[] = [];
                for (const edit of batchOps) {
                    if (edit.mode && edit.mode !== "replace") continue;
                    const key = `${edit.path}::${edit.symbol}`;
                    const oldRaw = result.oldRawCodes.get(key);
                    if (oldRaw && detectSignatureChange(oldRaw, edit.new_code)) {
                        changedSymbols.push(edit.symbol);
                    }
                }
                if (changedSymbols.length > 0) {
                    // Collect dependents for all edited files
                    const allDependents = new Set<string>();
                    for (const filePath of result.files) {
                        try {
                            const fileDeps = await engine.findDependents(filePath);
                            for (const d of fileDeps) allDependents.add(d);
                        } catch { /* non-fatal */ }
                    }
                    // Remove files that were already part of this batch edit
                    for (const f of result.files) allDependents.delete(f);

                    const depList = allDependents.size > 0
                        ? `\nFiles that import these modules:\n${[...allDependents].map(d => `  - ${d}`).join("\n")}\n`
                        : "";

                    blastRadiusWarning =
                        `\n\n**[BLAST RADIUS]** Signature changed for: ${changedSymbols.map(s => `\`${s}\``).join(", ")}.` +
                        depList +
                        `\nIf you altered parameters or return types, use \`nreki_code action:"batch_edit"\` to update those files before running tests.`;
                }
            } catch { /* non-fatal */ }
        }

        return {
            content: [{
                type: "text" as const,
                text:
                    `## Batch Edit: SUCCESS\n\n` +
                    `**Edits applied:** ${result.editCount}\n` +
                    `**Files modified:** ${result.fileCount}\n` +
                    `${fileList}\n\n` +
                    `All files passed syntax validation.\n` +
                    `Run \`npm run typecheck\` or your tests to verify types.\n\n` +
                    `[NREKI batch edit complete]` +
                    batchTtrdFeedback +
                    blastRadiusWarning,
            }],
        };
    } finally {
        for (const p of acquiredLocks) releaseFileLock(p);
    }
}

async function handleUndo(
    params: CodeParams,
    _deps: RouterDependencies,
): Promise<McpToolResponse> {
    const file = params.path ?? "";
    let resolvedPath: string;
    try {
        resolvedPath = safePath(process.cwd(), file);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}\n\n[NREKI saved ~0 tokens]`,
            }],
        };
    }

    try {
        const message = restoreBackup(process.cwd(), resolvedPath);
        return {
            content: [{
                type: "text" as const,
                text: `## nreki_undo: SUCCESS\n\n${message}\n\n[NREKI: file restored]`,
            }],
        };
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `## nreki_undo: FAILED\n\n${(err as Error).message}\n\n[NREKI saved ~0 tokens]`,
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
                text: `Error: "output" is required for the filter_output action.\n\n[NREKI saved ~0 tokens]`,
            }],
        };
    }

    const result = filterTerminalOutput(output, max_lines);

    engine.logUsage(
        "nreki_filter_output",
        result.filtered_tokens,
        result.filtered_tokens,
        Math.max(0, result.original_tokens - result.filtered_tokens),
    );

    // Feed errors to circuit breaker for loop detection
    let circuitWarning = "";
    if (result.error_summary.errorCount > 0) {
        const loopCheck = circuitBreaker.recordToolCall(
            "nreki_filter_output",
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
    summaryLines.push(`[NREKI saved ~${saved.toLocaleString()} tokens on this filter]`);

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
    _deps: RouterDependencies,
): Promise<McpToolResponse> {
    const projectRoot = process.cwd();
    const text = typeof params.text === "string" ? params.text : "";

    if (!text) {
        return {
            content: [{
                type: "text" as const,
                text: "Error: `text` is required for the pin action.\n\n[NREKI saved ~0 tokens]",
            }],
        };
    }

    const result = addPin(projectRoot, text, "claude");
    if (!result.success) {
        return {
            content: [{
                type: "text" as const,
                text: `## Pin: FAILED\n\n${result.error}\n\n[NREKI saved ~0 tokens]`,
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
                `This rule will appear in every nreki_navigate action:"map" response.\n\n` +
                `[NREKI saved ~0 tokens]`,
        }],
    };
}

async function handleUnpin(
    params: GuardParams,
    _deps: RouterDependencies,
): Promise<McpToolResponse> {
    const projectRoot = process.cwd();
    const index = typeof params.index === "number" ? params.index : undefined;
    const id = typeof params.id === "string" ? params.id : undefined;

    // A-14: When index is provided, resolve to the pin at that display position
    // (1-based, sorted by id via stableCompare - same order as getPinnedText).
    let pinId = id;
    if (!pinId && typeof index === "number") {
        const allPins = listPins(projectRoot);
        const sorted = [...allPins].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        const target = sorted[index - 1];
        pinId = target?.id;
    }

    if (!pinId) {
        return {
            content: [{
                type: "text" as const,
                text: "Error: `index` or `id` is required for the unpin action.\n\n[NREKI saved ~0 tokens]",
            }],
        };
    }

    const removed = removePin(projectRoot, pinId);
    if (!removed) {
        return {
            content: [{
                type: "text" as const,
                text: `## Pin: NOT FOUND\n\nNo pin with id "${pinId}" exists.\n\n[NREKI saved ~0 tokens]`,
            }],
        };
    }

    return {
        content: [{
            type: "text" as const,
            text: `## Pin: REMOVED\n\n**ID:** ${pinId}\n\nThis rule will no longer appear in nreki_navigate action:"map" responses.\n\n[NREKI saved ~0 tokens]`,
        }],
    };
}

async function handleStatus(
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine, monitor } = deps;
    await engine.initialize();

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
            "  Do NOT read these raw. Use nreki_code action:\"compress\".",
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
            "  2. Use nreki_navigate action:\"search\" instead of reading files directly\n" +
            "  3. Minimize output length - emit only patches\n" +
            "  4. Consider starting a new session soon";
    } else if (prediction.alertLevel === "warning") {
        recommendations =
            "\n\n💡 RECOMMENDATIONS:\n" +
            "  1. Use nreki_code action:\"compress\" for files > 100 lines\n" +
            "  2. Prefer nreki_navigate action:\"search\" over grep/glob\n" +
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
                `\n\n[NREKI saved ~${saved.toLocaleString()} tokens on this query]`,
        }],
    };
}

async function handleReport(
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine, monitor, circuitBreaker } = deps;
    await engine.initialize();

    const sessionReport = engine.getSessionReport();
    const burnRate = monitor.computeBurnRate();
    const prediction = monitor.predictExhaustion();
    const usageStats = engine.getUsageStats();
    const cbStats = circuitBreaker.getStats();
    const pins = listPins(process.cwd());

    const fileTypeRows = sessionReport.byFileType.length > 0
        ? sessionReport.byFileType.map(ft =>
            `  ${ft.ext.padEnd(6)} - ${ft.count} files, ` +
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
            modelRec = `Current usage is efficient. NREKI has saved $${sonnetSavings.toFixed(3)} (Sonnet) / $${opusSavings.toFixed(3)} (Opus).`;
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
        "|          NREKI SESSION RECEIPT                    |",
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
        "💡 Did NREKI save your session?",
        "   Share this receipt → https://github.com/Ruso-0/nreki/discussions",
    ].join("\n");

    let healthScoreStr = "";
    if (deps.kernel && deps.kernel.isBooted() && deps.chronos) {
        healthScoreStr = deps.chronos.getHealthReport(
            deps.kernel.getInitialErrorCount(),
            deps.kernel.getCurrentErrorCount(),
        ) + "\n\n";
    }

    const report = [
        "===================================================",
        "  NREKI - Session Report",
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
            text: healthScoreStr + report + receipt,
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
                    `NREKI injects this every ~15 tool calls. A plan this large will burn ` +
                    `context rapidly and accelerate compaction instead of preventing it.\n\n` +
                    `**Action:** Summarize your \`${path.basename(resolvedPath)}\` into strict ` +
                    `bullet points (aim for < 1,500 tokens), then try again.`,
            }],
            isError: true,
        };
    }

    deps.engine.setMetadata("nreki_master_plan", resolvedPath);
    deps.engine.setMetadata(
        "nreki_plan_last_inject",
        String(deps.circuitBreaker.getStats().totalToolCalls),
    );

    return {
        content: [{
            type: "text" as const,
            text:
                `## Master Plan Anchored\n\n` +
                `**Path:** ${resolvedPath}\n` +
                `**Cost:** ~${planTokens.toLocaleString()} tokens per heartbeat\n\n` +
                `NREKI's Context Heartbeat is now ACTIVE. It will silently re-inject ` +
                `these constraints every ~15 tool calls during context-gathering operations.\n\n` +
                `*Tip: Use \`nreki_guard action:"memorize"\` as you progress to leave notes for your future self.*`,
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

    deps.engine.setMetadata("nreki_scratchpad", params.text);

    return {
        content: [{
            type: "text" as const,
            text:
                `## Memory Saved\n\n` +
                `NREKI has written your thoughts to the Active Scratchpad. ` +
                `If context compaction occurs, these notes will be automatically ` +
                `re-injected so you don't lose your train of thought.`,
        }],
    };
}
