/**
 * router.ts - Thin facade + heartbeat middleware (DAG architecture).
 *
 * This file is the ONLY entry point for MCP tool dispatch.
 * It owns:
 *   1. Type exports (consumed via `import type` by handlers — zero runtime cycle)
 *   2. The Context Heartbeat middleware (prompt cache physics)
 *   3. The switch dispatch that calls pure handlers and wraps responses
 *
 * The dependency graph is a strict DAG:
 *   router.ts → handlers/{navigate,code,guard}.ts → domain modules
 *   handlers use `import type` from router.ts (erased at compile time)
 *
 * 3 router tools replace 16 individual tools:
 *   nreki_navigate → search, definition, references, outline, map, prepare_refactor
 *   nreki_code     → read, compress, edit, batch_edit, undo, filter_output
 *   nreki_guard    → pin, unpin, status, report, reset, set_plan, memorize, audit
 */

import fs from "fs";
import path from "path";
import { readSource } from "./utils/read-source.js";
import { safePath } from "./utils/path-jail.js";
import { getPinnedText } from "./pin-memory.js";

import type { NrekiEngine } from "./engine.js";
import type { TokenMonitor } from "./monitor.js";
import type { AstSandbox } from "./ast-sandbox.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import type { PreToolUseHook } from "./hooks/preToolUse.js";
import type { NrekiKernel } from "./kernel/nreki-kernel.js";
import type { ChronosMemory } from "./chronos-memory.js";

// 1. IMPORT HANDLERS (Unidirectional)
import * as nav from "./handlers/navigate.js";
import * as code from "./handlers/code.js";
import * as guard from "./handlers/guard.js";

// ─── Types (consumed by handlers via `import type`) ─────────────────

export interface McpToolResponse {
    [key: string]: unknown;
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}

export interface RouterDependencies {
    engine: NrekiEngine;
    monitor: TokenMonitor;
    sandbox: AstSandbox;
    circuitBreaker: CircuitBreaker;
    hook?: PreToolUseHook;
    kernel?: NrekiKernel;
    chronos?: ChronosMemory;
    nrekiMode?: "syntax" | "file" | "project" | "hologram";
}

/** Flat params for nreki_navigate (replaces target + options bag). */
export interface NavigateParams {
    action: string;
    query?: string;
    symbol?: string;
    path?: string;
    limit?: number;
    include_raw?: boolean;
    kind?: string;
    signatures?: boolean;
    refresh?: boolean;
    auto_context?: boolean;
}

/** Flat params for nreki_code (replaces path + options bag). */
export interface CodeParams {
    action: string;
    path?: string;
    symbol?: string;
    new_code?: string;
    compress?: boolean;
    level?: string;
    focus?: string;
    tier?: number;
    output?: string;
    max_lines?: number;
    mode?: string;
    auto_context?: boolean;
    edits?: Array<{ path: string; symbol: string; new_code: string; mode?: string }>;
}

/** Flat params for nreki_guard (replaces options bag). */
export interface GuardParams {
    action: string;
    text?: string;
    index?: number;
    id?: string;
}

// ─── Context Heartbeat Middleware ────────────────────────────────────

/**
 * Context Heartbeat - Session State Re-injection.
 *
 * Re-injects a 4-layer session state every ~15 tool calls to survive
 * Claude Code's context compaction. Injects memory ABOVE the tool result
 * (respects U-shaped attention curve in transformer models).
 *
 * Only fires during read-only actions (read, search, map, status,
 * definition, references, outline). Never during edit, undo, or filter_output.
 *
 * Layers:
 * 1. Plan File - Anchored plan document (PLAN.md, schemas, constraints)
 * 2. Scratchpad - Claude's progress notes
 * 3. Recent Edits - Files modified in this session
 * 4. Circuit Breaker - Active escalation alerts
 */
