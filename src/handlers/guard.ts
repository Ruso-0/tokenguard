/**
 * handlers/guard.ts - Pure guard handlers (DAG: no circular dependencies).
 *
 * Each handler takes params + deps, returns McpToolResponse.
 * ZERO side effects beyond engine/monitor/circuitBreaker calls.
 * Heartbeat wrapping is the router's responsibility.
 */

import fs from "fs";
import path from "path";
import type { McpToolResponse, GuardParams, RouterDependencies } from "../router.js";
import { Embedder } from "../embedder.js";
import { safePath } from "../utils/path-jail.js";
import { readSource } from "../utils/read-source.js";
import { addPin, removePin, listPins } from "../pin-memory.js";
import { latencyTracker } from "../utils/latency-tracker.js";
import { computeAudit, formatAuditReport } from "../audit.js";

// ─── Pin ────────────────────────────────────────────────────────────

export async function handlePin(
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

    const result = addPin(projectRoot, text, "agent");
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

// ─── Unpin ──────────────────────────────────────────────────────────

export async function handleUnpin(
    params: GuardParams,
    _deps: RouterDependencies,
): Promise<McpToolResponse> {
    const projectRoot = process.cwd();
    const index = typeof params.index === "number" ? params.index : undefined;
    const id = typeof params.id === "string" ? params.id : undefined;

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

// ─── Status ─────────────────────────────────────────────────────────

export async function handleStatus(
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

    const latencySection = [
        "",
        "───────────────────────────────────────────",
        "  ⏱️  Latency (last 200 ops):",
        latencyTracker.getSummary(),
        "───────────────────────────────────────────",
    ].join("\n");

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
                latencySection +
                dangerZones +
                recommendations +
                `\n\n[NREKI saved ~${saved.toLocaleString()} tokens on this query]`,
        }],
    };
}

// ─── Report ─────────────────────────────────────────────────────────

export async function handleReport(
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
        `|  Syntax Errors Blocked:   ${pad(cbStats.loopsDetected, 16)}    |`,
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

// ─── Reset ──────────────────────────────────────────────────────────

export async function handleReset(
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

// ─── Audit ──────────────────────────────────────────────────────────

export async function handleAudit(
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine, kernel, chronos } = deps;
    await engine.initialize();

    const stats = engine.getStats();
    if (stats.filesIndexed === 0) {
        await engine.indexDirectory(process.cwd());
    }

    const graph = await engine.getDependencyGraph();
    const { map } = await engine.getRepoMap();
    const allFiles = map.entries.map(e => e.filePath);
    const projectRoot = engine.getProjectRoot();

    const report = await computeAudit(graph, allFiles, projectRoot, kernel, chronos);
    const text = formatAuditReport(report);

    return {
        content: [{
            type: "text" as const,
            text,
        }],
    };
}

// ─── Set Plan ───────────────────────────────────────────────────────

export async function handleSetPlan(
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

// ─── Memorize ───────────────────────────────────────────────────────

export async function handleMemorize(
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
