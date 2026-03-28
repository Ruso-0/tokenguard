/**
 * stress.test.ts - Stress tests for NREKI edge cases.
 *
 * 10 scenarios covering:
 * 1. Empty file
 * 2. Huge 500KB TypeScript file
 * 3. Binary data (non-UTF-8)
 * 4. Unicode / emoji content
 * 5. Minified 50KB JavaScript (single line)
 * 6. File that is 100% comments
 * 7. Deeply nested functions (20 levels)
 * 8. Concurrent 50-file indexing
 * 9. Malformed / invalid syntax
 * 10. Repeated 100x indexing of same file
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import { NrekiDB } from "../src/database.js";
import {
    AdvancedCompressor,
    preprocess,
    scoreTokens,
    filterTokens,
} from "../src/compressor.js";
import { PreToolUseHook } from "../src/hooks/preToolUse.js";
import { Embedder } from "../src/embedder.js";

// ─── Shared Fixtures ────────────────────────────────────────────────

const TMP_DIR = path.join(os.tmpdir(), `tg-stress-${Date.now()}`);

beforeAll(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
    // Recursive cleanup
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

/** Write a temp file and return its path. */
function tmpFile(name: string, content: string | Buffer): string {
    const fp = path.join(TMP_DIR, name);
    fs.writeFileSync(fp, content);
    return fp;
}

// ─── 1. Empty File ──────────────────────────────────────────────────

describe("Stress: Empty file", () => {
    it("preprocess handles empty string", () => {
        const { cleaned, removed } = preprocess("", "empty.ts");
        expect(cleaned).toBe("");
        expect(removed).toBe(0);
    });

    it("scoreTokens handles empty string", () => {
        const scored = scoreTokens("", 0.5);
        expect(scored).toEqual([]);
    });

    it("filterTokens handles empty scored array", () => {
        const result = filterTokens([], "aggressive");
        expect(result).toBe("");
    });

    it("PreToolUseHook handles empty file", () => {
        const fp = tmpFile("empty.ts", "");
        const hook = new PreToolUseHook({ fileSizeThreshold: 0, tokenThreshold: 0 });
        const result = hook.evaluateFileRead(fp);
        // Empty file = 0 bytes, should not intercept
        expect(result.shouldIntercept).toBe(false);
    });

    it("database handles empty content hash", () => {
        const db = new NrekiDB(path.join(TMP_DIR, "empty-test.db"));
        return db.initialize().then(() => {
            const hash = db.hashContent("");
            expect(hash).toBeTruthy();
            expect(hash.length).toBe(64); // SHA-256 hex
            db.close();
        });
    });
});

// ─── 2. Huge 500KB TypeScript File ──────────────────────────────────

describe("Stress: Huge 500KB TypeScript file", () => {
    const FUNCTION_TEMPLATE = `export function func_INDEX(arg: string): string {
  const result = arg.toUpperCase();
  if (result.length > 10) {
    return result.slice(0, 10);
  }
  return result;
}\n\n`;

    let hugeContent: string;
    let hugePath: string;

    beforeAll(() => {
        // Generate ~500KB of TypeScript
        const parts: string[] = ['import { Request } from "express";\n\n'];
        let idx = 0;
        while (parts.join("").length < 500_000) {
            parts.push(FUNCTION_TEMPLATE.replace(/INDEX/g, String(idx++)));
        }
        hugeContent = parts.join("");
        hugePath = tmpFile("huge.ts", hugeContent);
    });

    it("preprocess handles 500KB+ content without crash", () => {
        const { cleaned, removed } = preprocess(hugeContent, "huge.ts");
        expect(cleaned.length).toBeGreaterThan(0);
        expect(cleaned.length).toBeLessThanOrEqual(hugeContent.length);
        expect(removed).toBeGreaterThanOrEqual(0);
    });

    it("scoreTokens handles large input", () => {
        // Score just the first 10KB to keep test fast
        const slice = hugeContent.slice(0, 10_000);
        const scored = scoreTokens(slice, 0.5);
        expect(scored.length).toBeGreaterThan(100);
    });

    it("PreToolUseHook intercepts 500KB file", () => {
        const hook = new PreToolUseHook({ fileSizeThreshold: 1024, tokenThreshold: 50 });
        const result = hook.evaluateFileRead(hugePath);
        expect(result.shouldIntercept).toBe(true);
        expect(result.wastedTokens).toBeGreaterThan(1000);
    });

    it("Embedder.estimateTokens handles large content", () => {
        const tokens = Embedder.estimateTokens(hugeContent);
        expect(tokens).toBeGreaterThan(100_000);
    });
});

