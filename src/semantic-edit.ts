/**
 * semantic-edit.ts — Zero-read surgical AST patching for TokenGuard.
 *
 * Replaces a single function/class/interface/type by name without
 * reading or rewriting the entire file. Finds the exact AST node,
 * splices only those bytes, and validates syntax before saving.
 *
 * Saves 98% of tokens vs full file rewrite.
 */

import fs from "fs";
import path from "path";
import { ASTParser, type ParsedChunk } from "./parser.js";
import { AstSandbox } from "./ast-sandbox.js";
import { Embedder } from "./embedder.js";
import { readSource } from "./utils/read-source.js";
import { saveBackup } from "./undo.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface EditResult {
    success: boolean;
    filePath: string;
    symbolName: string;
    oldLines: number;
    newLines: number;
    tokensAvoided: number;
    syntaxValid: boolean;
    error?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Extract symbol name from a chunk's raw code. */
function extractName(chunk: ParsedChunk): string {
    const raw = chunk.rawCode.trim();
    let m: RegExpExecArray | null;

    // export [default] [async] function NAME
    m = /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/.exec(raw);
    if (m) return m[1];

    // class NAME
    m = /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/.exec(raw);
    if (m) return m[1];

    // interface NAME
    m = /(?:export\s+)?interface\s+(\w+)/.exec(raw);
    if (m) return m[1];

    // type NAME
    m = /(?:export\s+)?type\s+(\w+)/.exec(raw);
    if (m) return m[1];

    // enum NAME
    m = /(?:export\s+)?enum\s+(\w+)/.exec(raw);
    if (m) return m[1];

    // method: NAME(
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
    m = /type\s+(\w+)/.exec(raw);
    if (m) return m[1];

    // Fallback
    m = /(\w+)/.exec(raw);
    return m ? m[1] : "";
}

/** Map file extension to language name for validation. */
function detectLanguage(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
        ".ts": "typescript",
        ".tsx": "typescript",
        ".js": "javascript",
        ".jsx": "javascript",
        ".py": "python",
        ".go": "go",
    };
    return map[ext] ?? null;
}

/**
 * Compute the byte offset for a 1-indexed line number in a string.
 * Returns the index of the first character on that line.
 */
function lineToByteOffset(content: string, lineNumber: number): number {
    let line = 1;
    for (let i = 0; i < content.length; i++) {
        if (line === lineNumber) return i;
        if (content[i] === "\n") line++;
    }
    return content.length;
}

// ─── Core ───────────────────────────────────────────────────────────

/**
 * Surgically edit a single symbol in a file by name.
 *
 * 1. Parse file to find the target AST node
 * 2. Locate its exact byte position in the file content
 * 3. Splice: before + newCode + after
 * 4. Validate the result with tree-sitter
 * 5. Write only if syntax is valid
 */
