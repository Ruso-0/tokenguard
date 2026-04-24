/**
 * Unit tests for handleFastGrep.
 *
 * Uses a minimal mock engine (satisfying only the methods handleFastGrep calls)
 * so we can feed deterministic chunks without touching SQLite or disk.
 */

import { describe, it, expect } from "vitest";
import { handleFastGrep } from "./navigate.js";
import type { ChunkRecord } from "../database.js";
import type { RouterDependencies, NavigateParams } from "../router.js";

function mkChunk(partial: {
    path: string;
    raw_code: string;
    start_line: number;
    symbol_name: string;
}): ChunkRecord {
    return {
        id: 0,
        path: partial.path,
        shorthand: "",
        raw_code: partial.raw_code,
        node_type: "function_declaration",
        start_line: partial.start_line,
        end_line: partial.start_line + partial.raw_code.split("\n").length - 1,
        start_index: 0,
        end_index: partial.raw_code.length,
        symbol_name: partial.symbol_name,
    };
}

function mkDeps(chunks: ChunkRecord[]): RouterDependencies {
    const mockEngine = {
        initialize: async () => {},
        getProjectRoot: () => "/test",
        logUsage: () => {},
        fastGrep: async (query: string, limit: number) =>
            chunks.filter(c => c.raw_code.includes(query)).slice(0, limit).map(c => ({
                path: c.path,
                raw_code: c.raw_code,
                start_line: c.start_line,
                symbol_name: c.symbol_name,
            })),
    };
    return { engine: mockEngine } as unknown as RouterDependencies;
}

describe("handleFastGrep correctness", () => {
    const mockChunks: ChunkRecord[] = [
        mkChunk({
            path: "/test/file1.ts",
            symbol_name: "funcA",
            start_line: 10,
            raw_code: "export function funcA() {\n  const x = 1;\n  return x;\n}",
        }),
        mkChunk({
            path: "/test/file1.ts",
            symbol_name: "funcB",
            start_line: 20,
            raw_code: "export function funcB() {\n  export const y = 2;\n  return y;\n}",
        }),
        mkChunk({
            path: "/test/file2.ts",
            symbol_name: "funcC",
            start_line: 30,
            raw_code: "const nohit = \"other code\";\nexport const z = 3;",
        }),
    ];

    it("returns 'No matches found' when query has no matches", async () => {
        const params: NavigateParams = { action: "fast_grep", query: "NONEXISTENT_TOKEN" };
        const result = await handleFastGrep(params, mkDeps(mockChunks));
        expect(result.content[0].text).toContain("No matches found");
    });

    it("finds single-hit queries with correct line numbers", async () => {
        const params: NavigateParams = { action: "fast_grep", query: "funcA" };
        const result = await handleFastGrep(params, mkDeps(mockChunks));
        const text = result.content[0].text;
        expect(text).toContain("L10");
        expect(text).toContain("Found 1 match(es)");
    });

    it("finds multiple hits in the same chunk at different lines", async () => {
        const params: NavigateParams = { action: "fast_grep", query: "export" };
        const result = await handleFastGrep(params, mkDeps(mockChunks));
        const text = result.content[0].text;
        expect(text).toContain("L10");
        expect(text).toContain("L20");
        expect(text).toContain("L21");
        expect(text).toContain("L31");
        expect(text).toContain("Found 4 match(es)");
    });

    it("does NOT report duplicate hits on the same line", async () => {
        const dup = [mkChunk({
            path: "/test/dup.ts",
            symbol_name: "dup",
            start_line: 5,
            raw_code: "export export export;",
        })];
        const params: NavigateParams = { action: "fast_grep", query: "export" };
        const result = await handleFastGrep(params, mkDeps(dup));
        expect(result.content[0].text).toContain("Found 1 match(es)");
    });

    it("handles hits in the last line without trailing newline", async () => {
        const chunk = [mkChunk({
            path: "/test/noNl.ts",
            symbol_name: "tail",
            start_line: 1,
            raw_code: "line1\nline2\nexport const end = 1",
        })];
        const params: NavigateParams = { action: "fast_grep", query: "export" };
        const result = await handleFastGrep(params, mkDeps(chunk));
        const text = result.content[0].text;
        expect(text).toContain("L3");
        expect(text).toContain("export const end = 1");
    });

    it("handles multi-line queries", async () => {
        const params: NavigateParams = { action: "fast_grep", query: "1;\n  return" };
        const result = await handleFastGrep(params, mkDeps(mockChunks));
        expect(result.content[0].text).toContain("match spans multiple lines");
    });
});
