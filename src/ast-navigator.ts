/**
 * ast-navigator.ts - Deterministic AST navigation for NREKI.
 *
 * Provides go-to-definition, find-references, and file-outline using
 * tree-sitter AST parsing. 100% precise, no vector search needed.
 * Typical latency: 3-50ms vs 900ms+ for embedding-based search.
 */

import fs from "fs";
import path from "path";
import { ASTParser, type ParsedChunk } from "./parser.js";
import { shouldProcess } from "./utils/file-filter.js";
import { readSource } from "./utils/read-source.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface DefinitionResult {
    filePath: string;
    name: string;
    kind: string;
    signature: string;
    body: string;
    startLine: number;
    endLine: number;
    exportedAs: string | null;
}

export interface ReferenceResult {
    filePath: string;
    line: number;
    column: number;
    context: string;
}

export type SymbolKind = "function" | "class" | "interface" | "type" | "variable" | "enum" | "method" | "any";

// ─── Constants ──────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go"]);

const IGNORE_DIRS = new Set([
    "node_modules", "dist", "build", ".git", "coverage",
    ".next", "__pycache__", ".nreki",
]);

// Map parser nodeType to user-facing kind
const NODE_TYPE_TO_KIND: Record<string, string> = {
    func: "function",
    class: "class",
    method: "method",
    interface: "interface",
    type: "type",
    type_decl: "type",
};

// ─── File Walking ───────────────────────────────────────────────────

function walkFiles(dirPath: string): string[] {
    const files: string[] = [];

    const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (!IGNORE_DIRS.has(entry.name)) walk(fullPath);
                continue;
            }

            const ext = path.extname(entry.name).toLowerCase();
            if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
            if (entry.name.endsWith(".d.ts")) continue;

            try {
                const stat = fs.statSync(fullPath);
                const filter = shouldProcess(fullPath, stat.size);
                if (filter.process) files.push(fullPath);
            } catch {
                // Skip inaccessible files
            }
        }
    };

    walk(dirPath);
    // v10.5.2 #94: locale-independent sort preserves Anthropic Prompt Cache.
    // Default .sort() uses OS locale — Linux/macOS order differently → cache miss.
    return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ─── Signature Extraction ───────────────────────────────────────────

function extractSignature(rawCode: string): string {
    const lines = rawCode.split("\n");
    if (lines.length <= 1) return rawCode.trim();

    let parenDepth = 0;
    let angleDepth = 0;

    for (let i = 0; i < rawCode.length; i++) {
        const ch = rawCode[i];
        if (ch === "(") parenDepth++;
        else if (ch === ")") parenDepth--;
        else if (ch === "<") angleDepth++;
        else if (ch === ">") angleDepth--;
        else if (ch === "{" && parenDepth === 0 && angleDepth === 0) {
            return rawCode.slice(0, i).trim();
        }
        // A-02: Python colon - only match at depth 0 (skip colons inside type hints)
        else if (ch === ":" && parenDepth === 0 && angleDepth === 0) {
            if (/^(?:async\s+)?def\s|^class\s/.test(rawCode)) {
                return rawCode.slice(0, i).trim();
            }
        }
    }

    return lines[0].trim();
}