// ─── 3. Binary Data ─────────────────────────────────────────────────

describe("Stress: Binary data", () => {
    it("preprocess handles binary-like content gracefully", () => {
        const binary = Buffer.alloc(1024);
        for (let i = 0; i < 1024; i++) binary[i] = Math.floor(Math.random() * 256);
        const str = binary.toString("utf-8"); // will have replacement chars
        const { cleaned } = preprocess(str, "data.bin");
        expect(typeof cleaned).toBe("string");
    });

    it("scoreTokens handles binary gibberish", () => {
        const garbage = "ÿþ\x00\x01\x02ñ©®\uFFFD\uFFFD";
        const scored = scoreTokens(garbage, 0.5);
        expect(Array.isArray(scored)).toBe(true);
    });

    it("PreToolUseHook skips unsupported extensions", () => {
        const fp = tmpFile("data.bin", Buffer.alloc(5000));
        const hook = new PreToolUseHook({ fileSizeThreshold: 100, tokenThreshold: 10 });
        const result = hook.evaluateFileRead(fp);
        expect(result.shouldIntercept).toBe(false); // .bin not supported
    });

    it("database handles binary-ish content hashing", () => {
        const db = new NrekiDB(path.join(TMP_DIR, "binary-test.db"));
        return db.initialize().then(() => {
            const content = "\x00\x01\x02\xFF\xFE";
            const hash = db.hashContent(content);
            expect(hash.length).toBe(64);
            expect(db.fileNeedsUpdate("/binary.bin", content)).toBe(true);
            db.close();
        });
    });
});

// ─── 4. Unicode / Emoji Content ─────────────────────────────────────

describe("Stress: Unicode and emoji", () => {
    const UNICODE_CODE = `
// 日本語のコメント
export class データ処理 {
  private 名前: string = "テスト";

  async 実行(入力: string): Promise<string> {
    const 結果 = 入力 + " 🚀✨💻";
    console.log("処理中:", 結果);
    return 結果;
  }
}

// Emojis in identifiers and strings
const greeting = "Hello 世界 🌍";
const emoji_var = "🎉🎊🎈";
`;

    it("preprocess preserves unicode identifiers", () => {
        const { cleaned } = preprocess(UNICODE_CODE, "unicode.ts");
        expect(cleaned).toContain("データ処理");
        expect(cleaned).toContain("名前");
        expect(cleaned).not.toContain("console.log");
    });

    it("scoreTokens handles CJK + emoji tokens", () => {
        const scored = scoreTokens("データ 処理 🚀 実行 Hello", 0.5);
        const nonBreak = scored.filter(t => !t.lineBreak);
        expect(nonBreak.length).toBeGreaterThan(0);
        // CJK tokens should have high self-info (not in UNIGRAM_FREQ)
        const cjk = nonBreak.find(t => t.token === "データ");
        if (cjk) {
            expect(cjk.score).toBeGreaterThan(5);
        }
    });

    it("filterTokens preserves emoji in output", () => {
        const scored = scoreTokens("Hello 🚀 world 🌍 test", 0.5);
        const filtered = filterTokens(scored, "light");
        expect(filtered).toContain("🚀");
        expect(filtered).toContain("🌍");
    });

    it("database stores and retrieves unicode chunks", () => {
        const db = new NrekiDB(path.join(TMP_DIR, "unicode-test.db"));
        return db.initialize().then(() => {
            const embedding = new Float32Array(512).fill(0.1);
            db.insertChunk(
                "/test/unicode.ts",
                "[class] データ処理 { 実行() }",
                UNICODE_CODE,
                "class",
                1, 15,
                embedding
            );
            const results = db.searchHybrid(embedding, "データ処理", 5);
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].shorthand).toContain("データ処理");
            db.close();
        });
    });
});

