/**
 * terminal-filter.test.ts — Tests for terminal entropy filter.
 *
 * Covers:
 * - ANSI code stripping
 * - Repeated line deduplication
 * - Repeated block deduplication
 * - node_modules stack trace collapsing
 * - Error summary extraction (TS, Node, npm, Jest/Vitest)
 * - Full pipeline: filterTerminalOutput
 * - Empty / clean input edge cases
 * - Token savings calculation
 */

import { describe, it, expect } from "vitest";
import {
    stripAnsiCodes,
    deduplicateLines,
    filterNodeModules,
    extractErrorSummary,
    filterTerminalOutput,
} from "../src/terminal-filter.js";

// ─── ANSI Stripping ─────────────────────────────────────────────────

describe("stripAnsiCodes", () => {
    it("should remove SGR color codes", () => {
        const input = "\x1b[31mError\x1b[0m: something failed";
        expect(stripAnsiCodes(input)).toBe("Error: something failed");
    });

    it("should remove multiple ANSI sequences", () => {
        const input = "\x1b[1m\x1b[36m PASS \x1b[39m\x1b[22m tests/foo.test.ts";
        expect(stripAnsiCodes(input)).toBe(" PASS  tests/foo.test.ts");
    });

    it("should handle text without ANSI codes", () => {
        const input = "plain text output";
        expect(stripAnsiCodes(input)).toBe("plain text output");
    });

    it("should handle empty string", () => {
        expect(stripAnsiCodes("")).toBe("");
    });

    it("should strip complex color sequences", () => {
        const input = "\x1b[38;5;196mred\x1b[0m \x1b[48;2;0;255;0mgreen bg\x1b[0m";
        expect(stripAnsiCodes(input)).toBe("red green bg");
    });
});

// ─── Line Deduplication ─────────────────────────────────────────────

describe("deduplicateLines", () => {
    it("should collapse line repeated 50 times", () => {
        const line = "Error: Cannot find module 'foo'";
        const lines = Array(50).fill(line);
        const result = deduplicateLines(lines);

        expect(result.length).toBe(2);
        expect(result[0]).toBe(line);
        expect(result[1]).toContain("repeated 49 more times");
    });

    it("should keep lines that appear only once or twice", () => {
        const lines = ["line A", "line B", "line B", "line C"];
        const result = deduplicateLines(lines);

        expect(result).toContain("line A");
        expect(result).toContain("line B");
        expect(result).toContain("line C");
        expect(result.join("\n")).not.toContain("repeated");
    });

    it("should collapse repeating blocks of 3+ lines", () => {
        const block = ["error in file.ts", "  at line 42", "  caused by: null"];
        // Repeat the block 5 times
        const lines = [...block, ...block, ...block, ...block, ...block];
        const result = deduplicateLines(lines);

        // Should show block once + repetition note
        expect(result.join("\n")).toContain("block repeated");
        expect(result.length).toBeLessThan(lines.length);
    });

    it("should handle empty input", () => {
        expect(deduplicateLines([])).toEqual([]);
    });

    it("should handle all unique lines", () => {
        const lines = ["a", "b", "c", "d", "e"];
        const result = deduplicateLines(lines);
        expect(result).toEqual(lines);
    });
});

// ─── Node Modules Filtering ────────────────────────────────────────

describe("filterNodeModules", () => {
    it("should collapse node_modules stack frames", () => {
        const lines = [
            "Error: Something broke",
            "    at myFunction (src/app.ts:42:10)",
            "    at Object.<anonymous> (node_modules/express/lib/router.js:100:5)",
            "    at next (node_modules/express/lib/router.js:200:10)",
            "    at Layer.handle (node_modules/express/lib/layer.js:95:5)",
            "    at trim (node_modules/express/lib/router.js:300:12)",
            "    at route (node_modules/express/lib/router.js:400:15)",
            "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
        ];
        const result = filterNodeModules(lines);

        // Error line and user frame kept
        expect(result).toContain("Error: Something broke");
        expect(result).toContain("    at myFunction (src/app.ts:42:10)");

        // node_modules frames collapsed
        const collapsed = result.find(l => l.includes("frames in node_modules"));
        expect(collapsed).toBeDefined();

        // Much shorter than original
        expect(result.length).toBeLessThan(lines.length);
    });

    it("should keep all lines when no node_modules present", () => {
        const lines = [
            "Error: bug",
            "    at foo (src/a.ts:1:1)",
            "    at bar (src/b.ts:2:2)",
        ];
        const result = filterNodeModules(lines);
        expect(result).toEqual(lines);
    });

    it("should collapse 500 node_modules frames", () => {
        const lines = ["TypeError: undefined is not a function"];
        for (let i = 0; i < 500; i++) {
            lines.push(`    at mod${i} (node_modules/lib${i % 10}/index.js:${i}:1)`);
        }
        const result = filterNodeModules(lines);

        expect(result.length).toBeLessThanOrEqual(3);
        expect(result.join("\n")).toContain("500 frames");
    });
});