/** Extract the symbol name from a chunk's raw code. */
function extractName(chunk: ParsedChunk): string {
    const raw = chunk.rawCode.trim();

    // TS/JS patterns
    let m: RegExpExecArray | null;

    // TS/JS: Arrow functions (export const foo = async () => ...)
    m = /(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:(?:<[^>]*>\s*)?\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/.exec(raw);
    if (m) return m[1];

    // export [default] [async] function NAME
    m = /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/.exec(raw);
    if (m) return m[1];

    // export [default] class NAME
    m = /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/.exec(raw);
    if (m) return m[1];

    // export interface NAME
    m = /(?:export\s+)?interface\s+(\w+)/.exec(raw);
    if (m) return m[1];

    // export type NAME
    m = /(?:export\s+)?type\s+(\w+)/.exec(raw);
    if (m) return m[1];

    // export enum NAME
    m = /(?:export\s+)?enum\s+(\w+)/.exec(raw);
    if (m) return m[1];

    // method: [async] NAME(
    m = /(?:async\s+)?(?:static\s+)?(?:readonly\s+)?(?:public\s+|private\s+|protected\s+)?(\w+)\s*[(<]/.exec(raw);
    if (m) return m[1];

    // Python: def NAME / class NAME
    m = /(?:async\s+)?def\s+(\w+)/.exec(raw);
    if (m) return m[1];
    m = /class\s+(\w+)/.exec(raw);
    if (m) return m[1];

    // Go: func NAME / func (receiver) NAME
    m = /func\s+(?:\([^)]*\)\s+)?(\w+)/.exec(raw);
    if (m) return m[1];

    // Go: type NAME
    m = /type\s+(\w+)/.exec(raw);
    if (m) return m[1];

    // Fallback: first word-like token
    m = /(\w+)/.exec(raw);
    return m ? m[1] : "";
}

/** Determine if a chunk is exported. Checks rawCode and falls back to the original source line. */
function getExportStatus(rawCode: string, contentLines?: string[], startLine?: number): string | null {
    const trimmed = rawCode.trim();
    if (trimmed.startsWith("export default ")) return "default";
    if (trimmed.startsWith("export ")) return "named";

    // Tree-sitter may capture inner nodes (e.g., type_alias_declaration without export wrapper).
    // Check the original source line for the export keyword.
    if (contentLines && startLine) {
        const line = contentLines[startLine - 1]; // 1-indexed
        if (line) {
            const lineTrimmed = line.trim();
            if (lineTrimmed.startsWith("export default ")) return "default";
            if (lineTrimmed.startsWith("export ")) return "named";
        }
    }

    return null;
}

// ─── Core Navigation Functions ──────────────────────────────────────

export async function findDefinition(
    projectRoot: string,
    parser: ASTParser,
    symbolName: string,
    kind: SymbolKind = "any"
): Promise<DefinitionResult[]> {
    await parser.initialize();

    const files = walkFiles(projectRoot);
    const exact: DefinitionResult[] = [];
    const partial: DefinitionResult[] = [];
    const lowerSymbol = symbolName.toLowerCase();

    for (const filePath of files) {
        const ext = path.extname(filePath).toLowerCase();
        if (!parser.isSupported(ext)) continue;

        let content: string;
        try {
            content = readSource(filePath);
        } catch {
            continue;
        }

        const result = await parser.parse(filePath, content);
        const contentLines = content.split("\n");

        for (const chunk of result.chunks) {
            const name = chunk.symbolName || extractName(chunk);
            if (!name) continue;

            // Kind filtering
            const chunkKind = NODE_TYPE_TO_KIND[chunk.nodeType] || chunk.nodeType;
            if (kind !== "any" && chunkKind !== kind) continue;

            const relPath = path.relative(projectRoot, filePath).replace(/\\/g, "/");
            const def: DefinitionResult = {
                filePath: relPath,
                name,
                kind: chunkKind,
                signature: extractSignature(chunk.rawCode),
                body: chunk.rawCode,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                exportedAs: getExportStatus(chunk.rawCode, contentLines, chunk.startLine),
            };

            if (name === symbolName) {
                exact.push(def);
            } else if (name.toLowerCase() === lowerSymbol) {
                partial.push(def);
            }
        }
    }

    // Exact matches first, then case-insensitive matches
    return [...exact, ...partial];
}

export async function findReferences(
    projectRoot: string,
    parser: ASTParser,
    symbolName: string
): Promise<ReferenceResult[]> {
    await parser.initialize();

    const files = walkFiles(projectRoot);
    const results: ReferenceResult[] = [];
    // Word boundary regex for the symbol
    const symbolRe = new RegExp(`\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");

    for (const filePath of files) {
        let content: string;
        try {
            content = readSource(filePath);
        } catch {
            continue;
        }

        const lines = content.split("\n");
        const relPath = path.relative(projectRoot, filePath).replace(/\\/g, "/");

        for (let i = 0; i < lines.length; i++) {
            symbolRe.lastIndex = 0;
            const match = symbolRe.exec(lines[i]);
            if (!match) continue;

            // Build context: line + 1 line above and below
            const ctxStart = Math.max(0, i - 1);
            const ctxEnd = Math.min(lines.length - 1, i + 1);
            const context = lines.slice(ctxStart, ctxEnd + 1).join("\n");

            results.push({
                filePath: relPath,
                line: i + 1, // 1-indexed
                column: match.index + 1,
                context,
            });
        }
    }

    return results;
}

export async function getFileSymbols(
    filePath: string,
    parser: ASTParser,
    projectRoot?: string
): Promise<DefinitionResult[]> {
    await parser.initialize();

    const ext = path.extname(filePath).toLowerCase();
    if (!parser.isSupported(ext)) return [];

    let content: string;
    try {
        content = readSource(filePath);
    } catch {
        return [];
    }

    const result = await parser.parse(filePath, content);
    const contentLines = content.split("\n");
    const relPath = projectRoot
        ? path.relative(projectRoot, filePath).replace(/\\/g, "/")
        : filePath;

    return result.chunks.map((chunk) => ({
        filePath: relPath,
        name: chunk.symbolName || extractName(chunk),
        kind: NODE_TYPE_TO_KIND[chunk.nodeType] || chunk.nodeType,
        signature: extractSignature(chunk.rawCode),
        body: chunk.rawCode,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        exportedAs: getExportStatus(chunk.rawCode, contentLines, chunk.startLine),
    }));
}
