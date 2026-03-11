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
    version: "3.0.2",
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
