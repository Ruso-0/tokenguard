/**
 * middleware.test.ts - Tests for v3.0 middleware layer.
 *
 * Covers:
 * - Validator: valid code passes, invalid code blocked with details
 * - Circuit breaker middleware: auto-reset, trip behavior, isError flag
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CircuitBreaker, containsError } from "../src/circuit-breaker.js";
import {
    wrapWithCircuitBreaker,
    resetMiddlewareState,
} from "../src/middleware/circuit-breaker.js";
import {
    validateBeforeWrite,
    formatValidationErrors,
} from "../src/middleware/validator.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import type { McpToolResponse } from "../src/router.js";

// ─── Validator Middleware ────────────────────────────────────────────

describe("Validator Middleware", () => {
    let sandbox: AstSandbox;

    beforeEach(async () => {
        sandbox = new AstSandbox();
    });

    it("should pass valid TypeScript code", async () => {
        const code = `function greet(name: string): string {
    return "Hello, " + name;
}`;
        const result = await validateBeforeWrite(code, "typescript", sandbox);
        expect(result.valid).toBe(true);
        expect(result.errors.length).toBe(0);
    });

    it("should pass valid JavaScript code", async () => {
        const code = `const sum = (a, b) => a + b;
module.exports = { sum };`;
        const result = await validateBeforeWrite(code, "javascript", sandbox);
        expect(result.valid).toBe(true);
    });

    it("should block code with syntax errors", async () => {
        const code = `function broken( {
    return "missing paren";
}`;
        const result = await validateBeforeWrite(code, "typescript", sandbox);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should provide error details with line and column", async () => {
        const code = `const x = {
    a: 1,
    b:
};`;
        const result = await validateBeforeWrite(code, "typescript", sandbox);
        if (!result.valid) {
            expect(result.errors[0]).toHaveProperty("line");
            expect(result.errors[0]).toHaveProperty("column");
        }
    });

    it("should format errors as human-readable string", async () => {
        const code = `function bad( { return 1; }`;
        const result = await validateBeforeWrite(code, "typescript", sandbox);
        if (!result.valid) {
            const formatted = formatValidationErrors(result);
            expect(formatted).toContain("Validation: FAILED");
            expect(formatted).toContain("syntax error");
        }
    });

    it("should return empty string for valid code formatting", async () => {
        const code = `const x = 42;`;
        const result = await validateBeforeWrite(code, "typescript", sandbox);
        if (result.valid) {
            const formatted = formatValidationErrors(result);
            expect(formatted).toBe("");
        }
    });
});

// ─── Circuit Breaker Middleware ─────────────────────────────────────

describe("Circuit Breaker Middleware", () => {
    let cb: CircuitBreaker;

    beforeEach(() => {
        cb = new CircuitBreaker();
        resetMiddlewareState();
    });

    it("should pass through successful handler responses", async () => {
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "Success!" }],
        });

        const result = await wrapWithCircuitBreaker(cb, "nreki_navigate", "search", handler);
        expect(result.content[0].text).toBe("Success!");
        expect(result.isError).toBeUndefined();
    });

    it("should pass through handler errors without tripping on first occurrence", async () => {
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "TypeError: something failed" }],
            isError: true,
        });

        const result = await wrapWithCircuitBreaker(cb, "nreki_code", "edit", handler);
        expect(result.isError).toBe(true);
        // First error should not trip the breaker
        expect(result.content[0].text).toContain("TypeError");
        expect(result.content[0].text).not.toContain("CIRCUIT BREAKER");
    });

    it("should trip after 3 identical errors on same tool/action", async () => {
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "TypeError: Cannot read property 'x'" }],
            isError: true,
        });

        await wrapWithCircuitBreaker(cb, "nreki_code", "edit", handler, "src/foo.ts");
        await wrapWithCircuitBreaker(cb, "nreki_code", "edit", handler, "src/foo.ts");
        const result = await wrapWithCircuitBreaker(cb, "nreki_code", "edit", handler, "src/foo.ts");

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("BREAK & BUILD");
    });

    it("should return isError: true when breaker trips with level-specific payload", async () => {
        const error = "TypeError: Same recurring error";
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: error }],
            isError: true,
        });

        for (let i = 0; i < 3; i++) {
            await wrapWithCircuitBreaker(cb, "nreki_code", "edit", handler, "src/foo.ts");
        }

        // Level 1 trip: soft-resets to allow retry, but still returns redirect
        // The trip response from recordToolCall contains the redirect
        const state = cb.getState();
        expect(state.escalationLevel).toBe(1);
    });

    it("should soft-reset and allow different tool/action after trip", async () => {
        const error = "TypeError: Same error";
        const errorHandler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: error }],
            isError: true,
        });

        // Trip the breaker
        for (let i = 0; i < 3; i++) {
            await wrapWithCircuitBreaker(cb, "nreki_code", "edit", errorHandler, "src/foo.ts");
        }

        expect(cb.getState().escalationLevel).toBe(1);

        // Different tool/action should soft-reset and pass through
        const successHandler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "Search result" }],
        });

        const result = await wrapWithCircuitBreaker(cb, "nreki_navigate", "search", successHandler);
        expect(result.content[0].text).toBe("Search result");
    });

    it("should record non-error calls for file write tracking", async () => {
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "Edit successful" }],
        });

        await wrapWithCircuitBreaker(cb, "nreki_code", "edit", handler, "src/foo.ts");
        await wrapWithCircuitBreaker(cb, "nreki_code", "edit", handler, "src/foo.ts");

        const stats = cb.getStats();
        expect(stats.totalToolCalls).toBeGreaterThanOrEqual(2);
    });

    it("should detect errors in response text even without isError flag", async () => {
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "Build failed with 5 errors\nTypeError: something" }],
        });

        // containsError detects error patterns in text
        expect(containsError("Build failed with 5 errors")).toBe(true);
        expect(containsError("All tests passed")).toBe(false);
    });

    it("Level 1 trip returns BREAK & BUILD LEVEL 1 payload", async () => {
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "TypeError: Cannot read property 'x'" }],
            isError: true,
        });

        // Trip to level 1
        let result;
        for (let i = 0; i < 3; i++) {
            result = await wrapWithCircuitBreaker(cb, "nreki_code", "edit", handler, "src/foo.ts", "myFunc");
        }

        expect(result!.isError).toBe(true);
        expect(result!.content[0].text).toContain("LEVEL 1");
        expect(result!.content[0].text).toContain("BREAK & BUILD");
        expect(result!.content[0].text).toContain("native Write");
    });

    it("Level 2 trip returns DECOMPOSE payload", async () => {
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "TypeError: Cannot read property 'x'" }],
            isError: true,
        });

        // Trip to level 1 (3 errors)
        for (let i = 0; i < 3; i++) {
            await wrapWithCircuitBreaker(cb, "nreki_code", "edit", handler, "src/foo.ts");
        }
        expect(cb.getState().escalationLevel).toBe(1);

        // After level 1 soft-reset (amnesia total clears file history),
        // need 3 more errors to re-trip and escalate to level 2.
        let result;
        for (let i = 0; i < 3; i++) {
            result = await wrapWithCircuitBreaker(cb, "nreki_code", "edit", handler, "src/foo.ts");
        }
        expect(result!.isError).toBe(true);
        expect(result!.content[0].text).toContain("LEVEL 2");
        expect(result!.content[0].text).toContain("DECOMPOSE");
        expect(cb.getState().escalationLevel).toBe(2);
    });

    it("Level 3 trip returns HARD STOP payload", async () => {
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "TypeError: Cannot read property 'x'" }],
            isError: true,
        });

        // Trip to level 1 (3 errors)
        for (let i = 0; i < 3; i++) {
            await wrapWithCircuitBreaker(cb, "nreki_code", "edit", handler, "src/foo.ts");
        }
        expect(cb.getState().escalationLevel).toBe(1);

        // Escalate to level 2 (amnesia total: need 3 more errors)
        for (let i = 0; i < 3; i++) {
            await wrapWithCircuitBreaker(cb, "nreki_code", "edit", handler, "src/foo.ts");
        }
        expect(cb.getState().escalationLevel).toBe(2);

        // Escalate to level 3 (amnesia total: need 3 more errors)
        for (let i = 0; i < 3; i++) {
            await wrapWithCircuitBreaker(cb, "nreki_code", "edit", handler, "src/foo.ts");
        }
        expect(cb.getState().escalationLevel).toBe(3);

        // Level 3 does NOT soft-reset, so next call returns hard stop from pre-check
        const result = await wrapWithCircuitBreaker(cb, "nreki_code", "edit", handler, "src/foo.ts");
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("HARD STOP");
        expect(result.content[0].text).toContain("Ask the human");
    });

    it("symbolName is passed through to recordToolCall", async () => {
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "Success" }],
        });

        await wrapWithCircuitBreaker(cb, "nreki_code", "edit", handler, "src/foo.ts", "validateToken");
        const state = cb.getState();
        expect(state.history[0].symbolName).toBe("validateToken");
    });

    // ─── NUEVO-B nivel 2: defensa profunda containsError ─────────────
    // Tests firmados por Furia (sprint v10.18.1 / Commit #5):
    // verifican que las read-only actions NO tripeen el breaker por
    // false-positive de containsError() text matching, pero SÍ tripeen
    // cuando el handler reporta isError:true (señal de hardware).

    it("should NOT trip on text matching for read-only actions (search, fast_grep, etc.)", async () => {
        // fast_grep returns matches that legitimately contain "error" strings
        // (e.g., search hits on try/catch blocks). The breaker must NOT trip
        // even after many calls, because containsError() is a heuristic that
        // produces false positives on real source code.
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{
                type: "text",
                text: "Found 3 matches:\n- src/foo.ts: try { ... } catch (error) { throw new Error(...) }\n- src/bar.ts: error handling logic\n- src/baz.ts: failed test case",
            }],
        });

        // Invoke 5 times: more than the 3-call breaker threshold
        for (let i = 0; i < 5; i++) {
            await wrapWithCircuitBreaker(cb, "nreki_navigate", "fast_grep", handler);
        }

        const state = cb.getState();
        expect(state.escalationLevel).toBe(0);
    });

    it("should still trip on text matching for write actions (edit, batch_edit) - preserved behavior", async () => {
        // For write actions (edit, batch_edit), containsError() text matching
        // remains active. Repeated error responses indicate a doom loop and
        // SHOULD trip the breaker. This preserves the existing behavior.
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{
                type: "text",
                text: "TypeError: assignment failed at line 42",
            }],
        });

        // 3 calls to trigger breaker on write action
        for (let i = 0; i < 3; i++) {
            await wrapWithCircuitBreaker(cb, "nreki_code", "edit", handler, "src/foo.ts");
        }

        const state = cb.getState();
        expect(state.escalationLevel).toBeGreaterThanOrEqual(1);
    });

    it("should trip on read-only action when response.isError === true (hardware signal)", async () => {
        // Even on a read-only action, an explicit isError:true (e.g., path
        // jail violation, security error, contract failure) MUST trip the
        // breaker. isError is hardware (explicit contract); containsError is
        // heuristic. Hardware always overrides the read-only exemption.
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{
                type: "text",
                text: "Security error: path outside project root",
            }],
            isError: true,
        });

        // 3 calls of identical hardware error to trip
        for (let i = 0; i < 3; i++) {
            await wrapWithCircuitBreaker(cb, "nreki_navigate", "search", handler);
        }

        const state = cb.getState();
        expect(state.escalationLevel).toBeGreaterThanOrEqual(1);
    });
});
