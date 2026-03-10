#!/usr/bin/env node

/**
 * index.ts — TokenGuard MCP Server entry point.
 *
 * Exposes 7 MCP tools to Claude Code:
 *
 * 1. tg_search  — Hybrid semantic + keyword search (replaces grep)
 * 2. tg_audit   — Token consumption audit for the current session
 * 3. tg_compress — Compress a file before reading (saves ~75% tokens)
 * 4. tg_status  — Burn rate, exhaustion prediction, and alerts
 * 5. tg_session_report — Comprehensive session savings report
 * 6. tg_map     — Static repo map for prompt cache optimization
 * 7. tg_read    — Read file with automatic compression
 *
 * Every tool response appends a savings message:
 *   "[TokenGuard saved ~X tokens on this query]"
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";

import { TokenGuardEngine } from "./engine.js";
import { TokenMonitor } from "./monitor.js";
import { Embedder } from "./embedder.js";
import { safePath } from "./utils/path-jail.js";
import { shouldProcess } from "./utils/file-filter.js";

// ─── Initialization ──────────────────────────────────────────────────

const engine = new TokenGuardEngine({
    dbPath: path.join(process.cwd(), ".tokenguard.db"),
    watchPaths: [process.cwd()],
});

const monitor = new TokenMonitor();

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
    "Compress a source file for token-efficient reading. " +
    "Two modes: classic tiers (1-3) or advanced LLMLingua-2-inspired levels (light/medium/aggressive). " +
    "Advanced mode achieves 50-95% reduction via preprocessing, token filtering, and structural compression.",
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
                "Classic compression tier: 1=signatures only (~80%), 2=smart body (~50%), 3=with docs (~30%). Ignored if compression_level is set."
            ),
        compression_level: z
            .enum(["light", "medium", "aggressive"])
            .optional()
            .describe(
                "Advanced compression level. Overrides tier. light=~50%, medium=~75%, aggressive=~90-95%."
            ),
        focus: z
            .string()
            .optional()
            .describe(
                "Optional focus query to rank chunks by relevance. E.g., 'authentication' will put auth-related code first."
            ),
    },
    async ({ file_path, tier, compression_level, focus }) => {
        await engine.initialize();

        // FIX 1: Path traversal protection
        let resolvedPath: string;
        try {
            resolvedPath = safePath(process.cwd(), file_path);
        } catch (err) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Security error: ${(err as Error).message}\n\n[TokenGuard saved ~0 tokens on this query]`,
                    },
                ],
            };
        }

        try {
            // Advanced compression path
            if (compression_level) {
                const result = await engine.compressFileAdvanced(resolvedPath, compression_level);
                const saved = result.tokensSaved;
                const sessionReport = engine.getSessionReport();

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
                        },
                    ],
                };
            }

            // Classic tier-based compression path (backward compat)
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

// ─── Tool 5: tg_session_report ──────────────────────────────────────

server.tool(
    "tg_session_report",
    "Comprehensive session savings report. Shows total tokens saved, " +
    "estimated USD saved (Sonnet & Opus pricing), per-file-type breakdown, " +
    "burn rate trend, and model switch recommendations.",
    {},
    async () => {
        const sessionReport = engine.getSessionReport();
        const burnRate = monitor.computeBurnRate();
        const prediction = monitor.predictExhaustion();

        const fileTypeRows = sessionReport.byFileType.length > 0
            ? sessionReport.byFileType.map(ft =>
                `  ${ft.ext.padEnd(6)} — ${ft.count} files, ` +
                `avg ${(ft.ratio * 100).toFixed(0)}% compression, ` +
                `${ft.tokensSaved.toLocaleString()} tokens saved`
            ).join("\n")
            : "  (no compressions yet)";

        // Burn rate trend
        let trendMsg = "Stable";
        if (burnRate.tokensPerMinute > 0) {
            trendMsg = burnRate.tokensPerMinute > 3000
                ? "High (consider aggressive compression)"
                : burnRate.tokensPerMinute > 1000
                    ? "Moderate"
                    : "Low (efficient usage)";
        }

        // Model recommendation
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

        const report = [
            "═══════════════════════════════════════════════════",
            "  TokenGuard — Session Report",
            "═══════════════════════════════════════════════════",
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
            "═══════════════════════════════════════════════════",
        ].join("\n");

        return {
            content: [
                {
                    type: "text" as const,
                    text: report,
                },
            ],
        };
    }
);

// ─── Tool 6: tg_map ────────────────────────────────────────────────

server.tool(
    "tg_map",
    "Returns a static repo map with all file signatures, exports, and imports. " +
    "This output is deterministic and cache-friendly — identical text for the same repo state. " +
    "Use this FIRST before reading any files. Acts as a mental map of the entire codebase. " +
    "Enables Anthropic prompt caching ($0.30/M vs $3.00/M input tokens).",
    {
        refresh: z
            .boolean()
            .default(false)
            .describe("Force regenerate the map even if cached version exists"),
    },
    async ({ refresh }) => {
        await engine.initialize();

        // Index on first call if not already indexed
        const stats = engine.getStats();
        if (stats.filesIndexed === 0) {
            await engine.indexDirectory(process.cwd());
        }

        const { text, fromCache } = await engine.getRepoMap(refresh);
        const tokens = Embedder.estimateTokens(text);

        engine.logUsage("tg_map", tokens, tokens, 0);

        return {
            content: [
                {
                    type: "text" as const,
                    text:
                        text +
                        `\n[TokenGuard repo map: ${tokens.toLocaleString()} tokens | ` +
                        `${fromCache ? "from cache (prompt-cacheable)" : "freshly generated"} | ` +
                        `This text is deterministic — place it early in context for Anthropic prompt caching]`,
                },
            ],
        };
    }
);

// ─── Tool 7: tg_read ───────────────────────────────────────────────

server.tool(
    "tg_read",
    "Read a file with automatic TokenGuard compression. " +
    "Drop-in replacement for Read that saves 50-95% tokens. " +
    "Files < 1KB are returned raw (compression overhead not worth it).",
    {
        file_path: z
            .string()
            .describe("Path to the file to read"),
        level: z
            .enum(["light", "medium", "aggressive"])
            .default("medium")
            .describe("Compression level: light=~50%, medium=~75%, aggressive=~90-95%"),
    },
    async ({ file_path, level }) => {
        await engine.initialize();

        // FIX 1: Path traversal protection
        let resolvedPath: string;
        try {
            resolvedPath = safePath(process.cwd(), file_path);
        } catch (err) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Security error: ${(err as Error).message}\n\n[TokenGuard saved ~0 tokens]`,
                    },
                ],
            };
        }

        try {
            const stat = fs.statSync(resolvedPath);

            // FIX 7: File size and extension filter
            const filterResult = shouldProcess(resolvedPath, stat.size);
            if (!filterResult.process) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `File skipped: ${filterResult.reason}\n\n[TokenGuard saved ~0 tokens]`,
                        },
                    ],
                };
            }

            // Skip compression for small files (< 1KB)
            if (stat.size < 1024) {
                const content = fs.readFileSync(resolvedPath, "utf-8");
                return {
                    content: [
                        {
                            type: "text" as const,
                            text:
                                `## ${path.basename(resolvedPath)} (raw — ${stat.size} bytes, below 1KB threshold)\n\n` +
                                `\`\`\`\n${content}\n\`\`\`\n\n` +
                                `[TokenGuard: file too small to compress]`,
                        },
                    ],
                };
            }

            const result = await engine.compressFileAdvanced(resolvedPath, level);
            const saved = result.tokensSaved;

            engine.logUsage(
                "tg_read",
                Embedder.estimateTokens(result.compressed),
                Embedder.estimateTokens(result.compressed),
                saved
            );

            const sessionReport = engine.getSessionReport();

            // For aggressive compression, reference the static repo map
            const mapHint = level === "aggressive"
                ? "See tg_map for full project structure. Showing only the requested code:\n\n"
                : "";

            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            `## ${path.basename(resolvedPath)} (${level} compression)\n` +
                            `${result.originalSize.toLocaleString()} → ${result.compressedSize.toLocaleString()} chars ` +
                            `(${(result.ratio * 100).toFixed(1)}% reduction)\n\n` +
                            mapHint +
                            `\`\`\`\n${result.compressed}\n\`\`\`\n\n` +
                            `[TokenGuard saved ~${saved.toLocaleString()} tokens | ` +
                            `Session: ~${sessionReport.totalTokensSaved.toLocaleString()} tokens saved]`,
                    },
                ],
            };
        } catch (err) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Error reading ${file_path}: ${(err as Error).message}\n\n[TokenGuard saved ~0 tokens]`,
                    },
                ],
            };
        }
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
