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
import { escapeRegExp } from "./utils/imports.js";
import type { NrekiEngine } from "./engine.js";
import type { ChunkRecord } from "./database.js";

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

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".go", ".css", ".json", ".html"]);

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
    // Locale-independent sort preserves Anthropic Prompt Cache.
    // Default .sort() uses OS locale — Linux/macOS order differently → cache miss.
    return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ─── Signature Extraction ───────────────────────────────────────────

function extractSignature(rawCode: string): string {
    const lines = rawCode.split("\n");

    let parenDepth = 0;
    let angleDepth = 0;
    let topLevelAssignmentSeen = false;

    for (let i = 0; i < rawCode.length; i++) {
        const ch = rawCode[i];
        if (ch === "(") parenDepth++;
        else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
        else if (ch === "<") angleDepth++;
        else if (ch === ">" && !(i > 0 && rawCode[i - 1] === "=")) angleDepth = Math.max(0, angleDepth - 1);
        else if (ch === "=" && i + 1 < rawCode.length && rawCode[i + 1] === ">" &&
                 parenDepth === 0 && angleDepth === 0 && topLevelAssignmentSeen) {
            return rawCode.slice(0, i + 2).trim();
        } else if (ch === "=" && parenDepth === 0 && angleDepth === 0) {
            topLevelAssignmentSeen = true;
        }
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

/**
 * Replace contents of string literals and comments with spaces, preserving
 * line and column geometry of the source. Used by findReferences AST-light
 * filter to avoid matching inside strings/comments without shifting line/column.
 *
 * ORDER IS CRITICAL: strings are neutralized FIRST. If comments were processed
 * first, "//" inside a string like "http://api.com" would eat the rest of the
 * line and break the string regex.
 */
function stripCommentsAndStringsPreservingGeometry(code: string): string {
    return code
        .replace(/(["\u0027`])(?:\\.|(?!\1)[^\\])*\1/g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/** Convert a ChunkRecord (SQLite) to a DefinitionResult. Re-reads file only if export status is ambiguous. */
function chunkRecordToDefinition(
    chunk: ChunkRecord,
    projectRoot: string,
    symbolName: string,
): DefinitionResult {
    const chunkKind = NODE_TYPE_TO_KIND[chunk.node_type] || chunk.node_type;
    const relPath = path.relative(projectRoot, path.resolve(projectRoot, chunk.path)).replace(/\\/g, "/");
    const trimmed = chunk.raw_code.trim();
    let exportedAs: string | null = null;
    if (trimmed.startsWith("export default ")) exportedAs = "default";
    else if (trimmed.startsWith("export ")) exportedAs = "named";
    else {
        // Inner AST node (e.g. interface/type/enum without export wrapper). Re-read source line.
        try {
            const absPath = path.resolve(projectRoot, chunk.path);
            const content = readSource(absPath);
            const lineText = content.split("\n")[chunk.start_line - 1];
            if (lineText) {
                const lt = lineText.trim();
                if (lt.startsWith("export default ")) exportedAs = "default";
                else if (lt.startsWith("export ")) exportedAs = "named";
            }
        } catch { /* non-fatal: leave exportedAs null */ }
    }
    return {
        filePath: relPath,
        name: chunk.symbol_name || symbolName,
        kind: chunkKind,
        signature: extractSignature(chunk.raw_code),
        body: chunk.raw_code,
        startLine: chunk.start_line,
        endLine: chunk.end_line,
        exportedAs,
    };
}

// ─── Core Navigation Functions ──────────────────────────────────────

export async function findDefinition(
    projectRoot: string,
    parser: ASTParser,
    symbolName: string,
    kind: SymbolKind = "any",
    engine?: NrekiEngine,
): Promise<DefinitionResult[]> {
    if (!symbolName.trim()) return [];

    // Fast path: SQLite lookup if engine provided
    if (engine) {
        try {
            let chunks = await engine.getChunksBySymbolExact(symbolName, true);
            if (chunks.length === 0) {
                chunks = await engine.getChunksBySymbolExact(symbolName, false);
            }
            if (chunks.length > 0) {
                const exactFast: DefinitionResult[] = [];
                const partialFast: DefinitionResult[] = [];
                const lowerSymbolFast = symbolName.toLowerCase();
                for (const chunk of chunks) {
                    const chunkKind = NODE_TYPE_TO_KIND[chunk.node_type] || chunk.node_type;
                    if (kind !== "any" && chunkKind !== kind) continue;
                    const def = chunkRecordToDefinition(chunk, projectRoot, symbolName);
                    if (chunk.symbol_name === symbolName) exactFast.push(def);
                    else if ((chunk.symbol_name || "").toLowerCase() === lowerSymbolFast) partialFast.push(def);
                }
                if (exactFast.length > 0 || partialFast.length > 0) {
                    return [...exactFast, ...partialFast];
                }
                // Fast path returned chunks but none passed kind filter: fall through to slow path
            }
        } catch { /* SQLite unavailable — fall through to slow path */ }
    }

    // Slow path: walk disk (original behavior, backward-compatible)
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
    symbolName: string,
    engine?: NrekiEngine,
): Promise<ReferenceResult[]> {
    if (!symbolName.trim()) return [];

    // escapeRegExp from utils is blinded-tested and avoids the fragile inline character class
    const symbolRe = new RegExp(`\\b${escapeRegExp(symbolName)}\\b`, "g");
    const results: ReferenceResult[] = [];

    // Candidate file selection: SQLite inverted index if engine available, else walk disk
    let candidatePaths: string[] = [];
    let usedFastPath = false;
    if (engine) {
        try {
            const relCandidates = await engine.searchFilesBySymbol(symbolName);
            if (relCandidates.length > 0) {
                candidatePaths = relCandidates.map((rel) => path.resolve(projectRoot, rel));
                usedFastPath = true;
            }
        } catch { /* SQLite unavailable — fall through */ }
    }
    if (!usedFastPath) {
        await parser.initialize();
        candidatePaths = walkFiles(projectRoot);
    }

    for (const filePath of candidatePaths) {
        let content: string;
        try {
            content = readSource(filePath);
        } catch {
            continue;
        }

        // AST-light: zero out string/comment content (preserves line/column geometry)
        const cleanContent = stripCommentsAndStringsPreservingGeometry(content);
        const cleanLines = cleanContent.split("\n");
        const rawLines = content.split("\n");
        const relPath = path.relative(projectRoot, filePath).replace(/\\/g, "/");

        for (let i = 0; i < cleanLines.length; i++) {
            symbolRe.lastIndex = 0;
            const match = symbolRe.exec(cleanLines[i]);
            if (!match) continue;

            // Context: 1 line above and below from RAW content (not cleaned)
            const ctxStart = Math.max(0, i - 1);
            const ctxEnd = Math.min(rawLines.length - 1, i + 1);
            const context = rawLines.slice(ctxStart, ctxEnd + 1).join("\n");

            results.push({
                filePath: relPath,
                line: i + 1,
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
