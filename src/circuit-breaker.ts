/**
 * circuit-breaker.ts — Detects and stops infinite failure loops.
 *
 * Claude Code often enters loops: write bad code → test → fail → fix →
 * test → fail, repeating 20+ times and burning $5+ in tokens.
 *
 * This module monitors tool call patterns and trips a circuit breaker
 * when it detects:
 *   Pattern 1: Same error hash 3+ times in last 10 calls
 *   Pattern 2: Same file written 5+ times in last 15 calls
 *   Pattern 3: Alternating write→test→fail cycle 3+ times
 */

import crypto from "crypto";

// ─── Types ───────────────────────────────────────────────────────────

export interface ToolCallRecord {
    toolName: string;
    timestamp: number;
    errorHash: string | null;
    filePath: string | null;
}

export interface CircuitBreakerState {
    history: ToolCallRecord[];
    tripped: boolean;
    tripReason: string | null;
    consecutiveFailures: number;
}

export interface LoopCheckResult {
    tripped: boolean;
    reason: string;
}

export interface CircuitBreakerStats {
    totalToolCalls: number;
    loopsDetected: number;
    loopsPrevented: number;
    estimatedTokensSaved: number;
    sessionStartTime: number;
}

// ─── Constants ───────────────────────────────────────────────────────

const MAX_HISTORY = 50;
const SAME_ERROR_THRESHOLD = 3;
const SAME_ERROR_WINDOW = 10;
const SAME_FILE_THRESHOLD = 5;
const SAME_FILE_WINDOW = 15;
const WRITE_TEST_FAIL_THRESHOLD = 3;

// Average tokens burned per failed loop iteration (write + test + read error)
const TOKENS_PER_FAILED_ITERATION = 2000;

// TTL for history entries (5 minutes)
const HISTORY_TTL_MS = 300_000;

// ─── Error Hashing ──────────────────────────────────────────────────

/**
 * Extract a stable hash from error output.
 * Normalizes line numbers and timestamps so that the "same" error
 * (e.g., same type error in different locations) hashes identically.
 */
export function hashError(errorText: string): string {
    // Normalize: strip line/col numbers, timestamps, ANSI codes, addresses
    const normalized = errorText
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")                  // ANSI
        .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "[TIME]")      // ISO timestamps
        .replace(/:\d+:\d+/g, ":[L]:[C]")                        // line:col
        .replace(/line \d+/gi, "line N")                          // "line 42"
        .replace(/\d{13,}/g, "[TS]")                              // epoch timestamps
        .replace(/0x[a-fA-F0-9]+/gi, "[MEM]")                    // memory addresses
        .trim();

    return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Detect if text contains error patterns.
 * Returns true if the text looks like an error output.
 */
export function containsError(text: string): boolean {
    const ERROR_PATTERNS = [
        /error\s+TS\d+/i,
        /^\w*Error:/m,
        /npm\s+(?:ERR!|error)/im,
        /(?:FAIL|✕|×|✗)\s+/,
        /SyntaxError:/,
        /TypeError:/,
        /ReferenceError:/,
        /Cannot find module/,
        /ENOENT/,
        /ExitCode:\s*[1-9]/,
        /Process exited with code [1-9]/,
        /Command failed/i,
        /Build failed/i,
        /Tests?\s+failed/i,
    ];

    return ERROR_PATTERNS.some((re) => re.test(text));
}

// ─── Circuit Breaker ────────────────────────────────────────────────

export class CircuitBreaker {
    private state: CircuitBreakerState = {
        history: [],
        tripped: false,
        tripReason: null,
        consecutiveFailures: 0,
    };

    private stats: CircuitBreakerStats = {
        totalToolCalls: 0,
        loopsDetected: 0,
        loopsPrevented: 0,
        estimatedTokensSaved: 0,
        sessionStartTime: Date.now(),
    };

    /**
     * Record a tool call and check for loop patterns.
     * Returns a LoopCheckResult indicating whether the breaker tripped.
     */
    recordToolCall(
        toolName: string,
        result: string,
        filePath?: string
    ): LoopCheckResult {
        const hasError = containsError(result);
        const errorHash = hasError ? hashError(result) : null;

        const record: ToolCallRecord = {
            toolName,
            timestamp: Date.now(),
            errorHash,
            filePath: filePath ?? null,
        };

        // Ring buffer: keep last MAX_HISTORY entries
        this.state.history.push(record);
        if (this.state.history.length > MAX_HISTORY) {
            this.state.history = this.state.history.slice(-MAX_HISTORY);
        }

        this.stats.totalToolCalls++;

        // Track consecutive failures
        if (hasError) {
            this.state.consecutiveFailures++;
        } else {
            this.state.consecutiveFailures = 0;
        }

        // Check for loop patterns
        return this.checkForLoop();
    }

