/**
 * v402-bugfixes.test.ts - Tests for v4.0.2 critical bugfixes.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ASTParser } from "../src/parser.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import { semanticEdit, applySemanticSplice, detectSignatureChange, type SpliceTarget } from "../src/semantic-edit.js";
import { extractSignature } from "../src/repo-map.js";
import { getFileSymbols } from "../src/ast-navigator.js";

let tmpDir: string;
let parser: ASTParser;
let sandbox: AstSandbox;

function writeTmp(name: string, content: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content, "utf-8");
    return p;
}

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-v402-"));
    parser = new ASTParser();
    sandbox = new AstSandbox();
    await parser.initialize();
    await sandbox.initialize();
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── BUG 1: prepare_refactor exhaustive search ─────────────────────

describe("BUG 1: searchRawCode exhaustive scan", () => {
    it("should find a symbol used inside function bodies via searchRawCode", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-raw-"));
        const file = path.join(dir, "service.ts");
        // AuthManager is used INSIDE the body, NOT in the signature
        fs.writeFileSync(file, [
            "function startService(): void {",
            "    const mgr = new AuthManager();",
            "    mgr.init();",
            "}",
        ].join("\n"));

        const { NrekiEngine } = await import("../src/engine.js");
        const engine = new NrekiEngine({
            dbPath: path.join(dir, "test.db"),
            watchPaths: [dir],
        });
        await engine.initialize();
        await engine.indexFile(file);

        // searchFilesBySymbol should find it (raw_code scan)
        const results = await engine.searchFilesBySymbol("AuthManager");
        expect(results.length).toBeGreaterThan(0);

        // Regular BM25 search on shorthand might NOT find it (shorthand strips body)
        // This is the bug we fixed - searchFilesBySymbol is the exhaustive fallback

        engine.shutdown();
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

// ─── BUG 3: indexOf wrong function with duplicates ──────────────────

describe("BUG 3: applySemanticSplice local window search", () => {
    it("should edit the second duplicate function when they are far apart", () => {
        // Create two identical functions >500 bytes apart so the local window
        // around the second one excludes the first
        const filler = "    // " + "x".repeat(600) + "\n";
        const content = [
            "class A {",
            "    reset() {",
            "        return 0;",
            "    }",
            filler.trimEnd(),
            "}",
            "",
            "class B {",
            "    reset() {",
            "        return 0;",
            "    }",
            "}",
        ].join("\n");

        const rawCode = "reset() {\n        return 0;\n    }";
        // The second reset starts at the position of class B's reset
        const secondResetStart = content.indexOf("reset", content.indexOf("class B"));
        const secondResetEnd = secondResetStart + rawCode.length;

        const target: SpliceTarget = {
            // Simulate a slightly wrong AST offset (off by 3 bytes)
            startIndex: secondResetStart + 3,
            endIndex: secondResetEnd + 3,
            rawCode,
            symbolName: "reset",
            startLine: 9,
        };

        const { newContent: result } = applySemanticSplice(
            content,
            target,
            "reset() {\n        return 42;\n    }",
        );

        // Class A's reset should still return 0
        const classBPos = result.indexOf("class B");
        const classASection = result.substring(0, classBPos);
        expect(classASection).toContain("return 0");
        expect(classASection).not.toContain("return 42");
        // Class B's reset should now return 42
        const classBSection = result.substring(classBPos);
        expect(classBSection).toContain("return 42");
    });
});

// ─── BUG 4: extractSignature with { inside strings ──────────────────

describe("BUG 4: extractSignature string-safe", () => {
    it("should not truncate at { inside a string literal", () => {
        const code = `function log(msg = "{") {\n    return msg;\n}`;
        const sig = extractSignature(code);
        expect(sig).toBe(`function log(msg = "{")`);
    });

    it("should not truncate at { inside a single-quoted string", () => {
        const code = `function log(msg = '{') {\n    return msg;\n}`;
        const sig = extractSignature(code);
        expect(sig).toBe(`function log(msg = '{')`);
    });

    it("should not truncate at { inside a template literal", () => {
        const code = "function log(msg = `{`) {\n    return msg;\n}";
        const sig = extractSignature(code);
        expect(sig).toBe("function log(msg = `{`)");
    });

    it("should handle escaped quotes inside strings", () => {
        const code = `function log(msg = "\\"{}") {\n    return msg;\n}`;
        const sig = extractSignature(code);
        expect(sig).toBe(`function log(msg = "\\"{}")`);
    });

    it("should still work for normal functions without strings", () => {
        const code = `function add(a: number, b: number): number {\n    return a + b;\n}`;
        const sig = extractSignature(code);
        expect(sig).toBe("function add(a: number, b: number): number");
    });

    it("should strip one-line function bodies", () => {
        const sig = extractSignature("export function foo(): number { return 1; }");
        expect(sig).toBe("export function foo(): number");
    });

    it("should strip one-line arrow expression bodies", () => {
        const sig = extractSignature("const x = () => 1");
        expect(sig).toBe("const x = () =>");
    });

    it("should not cut at nested arrow types inside parameters", () => {
        expect(detectSignatureChange(
            "const x = (cb: () => number) => cb()",
            "const x = (cb: () => number) => cb2()",
        )).toBe(false);
    });

    it("should preserve generic arrow signatures", () => {
        const sig = extractSignature("const x = <T,>(v: T) => v");
        expect(sig).toBe("const x = <T,>(v: T) =>");
    });

    it("should not mark one-line body-only edits as topology changes", async () => {
        const file = writeTmp("one-line-topology.ts", "export function foo(): number { return 1; }\n");

        const result = await semanticEdit(
            file,
            "foo",
            "export function foo(): number { return 2; }",
            parser,
            sandbox,
            tmpDir,
            "replace",
            true,
        );

        expect(result.success).toBe(true);
        expect(result.topologyChanged).toBe(false);
    });

    it("should expose stripped one-line signatures through ast-navigator", async () => {
        const file = writeTmp("navigator-one-line.ts", "export function foo(): number { return 1; }\nconst x = () => 1;\n");

        const symbols = await getFileSymbols(file, parser, tmpDir);
        const foo = symbols.find(s => s.name === "foo");
        const x = symbols.find(s => s.name === "x");

        expect(foo?.signature).toBe("export function foo(): number");
        expect(x?.signature).toBe("const x = () =>");
    });
});