// ─── 5. Minified 50KB JavaScript ────────────────────────────────────

describe("Stress: Minified JavaScript (single line)", () => {
    let minified: string;

    beforeAll(() => {
        // Generate ~50KB of minified JS (no newlines, no spaces)
        const parts: string[] = [];
        for (let i = 0; i < 2000; i++) {
            parts.push(`var a${i}=function(x){return x*${i}+${i}};`);
        }
        minified = parts.join("");
    });

    it("preprocess handles single-line minified JS", () => {
        const { cleaned } = preprocess(minified, "bundle.min.js");
        expect(cleaned.length).toBeGreaterThan(0);
    });

    it("scoreTokens handles extremely long single line", () => {
        // Take first 5KB to keep test fast
        const slice = minified.slice(0, 5_000);
        const scored = scoreTokens(slice, 0.5);
        expect(scored.length).toBeGreaterThan(0);
    });

    it("filterTokens handles minified content without crash", () => {
        const slice = minified.slice(0, 5_000);
        const scored = scoreTokens(slice, 0.7);
        const filtered = filterTokens(scored, "aggressive");
        // Minified JS is mostly protected tokens (operators, parens, numbers)
        // so filtering may not reduce size - but it should not crash
        expect(typeof filtered).toBe("string");
        expect(filtered.length).toBeGreaterThan(0);
        // Verify some content survived
        expect(filtered).toContain("var");
    });

    it("Embedder.estimateTokens on minified JS", () => {
        const tokens = Embedder.estimateTokens(minified);
        expect(tokens).toBeGreaterThan(10_000);
    });
});

// ─── 6. File That Is 100% Comments ──────────────────────────────────

describe("Stress: 100% comments file", () => {
    const ALL_COMMENTS = `
// This is a comment
// Another comment
/* Block comment
   spanning multiple
   lines */
/**
 * JSDoc comment
 * @param {string} name
 * @returns {void}
 */
// More comments
// Even more comments
/* final comment */
`;

    it("preprocess strips everything, leaving minimal content", () => {
        const { cleaned, removed } = preprocess(ALL_COMMENTS, "comments.ts");
        // Should remove virtually all content
        expect(removed).toBeGreaterThan(ALL_COMMENTS.length * 0.8);
        // Cleaned should be mostly empty (just whitespace/newlines)
        expect(cleaned.trim().length).toBeLessThan(10);
    });

    it("scoreTokens handles near-empty result from preprocessing", () => {
        const { cleaned } = preprocess(ALL_COMMENTS, "comments.ts");
        const scored = scoreTokens(cleaned, 0.5);
        // Should be very few or no tokens
        expect(scored.length).toBeLessThan(5);
    });

    it("Python docstring-only file", () => {
        const pyDocOnly = `
"""
This module does nothing.
It's entirely documentation.
"""

# Just comments
# More comments

'''
Triple single-quote docstring.
'''
`;
        const { cleaned, removed } = preprocess(pyDocOnly, "doconly.py");
        expect(removed).toBeGreaterThan(pyDocOnly.length * 0.7);
    });
});

// ─── 7. Deeply Nested Functions (20 levels) ─────────────────────────