// ─── Error Summary Extraction ───────────────────────────────────────

describe("extractErrorSummary", () => {
    it("should extract TypeScript errors", () => {
        const text = [
            "src/app.ts(42,5): error TS2345: Argument of type 'string' is not assignable",
            "src/utils.ts(10,1): error TS2304: Cannot find name 'foo'",
        ].join("\n");

        const summary = extractErrorSummary(text);
        expect(summary.errorCount).toBe(2);
        expect(summary.uniqueErrors[0]).toContain("TS2304");
        expect(summary.uniqueErrors[1]).toContain("TS2345");
        expect(summary.firstError).toContain("TS2345");
        expect(summary.affectedFiles).toContain("src/app.ts");
        expect(summary.affectedFiles).toContain("src/utils.ts");
    });

    it("should extract Node.js runtime errors", () => {
        const text = "TypeError: Cannot read properties of null (reading 'map')";
        const summary = extractErrorSummary(text);

        expect(summary.errorCount).toBe(1);
        expect(summary.firstError).toContain("TypeError");
    });

    it("should extract npm errors", () => {
        const text = [
            "npm ERR! code ELIFECYCLE",
            "npm ERR! errno 1",
            "npm ERR! tokenguard@1.0.0 test: vitest run",
        ].join("\n");

        const summary = extractErrorSummary(text);
        expect(summary.errorCount).toBeGreaterThan(0);
        expect(summary.uniqueErrors.some(e => e.startsWith("npm:"))).toBe(true);
    });

    it("should extract Jest/Vitest test failures", () => {
        const text = [
            "FAIL tests/engine.test.ts",
            "FAIL tests/audit.test.ts",
        ].join("\n");

        const summary = extractErrorSummary(text);
        expect(summary.errorCount).toBe(2);
        expect(summary.affectedFiles).toContain("tests/engine.test.ts");
        expect(summary.affectedFiles).toContain("tests/audit.test.ts");
    });

    it("should handle output with no errors", () => {
        const text = "All tests passed!\n3 test suites, 42 tests";
        const summary = extractErrorSummary(text);

        expect(summary.errorCount).toBe(0);
        expect(summary.firstError).toBeNull();
        expect(summary.summary).toContain("No structured errors");
    });
});

// ─── Normalization-Based Deduplication ───────────────────────────────

describe("normalization-based deduplication", () => {
    it("deduplicates stack traces with different line numbers", () => {
        const input = [
            "at Object.<anonymous> (/app/src/auth.ts:14:2)",
            "at Object.<anonymous> (/app/src/auth.ts:15:3)",
            "at Object.<anonymous> (/app/src/auth.ts:16:7)",
        ].join("\n");
        const result = filterTerminalOutput(input);
        expect(result.filtered_text.split("\n").length).toBe(1);
    });

    it("deduplicates lines with different memory addresses", () => {
        const input = [
            "Error at 0xF4A2B3: segfault",
            "Error at 0xD1C2E3: segfault",
        ].join("\n");
        const result = filterTerminalOutput(input);
        expect(result.filtered_text.split("\n").length).toBe(1);
    });

    it("deduplicates lines with different single line numbers", () => {
        const input = [
            "  at handler (/app/src/route.ts:10)",
            "  at handler (/app/src/route.ts:20)",
            "  at handler (/app/src/route.ts:30)",
        ].join("\n");
        const result = filterTerminalOutput(input);
        expect(result.filtered_text.split("\n").length).toBe(1);
    });

    it("keeps lines that differ in more than just numbers", () => {
        const input = [
            "at Object.<anonymous> (/app/src/auth.ts:14:2)",
            "at Object.<anonymous> (/app/src/user.ts:15:3)",
        ].join("\n");
        const result = filterTerminalOutput(input);
        expect(result.filtered_text.split("\n").length).toBe(2);
    });
});

