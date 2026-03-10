#!/usr/bin/env node

/**
 * index.ts — TokenGuard MCP Server entry point.
 *
 * Exposes 4 MCP tools to Claude Code:
 *
 * 1. tg_search  — Hybrid semantic + keyword search (replaces grep)
 * 2. tg_audit   — Token consumption audit for the current session
 * 3. tg_compress — Compress a file before reading (saves ~75% tokens)
 * 4. tg_status  — Burn rate, exhaustion prediction, and alerts
 *
 * Every tool response appends a savings message:
 *   "[TokenGuard saved ~X tokens on this query]"
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "path";

import { TokenGuardEngine } from "./engine.js";
import { TokenMonitor } from "./monitor.js";
import { PreToolUseHook } from "./hooks/preToolUse.js";
import { Embedder } from "./embedder.js";

// ─── Initialization ──────────────────────────────────────────────────

const engine = new TokenGuardEngine({
    dbPath: path.join(process.cwd(), ".tokenguard.db"),
    watchPaths: [process.cwd()],
});

const monitor = new TokenMonitor();
const hook = new PreToolUseHook();

const server = new McpServer({
    name: "TokenGuard",
    version: "1.0.0",
});

// ─── Tool 1: tg_search ──────────────────────────────────────────────

server.tool(
    "tg_search",
    "Semantic hybrid search across the indexed codebase. " +
    "Replaces grep/glob with AST-aware, meaning-based code discovery. " +
    "Uses RRF fusion of vector similarity + BM25 keyword matching. " +
    "Returns compressed shorthand signatures with file locations.",
    {
        query: z
            .string()
            .describe(
                "Natural language or code query. Examples: 'authentication middleware', 'database connection pool', 'handleSubmit function'"
            ),
        limit: z
            .number()
            .min(1)
            .max(50)
            .default(10)
            .describe("Maximum number of results to return (1-50, default 10)"),
        include_raw: z
            .boolean()
            .default(false)
            .describe(
                "Include full raw source code in results (increases token usage)"
            ),
    },
    async ({ query, limit, include_raw }) => {
        await engine.initialize();

        // Index on first search if not already indexed
        const stats = engine.getStats();
        if (stats.filesIndexed === 0) {
            await engine.indexDirectory(process.cwd());
        }

        const results = await engine.search(query, limit);

        if (results.length === 0) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            `No results found for: "${query}"\n\n` +
                            `Indexed ${engine.getStats().filesIndexed} files with ${engine.getStats().totalChunks} chunks.\n` +
                            `Try a broader query or index more directories.\n\n` +
                            `[TokenGuard saved ~0 tokens on this query]`,
                    },
                ],
            };
        }

        // Format results
        const formatted = results.map((r, i) => {
            const header = `### ${i + 1}. ${path.relative(process.cwd(), r.path)}:L${r.startLine}-L${r.endLine}`;
            const shorthand = `\`\`\`\n${r.shorthand}\n\`\`\``;
            const rawSection = include_raw
                ? `\n<details><summary>Full source</summary>\n\n\`\`\`\n${r.rawCode}\n\`\`\`\n</details>`
                : "";
            const score = `Score: ${r.score.toFixed(4)} | Type: ${r.nodeType}`;
            return `${header}\n${shorthand}\n${score}${rawSection}`;
        });

        // Calculate savings: grep would have read all matching files entirely
        const grepEstimate =
            results.reduce(
                (sum, r) => sum + Embedder.estimateTokens(r.rawCode),
                0
            ) * 3; // grep returns surrounding context too
        const searchTokens = results.reduce(
            (sum, r) => sum + Embedder.estimateTokens(r.shorthand),
            0
        );
        const saved = Math.max(0, grepEstimate - searchTokens);

        engine.logUsage("tg_search", searchTokens, searchTokens, saved);

        return {
            content: [
                {
                    type: "text" as const,
                    text:
                        `## TokenGuard Search: "${query}"\n` +
                        `Found ${results.length} results across ${new Set(results.map((r) => r.path)).size} files.\n\n` +
                        formatted.join("\n\n") +
                        `\n\n[TokenGuard saved ~${saved.toLocaleString()} tokens on this query]`,
                },
            ],
        };
    }
);

// ─── Tool 2: tg_audit ───────────────────────────────────────────────

server.tool(
    "tg_audit",
    "Analyze token consumption of the current coding session. " +
    "Shows input/output breakdown, cache efficiency, estimated cost, " +
    "and per-tool usage statistics. Use to understand where tokens are going.",
    {
        since: z
            .string()
            .optional()
            .describe(
                "ISO timestamp to filter usage from (e.g., '2024-01-01T00:00:00Z'). Defaults to all time."
            ),
    },
    async ({ since }) => {
        // Get TokenGuard's internal usage stats
        const internalStats = engine.getUsageStats(since);

        // Get Claude's session-level stats from the monitor
        const burnRate = monitor.computeBurnRate();
        const prediction = monitor.predictExhaustion();

        const report = [
            "═══════════════════════════════════════════════════",
            "  TokenGuard — Token Consumption Audit",
            "═══════════════════════════════════════════════════",
            "",
            "  📊 Session Overview (from Claude usage log):",
            `     Input tokens:    ${burnRate.inputTokens.toLocaleString()}`,
            `     Output tokens:   ${burnRate.outputTokens.toLocaleString()}`,
            `     Cache reads:     ${burnRate.cacheReadTokens.toLocaleString()} (savings from cache)`,
            `     Total consumed:  ${burnRate.totalConsumed.toLocaleString()}`,
            `     API calls:       ${burnRate.apiCalls}`,
            `     Est. cost:       $${burnRate.estimatedCostUsd.toFixed(2)}`,
            "",
            "  🛡️ TokenGuard Savings:",
            `     Tool calls:      ${internalStats.tool_calls}`,
            `     Tokens saved:    ${internalStats.total_saved.toLocaleString()}`,
            `     Input routed:    ${internalStats.total_input.toLocaleString()}`,
            `     Output routed:   ${internalStats.total_output.toLocaleString()}`,
            "",
            "  🔮 Prediction:",
            `     ${prediction.message}`,
            "",
            "  📈 Index Stats:",
            `     Files indexed:   ${engine.getStats().filesIndexed}`,
            `     AST chunks:      ${engine.getStats().totalChunks}`,
            `     Compression:     ${(engine.getStats().compressionRatio * 100).toFixed(1)}%`,
            "═══════════════════════════════════════════════════",
        ].join("\n");

        const saved = Embedder.estimateTokens(report);

        return {
            content: [
                {
                    type: "text" as const,
                    text:
                        report +
                        `\n\n[TokenGuard saved ~${internalStats.total_saved.toLocaleString()} tokens across ${internalStats.tool_calls} tool calls]`,
                },
            ],
        };
    }
);

// ─── Tool 3: tg_compress ────────────────────────────────────────────

server.tool(
    "tg_compress",
    "Compress a source file into shorthand AST notation before reading. " +
    "Reduces token consumption by 30-80% while preserving code structure. " +
    "Three compression tiers: 1=signatures only (max savings), " +
    "2=signatures + key logic, 3=signatures + docs + key logic.",
    {
        file_path: z
            .string()
            .describe(
                "Absolute or relative path to the file to compress. Must be a supported file type (ts, js, py, go)."
            ),
        tier: z
            .number()
            .min(1)
            .max(3)
            .default(1)
            .describe(
                "Compression tier: 1=signatures only (~80% savings), 2=smart body (~50%), 3=with docs (~30%)"
            ),
        focus: z
            .string()
            .optional()
            .describe(
                "Optional focus query to rank chunks by relevance. E.g., 'authentication' will put auth-related code first."
            ),
    },
    async ({ file_path, tier, focus }) => {
        await engine.initialize();

        const resolvedPath = path.resolve(process.cwd(), file_path);

        // Check pre-tool-use hook
        const intercept = hook.evaluateFileRead(resolvedPath);

        try {
            const result = await engine.compressFile(
                resolvedPath,
                tier as 1 | 2 | 3,
                focus
            );

            const saved = result.tokensSaved;
            engine.logUsage(
                "tg_compress",
                Embedder.estimateTokens(result.compressed),
                Embedder.estimateTokens(result.compressed),
                saved
            );

            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            `## TokenGuard Compressed: ${path.basename(resolvedPath)}\n` +
                            `Tier ${tier} | ${result.chunksFound} chunks | ` +
                            `${result.originalSize.toLocaleString()} → ${result.compressedSize.toLocaleString()} chars ` +
                            `(${(result.ratio * 100).toFixed(1)}% reduction)\n\n` +
                            `\`\`\`\n${result.compressed}\n\`\`\`\n\n` +
                            `[TokenGuard saved ~${saved.toLocaleString()} tokens on this query]`,
                    },
                ],
            };
        } catch (err) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Error compressing ${file_path}: ${(err as Error).message}\n\n[TokenGuard saved ~0 tokens on this query]`,
                    },
                ],
            };
        }
    }
);

// ─── Tool 4: tg_status ─────────────────────────────────────────────

server.tool(
    "tg_status",
    "Show current token burn rate, budget prediction, and exhaustion timeline. " +
    "Use before heavy operations to decide if compression is needed. " +
    "Includes per-minute rates, session duration, and alert levels.",
    {},
    async () => {
        const report = monitor.generateReport();
        const prediction = monitor.predictExhaustion();

        // Add index status
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

        // Add recommendations based on alert level
        let recommendations = "";
        if (prediction.alertLevel === "critical") {
            recommendations =
                "\n\n⚠️ RECOMMENDATIONS:\n" +
                "  1. Switch to Tier 1 compression for all file reads\n" +
                "  2. Use tg_search instead of Reading files directly\n" +
                "  3. Minimize output length — emit only patches\n" +
                "  4. Consider starting a new session soon";
        } else if (prediction.alertLevel === "warning") {
            recommendations =
                "\n\n💡 RECOMMENDATIONS:\n" +
                "  1. Use tg_compress for files > 100 lines\n" +
                "  2. Prefer tg_search over grep/glob\n" +
                "  3. Keep responses concise";
        }

        const saved = Embedder.estimateTokens(report + indexSection);

        return {
            content: [
                {
                    type: "text" as const,
                    text:
                        report +
                        indexSection +
                        recommendations +
                        `\n\n[TokenGuard saved ~${saved.toLocaleString()} tokens on this query]`,
                },
            ],
        };
    }
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

    // Pre-initialize engine in background (non-blocking)
    engine.initialize().catch((err) => {
        console.error(`[TokenGuard] Background init error: ${err.message}`);
    });
}

main().catch((err) => {
    console.error(`[TokenGuard] Fatal error: ${err.message}`);
    process.exit(1);
});
