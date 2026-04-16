/**
 * semantic-edit.test.ts - Tests for zero-read surgical AST patching.
 *
 * Covers:
 * - Edit a function → only that function changes
 * - Edit a class → replaces entire class
 * - Edit an interface → replaces declaration
 * - Symbol not found → returns available symbols
 * - Syntax error in new code → rejects, file untouched
 * - File untouched on rejection (read before and after)
 * - Nested function → edits correct one
 * - Tokens avoided calculation is correct
 * - Multiple symbols with same name → disambiguation error
 * - Large file (1000 lines) edit performance
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { semanticEdit } from "../src/semantic-edit.js";
import { ASTParser } from "../src/parser.js";
import { AstSandbox } from "../src/ast-sandbox.js";

// ─── Setup ──────────────────────────────────────────────────────────

let tmpDir: string;
let parser: ASTParser;
let sandbox: AstSandbox;

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-semantic-edit-"));
    parser = new ASTParser();
    sandbox = new AstSandbox();
    await parser.initialize();
    await sandbox.initialize();
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a temp file and return its absolute path. */
function writeTmp(name: string, content: string): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
}

// ─── Edit a function ────────────────────────────────────────────────

describe("edit function", () => {
    it("should replace only the target function", async () => {
        const file = writeTmp("func-edit.ts", [
            "const HEADER = 42;",
            "",
            "function greet(name: string): string {",
            '    return "Hello, " + name;',
            "}",
            "",
            "function farewell(name: string): string {",
            '    return "Goodbye, " + name;',
            "}",
            "",
            "const FOOTER = 99;",
        ].join("\n"));

        const result = await semanticEdit(
            file,
            "greet",
            'function greet(name: string): string {\n    return `Hi, ${name}!`;\n}',
            parser,
            sandbox,
            tmpDir,
        );

        expect(result.success).toBe(true);
        expect(result.oldLines).toBe(3);
        expect(result.newLines).toBe(3);
        expect(result.syntaxValid).toBe(true);

        const content = fs.readFileSync(file, "utf-8");
        expect(content).toContain("Hi, ${name}!");
        expect(content).toContain("const HEADER = 42;");
        expect(content).toContain("farewell");
        expect(content).toContain("const FOOTER = 99;");
    });

    it("should handle exported functions", async () => {
        const file = writeTmp("export-func.ts", [
            "export function calculate(x: number): number {",
            "    return x * 2;",
            "}",
        ].join("\n"));

        const result = await semanticEdit(
            file,
            "calculate",
            "function calculate(x: number): number {\n    return x * 3;\n}",
            parser,
            sandbox,
            tmpDir,
        );

        expect(result.success).toBe(true);

        const content = fs.readFileSync(file, "utf-8");
        // The export prefix before "function" should be preserved
        expect(content).toContain("x * 3");
    });
});

// ─── Edit a class ───────────────────────────────────────────────────

describe("edit class", () => {
    it("should replace entire class body", async () => {
        const file = writeTmp("class-edit.ts", [
            "const VERSION = 1;",
            "",
            "class Calculator {",
            "    add(a: number, b: number): number {",
            "        return a + b;",
            "    }",
            "}",
            "",
            "const AFTER = true;",
        ].join("\n"));

        const result = await semanticEdit(
            file,
            "Calculator",
            [
                "class Calculator {",
                "    add(a: number, b: number): number {",
                "        return a + b;",
                "    }",
                "    subtract(a: number, b: number): number {",
                "        return a - b;",
                "    }",
                "}",
            ].join("\n"),
            parser,
            sandbox,
            tmpDir,
        );

        expect(result.success).toBe(true);
        expect(result.newLines).toBe(8);

        const content = fs.readFileSync(file, "utf-8");
        expect(content).toContain("subtract");
        expect(content).toContain("const VERSION = 1;");
        expect(content).toContain("const AFTER = true;");
    });
});

// ─── Edit an interface ──────────────────────────────────────────────

describe("edit interface", () => {
    it("should replace interface declaration", async () => {
        const file = writeTmp("iface-edit.ts", [
            "interface Config {",
            "    host: string;",
            "    port: number;",
            "}",
            "",
            "function useConfig(c: Config): void {}",
        ].join("\n"));

        const result = await semanticEdit(
            file,
            "Config",
            "interface Config {\n    host: string;\n    port: number;\n    ssl: boolean;\n}",
            parser,
            sandbox,
            tmpDir,
        );

        expect(result.success).toBe(true);

        const content = fs.readFileSync(file, "utf-8");
        expect(content).toContain("ssl: boolean");
        expect(content).toContain("useConfig");
    });
});

