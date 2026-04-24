/**
 * batch-edit.test.ts - Tests for ACID batch edit with reverse splice.
 *
 * Covers:
 * - Multiple edits across multiple files applied atomically
 * - Rollback: syntax error in one file → no files modified
 * - Reverse splice: 2 edits in same file with correct offsets
 * - Overlapping edit detection and rejection
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { batchSemanticEdit, type BatchEditOp } from "../src/semantic-edit.js";
import { ASTParser } from "../src/parser.js";
import { AstSandbox } from "../src/ast-sandbox.js";

let tmpDir: string;
let parser: ASTParser;
let sandbox: AstSandbox;

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-batch-edit-"));
    parser = new ASTParser();
    sandbox = new AstSandbox();
    await parser.initialize();
    await sandbox.initialize();
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmp(name: string, content: string): string {
    const filePath = path.join(tmpDir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
}

describe("Batch Edit ACID", () => {
    it("should detect topology changes for relative paths", async () => {
        writeTmp("src/foo.ts", [
            "export function foo(a: string): string {",
            "    return a;",
            "}",
        ].join("\n"));

        const result = await batchSemanticEdit([{
            path: "src/foo.ts",
            symbol: "foo",
            new_code: "export function foo(a: number): number {\n    return a;\n}",
        }], parser, sandbox, tmpDir);

        expect(result.success).toBe(true);
        expect(result.topologyChanged).toBe(true);
    });

    it("should detect topology changes for absolute paths", async () => {
        const file = writeTmp("src/foo-absolute.ts", [
            "export function foo(a: string): string {",
            "    return a;",
            "}",
        ].join("\n"));

        const result = await batchSemanticEdit([{
            path: file,
            symbol: "foo",
            new_code: "export function foo(a: number): number {\n    return a;\n}",
        }], parser, sandbox, tmpDir);

        expect(result.success).toBe(true);
        expect(result.topologyChanged).toBe(true);
    });

    it("should not report topology changes for relative body-only edits", async () => {
        writeTmp("src/foo-body.ts", [
            "export function foo(a: string): string {",
            "    return a;",
            "}",
        ].join("\n"));

        const result = await batchSemanticEdit([{
            path: "src/foo-body.ts",
            symbol: "foo",
            new_code: "export function foo(a: string): string {\n    return a.toUpperCase();\n}",
        }], parser, sandbox, tmpDir);

        expect(result.success).toBe(true);
        expect(result.topologyChanged).toBe(false);
    });

    it("should apply multiple edits across multiple files atomically", async () => {
        const file1 = writeTmp("batch1.ts", [
            "function greet(name: string): string {",
            '    return "hello " + name;',
            "}",
        ].join("\n"));

        const file2 = writeTmp("batch2.ts", [
            "function add(a: number, b: number): number {",
            "    return a + b;",
            "}",
        ].join("\n"));

        const edits: BatchEditOp[] = [
            {
                path: file1,
                symbol: "greet",
                new_code: 'function greet(name: string): string {\n    return "hi " + name;\n}',
            },
            {
                path: file2,
                symbol: "add",
                new_code: "function add(a: number, b: number): number {\n    return a + b + 1;\n}",
            },
        ];

        const result = await batchSemanticEdit(edits, parser, sandbox, tmpDir);

        expect(result.success).toBe(true);
        expect(result.editCount).toBe(2);
        expect(result.fileCount).toBe(2);

        const content1 = fs.readFileSync(file1, "utf-8");
        const content2 = fs.readFileSync(file2, "utf-8");
        expect(content1).toContain('"hi "');
        expect(content2).toContain("a + b + 1");
    });

    it("should rollback ALL files if ONE has syntax error", async () => {
        const file1 = writeTmp("rollback1.ts", [
            "function alpha(): string {",
            '    return "a";',
            "}",
        ].join("\n"));

        const file2 = writeTmp("rollback2.ts", [
            "function beta(): number {",
            "    return 42;",
            "}",
        ].join("\n"));

        const originalContent1 = fs.readFileSync(file1, "utf-8");
        const originalContent2 = fs.readFileSync(file2, "utf-8");

        const edits: BatchEditOp[] = [
            {
                path: file1,
                symbol: "alpha",
                new_code: 'function alpha(): string {\n    return "updated";\n}',
            },
            {
                path: file2,
                symbol: "beta",
                // Invalid syntax: missing closing brace
                new_code: "function beta(): number {\n    return 99;\n",
            },
        ];

        const result = await batchSemanticEdit(edits, parser, sandbox, tmpDir);

        expect(result.success).toBe(false);
        expect(result.error).toContain("syntax error");

        // NEITHER file should have been modified
        expect(fs.readFileSync(file1, "utf-8")).toBe(originalContent1);
        expect(fs.readFileSync(file2, "utf-8")).toBe(originalContent2);
    });

    it("should handle 2 edits in the same file with bottom-up reverse splice", async () => {
        const file = writeTmp("same-file.ts", [
            "function first(): number {",
            "    return 1;",
            "}",
            "",
            "function second(): number {",
            "    return 2;",
            "}",
        ].join("\n"));

        const edits: BatchEditOp[] = [
            {
                path: file,
                symbol: "first",
                new_code: "function first(): number {\n    return 10;\n}",
            },
            {
                path: file,
                symbol: "second",
                new_code: "function second(): number {\n    return 20;\n}",
            },
        ];

        const result = await batchSemanticEdit(edits, parser, sandbox, tmpDir);

        expect(result.success).toBe(true);
        expect(result.editCount).toBe(2);
        expect(result.fileCount).toBe(1);

        const content = fs.readFileSync(file, "utf-8");
        expect(content).toContain("return 10;");
        expect(content).toContain("return 20;");
        expect(content).not.toContain("return 1;");
        expect(content).not.toContain("return 2;");
    });

    it("should detect and reject overlapping edits", async () => {
        const file = writeTmp("overlap.ts", [
            "class MyClass {",
            "    doStuff(): void {",
            "        console.log('stuff');",
            "    }",
            "}",
        ].join("\n"));

        const edits: BatchEditOp[] = [
            {
                path: file,
                symbol: "MyClass",
                new_code: "class MyClass {\n    doStuff(): void {\n        console.log('new');\n    }\n}",
            },
            {
                path: file,
                symbol: "doStuff",
                new_code: "    doStuff(): void {\n        console.log('other');\n    }",
            },
        ];

        const result = await batchSemanticEdit(edits, parser, sandbox, tmpDir);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Overlapping");
    });

    it("should return error when symbol not found", async () => {
        const file = writeTmp("notfound.ts", "function exists(): void {}");

        const edits: BatchEditOp[] = [
            {
                path: file,
                symbol: "nonexistent",
                new_code: "function nonexistent(): void {}",
            },
        ];

        const result = await batchSemanticEdit(edits, parser, sandbox, tmpDir);

        expect(result.success).toBe(false);
        expect(result.error).toContain("nonexistent");
        expect(result.error).toContain("not found");
    });

    it("should return error for empty edits array", async () => {
        const result = await batchSemanticEdit([], parser, sandbox, tmpDir);
        expect(result.success).toBe(false);
        expect(result.error).toContain("No edits");
    });
});

// ─── v10.14.0 Block 3: Multi-Patch Transactional ───

describe("Batch Edit ACID: Intra-Symbol Multi-Patching (Block 3)", () => {
    it("should accept multiple patches to the same symbol when all mode:\"patch\" and search_texts disjoint", async () => {
        const file = writeTmp("multipatch-happy.ts", [
            "export function processConfig(data: any) {",
            "    const host = 'localhost';",
            "    const port = 8080;",
            "    return { host, port };",
            "}"
        ].join("\n"));

        const edits: BatchEditOp[] = [
            {
                path: file, symbol: "processConfig", mode: "patch",
                search_text: "    const host = 'localhost';",
                replace_text: "    const host = '0.0.0.0';"
            },
            {
                path: file, symbol: "processConfig", mode: "patch",
                search_text: "    const port = 8080;",
                replace_text: "    const port = 443;"
            }
        ];

        const result = await batchSemanticEdit(edits, parser, sandbox, tmpDir);

        expect(result.success).toBe(true);
        expect(result.editCount).toBe(2);

        const content = fs.readFileSync(file, "utf-8");
        expect(content).toContain("const host = '0.0.0.0';");
        expect(content).toContain("const port = 443;");
    });

    it("should reject cross-patch corruption via ACID pre-check", async () => {
        const file = writeTmp("acid-precheck.ts", [
            "function secure() {",
            "    return true;",
            "}"
        ].join("\n"));

        const edits: BatchEditOp[] = [
            // P1 injects new content
            {
                path: file, symbol: "secure", mode: "patch",
                search_text: "return true;",
                replace_text: "return true;\n    // injected"
            },
            // P2 attempts to anchor to P1's injection — ACID pre-check rejects
            // because "// injected" does not exist in the ORIGINAL source
            {
                path: file, symbol: "secure", mode: "patch",
                search_text: "// injected",
                replace_text: "// compromised"
            }
        ];

        const result = await batchSemanticEdit(edits, parser, sandbox, tmpDir);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/ACID violation/i);
        expect(result.error).toMatch(/ORIGINAL source/i);

        // ACID: disk untouched
        const content = fs.readFileSync(file, "utf-8");
        expect(content).not.toContain("injected");
        expect(content).not.toContain("compromised");
    });

    it("should reject multi-edit with mixed modes (patch + replace)", async () => {
        const file = writeTmp("mixed-modes.ts", [
            "function mixed() {",
            "    console.log('A');",
            "}"
        ].join("\n"));

        const edits: BatchEditOp[] = [
            {
                path: file, symbol: "mixed", mode: "patch",
                search_text: "    console.log('A');",
                replace_text: "    console.log('X');"
            },
            {
                path: file, symbol: "mixed", mode: "replace",
                new_code: "function mixed() { console.log('OVERWRITE'); }"
            }
        ];

        const result = await batchSemanticEdit(edits, parser, sandbox, tmpDir);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/ALL edits to the same symbol must use mode:"patch"/i);
    });

    // STRESS — validates causal sequencing: P2 inherits P1's structural mutations.
    // Mechanism:
    //   1. ACID pre-check on P2 passes because "doB();" exists as substring in ORIGINAL chunk.
    //   2. In Phase C Limbo, P1 wraps doA/doB in try/catch (indent pushed from 4 to 8 spaces).
    //   3. P2 Tier 1 exact match finds "doB();" within "        doB();" — split/join preserves
    //      the 8-space prefix because it lives OUTSIDE the matched pattern.
    //   4. Result: "        doBetterB();" — causally consistent with the new nesting.
    // Regression signal: if test shows 4 spaces, either ACID or Phase C splice changed behavior.
    it("STRESS: should inherit structural mutations from preceding patches (causal sequencing)", async () => {
        const file = writeTmp("fuzzy-inherit.ts", [
            "function wrapMe() {",
            "    doA();",
            "    doB();",
            "}"
        ].join("\n"));

        const edits: BatchEditOp[] = [
            {
                path: file, symbol: "wrapMe", mode: "patch",
                search_text: "    doA();\n    doB();",
                replace_text: "    try {\n        doA();\n        doB();\n    } catch (e) {}"
            },
            {
                path: file, symbol: "wrapMe", mode: "patch",
                search_text: "doB();",
                replace_text: "doBetterB();"
            }
        ];

        const result = await batchSemanticEdit(edits, parser, sandbox, tmpDir);

        expect(result.success).toBe(true);
        const content = fs.readFileSync(file, "utf-8");
        expect(content).toContain("        doBetterB();");
        expect(content).not.toMatch(/    doB\(\);/);
    });

    // STRESS — verifies Block 3 moved the 80L guillotine INSIDE the Phase C micro-splice loop.
    // Setup: 2 patches at the same symbol. First is 1L (valid). Second is 85L (exceeds cap).
    // Total payload 86L (well below 500L global cap of LEY 4.5, so this isolates Phase C enforcement).
    // If the cap only fired on first iteration, this test would succeed with content mutated.
    it("STRESS: should enforce 80L payload cap on every patch in Phase C loop (per-iteration)", async () => {
        const lines = Array.from({ length: 60 }, (_, i) => "    const v" + i + " = " + i + ";").join("\n");
        const file = writeTmp("cap-per-patch.ts", "export function big() {\n" + lines + "\n}");

        const bigPayload = Array.from({ length: 85 }, () => "    // noise").join("\n");

        const edits: BatchEditOp[] = [
            {
                path: file, symbol: "big", mode: "patch",
                search_text: "    const v0 = 0;", replace_text: "    const v0 = 999;"
            },
            {
                path: file, symbol: "big", mode: "patch",
                search_text: "    const v1 = 1;", replace_text: bigPayload
            }
        ];

        const result = await batchSemanticEdit(edits, parser, sandbox, tmpDir);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/limit: 80L/i);

        // ACID: first patch was valid but transaction aborted — disk untouched
        const content = fs.readFileSync(file, "utf-8");
        expect(content).not.toContain("const v0 = 999;");
    });

    // STRESS — multi-patch + multi-chunk with reverse-offset ordering.
    // Top (earlier in file) has 2 patches clustered. Bottom (later) has 1 replace.
    // Reverse sort puts Bottom first. After Bottom is spliced, Top's original offsets
    // remain valid because Bottom is spatially AFTER Top.
    // If reverse sort regressed (ascending instead of descending), Top would splice first,
    // shifting virtualCode, then Bottom's stale endIndex would corrupt the result.
    it("STRESS: should correctly resolve offsets when mixing multi-patch and multi-chunk bottom-up", async () => {
        const file = writeTmp("complex-topology.ts", [
            "export class Top {",
            "    a() { return 1; }",
            "    b() { return 2; }",
            "}",
            "",
            "export class Bottom {",
            "    c() { return 3; }",
            "}"
        ].join("\n"));

        const edits: BatchEditOp[] = [
            {
                path: file, symbol: "Top", mode: "patch",
                search_text: "return 1;", replace_text: "return 10;"
            },
            {
                path: file, symbol: "Top", mode: "patch",
                search_text: "return 2;", replace_text: "return 20;"
            },
            {
                path: file, symbol: "Bottom", mode: "replace",
                new_code: "export class Bottom {\n    c() { return 300; }\n}"
            }
        ];

        const result = await batchSemanticEdit(edits, parser, sandbox, tmpDir);

        expect(result.success).toBe(true);
        const content = fs.readFileSync(file, "utf-8");
        expect(content).toContain("return 10;");
        expect(content).toContain("return 20;");
        expect(content).toContain("return 300;");
    });
});

