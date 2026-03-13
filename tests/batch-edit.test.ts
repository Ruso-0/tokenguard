/**
 * batch-edit.test.ts — Tests for ACID batch edit with reverse splice.
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
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
}

describe("Batch Edit ACID", () => {
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
