/**
 * monitor.ts — Token consumption monitor for TokenGuard.
 *
 * Tracks Claude's token usage by reading JSONL session logs,
 * computes real-time burn rate, and predicts when the context
 * budget will be exhausted. Emits proactive alerts at configurable
 * thresholds so you can adjust strategy before hitting limits.
 */

import fs from "fs";
import path from "path";
import os from "os";

// ─── Types ───────────────────────────────────────────────────────────

export interface UsageEntry {
    timestamp: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    total_cost_usd?: number;
}

export interface BurnRateResult {
    /** Current burn rate in tokens per minute. */
    tokensPerMinute: number;
    /** Current burn rate in tokens per hour. */
    tokensPerHour: number;
    /** Total tokens consumed this session. */
    totalConsumed: number;
    /** Total input tokens. */
    inputTokens: number;
    /** Total output tokens. */
    outputTokens: number;
    /** Total cache read tokens (savings from caching). */
    cacheReadTokens: number;
    /** Estimated cost in USD. */
    estimatedCostUsd: number;
    /** Duration of the session in minutes. */
    sessionDurationMinutes: number;
    /** Number of API calls tracked. */
    apiCalls: number;
}

export interface ExhaustionPrediction {
    /** Estimated minutes until context budget is exhausted. */
    minutesRemaining: number;
    /** Estimated time of exhaustion as ISO string. */
    exhaustionTime: string;
    /** Current usage as a fraction of the budget (0.0 - 1.0). */
    usageFraction: number;
    /** Whether an alert should be triggered. */
    shouldAlert: boolean;
    /** Alert severity: info, warning, critical. */
    alertLevel: "info" | "warning" | "critical" | "none";
    /** Human-readable status message. */
    message: string;
}

export interface MonitorConfig {
    /** Path to Claude's JSONL usage log. Auto-detected if not provided. */
    logPath?: string;
    /** Total token budget for the session. Default: 1_000_000 */
    budgetTokens?: number;
    /** Warning threshold as fraction of budget. Default: 0.7 */
    warningThreshold?: number;
    /** Critical threshold as fraction of budget. Default: 0.9 */
    criticalThreshold?: number;
}

// ─── Constants ───────────────────────────────────────────────────────

/** Default Claude pricing (per 1M tokens) */
const PRICING = {
    input: 3.0, // $3.00 per 1M input tokens
    output: 15.0, // $15.00 per 1M output tokens
    cacheRead: 0.3, // $0.30 per 1M cache read tokens
    cacheWrite: 3.75, // $3.75 per 1M cache write tokens
};

// ─── Monitor ─────────────────────────────────────────────────────────

export class TokenMonitor {
    private entries: UsageEntry[] = [];
    private config: Required<MonitorConfig>;
    private lastReadPosition = 0;

    constructor(config: MonitorConfig = {}) {
        this.config = {
            logPath: config.logPath ?? this.detectLogPath(),
            budgetTokens: config.budgetTokens ?? 1_000_000,
            warningThreshold: config.warningThreshold ?? 0.7,
            criticalThreshold: config.criticalThreshold ?? 0.9,
        };
    }

    // ─── Log Detection ────────────────────────────────────────────

