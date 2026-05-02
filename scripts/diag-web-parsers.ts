import fs from "fs";
import path from "path";
import Parser from "web-tree-sitter";

const WASM_DIR = path.resolve("node_modules/tree-sitter-wasms/out");

const FIXTURES = {
    css: `
.home-sidebar .hero-showcase, #main-banner {
  display: flex;
  color: red;
}
@media (max-width: 600px) {
  .mobile-hidden { display: none; }
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
:root {
  --primary-color: blue;
}
`,
    json_small: `
{
  "name": "nreki",
  "dependencies": {
    "zod": "^3.0.0"
  }
}
`,
    json_nested: `
{
  "name": "test-pkg",
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "root", "dependencies": { "a": "1.0.0", "b": "2.0.0" } },
    "node_modules/a": { "version": "1.0.0", "resolved": "https://registry/a.tgz", "integrity": "sha-x" },
    "node_modules/b": { "version": "2.0.0", "resolved": "https://registry/b.tgz", "integrity": "sha-y",
      "dependencies": { "c": "3.0.0", "d": "4.0.0" } },
    "node_modules/c": { "version": "3.0.0", "integrity": "sha-z", "requires": { "e": "5.0.0" } },
    "node_modules/d": { "version": "4.0.0", "integrity": "sha-w" },
    "node_modules/e": { "version": "5.0.0", "integrity": "sha-q" }
  }
}
`,
    html: `
<div id="app-root" class="container">
  <header class="navbar dark-theme">
    <span>Logo</span>
    <nav class="main-nav">
      <a href="/home">Home</a>
      <a href="/about">About</a>
    </nav>
  </header>
  <main>
    <section class="hero-showcase">
      <h1 id="hero-title">Welcome</h1>
      <div class="cards">
        <div class="card">A</div>
        <div class="card">B</div>
      </div>
    </section>
  </main>
</div>
`
};

// CSS: selectors completo como symbolName
const QUERY_CSS = `(rule_set (selectors) @symbol_name) @chunk`;

// JSON: todos los pairs (empírico: mediremos el blowup en nested)
const QUERY_JSON_ALL = `(pair key: (string) @symbol_name) @chunk`;

// JSON: solo top-level (comparación)
const QUERY_JSON_TOP = `(document (object (pair key: (string) @symbol_name) @chunk))`;

// HTML Query A (amplia): cada element, tag_name como symbol
const QUERY_HTML_WIDE = `(element (start_tag (tag_name) @symbol_name)) @chunk`;

// HTML Query B (restrictiva): element con attribute, filtro id/class en JS
const QUERY_HTML_KEYED = `
(element
  (start_tag
    (attribute
      (attribute_name) @attr_name
      (quoted_attribute_value (attribute_value) @symbol_name)))) @chunk
`;

interface ChunkInfo {
    symbolName: string;
    firstLine: string;
    startByte: number;
    endByte: number;
}

