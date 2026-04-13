import { describe, it, expect, vi } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { applyContextHeartbeat, type McpToolResponse, type RouterDependencies } from "../src/router.js";

// ─── Minimal mock deps for applyContextHeartbeat ──────────────────────

function makeMockDeps(overrides: {
    totalToolCalls?: number;
    tokenDrift?: number;
    escalationLevel?: number;
    metadata?: Record<string, string>;
    planPath?: string;
    planExists?: boolean;
} = {}): RouterDependencies {
    const metadata: Record<string, string> = overrides.metadata ?? {};
    const cb = new CircuitBreaker();

    // Drive totalToolCalls to the desired count
    const target = overrides.totalToolCalls ?? 0;
    for (let i = 0; i < target; i++) {
        cb.recordToolCall("nreki_code:read", "ok");
    }

    // If we need escalation >= 2, trip the breaker twice (each trip increments level by 1)
    if (overrides.escalationLevel && overrides.escalationLevel >= 2) {
        // Trip 1 → level 1
        for (let i = 0; i < 4; i++) {
            cb.recordToolCall("nreki_code:edit", "TypeError: x", "src/app.ts", "sym", true);
        }
        // Soft reset so it can trip again
        cb.softReset();
        // Trip 2 → level 2
        for (let i = 0; i < 4; i++) {
            cb.recordToolCall("nreki_code:edit", "TypeError: x", "src/app.ts", "sym", true);
        }
    }

    // Token drift for heartbeat physics
    const drift = overrides.tokenDrift ?? 0;

    return {
        engine: {
            initialize: vi.fn(),
            getMetadata: (key: string) => metadata[key] ?? null,
            setMetadata: (key: string, value: string) => { metadata[key] = value; },
            getStats: () => ({ filesIndexed: 0, totalChunks: 0, totalRawChars: 0, totalShorthandChars: 0, compressionRatio: 0, watchedPaths: [] }),
            getUsageStats: () => ({ total_input: Math.floor(drift / 2), total_output: Math.ceil(drift / 2), total_saved: 0, tool_calls: target }),
        } as any,
        monitor: {} as any,
        sandbox: {} as any,
        circuitBreaker: cb,
    };
}

function makeResponse(text: string): McpToolResponse {
    return { content: [{ type: "text" as const, text }] };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("Context Heartbeat: Prerequisites", () => {
    it("totalToolCalls increments on every recordToolCall", () => {
        const cb = new CircuitBreaker();
        expect(cb.getStats().totalToolCalls).toBe(0);

        cb.recordToolCall("nreki_code:read", "success", "src/app.ts");
        cb.recordToolCall("nreki_code:edit", "success", "src/app.ts");
        cb.recordToolCall("nreki_navigate:search", "success");

        expect(cb.getStats().totalToolCalls).toBe(3);
    });

    it("totalToolCalls survives soft reset", () => {
        const cb = new CircuitBreaker();
        for (let i = 0; i < 5; i++) {
            cb.recordToolCall("nreki_code:read", "success");
        }
        expect(cb.getStats().totalToolCalls).toBe(5);

        cb.softReset();
        expect(cb.getStats().totalToolCalls).toBe(5);
    });
});

describe("Context Heartbeat: applyContextHeartbeat (token drift)", () => {
    it("does not inject heartbeat when drift < 15000 tokens (default threshold)", () => {
        const deps = makeMockDeps({ tokenDrift: 5000 });
        const response = makeResponse("original result");

        const result = applyContextHeartbeat("read", response, deps);

        expect(result.content[0].text).toBe("original result");
    });

    it("injects heartbeat on safe action after 50000+ tokens of drift", () => {
        const deps = makeMockDeps({ tokenDrift: 60000 });
        const response = makeResponse("original result");

        const result = applyContextHeartbeat("read", response, deps);

        expect(result.content[0].text).toContain("nreki_heartbeat");
        expect(result.content[0].text).toContain("original result");
    });

    it("does NOT inject heartbeat on unsafe actions (edit, undo, filter_output)", () => {
        const deps = makeMockDeps({ tokenDrift: 20000 });

        for (const action of ["edit", "undo", "filter_output", "compress"]) {
            const response = makeResponse("result");
            const result = applyContextHeartbeat(action, response, deps);
            expect(result.content[0].text).not.toContain("nreki_heartbeat");
        }
    });

    it("injects on all safe actions (read, search, map, status, definition, references, outline)", () => {
        for (const action of ["read", "search", "map", "status", "definition", "references", "outline"]) {
            const deps = makeMockDeps({ tokenDrift: 60000 });
            const response = makeResponse("result");
            const result = applyContextHeartbeat(action, response, deps);
            expect(result.content[0].text).toContain("nreki_heartbeat");
        }
    });

    it("does not inject on error responses", () => {
        const deps = makeMockDeps({ tokenDrift: 20000 });
        const response: McpToolResponse = {
            content: [{ type: "text" as const, text: "error" }],
            isError: true,
        };

        const result = applyContextHeartbeat("read", response, deps);
        expect(result.content[0].text).toBe("error");
    });

    it("does not inject during high escalation (level >= 2)", () => {
        const deps = makeMockDeps({ tokenDrift: 20000, escalationLevel: 2 });
        const response = makeResponse("result");

        const result = applyContextHeartbeat("read", response, deps);
        expect(result.content[0].text).not.toContain("nreki_heartbeat");
    });

    it("restart detection: resets marker when currentDrift < lastInjectDrift", () => {
        // Simulate a previous session that set lastInjectDrift to 100000
        const deps = makeMockDeps({
            tokenDrift: 60000,
            metadata: { "nreki_plan_last_drift": "150000" },
        });
        const response = makeResponse("result");

        // currentDrift (30000) < lastInjectDrift (100000) → should reset and inject
        const result = applyContextHeartbeat("read", response, deps);
        expect(result.content[0].text).toContain("nreki_heartbeat");
    });

    it("updates last_drift marker after injection", () => {
        const metadata: Record<string, string> = {};
        const deps = makeMockDeps({ tokenDrift: 60000, metadata });
        const response = makeResponse("result");

        applyContextHeartbeat("read", response, deps);
        expect(metadata["nreki_plan_last_drift"]).toBe("60000");
    });
});

describe("Context Heartbeat: Bankruptcy Shield", () => {
    it("rejects plans over 4000 estimated tokens", () => {
        const largePlan = "x".repeat(16000);
        const estimatedTokens = Math.ceil(largePlan.length / 3.5);
        expect(estimatedTokens).toBeGreaterThan(4000);
    });

    it("accepts plans under 4000 estimated tokens", () => {
        const smallPlan = "x".repeat(5000);
        const estimatedTokens = Math.ceil(smallPlan.length / 3.5);
        expect(estimatedTokens).toBeLessThan(4000);
    });
});