    /**
     * Auto-detect Claude's JSONL usage log path.
     * Checks common locations across operating systems.
     */
    private detectLogPath(): string {
        const home = os.homedir();

        const candidates = [
            // Claude Code / Claude Desktop on macOS
            path.join(home, ".claude", "usage.jsonl"),
            // Claude Code on Linux
            path.join(home, ".config", "claude", "usage.jsonl"),
            // Claude Code on Windows
            path.join(home, "AppData", "Roaming", "claude", "usage.jsonl"),
            // Alternative: local project usage
            path.join(process.cwd(), ".claude", "usage.jsonl"),
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        // Default fallback — will be created if Claude generates it
        return path.join(home, ".claude", "usage.jsonl");
    }

    // ─── Log Reading ──────────────────────────────────────────────

    /**
     * Read and parse the JSONL usage log.
     * Uses incremental reading — only processes new lines since last read.
     */
    readUsageLog(): UsageEntry[] {
        if (!fs.existsSync(this.config.logPath)) {
            return this.entries;
        }

        try {
            const content = fs.readFileSync(this.config.logPath, "utf-8");
            const newContent = content.slice(this.lastReadPosition);

            if (newContent.trim()) {
                const newLines = newContent
                    .split("\n")
                    .filter((line) => line.trim())
                    .map((line) => {
                        try {
                            return JSON.parse(line) as UsageEntry;
                        } catch {
                            return null;
                        }
                    })
                    .filter((entry): entry is UsageEntry => entry !== null);

                this.entries.push(...newLines);
            }

            this.lastReadPosition = content.length;
        } catch (err) {
            console.error(
                `[TokenGuard] Failed to read usage log: ${(err as Error).message}`
            );
        }

        return this.entries;
    }

    // ─── Burn Rate Analysis ───────────────────────────────────────

    /** Calculate the current token burn rate. */
    computeBurnRate(): BurnRateResult {
        this.readUsageLog();

        if (this.entries.length === 0) {
            return {
                tokensPerMinute: 0,
                tokensPerHour: 0,
                totalConsumed: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                estimatedCostUsd: 0,
                sessionDurationMinutes: 0,
                apiCalls: 0,
            };
        }

        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;

        for (const entry of this.entries) {
            inputTokens += entry.input_tokens ?? 0;
            outputTokens += entry.output_tokens ?? 0;
            cacheReadTokens += entry.cache_read_tokens ?? 0;
            cacheWriteTokens += entry.cache_write_tokens ?? 0;
        }

        const totalConsumed = inputTokens + outputTokens;

        // Calculate time span
        const firstTime = new Date(this.entries[0].timestamp).getTime();
        const lastTime = new Date(
            this.entries[this.entries.length - 1].timestamp
        ).getTime();
        const durationMs = Math.max(lastTime - firstTime, 60_000); // At least 1 minute
        const durationMinutes = durationMs / 60_000;

        const tokensPerMinute = totalConsumed / durationMinutes;

        // Estimate cost
        const estimatedCostUsd =
            (inputTokens / 1_000_000) * PRICING.input +
            (outputTokens / 1_000_000) * PRICING.output +
            (cacheReadTokens / 1_000_000) * PRICING.cacheRead +
            (cacheWriteTokens / 1_000_000) * PRICING.cacheWrite;

        return {
            tokensPerMinute: Math.round(tokensPerMinute),
            tokensPerHour: Math.round(tokensPerMinute * 60),
            totalConsumed,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            estimatedCostUsd: Math.round(estimatedCostUsd * 100) / 100,
            sessionDurationMinutes: Math.round(durationMinutes * 10) / 10,
            apiCalls: this.entries.length,
        };
    }

    // ─── Exhaustion Prediction ────────────────────────────────────

    /** Predict when the token budget will be exhausted. */
    predictExhaustion(): ExhaustionPrediction {
        const burnRate = this.computeBurnRate();

        if (burnRate.tokensPerMinute === 0) {
            return {
                minutesRemaining: Infinity,
                exhaustionTime: "N/A — no usage detected",
                usageFraction: 0,
                shouldAlert: false,
                alertLevel: "none",
                message: "📊 No token usage detected yet. Start coding!",
            };
        }

        const remaining = this.config.budgetTokens - burnRate.totalConsumed;
        const minutesRemaining = Math.max(
            0,
            remaining / burnRate.tokensPerMinute
        );
        const exhaustionTime = new Date(
            Date.now() + minutesRemaining * 60_000
        ).toISOString();
        const usageFraction = burnRate.totalConsumed / this.config.budgetTokens;

        // Determine alert level
        let alertLevel: ExhaustionPrediction["alertLevel"] = "none";
        let shouldAlert = false;
        let message = "";

        if (usageFraction >= this.config.criticalThreshold) {
            alertLevel = "critical";
            shouldAlert = true;
            message = `🔴 CRITICAL: ${Math.round(usageFraction * 100)}% of budget consumed! ~${Math.round(minutesRemaining)} min remaining. Switch to Tier 1 compression immediately.`;
        } else if (usageFraction >= this.config.warningThreshold) {
            alertLevel = "warning";
            shouldAlert = true;
            message = `🟡 WARNING: ${Math.round(usageFraction * 100)}% of budget consumed. ~${Math.round(minutesRemaining)} min remaining. Consider using tg_compress for large files.`;
        } else if (usageFraction >= 0.5) {
            alertLevel = "info";
            shouldAlert = false;
            message = `🟢 ${Math.round(usageFraction * 100)}% of budget used. ~${Math.round(minutesRemaining)} min remaining at current pace.`;
        } else {
            alertLevel = "none";
            shouldAlert = false;
            message = `✅ Budget healthy: ${Math.round(usageFraction * 100)}% used. ~${Math.round(minutesRemaining)} min remaining.`;
        }

        return {
            minutesRemaining: Math.round(minutesRemaining),
            exhaustionTime,
            usageFraction: Math.round(usageFraction * 1000) / 1000,
            shouldAlert,
            alertLevel,
            message,
        };
    }

    // ─── Formatted Report ─────────────────────────────────────────

    /** Generate a formatted status report for the tg_status tool. */
    generateReport(): string {
        const burnRate = this.computeBurnRate();
        const prediction = this.predictExhaustion();

        const lines = [
            "===========================================",
            "  TokenGuard -- Session Status Report",
            "===========================================",
            "",
            `  Burn Rate:     ${burnRate.tokensPerMinute.toLocaleString()} tok/min (${burnRate.tokensPerHour.toLocaleString()} tok/hr)`,
            `  Total Used:    ${burnRate.totalConsumed.toLocaleString()} tokens`,
            `  Input:         ${burnRate.inputTokens.toLocaleString()} tokens`,
            `  Output:        ${burnRate.outputTokens.toLocaleString()} tokens`,
            `  Cache Reads:   ${burnRate.cacheReadTokens.toLocaleString()} tokens (saved)`,
            `  Est. Cost:     $${burnRate.estimatedCostUsd.toFixed(2)}`,
            `  Session:       ${burnRate.sessionDurationMinutes} min`,
            `  API Calls:     ${burnRate.apiCalls}`,
            "",
            "-------------------------------------------",
            `  ${prediction.message}`,
            "===========================================",
        ];

        return lines.join("\n");
    }
}