async function runQuery(
    lang: string,
    wasmName: string,
    source: string,
    queryText: string,
    opts: { filterAttr?: boolean } = {}
): Promise<ChunkInfo[]> {
    const wasmPath = path.join(WASM_DIR, wasmName);
    if (!fs.existsSync(wasmPath)) {
        throw new Error(`WASM not found: ${wasmPath}`);
    }
    const parser = new Parser();
    const Language = await Parser.Language.load(wasmPath);
    parser.setLanguage(Language);
    const tree = parser.parse(source);
    const query = Language.query(queryText);
    const matches = query.matches(tree.rootNode);

    const seen = new Set<string>();
    const results: ChunkInfo[] = [];
    for (const match of matches) {
        const chunk = match.captures.find(c => c.name === "chunk");
        const sym = match.captures.find(c => c.name === "symbol_name");
        if (!chunk || !sym) continue;

        if (opts.filterAttr) {
            const attrName = match.captures.find(c => c.name === "attr_name");
            if (!attrName) continue;
            if (attrName.node.text !== "id" && attrName.node.text !== "class") continue;
        }

        const key = `${chunk.node.startIndex}-${chunk.node.endIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
            symbolName: sym.node.text.replace(/\s+/g, " ").trim(),
            firstLine: chunk.node.text.split("\n")[0].substring(0, 80),
            startByte: chunk.node.startIndex,
            endByte: chunk.node.endIndex,
        });
    }
    tree.delete();
    parser.delete();
    return results;
}

async function main() {
    console.log("=== NREKI WEB PARSERS DIAGNOSTIC v2 ===");
    console.log(`WASM_DIR: ${WASM_DIR}`);
    await Parser.init();

    // CSS
    console.log("\n--- CSS (rule_set + selectors as symbol) ---");
    try {
        const r = await runQuery("css", "tree-sitter-css.wasm", FIXTURES.css, QUERY_CSS);
        console.log(`Chunks extracted: ${r.length}`);
        for (const c of r) console.log(`  [${c.symbolName}]  byte ${c.startByte}-${c.endByte}  "${c.firstLine}"`);
    } catch (e) { console.error("CSS FAILED:", (e as Error).message); }

    // JSON small — all pairs
    console.log("\n--- JSON small (all pairs, any depth) ---");
    try {
        const r = await runQuery("json", "tree-sitter-json.wasm", FIXTURES.json_small, QUERY_JSON_ALL);
        console.log(`Chunks extracted: ${r.length}`);
        for (const c of r) console.log(`  [${c.symbolName}]  byte ${c.startByte}-${c.endByte}`);
    } catch (e) { console.error("JSON small FAILED:", (e as Error).message); }

    // JSON nested — all pairs (measure blowup)
    console.log("\n--- JSON nested lockfile-like (all pairs) ---");
    try {
        const r = await runQuery("json", "tree-sitter-json.wasm", FIXTURES.json_nested, QUERY_JSON_ALL);
        console.log(`Chunks extracted: ${r.length}  [BLOWUP METRIC]`);
        console.log(`Sample first 5: ${r.slice(0, 5).map(c => c.symbolName).join(", ")}`);
        console.log(`Sample last 5:  ${r.slice(-5).map(c => c.symbolName).join(", ")}`);
    } catch (e) { console.error("JSON nested FAILED:", (e as Error).message); }

    // JSON nested — top-level only
    console.log("\n--- JSON nested (top-level pairs only) ---");
    try {
        const r = await runQuery("json", "tree-sitter-json.wasm", FIXTURES.json_nested, QUERY_JSON_TOP);
        console.log(`Chunks extracted: ${r.length}`);
        for (const c of r) console.log(`  [${c.symbolName}]`);
    } catch (e) { console.error("JSON top-level FAILED:", (e as Error).message); }

    // HTML A — wide
    console.log("\n--- HTML WIDE (every element, tag_name as symbol) ---");
    try {
        const r = await runQuery("html", "tree-sitter-html.wasm", FIXTURES.html, QUERY_HTML_WIDE);
        console.log(`Chunks extracted: ${r.length}  [NOISE METRIC]`);
        const distinctNames = new Set(r.map(c => c.symbolName));
        console.log(`Distinct symbol names: ${distinctNames.size} → ${[...distinctNames].join(", ")}`);
    } catch (e) { console.error("HTML wide FAILED:", (e as Error).message); }

    // HTML B — keyed (id/class only)
    console.log("\n--- HTML KEYED (only elements with id or class, attr_value as symbol) ---");
    try {
        const r = await runQuery("html", "tree-sitter-html.wasm", FIXTURES.html, QUERY_HTML_KEYED, { filterAttr: true });
        console.log(`Chunks extracted: ${r.length}`);
        for (const c of r) console.log(`  [${c.symbolName}]  "${c.firstLine}"`);
    } catch (e) { console.error("HTML keyed FAILED:", (e as Error).message); }

    console.log("\n=== DIAGNOSTIC COMPLETE ===");
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
