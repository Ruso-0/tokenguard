/**
 * middleware/circuit-breaker.ts - Creative circuit breaker middleware for NREKI.
 *
 * Wraps all router tool handlers with automatic loop detection.
 * Records every tool call result and trips the breaker when it detects
 * destructive patterns (repeated errors, excessive edits, doom loops).
 *
 * v3.1.0: 3-level escalation system ("Break & Build"):
 *   Level 1 - Rewrite: stop patching, rewrite the symbol from scratch
 *   Level 2 - Decompose: break into smaller helper functions
 *   Level 3 - Hard Stop: ask the human for guidance
 */

import { CircuitBreaker, containsError } from "../circuit-breaker.js";
import type { McpToolResponse } from "../router.js";

/** Inactivity timeout for auto-reset (60 seconds). */
const INACTIVITY_TIMEOUT_MS = 60_000;

// ─── Middleware Class ─────────────────────────────────────────────────

export class CircuitBreakerMiddleware {
    private lastActivityTimestamp = Date.now();
    private lastToolAction = "";

    wrap(
        cb: CircuitBreaker,
        toolName: string,
        action: string,
        handler: () => Promise<McpToolResponse>,
        filePath?: string,
        symbolName?: string,
        chronos?: { recordTrip: (file: string, reason: string) => void },
    ): Promise<McpToolResponse> {
        return (async () => {
            const toolAction = `${toolName}:${action}`;
            const now = Date.now();

            // Auto-reset: 60s inactivity
            if (now - this.lastActivityTimestamp > INACTIVITY_TIMEOUT_MS) {
                const state = cb.getState();
                if (state.tripped) {
                    cb.reset();
                }
            }

            // Soft reset on different request type: clears tripped state but
            // preserves per-file failure counters and escalation level.
            if (toolAction !== this.lastToolAction && this.lastToolAction !== "") {
                const state = cb.getState();
                if (state.tripped) {
                    cb.softReset();
                }
            }

            this.lastActivityTimestamp = now;
            this.lastToolAction = toolAction;

            // If breaker is still tripped after potential resets, return level-specific redirect
            const preState = cb.getState();
            if (preState.tripped) {
                // For levels 1-2, soft-reset to allow the retry after redirect
                if (preState.escalationLevel < 3) {
                    cb.softReset();
                }
                return generateBreakerResponse(
                    preState.escalationLevel,
                    preState.lastTrippedSymbol,
                    preState.lastTrippedFile,
                    preState.tripReason ?? "Unknown pattern",
                );
            }

            // Execute the actual handler
            const response = await handler();

            // Record the result for pattern detection
            const responseText = response.content.map(c => c.text).join("\n");
            const hasError = response.isError === true || containsError(responseText);

            if (hasError) {
                const loopCheck = cb.recordToolCall(
                    toolAction,
                    responseText,
                    filePath,
                    symbolName,
                    true,
                );

                if (loopCheck.tripped) {
                    // Record circuit breaker trip in file fragility tracker
                    if (chronos && filePath) {
                        chronos.recordTrip(filePath, loopCheck.reason);
                    }

                    // For levels 1-2, soft-reset to allow retry after redirect
                    if (loopCheck.level < 3) {
                        cb.softReset();
                    }
                    return generateBreakerResponse(
                        loopCheck.level,
                        symbolName ?? null,
                        filePath ?? null,
                        loopCheck.reason,
                    );
                }
            } else {
                // Record non-error calls too (for same-file tracking)
                cb.recordToolCall(
                    toolAction,
                    "",
                    filePath,
                    symbolName,
                );
            }

            return response;
        })();
    }

    /** Reset middleware state (for testing). */
    reset(): void {
        this.lastActivityTimestamp = Date.now();
        this.lastToolAction = "";
    }
}

// ─── Level-Specific Payloads ─────────────────────────────────────────

function generateLevel1Redirect(
    symbol: string | null,
    file: string | null,
    error: string,
): string {
    const sym = symbol ?? "the failing symbol";
    const fil = file ?? "the current file";
    return (
        `🔄 **[NREKI: BREAK & BUILD - LEVEL 1]**\n\n` +
        `You are stuck in a syntax/error loop attempting to patch \`${sym}\` in \`${fil}\`.\n` +
        `Repeated fixes to the same code are failing with the same pattern:\n` +
        `> ${error}\n\n` +
        `**STRATEGY SHIFT: Stop patching. Rewrite from scratch.**\n\n` +
        `1. Use \`nreki_code action:"read" compress:false path:"${fil}"\` to read the UNCOMPRESSED code. You CANNOT rewrite the logic if you read it compressed.\n` +
        `2. DO NOT use the native Write tool (it bypasses AST validation).\n` +
        `3. Use \`nreki_code action:"edit" mode:"insert_after" symbol:"${sym}"\` to safely append a NEW function \`${sym}_v2\` below the original. NREKI will validate it.\n` +
        `4. Implement the intended behavior cleanly from zero in \`${sym}_v2\`.\n` +
        `5. Once it compiles (test with Bash), update callers to use \`${sym}_v2\`.\n` +
        `6. Then remove the old \`${sym}\` with \`nreki_code action:"edit"\`.\n\n` +
        `Acknowledge this and start building \`${sym}_v2\`.`
    );
}

