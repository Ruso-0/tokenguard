#!/usr/bin/env node

/**
 * index.ts — TokenGuard v4.0.2 MCP Server entry point.
 *
 * Exposes 3 router tools to Claude Code (replaces 16 individual tools):
 *
 *   1. tg_navigate — AST-powered code navigation, semantic search, and refactor analysis
 *   2. tg_code     — Read, compress, surgically edit, and batch edit code files
 *   3. tg_guard    — Safety controls, session monitoring, and persistent memory
 *
 * Middleware (runs automatically, not exposed as tools):
 *   - AST Validation: validates code before disk writes (inside tg_code edit/batch_edit)
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
import { PreToolUseHook } from "./hooks/preToolUse.js";

// ─── CLI Flag Parsing ───────────────────────────────────────────────

const args = process.argv.slice(2);
const VERSION = "4.0.2";

if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
    console.log(`
🛡️ TokenGuard v${VERSION} — AST-Aware Context Firewall for Claude Code

Usage:
  npx @ruso-0/tokenguard [options]
  npx @ruso-0/tokenguard init      # Creates optimal CLAUDE.md instructions

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
    const marker = "# TokenGuard Active";

    if (fs.existsSync(claudePath)) {
        const existing = fs.readFileSync(claudePath, "utf-8");
        if (existing.includes(marker)) {
            console.error("[TokenGuard] CLAUDE.md already contains TokenGuard instructions. Skipping.");
            process.exit(0);
        }
        // Append to existing CLAUDE.md
        fs.appendFileSync(claudePath, "\n\n" + getClaudeMdContent(), "utf-8");
        console.error("[TokenGuard] Appended TokenGuard instructions to existing CLAUDE.md");
    } else {
        fs.writeFileSync(claudePath, getClaudeMdContent(), "utf-8");
        console.error("[TokenGuard] Created CLAUDE.md in " + process.cwd());
    }
    process.exit(0);
}

function getClaudeMdContent(): string {
    return `# TokenGuard Active

This workspace has the TokenGuard MCP plugin installed. It extends your capabilities with AST-aware tools that protect your context window and prevent syntax errors before they reach disk.

## Optimal Workflow

1. **Run tests & commands freely.** Use Bash for npm test, builds, git — TokenGuard doesn't interfere with your terminal.
2. **Navigate with AST precision.** Prefer \`tg_navigate\` over grep/glob. It returns exact structural matches (functions, classes, references) without flooding your context with noise.
3. **Read files efficiently.** ALWAYS prefer \`tg_code action:"read"\` over native Read. Native Read dumps the entire file into your context — a 2,000-line file burns ~5,000 tokens in one call. \`tg_code read\` auto-compresses to ~1,200 tokens while keeping all structural context. This is the single biggest token saver available to you.
4. **Debugging? Read uncompressed.** If you need to understand a function's internal logic (not just its signature), use \`tg_code action:"read" compress:false\`. Compression hides function bodies to save tokens — great for navigation, but not for debugging.
5. **Edit surgically.** Prefer \`tg_code action:"edit"\` for modifying existing functions/classes. It validates the AST before writing to disk — if your code has a syntax error, the file stays untouched and you get the exact line/column to fix.
6. **Multi-file refactors? Use batch_edit.** \`tg_code action:"batch_edit" edits:[...]\` edits multiple files atomically. If ANY file has a syntax error, NOTHING is written to disk. All-or-nothing safety.
7. **Renaming a symbol? Use prepare_refactor first.** \`tg_navigate action:"prepare_refactor" symbol:"OldName"\` analyzes every occurrence and classifies it as "high confidence" (safe to rename) or "review" (might be a string, comment, or object key). Then use batch_edit to apply the renames.
8. **Watch for blast radius warnings.** When you change a function's signature, TokenGuard automatically warns you which files import it. Fix those files before running tests.
9. **The repo map shows architecture tiers.** \`tg_navigate action:"map"\` now classifies files as CORE (high import count — modify with caution), BUSINESS LOGIC (medium), or LEAF (safe to experiment).
10. **Create new files normally.** Use native Write for brand new files that don't exist yet.
11. **Pin rules that matter.** Use \`tg_guard action:"pin"\` to persist instructions across messages (e.g., "always use fetch, not axios").
12. **Anchor your plan.** If you're working on a complex task with strict schemas or architectural constraints, use \`tg_guard action:"set_plan" text:"PLAN.md"\` at the start. TokenGuard will silently re-inject your plan every ~15 tool calls to survive context compaction. Use \`tg_guard action:"memorize" text:"your progress notes"\` to leave notes for yourself.
13. **If the circuit breaker triggers, follow its instructions.** It detected a doom loop and is protecting your session from burning tokens on repeated failures.

TokenGuard handles the context heavy-lifting so you can focus on writing correct code on the first try.
`;
}

// ─── Initialization ─────────────────────────────────────────────────

const engine = new TokenGuardEngine({
    dbPath: path.join(process.cwd(), ".tokenguard.db"),
    watchPaths: [process.cwd()],
    enableEmbeddings,
});

const monitor = new TokenMonitor();
const sandbox = new AstSandbox();
const circuitBreaker = new CircuitBreaker();

const hook = new PreToolUseHook({ tokenThreshold: 1000 });
const deps: RouterDependencies = { engine, monitor, sandbox, circuitBreaker, hook };

const server = new McpServer({
    name: "TokenGuard",
    version: VERSION,
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
            "tg_code",
            action,
            () => handleCode(action, params, deps),
            filePath,
            symbol,
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
            .enum(["pin", "unpin", "status", "report", "reset", "set_plan", "memorize"])
            .describe(
                "pin: add a persistent rule (injected into every map response). " +
                "unpin: remove a pinned rule. " +
                "status: token burn rate and alerts. " +
                "report: full session savings receipt. " +
                "reset: clear circuit breaker state to resume editing. " +
                "set_plan: anchor a master plan file to prevent Claude from forgetting it during context compaction. " +
                "memorize: write your current progress/thoughts to TokenGuard's active memory.",
            ),
        text: z
            .string()
            .optional()
            .describe("For pin: the rule text (max 200 chars). For set_plan: the file path to your plan. For memorize: your thoughts/progress to remember."),
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
