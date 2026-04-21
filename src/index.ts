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
import { CognitiveEnforcer } from "./hooks/cognitive-enforcer.js";
import { NrekiKernel } from "./kernel/nreki-kernel.js";
import { ChronosMemory } from "./chronos-memory.js";
import { logger } from "./utils/logger.js";

// Patch 7 (v10.6.1): shape of .claude/settings.json. Kept loose on unknown
// keys because Anthropic may add fields; the init command only reads/writes
// the `hooks.PreToolUse` matcher list.
interface ClaudeSettings {
    hooks?: {
        PreToolUse?: Array<{
            matcher: string;
            hooks: Array<{ type: string; command: string }>;
        }>;
    };
    [key: string]: unknown;
}

// ─── Performance Mode Auto-Detection ────────────────────────────────

// Bounded DFS. Uses stack.pop() which is O(1) in V8.
// Array.shift() is O(N) in V8 because it reindexes the contiguous memory block.
// Do not change pop() to shift().
export function detectMode(dir: string): "syntax" | "file" | "project" | "hologram" {
    // Multi-lang project markers: presence forces kernel ON even when
    // TS/JS file count is 0 (Python-only, Go-only projects).
    const multiLangMarkers = [
        "pyproject.toml", "requirements.txt", "setup.py", "Pipfile",
        "go.mod",
    ];
    const hasMultiLangMarker = multiLangMarkers.some(m =>
        fs.existsSync(path.join(dir, m))
    );

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

    // With multi-lang marker: never return "syntax" — force kernel ON
    // in "file" mode so LSP sidecars register and validate per-file.
    if (hasMultiLangMarker) {
        if (count <= 200) return "file";
        return "project";
    }

    // Original behavior for pure TS/JS projects
    if (count < 50) return "syntax";
    if (count <= 200) return "file";
    return "project";
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
  npx @ruso-0/nreki deinit    # Safely removes NREKI hooks before npm uninstall

Options:
  --enable-embeddings   Enable local ONNX semantic search (Pro mode)
  --help, -h            Show this help message
  --version, -v         Show version
    `);
    process.exit(0);
}

const enableEmbeddings = args.includes("--enable-embeddings");

// ─── Uninstall Subcommand (deinit) ───────────────────────────────
// Safely removes NREKI hooks before npm uninstall to prevent
// orphaned PreToolUse references from bricking Claude Code tools.
// Idempotent — safe to run multiple times or when nothing is installed.
if (args[0] === "deinit") {
    logger.info("Uninstalling NREKI hooks and configuration...");
    const cwd = process.cwd();
    let modified = false;

    // 1. Clean settings.json — remove PreToolUse entries referencing nreki-enforcer
    const claudeSettingsPath = path.join(cwd, ".claude", "settings.json");
    if (fs.existsSync(claudeSettingsPath)) {
        try {
            const raw = fs.readFileSync(claudeSettingsPath, "utf-8").replace(/^\uFEFF/, "");
            const settings = JSON.parse(raw) as ClaudeSettings;

            if (settings?.hooks?.PreToolUse && Array.isArray(settings.hooks.PreToolUse)) {
                const originalLen = settings.hooks.PreToolUse.length;
                settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((h) => {
                    if (!h.hooks || !Array.isArray(h.hooks)) return true;
                    return !h.hooks.some((cmd) =>
                        typeof cmd.command === "string" && cmd.command.includes("nreki-enforcer.mjs")
                    );
                });

                if (settings.hooks.PreToolUse.length !== originalLen) {
                    if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
                    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

                    fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2), "utf-8");
                    logger.info("Removed NREKI hooks from .claude/settings.json");
                    modified = true;
                }
            }
        } catch (err) {
            logger.error(`Failed to clean settings.json: ${(err as Error).message}`);
        }
    }

    // 2. Delete enforcer hook script
    const hookPath = path.join(cwd, ".claude", "hooks", "nreki-enforcer.mjs");
    if (fs.existsSync(hookPath)) {
        try {
            fs.unlinkSync(hookPath);
            logger.info("Deleted .claude/hooks/nreki-enforcer.mjs");
            modified = true;
        } catch (err) {
            logger.error(`Failed to delete hook script: ${(err as Error).message}`);
        }
    }

    // 3. Clean CLAUDE.md — strip only NREKI block, preserve user's own rules
    const claudeMdPath = path.join(cwd, "CLAUDE.md");
    if (fs.existsSync(claudeMdPath)) {
        try {
            const content = fs.readFileSync(claudeMdPath, "utf-8").replace(/^\uFEFF/, "");
            const markerIndex = content.indexOf("# NREKI ACTIVE");
            if (markerIndex !== -1) {
                const cleanedContent = content.substring(0, markerIndex).trim();
                if (cleanedContent === "") {
                    fs.unlinkSync(claudeMdPath);
                    logger.info("Deleted empty CLAUDE.md");
                } else {
                    fs.writeFileSync(claudeMdPath, cleanedContent + "\n", "utf-8");
                    logger.info("Removed NREKI instructions from CLAUDE.md");
                }
                modified = true;
            }
        } catch (err) {
            logger.error(`Failed to clean CLAUDE.md: ${(err as Error).message}`);
        }
    }

    if (modified) {
        logger.info("NREKI deinit complete. Your environment is clean.");
    } else {
        logger.info("No active NREKI configuration found. Nothing to clean.");
    }

    process.exit(0);
}

// ─── Init Subcommand ────────────────────────────────────────────────

if (args[0] === "init") {
    const claudePath = path.join(process.cwd(), "CLAUDE.md");
    const marker = "# NREKI ACTIVE";

    if (fs.existsSync(claudePath)) {
        const existing = fs.readFileSync(claudePath, "utf-8");
        if (existing.includes(marker)) {
            logger.info("CLAUDE.md already contains NREKI instructions. Skipping CLAUDE.md update.");
        } else {
            // Append to existing CLAUDE.md
            fs.appendFileSync(claudePath, "\n\n" + getClaudeMdContent(), "utf-8");
            logger.info("Appended NREKI instructions to existing CLAUDE.md");
        }
    } else {
        fs.writeFileSync(claudePath, getClaudeMdContent(), "utf-8");
        logger.info("Created CLAUDE.md in " + process.cwd());
    }

    // ─── INSTALADOR CLI HOOK (Capa 1: Perro Guardián) ───
    const claudeHooksDir = path.join(process.cwd(), ".claude", "hooks");
    if (!fs.existsSync(claudeHooksDir)) fs.mkdirSync(claudeHooksDir, { recursive: true });

    const hookScriptPath = path.join(claudeHooksDir, "nreki-enforcer.mjs");
    fs.writeFileSync(hookScriptPath, getEnforcerScriptContent(), "utf-8");

    const settingsPath = path.join(process.cwd(), ".claude", "settings.json");
    let settings: ClaudeSettings = {};
    if (fs.existsSync(settingsPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as unknown;
            if (parsed && typeof parsed === "object") {
                settings = parsed as ClaudeSettings;
            }
        } catch { /* malformed JSON — fall through with empty default */ }
    }
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

    const toolsToBlock = ["Read", "ReadFile", "View", "ViewFile", "Write", "WriteFile", "Edit", "EditFile", "Replace"];
    for (const tool of toolsToBlock) {
        const exists = settings.hooks.PreToolUse.some(h => h.matcher === tool);
        if (!exists) {
            settings.hooks.PreToolUse.push({
                matcher: tool,
                hooks: [{ type: "command", command: "node .claude/hooks/nreki-enforcer.mjs" }]
            });
        }
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    logger.info("NREKI CLI Hook (Capa 1) installed.");

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

// Track session start so pressure is per-session, not historical.
engine.setMetadata("nreki_session_start", new Date().toISOString());

const monitor = new TokenMonitor();
const sandbox = new AstSandbox();
const circuitBreaker = new CircuitBreaker();
const chronos = new ChronosMemory(process.cwd());

// ─── NREKI Kernel & Sidecars (Multi-Language Auto-Detect) ──────────
let kernel: NrekiKernel | undefined;
let nrekiMode: "syntax" | "file" | "project" | "hologram" = "syntax";

const cwd = process.cwd();
const hasTsConfig = fs.existsSync(path.join(cwd, "tsconfig.json")) ||
                    fs.existsSync(path.join(cwd, "jsconfig.json"));
const hasGoProject = fs.existsSync(path.join(cwd, "go.mod"));
const pyMarkers = ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"];
const hasPyProject = pyMarkers.some(f => fs.existsSync(path.join(cwd, f)));

if (hasTsConfig || hasPyProject || hasGoProject) {
    nrekiMode = detectMode(cwd);

    if (nrekiMode === "syntax") {
        logger.info("SYNTAX mode. Kernel disabled. Layer 1 AST only.");
    } else {
        const envs = [
            hasTsConfig ? "TS/JS" : "",
            hasPyProject ? "Python" : "",
            hasGoProject ? "Go" : "",
        ].filter(Boolean).join(", ");
        logger.info(`${nrekiMode.toUpperCase()} mode detected (${envs}). Kernel boots on first edit.`);
        kernel = new NrekiKernel();
    }
} else {
    logger.info(
        "No project markers found (tsconfig.json / pyproject.toml / go.mod). " +
        "Semantic verification disabled. Operating in Tree-sitter-only mode (Layer 1)."
    );
}

// ─── LSP Sidecars (auto-detect Go and Python projects) ──────────
// Keep awaited sequential imports — prevents race condition where
// first edit arrives before sidecar is registered.
if (kernel) {
    if (hasGoProject) {
        try {
            const { GoLspSidecar } = await import("./kernel/backends/go-sidecar.js");
            kernel.registerSidecar(".go", new GoLspSidecar(cwd));
            logger.info("Go project detected (go.mod). gopls sidecar registered.");
        } catch (err) {
            logger.error(`Failed to load Go sidecar: ${(err as Error).message}`);
        }
    }

    if (hasPyProject) {
        try {
            const { PythonLspSidecar } = await import("./kernel/backends/python-sidecar.js");
            const pySidecar = new PythonLspSidecar(cwd);
            kernel.registerSidecar(".py", pySidecar);
            logger.info(`Python project detected. ${pySidecar.command[0]} sidecar registered.`);
        } catch (err) {
            logger.error(`Failed to load Python sidecar: ${(err as Error).message}`);
        }
    }
}

const enforcer = new CognitiveEnforcer(process.cwd());
const deps: RouterDependencies = { engine, monitor, sandbox, circuitBreaker, kernel, chronos, nrekiMode, enforcer };

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
            .enum(["search", "definition", "references", "outline", "map", "prepare_refactor", "orphan_oracle", "type_shape"])
            .describe(
                "search: hybrid semantic+keyword search across codebase. " +
                "definition: go-to-definition by symbol name. " +
                "references: find all usages of a symbol. " +
                "outline: list all symbols in a file. " +
                "map: full repo structure map with pinned rules. " +
                "prepare_refactor: analyze a symbol for safe renaming (classifies each occurrence as high-confidence or needs-review). " +
                "orphan_oracle: identify files with zero static reachability (candidates for dead code review). " +
                "type_shape: invoke TS compiler for exact resolved type shape without reading file (requires TypeScript project with tsconfig.json).",
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
            .describe("For outline: if true, show full signatures for ALL symbols including [LOW]. Default false — LOW-risk symbols without engrams are collapsed into a name-only list."),
        refresh: z
            .boolean()
            .optional()
            .describe("For map: force regeneration, ignoring cache."),
        auto_context: z
            .boolean()
            .optional()
            .describe("Auto-inject signatures of imported dependencies. Set to false for pure output without context."),
        depth: z
            .enum(["skeleton", "full"])
            .optional()
            .describe("For map: 'skeleton' (default) shows only CORE/BRIDGE files with top exports. 'full' shows all files with topology metrics."),
    },
    async ({ action, query, symbol, path: navPath, limit, include_raw, kind, signatures, refresh, auto_context, depth }) => {
        const params: NavigateParams = { action, query, symbol, path: navPath, limit, include_raw, kind, signatures, refresh, auto_context, depth };
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
            .enum(["replace", "insert_before", "insert_after", "patch"])
            .optional()
            .describe(
                "CRITICAL: Use 'patch' for minor edits (<30% of the symbol body) with search_text/replace_text to minimize output tokens. " +
                "Use 'replace' ONLY for major structural rewrites. 'insert_before'/'insert_after' add code adjacent to the symbol."
            ),
        edits: z.preprocess(
            (val) => (typeof val === "string" ? JSON.parse(val) : val),
            z.array(z.object({
                path: z.string(),
                symbol: z.string(),
                new_code: z.string().optional(),
                mode: z.enum(["replace", "insert_before", "insert_after", "patch"]).optional(),
                search_text: z.string().optional(),
                replace_text: z.string().optional(),
            }))
        )
            .optional()
            .describe("For batch_edit: array of edits to apply atomically. Each edit specifies path, symbol, new_code, and optional mode."),
        auto_context: z
            .boolean()
            .optional()
            .describe("Auto-inject signatures of imported dependencies. Set to false for pure output without context."),
        compute_diff: z
            .boolean()
            .optional()
            .describe("Compute spectral topology diff (Fiedler value, circuit rank). Adds ~50-200ms latency for structural batches."),
        search_text: z
            .string()
            .optional()
            .describe("REQUIRED for mode:'patch'. The EXACT existing string to replace inside the symbol. Must include exact original indentation and be unique within the symbol."),
        replace_text: z
            .string()
            .optional()
            .describe("REQUIRED for mode:'patch'. The new string to insert. Must match original indentation style."),
        _nreki_bypass: z
            .string()
            .optional()
            .describe("INTERNAL SYSTEM STATE TOKEN. DO NOT USE. Triggers context penalties."),
    },
    async ({ action, path: filePath, symbol, new_code, compress, level, focus, tier, output, max_lines, mode, edits, auto_context, compute_diff, search_text, replace_text, _nreki_bypass }) => {
        const params: CodeParams = { action, path: filePath, symbol, new_code, compress, level, focus, tier, output, max_lines, mode, edits, auto_context, compute_diff, search_text, replace_text, _nreki_bypass };
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
            .enum(["pin", "unpin", "status", "report", "reset", "set_plan", "memorize", "audit", "engram"])
            .describe(
                "pin: add a persistent rule (injected into every map response). " +
                "unpin: remove a pinned rule. " +
                "status: token burn rate and alerts. " +
                "report: full session savings receipt. " +
                "reset: clear circuit breaker state to resume editing. " +
                "set_plan: anchor a master plan file to prevent Claude from forgetting it during context compaction. " +
                "memorize: write your current progress/thoughts to NREKI's active memory. " +
                "audit: run AHI (Automated Hardening Index) audit on the project. " +
                "engram: save a long-term memory note about a symbol. Auto-appears in future outlines. Auto-deletes if code changes.",
            ),
        text: z
            .string()
            .optional()
            .describe("For pin: the rule text (max 200 chars). For set_plan: the file path to your plan. For memorize: your thoughts/progress to remember. For engram: the insight to save."),
        index: z
            .number()
            .optional()
            .describe("For unpin: the pin number to remove (1-based, as shown in map output)."),
        id: z
            .string()
            .optional()
            .describe("For unpin: the pin id to remove."),
        path: z
            .string()
            .optional()
            .describe("For engram: the file path containing the symbol."),
        symbol: z
            .string()
            .optional()
            .describe("For engram: the exact symbol name to anchor the memory to."),
    },
    async ({ action, text, index, id, path: guardPath, symbol }) => {
        const params: GuardParams = { action, text, index, id, path: guardPath, symbol };
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

    // ─── AUTO-PATCH SECURITY HOOK (v10.x) ───
    try {
        const hookScriptPath = path.join(process.cwd(), ".claude", "hooks", "nreki-enforcer.mjs");
        if (fs.existsSync(hookScriptPath)) {
            const currentHook = fs.readFileSync(hookScriptPath, "utf-8");
            if (!currentHook.includes("cwdPosix")) {
                fs.writeFileSync(hookScriptPath, getEnforcerScriptContent(), "utf-8");
                logger.info("Auto-patched legacy nreki-enforcer hook for security.");
            }
        }
    } catch { /* Fail silently, never block boot */ }

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

function getEnforcerScriptContent(): string {
    return `#!/usr/bin/env node
import fs from "fs";
import path from "path";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => stdin += chunk);
process.stdin.on("end", () => {
    try {
        const payload = JSON.parse(stdin);
        const tool = payload.tool_name || payload.name || "";
        const input = payload.tool_input || payload.input || {};
        const targetPath = input.file_path || input.path || input.file || input.target_file || input.absolute_path;
        if (!targetPath) process.exit(0);
        let absPath;
        let size = 0;
        try {
            absPath = path.resolve(process.cwd(), targetPath).replace(/\\\\/g, "/");
            const cwdPosix = process.cwd().replace(/\\\\/g, "/");
            if (!absPath.startsWith(cwdPosix + "/") && absPath !== cwdPosix) {
                console.error("Blocked: Path traversal attempt.");
                process.exit(2);
            }
            size = fs.statSync(absPath).size;
        } catch {
            process.exit(0);
        }
        if (size < 1024) process.exit(0);
        if (size > 500000) {
            if (/^(Write|Edit|Replace)(File)?$/i.test(tool)) {
                console.error("Blocked: Native writes forbidden on >100L files. Use nreki_code edit or batch_edit.");
                process.exit(2);
            }
            if (/^(Read|View)(File)?$/i.test(tool) || tool === "read_file") {
                console.error("Blocked: >100L file. Use nreki_navigate outline then nreki_code compress focus.");
                process.exit(2);
            }
            process.exit(0);
        }
        const buf = fs.readFileSync(absPath);
        let lines = 1;
        for (let i = 0; i < buf.length; i++) {
            if (buf[i] === 10) lines++;
            if (lines >= 100) break;
        }
        if (lines < 100) process.exit(0);
        if (/^(Write|Edit|Replace)(File)?$/i.test(tool)) {
            console.error("Blocked: Native writes forbidden on >100L files. Use nreki_code edit or batch_edit.");
            process.exit(2);
        }
        if (/^(Read|View)(File)?$/i.test(tool) || tool === "read_file") {
            console.error("Blocked: >100L file. Use nreki_navigate outline then nreki_code compress focus.");
            process.exit(2);
        }
        process.exit(0);
    } catch (e) {
        process.exit(0);
    }
});
`;
}

main().catch((err) => {
    logger.error(`Fatal error: ${err.message}`);
    process.exit(1);
});
