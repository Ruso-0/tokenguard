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

/**
 * Read-only actions exempt from heuristic text-matching of error patterns
 * via containsError(). These actions can legitimately return responses
 * containing words like "error", "failed", "exception" (search hits on
 * try/catch blocks, fast_grep over real source code, audit reports with
 * "Type errors" frequency, agent's own memorize/engram annotations).
 *
 * Important: this skip applies ONLY to containsError() text heuristic.
 * Explicit response.isError === true (hardware signal: path jail
 * violation, security error, etc.) STILL trips the breaker for these
 * actions, because that is a contract violation, not a false-positive.
 *
 * Excluded from this set: filter_output (it is the gateway for the
 * agent to read Bash/test/build output - text matching of "FAIL"/"error"
 * there is exactly the doom-loop signal the breaker must catch).
 */
const READ_ONLY_ACTIONS = new Set<string>([
    // nreki_navigate
    "search", "definition", "references", "outline", "map",
    "fast_grep", "prepare_refactor", "orphan_oracle", "type_shape",
    // nreki_code (read-only sub-actions; filter_output deliberately excluded)
    "read", "compress",
    // nreki_guard (state inspection + agent's own memory annotations)
    "status", "report", "audit",
    "pin", "unpin", "reset", "set_plan", "memorize", "engram",
]);


// ─── Level-Specific Payloads ─────────────────────────────────────────

function generateLevel1Redirect(
    symbol: string | null,
    file: string | null,
    error: string,
): string {
    const sym = symbol ?? "the failing symbol";
    const fil = file ?? "the current file";
    return (
        `**BREAK & BUILD - LEVEL 1**\n\n` +
        `You are stuck in a syntax/error loop attempting to patch \`${sym}\` in \`${fil}\`.\n` +
        `Repeated fixes to the same code are failing with the same pattern:\n` +
        `> ${error}\n\n` +
        `**STRATEGY SHIFT: Stop patching. Rewrite from scratch.**\n\n` +
        `1. Use \`nreki_code action:"read" compress:false _nreki_bypass:"chronos_recovery" path:"${fil}"\` to read the UNCOMPRESSED code. You CANNOT rewrite the logic if you read it compressed.\n` +
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
        `**BREAK & BUILD - LEVEL 2: DECOMPOSE**\n\n` +
        `Rewriting \`${sym}\` in \`${fil}\` as a single function also failed.\n` +
        `The complexity is too high for monolithic code. Time to divide and conquer.\n` +
        `> ${error}\n\n` +
        `**MANDATORY STRATEGY: Break the logic into smaller pieces.**\n\n` +
        `1. Use \`nreki_code action:"read" compress:false _nreki_bypass:"chronos_recovery" path:"${fil}"\` to read the full uncompressed code of \`${sym}\` and understand its responsibilities.\n` +
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
        `**CIRCUIT BREAKER - HARD STOP**\n\n` +
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

// ─── Session-Isolated Middleware (WeakMap per CircuitBreaker) ─────────

const middlewareStates = new WeakMap<CircuitBreaker, { lastActivity: number; lastAction: string }>();

/**
 * Wrap a router handler with passive circuit breaker monitoring.
 * State is isolated per CircuitBreaker instance via WeakMap — no global singleton.
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
    return (async () => {
        const toolAction = `${toolName}:${action}`;
        const now = Date.now();

        // AUDIT FIX: State per CB instance, not global singleton
        let state = middlewareStates.get(cb) || { lastActivity: 0, lastAction: "" };

        // Auto-reset: 60s inactivity
        if (now - state.lastActivity > INACTIVITY_TIMEOUT_MS) {
            if (cb.getState().tripped) cb.reset();
        }

        // Soft reset on different request type
        if (toolAction !== state.lastAction && state.lastAction !== "") {
            if (cb.getState().tripped) cb.softReset();
        }

        state.lastActivity = now;
        state.lastAction = toolAction;
        middlewareStates.set(cb, state);

        // If breaker is still tripped after potential resets, return level-specific redirect
        const preState = cb.getState();
        if (preState.tripped) {
            if (preState.escalationLevel < 3) cb.softReset();
            return generateBreakerResponse(
                preState.escalationLevel,
                preState.lastTrippedSymbol,
                preState.lastTrippedFile,
                preState.tripReason ?? "Unknown pattern",
            );
        }

        // Execute the actual handler
        // PATCH-4: Catch handler exceptions so the circuit breaker can see them.
        // Without this, thrown errors bypass recordToolCall entirely, making
        // the breaker blind to ENOENT loops, timeout cascades, etc.
        let response: McpToolResponse;
        try {
            response = await handler();
        } catch (err) {
            response = {
                content: [{
                    type: "text" as const,
                    text: `Fatal tool error: ${(err as Error).message}`,
                }],
                isError: true,
            };
        }

        // Record the result for pattern detection
        // Truncate to 2KB before hashing — terminal output can be megabytes
        const responseText = response.content.map(c => c.text ?? "").filter(Boolean).join("\n").slice(0, 2048);
        // Read-only actions skip the containsError() text heuristic to avoid
        // false-positive trips on legitimate error mentions in source code,
        // search results, audit reports, or agent's own memory annotations.
        // Explicit response.isError === true (hardware signal) still trips
        // the breaker for these actions: it is a contract violation, not a
        // heuristic match.
        const isReadOnly = READ_ONLY_ACTIONS.has(action);
        const hasError = response.isError === true ||
            (!isReadOnly && containsError(responseText));

        if (hasError) {
            const loopCheck = cb.recordToolCall(
                toolAction, responseText, filePath, symbolName, true,
            );

            if (loopCheck.tripped) {
                if (chronos && filePath) chronos.recordTrip(filePath, loopCheck.reason);
                if (loopCheck.level < 3) cb.softReset();
                return generateBreakerResponse(
                    loopCheck.level, symbolName ?? null, filePath ?? null, loopCheck.reason,
                );
            }
        } else {
            cb.recordToolCall(toolAction, "", filePath, symbolName);
        }

        return response;
    })();
}

/**
 * Legacy cleanup hook. Intentionally a no-op since v7.0.
 * WeakMap entries are GC'd when the CB instance is collected.
 * Tests create fresh CircuitBreaker instances, so no stale state persists.
 * @deprecated Will be removed in v8. Tests should stop calling this.
 */
export function resetMiddlewareState(): void {
    // No-op: retained for backward compatibility with test imports.
}
