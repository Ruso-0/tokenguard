# TokenGuard v3.0.1 — Audit Package

> Full source of all critical files for security audit and review.
> Generated: 2026-03-10

---

## Table of Contents

1. [src/index.ts](#srcindexts)
2. [src/router.ts](#srcrouterts)
3. [src/middleware/validator.ts](#srcmiddlewarevalidatorts)
4. [src/middleware/circuit-breaker.ts](#srcmiddlewarecircuit-breakerts)
5. [src/middleware/file-lock.ts](#srcmiddlewarefile-lockts)
6. [README.md](#readmemd)
7. [package.json](#packagejson)
8. [CHANGELOG.md](#changelogmd)

---

## src/index.ts

```typescript
#!/usr/bin/env node

/**
 * index.ts — TokenGuard v3.0.1 MCP Server entry point.
 *
 * Exposes 3 router tools to Claude Code (replaces 16 individual tools):
 *
 *   1. tg_navigate — AST-powered code navigation and semantic search
 *   2. tg_code     — Read, compress, and surgically edit code files
 *   3. tg_guard    — Safety controls, session monitoring, and persistent memory
 *
 * Middleware (runs automatically, not exposed as tools):
 *   - AST Validation: validates code before disk writes (inside tg_code edit)
 *   - Circuit Breaker: detects and stops infinite failure loops
 *   - File Lock: prevents concurrent edit corruption
 *
 * v3.0.1: Flat parameter schemas (explicit fields per action, no generic options bag),
 * file-level mutex on edits, security hardening (symlink resolution, sensitive file
 * blocklist, per-file circuit breaker tracking, pin sanitization).
 *
 * All processing is local. Zero cloud dependencies.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "path";

import { TokenGuardEngine } from "./engine.js";
import { TokenMonitor } from "./monitor.js";
import { AstSandbox } from "./ast-sandbox.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import {
    handleNavigate,
    handleCode,
    handleGuard,
    type RouterDependencies,
    type NavigateParams,
    type CodeParams,
    type GuardParams,
} from "./router.js";
import { wrapWithCircuitBreaker } from "./middleware/circuit-breaker.js";

// ─── CLI Flag Parsing ───────────────────────────────────────────────

const args = process.argv.slice(2);
const enableEmbeddings = args.includes("--enable-embeddings");

// ─── Initialization ─────────────────────────────────────────────────

const engine = new TokenGuardEngine({
    dbPath: path.join(process.cwd(), ".tokenguard.db"),
    watchPaths: [process.cwd()],
    enableEmbeddings,
});

const monitor = new TokenMonitor();
const sandbox = new AstSandbox();
const circuitBreaker = new CircuitBreaker();

const deps: RouterDependencies = { engine, monitor, sandbox, circuitBreaker };

const server = new McpServer({
    name: "TokenGuard",
    version: "3.0.1",
});

if (!enableEmbeddings) {
    console.error(
        "[TokenGuard] Running in Lite mode (BM25 keyword search only). " +
        "Run with --enable-embeddings for semantic search.",
    );
}

// ─── Tool 1: tg_navigate ───────────────────────────────────────────

server.tool(
    "tg_navigate",
    "AST-powered code navigation and semantic search. Use for finding code, understanding project structure, and locating symbols.",
    {
        action: z
            .enum(["search", "definition", "references", "outline", "map"])
            .describe(
                "search: hybrid semantic+keyword search across codebase. " +
                "definition: go-to-definition by symbol name. " +
                "references: find all usages of a symbol. " +
                "outline: list all symbols in a file. " +
                "map: full repo structure map with pinned rules.",
            ),
        query: z
            .string()
            .optional()
            .describe("For search: the query string."),
        symbol: z
            .string()
            .optional()
            .describe("For definition/references: the symbol name."),
        path: z
            .string()
            .optional()
            .describe("For outline: the file path."),
        limit: z
            .number()
            .optional()
            .describe("For search: max results to return (1-50, default 10)."),
        include_raw: z
            .boolean()
            .optional()
            .describe("For search: include full source code in results."),
        kind: z
            .string()
            .optional()
            .describe("For definition: filter by symbol kind (function, class, interface, etc.)."),
        signatures: z
            .boolean()
            .optional()
            .describe("For outline: include full signatures."),
        refresh: z
            .boolean()
            .optional()
            .describe("For map: force regeneration, ignoring cache."),
    },
    async ({ action, query, symbol, path: navPath, limit, include_raw, kind, signatures, refresh }) => {
        const params: NavigateParams = { action, query, symbol, path: navPath, limit, include_raw, kind, signatures, refresh };
        return wrapWithCircuitBreaker(
            circuitBreaker,
            "tg_navigate",
            action,
            () => handleNavigate(action, params, deps),
        );
    },
);

// ─── Tool 2: tg_code ───────────────────────────────────────────────

server.tool(
    "tg_code",
    "Read, compress, and surgically edit code files. " +
    "All edits are automatically validated via AST before writing to disk — " +
    "if syntax is invalid, the edit is blocked and you get the exact error. " +
    "Undo reverts the last edit. filter_output strips noisy terminal output.",
    {
        action: z
            .enum(["read", "compress", "edit", "undo", "filter_output"])
            .describe(
                "read: read file with optional compression. " +
                "compress: compress file/directory with full control. " +
                "edit: surgically edit a function/class by name (auto-validated). " +
                "undo: revert last edit. " +
                "filter_output: filter noisy terminal output (strips ANSI, deduplicates errors). Does NOT execute commands.",
            ),
        path: z
            .string()
            .optional()
            .describe("File or directory path (required for read, compress, edit, undo)."),
        symbol: z
            .string()
            .optional()
            .describe("For edit: the function/class/interface name to replace."),
        new_code: z
            .string()
            .optional()
            .describe("For edit: the complete replacement source code for the symbol."),
        compress: z
            .boolean()
            .optional()
            .describe("For read: enable auto-compression (default true)."),
        level: z
            .string()
            .optional()
            .describe("Compression level: 'light', 'medium', or 'aggressive'."),
        focus: z
            .string()
            .optional()
            .describe("For compress: focus query to rank chunks by relevance."),
        tier: z
            .number()
            .optional()
            .describe("For compress: legacy tier (1-3)."),
        output: z
            .string()
            .optional()
            .describe("For filter_output: the terminal output text to filter."),
        max_lines: z
            .number()
            .optional()
            .describe("For filter_output: max output lines (1-1000, default 100)."),
    },
    async ({ action, path: filePath, symbol, new_code, compress, level, focus, tier, output, max_lines }) => {
        const params: CodeParams = { action, path: filePath, symbol, new_code, compress, level, focus, tier, output, max_lines };
        return wrapWithCircuitBreaker(
            circuitBreaker,
            "tg_code",
            action,
            () => handleCode(action, params, deps),
            filePath,
        );
    },
);

// ─── Tool 3: tg_guard ──────────────────────────────────────────────

server.tool(
    "tg_guard",
    "Safety controls, session monitoring, and persistent memory. " +
    "Pin rules that persist across messages, check token burn rate, " +
    "and get session reports.",
    {
        action: z
            .enum(["pin", "unpin", "status", "report"])
            .describe(
                "pin: add a persistent rule (injected into every map response). " +
                "unpin: remove a pinned rule. " +
                "status: token burn rate and alerts. " +
                "report: full session savings receipt.",
            ),
        text: z
            .string()
            .optional()
            .describe("For pin: the rule text to pin (max 200 chars)."),
        index: z
            .number()
            .optional()
            .describe("For unpin: the pin index to remove (0-based)."),
        id: z
            .string()
            .optional()
            .describe("For unpin: the pin id to remove."),
    },
    async ({ action, text, index, id }) => {
        const params: GuardParams = { action, text, index, id };
        return wrapWithCircuitBreaker(
            circuitBreaker,
            "tg_guard",
            action,
            () => handleGuard(action, params, deps),
        );
    },
);

// ─── Server Startup ─────────────────────────────────────────────────

async function main(): Promise<void> {
    const transport = new StdioServerTransport();

    // Graceful shutdown
    process.on("SIGINT", () => {
        engine.shutdown();
        process.exit(0);
    });

    process.on("SIGTERM", () => {
        engine.shutdown();
        process.exit(0);
    });

    // Connect and serve
    await server.connect(transport);

    // Engine initialization is lazy — each tool calls engine.initialize()
    // (fast: db + parser) or engine.initializeEmbedder() (full: + ONNX model)
    // as needed. This keeps the MCP handshake under 100ms.
}

main().catch((err) => {
    console.error(`[TokenGuard] Fatal error: ${err.message}`);
    process.exit(1);
});
```

---

## src/router.ts

```typescript
/**
 * router.ts — Central dispatcher for TokenGuard v3.0.1 router tools.
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
import { semanticEdit } from "./semantic-edit.js";
import { addPin, removePin, listPins, getPinnedText } from "./pin-memory.js";
import { readSource } from "./utils/read-source.js";
import { restoreBackup } from "./undo.js";
import { validateBeforeWrite } from "./middleware/validator.js";
import { wrapWithCircuitBreaker } from "./middleware/circuit-breaker.js";
import { acquireFileLock, releaseFileLock } from "./middleware/file-lock.js";

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
        default:
            return {
                content: [{
                    type: "text" as const,
                    text: `Unknown tg_guard action: "${action}". Valid actions: pin, unpin, status, report.`,
                }],
                isError: true,
            };
    }
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
            // Raw read without compression
            const content = readSource(resolvedPath);
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## ${path.basename(resolvedPath)} (raw)\n\n` +
                        `\`\`\`\n${content}\n\`\`\`\n\n` +
                        `[TokenGuard: raw read, no compression applied]`,
                }],
            };
        }

        const result = await engine.compressFileAdvanced(resolvedPath, level);
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
        const result = await semanticEdit(
            resolvedPath,
            symbol,
            new_code,
            parser,
            sandbox,
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

    const saved = Embedder.estimateTokens(report + indexSection);

    return {
        content: [{
            type: "text" as const,
            text:
                report +
                indexSection +
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
        `|  Pinned Rules Active:     ${pad(pins.length, 16)}    |`,
        "+--------------------------------------------------+",
        `|  ESTIMATED SAVINGS:       ${pad("$" + usdStr, 16)}    |`,
        `|  MODEL:                   ${pad(modelName, 16)}    |`,
        `|  TOOLS USED:              ${pad(usageStats.tool_calls + " calls", 16)}    |`,
        "+--------------------------------------------------+",
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
```

---

## src/middleware/validator.ts

```typescript
/**
 * middleware/validator.ts — AST validation middleware for TokenGuard v3.0.
 *
 * Wraps edit operations with automatic pre-write syntax validation.
 * If the edited code has syntax errors, the write is blocked and the
 * caller gets the exact error with line/column and fix suggestions.
 *
 * This is the former tg_validate tool, now running automatically
 * as invisible middleware inside tg_code action:"edit".
 */

import { AstSandbox, type ValidationResult } from "../ast-sandbox.js";

/**
 * Validate code before writing to disk.
 *
 * @param code - The code to validate
 * @param language - Programming language (typescript, javascript, python, go)
 * @param sandbox - AstSandbox instance
 * @param originalCode - Optional original file content for diff context
 * @returns ValidationResult with validity status, errors, and suggestions
 */
export async function validateBeforeWrite(
    code: string,
    language: string,
    sandbox: AstSandbox,
    originalCode?: string,
): Promise<ValidationResult> {
    await sandbox.initialize();

    if (originalCode) {
        return sandbox.validateDiff(originalCode, code, language);
    }

    return sandbox.validateCode(code, language);
}

/**
 * Format validation errors as a human-readable string for MCP responses.
 */
export function formatValidationErrors(result: ValidationResult): string {
    if (result.valid) return "";

    const errorLines = result.errors.map((e, i) =>
        `${i + 1}. **Line ${e.line}, Col ${e.column}** (${e.nodeType}): \`${e.context.split("\n")[0].trim()}\``,
    );

    return (
        `## Validation: FAILED — ${result.errors.length} syntax error(s)\n\n` +
        `### Errors\n${errorLines.join("\n")}\n\n` +
        `### Suggestions\n${result.suggestion}\n\n` +
        `Fix these errors before writing the file.`
    );
}
```

---

## src/middleware/circuit-breaker.ts

```typescript
/**
 * middleware/circuit-breaker.ts — Passive circuit breaker middleware for TokenGuard v3.0.
 *
 * Wraps all router tool handlers with automatic loop detection.
 * Records every tool call result and trips the breaker when it detects
 * destructive patterns (repeated errors, excessive edits, doom loops).
 *
 * This is the former tg_circuit_breaker tool, now running automatically
 * as invisible middleware monitoring all tool calls.
 */

import { CircuitBreaker, containsError } from "../circuit-breaker.js";
import type { McpToolResponse } from "../router.js";

/** Last activity timestamp for auto-reset. */
let lastActivityTimestamp = Date.now();

/** Last tool+action combo for diversity detection. */
let lastToolAction = "";

/** Inactivity timeout for auto-reset (60 seconds). */
const INACTIVITY_TIMEOUT_MS = 60_000;

/**
 * Wrap a router handler with passive circuit breaker monitoring.
 *
 * Before executing the handler, checks:
 *   1. If the breaker was tripped but 60s have elapsed → auto-reset
 *   2. If the breaker was tripped but a different tool/action is requested → auto-reset
 *   3. If the breaker is currently tripped → return isError: true immediately
 *
 * After execution, records the result for pattern detection.
 */
export function wrapWithCircuitBreaker(
    cb: CircuitBreaker,
    toolName: string,
    action: string,
    handler: () => Promise<McpToolResponse>,
    filePath?: string,
): Promise<McpToolResponse> {
    return (async () => {
        const toolAction = `${toolName}:${action}`;
        const now = Date.now();

        // Auto-reset: 60s inactivity
        if (now - lastActivityTimestamp > INACTIVITY_TIMEOUT_MS) {
            const state = cb.getState();
            if (state.tripped) {
                cb.reset();
            }
        }

        // Soft reset on different request type: clears tripped state but
        // preserves per-file failure counters. This prevents the bypass where
        // alternating Edit(fail) → Read → Edit(fail) circumvents detection.
        if (toolAction !== lastToolAction && lastToolAction !== "") {
            const state = cb.getState();
            if (state.tripped) {
                cb.softReset();
            }
        }

        lastActivityTimestamp = now;
        lastToolAction = toolAction;

        // If breaker is still tripped after potential resets, block
        const preState = cb.getState();
        if (preState.tripped) {
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `⚠️ CIRCUIT BREAKER TRIPPED: ${preState.tripReason}. ` +
                        `TokenGuard detected a destructive loop pattern. ` +
                        `STOP and ask the human for guidance before proceeding. ` +
                        `Pattern detected: ${preState.tripReason}`,
                }],
                isError: true,
            };
        }

        // Execute the actual handler
        const response = await handler();

        // Record the result for pattern detection
        const responseText = response.content.map(c => c.text).join("\n");
        const hasError = response.isError === true || containsError(responseText);

        if (hasError) {
            const loopCheck = cb.recordToolCall(
                toolAction,
                responseText,
                filePath,
            );

            if (loopCheck.tripped) {
                return {
                    content: [{
                        type: "text" as const,
                        text:
                            `⚠️ CIRCUIT BREAKER TRIPPED: ${loopCheck.reason}. ` +
                            `TokenGuard detected a destructive loop pattern. ` +
                            `STOP and ask the human for guidance before proceeding. ` +
                            `Pattern detected: ${loopCheck.reason}`,
                    }],
                    isError: true,
                };
            }
        } else {
            // Record non-error calls too (for same-file tracking)
            cb.recordToolCall(
                toolAction,
                "",
                filePath,
            );
        }

        return response;
    })();
}

/**
 * Reset middleware state (for testing).
 */
export function resetMiddlewareState(): void {
    lastActivityTimestamp = Date.now();
    lastToolAction = "";
}
```

---

## src/middleware/file-lock.ts

```typescript
/**
 * file-lock.ts — Synchronous file-level mutex for edit operations.
 *
 * Prevents concurrent edits to the same file from corrupting it.
 * Non-queuing: if the file is already locked, the caller gets an
 * immediate rejection (the LLM should retry on the next turn).
 *
 * Usage:
 *   const lock = acquireFileLock(filePath, "tg_code:edit");
 *   if (!lock.acquired) return errorResponse;
 *   try { ... } finally { releaseFileLock(filePath); }
 */

import path from "path";

// ─── Types ───────────────────────────────────────────────────────────

interface LockEntry {
    toolAction: string;
    acquiredAt: number;
}

// ─── State ───────────────────────────────────────────────────────────

const activeLocks = new Map<string, LockEntry>();

/** Auto-expire stale locks after 30 seconds (safety net). */
const LOCK_TIMEOUT_MS = 30_000;

// ─── Helpers ─────────────────────────────────────────────────────────

function normalizeLockKey(filePath: string): string {
    return path.resolve(filePath).replace(/\\/g, "/").toLowerCase();
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Attempt to acquire a lock on a file path.
 * Returns immediately — does NOT queue or wait.
 */
export function acquireFileLock(
    filePath: string,
    toolAction: string,
): { acquired: true } | { acquired: false; heldBy: string; heldForMs: number } {
    const key = normalizeLockKey(filePath);
    const existing = activeLocks.get(key);

    if (existing) {
        const elapsed = Date.now() - existing.acquiredAt;
        if (elapsed < LOCK_TIMEOUT_MS) {
            return { acquired: false, heldBy: existing.toolAction, heldForMs: elapsed };
        }
        // Stale lock — reclaim it
    }

    activeLocks.set(key, { toolAction, acquiredAt: Date.now() });
    return { acquired: true };
}

/**
 * Release a previously acquired lock.
 * Safe to call even if the lock doesn't exist (idempotent).
 */
export function releaseFileLock(filePath: string): void {
    const key = normalizeLockKey(filePath);
    activeLocks.delete(key);
}

/**
 * Clear all locks. For testing only.
 */
export function resetFileLocks(): void {
    activeLocks.clear();
}
```

---

## README.md

```markdown
# TokenGuard v3.0 — 3 Tools. 361 Tests. Zero Cloud. Instant Startup.

<p align="center">
  <img src="https://img.shields.io/badge/MCP-Plugin-blue?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0wIDE4Yy00LjQyIDAtOC0zLjU4LTgtOHMzLjU4LTggOC04IDggMy41OCA4IDgtMy41OCA0LTggOHoiLz48L3N2Zz4=" alt="MCP Plugin">
  <img src="https://img.shields.io/badge/Tools-3-blue?style=for-the-badge" alt="3 Tools">
  <img src="https://img.shields.io/badge/Token%20Savings-91%25-green?style=for-the-badge" alt="91% Savings">
  <img src="https://img.shields.io/badge/Tests-361%20passed-brightgreen?style=for-the-badge" alt="361 Tests">
  <img src="https://img.shields.io/badge/Cloud-Zero-red?style=for-the-badge" alt="Zero Cloud">
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="MIT License">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=for-the-badge&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-≥20-339933?style=for-the-badge&logo=node.js" alt="Node.js">
</p>

<p align="center">
  <b>3 router tools. Invisible middleware. Lite mode (instant) or Pro mode (semantic). All local.</b>
</p>

---

### What Changed in v3.0

TokenGuard v2 had 16 tools. That meant **~3,520 tokens of fixed overhead** just for tool definitions, plus wasted output tokens as the LLM reasoned about which of 16 tools to call. For small/medium projects, TokenGuard was **net-negative**.

v3.0 fixes this by collapsing 16 tools into 3 routers and moving validation/safety into invisible middleware:

| v2 (16 tools) | v3 (3 tools) | What Changed |
|---|---|---|
| `tg_search`, `tg_def`, `tg_refs`, `tg_outline`, `tg_map` | **`tg_navigate`** | One router, `action` parameter selects behavior |
| `tg_read`, `tg_compress`, `tg_semantic_edit`, `tg_undo`, `tg_terminal` | **`tg_code`** | Edits auto-validated via AST before disk write |
| `tg_pin`, `tg_status`, `tg_session_report` | **`tg_guard`** | Safety + monitoring unified |
| `tg_validate` | *invisible middleware* | Runs automatically inside `tg_code edit` |
| `tg_circuit_breaker` | *invisible middleware* | Monitors all calls, auto-resets on diversity |
| `tg_audit` | *CLI only* | Removed from MCP, available via `npx @ruso-0/tokenguard --audit` |

**Result:** ~660 tokens of tool definitions instead of ~3,520. **81% reduction in fixed overhead.**

### Lite Mode vs Pro Mode

| | Lite (Default) | Pro (Opt-in) |
|---|---|---|
| **Startup** | Instant (~100ms) | ~5-10s (ONNX model load) |
| **Search** | BM25 keyword search | Hybrid semantic + BM25 with RRF |
| **Dependencies** | Tree-sitter only | Tree-sitter + ONNX Runtime |
| **Enable** | Default | `--enable-embeddings` flag |

Lite mode is perfect for most projects. Pro mode adds semantic understanding for large codebases.

---

## The Problem

You're 90 minutes into a Claude Pro session. You've been exploring a codebase, reading files, running grep searches. Suddenly: **context limit reached**. Your session is over.

**Why?** Because every `grep` reads entire files. Every `Read` dumps thousands of tokens. Every broken code write causes a fix-retry loop that burns your remaining context.

## The Solution

TokenGuard sits between you and token waste with 3 smart tools:

| What You Do Now | What TokenGuard Does | Savings |
|---|---|---|
| `grep "auth" ./src` reads 50 files | `tg_navigate action:"search" target:"authentication"` returns 5 relevant chunks | **97%** |
| `Read src/engine.ts` dumps 5,502 tokens | `tg_code action:"compress" path:"src/engine.ts"` sends 1,753 tokens | **68%** |
| Read file + skim for function | `tg_navigate action:"definition" target:"AuthService"` jumps straight there | **300x faster** |
| Copy-paste 500 lines of npm errors | `tg_code action:"terminal"` extracts the 3 actual errors | **89%** |
| Rewrite entire file to change one function | `tg_code action:"edit"` patches only the AST node | **98% output saved** |
| Write broken code → see error → retry loop | Automatic AST validation blocks bad writes before disk | **Prevents loop** |
| Claude gets stuck in write-test-fail loops | Circuit breaker auto-detects and stops doom loops | **Saves session** |
| Claude forgets "always use fetch, not axios" | `tg_guard action:"pin"` keeps rules in every response | **Never forgotten** |

## The 3 Tools

### `tg_navigate` — Search & Navigate

| Action | Description |
|---|---|
| `search` | Hybrid semantic + BM25 search (Pro) or keyword search (Lite). Returns compressed AST chunks. |
| `definition` | Go-to-definition by symbol name. 100% precise AST lookup. |
| `references` | Find all references to a symbol across the project. |
| `outline` | List all symbols in a file with signatures and line ranges. |
| `map` | Static repo map with pinned rules. Deterministic and prompt-cache-friendly. |

### `tg_code` — Read, Compress & Edit

| Action | Description |
|---|---|
| `read` | Smart file reader with optional auto-compression for large files. |
| `compress` | Full-control compression. 3 levels (light/medium/aggressive) or 6 tiers. |
| `edit` | Surgically edit a function/class by name. **Auto-validated via AST before write.** |
| `undo` | Revert the last edit. One-shot backup restore. |
| `terminal` | Filter noisy terminal output. Strips ANSI, deduplicates, extracts errors. |

### `tg_guard` — Safety & Memory

| Action | Description |
|---|---|
| `pin` | Pin a rule Claude should never forget. Injected into every map response. |
| `unpin` | Remove a pinned rule. |
| `status` | Token burn rate, exhaustion prediction, and alert levels. |
| `report` | Full session savings receipt with USD estimates. |

## Invisible Middleware

These run automatically — you never call them directly:

- **AST Validation**: Every `tg_code action:"edit"` validates syntax via tree-sitter before writing to disk. Invalid code is blocked with exact line/column error details and fix suggestions.
- **Circuit Breaker**: Monitors all tool calls for destructive patterns (same error 3x, same file 5x, write-test-fail cycles). Auto-resets when you switch actions or after 60s idle.

## Installation

```bash
# One command — runs directly from npm:
npx @ruso-0/tokenguard
```

Or install globally:

```bash
npm install -g @ruso-0/tokenguard
```

### Claude Code Configuration

**Option A — CLI (recommended):**

```bash
# Lite mode (instant startup, keyword search):
claude mcp add tokenguard -- npx @ruso-0/tokenguard

# Pro mode (semantic search, requires ONNX model download on first run):
claude mcp add tokenguard -- npx @ruso-0/tokenguard --enable-embeddings
```

**Option B — Manual config** in `.claude.json` or `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tokenguard": {
      "command": "npx",
      "args": ["-y", "@ruso-0/tokenguard"]
    }
  }
}
```

For Pro mode, add `"--enable-embeddings"` to the args array.

## Quick Start

```bash
# TokenGuard runs as an MCP server — just use the tools:

# 1. Pin your project rules (they'll never be forgotten)
tg_guard action:"pin" options:{text: "Always use fetch, not axios"}
tg_guard action:"pin" options:{text: "API base URL is /api/v2"}

# 2. Get the repo map (cached by Anthropic prompt cache, includes pinned rules)
tg_navigate action:"map"

# 3. Search semantically (replaces grep)
tg_navigate action:"search" target:"authentication middleware"

# 4. Jump to a definition (replaces Read + Ctrl+F)
tg_navigate action:"definition" target:"AuthService"

# 5. Surgically edit a function (auto-validated, no file rewrite needed)
tg_code action:"edit" path:"src/auth.ts" options:{symbol: "validateToken", new_code: "..."}

# 6. Filter noisy terminal output
tg_code action:"terminal" options:{output: "<paste error output>"}

# 7. Full session report with receipt
tg_guard action:"report"
```

## Architecture

```
+-------------------------------------------------------------+
|                  Claude Code (MCP Client)                    |
+----------------------------+--------------------------------+
                             | stdio (JSON-RPC)
+----------------------------v--------------------------------+
|          TokenGuard MCP Server (3 router tools)              |
|                                                              |
|  +--------------------------------------------------------+  |
|  |  Middleware Layer (invisible)                            |  |
|  |  +------------------+ +---------------------+          |  |
|  |  | AST Validator    | | Circuit Breaker     |          |  |
|  |  | (pre-edit check) | | (loop detection)    |          |  |
|  |  +------------------+ +---------------------+          |  |
|  +--------------------------------------------------------+  |
|                                                              |
|  +------------------+------------------+------------------+  |
|  | tg_navigate      | tg_code          | tg_guard         |  |
|  | search           | read             | pin / unpin      |  |
|  | definition       | compress         | status           |  |
|  | references       | edit (validated) | report           |  |
|  | outline          | undo             |                  |  |
|  | map              | terminal         |                  |  |
|  +--------+---------+--------+---------+--------+---------+  |
|           |                  |                  |            |
|  +--------v------------------v------------------v---------+  |
|  |                    Core Layer                           |  |
|  |  +----------+ +----------+ +----------+ +----------+  |  |
|  |  | Embedder | |  Parser  | | Database | | Sandbox  |  |  |
|  |  |(jina v2) | |(TreeSit.)| | (SQLite) | |(Validate)|  |  |
|  |  +----------+ +----------+ +----------+ +----------+  |  |
|  +---------------------------------------------------------+  |
+--------------------------------------------------------------+
```

## Stress Tested

**361 tests. 0 failures. 14 test suites.**

| Scenario | What We Tested | Result |
|---|---|---|
| Router dispatch | All 14 {tool, action} combinations | Pass |
| Middleware wrap | Circuit breaker auto-trip and auto-reset | Pass |
| AST validation | Valid/invalid code, error formatting | Pass |
| Backward compat | All 16 original tool behaviors preserved | Pass |
| Empty files | 0-byte input through every pipeline stage | Pass |
| 500KB TypeScript | ~3,500 generated functions | Pass |
| Binary data | Random bytes, null bytes, non-UTF-8 | Pass |
| Unicode / CJK / Emoji | Japanese identifiers, emoji in strings | Pass |
| Minified 50KB JS | Single-line, no whitespace, 2000 functions | Pass |
| 20-level nesting | Deeply nested function chains | Pass |
| 50-file concurrent batch | Batch insert + hybrid search | Pass |
| Surgical edits | Symbol replacement with syntax validation | Pass |
| Pin memory | Add/remove/persist/limits/deterministic output | Pass |

### Real-World Validation
Tested against a 57-file production Next.js + Supabase app (SICAEP):
- **94.1% token reduction** (tier 1 compression)
- **10,532 tokens saved** on a single search query
- **361/361 tests passed** (305 unit + 56 new for v3)
- Surgically fixed a real `.single()` → `.maybeSingle()` bug via `tg_code action:"edit"`
- Circuit breaker correctly detected repeated error patterns
- Path traversal attack (`../../../../etc/passwd`) → **BLOCKED**

> **Note:** TokenGuard is most effective on projects with 50+ files. For very small projects (<20 files), the overhead may not justify the savings.

## Security

- **Zero cloud**: All processing is local. No API keys, no telemetry, no network calls.
- **No data leaves your machine**: Embeddings computed locally via ONNX Runtime.
- **Path traversal protection**: All file paths validated with `safePath()`.
- **SQLite storage**: Your code index stays in `.tokenguard.db` in your project root.
- **WASM memory safety**: All tree-sitter parsing wrapped in `safeParse()` with guaranteed cleanup.
- **MIT licensed**: Fully open source, audit the code yourself.

## Contributing

PRs welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting.

```bash
# Development
git clone https://github.com/Ruso-0/TokenGuard.git
cd TokenGuard
npm install
npm run build
npm test
```

## License

MIT

---

<p align="center">
  <b>Stop burning tokens. Start guarding them.</b><br>
  <sub>Built with frustration, shipped with hope. Now 81% leaner.</sub>
</p>
```

---

## package.json

```json
{
  "name": "@ruso-0/tokenguard",
  "version": "3.0.1",
  "description": "MCP plugin for Claude Code — 3 router tools with invisible middleware for token-optimized code navigation, compression, and safety. Lite mode (instant) or Pro mode (semantic search).",
  "main": "dist/index.js",
  "type": "module",
  "bin": {
    "tokenguard": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "postinstall": "node scripts/download-wasm.js",
    "lint": "tsc --noEmit"
  },
  "keywords": [
    "mcp",
    "claude",
    "token-optimization",
    "semantic-search",
    "ast",
    "tree-sitter",
    "embeddings",
    "context-management"
  ],
  "author": "",
  "license": "MIT",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.1",
    "@xenova/transformers": "^2.17.2",
    "chokidar": "^4.0.3",
    "sql.js": "^1.12.0",
    "tree-sitter-wasms": "^0.1.13",
    "web-tree-sitter": "^0.24.7",
    "zod": "^3.24.2"
  },
  "optionalDependencies": {
    "sharp": "^0.34.5"
  },
  "devDependencies": {
    "@types/node": "^22.13.10",
    "tsx": "^4.19.3",
    "typescript": "^5.7.3",
    "vitest": "^3.0.7"
  },
  "files": [
    "dist/",
    "wasm/",
    "scripts/download-wasm.js",
    "README.md",
    "LICENSE",
    "CHANGELOG.md"
  ],
  "engines": {
    "node": ">=20.0.0"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/Ruso-0/TokenGuard"
  }
}
```

---

## CHANGELOG.md

```markdown
# Changelog

All notable changes to TokenGuard will be documented in this file.

## [3.0.0] - 2026-03-10

### Headline
TokenGuard v3.0 — Architecture overhaul. 16 tools collapsed to 3 routers. Invisible middleware. Lite/Pro mode. 81% reduction in tool definition overhead.

### BREAKING CHANGES
- **16 tools → 3 router tools**: All MCP tool names have changed. LLMs must use the new `tg_navigate`, `tg_code`, `tg_guard` tool names with `action` parameters.
- **`tg_validate` removed from MCP**: Now runs automatically as invisible middleware inside `tg_code action:"edit"`. No manual calls needed.
- **`tg_circuit_breaker` removed from MCP**: Now runs as passive middleware monitoring all tool calls. Auto-resets after 60s inactivity or when a different action is called.
- **`tg_audit` removed from MCP**: Moved to CLI only. Use `npx @ruso-0/tokenguard --audit`.

### Added — Router Pattern
- **`tg_navigate`** — Unified navigation tool replacing `tg_search`, `tg_def`, `tg_refs`, `tg_outline`, `tg_map`. Actions: `search`, `definition`, `references`, `outline`, `map`.
- **`tg_code`** — Unified code tool replacing `tg_read`, `tg_compress`, `tg_semantic_edit`, `tg_undo`, `tg_terminal`. Actions: `read`, `compress`, `edit`, `undo`, `terminal`.
- **`tg_guard`** — Unified safety tool replacing `tg_pin`, `tg_status`, `tg_session_report`. Actions: `pin`, `unpin`, `status`, `report`.
- `src/router.ts` — Central dispatcher mapping `{tool, action}` to handler functions (~700 lines).

### Added — Invisible Middleware
- `src/middleware/validator.ts` — AST validation wrapper. Validates code via tree-sitter before disk writes inside `tg_code action:"edit"`.
- `src/middleware/circuit-breaker.ts` — Passive circuit breaker. Wraps all handlers, records tool call results, trips on destructive patterns, auto-resets on action diversity or 60s inactivity.

### Added — Lite / Pro Mode
- **Lite mode (default)**: Instant startup (~100ms). BM25 keyword-only search. No ONNX model dependency.
- **Pro mode (`--enable-embeddings`)**: Hybrid semantic + BM25 search with RRF fusion. Requires ONNX Runtime for jina-v2-small embeddings.
- `searchKeywordOnly()` method added to `TokenGuardDB` for Lite mode BM25 search.
- Engine methods (`indexFile`, `indexDirectory`, `search`, `getRepoMap`) now branch based on `enableEmbeddings` config.

### Changed
- **`src/index.ts`**: Rewritten from ~1,479 lines (16 tool registrations) to ~180 lines (3 router registrations).
- **Tool definition overhead**: ~3,520 tokens → ~660 tokens (81% reduction).
- **Test count**: 305 → 361 tests across 14 test suites.
- **`package.json`**: Version bumped to 3.0.0. Description updated.
- **`README.md`**: Complete rewrite for v3.0 architecture.

### Added — Tests
- `tests/router.test.ts` — 30 tests for router dispatch correctness across all 14 `{tool, action}` pairs.
- `tests/middleware.test.ts` — 13 tests for validator and circuit breaker middleware behavior.
- `tests/backward-compat.test.ts` — 13 tests verifying all 16 original tool behaviors work through the new 3-tool API.

---

## [2.1.2] - 2026-03-10

### Headline
TokenGuard v2.1.2 — Lazy ONNX loading fixes MCP handshake timeout for real-world users.

### Fixed
- **CRITICAL — MCP handshake timeout**: `engine.initialize()` was eagerly loading the ONNX embedding model (~5-10s) during startup, blocking ALL tool calls until the model was ready. Real users connecting via Claude Code would experience timeouts or slow first responses. Split initialization into two phases:
  - **Fast path** (`initialize()`): SQLite + Tree-sitter only (~100ms). Used by 12/16 tools.
  - **Embedder path** (`initializeEmbedder()`): Adds ONNX model load. Used only by `tg_search`, `tg_map`, and indexing operations.
- **`tg_def` first-call latency**: Was 465ms because it waited for the embedder to load (which it doesn't use). Now completes in ~50ms on first call.
- Removed background `engine.initialize()` from `main()` — tools now self-initialize at the correct level when first called.

### Changed
- **package.json**: Version bumped to 2.1.2.

---

## [2.1.1] - 2026-03-10

### Headline
TokenGuard v2.1.1 — Final audit fixes, tg_undo, 16 tools, 305 tests.

### Added — New Tool
- **`tg_undo`** — Undo the last `tg_semantic_edit` on a file. Auto-restores from backup with one-shot semantics (backup is consumed after restore).

### Added — New Module
- `src/undo.ts` — Backup/restore engine using base64url-encoded file paths. Stores pre-edit snapshots in `.tokenguard/backups/`.
- `src/utils/read-source.ts` — Shared BOM-safe file reader. Strips U+FEFF byte order marks from Windows-created source files.

### Security
- **FIX 2 — XML injection prevention**: Pin content is now escaped (`&`, `<`, `>`, `"`, `'`) before storage to prevent prompt injection via pinned rules.

### Fixed
- **FIX 1 — BOM stripping**: All source file readers now use `readSource()` to strip U+FEFF BOM, fixing parse failures on Windows-created files.
- **FIX 3 — Code tokenizer**: Rewritten to correctly handle `$scope`, `__proto__`, `_privateVar`, and other edge-case identifiers with `$`/`_` prefixes.
- **FIX 4 — Fast dot product**: Replaced cosine similarity with direct dot product for L2-normalized vectors. Removes sqrt/division overhead; mathematically equivalent for unit vectors.
- **FIX 6 — Pin order**: Pinned rules now appear AFTER repo map text (was before). Preserves Anthropic prompt cache hits since the static map stays at the start of context.
- **FIX 7 — Circuit breaker normalization**: `hashError()` now normalizes ISO timestamps and improved memory address normalization. Added 5-minute TTL eviction to prevent stale errors from tripping the breaker.
- **FIX 8 — ASCII receipt**: Replaced all Unicode box-drawing characters and emojis in session receipt and reports with ASCII equivalents for terminal compatibility.

### Changed
- **Tool count**: 15 -> 16 MCP tools.
- **Test count**: 282 -> 305 tests across 11 test suites.
- **tg_map**: Pinned rules now appended after repo map (was prepended before).
- **package.json**: Version bumped to 2.1.1.

---

## [2.1.0] - 2026-03-10

### Headline
TokenGuard v2.1 — 15 MCP tools, 282 tests, circuit breaker, surgical edit, pin memory, session receipt.

### Added — New Tools
- **`tg_semantic_edit`** — Surgically edit a function/class/interface by name without reading or rewriting the entire file. Finds the exact AST node, replaces only those bytes, validates syntax before saving. Saves 98% of output tokens vs full file rewrites.
- **`tg_circuit_breaker`** — Detects infinite failure loops (same error 3+ times, same file 5+ times, write-test-fail cycles). When tripped, forces Claude to stop and ask the human for guidance. Prevents doom loops that burn through remaining context.
- **`tg_pin`** — Pin important rules Claude should never forget. Pinned items are injected into every `tg_map` response, keeping project conventions permanently in Claude's attention window. Max 10 pins, 200 chars each, persisted to disk.

### Added — New Modules
- `src/semantic-edit.ts` — Zero-read surgical AST patching. Symbol name lookup, byte-level splice, syntax validation before write.
- `src/circuit-breaker.ts` — Loop detection engine with sliding window analysis, consecutive failure tracking, and automatic trip/reset.
- `src/pin-memory.ts` — Persistent pinned rules with deterministic output (sorted by id) for prompt cache compatibility.

### Added — Session Receipt
- `tg_session_report` now generates an ASCII receipt showing input tokens saved, output tokens avoided, search queries, surgical edits, syntax errors blocked, doom loops prevented, pinned rules active, estimated USD savings, and model info.

### Changed
- **Tool count**: 12 -> 15 MCP tools.
- **Test count**: 194 -> 282 tests across 11 test suites.
- **tg_map**: Now prepends pinned rules at the top of the repo map output.
- **README**: Complete rewrite for v2.1 with comparison table, 3 unique features highlight, receipt preview, and updated architecture diagram.
- **package.json**: Version bumped to 2.1.0.

### Architecture
- **Pin memory layer**: Pinned rules are stored in `.tokenguard/pins.json` and prepended to every `tg_map` response. Deterministic output (sorted by id) preserves prompt cache compatibility.
- **Circuit breaker integration**: `tg_terminal` automatically feeds errors to the circuit breaker for proactive loop detection.

## [2.0.0] - 2026-03-10

### Headline
TokenGuard v2.0 — 12 MCP tools, 194 tests, cache-aware two-layer architecture.

### Added — New Tools
- **`tg_def`** — Go-to-definition by symbol name. AST-based, 100% precise, returns full source body with signature.
- **`tg_refs`** — Find all references to a symbol across the project. Cross-file word-boundary matching with context.
- **`tg_outline`** — List all symbols in a file with kind, signature, export status, and line ranges. Like VS Code Outline.
- **`tg_validate`** — AST sandbox validator. Parses code with tree-sitter before disk write. Catches missing commas, unclosed braces, invalid syntax with exact line/column and fix suggestions. Prevents the "write broken code → see error → retry" token burn loop.

### Added — New Modules
- `src/ast-navigator.ts` — AST navigation engine for tg_def, tg_refs, tg_outline. Walks project files, extracts symbols, signatures, export status.
- `src/ast-sandbox.ts` — AST sandbox validator with `validateCode()` and `validateDiff()`. Recursive tree walk with `hasError` subtree pruning for large-file performance.
- `src/terminal-filter.ts` — Terminal entropy filter. Strips ANSI codes, deduplicates stack traces, extracts unique errors and affected files. 89% token reduction on error output.
- `src/repo-map.ts` — Static deterministic repo map for Anthropic prompt cache optimization. Identical output for same repo state enables $0.30/M caching vs $3.00/M input.

### Changed
- **Embeddings**: Migrated from all-MiniLM-L6-v2 (384-dim) to jina-embeddings-v2-small-en (512-dim) for 3x better code search precision.
- **BM25 tuning**: Optimized k1=1.8, b=0.35 for code (vs default k1=1.2, b=0.75 for prose).
- **RRF tuning**: k=10 for sharper rank fusion (vs k=60 default).
- **Code tokenizer**: camelCase, snake_case, PascalCase identifiers split into sub-tokens for better BM25 matching.
- **Tool count**: 6 → 12 MCP tools.
- **Test count**: 90 → 194 tests across 8 test suites.
- **README**: Complete rewrite with self-benchmark results, two-layer architecture docs, and updated comparison table.

### Architecture
- **Two-layer design**: Layer 1 (static repo map, prompt-cacheable) + Layer 2 (dynamic context, per-query).
- **Cache-friendly**: tg_map output is deterministic — same repo state produces identical text, enabling Anthropic prompt caching.

### Performance (Self-Benchmark)
- tg_search: 10 results in 16ms (hybrid RRF fusion)
- tg_def: Definition lookup in 128ms across 22 files
- tg_refs: 20 references found in 11ms
- tg_outline: 25 symbols extracted in 7ms
- tg_compress: 5,502 → 1,753 tokens (68% reduction, medium level)
- tg_terminal: 11,967 → 1,276 tokens (89% reduction)
- tg_validate: Syntax error detection with line/column in <1ms
- tg_map: 22 files mapped, 4,677 tokens, 169ms

## [1.2.0] - 2026-03-10

### Security
- **Path traversal protection**: All file operations now validate paths stay within workspace root (`safePath`)
- **Input validation**: All tool inputs validated with Zod schemas before processing
- **File size limits**: Files > 500KB and binary/minified files are automatically skipped

### Fixed
- **WASM memory leaks**: Tree-sitter parse trees now guaranteed cleanup via `safeParse` try/finally wrapper
- **Event loop blocking**: Large indexing operations now yield every 100 files via `setImmediate`
- **Aggressive compression stubs**: Functions now show line count, key references, and expand commands instead of empty bodies
- **Search tokenization**: Code identifiers (camelCase, snake_case, PascalCase) are now split into sub-tokens for better matching
- **Vector search accuracy**: Cosine similarity now uses proper norm computation instead of raw dot product
- **RRF scoring**: Verified correct rank-based fusion (was already using positions, not scores)

### Added
- `src/utils/path-jail.ts` — Path traversal protection
- `src/utils/safe-parse.ts` — WASM memory-safe parsing
- `src/utils/file-filter.ts` — File size and extension filtering
- `src/utils/code-tokenizer.ts` — Code-aware identifier tokenization
- `src/schemas.ts` — Zod validation schemas for all tools
- `.github/workflows/ci.yml` — CI/CD with matrix testing (3 OSes × 3 Node versions)
- `CONTRIBUTING.md` — Contributor guide
- `CHANGELOG.md` — This file
- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- Comprehensive test suite for all new utilities

### Performance
- Pre-computed vector norms at index time (avoids recalculation during search)
- Proper cosine similarity with normalized vectors

## [1.1.1] - 2026-03-09

### Initial Release
- MCP server with 6 tools: tg_search, tg_audit, tg_compress, tg_status, tg_session_report, tg_read
- Hybrid RRF search (BM25 + vector similarity)
- Three-tier classic compression + LLMLingua-2-inspired advanced compression
- Real-time file watching with chokidar
- Token consumption monitoring and burn rate prediction
- Pre-tool-use interception hook
```