    /**
     * Check the history for loop patterns.
     */
    checkForLoop(): LoopCheckResult {
        // If already tripped, stay tripped
        if (this.state.tripped) {
            return {
                tripped: true,
                reason: this.state.tripReason!,
            };
        }

        // TTL eviction: remove entries older than 5 minutes
        const now = Date.now();
        this.state.history = this.state.history.filter(
            (r) => now - r.timestamp <= HISTORY_TTL_MS
        );

        const history = this.state.history;

        // Pattern 1: Same error hash appears 3+ times in last 10 calls
        const recentErrors = history.slice(-SAME_ERROR_WINDOW);
        const errorCounts = new Map<string, { count: number; file: string | null }>();
        for (const record of recentErrors) {
            if (record.errorHash) {
                const entry = errorCounts.get(record.errorHash) || { count: 0, file: null };
                entry.count++;
                if (record.filePath) entry.file = record.filePath;
                errorCounts.set(record.errorHash, entry);
            }
        }

        for (const [, entry] of errorCounts) {
            if (entry.count >= SAME_ERROR_THRESHOLD) {
                const fileHint = entry.file ? ` on ${entry.file}` : "";
                return this.trip(
                    `Same error repeated ${entry.count} times${fileHint}. ` +
                    `Stop and ask the human for guidance.`
                );
            }
        }

        // Pattern 2: Same file written 5+ times in last 15 calls
        const recentWrites = history.slice(-SAME_FILE_WINDOW);
        const fileCounts = new Map<string, number>();
        for (const record of recentWrites) {
            if (record.filePath) {
                fileCounts.set(record.filePath, (fileCounts.get(record.filePath) || 0) + 1);
            }
        }

        for (const [file, count] of fileCounts) {
            if (count >= SAME_FILE_THRESHOLD) {
                return this.trip(
                    `File ${file} modified ${count} times in last ${SAME_FILE_WINDOW} calls. ` +
                    `Likely stuck in a loop. Stop and ask the human for guidance.`
                );
            }
        }

        // Pattern 3: Alternating write→test→fail pattern 3+ times
        const writeTestFailCount = this.countWriteTestFailCycles();
        if (writeTestFailCount >= WRITE_TEST_FAIL_THRESHOLD) {
            return this.trip(
                `Write→test→fail cycle detected ${writeTestFailCount} times. ` +
                `Stop and ask the human for guidance.`
            );
        }

        return { tripped: false, reason: "" };
    }

    /**
     * Count write→test→fail cycles in recent history.
     * A cycle is: a call with a filePath (write), followed by a call
     * that looks like a test/build, followed by a call with an error.
     */
    private countWriteTestFailCycles(): number {
        const history = this.state.history;
        let cycles = 0;
        let i = 0;

        while (i < history.length - 2) {
            const step1 = history[i];
            const step2 = history[i + 1];
            const step3 = history[i + 2];

            const isWrite = step1.filePath !== null;
            const isTest = this.isTestLikeCall(step2);
            const isFail = step3.errorHash !== null;

            if (isWrite && isTest && isFail) {
                cycles++;
                i += 3; // skip past this cycle
            } else {
                i++;
            }
        }

        return cycles;
    }

    /**
     * Heuristic: does this tool call look like a test/build invocation?
     */
    private isTestLikeCall(record: ToolCallRecord): boolean {
        const testTools = ["bash", "terminal", "tg_terminal", "run_command"];
        return testTools.includes(record.toolName.toLowerCase()) || record.errorHash !== null;
    }

    /**
     * Trip the circuit breaker.
     */
    private trip(reason: string): LoopCheckResult {
        this.state.tripped = true;
        this.state.tripReason = reason;
        this.stats.loopsDetected++;
        this.stats.loopsPrevented++;

        // Estimate tokens saved: remaining iterations that would have happened
        // Conservative estimate: would have looped at least 5 more times
        this.stats.estimatedTokensSaved += 5 * TOKENS_PER_FAILED_ITERATION;

        return { tripped: true, reason };
    }

    /**
     * Reset the circuit breaker after human intervention.
     */
    reset(): void {
        this.state.tripped = false;
        this.state.tripReason = null;
        this.state.consecutiveFailures = 0;
        this.state.history = [];
    }

    /**
     * Get circuit breaker statistics.
     */
    getStats(): CircuitBreakerStats {
        return { ...this.stats };
    }

    /**
     * Get current state (for debugging/inspection).
     */
    getState(): CircuitBreakerState {
        return {
            history: [...this.state.history],
            tripped: this.state.tripped,
            tripReason: this.state.tripReason,
            consecutiveFailures: this.state.consecutiveFailures,
        };
    }

    /**
     * Get the number of records in history (for testing ring buffer).
     */
    getHistoryLength(): number {
        return this.state.history.length;
    }
}
