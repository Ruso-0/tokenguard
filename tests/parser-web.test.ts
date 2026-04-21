import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ASTParser } from "../src/parser.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import path from "path";
import os from "os";
import fs from "fs";

describe("Web Parsers (CSS/HTML/JSON) — v10.11.1", () => {
    let parser: ASTParser;
    let sandbox: AstSandbox;
    const tmpDir = path.join(os.tmpdir(), `nreki-web-test-${Date.now()}`);

    beforeAll(async () => {
        fs.mkdirSync(tmpDir, { recursive: true });
        parser = new ASTParser();
        await parser.initialize();
        sandbox = new AstSandbox();
        await sandbox.initialize();
    });

    afterAll(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it("CSS: rule_sets captured, selectors normalized correctly", async () => {
        const cssPath = path.join(tmpDir, "test.css");
        fs.writeFileSync(cssPath, ".home-sidebar .hero-showcase, #main-banner { color: red; }");
        const res = await parser.parse(cssPath, fs.readFileSync(cssPath, "utf-8"));
        expect(res.chunks.length).toBe(1);
        expect(res.chunks[0].symbolName).toBe("home-sidebar hero-showcase main-banner");
    });

    it("HTML: elements with id/class captured, supports unquoted attrs and multi-attr", async () => {
        const htmlPath = path.join(tmpDir, "test.html");
        fs.writeFileSync(htmlPath, `<div id=app class="container"><span data-test="ignore"></span></div>`);
        const res = await parser.parse(htmlPath, fs.readFileSync(htmlPath, "utf-8"));

        expect(res.chunks.length).toBe(2);
        const names = res.chunks.map(c => c.symbolName);
        expect(names).toContain("app");         // unquoted match
        expect(names).toContain("container");   // second attribute on same node (nodeKey fix)
        expect(names).not.toContain("ignore");  // data-test filtered out
    });

    it("JSON: single-line minified — all top-level pairs captured (nodeKey fix)", async () => {
        const jsonPath = path.join(tmpDir, "mini.json");
        fs.writeFileSync(jsonPath, `{"a":1,"b":2,"c":{"nested":true},"d":4}`);
        const res = await parser.parse(jsonPath, fs.readFileSync(jsonPath, "utf-8"));

        expect(res.chunks.length).toBe(4);
        const names = res.chunks.map(c => c.symbolName).sort();
        expect(names).toEqual(["a", "b", "c", "d"]);
    });

    it("JSON: only top-level pairs captured, nested keys ignored", async () => {
        const jsonPath = path.join(tmpDir, "test.json");
        const json = `{\n  "name": "nreki",\n  "nested": {\n    "ignore": true\n  }\n}`;
        fs.writeFileSync(jsonPath, json);
        const res = await parser.parse(jsonPath, fs.readFileSync(jsonPath, "utf-8"));

        expect(res.chunks.length).toBe(2);
        const names = res.chunks.map(c => c.symbolName);
        expect(names).toContain("name");
        expect(names).toContain("nested");
        expect(names).not.toContain("ignore");
    });

    it("Sandbox: validates HTML/CSS/JSON successfully (edit deadlock closed)", async () => {
        const resHtml = await sandbox.validateCode(`<div id="test"></div>`, "html");
        expect(resHtml.valid).toBe(true);

        const resCss = await sandbox.validateCode(`.class { color: red; }`, "css");
        expect(resCss.valid).toBe(true);

        const resJson = await sandbox.validateCode(`{"valid": true}`, "json");
        expect(resJson.valid).toBe(true);
    });
});