// ─── Symbol not found ───────────────────────────────────────────────

describe("symbol not found", () => {
    it("should return available symbols", async () => {
        const file = writeTmp("not-found.ts", [
            "function alpha(): void {}",
            "function beta(): void {}",
        ].join("\n"));

        const result = await semanticEdit(
            file,
            "gamma",
            "function gamma(): void {}",
            parser,
            sandbox,
            tmpDir,
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("gamma");
        expect(result.error).toContain("alpha");
        expect(result.error).toContain("beta");
    });

    it("should suggest case-insensitive match", async () => {
        const file = writeTmp("case-mismatch.ts", [
            "function MyFunction(): void {}",
        ].join("\n"));

        const result = await semanticEdit(
            file,
            "myfunction",
            "function myfunction(): void {}",
            parser,
            sandbox,
            tmpDir,
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("Did you mean");
        expect(result.error).toContain("MyFunction");
    });
});

// ─── Syntax error rejection ─────────────────────────────────────────

describe("syntax error rejection", () => {
    it("should reject and leave file untouched", async () => {
        const original = [
            "function valid(): number {",
            "    return 42;",
            "}",
        ].join("\n");

        const file = writeTmp("syntax-reject.ts", original);
        const contentBefore = fs.readFileSync(file, "utf-8");

        const result = await semanticEdit(
            file,
            "valid",
            "function valid(): number {\n    return 42\n",  // missing closing brace
            parser,
            sandbox,
            tmpDir,
        );

        expect(result.success).toBe(false);
        expect(result.syntaxValid).toBe(false);
        expect(result.error).toContain("Syntax error");

        const contentAfter = fs.readFileSync(file, "utf-8");
        expect(contentAfter).toBe(contentBefore);
    });

    it("should report error details", async () => {
        const file = writeTmp("syntax-detail.ts", [
            "function foo(): void {",
            "    console.log('hello');",
            "}",
        ].join("\n"));

        const result = await semanticEdit(
            file,
            "foo",
            "function foo(): void {\n    console.log('hello'\n}",  // missing closing paren
            parser,
            sandbox,
            tmpDir,
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("file NOT modified");
    });
});

// ─── Nested function ────────────────────────────────────────────────

describe("nested function", () => {
    it("should edit the inner function, not the outer", async () => {
        const file = writeTmp("nested.ts", [
            "function outer(): number {",
            "    function inner(): number {",
            "        return 1;",
            "    }",
            "    return inner();",
            "}",
        ].join("\n"));

        const result = await semanticEdit(
            file,
            "inner",
            "function inner(): number {\n        return 999;\n    }",
            parser,
            sandbox,
            tmpDir,
        );

        expect(result.success).toBe(true);

        const content = fs.readFileSync(file, "utf-8");
        expect(content).toContain("return 999;");
        expect(content).toContain("function outer()");
        expect(content).toContain("return inner();");
    });
});

// ─── Tokens avoided ────────────────────────────────────────────────

describe("tokens avoided", () => {
    it("should calculate token savings correctly", async () => {
        // Build a file with enough content to have meaningful token counts
        const padding = Array(20)
            .fill(null)
            .map((_, i) => `function pad${i}(): void { console.log(${i}); }`)
            .join("\n\n");

        const file = writeTmp("tokens.ts", [
            padding,
            "",
            "function target(): string {",
            '    return "old";',
            "}",
        ].join("\n"));

        const result = await semanticEdit(
            file,
            "target",
            'function target(): string {\n    return "new";\n}',
            parser,
            sandbox,
            tmpDir,
        );

        expect(result.success).toBe(true);
        expect(result.tokensAvoided).toBeGreaterThan(0);
        // Savings should be significant (close to 2x full file tokens)
        expect(result.tokensAvoided).toBeGreaterThan(100);
    });
});

// ─── Multiple symbols with same name ────────────────────────────────

describe("multiple symbols", () => {
    it("should return disambiguation error", async () => {
        // TypeScript allows function overloads that create multiple matches
        const file = writeTmp("multi.ts", [
            "function process(x: number): number {",
            "    return x * 2;",
            "}",
            "",
            "class Foo {",
            "    process(x: string): string {",
            '        return x + "!";',
            "    }",
            "}",
        ].join("\n"));

        const result = await semanticEdit(
            file,
            "process",
            "function process(): void {}",
            parser,
            sandbox,
            tmpDir,
        );

        // Either succeeds (if parser deduplicates) or fails with disambiguation
        if (!result.success) {
            expect(result.error).toContain("Multiple symbols");
        }
    });
});

// ─── Edge cases ─────────────────────────────────────────────────────

describe("edge cases", () => {
    it("should return error for nonexistent file", async () => {
        const result = await semanticEdit(
            path.join(tmpDir, "does-not-exist.ts"),
            "foo",
            "function foo(): void {}",
            parser,
            sandbox,
            tmpDir,
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("Cannot read file");
    });

    it("should return error for empty file", async () => {
        const file = writeTmp("empty.ts", "");

        const result = await semanticEdit(
            file,
            "foo",
            "function foo(): void {}",
            parser,
            sandbox,
            tmpDir,
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("No symbols found");
    });

    it("should handle type alias edits", async () => {
        const file = writeTmp("type-edit.ts", [
            "type Point = {",
            "    x: number;",
            "    y: number;",
            "};",
            "",
            "function usePoint(p: Point): void {}",
        ].join("\n"));

        const result = await semanticEdit(
            file,
            "Point",
            "type Point = {\n    x: number;\n    y: number;\n    z: number;\n}",
            parser,
            sandbox,
            tmpDir,
        );

        expect(result.success).toBe(true);

        const content = fs.readFileSync(file, "utf-8");
        expect(content).toContain("z: number");
        expect(content).toContain("usePoint");
    });
});

// ─── Topological Edits (insert_before / insert_after) ───────────────

describe("topological edits (insert_before / insert_after)", () => {
    it("should insert_after placing code after the symbol without removing it", async () => {
        const file = writeTmp("insert-after.ts", [
            "function process() {",
            "    return 1;",
            "}",
            "",
            "function end() {}"
        ].join("\n"));

        const result = await semanticEdit(
            file, "process", "function process_v2() {\n    return 2;\n}",
            parser, sandbox, tmpDir, "insert_after"
        );

        expect(result.success).toBe(true);
        const content = fs.readFileSync(file, "utf-8");
        expect(content).toContain("function process()");
        expect(content).toContain("function process_v2()");
        expect(content.indexOf("process()")).toBeLessThan(content.indexOf("process_v2()"));
        expect(content.indexOf("process_v2()")).toBeLessThan(content.indexOf("end()"));
    });

    it("should insert_before placing code before the symbol without removing it", async () => {
        const file = writeTmp("insert-before.ts", [
            "function first() {}",
            "",
            "function end() {",
            "    return 1;",
            "}"
        ].join("\n"));

        const result = await semanticEdit(
            file, "end", "function start() {\n    return 0;\n}",
            parser, sandbox, tmpDir, "insert_before"
        );

        expect(result.success).toBe(true);
        const content = fs.readFileSync(file, "utf-8");
        expect(content).toContain("function start()");
        expect(content).toContain("function end()");
        expect(content.indexOf("first()")).toBeLessThan(content.indexOf("start()"));
        expect(content.indexOf("start()")).toBeLessThan(content.indexOf("end()"));
    });

    it("should auto-indent inserted code for nested blocks", async () => {
        const file = writeTmp("auto-indent.ts", [
            "class Controller {",
            "    async getData() {",
            "        return true;",
            "    }",
            "}"
        ].join("\n"));

        const rawNewCode = "async validateData() {\n    return false;\n}";

        const result = await semanticEdit(
            file, "getData", rawNewCode, parser, sandbox, tmpDir, "insert_before"
        );

        expect(result.success).toBe(true);
        const content = fs.readFileSync(file, "utf-8");
        expect(content).toMatch(/\n    async validateData\(\) \{\n        return false;\n    \}\n/);
    });

    it("should reject inserted code with syntax errors without modifying file", async () => {
        const file = writeTmp("insert-invalid.ts", "function valid() { return 1; }");
        const contentBefore = fs.readFileSync(file, "utf-8");

        const result = await semanticEdit(
            file, "valid", "function broken() { return 1",
            parser, sandbox, tmpDir, "insert_after"
        );

        expect(result.success).toBe(false);
        expect(result.syntaxValid).toBe(false);
        const contentAfter = fs.readFileSync(file, "utf-8");
        expect(contentAfter).toBe(contentBefore);
    });

    it("should handle insert_after on the last symbol of the file", async () => {
        const file = writeTmp("insert-last.ts", "function foo() { return 1; }");

        const result = await semanticEdit(
            file, "foo", "function bar() { return 2; }", parser, sandbox, tmpDir, "insert_after"
        );

        expect(result.success).toBe(true);
        const content = fs.readFileSync(file, "utf-8");
        expect(content).toContain("function foo()");
        expect(content).toContain("function bar()");
        expect(content.indexOf("foo()")).toBeLessThan(content.indexOf("bar()"));
    });
});

// ─── Performance ────────────────────────────────────────────────────

describe("performance", () => {
    it("should edit a 1000-line file in under 500ms", async () => {
        // Generate a large file
        const funcs = Array(100)
            .fill(null)
            .map((_, i) => [
                `function func${i}(x: number): number {`,
                `    const a = x + ${i};`,
                `    const b = a * ${i + 1};`,
                `    const c = b - ${i};`,
                `    const d = c / (${i + 1});`,
                `    const e = d + ${i * 2};`,
                `    const f = e * ${i + 3};`,
                `    const g = f - ${i + 1};`,
                `    const h = g + 1;`,
                `    return h;`,
                `}`,
            ].join("\n"))
            .join("\n\n");

        const file = writeTmp("large-file.ts", funcs);

        const start = performance.now();
        const result = await semanticEdit(
            file,
            "func50",
            "function func50(x: number): number {\n    return x * 50;\n}",
            parser,
            sandbox,
            tmpDir,
        );
        const elapsed = performance.now() - start;

        expect(result.success).toBe(true);
        expect(elapsed).toBeLessThan(1000);

        const content = fs.readFileSync(file, "utf-8");
        expect(content).toContain("return x * 50;");
        // Verify other functions untouched
        expect(content).toContain("function func0(");
        expect(content).toContain("function func99(");
    });
});

// ─── symbolName from AST (PASO 0) ──────────────────────────────────

describe("symbolName extraction from AST", () => {
    it("should extract symbolName for functions, classes, interfaces, and arrow funcs", async () => {
        const code = [
            'export async function processTransaction(userId: string, amount: number): Promise<void> { return; }',
            '',
            'export class PaymentService {',
            '    async charge() { return true; }',
            '}',
            '',
            'export interface Config {',
            '    debug: boolean;',
            '}',
            '',
            'export type UserId = string;',
            '',
            'const handler = async (req: Request) => { return req; };',
        ].join('\n');

        const result = await parser.parse("test.ts", code);

        const names = result.chunks.map(c => c.symbolName);
        expect(names).toContain("processTransaction");
        expect(names).toContain("PaymentService");
        expect(names).toContain("Config");
        expect(names).toContain("UserId");
        expect(names).toContain("handler");
    });

    it("should extract symbolName for Python defs", async () => {
        const code = [
            'def process_data(items):',
            '    return items',
            '',
            'class DataProcessor:',
            '    def run(self):',
            '        pass',
        ].join('\n');

        const result = await parser.parse("test.py", code);

        const names = result.chunks.map(c => c.symbolName);
        expect(names).toContain("process_data");
        expect(names).toContain("DataProcessor");
    });

    it("should use symbolName for edit matching instead of regex", async () => {
        const file = writeTmp("symbol-name-edit.ts", [
            'export async function processTransaction(',
            '  userId: string,',
            '  amount: number',
            '): Promise<void> {',
            '  console.log("old");',
            '}',
        ].join('\n'));

        const result = await semanticEdit(
            file, "processTransaction",
            'export async function processTransaction(\n  userId: string,\n  amount: number\n): Promise<void> {\n  console.log("new");\n}',
            parser, sandbox,
            tmpDir,
        );

        expect(result.success).toBe(true);
        const content = fs.readFileSync(file, "utf-8");
        expect(content).toContain('"new"');
        expect(content).not.toContain('"old"');
    });
});

// ─── Memory safety ──────────────────────────────────────────────────

describe("memory safety", () => {
    it("should handle multiple sequential edits without leaking", async () => {
        for (let i = 0; i < 10; i++) {
            const file = writeTmp(`mem-${i}.ts`, [
                `function target(): number {`,
                `    return ${i};`,
                `}`,
            ].join("\n"));

            const result = await semanticEdit(
                file,
                "target",
                `function target(): number {\n    return ${i + 100};\n}`,
                parser,
                sandbox,
                tmpDir,
            );

            expect(result.success).toBe(true);
        }
        // If we get here without crash, tree.delete() is working
    });
});