export function applyContextHeartbeat(
    action: string,
    response: McpToolResponse,
    deps: RouterDependencies,
): McpToolResponse {
    if (response.isError || !response.content || response.content[0]?.type !== "text") {
        return response;
    }

    // C4: Don't inject heartbeat during active circuit breaker escalation
    if (deps.circuitBreaker.getState().escalationLevel >= 2) {
        return response;
    }

    try {
        const currentCalls = deps.circuitBreaker.getStats().totalToolCalls;
        let lastInjectCalls = parseInt(
            deps.engine.getMetadata("nreki_plan_last_inject") || "0",
            10,
        );

        // FIX: Use strict < instead of <=. With <=, equal values (tool failure
        // without counter increment) reset lastInjectCalls to 0, causing
        // currentCalls - 0 >= 15 to be true on every subsequent call.
        // This injects thousands of heartbeat tokens per session.
        if (currentCalls < lastInjectCalls) {
            lastInjectCalls = 0;
            deps.engine.setMetadata("nreki_plan_last_inject", "0");
        }

        if (currentCalls - lastInjectCalls >= 15) {
            const safeActions = [
                "read", "search", "map", "status",
                "definition", "references", "outline",
            ];

            if (safeActions.includes(action)) {
                let memoryPayload = "";

                // LAYER 1: Plan File
                const rawPlanPath = deps.engine.getMetadata("nreki_master_plan");
                // PATH JAIL: Validate plan path before reading.
                // Without this, a prompt injection can set the plan to /etc/shadow
                // and NREKI exfiltrates it into Claude's context every 15 calls.
                let planPath: string | null = null;
                if (rawPlanPath) {
                    try {
                        planPath = safePath(deps.engine.getProjectRoot(), rawPlanPath);
                    } catch {
                        planPath = null; // Path jail blocked — skip plan injection
                    }
                }
                if (planPath && fs.existsSync(planPath)) {
                    let planContent: string;
                    try { planContent = readSource(planPath); } catch { planContent = ""; }
                    if (planContent && planContent.length < 15000) {
                        memoryPayload +=
                            `=== PLAN FILE (${path.basename(planPath)}) ===\n` +
                            `${planContent}\n\n`;
                    } else {
                        memoryPayload +=
                            `=== PLAN FILE ===\n` +
                            `[WARNING: Your plan file "${path.basename(planPath)}" exceeds 15,000 characters (${planContent.length.toLocaleString()} chars). ` +
                            `NREKI skipped injection to protect your context window. ` +
                            `Summarize it or split it into smaller files, then re-anchor with: ` +
                            `nreki_guard action:"set_plan" text:"<shorter_plan_file>"]\n\n`;
                    }
                }

                // LAYER 2: Scratchpad
                const scratchpad = deps.engine.getMetadata("nreki_scratchpad");
                if (scratchpad) {
                    memoryPayload +=
                        `=== SCRATCHPAD (Your Notes) ===\n` +
                        `${scratchpad}\n\n`;
                }

                // LAYER 2b: Pinned Rules
                try {
                    const pinnedText = getPinnedText(process.cwd());
                    if (pinnedText) {
                        memoryPayload += `${pinnedText}\n\n`;
                    }
                } catch {
                    // getPinnedText may fail - skip gracefully
                }

                // LAYER 3: Recent Edits
                const history = deps.circuitBreaker.getState().history;
                const recentEdits = new Set<string>();
                const scanWindow = Math.max(0, history.length - 15);
                for (let i = history.length - 1; i >= scanWindow; i--) {
                    const record = history[i];
                    if (
                        record.filePath &&
                        !record.errorHash
                    ) {
                        recentEdits.add(path.basename(record.filePath));
                    }
                }
                if (recentEdits.size > 0) {
                    memoryPayload +=
                        `=== RECENT EDITS ===\n` +
                        `You recently modified: ${Array.from(recentEdits).join(", ")}.\n\n`;
                }

                // LAYER 4: Circuit Breaker Alert
                const cbState = deps.circuitBreaker.getState();
                if (cbState.escalationLevel > 0) {
                    const target =
                        cbState.lastTrippedSymbol ||
                        cbState.lastTrippedFile ||
                        "a critical component";
                    memoryPayload +=
                        `=== CIRCUIT BREAKER ALERT (LEVEL ${cbState.escalationLevel}) ===\n` +
                        `You are executing a "Break & Build" strategy on \`${target}\`.\n` +
                        `Do not deviate until this is resolved.\n\n`;
                }

                // TOP-INJECTION: State ABOVE, tool result BELOW
                if (memoryPayload.trim().length > 0) {
                    const header =
                        `=================================================================\n` +
                        ` [NREKI CONTEXT HEARTBEAT]\n` +
                        ` Context compaction detected. Restoring session state:\n` +
                        `=================================================================\n\n`;

                    const footer =
                        `=================================================================\n` +
                        `[END CONTEXT HEARTBEAT] Proceed with tool result below:\n` +
                        `=================================================================\n\n`;

                    const newResponse = {
                        ...response,
                        content: [...response.content],
                    };
                    const originalText = response.content[0].text;

                    // 🔥 PROMPT CACHE PHYSICS (PATCH-5) 🔥
                    // Anthropic uses Prefix Caching. Dynamic content (heartbeat) MUST go
                    // AFTER static content to preserve the prefix hash.
                    // Previous code put heartbeat before originalText for non-map actions,
                    // which destroyed the cache on every injection cycle.
                    newResponse.content[0] = {
                        type: "text" as const,
                        text: originalText + "\n\n" + header + memoryPayload + footer,
                    };

                    deps.engine.setMetadata(
                        "nreki_plan_last_inject",
                        String(currentCalls),
                    );

                    return newResponse;
                }
            }
        }
    } catch {
        // Fail silently - never break the core tool response
    }

    return response;
}