export async function semanticEdit(
    filePath: string,
    symbolName: string,
    newCode: string,
    parser: ASTParser,
    sandbox: AstSandbox,
): Promise<EditResult> {
    // Read file
    let content: string;
    try {
        content = readSource(filePath);
    } catch (err) {
        return {
            success: false,
            filePath,
            symbolName,
            oldLines: 0,
            newLines: 0,
            tokensAvoided: 0,
            syntaxValid: false,
            error: `Cannot read file: ${(err as Error).message}`,
        };
    }

    // Parse to get AST chunks
    const parseResult = await parser.parse(filePath, content);

    if (parseResult.chunks.length === 0) {
        return {
            success: false,
            filePath,
            symbolName,
            oldLines: 0,
            newLines: 0,
            tokensAvoided: 0,
            syntaxValid: false,
            error: "No symbols found in file. File may be empty or unsupported.",
        };
    }

    // Find matching chunks by name
    const matches: Array<{ chunk: ParsedChunk; name: string }> = [];
    const allNames: string[] = [];

    for (const chunk of parseResult.chunks) {
        const name = extractName(chunk);
        if (name) allNames.push(`${name} (L${chunk.startLine}-L${chunk.endLine})`);
        if (name === symbolName) {
            matches.push({ chunk, name });
        }
    }

    // Symbol not found
    if (matches.length === 0) {
        const lowerSymbol = symbolName.toLowerCase();
        const fuzzy = parseResult.chunks
            .map((c) => ({ chunk: c, name: extractName(c) }))
            .filter((c) => c.name.toLowerCase() === lowerSymbol);

        if (fuzzy.length > 0) {
            return {
                success: false,
                filePath,
                symbolName,
                oldLines: 0,
                newLines: 0,
                tokensAvoided: 0,
                syntaxValid: false,
                error:
                    `Symbol "${symbolName}" not found. Did you mean "${fuzzy[0].name}"? ` +
                    `Available symbols: ${allNames.join(", ")}`,
            };
        }

        return {
            success: false,
            filePath,
            symbolName,
            oldLines: 0,
            newLines: 0,
            tokensAvoided: 0,
            syntaxValid: false,
            error: `Symbol "${symbolName}" not found. Available symbols: ${allNames.join(", ")}`,
        };
    }

    // Multiple matches → ask Claude to disambiguate
    if (matches.length > 1) {
        const locs = matches
            .map((m) => `L${m.chunk.startLine}-L${m.chunk.endLine}`)
            .join(", ");
        return {
            success: false,
            filePath,
            symbolName,
            oldLines: 0,
            newLines: 0,
            tokensAvoided: 0,
            syntaxValid: false,
            error:
                `Multiple symbols named "${symbolName}" found at: ${locs}. ` +
                `Use tg_def to identify the correct one.`,
        };
    }

    // ── Single match: perform the edit ──

    const { chunk } = matches[0];
    const rawCode = chunk.rawCode;

    // Find exact byte position of rawCode in content.
    // Start searching near the chunk's startLine for efficiency.
    const searchStart = lineToByteOffset(content, chunk.startLine);
    let pos = content.indexOf(rawCode, Math.max(0, searchStart - 1));

    if (pos < 0) {
        // Fallback: search from beginning
        pos = content.indexOf(rawCode);
    }

    if (pos < 0) {
        return {
            success: false,
            filePath,
            symbolName,
            oldLines: rawCode.split("\n").length,
            newLines: newCode.split("\n").length,
            tokensAvoided: 0,
            syntaxValid: false,
            error: "Internal error: could not locate symbol text in file.",
        };
    }

    // Splice: before + newCode + after
    const newContent =
        content.slice(0, pos) + newCode + content.slice(pos + rawCode.length);

    // Validate syntax of the edited file
    const language = detectLanguage(filePath);
    if (!language) {
        return {
            success: false,
            filePath,
            symbolName,
            oldLines: rawCode.split("\n").length,
            newLines: newCode.split("\n").length,
            tokensAvoided: 0,
            syntaxValid: false,
            error: "Unsupported file type for syntax validation.",
        };
    }

    await sandbox.initialize();
    const validation = await sandbox.validateCode(newContent, language);

    if (!validation.valid) {
        const errDetails = validation.errors
            .slice(0, 5)
            .map(
                (e) =>
                    `  Line ${e.line}, Col ${e.column}: ${e.context.split("\n")[0].trim()}`,
            )
            .join("\n");

        return {
            success: false,
            filePath,
            symbolName,
            oldLines: rawCode.split("\n").length,
            newLines: newCode.split("\n").length,
            tokensAvoided: 0,
            syntaxValid: false,
            error:
                `Syntax error in edited code — file NOT modified:\n${errDetails}\n\n${validation.suggestion}`,
        };
    }

    // Save backup before writing (enables tg_undo)
    try {
        saveBackup(process.cwd(), filePath);
    } catch {
        // Non-fatal: don't block the edit if backup fails
    }

    // Write to disk
    fs.writeFileSync(filePath, newContent, "utf-8");

    // Calculate tokens avoided:
    // Without semantic edit: read full file + write full file = 2× file tokens
    // With semantic edit: only newCode tokens
    const fullFileTokens = Embedder.estimateTokens(content);
    const newCodeTokens = Embedder.estimateTokens(newCode);
    const tokensAvoided = Math.max(0, fullFileTokens * 2 - newCodeTokens);

    return {
        success: true,
        filePath,
        symbolName,
        oldLines: rawCode.split("\n").length,
        newLines: newCode.split("\n").length,
        tokensAvoided,
        syntaxValid: true,
    };
}