describe("Stress: Deeply nested functions (20 levels)", () => {
    let nested: string;

    beforeAll(() => {
        const lines: string[] = [];
        for (let i = 0; i < 20; i++) {
            const indent = "  ".repeat(i);
            lines.push(`${indent}function level${i}() {`);
        }
        lines.push("  ".repeat(20) + "return 'deep';");
        for (let i = 19; i >= 0; i--) {
            lines.push("  ".repeat(i) + "}");
        }
        nested = lines.join("\n");
    });

    it("preprocess handles deeply nested code", () => {
        const { cleaned } = preprocess(nested, "nested.ts");
        expect(cleaned).toContain("function level0()");
        expect(cleaned).toContain("function level19()");
        expect(cleaned).toContain("'deep'");
    });

    it("scoreTokens handles nested function tokens", () => {
        const scored = scoreTokens(nested, 0.7);
        const functions = scored.filter(t => t.token === "function");
        expect(functions.length).toBe(20);
        // "function" keyword should be protected
        for (const f of functions) {
            expect(f.protected).toBe(true);
        }
    });

    it("filterTokens preserves function keywords at all levels", () => {
        const scored = scoreTokens(nested, 0.7);
        for (const level of ["light", "medium", "aggressive"] as const) {
            const filtered = filterTokens(scored, level);
            expect(filtered).toContain("function");
            expect(filtered).toContain("level0()");
        }
    });
});

// ─── 8. Concurrent 50-File Indexing ─────────────────────────────────

describe("Stress: Concurrent database operations", () => {
    it("should handle 50 chunk insertions in a single batch", async () => {
        const db = new NrekiDB(path.join(TMP_DIR, "concurrent-test.db"));
        await db.initialize();

        const chunks = Array.from({ length: 50 }, (_, i) => ({
            path: `/test/concurrent/file${i}.ts`,
            shorthand: `[func] handler${i}(req, res) { /* TG:L1-L10 */ }`,
            rawCode: `async function handler${i}(req: Request, res: Response) { res.json({ id: ${i} }); }`,
            nodeType: "func",
            startLine: 1,
            endLine: 10,
            embedding: new Float32Array(512).fill(0.01 * i),
        }));

        // Batch insert should not throw
        db.insertChunksBatch(chunks);

        const stats = db.getStats();
        expect(stats.total_chunks).toBe(50);

        // Search should work across all 50 chunks
        const queryEmb = new Float32Array(512).fill(0.25);
        const results = db.searchHybrid(queryEmb, "handler request response", 10);
        expect(results.length).toBeGreaterThan(0);
        expect(results.length).toBeLessThanOrEqual(10);

        db.close();
    });

    it("should handle rapid insert-delete-insert cycles", async () => {
        const db = new NrekiDB(path.join(TMP_DIR, "cycle-test.db"));
        await db.initialize();

        const embedding = new Float32Array(512).fill(0.5);

        for (let i = 0; i < 20; i++) {
            db.insertChunk(
                `/test/cycle.ts`,
                `[func] cycle${i}()`,
                `function cycle${i}() { return ${i}; }`,
                "func", 1, 3,
                embedding
            );
            if (i > 0 && i % 5 === 0) {
                db.clearChunks(`/test/cycle.ts`);
            }
        }

        // After clearing at i=5,10,15, remaining should be chunks from 16-19
        const stats = db.getStats();
        expect(stats.total_chunks).toBeGreaterThan(0);
        expect(stats.total_chunks).toBeLessThanOrEqual(20);

        db.close();
    });
});

// ─── 9. Malformed / Invalid Syntax ──────────────────────────────────

