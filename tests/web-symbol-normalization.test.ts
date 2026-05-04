/**
 * web-symbol-normalization.test.ts — v10.18.1 NUEVO-C
 *
 * Validates that LLM-supplied web symbols with prefixes (".foo", "#bar",
 * '"key"') match parser-stored chunks (which strip those prefixes).
 *
 * Coverage:
 *  - normalizeWebSymbol() unit (pure function, all extensions).
 *  - semanticEdit single end-to-end on CSS/JSON.
 *  - batchSemanticEdit end-to-end on CSS/JSON, including key-leak
 *    regression test for oldRawCodes/newRawCodes alignment.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ASTParser, normalizeWebSymbol } from "../src/parser.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import { batchSemanticEdit, semanticEdit, type BatchEditOp } from "../src/semantic-edit.js";

let tmpDir: string;
let parser: ASTParser;
let sandbox: AstSandbox;

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-websym-"));
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

describe("normalizeWebSymbol — pure function", () => {
    it("CSS: strips class prefix", () => {
        expect(normalizeWebSymbol(".className", ".css")).toBe("className");
    });

    it("CSS: strips id prefix", () => {
        expect(normalizeWebSymbol("#hashSel", ".css")).toBe("hashSel");
    });

    it("CSS: handles compound selector", () => {
        expect(normalizeWebSymbol(".foo, #bar", ".css")).toBe("foo bar");
    });

    it("CSS: backward-compat — already-clean input unchanged", () => {
        expect(normalizeWebSymbol("className", ".css")).toBe("className");
    });

    it("JSON: strips double quotes", () => {
        expect(normalizeWebSymbol('"key"', ".json")).toBe("key");
    });

    it("JSON: strips single quotes", () => {
        expect(normalizeWebSymbol("'key'", ".json")).toBe("key");
    });

    it("HTML: strips quotes", () => {
        expect(normalizeWebSymbol('"app"', ".html")).toBe("app");
    });

    it("TS: no-op (foreign extension)", () => {
        expect(normalizeWebSymbol(".myFunc", ".ts")).toBe(".myFunc");
    });

    it("Empty input: passes through", () => {
        expect(normalizeWebSymbol("", ".css")).toBe("");
    });
});

describe("semanticEdit single — web symbols at API boundary", () => {
    it("CSS: accepts .className from caller, matches stored chunk", async () => {
        const cssPath = writeTmp("single.css", ".myClass { color: red; }\n");
        const result = await semanticEdit(
            cssPath,
            ".myClass",
            ".myClass { color: blue; }",
            parser,
            sandbox,
            tmpDir,
            "replace",
            true,
        );
        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
    });

    it("JSON: accepts \"key\" from caller, matches stored chunk", async () => {
        const jsonPath = writeTmp("single.json", `{"name": "old"}\n`);
        const result = await semanticEdit(
            jsonPath,
            '"name"',
            `"name": "new"`,
            parser,
            sandbox,
            tmpDir,
            "replace",
            true,
        );
        expect(result.success).toBe(true);
    });

    it("CSS: backward-compat — clean className still works", async () => {
        const cssPath = writeTmp("single-bc.css", ".myClass { color: red; }\n");
        const result = await semanticEdit(
            cssPath,
            "myClass",
            ".myClass { color: blue; }",
            parser,
            sandbox,
            tmpDir,
            "replace",
            true,
        );
        expect(result.success).toBe(true);
    });
});

describe("batchSemanticEdit — web symbols + key leak regression", () => {
    it("CSS: accepts .className symbol in batch", async () => {
        const cssPath = writeTmp("batch.css", ".alpha { color: red; }\n.beta { color: blue; }\n");
        const ops: BatchEditOp[] = [{
            path: cssPath,
            symbol: ".alpha",
            new_code: ".alpha { color: green; }",
            mode: "replace",
        }];
        const result = await batchSemanticEdit(ops, parser, sandbox, tmpDir, true);
        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
    });

    it("JSON: accepts \"key\" symbol in batch", async () => {
        const jsonPath = writeTmp("batch.json", `{"foo": 1, "bar": 2}\n`);
        const ops: BatchEditOp[] = [{
            path: jsonPath,
            symbol: '"foo"',
            new_code: `"foo": 99`,
            mode: "replace",
        }];
        const result = await batchSemanticEdit(ops, parser, sandbox, tmpDir, true);
        expect(result.success).toBe(true);
    });

    it("KEY LEAK REGRESSION: oldRawCodes/newRawCodes keyed by normalized symbol", async () => {
        // Furia's catch: if edit.symbol stays raw (".alpha") but oldRawCodes
        // is keyed off chunk.symbolName ("alpha"), blast-radius detection
        // silently breaks. After in-place mutation, both must align.
        const cssPath = writeTmp("keyleak.css", ".alpha { color: red; }\n");
        const ops: BatchEditOp[] = [{
            path: cssPath,
            symbol: ".alpha",
            new_code: ".alpha { color: blue; font-size: 14px; }",
            mode: "replace",
        }];
        const result = await batchSemanticEdit(ops, parser, sandbox, tmpDir, true);
        expect(result.success).toBe(true);

        // After normalization, edit.symbol must equal "alpha" (mutated in-place).
        expect(ops[0].symbol).toBe("alpha");

        // oldRawCodes/newRawCodes must contain entries keyed with "alpha",
        // matching what handleBatchEdit's blast-radius lookup will use.
        const expectedKey = `${cssPath}::alpha`;
        expect(result.oldRawCodes?.has(expectedKey)).toBe(true);
        expect(result.newRawCodes?.has(expectedKey)).toBe(true);
    });

    it("Backward-compat: clean className in batch still works", async () => {
        const cssPath = writeTmp("batch-bc.css", ".gamma { color: red; }\n");
        const ops: BatchEditOp[] = [{
            path: cssPath,
            symbol: "gamma",
            new_code: ".gamma { color: yellow; }",
            mode: "replace",
        }];
        const result = await batchSemanticEdit(ops, parser, sandbox, tmpDir, true);
        expect(result.success).toBe(true);
    });
});