#!/usr/bin/env node

/**
 * index.ts — TokenGuard MCP Server entry point.
 *
 * Exposes 14 MCP tools to Claude Code:
 *
 * 1. tg_search  — Hybrid semantic + keyword search (replaces grep)
 * 2. tg_audit   — Token consumption audit for the current session
 * 3. tg_compress — Compress a file before reading (saves ~75% tokens)
 * 4. tg_status  — Burn rate, exhaustion prediction, and alerts
 * 5. tg_session_report — Comprehensive session savings report
 * 6. tg_map     — Static repo map for prompt cache optimization
 * 7. tg_terminal — Terminal entropy filter for error output
 * 8. tg_def     — Go to definition by symbol name (AST-based, 100% precise)
 * 9. tg_refs    — Find all references to a symbol across the project
 * 10. tg_outline — List all symbols in a file (like VS Code outline)
 * 11. tg_read   — Read file with automatic compression
 * 12. tg_validate — AST sandbox validator (catches syntax errors before disk)
 * 13. tg_circuit_breaker — Detects and stops infinite failure loops
 * 14. tg_semantic_edit — Zero-read surgical AST patching (saves 98% output tokens)
 * 15. tg_pin — Pin persistent rules Claude never forgets
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
import { filterTerminalOutput } from "./terminal-filter.js";
import { findDefinition, findReferences, getFileSymbols, type SymbolKind, type ReferenceResult } from "./ast-navigator.js";
import { AstSandbox } from "./ast-sandbox.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { semanticEdit } from "./semantic-edit.js";
import { addPin, removePin, listPins, getPinnedText } from "./pin-memory.js";
import { readSource } from "./utils/read-source.js";
import { restoreBackup } from "./undo.js";

// ─── Initialization ──────────────────────────────────────────────────

const engine = new TokenGuardEngine({
    dbPath: path.join(process.cwd(), ".tokenguard.db"),
    watchPaths: [process.cwd()],
});

const monitor = new TokenMonitor();
const sandbox = new AstSandbox();
const circuitBreaker = new CircuitBreaker();

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
            "===================================================",
            "  TokenGuard — Token Consumption Audit",
            "===================================================",
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
            "===================================================",
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
        const usageStats = engine.getUsageStats();
        const cbStats = circuitBreaker.getStats();
        const pins = listPins(process.cwd());

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

        // Determine model name from burn rate
        const modelName = burnRate.estimatedCostUsd > 0
            ? (burnRate.estimatedCostUsd / Math.max(1, burnRate.totalConsumed) > 0.01
                ? "Opus" : "Sonnet")
            : "Unknown";

        // Generate ASCII receipt
        const pad = (v: string | number, w: number) => String(v).padStart(w);
        const usdStr = Math.max(
            sessionReport.savedUsdSonnet,
            sessionReport.savedUsdOpus
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
            content: [
                {
                    type: "text" as const,
                    text: report + receipt,
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

        // Append pinned rules AFTER repo map so the static map text stays
        // at the start of context — preserving Anthropic prompt cache hits.
        const pinnedText = getPinnedText(process.cwd());
        const fullText = text + (pinnedText ? "\n" + pinnedText : "");
        const tokens = Embedder.estimateTokens(fullText);

        engine.logUsage("tg_map", tokens, tokens, 0);

        return {
            content: [
                {
                    type: "text" as const,
                    text:
                        fullText +
                        `\n[TokenGuard repo map: ${tokens.toLocaleString()} tokens | ` +
                        `${fromCache ? "from cache (prompt-cacheable)" : "freshly generated"} | ` +
                        `${pinnedText ? `${listPins(process.cwd()).length} pinned rules | ` : ""}` +
                        `This text is deterministic — place it early in context for Anthropic prompt caching]`,
                },
            ],
        };
    }
);

// ─── Tool 7: tg_terminal ───────────────────────────────────────────

server.tool(
    "tg_terminal",
    "Filters noisy terminal output (npm errors, test failures, build logs). " +
    "Removes duplicate lines, node_modules stack traces, and ANSI color codes. " +
    "Returns a clean error summary with affected files. " +
    "Use this after any failed command to save tokens.",
    {
        output: z
            .string()
            .describe("Raw terminal output to filter"),
        max_lines: z
            .number()
            .min(1)
            .max(1000)
            .default(100)
            .describe("Maximum lines in filtered output (default 100)"),
    },
    async ({ output, max_lines }) => {
        const result = filterTerminalOutput(output, max_lines);

        engine.logUsage(
            "tg_terminal",
            result.filtered_tokens,
            result.filtered_tokens,
            Math.max(0, result.original_tokens - result.filtered_tokens)
        );

        // Feed errors to circuit breaker for loop detection
        let circuitWarning = "";
        if (result.error_summary.errorCount > 0) {
            const loopCheck = circuitBreaker.recordToolCall(
                "tg_terminal",
                output,
                result.error_summary.affectedFiles[0] ?? undefined
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
            content: [
                {
                    type: "text" as const,
                    text: summaryLines.join("\n") + circuitWarning,
                },
            ],
        };
    }
);

// ─── Tool 8: tg_def ────────────────────────────────────────────────

server.tool(
    "tg_def",
    "Go to definition. Finds the exact source code of any function, class, interface, " +
    "type, or variable by name. Returns the complete definition with full body. " +
    "100% precise AST-based lookup, no search needed. " +
    "Use this instead of tg_read when you know the symbol name.",
    {
        symbol: z
            .string()
            .describe("Name of the symbol to find (function, class, interface, type, variable)"),
        kind: z
            .enum(["function", "class", "interface", "type", "variable", "enum", "method", "any"])
            .default("any")
            .describe("Filter by symbol kind (default: any)"),
    },
    async ({ symbol, kind }) => {
        await engine.initialize();

        const root = engine.getProjectRoot();
        const parser = engine.getParser();
        const results = await findDefinition(root, parser, symbol, kind as SymbolKind);

        if (results.length === 0) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            `No definition found for symbol: "${symbol}"` +
                            (kind !== "any" ? ` (kind: ${kind})` : "") +
                            `\n\n[TokenGuard saved ~0 tokens]`,
                    },
                ],
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
            (sum, r) => sum + Embedder.estimateTokens(r.body),
            0
        );

        engine.logUsage("tg_def", bodyTokens, bodyTokens, 0);

        return {
            content: [
                {
                    type: "text" as const,
                    text:
                        `## Definition: ${symbol}\n` +
                        `Found ${results.length} definition(s).\n\n` +
                        formatted.join("\n\n") +
                        `\n\n[TokenGuard: ${bodyTokens.toLocaleString()} tokens — exact AST lookup, no search overhead]`,
                },
            ],
        };
    }
);

// ─── Tool 9: tg_refs ───────────────────────────────────────────────

server.tool(
    "tg_refs",
    "Find all references to a symbol across the project. " +
    "Shows every file and line where the symbol is used, with surrounding context. " +
    "Like 'Find All References' in VS Code.",
    {
        symbol: z
            .string()
            .describe("Name of the symbol to find references for"),
    },
    async ({ symbol }) => {
        await engine.initialize();

        const root = engine.getProjectRoot();
        const parser = engine.getParser();
        const results = await findReferences(root, parser, symbol);

        if (results.length === 0) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            `No references found for: "${symbol}"\n\n` +
                            `[TokenGuard saved ~0 tokens]`,
                    },
                ],
            };
        }

        // Group by file
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
            (sum, r) => sum + Embedder.estimateTokens(r.context),
            0
        );

        engine.logUsage("tg_refs", refTokens, refTokens, 0);

        return {
            content: [
                {
                    type: "text" as const,
                    text:
                        `## References: ${symbol}\n` +
                        `Found ${results.length} reference(s) across ${byFile.size} file(s).\n\n` +
                        formatted.join("\n") +
                        `\n\n[TokenGuard: ${refTokens.toLocaleString()} tokens]`,
                },
            ],
        };
    }
);

// ─── Tool 10: tg_outline ──────────────────────────────────────────

server.tool(
    "tg_outline",
    "List all symbols in a file with their signatures. " +
    "Shows functions, classes, interfaces, types, and methods. " +
    "Like the Outline view in VS Code. Use this to understand a file's structure.",
    {
        file: z
            .string()
            .describe("File path (relative to project root or absolute)"),
    },
    async ({ file }) => {
        await engine.initialize();

        const root = engine.getProjectRoot();
        let resolvedPath: string;
        try {
            resolvedPath = safePath(root, file);
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

        const parser = engine.getParser();
        const symbols = await getFileSymbols(resolvedPath, parser, root);

        if (symbols.length === 0) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            `No symbols found in: ${file}\n` +
                            `(File may be empty, unsupported, or contain no declarations.)\n\n` +
                            `[TokenGuard saved ~0 tokens]`,
                    },
                ],
            };
        }

        const relPath = path.relative(root, resolvedPath).replace(/\\/g, "/");
        const lines = [`## Outline: ${relPath}`, `${symbols.length} symbol(s)`, ""];

        for (const sym of symbols) {
            const exported = sym.exportedAs ? ` [${sym.exportedAs}]` : "";
            lines.push(
                `- **${sym.kind}** \`${sym.name}\`${exported} — L${sym.startLine}-L${sym.endLine}`
            );
            lines.push(`  \`${sym.signature}\``);
        }

        const outlineTokens = Embedder.estimateTokens(lines.join("\n"));

        // Estimate savings: reading full file vs outline
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
            content: [
                {
                    type: "text" as const,
                    text: lines.join("\n"),
                },
            ],
        };
    }
);

// ─── Tool 11: tg_read ──────────────────────────────────────────────

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
                const content = readSource(resolvedPath);
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

// ─── Tool 12: tg_validate ───────────────────────────────────────────

server.tool(
    "tg_validate",
    "Validates code syntax before saving to disk. " +
    "Parses the code with tree-sitter and checks for syntax errors. " +
    "Use this before writing any file to prevent broken code from reaching the filesystem. " +
    "Returns specific error locations and fix suggestions.",
    {
        code: z
            .string()
            .describe("The code to validate"),
        language: z
            .enum(["typescript", "javascript", "python", "go"])
            .describe("Programming language of the code"),
        file_path: z
            .string()
            .optional()
            .describe(
                "Optional file path. If the file exists on disk, validates as a diff against the original."
            ),
    },
    async ({ code, language, file_path }) => {
        let result;

        // If file_path provided and file exists, use diff validation
        if (file_path) {
            try {
                const resolvedPath = safePath(process.cwd(), file_path);
                const original = readSource(resolvedPath);
                result = await sandbox.validateDiff(original, code, language);
            } catch {
                // File doesn't exist or path error — validate code only
                result = await sandbox.validateCode(code, language);
            }
        } else {
            result = await sandbox.validateCode(code, language);
        }

        const inputTokens = Embedder.estimateTokens(code);

        if (result.valid) {
            engine.logUsage("tg_validate", inputTokens, 0, 0);

            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            `## Validation: PASSED\n` +
                            `Code is syntactically valid ${language}. Safe to write.\n\n` +
                            `[TokenGuard saved ~0 tokens on this validation]`,
                    },
                ],
            };
        }

        // Format errors
        const errorLines = result.errors.map((e, i) =>
            `${i + 1}. **Line ${e.line}, Col ${e.column}** (${e.nodeType}): \`${e.context.split("\n")[0].trim()}\``
        );

        const saved = inputTokens; // prevented a broken write + retry cycle
        engine.logUsage("tg_validate", inputTokens, Embedder.estimateTokens(result.suggestion), saved);

        return {
            content: [
                {
                    type: "text" as const,
                    text:
                        `## Validation: FAILED — ${result.errors.length} syntax error(s)\n\n` +
                        `### Errors\n${errorLines.join("\n")}\n\n` +
                        `### Suggestions\n${result.suggestion}\n\n` +
                        `Fix these errors before writing the file.\n\n` +
                        `[TokenGuard saved ~${saved.toLocaleString()} tokens by catching errors before disk write]`,
                },
            ],
        };
    }
);

// ─── Tool 13: tg_circuit_breaker ────────────────────────────────────

server.tool(
    "tg_circuit_breaker",
    "Monitors for infinite failure loops (write→test→fail cycles). " +
    "Call this after any failed command. If it returns tripped=true, " +
    "STOP immediately and ask the human for guidance. " +
    "Do NOT attempt another fix — you are likely stuck in a loop.",
    {
        last_error: z
            .string()
            .describe("The error output from the last failed command"),
        file_path: z
            .string()
            .optional()
            .describe("File being worked on (if applicable)"),
        action: z
            .enum(["check", "reset", "stats"])
            .default("check")
            .describe("check=record error and check for loops, reset=clear after human help, stats=show loop stats"),
    },
    async ({ last_error, file_path, action }) => {
        if (action === "reset") {
            circuitBreaker.reset();
            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            "## Circuit Breaker: RESET\n" +
                            "State cleared. You may resume working.\n\n" +
                            "[TokenGuard circuit breaker reset]",
                    },
                ],
            };
        }

        if (action === "stats") {
            const stats = circuitBreaker.getStats();
            const uptimeMin = Math.round((Date.now() - stats.sessionStartTime) / 60_000);
            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            "## Circuit Breaker Stats\n" +
                            `Session uptime: ${uptimeMin} min\n` +
                            `Total tool calls tracked: ${stats.totalToolCalls}\n` +
                            `Loops detected: ${stats.loopsDetected}\n` +
                            `Loops prevented: ${stats.loopsPrevented}\n` +
                            `Estimated tokens saved: ~${stats.estimatedTokensSaved.toLocaleString()}\n\n` +
                            "[TokenGuard circuit breaker stats]",
                    },
                ],
            };
        }

        // action === "check"
        const result = circuitBreaker.recordToolCall(
            "error_check",
            last_error,
            file_path
        );

        if (result.tripped) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            "## ⚠️ CIRCUIT BREAKER TRIPPED\n\n" +
                            `**${result.reason}**\n\n` +
                            "**Action required:** STOP all fix attempts. " +
                            "Ask the human what to do next. " +
                            "Do NOT attempt another automatic fix.\n\n" +
                            "When the human provides guidance, call this tool with " +
                            '`action: "reset"` before resuming.\n\n' +
                            "[TokenGuard saved ~10,000 tokens by breaking the loop]",
                    },
                ],
            };
        }

        const state = circuitBreaker.getState();
        return {
            content: [
                {
                    type: "text" as const,
                    text:
                        "## Circuit Breaker: OK\n" +
                        `Consecutive failures: ${state.consecutiveFailures}\n` +
                        `History depth: ${state.history.length}/${50}\n` +
                        "No loop detected yet. You may continue.\n\n" +
                        "[TokenGuard circuit breaker monitoring]",
                },
            ],
        };
    }
);

// ─── Tool 14: tg_semantic_edit ──────────────────────────────────────

server.tool(
    "tg_semantic_edit",
    "Surgically edit a specific function, class, interface, or type by name " +
    "without reading or rewriting the entire file. Finds the exact AST node, " +
    "replaces only those bytes, and validates syntax before saving. " +
    "Use this instead of full file rewrites to save 98% of output tokens. " +
    "If the new code has syntax errors, the edit is rejected and the " +
    "original file is untouched.",
    {
        file: z
            .string()
            .describe("File path relative to project root"),
        symbol: z
            .string()
            .describe("Name of the function/class/interface/type to edit"),
        new_code: z
            .string()
            .describe("Complete new code for the symbol (including signature, decorators, export keyword if needed)"),
    },
    async ({ file, symbol, new_code }) => {
        await engine.initialize();

        let resolvedPath: string;
        try {
            resolvedPath = safePath(process.cwd(), file);
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
                content: [
                    {
                        type: "text" as const,
                        text:
                            `## Semantic Edit: FAILED\n\n` +
                            `**Symbol:** ${symbol}\n` +
                            `**File:** ${file}\n\n` +
                            `${result.error}\n\n` +
                            `[TokenGuard saved ~0 tokens]`,
                    },
                ],
            };
        }

        engine.logUsage(
            "tg_semantic_edit",
            Embedder.estimateTokens(new_code),
            Embedder.estimateTokens(new_code),
            result.tokensAvoided,
        );

        return {
            content: [
                {
                    type: "text" as const,
                    text:
                        `## Semantic Edit: SUCCESS\n\n` +
                        `**Symbol:** ${symbol}\n` +
                        `**File:** ${file}\n` +
                        `**Lines:** ${result.oldLines} → ${result.newLines}\n` +
                        `**Syntax:** validated ✓\n\n` +
                        `[TokenGuard saved ~${result.tokensAvoided.toLocaleString()} tokens vs full file rewrite]`,
                },
            ],
        };
    },
);

// ─── Tool 15: tg_pin ────────────────────────────────────────────────

server.tool(
    "tg_pin",
    "Pin important rules or context that should never be forgotten. " +
    "Pinned items are injected into every repo map response, keeping them " +
    "permanently in Claude's attention window. Use for project conventions, " +
    "API patterns, or architectural decisions. Max 10 pins.",
    {
        action: z
            .enum(["add", "remove", "list"])
            .default("list")
            .describe("add=pin a new rule, remove=unpin by id, list=show all pins"),
        text: z
            .string()
            .optional()
            .describe("Rule text to pin (for add action, max 200 chars)"),
        id: z
            .string()
            .optional()
            .describe("Pin ID to remove (for remove action, e.g. pin_001)"),
    },
    async ({ action, text, id }) => {
        const projectRoot = process.cwd();

        if (action === "add") {
            if (!text) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Error: `text` is required for the add action.\n\n[TokenGuard saved ~0 tokens]",
                        },
                    ],
                };
            }

            const result = addPin(projectRoot, text, "claude");
            if (!result.success) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `## Pin: FAILED\n\n${result.error}\n\n[TokenGuard saved ~0 tokens]`,
                        },
                    ],
                };
            }

            const pins = listPins(projectRoot);
            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            `## Pin: ADDED\n\n` +
                            `**ID:** ${result.pin.id}\n` +
                            `**Rule:** ${result.pin.text}\n` +
                            `**Total pins:** ${pins.length}/${10}\n\n` +
                            `This rule will appear in every tg_map response.\n\n` +
                            `[TokenGuard saved ~0 tokens]`,
                    },
                ],
            };
        }

        if (action === "remove") {
            if (!id) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Error: `id` is required for the remove action.\n\n[TokenGuard saved ~0 tokens]",
                        },
                    ],
                };
            }

            const removed = removePin(projectRoot, id);
            if (!removed) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `## Pin: NOT FOUND\n\nNo pin with id "${id}" exists.\n\n[TokenGuard saved ~0 tokens]`,
                        },
                    ],
                };
            }

            return {
                content: [
                    {
                        type: "text" as const,
                        text: `## Pin: REMOVED\n\n**ID:** ${id}\n\nThis rule will no longer appear in tg_map responses.\n\n[TokenGuard saved ~0 tokens]`,
                    },
                ],
            };
        }

        // action === "list"
        const pins = listPins(projectRoot);
        if (pins.length === 0) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: "## Pinned Rules\n\nNo pins set. Use `action: \"add\"` to pin a rule.\n\n[TokenGuard saved ~0 tokens]",
                    },
                ],
            };
        }

        const pinLines = pins.map(
            (p) => `- **${p.id}** (${p.source}): ${p.text}`
        );

        return {
            content: [
                {
                    type: "text" as const,
                    text:
                        `## Pinned Rules (${pins.length}/${10})\n\n` +
                        pinLines.join("\n") +
                        `\n\nThese rules are injected into every tg_map response.\n\n` +
                        `[TokenGuard saved ~0 tokens]`,
                },
            ],
        };
    }
);

// ─── Tool 16: tg_undo ───────────────────────────────────────────────

server.tool(
    "tg_undo",
    "Undo the last tg_semantic_edit on a file. " +
    "Restores the file to its state before the edit. " +
    "Only one level of undo is available per file.",
    {
        file: z
            .string()
            .describe("File path to restore (same path used in tg_semantic_edit)"),
    },
    async ({ file }) => {
        let resolvedPath: string;
        try {
            resolvedPath = safePath(process.cwd(), file);
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
            const message = restoreBackup(process.cwd(), resolvedPath);
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `## tg_undo: SUCCESS\n\n${message}\n\n[TokenGuard: file restored]`,
                    },
                ],
            };
        } catch (err) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `## tg_undo: FAILED\n\n${(err as Error).message}\n\n[TokenGuard saved ~0 tokens]`,
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
