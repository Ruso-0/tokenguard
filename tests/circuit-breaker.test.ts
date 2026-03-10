/**
 * circuit-breaker.test.ts — Tests for infinite loop detection.
 *
 * Covers:
 * - Same error 3x → trips
 * - Different errors → does NOT trip
 * - Same file written 5x → trips
 * - Write→test→fail pattern 3x → trips
 * - Reset clears state
 * - Stats returns correct counts
 * - History ring buffer caps at 50
 * - Error hashing and detection
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
    CircuitBreaker,
    hashError,
    containsError,
} from "../src/circuit-breaker.js";

// ─── Error Hashing ──────────────────────────────────────────────────

describe("hashError", () => {
    it("should produce a 16-char hex hash", () => {
        const hash = hashError("TypeError: Cannot read property 'foo'");
        expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });

    it("should produce the same hash for errors differing only in line numbers", () => {
        const a = hashError("Error at src/foo.ts:42:10 — something broke");
        const b = hashError("Error at src/foo.ts:99:3 — something broke");
        expect(a).toBe(b);
    });

    it("should produce different hashes for genuinely different errors", () => {
        const a = hashError("TypeError: Cannot read property 'foo'");
        const b = hashError("ReferenceError: bar is not defined");
        expect(a).not.toBe(b);
    });

    it("should normalize ANSI codes", () => {
        const plain = hashError("Error: something failed");
        const ansi = hashError("\x1b[31mError: something failed\x1b[0m");
        expect(plain).toBe(ansi);
    });

    it("should normalize memory addresses", () => {
        const a = hashError("Segfault at 0xDEADBEEF");
        const b = hashError("Segfault at 0x12345678");
        expect(a).toBe(b);
    });
});

// ─── Error Detection ────────────────────────────────────────────────

describe("containsError", () => {
    it("should detect TypeScript errors", () => {
        expect(containsError("error TS2345: Argument of type...")).toBe(true);
    });

    it("should detect Node errors", () => {
        expect(containsError("TypeError: Cannot read properties of undefined")).toBe(true);
    });

    it("should detect npm errors", () => {
        expect(containsError("npm ERR! code ELIFECYCLE")).toBe(true);
    });

    it("should detect test failures", () => {
        expect(containsError("FAIL tests/foo.test.ts")).toBe(true);
    });

    it("should detect build failures", () => {
        expect(containsError("Build failed with 3 errors")).toBe(true);
    });

    it("should NOT detect clean output", () => {
        expect(containsError("All tests passed\n214 tests, 0 failures")).toBe(false);
    });

    it("should NOT detect normal log output", () => {
        expect(containsError("Server started on port 3000\nReady")).toBe(false);
    });
});

// ─── Circuit Breaker ────────────────────────────────────────────────

describe("CircuitBreaker", () => {
    let cb: CircuitBreaker;

    beforeEach(() => {
        cb = new CircuitBreaker();
    });

    // ── Pattern 1: Same error repeated ──

    describe("Pattern 1: same error repeated", () => {
        it("should trip after 3 identical errors", () => {
            const error = "TypeError: Cannot read property 'foo' of undefined";

            const r1 = cb.recordToolCall("bash", error, "src/auth.ts");
            expect(r1.tripped).toBe(false);

            const r2 = cb.recordToolCall("bash", error, "src/auth.ts");
            expect(r2.tripped).toBe(false);

            const r3 = cb.recordToolCall("bash", error, "src/auth.ts");
            expect(r3.tripped).toBe(true);
            expect(r3.reason).toContain("Same error repeated");
            expect(r3.reason).toContain("src/auth.ts");
            expect(r3.reason).toContain("ask the human");
        });

        it("should NOT trip with 3 different errors", () => {
            cb.recordToolCall("bash", "TypeError: foo is undefined");
            cb.recordToolCall("bash", "ReferenceError: bar is not defined");
            const r = cb.recordToolCall("bash", "SyntaxError: unexpected token");
            expect(r.tripped).toBe(false);
        });

        it("should trip even when same error has different line numbers", () => {
            cb.recordToolCall("bash", "TypeError: Cannot read 'x' at file.ts:10:5");
            cb.recordToolCall("bash", "TypeError: Cannot read 'x' at file.ts:20:8");
            const r = cb.recordToolCall("bash", "TypeError: Cannot read 'x' at file.ts:35:2");
            expect(r.tripped).toBe(true);
        });
    });

    // ── Pattern 2: Same file written repeatedly ──

    describe("Pattern 2: same file written repeatedly", () => {
        it("should trip after 5 writes to the same file", () => {
            for (let i = 0; i < 4; i++) {
                const r = cb.recordToolCall("write", "ok", "src/utils.ts");
                expect(r.tripped).toBe(false);
            }
            const r5 = cb.recordToolCall("write", "ok", "src/utils.ts");
            expect(r5.tripped).toBe(true);
            expect(r5.reason).toContain("src/utils.ts");
            expect(r5.reason).toContain("modified 5 times");
        });

        it("should NOT trip with writes to different files", () => {
            cb.recordToolCall("write", "ok", "src/a.ts");
            cb.recordToolCall("write", "ok", "src/b.ts");
            cb.recordToolCall("write", "ok", "src/c.ts");
            cb.recordToolCall("write", "ok", "src/d.ts");
            const r = cb.recordToolCall("write", "ok", "src/e.ts");
            expect(r.tripped).toBe(false);
        });
    });

    // ── Pattern 3: Write→Test→Fail cycle ──

    describe("Pattern 3: write→test→fail cycle", () => {
        it("should trip after 3 write→test→fail cycles", () => {
            // Use different errors each cycle so Pattern 1 doesn't trigger first
            for (let i = 0; i < 3; i++) {
                cb.recordToolCall("write", "ok", `src/file${i}.ts`);
                cb.recordToolCall("bash", "running tests...");
                cb.recordToolCall("bash", `FAIL tests/auth.test.ts\nTypeError: variant ${i}`);
            }

            const state = cb.getState();
            expect(state.tripped).toBe(true);
            expect(state.tripReason).toContain("cycle detected");
        });

        it("should NOT trip with successful test runs between writes", () => {
            // Use different files so Pattern 2 doesn't trigger
            for (let i = 0; i < 5; i++) {
                cb.recordToolCall("write", "ok", `src/module${i}.ts`);
                cb.recordToolCall("bash", "All tests passed. 214 tests, 0 failures");
            }
            const state = cb.getState();
            expect(state.tripped).toBe(false);
        });
    });

    // ── Reset ──

    describe("reset", () => {
        it("should clear tripped state", () => {
            const error = "TypeError: same error";
            cb.recordToolCall("bash", error);
            cb.recordToolCall("bash", error);
            cb.recordToolCall("bash", error);

            expect(cb.getState().tripped).toBe(true);

            cb.reset();

            expect(cb.getState().tripped).toBe(false);
            expect(cb.getState().tripReason).toBe(null);
            expect(cb.getState().consecutiveFailures).toBe(0);
        });

        it("should allow recording new calls after reset", () => {
            const error = "TypeError: same error";
            cb.recordToolCall("bash", error);
            cb.recordToolCall("bash", error);
            cb.recordToolCall("bash", error);

            cb.reset();

            // Should be able to record without immediately tripping
            const r = cb.recordToolCall("bash", "All tests passed");
            expect(r.tripped).toBe(false);
        });
    });

    // ── Stats ──

    describe("getStats", () => {
        it("should track total tool calls", () => {
            cb.recordToolCall("bash", "ok");
            cb.recordToolCall("write", "ok", "src/foo.ts");
            cb.recordToolCall("bash", "ok");

            const stats = cb.getStats();
            expect(stats.totalToolCalls).toBe(3);
        });

        it("should track loops detected", () => {
            const error = "TypeError: same error";
            cb.recordToolCall("bash", error);
            cb.recordToolCall("bash", error);
            cb.recordToolCall("bash", error);

            const stats = cb.getStats();
            expect(stats.loopsDetected).toBe(1);
            expect(stats.loopsPrevented).toBe(1);
        });

        it("should estimate tokens saved when loop is detected", () => {
            const error = "TypeError: same error";
            cb.recordToolCall("bash", error);
            cb.recordToolCall("bash", error);
            cb.recordToolCall("bash", error);

            const stats = cb.getStats();
            expect(stats.estimatedTokensSaved).toBeGreaterThan(0);
        });

        it("should have a session start time", () => {
            const stats = cb.getStats();
            expect(stats.sessionStartTime).toBeLessThanOrEqual(Date.now());
            expect(stats.sessionStartTime).toBeGreaterThan(Date.now() - 60_000);
        });
    });

    // ── Ring Buffer ──

    describe("history ring buffer", () => {
        it("should not grow beyond 50 entries", () => {
            for (let i = 0; i < 80; i++) {
                cb.recordToolCall("bash", `output ${i}`);
            }

            expect(cb.getHistoryLength()).toBe(50);
        });

        it("should keep the most recent entries", () => {
            for (let i = 0; i < 60; i++) {
                cb.recordToolCall("bash", `output ${i}`);
            }

            const state = cb.getState();
            expect(state.history.length).toBe(50);
            // Total calls tracked in stats should still be 60
            expect(cb.getStats().totalToolCalls).toBe(60);
        });
    });

    // ── Consecutive Failures ──

    describe("consecutive failures tracking", () => {
        it("should count consecutive failures", () => {
            cb.recordToolCall("bash", "TypeError: foo");
            cb.recordToolCall("bash", "ReferenceError: bar");
            expect(cb.getState().consecutiveFailures).toBe(2);
        });

        it("should reset consecutive count on success", () => {
            cb.recordToolCall("bash", "TypeError: foo");
            cb.recordToolCall("bash", "TypeError: bar");
            cb.recordToolCall("bash", "All tests passed");
            expect(cb.getState().consecutiveFailures).toBe(0);
        });
    });

    // ── Stay tripped ──

    describe("tripped state persistence", () => {
        it("should stay tripped on subsequent checks", () => {
            const error = "TypeError: same error";
            cb.recordToolCall("bash", error);
            cb.recordToolCall("bash", error);
            cb.recordToolCall("bash", error);

            // Further calls should still return tripped
            const r = cb.recordToolCall("bash", "some other thing");
            expect(r.tripped).toBe(true);
        });
    });
});
