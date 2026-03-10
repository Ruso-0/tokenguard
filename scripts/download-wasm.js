/**
 * download-wasm.js — Postinstall script to fetch Tree-sitter WASM grammars.
 * Downloads language grammars from the official tree-sitter GitHub releases
 * to avoid committing large binary files to the repository.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = join(__dirname, "..", "wasm");

const GRAMMARS = [
    {
        name: "tree-sitter-typescript.wasm",
        url: "https://github.com/nicolo-ribaudo/tree-sitter-wasm-builds/releases/latest/download/tree-sitter-typescript.wasm",
    },
    {
        name: "tree-sitter-javascript.wasm",
        url: "https://github.com/nicolo-ribaudo/tree-sitter-wasm-builds/releases/latest/download/tree-sitter-javascript.wasm",
    },
    {
        name: "tree-sitter-python.wasm",
        url: "https://github.com/nicolo-ribaudo/tree-sitter-wasm-builds/releases/latest/download/tree-sitter-python.wasm",
    },
    {
        name: "tree-sitter-go.wasm",
        url: "https://github.com/nicolo-ribaudo/tree-sitter-wasm-builds/releases/latest/download/tree-sitter-go.wasm",
    },
];

if (!existsSync(WASM_DIR)) {
    mkdirSync(WASM_DIR, { recursive: true });
}

for (const grammar of GRAMMARS) {
    const dest = join(WASM_DIR, grammar.name);
    if (existsSync(dest)) {
        console.log(`  ✓ ${grammar.name} already exists, skipping.`);
        continue;
    }
    console.log(`  ↓ Downloading ${grammar.name}...`);
    try {
        execSync(`curl -fsSL -o "${dest}" "${grammar.url}"`, { stdio: "inherit" });
        console.log(`  ✓ ${grammar.name} downloaded.`);
    } catch {
        console.warn(`  ⚠ Failed to download ${grammar.name}. You can manually place it in ./wasm/`);
    }
}

console.log("\n✅ WASM grammars ready.\n");