// ─── Full Pipeline ──────────────────────────────────────────────────

describe("filterTerminalOutput", () => {
    it("should handle empty input", () => {
        const result = filterTerminalOutput("");
        expect(result.original_tokens).toBe(0);
        expect(result.filtered_tokens).toBe(0);
        expect(result.reduction_percent).toBe(0);
        expect(result.filtered_text).toBe("");
    });

    it("should handle whitespace-only input", () => {
        const result = filterTerminalOutput("   \n  \n  ");
        expect(result.filtered_text).toBe("");
    });

    it("should leave clean input mostly unchanged", () => {
        const clean = "Test passed\nAll 3 suites passed\n42 tests";
        const result = filterTerminalOutput(clean);

        expect(result.filtered_text).toContain("Test passed");
        expect(result.filtered_text).toContain("42 tests");
        // Minimal or no reduction for clean input
        expect(result.reduction_percent).toBeLessThanOrEqual(5);
    });

    it("should achieve high reduction on noisy npm error output", () => {
        // Simulate a noisy npm error: ANSI codes + repeated lines + node_modules
        const noisyLines: string[] = [];

        // ANSI-colored error header
        noisyLines.push("\x1b[31m\x1b[1mERROR\x1b[0m in src/app.ts:42:10");
        noisyLines.push("TypeError: Cannot read properties of null (reading 'foo')");

        // User's stack frame
        noisyLines.push("    at processData (src/app.ts:42:10)");

        // 100 node_modules frames
        for (let i = 0; i < 100; i++) {
            noisyLines.push(`    at step${i} (node_modules/some-lib/dist/index.js:${i * 10}:${i})`);
        }

        // Repeated warning 50 times
        const warning = "Warning: Each child in a list should have a unique key prop.";
        for (let i = 0; i < 50; i++) {
            noisyLines.push(warning);
        }

        const raw = noisyLines.join("\n");
        const result = filterTerminalOutput(raw);

        // Should achieve significant reduction
        expect(result.reduction_percent).toBeGreaterThanOrEqual(80);

        // Should still contain the actual error
        expect(result.filtered_text).toContain("TypeError");
        expect(result.filtered_text).toContain("src/app.ts");

        // node_modules frames should be collapsed
        expect(result.filtered_text).toContain("frames in node_modules");

        // Repeated warning should be collapsed
        expect(result.filtered_text).toContain("repeated");
    });

    it("should respect max_lines parameter", () => {
        const lines = Array.from({ length: 500 }, (_, i) => `unique line ${i}`);
        const raw = lines.join("\n");

        const result = filterTerminalOutput(raw, 50);
        const outputLines = result.filtered_text.split("\n");

        // Should not exceed max_lines + truncation message
        expect(outputLines.length).toBeLessThanOrEqual(52);
        expect(result.filtered_text).toContain("truncated");
    });

    it("should calculate token savings correctly", () => {
        const line = "Error: something broke in the application handler";
        const raw = Array(100).fill(line).join("\n");
        const result = filterTerminalOutput(raw);

        expect(result.original_tokens).toBeGreaterThan(0);
        expect(result.filtered_tokens).toBeLessThan(result.original_tokens);
        expect(result.reduction_percent).toBeGreaterThan(0);
        expect(result.reduction_percent).toBeLessThanOrEqual(100);
    });

    it("should handle mixed real errors and noise", () => {
        const lines = [
            "\x1b[31merror\x1b[0m TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
            "  src/utils.ts:15:3",
            "",
            // Noise: repeated blank-ish lines
            "    at Object.<anonymous> (node_modules/ts-node/src/index.ts:100:1)",
            "    at Module._compile (node:internal/modules/cjs/loader:1105:14)",
            "    at Module._extensions..js (node:internal/modules/cjs/loader:1159:10)",
            "",
            "\x1b[31merror\x1b[0m TS2304: Cannot find name 'bar'.",
            "  src/app.ts:42:7",
        ];

        const result = filterTerminalOutput(lines.join("\n"));

        // Should keep the real errors
        expect(result.filtered_text).toContain("TS2345");
        expect(result.filtered_text).toContain("TS2304");
        expect(result.filtered_text).toContain("src/utils.ts");
        expect(result.filtered_text).toContain("src/app.ts");

        // Error summary should capture both TS errors
        expect(result.error_summary.errorCount).toBe(2);
    });
});
