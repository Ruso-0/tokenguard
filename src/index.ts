#!/usr/bin/env node

/**
 * index.ts - NREKI MCP Server entry point.
 *
 * Exposes 3 router tools to Claude Code (replaces 16 individual tools):
 *
 *   1. nreki_navigate - AST-powered code navigation, semantic search, and refactor analysis
 *   2. nreki_code     - Read, compress, surgically edit, and batch edit code files
 *   3. nreki_guard    - Safety controls, session monitoring, and persistent memory
 *
 * Middleware (runs automatically, not exposed as tools):
 *   - AST Validation: validates code before disk writes (inside nreki_code edit/batch_edit)
 *   - Circuit Breaker: detects and stops infinite failure loops
 *   - File Lock: prevents concurrent edit corruption
 *
 * All processing is local. Zero cloud dependencies.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "path";
import fs from "fs";

import { NrekiEngine } from "./engine.js";
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
import { PreToolUseHook } from "./hooks/preToolUse.js";
import { NrekiKernel } from "./kernel/nreki-kernel.js";
import { ChronosMemory } from "./chronos-memory.js";
import { logger } from "./utils/logger.js";

// ─── Performance Mode Auto-Detection ────────────────────────────────

// Bounded DFS. Uses stack.pop() which is O(1) in V8.
// Array.shift() is O(N) in V8 because it reindexes the contiguous memory block.
// Do not change pop() to shift().
export function detectMode(dir: string): "syntax" | "file" | "project" | "hologram" {
    let count = 0;
    const stack = [dir];
    const ignore = new Set(["node_modules", "dist", "build", ".git", ".next", "coverage"]);

    while (stack.length > 0) {
        if (count > 1000) return "hologram";

        const current = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(current, { withFileTypes: true }); }
        catch { continue; }

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!ignore.has(entry.name) && !entry.name.startsWith(".")) {
                    stack.push(path.join(current, entry.name));
                }
            } else if (
                /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(entry.name) &&
                !/\.d\.[mc]?ts$/i.test(entry.name)
            ) {
                count++;
            }
        }
    }
    // Escala por costo computacional: syntax < file < project < hologram
    if (count < 50) return "syntax";       // O(0) - AST parsing only, kernel off
    if (count <= 200) return "file";       // O(K) - Semantic checks on touched files only
    return "project";                       // O(N) - Full cascade evaluation
}

// ─── CLI Flag Parsing ───────────────────────────────────────────────

const args = process.argv.slice(2);
const VERSION = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8")
).version;

if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
    console.log(`
NREKI v${VERSION} - Semantic validation for Claude Code

Usage:
  npx @ruso-0/nreki [options]
  npx @ruso-0/nreki init      # Creates optimal CLAUDE.md instructions

Options:
  --enable-embeddings   Enable local ONNX semantic search (Pro mode)
  --help, -h            Show this help message
  --version, -v         Show version
    `);
    process.exit(0);
}

const enableEmbeddings = args.includes("--enable-embeddings");

// ─── Init Subcommand ────────────────────────────────────────────────

if (args[0] === "init") {
    const claudePath = path.join(process.cwd(), "CLAUDE.md");
    const marker = "# NREKI Active";

    if (fs.existsSync(claudePath)) {
        const existing = fs.readFileSync(claudePath, "utf-8");
        if (existing.includes(marker)) {
            logger.info("CLAUDE.md already contains NREKI instructions. Skipping.");
            process.exit(0);
        }
        // Append to existing CLAUDE.md
        fs.appendFileSync(claudePath, "\n\n" + getClaudeMdContent(), "utf-8");
        logger.info("Appended NREKI instructions to existing CLAUDE.md");
    } else {
        fs.writeFileSync(claudePath, getClaudeMdContent(), "utf-8");
        logger.info("Created CLAUDE.md in " + process.cwd());
    }
    process.exit(0);
}

function getClaudeMdContent(): string {
    return fs.readFileSync(
        new URL("../templates/CLAUDE.md", import.meta.url),
        "utf-8"
    );
}

// ─── Initialization ─────────────────────────────────────────────────

const engine = new NrekiEngine({
    dbPath: path.join(process.cwd(), ".nreki.db"),
    watchPaths: [process.cwd()],
    enableEmbeddings,
});

const monitor = new TokenMonitor();
const sandbox = new AstSandbox();
const circuitBreaker = new CircuitBreaker();
const chronos = new ChronosMemory(process.cwd());

// ─── NREKI Kernel (opt-in: only activates if tsconfig.json exists) ───
let kernel: NrekiKernel | undefined;
let nrekiMode: "syntax" | "file" | "project" | "hologram" = "syntax";

const tsconfigPath = path.join(process.cwd(), "tsconfig.json");
if (fs.existsSync(tsconfigPath)) {
    nrekiMode = detectMode(process.cwd());

    if (nrekiMode === "syntax") {
        logger.info("SYNTAX mode. Kernel disabled. Layer 1 AST only.");
    } else {
        logger.info(`${nrekiMode.toUpperCase()} mode detected. Kernel boots on first edit.`);
        kernel = new NrekiKernel(); // Instantiated but NOT booted
    }
} else {
    logger.info(
        "No tsconfig.json found. Semantic verification disabled. " +
        "Operating in Tree-sitter-only mode (Layer 1).",
    );
}

// ─── LSP Sidecars (auto-detect Go and Python projects) ──────────
if (kernel) {
    // Go: detect go.mod → register gopls sidecar
    if (fs.existsSync(path.join(process.cwd(), "go.mod"))) {
        try {
            const { GoLspSidecar } = await import("./kernel/backends/go-sidecar.js");
            kernel.registerSidecar(".go", new GoLspSidecar(process.cwd()));
            logger.info("Go project detected (go.mod). gopls sidecar registered.");
        } catch (err) {
            logger.error(`Failed to load Go sidecar: ${(err as Error).message}`);
        }
    }

    // Python: detect pyproject.toml, requirements.txt, setup.py, Pipfile → register pyright sidecar
    const pyMarkers = ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"];
    if (pyMarkers.some(f => fs.existsSync(path.join(process.cwd(), f)))) {
        try {
            const { PythonLspSidecar } = await import("./kernel/backends/python-sidecar.js");
            kernel.registerSidecar(".py", new PythonLspSidecar(process.cwd()));
            logger.info("Python project detected. pyright sidecar registered.");
        } catch (err) {
            logger.error(`Failed to load Python sidecar: ${(err as Error).message}`);
        }
    }
}

const hook = new PreToolUseHook({ tokenThreshold: 1000 });
const deps: RouterDependencies = { engine, monitor, sandbox, circuitBreaker, hook, kernel, chronos, nrekiMode };

const server = new McpServer({
    name: "NREKI",
    version: VERSION,
});

if (!enableEmbeddings) {
    logger.info(
        "Running in Lite mode (BM25 keyword search only). " +
        "Run with --enable-embeddings for semantic search.",
    );
}

// ─── Tool 1: nreki_navigate ───────────────────────────────────────────

server.tool(
    "nreki_navigate",
    "AST-powered code navigation and semantic search. Use for finding code, understanding project structure, and locating symbols.",
    {
        action: z
            .enum(["search", "definition", "references", "outline", "map", "prepare_refactor"])
            .describe(
                "search: hybrid semantic+keyword search across codebase. " +
                "definition: go-to-definition by symbol name. " +
                "references: find all usages of a symbol. " +
                "outline: list all symbols in a file. " +
                "map: full repo structure map with pinned rules. " +
                "prepare_refactor: analyze a symbol for safe renaming (classifies each occurrence as high-confidence or needs-review).",
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
        auto_context: z
            .boolean()
            .optional()
            .describe("Auto-inject signatures of imported dependencies. Set to false for pure output without context."),
    },
    async ({ action, query, symbol, path: navPath, limit, include_raw, kind, signatures, refresh, auto_context }) => {
        const params: NavigateParams = { action, query, symbol, path: navPath, limit, include_raw, kind, signatures, refresh, auto_context };
        return wrapWithCircuitBreaker(
            circuitBreaker,
            "nreki_navigate",
            action,
            () => handleNavigate(action, params, deps),
            undefined, undefined, chronos,
        );
    },
);

// ─── Tool 2: nreki_code ───────────────────────────────────────────────

server.tool(
    "nreki_code",
    "Read, compress, and surgically edit code files. " +
    "All edits are automatically validated via AST before writing to disk - " +
    "if syntax is invalid, the edit is blocked and you get the exact error. " +
    "Undo reverts the last edit. filter_output strips noisy terminal output.",
    {
        action: z
            .enum(["read", "compress", "edit", "batch_edit", "undo", "filter_output"])
            .describe(
                "read: read file with optional compression. " +
                "compress: compress file/directory with full control. " +
                "edit: surgically edit a function/class by name (auto-validated). " +
                "batch_edit: atomically edit multiple symbols across multiple files (all-or-nothing). " +
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
        mode: z
            .enum(["replace", "insert_before", "insert_after"])
            .optional()
            .describe("For edit: how to apply new_code relative to the symbol. 'replace' (default) replaces the symbol. 'insert_before'/'insert_after' adds new_code adjacent to the symbol without removing it."),
        edits: z
            .array(z.object({
                path: z.string(),
                symbol: z.string(),
                new_code: z.string(),
                mode: z.enum(["replace", "insert_before", "insert_after"]).optional(),
            }))
            .optional()
            .describe("For batch_edit: array of edits to apply atomically. Each edit specifies path, symbol, new_code, and optional mode."),
        auto_context: z
            .boolean()
            .optional()
            .describe("Auto-inject signatures of imported dependencies. Set to false for pure output without context."),
    },
    async ({ action, path: filePath, symbol, new_code, compress, level, focus, tier, output, max_lines, mode, edits, auto_context }) => {
        const params: CodeParams = { action, path: filePath, symbol, new_code, compress, level, focus, tier, output, max_lines, mode, edits, auto_context };
        return wrapWithCircuitBreaker(
            circuitBreaker,
            "nreki_code",
            action,
            () => handleCode(action, params, deps),
            filePath,
            symbol,
            chronos,
        );
    },
);

// ─── Tool 3: nreki_guard ──────────────────────────────────────────────

server.tool(
    "nreki_guard",
    "Safety controls, session monitoring, and persistent memory. " +
    "Pin rules that persist across messages, check token burn rate, " +
    "and get session reports.",
    {
        action: z
            .enum(["pin", "unpin", "status", "report", "reset", "set_plan", "memorize", "audit"])
            .describe(
                "pin: add a persistent rule (injected into every map response). " +
                "unpin: remove a pinned rule. " +
                "status: token burn rate and alerts. " +
                "report: full session savings receipt. " +
                "reset: clear circuit breaker state to resume editing. " +
                "set_plan: anchor a master plan file to prevent Claude from forgetting it during context compaction. " +
                "memorize: write your current progress/thoughts to NREKI's active memory. " +
                "audit: run AHI (Automated Hardening Index) audit on the project.",
            ),
        text: z
            .string()
            .optional()
            .describe("For pin: the rule text (max 200 chars). For set_plan: the file path to your plan. For memorize: your thoughts/progress to remember."),
        index: z
            .number()
            .optional()
            .describe("For unpin: the pin number to remove (1-based, as shown in map output)."),
        id: z
            .string()
            .optional()
            .describe("For unpin: the pin id to remove."),
    },
    async ({ action, text, index, id }) => {
        const params: GuardParams = { action, text, index, id };
        return wrapWithCircuitBreaker(
            circuitBreaker,
            "nreki_guard",
            action,
            () => handleGuard(action, params, deps),
            undefined, undefined, chronos,
        );
    },
);

// ─── Server Startup ─────────────────────────────────────────────────

async function main(): Promise<void> {
    const transport = new StdioServerTransport();

    // Graceful shutdown
    const gracefulShutdown = () => {
        try {
            if (kernel && kernel.isBooted()) {
                chronos.syncTechDebt(
                    kernel.getInitialErrorCount(),
                    kernel.getCurrentErrorCount(),
                );
            }
            chronos.forcePersist();
        } catch { /* Never block shutdown */ }
        engine.shutdown();
        process.exit(0);
    };
    process.on("SIGINT", gracefulShutdown);
    process.on("SIGTERM", gracefulShutdown);

    // Connect and serve
    await server.connect(transport);

    // Engine initialization is lazy - each tool calls engine.initialize()
    // (fast: db + parser) or engine.initializeEmbedder() (full: + ONNX model)
    // as needed. This keeps the MCP handshake under 100ms.

    // JIT Holography: pre-load WASM parser (~50ms) without scanning project
    if (nrekiMode === "hologram" && kernel) {
        setImmediate(async () => {
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
                kernel!.setJitParser(jitParser, tsLanguage);
                kernel!.setJitClassifier(classifyAndGenerateShadow);
                logger.info("WASM parser pre-loaded. JIT Holography ready.");
            } catch (err) {
                logger.warn(`WASM pre-load failed: ${(err as Error).message}`);
            }
        });
    }
}

main().catch((err) => {
    logger.error(`Fatal error: ${err.message}`);
    process.exit(1);
});