function generateLevel2Redirect(
    symbol: string | null,
    file: string | null,
    error: string,
): string {
    const sym = symbol ?? "the failing symbol";
    const fil = file ?? "the current file";
    return (
        `🔄 **[NREKI: BREAK & BUILD - LEVEL 2: DECOMPOSE]**\n\n` +
        `Rewriting \`${sym}\` in \`${fil}\` as a single function also failed.\n` +
        `The complexity is too high for monolithic code. Time to divide and conquer.\n` +
        `> ${error}\n\n` +
        `**MANDATORY STRATEGY: Break the logic into smaller pieces.**\n\n` +
        `1. Use \`nreki_code action:"read" compress:false path:"${fil}"\` to read the full uncompressed code of \`${sym}\` and understand its responsibilities.\n` +
        `2. Identify 2-3 distinct responsibilities inside \`${sym}\`.\n` +
        `3. DO NOT use the native Write tool (it bypasses AST validation).\n` +
        `4. Use \`nreki_code action:"edit" mode:"insert_before" symbol:"${sym}"\` to add small, pure helper functions above \`${sym}\` (data in → data out). NREKI will validate them.\n` +
        `5. Test each helper individually with Bash before moving on.\n` +
        `6. Only after all helpers compile, use \`nreki_code action:"edit"\` to rewrite \`${sym}\` as a thin orchestrator.\n\n` +
        `Acknowledge this and start with the first helper function.`
    );
}

function generateLevel3HardStop(
    symbol: string | null,
    file: string | null,
    error: string,
): string {
    const sym = symbol ?? "the failing symbol";
    const fil = file ?? "the current file";
    return (
        `🛑 **[NREKI: CIRCUIT BREAKER - HARD STOP]**\n\n` +
        `NREKI has tried redirecting you twice and you are still stuck on \`${sym}\` in \`${fil}\`.\n` +
        `> ${error}\n\n` +
        `**STOP. Ask the human how to proceed.**\n\n` +
        `Tell them:\n` +
        `- What you were trying to do\n` +
        `- The error pattern you cannot resolve\n` +
        `- The two strategies NREKI suggested (rewrite + decompose) and why they failed\n\n` +
        `Do not attempt another edit until the human responds.\n\n` +
        `Use \`nreki_guard action:"reset"\` after the human provides guidance to clear this breaker.`
    );
}

function generateBreakerResponse(
    level: number,
    symbol: string | null,
    file: string | null,
    error: string,
): McpToolResponse {
    let text: string;
    switch (level) {
        case 1:
            text = generateLevel1Redirect(symbol, file, error);
            break;
        case 2:
            text = generateLevel2Redirect(symbol, file, error);
            break;
        case 3:
        default:
            text = generateLevel3HardStop(symbol, file, error);
            break;
    }
    return {
        content: [{ type: "text" as const, text }],
        isError: true,
    };
}

// ─── Backward-Compatible Wrappers ────────────────────────────────────

const defaultMiddleware = new CircuitBreakerMiddleware();

/**
 * Wrap a router handler with passive circuit breaker monitoring.
 * Backward-compatible function wrapper — delegates to CircuitBreakerMiddleware.
 *
 * Before executing the handler, checks:
 *   1. If the breaker was tripped but 60s have elapsed → auto-reset
 *   2. If the breaker was tripped but a different tool/action is requested → soft-reset
 *   3. If the breaker is currently tripped → return level-specific redirect
 *
 * After execution, records the result for pattern detection.
 */
export function wrapWithCircuitBreaker(
    cb: CircuitBreaker,
    toolName: string,
    action: string,
    handler: () => Promise<McpToolResponse>,
    filePath?: string,
    symbolName?: string,
    chronos?: { recordTrip: (file: string, reason: string) => void },
): Promise<McpToolResponse> {
    return defaultMiddleware.wrap(cb, toolName, action, handler, filePath, symbolName, chronos);
}

/**
 * Reset middleware state (for testing).
 */
export function resetMiddlewareState(): void {
    defaultMiddleware.reset();
}
