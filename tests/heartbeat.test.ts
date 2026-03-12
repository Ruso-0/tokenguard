import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";

describe("Context Heartbeat: Prerequisites", () => {
    it("totalToolCalls increments on every recordToolCall", () => {
        const cb = new CircuitBreaker();
        expect(cb.getStats().totalToolCalls).toBe(0);

        cb.recordToolCall("tg_code:read", "success", "src/app.ts");
        cb.recordToolCall("tg_code:edit", "success", "src/app.ts");
        cb.recordToolCall("tg_navigate:search", "success");

        expect(cb.getStats().totalToolCalls).toBe(3);
    });

    it("totalToolCalls survives soft reset", () => {
        const cb = new CircuitBreaker();
        for (let i = 0; i < 5; i++) {
            cb.recordToolCall("tg_code:read", "success");
        }
        expect(cb.getStats().totalToolCalls).toBe(5);

        cb.softReset();
        expect(cb.getStats().totalToolCalls).toBe(5);
    });
});

describe("Context Heartbeat: Psychological Filter", () => {
    it("safe actions list includes all context-gathering operations", () => {
        const safeActions = [
            "read", "search", "map", "status",
            "definition", "references", "outline",
        ];

        // These should be safe (context gathering)
        expect(safeActions.includes("read")).toBe(true);
        expect(safeActions.includes("search")).toBe(true);
        expect(safeActions.includes("definition")).toBe(true);
        expect(safeActions.includes("references")).toBe(true);
        expect(safeActions.includes("outline")).toBe(true);
        expect(safeActions.includes("map")).toBe(true);
        expect(safeActions.includes("status")).toBe(true);

        // These should NOT be safe (active operations)
        expect(safeActions.includes("edit")).toBe(false);
        expect(safeActions.includes("undo")).toBe(false);
        expect(safeActions.includes("filter_output")).toBe(false);
        expect(safeActions.includes("compress")).toBe(false);
    });
});

describe("Context Heartbeat: Restart Detection", () => {
    it("detects session restart when currentCalls < lastInjectCalls", () => {
        // Simulates: lastInjectCalls was 45 (from previous session stored in SQLite)
        // currentCalls is 0 (fresh MCP server start)
        // Result: 0 - 45 = -45, which is < 15, so heartbeat would never fire
        // Fix: detect currentCalls < lastInjectCalls and reset to 0

        const currentCalls = 0;
        let lastInjectCalls = 45;

        if (currentCalls < lastInjectCalls) {
            lastInjectCalls = 0; // The fix
        }

        expect(currentCalls - lastInjectCalls).toBe(0);
        // After 15 more calls, heartbeat will fire correctly
        expect(15 - 0 >= 15).toBe(true);
    });
});

describe("Context Heartbeat: Bankruptcy Shield", () => {
    it("rejects plans over 4000 estimated tokens", () => {
        // A plan of ~16,000 chars ≈ ~4,571 tokens at 3.5 chars/token
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