describe("Stress: Malformed syntax", () => {
    const MALFORMED_TS = `
export class { // missing name
  constructor( {
    this.broken =
  }

  async (( { {{
    return ===;
  }}}

  function 123invalid() {
    const = ;
    let if = while;
  }

  <></>  // JSX fragment in .ts

  @decorator(
  class Oops extends {
    #private broken
  }
}}}}}
`;

    it("preprocess doesn't crash on malformed code", () => {
        const { cleaned } = preprocess(MALFORMED_TS, "broken.ts");
        expect(typeof cleaned).toBe("string");
        expect(cleaned.length).toBeGreaterThan(0);
    });

    it("scoreTokens handles malformed tokens", () => {
        const scored = scoreTokens(MALFORMED_TS, 0.5);
        expect(Array.isArray(scored)).toBe(true);
        expect(scored.length).toBeGreaterThan(0);
    });

    it("filterTokens handles malformed scored tokens", () => {
        const scored = scoreTokens(MALFORMED_TS, 0.5);
        const result = filterTokens(scored, "aggressive");
        expect(typeof result).toBe("string");
    });

    it("preprocess handles unclosed string literals", () => {
        const unclosed = `const x = "unclosed string\nconst y = 'also unclosed\nconst z = \`template`;
        const { cleaned } = preprocess(unclosed, "unclosed.ts");
        expect(typeof cleaned).toBe("string");
    });

    it("preprocess handles null bytes", () => {
        const nullBytes = "const x = 1;\x00\x00\x00const y = 2;";
        const { cleaned } = preprocess(nullBytes, "nullbytes.ts");
        expect(typeof cleaned).toBe("string");
    });
});

// ─── 10. Repeated 100x Indexing of Same File ────────────────────────

describe("Stress: Repeated 100x indexing (idempotency)", () => {
    it("should handle 100 upserts of the same file", async () => {
        const db = new NrekiDB(path.join(TMP_DIR, "repeat-test.db"));
        await db.initialize();

        const content = "export function repeat() { return 42; }";
        const hash = db.hashContent(content);
        const embedding = new Float32Array(512).fill(0.42);

        for (let i = 0; i < 100; i++) {
            // Simulate re-indexing: clear + insert + upsert
            db.clearChunks("/test/repeat.ts");
            db.insertChunk(
                "/test/repeat.ts",
                "[func] repeat() { /* TG:L1-L3 */ }",
                content,
                "func", 1, 3,
                embedding
            );
            db.upsertFile("/test/repeat.ts", hash);
        }

        // Should have exactly 1 chunk (last insert after last clear)
        const stats = db.getStats();
        expect(stats.total_chunks).toBe(1);
        expect(stats.total_files).toBe(1);

        // File hash should match - no update needed
        expect(db.fileNeedsUpdate("/test/repeat.ts", content)).toBe(false);
        // Changed content should need update
        expect(db.fileNeedsUpdate("/test/repeat.ts", content + " // modified")).toBe(true);

        db.close();
    });

    it("should maintain consistent search after repeated re-indexing", async () => {
        const db = new NrekiDB(path.join(TMP_DIR, "repeat-search-test.db"));
        await db.initialize();

        const embedding = new Float32Array(512).fill(0.33);

        // Index the same file 50 times
        for (let i = 0; i < 50; i++) {
            db.clearChunks("/test/stable.ts");
            db.insertChunk(
                "/test/stable.ts",
                "[func] stableFunction(input)",
                "function stableFunction(input: string) { return input.trim(); }",
                "func", 1, 3,
                embedding
            );
        }

        // Search should find exactly 1 result for this path
        const results = db.searchVector(embedding, 10);
        const uniquePaths = new Set(results.map(r => r.path));
        expect(uniquePaths.has("/test/stable.ts")).toBe(true);

        // Keyword search should work
        const hybridResults = db.searchHybrid(embedding, "stableFunction input", 10);
        expect(hybridResults.length).toBeGreaterThan(0);

        db.close();
    });

    it("usage stats accumulate correctly over many calls", async () => {
        const db = new NrekiDB(path.join(TMP_DIR, "usage-stress-test.db"));
        await db.initialize();

        // Log 100 usage entries
        for (let i = 0; i < 100; i++) {
            db.logUsage("nreki_search", 10, 20, 50);
        }

        const stats = db.getUsageStats();
        expect(stats.tool_calls).toBe(100);
        expect(stats.total_input).toBe(1000);
        expect(stats.total_output).toBe(2000);
        expect(stats.total_saved).toBe(5000);

        db.close();
    });
});