// ─── Rate Limiter (Token Bucket) ────────────────────────────────────
//
// Prevents hyperactive agents from overwhelming the kernel with
// rapid-fire edits. Only applied to mutating operations (edit, batch_edit).
// Reads and navigation are unrestricted.

class TokenBucket {
    private tokens: number;
    private lastRefill: number;
    constructor(
        private readonly capacity: number,
        private readonly refillRate: number, // tokens per second
    ) {
        this.tokens = capacity;
        this.lastRefill = Date.now();
    }

    tryConsume(): boolean {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000;
        this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
        this.lastRefill = now;
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return true;
        }
        return false;
    }
}

const editBucket = new TokenBucket(10, 3); // 10 burst, 3/sec sustained
const RATE_LIMITED_ACTIONS = new Set(["edit", "batch_edit"]);

// ─── Facade: nreki_navigate ─────────────────────────────────────────

export async function handleNavigate(
    action: string,
    params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    let response: McpToolResponse;
    switch (action) {
        case "search": response = await nav.handleSearch(params, deps); break;
        case "definition": response = await nav.handleDefinition(params, deps); break;
        case "references": response = await nav.handleReferences(params, deps); break;
        case "outline": response = await nav.handleOutline(params, deps); break;
        case "map": response = await nav.handleMap(params, deps); break;
        case "prepare_refactor": response = await nav.handlePrepareRefactor(params, deps); break;
        default:
            return {
                content: [{
                    type: "text" as const,
                    text: `Unknown nreki_navigate action: "${action}". Valid actions: search, definition, references, outline, map, prepare_refactor.`,
                }],
                isError: true,
            };
    }
    return applyContextHeartbeat(action, response, deps);
}

// ─── Facade: nreki_code ─────────────────────────────────────────────

export async function handleCode(
    action: string,
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    // Rate limit mutating operations to prevent agent flooding
    if (RATE_LIMITED_ACTIONS.has(action) && !editBucket.tryConsume()) {
        return {
            content: [{
                type: "text" as const,
                text: `[NREKI] Rate limit: too many edits per second. Wait briefly and retry.\n\n[NREKI saved ~0 tokens]`,
            }],
            isError: true,
        };
    }

    let response: McpToolResponse;
    switch (action) {
        case "read": response = await code.handleRead(params, deps); break;
        case "compress": response = await code.handleCompress(params, deps); break;
        case "edit": response = await code.handleEdit(params, deps); break;
        case "batch_edit": response = await code.handleBatchEdit(params, deps); break;
        case "undo": response = await code.handleUndo(params, deps); break;
        case "filter_output": response = await code.handleFilterOutput(params, deps); break;
        default: {
            const hint = action === "terminal"
                ? ' (Note: "terminal" was renamed to "filter_output" in v3.0.1)'
                : "";
            return {
                content: [{
                    type: "text" as const,
                    text: `Unknown nreki_code action: "${action}"${hint}. Valid actions: read, compress, edit, batch_edit, undo, filter_output.`,
                }],
                isError: true,
            };
        }
    }
    return applyContextHeartbeat(action, response, deps);
}

// ─── Facade: nreki_guard ────────────────────────────────────────────

export async function handleGuard(
    action: string,
    params: GuardParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    let response: McpToolResponse;
    switch (action) {
        case "pin": response = await guard.handlePin(params, deps); break;
        case "unpin": response = await guard.handleUnpin(params, deps); break;
        case "status": response = await guard.handleStatus(deps); break;
        case "report": response = await guard.handleReport(deps); break;
        case "reset": response = await guard.handleReset(deps); break;
        case "set_plan": response = await guard.handleSetPlan(params, deps); break;
        case "memorize": response = await guard.handleMemorize(params, deps); break;
        case "audit": response = await guard.handleAudit(deps); break;
        default:
            return {
                content: [{
                    type: "text" as const,
                    text: `Unknown nreki_guard action: "${action}". Valid actions: pin, unpin, status, report, reset, set_plan, memorize, audit.`,
                }],
                isError: true,
            };
    }
    return applyContextHeartbeat(action, response, deps);
}
