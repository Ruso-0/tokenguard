/**
 * semantic-edit.ts - Zero-read surgical AST patching for NREKI.
 *
 * Replaces a single function/class/interface/type by name without
 * reading or rewriting the entire file. Finds the exact AST node,
 * splices only those bytes, and validates syntax before saving.
 *
 * Typically saves 60-80% of tokens vs native read+edit workflow.
 *
 * v3.2.0: Byte-index splicing (no more indexOf), auto-indentation,
 * insert_before/insert_after modes, arrow function support,
 * and fuzzy anchor heuristic.
 */

import fs from "fs";
import path from "path";
import { ASTParser, type ParsedChunk } from "./parser.js";
import { AstSandbox } from "./ast-sandbox.js";
import { Embedder } from "./embedder.js";
import { readSource } from "./utils/read-source.js";
import { saveBackup, getBackupPath } from "./undo.js";
import { extractSignature, cleanSignature } from "./repo-map.js";
import crypto from "crypto";

// ─── Types ───────────────────────────────────────────────────────────

export type EditMode = "replace" | "insert_before" | "insert_after";

export interface EditResult {
    success: boolean;
    filePath: string;
    symbolName: string;
    oldLines: number;
    newLines: number;
    tokensAvoided: number;
    syntaxValid: boolean;
    error?: string;
    oldRawCode?: string;
    newContent?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Extract symbol name from a chunk's raw code. */
function extractName(chunk: ParsedChunk): string {
    const raw = chunk.rawCode.trim();
    let m: RegExpExecArray | null;

    // TS/JS: Arrow functions (export const foo = async () => ...)
    m = /(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:(?:<[^>]*>\s*)?\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/.exec(raw);
    if (m) return m[1];

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
        ".mts": "typescript",
        ".cts": "typescript",
        ".js": "javascript",
        ".jsx": "javascript",
        ".mjs": "javascript",
        ".cjs": "javascript",
        ".py": "python",
        ".go": "go",
    };
    return map[ext] ?? null;
}

// ─── Pure Functions (shared by single edit + batch edit) ────────────

export interface SpliceTarget {
    startIndex: number;
    endIndex: number;
    rawCode: string;
    symbolName: string;
    startLine: number;
}

/**
 * Find a chunk by symbol name. Prefers AST symbolName, falls back to regex extraction.
 */
export function findChunkBySymbol(
    chunks: ParsedChunk[],
    symbolName: string,
): ParsedChunk | null {
    // Exact match on AST symbolName first
    const astMatch = chunks.find(c => c.symbolName && c.symbolName === symbolName);
    if (astMatch) return astMatch;

    // Fallback: regex extraction
    const regexMatch = chunks.find(c => extractName(c) === symbolName);
    if (regexMatch) return regexMatch;

    // Case-insensitive fallback
    const lower = symbolName.toLowerCase();
    const fuzzy = chunks.find(c => {
        const name = c.symbolName || extractName(c);
        return name.toLowerCase() === lower;
    });
    return fuzzy ?? null;
}

/**
 * Apply a semantic splice on a string in RAM. Pure function: string in → string out.
 * Verifies byte indices, rebases indentation, and splices by mode.
 */
export function applySemanticSplice(
    content: string,
    target: SpliceTarget,
    newCode: string,
    mode: EditMode = "replace",
): string {
    const { startIndex, rawCode } = target;

    // Verify tree-sitter byte position against actual content
    let startIdx = startIndex;
    if (content.substring(startIdx, startIdx + rawCode.length) !== rawCode) {
        // NOTE: ±500 byte search window. If duplicate symbols exist within this range,
        // the wrong occurrence may be matched. Increase if false mismatches are reported.
        const windowStart = Math.max(0, startIdx - 500);
        const windowEnd = Math.min(content.length, startIdx + rawCode.length + 500);
        const searchWindow = content.substring(windowStart, windowEnd);
        let bestOffset = -1;
        let minDistance = Infinity;
        let currentOffset = searchWindow.indexOf(rawCode);
        while (currentOffset >= 0) {
            const absolutePos = windowStart + currentOffset;
            const distance = Math.abs(absolutePos - startIndex);
            if (distance < minDistance) {
                minDistance = distance;
                bestOffset = currentOffset;
            }
            currentOffset = searchWindow.indexOf(rawCode, currentOffset + 1);
        }

        if (bestOffset >= 0) {
            startIdx = windowStart + bestOffset;
        } else {
            // M-05: No global fallback - risk of matching wrong occurrence in large files
            startIdx = -1;
        }

        if (startIdx < 0) {
            throw new Error(
                `Cannot locate symbol "${target.symbolName}" in file content. AST offset mismatch.`,
            );
        }
    }
    const endIdx = startIdx + rawCode.length;

    // Extract exact original indentation
    let lineStart = startIdx;
    while (lineStart > 0 && content[lineStart - 1] !== "\n") lineStart--;
    if (content[lineStart] === "\r") lineStart++;
    const indentMatch = content.slice(lineStart, startIdx).match(/^[ \t]*/);
    const baseIndent = indentMatch ? indentMatch[0] : "";

    // Calculate minimum indentation in the new code (SKIP first line)
    const newLines = newCode.split("\n");
    const nonBlankInterior = newLines.filter((l, i) => i > 0 && l.trim().length > 0);
    let minClaudeIndent = Infinity;
    for (const line of nonBlankInterior) {
        const match = line.match(/^[ \t]*/);
        if (match && match[0].length < minClaudeIndent) minClaudeIndent = match[0].length;
    }
    if (minClaudeIndent === Infinity) minClaudeIndent = 0;

    // Relative rebase: strip Claude's indent, apply baseIndent
    // First line is excluded from minClaudeIndent calc, so don't strip it
    const formattedNewCode = newLines.map((line, i) => {
        if (line.trim() === "") return "";
        if (mode === "replace" && i === 0) return line.trimStart();

        // SAFE SLICE: never cut into actual text content.
        // If a line has fewer leading spaces than minClaudeIndent
        // (e.g. inside template strings, multiline comments),
        // only strip its actual whitespace prefix.
        const actualIndentMatch = line.match(/^[ \t]*/);
        const actualIndentLength = actualIndentMatch ? actualIndentMatch[0].length : 0;
        const safeSliceLength = Math.min(minClaudeIndent, actualIndentLength);

        const strippedLine = line.slice(safeSliceLength);
        return baseIndent + strippedLine;
    }).join("\n");

    // Splice by mode
    if (mode === "insert_before") {
        return content.slice(0, lineStart) + formattedNewCode + "\n\n" + content.slice(lineStart);
    } else if (mode === "insert_after") {
        let endOfLine = endIdx;
        while (endOfLine < content.length && content[endOfLine] !== "\n") endOfLine++;
        return content.slice(0, endOfLine) + "\n\n" + formattedNewCode + content.slice(endOfLine);
    } else {
        return content.slice(0, startIdx) + formattedNewCode + content.slice(endIdx);
    }
}

/**
 * Detect if a code edit changes the function/class signature.
 * Compares cleaned signatures (keyword-stripped) of old and new code.
 */
export function detectSignatureChange(oldRawCode: string, newCode: string): boolean {
    const oldSig = cleanSignature(extractSignature(oldRawCode));
    const newSig = cleanSignature(extractSignature(newCode));
    return oldSig !== newSig;
}

// ─── Batch Edit ACID ────────────────────────────────────────────────

export interface BatchEditOp {
    path: string;
    symbol: string;
    new_code: string;
    mode?: EditMode;
}

export interface BatchEditResult {
    success: boolean;
    editCount: number;
    fileCount: number;
    files: string[];
    error?: string;
    /** Per-edit old raw code (for blast radius detection) */
    oldRawCodes?: Map<string, string>;
    vfs?: Map<string, string>;
}

/**
 * Apply multiple edits atomically across multiple files.
 * All-or-nothing: if ANY validation fails, ZERO files are written.
 */
export async function batchSemanticEdit(
    edits: BatchEditOp[],
    parser: ASTParser,
    sandbox: AstSandbox,
    projectRoot: string,
    dryRun: boolean = false,
): Promise<BatchEditResult> {
    const { safePath } = await import("./utils/path-jail.js");

    if (!edits || edits.length === 0) {
        return { success: false, editCount: 0, fileCount: 0, files: [], error: "No edits provided." };
    }

    // 1. Group edits by file, resolving paths
    const editsByFile = new Map<string, BatchEditOp[]>();
    for (const edit of edits) {
        const resolved = safePath(projectRoot, edit.path);
        const arr = editsByFile.get(resolved) || [];
        arr.push(edit);
        editsByFile.set(resolved, arr);
    }

    // 2. Build VFS in RAM
    const vfs = new Map<string, string>();
    for (const filePath of editsByFile.keys()) {
        try {
            vfs.set(filePath, readSource(filePath));
        } catch (err) {
            return {
                success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                error: `Cannot read file "${filePath}": ${(err as Error).message}`,
            };
        }
    }

    // Track old raw codes for blast radius detection
    const oldRawCodes = new Map<string, string>();

    // 3. For each file: parse ONCE, map edits, reverse splice
    for (const [filePath, fileEdits] of editsByFile.entries()) {
        let virtualCode = vfs.get(filePath)!;
        const parseResult = await parser.parse(filePath, virtualCode);

        // Map each edit to its AST chunk
        const mappedEdits: Array<{ edit: BatchEditOp; chunk: ParsedChunk }> = [];
        for (const edit of fileEdits) {
            const chunk = findChunkBySymbol(parseResult.chunks, edit.symbol);
            if (!chunk) {
                const available = parseResult.chunks
                    .map(c => c.symbolName || extractName(c))
                    .filter(Boolean)
                    .join(", ");
                return {
                    success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                    error: `Symbol "${edit.symbol}" not found in ${edit.path}. Available: ${available}`,
                };
            }
            mappedEdits.push({ edit, chunk });
        }

        // Detect overlapping ranges
        for (let i = 0; i < mappedEdits.length; i++) {
            for (let j = i + 1; j < mappedEdits.length; j++) {
                const a = mappedEdits[i].chunk;
                const b = mappedEdits[j].chunk;
                if (a.startIndex < b.endIndex && b.startIndex < a.endIndex) {
                    return {
                        success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                        error: `Overlapping edits: "${mappedEdits[i].edit.symbol}" and "${mappedEdits[j].edit.symbol}" ` +
                            `overlap in ${path.relative(projectRoot, filePath)}. Separate them into two calls.`,
                    };
                }
            }
        }

        // Reverse splice: sort by startIndex DESCENDING (bottom-up)
        mappedEdits.sort((a, b) => b.chunk.startIndex - a.chunk.startIndex);

        for (const { edit, chunk } of mappedEdits) {
            oldRawCodes.set(`${edit.path}::${edit.symbol}`, chunk.rawCode);
            try {
                virtualCode = applySemanticSplice(
                    virtualCode,
                    {
                        startIndex: chunk.startIndex,
                        endIndex: chunk.endIndex,
                        rawCode: chunk.rawCode,
                        symbolName: chunk.symbolName || extractName(chunk),
                        startLine: chunk.startLine,
                    },
                    edit.new_code,
                    edit.mode || "replace",
                );
            } catch (err) {
                return {
                    success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                    error: `Error splicing "${edit.symbol}" in ${edit.path}: ${(err as Error).message}. No files modified.`,
                };
            }
        }

        vfs.set(filePath, virtualCode);
    }

    // 4. Validate ALL virtual files
    await sandbox.initialize();
    for (const [filePath, virtualContent] of vfs.entries()) {
        const language = detectLanguage(filePath);
        if (!language) continue;

        const validation = await sandbox.validateCode(virtualContent, language);
        if (!validation.valid) {
            const errDetail = validation.errors.slice(0, 3).map(e =>
                `  L${e.line}:${e.column} - ${e.context.split("\n")[0].trim()}`
            ).join("\n");

            return {
                success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                error: `TRANSACTION ABORTED - syntax error in ${path.relative(projectRoot, filePath)}:\n${errDetail}\n\n` +
                    `No files were modified.\n${validation.suggestion}\nFix the code and resend the full batch.`,
            };
        }
    }

    // 5. COMMIT: Two-Phase Atomic Write with Unbreakable Rollback
    const writtenFiles: string[] = [];
    if (!dryRun) {
        const tmpFiles = new Map<string, string>();
        const renamedFiles: string[] = [];

        try {
            // PHASE 1: PREPARE — Mandatory backups + entropy-named temps
            for (const [filePath, virtualContent] of vfs.entries()) {
                const entropy = crypto.randomBytes(4).toString("hex");
                const tmpPath = `${filePath}.nreki-${Date.now()}-${entropy}.tmp`;

                // Backup is MANDATORY for rollback safety.
                // If backup fails (disk full), abort BEFORE any rename.
                if (fs.existsSync(filePath)) {
                    try {
                        saveBackup(projectRoot, filePath);
                    } catch (backupErr) {
                        for (const tp of tmpFiles.values()) {
                            if (fs.existsSync(tp)) try { fs.unlinkSync(tp); } catch {}
                        }
                        throw new Error(`Backup failed for ${filePath}: ${(backupErr as Error).message}`);
                    }
                }

                fs.writeFileSync(tmpPath, virtualContent, "utf-8");
                tmpFiles.set(filePath, tmpPath);
            }

            // PHASE 2: COMMIT — Atomic POSIX inode rename
            for (const [filePath, tmpPath] of tmpFiles.entries()) {
                fs.renameSync(tmpPath, filePath);
                renamedFiles.push(filePath);
                writtenFiles.push(path.relative(projectRoot, filePath));
            }
        } catch (fatalErr) {
            // PHASE 3: ROLLBACK — Revert successful renames from backup
            for (const donePath of renamedFiles) {
                const backupPath = getBackupPath(projectRoot, donePath);
                if (fs.existsSync(backupPath)) {
                    try { fs.copyFileSync(backupPath, donePath); } catch {}
                }
            }
            // Clean remaining temp files
            for (const tmpPath of tmpFiles.values()) {
                if (fs.existsSync(tmpPath)) try { fs.unlinkSync(tmpPath); } catch {}
            }
            return {
                success: false,
                editCount: edits.length,
                fileCount: editsByFile.size,
                files: [],
                error: `ACID commit aborted: ${(fatalErr as Error).message}. ${renamedFiles.length} files reverted from backup.`,
            };
        }
    } else {
        for (const filePath of vfs.keys()) {
            writtenFiles.push(path.relative(projectRoot, filePath));
        }
    }

    return {
        success: true,
        editCount: edits.length,
        fileCount: editsByFile.size,
        files: writtenFiles,
        oldRawCodes,
        vfs,
    };
}

// ─── Core ───────────────────────────────────────────────────────────

/**
 * Surgically edit a single symbol in a file by name.
 *
 * 1. Parse file to find the target AST node
 * 2. Use exact byte indices from tree-sitter (no indexOf)
 * 3. Auto-indent the replacement to match original context
 * 4. Splice: before + newCode + after (supports replace/insert_before/insert_after)
 * 5. Validate the result with tree-sitter
 * 6. Write only if syntax is valid
 */
export async function semanticEdit(
    filePath: string,
    symbolName: string,
    newCode: string,
    parser: ASTParser,
    sandbox: AstSandbox,
    mode: EditMode = "replace",
    dryRun: boolean = false,
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

    // Find matching chunks by name (prefer AST symbolName, fallback to regex)
    const matches: Array<{ chunk: ParsedChunk; name: string }> = [];
    const allNames: string[] = [];

    for (const chunk of parseResult.chunks) {
        const name = chunk.symbolName || extractName(chunk);
        if (name) allNames.push(`${name} (L${chunk.startLine}-L${chunk.endLine})`);
        if (name === symbolName) {
            matches.push({ chunk, name });
        }
    }

    // Symbol not found
    if (matches.length === 0) {
        const lowerSymbol = symbolName.toLowerCase();
        const fuzzy = parseResult.chunks
            .map((c) => ({ chunk: c, name: c.symbolName || extractName(c) }))
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

        // BONUS: JIT Heuristic - guess the intended symbol by comparing tokens
        const codeTokens = new Set(newCode.match(/[a-zA-Z_]\w*/g) || []);
        let bestChunk: ParsedChunk | null = null;
        let bestScore = 0;

        for (const chunk of parseResult.chunks) {
            const chunkTokens = new Set(chunk.rawCode.match(/[a-zA-Z_]\w*/g) || []);
            let score = 0;
            for (const term of codeTokens) {
                if (chunkTokens.has(term)) score++;
            }
            if (score > bestScore) {
                bestScore = score;
                bestChunk = chunk;
            }
        }

        if (bestChunk && bestScore >= 5) {
            const guessedName = bestChunk.symbolName || extractName(bestChunk);
            return {
                success: false,
                filePath,
                symbolName,
                oldLines: 0,
                newLines: 0,
                tokensAvoided: 0,
                syntaxValid: false,
                error:
                    `Symbol "${symbolName}" not found. NREKI detected you likely meant to edit \`${guessedName}\`.\n` +
                    `Please retry using: symbol:"${guessedName}"`,
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
                `Use nreki_navigate action:"definition" to identify the correct one.`,
        };
    }

    // ── Single match: perform the edit ──

    const { chunk } = matches[0];
    const rawCode = chunk.rawCode;
    const oldLines = mode === "replace" ? chunk.rawCode.split("\n").length : 0;

    // Apply splice via shared pure function
    let newContent: string;
    try {
        newContent = applySemanticSplice(
            content,
            {
                startIndex: chunk.startIndex,
                endIndex: chunk.endIndex,
                rawCode: chunk.rawCode,
                symbolName: chunk.symbolName || extractName(chunk),
                startLine: chunk.startLine,
            },
            newCode,
            mode,
        );
    } catch (err) {
        return {
            success: false,
            filePath,
            symbolName,
            oldLines: rawCode.split("\n").length,
            newLines: newCode.split("\n").length,
            tokensAvoided: 0,
            syntaxValid: false,
            error: (err as Error).message,
        };
    }

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
                `Syntax error in edited code - file NOT modified:\n${errDetails}\n\n${validation.suggestion}`,
        };
    }

    // Save backup and write to disk ONLY if not dry run
    if (!dryRun) {
        try {
            saveBackup(process.cwd(), filePath);
        } catch {
            // Non-fatal: don't block the edit if backup fails
        }
        fs.writeFileSync(filePath, newContent, "utf-8");
    }

    // Tokens avoided: without NREKI Claude reads full file + sends old symbol code.
    // With NREKI: only sends newCode. Savings = (fullFile + oldSymbol) - newCode.
    const fullFileTokens = Embedder.estimateTokens(content);
    const symbolTokens = Embedder.estimateTokens(rawCode);
    const newCodeTokens = Embedder.estimateTokens(newCode);
    const tokensAvoided = Math.max(0, fullFileTokens + symbolTokens - newCodeTokens);

    return {
        success: true,
        filePath,
        symbolName,
        oldLines,
        newLines: newCode.split("\n").length,
        tokensAvoided,
        syntaxValid: true,
        oldRawCode: rawCode,
        newContent,
    };
}
