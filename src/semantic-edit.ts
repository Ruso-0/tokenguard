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
import { ASTParser, type ParsedChunk, normalizeWebSymbol } from "./parser.js";
import { AstSandbox } from "./ast-sandbox.js";
import { Embedder } from "./embedder.js";
import { readSource } from "./utils/read-source.js";
import { saveBackup, getBackupPath } from "./undo.js";
import { extractSignature, cleanSignature, extractImports, extractExports } from "./repo-map.js";
import { logger } from "./utils/logger.js";
import crypto from "crypto";

// ─── Types ───────────────────────────────────────────────────────────

export type EditMode = "replace" | "insert_before" | "insert_after" | "patch";

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
    newRawCode?: string;
    newContent?: string;
    topologyChanged?: boolean;
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
        ".css": "css",
        ".json": "json",
        ".html": "html",
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

export interface SpliceResult {
    newContent: string;
    newRawCode: string;
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
    newCode: string | undefined,
    mode: EditMode = "replace",
    searchText?: string,
    replaceText?: string,
): SpliceResult {
    const { startIndex, rawCode } = target;

    // Verify tree-sitter byte position against actual content
    let startIdx = startIndex;
    if (content.substring(startIdx, startIdx + rawCode.length) !== rawCode) {
        // ±500 byte search window. Duplicate symbols within range are detected and rejected.
        const windowStart = Math.max(0, startIdx - 500);
        const windowEnd = Math.min(content.length, startIdx + rawCode.length + 500);
        const searchWindow = content.substring(windowStart, windowEnd);
        let matchCount = 0;
        let bestOffset = -1;
        let scanPos = searchWindow.indexOf(rawCode);
        while (scanPos >= 0) {
            matchCount++;
            if (matchCount === 1) bestOffset = scanPos;
            if (matchCount > 1) break;
            scanPos = searchWindow.indexOf(rawCode, scanPos + 1);
        }

        // AUDIT FIX: Abort if multiple identical symbols exist in the search window
        if (matchCount > 1) {
            throw new Error(
                `Ambiguous AST match: ${matchCount} occurrences of "${target.symbolName}" found within ±500 bytes. ` +
                `Use nreki_navigate action:"outline" to identify exact lines and use batch_edit.`
            );
        }

        if (bestOffset >= 0) {
            startIdx = windowStart + bestOffset;
        } else {
            startIdx = -1;
        }

        if (startIdx < 0) {
            throw new Error(
                `Cannot locate symbol "${target.symbolName}" in file content. AST offset mismatch.`,
            );
        }
    }
    const endIdx = startIdx + rawCode.length;

    // ─── PHANTOM SCALPEL: Symbol-Scoped Patching (v9.0) ─────────
    if (mode === "patch") {
        if (!searchText || searchText.length < 2) {
            throw new Error(
                `[NREKI] Patch mode requires 'search_text' of at least 2 characters.`
            );
        }

        const symbolContent = content.substring(startIdx, endIdx);

        // Adapt search text to target file's line endings (CRLF vs LF) to prevent indexOf mismatch
        const isCRLF = symbolContent.includes('\r\n');
        const normSearchText = isCRLF ? searchText.replace(/(?<!\r)\n/g, '\r\n') : searchText.replace(/\r\n/g, '\n');
        const normReplaceText = replaceText ? (isCRLF ? replaceText.replace(/(?<!\r)\n/g, '\r\n') : replaceText.replace(/\r\n/g, '\n')) : "";

        // AUDIT FIX (Patch 3 / v10.5.8): Tolerant Patch — two-tier matching.
        // Tier 1: exact match (fast path). Tier 2: indent-tolerant fuzzy match
        // when the agent's search_text has stale indent but unique content.
        let occurrences = symbolContent.split(normSearchText).length - 1;
        let finalSearchText = normSearchText;
        let finalReplaceText = normReplaceText;

        if (occurrences === 0) {
            // Callback form avoids V8 substitution patterns in the replacement.
            const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, m => "\\" + m);
            const lines = normSearchText.split(isCRLF ? "\r\n" : "\n");
            const flexiblePattern = lines.map(line => {
                const trimmed = line.trimStart();
                return trimmed ? `[ \\t]*${escapeRegExp(trimmed)}` : `[ \\t]*`;
            }).join(isCRLF ? "\\r\\n" : "\\n");

            const fuzzyRegex = new RegExp(flexiblePattern, "g");
            const matches = symbolContent.match(fuzzyRegex) || [];
            occurrences = matches.length;
            const firstMatch = matches[0];
            if (occurrences === 1 && firstMatch !== undefined) {
                finalSearchText = firstMatch;
                const origIndentMatch = finalSearchText.match(/^[ \t]*/);
                const origIndent = origIndentMatch ? origIndentMatch[0] : "";
                const searchIndentMatch = normSearchText.match(/^[ \t]*/);
                const searchIndent = searchIndentMatch ? searchIndentMatch[0] : "";

                if (normReplaceText) {
                    const replaceLines = normReplaceText.split(isCRLF ? "\r\n" : "\n");
                    finalReplaceText = replaceLines.map(line => {
                        if (line.startsWith(searchIndent)) {
                            return origIndent + line.slice(searchIndent.length);
                        }
                        return line;
                    }).join(isCRLF ? "\r\n" : "\n");
                }
            }
        }

        if (occurrences === 0) {
            const preview = symbolContent.length > 300
                ? symbolContent.substring(0, 300) + "..."
                : symbolContent;
            throw new Error(
                `[NREKI] Patch failed: Exact or indentation-tolerant match not found inside symbol "${target.symbolName}".\n` +
                `Target AST content starts with:\n\`\`\`\n${preview}\n\`\`\``
            );
        }
        if (occurrences > 1) {
            throw new Error(
                `[NREKI] Patch ambiguous: "${searchText}" found ${occurrences} times ` +
                `inside "${target.symbolName}". Provide more surrounding context to disambiguate.`
            );
        }

        // split/join bypasses V8 substitution patterns (safe: occurrences === 1).
        const patchedRawCode = symbolContent.split(finalSearchText).join(finalReplaceText);

        return {
            newContent: content.slice(0, startIdx) + patchedRawCode + content.slice(endIdx),
            newRawCode: patchedRawCode,
        };
    }
    // ─── END PHANTOM SCALPEL ─────────────────────────────────────

    if (newCode === undefined) {
        throw new Error(`[NREKI] "new_code" is required for mode "${mode}".`);
    }

    // Normalize newCode line endings to LF before splitting (prevents \r residue from CRLF payloads)
    const cleanNewCode = newCode.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // Extract exact original indentation
    let lineStart = startIdx;
    while (lineStart > 0 && content[lineStart - 1] !== "\n") lineStart--;
    if (content[lineStart] === "\r") lineStart++;
    const indentMatch = content.slice(lineStart, startIdx).match(/^[ \t]*/);
    const baseIndent = indentMatch ? indentMatch[0] : "";

    // Calculate minimum indentation in the new code (SKIP first line)
    const newLines = cleanNewCode.split("\n");
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
        return {
            newContent: content.slice(0, lineStart) + formattedNewCode + "\n\n" + content.slice(lineStart),
            newRawCode: formattedNewCode,
        };
    } else if (mode === "insert_after") {
        let endOfLine = endIdx;
        while (endOfLine < content.length && content[endOfLine] !== "\n") endOfLine++;
        return {
            newContent: content.slice(0, endOfLine) + "\n\n" + formattedNewCode + content.slice(endOfLine),
            newRawCode: formattedNewCode,
        };
    } else {
        return {
            newContent: content.slice(0, startIdx) + formattedNewCode + content.slice(endIdx),
            newRawCode: formattedNewCode,
        };
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
    new_code?: string;
    mode?: EditMode;
    search_text?: string;
    replace_text?: string;
}

export interface BatchEditResult {
    success: boolean;
    editCount: number;
    fileCount: number;
    files: string[];
    error?: string;
    /** Per-edit old raw code (for blast radius detection) */
    oldRawCodes?: Map<string, string>;
    newRawCodes?: Map<string, string>;
    vfs?: Map<string, string>;
    topologyChanged?: boolean;
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

    // LEY 4.5 — Batch Global Guillotine: reject oversized payloads
    let totalPayloadLines = 0;
    for (const edit of edits) {
        if (edit.new_code) totalPayloadLines += edit.new_code.split("\n").length;
        if (edit.replace_text) totalPayloadLines += edit.replace_text.split("\n").length;
    }
    if (totalPayloadLines > 500) {
        return {
            success: false, editCount: edits.length, fileCount: 0, files: [],
            error: `Batch payload too large (${totalPayloadLines} lines, max 500). Use mode:"patch" to send smaller diffs.`,
        };
    }

    // 1. Group edits by file, resolving paths
    const editsByFile = new Map<string, BatchEditOp[]>();
    for (const edit of edits) {
        const resolved = safePath(projectRoot, edit.path);
        const arr = editsByFile.get(resolved) || [];
        arr.push(edit);
        editsByFile.set(resolved, arr);
    }

    // 2. Build VFS in RAM (capture original content once, share reference)
    const vfs = new Map<string, string>();
    const originalVfs = new Map<string, string>();
    for (const filePath of editsByFile.keys()) {
        try {
            const code = readSource(filePath);
            vfs.set(filePath, code);
            originalVfs.set(filePath, code);
        } catch (err) {
            return {
                success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                error: `Cannot read file "${filePath}": ${(err as Error).message}`,
            };
        }
    }

    // Track old/new raw codes for blast radius detection
    const oldRawCodes = new Map<string, string>();
    const newRawCodes = new Map<string, string>();

    // 3. For each file: parse ONCE, cluster edits by AST node, enforce ACID, apply sequentially
    //
    // v10.14.0 Block 3: Multi-Patch Transactional.
    // Multiple patches to the SAME symbol are now allowed (all must be mode:"patch").
    // Each patch is applied sequentially inside an isolated chunk string ("the Limbo"),
    // then the final mutated chunk is spliced back into the global virtualCode.
    //
    // Multi-patch re-indent inheritance: when a preceding patch alters indentation
    // (e.g. wrapping code in try/catch), subsequent fuzzy-matched patches inherit
    // the new indent via applySemanticSplice's Tier 2 tolerant matching. This is
    // INTENTIONAL — it keeps sequential patches causally consistent. Edits are
    // applied in the order they appear in the edits array.
    for (const [filePath, fileEdits] of editsByFile.entries()) {
        let virtualCode = vfs.get(filePath)!;
        const parseResult = await parser.parse(filePath, virtualCode);
        const ext = path.extname(filePath).toLowerCase();

        // ─── PHASE A: Cluster edits by AST node identity (startIndex) ───
        const chunkGroups = new Map<number, { chunk: ParsedChunk; edits: BatchEditOp[] }>();

        for (const edit of fileEdits) {
            // v10.18.1: normalize web symbols IN-PLACE so downstream
            // oldRawCodes/newRawCodes keys (built from chunk.symbolName)
            // align with handleBatchEdit's blast-radius lookup
            // (built from edit.symbol). Without in-place mutation,
            // signature changes on .css/.json/.html files would evade
            // detection silently.
            edit.symbol = normalizeWebSymbol(edit.symbol, ext);

            // AMBIGUITY CHECK: Reject if multiple symbols share the same name.
            const allMatches = parseResult.chunks.filter(c => {
                const name = c.symbolName || extractName(c);
                return name === edit.symbol;
            });
            if (allMatches.length > 1) {
                return {
                    success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                    error: `Ambiguous batch edit: ${allMatches.length} symbols named "${edit.symbol}" in ${edit.path}. ` +
                           `Use nreki_navigate action:"outline" to identify exact targets, then edit individually.`,
                };
            }

            const chunk = allMatches[0] || findChunkBySymbol(parseResult.chunks, edit.symbol);
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

            const group = chunkGroups.get(chunk.startIndex) || { chunk, edits: [] };
            group.edits.push(edit);
            chunkGroups.set(chunk.startIndex, group);
        }

        const uniqueChunks = Array.from(chunkGroups.values());

        // ─── PHASE B: Structural & ACID validation ───

        // B.1 — Inter-chunk overlap (parent/child nesting): reject.
        for (let i = 0; i < uniqueChunks.length; i++) {
            for (let j = i + 1; j < uniqueChunks.length; j++) {
                const a = uniqueChunks[i].chunk;
                const b = uniqueChunks[j].chunk;
                if (a.startIndex < b.endIndex && b.startIndex < a.endIndex) {
                    return {
                        success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                        error: `Overlapping edits: "${a.symbolName || extractName(a)}" and "${b.symbolName || extractName(b)}" ` +
                            `overlap structurally in ${path.relative(projectRoot, filePath)}. Separate them into two calls.`,
                    };
                }
            }
        }

        // B.2 — Intra-chunk rules: mixed modes rejected + ACID pre-check.
        for (const group of uniqueChunks) {
            const symName = group.chunk.symbolName || extractName(group.chunk);
            if (group.edits.length > 1) {
                const hasNonPatch = group.edits.some(e => (e.mode || "replace") !== "patch");
                if (hasNonPatch) {
                    return {
                        success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                        error: `Multiple edits to symbol "${symName}" detected. ` +
                               `ALL edits to the same symbol must use mode:"patch". Cannot mix replace/insert.`,
                    };
                }

                // ACID pre-check: each search_text must exist in the ORIGINAL chunk.
                // Prevents cross-patch corruption where P2 matches content P1 injected.
                const originalRawCode = group.chunk.rawCode;
                const isCRLF = originalRawCode.includes("\r\n");

                for (let i = 0; i < group.edits.length; i++) {
                    const edit = group.edits[i];
                    if (!edit.search_text) continue;

                    const normSearch = isCRLF
                        ? edit.search_text.replace(/(?<!\r)\n/g, "\r\n")
                        : edit.search_text.replace(/\r\n/g, "\n");

                    if (originalRawCode.indexOf(normSearch) === -1) {
                        // Fuzzy fallback — replicates applySemanticSplice's Tier 2 permissiveness.
                        // FIX-1 (audit): no /g flag — .test() with /g mutates lastIndex (anti-pattern).
                        const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, m => "\\" + m);
                        const lines = normSearch.split(isCRLF ? "\r\n" : "\n");
                        const flexiblePattern = lines.map(line => {
                            const trimmed = line.trimStart();
                            return trimmed ? `[ \\t]*${escapeRegExp(trimmed)}` : `[ \\t]*`;
                        }).join(isCRLF ? "\\r\\n" : "\\n");

                        const fuzzyRegex = new RegExp(flexiblePattern);
                        if (!fuzzyRegex.test(originalRawCode)) {
                            return {
                                success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                                error: `ACID violation on "${symName}": search_text for patch #${i + 1} ` +
                                       `does not exist in the ORIGINAL source. Rejected to prevent cross-patch corruption. ` +
                                       `Patches must target the original file state, not content injected by preceding patches.`,
                            };
                        }
                    }
                }
            }
        }

        // Reverse splice: sort chunks by startIndex DESCENDING (bottom-up).
        // Safe because each chunk's final content is spliced in one atomic step;
        // indices of unprocessed (earlier) chunks don't shift.
        uniqueChunks.sort((a, b) => b.chunk.startIndex - a.chunk.startIndex);

        // ─── PHASE C: Micro-transactions in RAM (per chunk) ───
        for (const group of uniqueChunks) {
            const chunk = group.chunk;
            const symName = chunk.symbolName || extractName(chunk);
            const key = `${filePath}::${symName}`;
            oldRawCodes.set(key, chunk.rawCode);

            // Isolated string — the "Limbo". Each patch mutates this, not virtualCode.
            let currentRawCode = chunk.rawCode;

            for (const edit of group.edits) {
                // LEY 4 / guillotine (per-payload).
                // FIX-2 (audit): batchOldLines uses chunk.rawCode (original), not currentRawCode.
                const batchPayloadLines = (edit.new_code ?? edit.replace_text ?? "").split("\n").length;
                const batchOldLines = chunk.rawCode.split("\n").length;
                const batchMode = edit.mode || "replace";

                if (batchPayloadLines > 80) {
                    return {
                        success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                        error: `Blocked: Payload for "${symName}" is ${batchPayloadLines}L (limit: 80L). Decompose into smaller functions.`,
                    };
                }

                if ((batchMode === "replace") && batchOldLines > 40) {
                    return {
                        success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                        error: `Blocked: Symbol "${symName}" is ${batchOldLines}L (>40L). Use mode:"patch" with search_text and replace_text.`,
                    };
                }

                try {
                    // Fake target: treat currentRawCode as if it were the whole file.
                    // applySemanticSplice's ±500-byte AST offset check is bypassed because
                    // content.substring(0, currentRawCode.length) === currentRawCode trivially.
                    const fakeTarget: SpliceTarget = {
                        startIndex: 0,
                        endIndex: currentRawCode.length,
                        rawCode: currentRawCode,
                        symbolName: symName,
                        startLine: chunk.startLine,
                    };

                    const spliceRes = applySemanticSplice(
                        currentRawCode,
                        fakeTarget,
                        edit.new_code,
                        batchMode as EditMode,
                        edit.search_text,
                        edit.replace_text,
                    );

                    currentRawCode = spliceRes.newContent;
                } catch (err) {
                    // FIX-3 (audit): clarify sequencing — "in array order", not "top-to-bottom".
                    return {
                        success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                        error: `Error splicing "${symName}" in ${path.relative(projectRoot, filePath)}: ${(err as Error).message}\n` +
                               `(Note: multiple patches to the same symbol are applied in array order; each patch sees mutations from preceding patches.) No files modified.`,
                    };
                }
            }

            // ─── PHASE D: Macro-splice — inject the final mutated chunk into virtualCode ───
            virtualCode = virtualCode.slice(0, chunk.startIndex) + currentRawCode + virtualCode.slice(chunk.endIndex);
            newRawCodes.set(key, currentRawCode);
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

        // ─── NREKI L1.5: REACT/JSX SEMANTIC SHIELD (BATCH) ───
        if (language === "typescript" || language === "javascript") {
            try {
                const { reactEslintSidecar } = await import("./eslint-sidecar.js");

                // Anti-Sweep sobre cada payload de las ops de este archivo
                const fileOps = editsByFile.get(filePath) || [];
                for (const op of fileOps) {
                    const payloads = [op.new_code, op.replace_text].filter(Boolean) as string[];
                    for (const payload of payloads) {
                        if (reactEslintSidecar.checkAntiSweep(payload)) {
                            return {
                                success: false,
                                editCount: edits.length,
                                fileCount: editsByFile.size,
                                files: [],
                                error: `TRANSACTION ABORTED - Blocked by Anti-Sweep Shield in ${path.relative(projectRoot, filePath)}: ESLint suppression comments for React critical rules are forbidden. Fix the underlying architectural flaw.`
                            };
                        }
                    }
                }

                const lintErrors = await reactEslintSidecar.validate(virtualContent, filePath);

                if (lintErrors.length > 0) {
                    const errDetail = lintErrors.slice(0, 3).map(e =>
                        `  L${e.line}:${e.column} [${e.code}] - ${e.message}`
                    ).join("\n");

                    return {
                        success: false,
                        editCount: edits.length,
                        fileCount: editsByFile.size,
                        files: [],
                        error: `TRANSACTION ABORTED - React/JSX Rule Violation in ${path.relative(projectRoot, filePath)}:\n${errDetail}\n\nNo files were modified.\nFix the violation and resend the full batch. Do not use suppressions.`
                    };
                }
            } catch (e) {
                logger.warn(`React shield bypassed in batch: ${(e as Error).message}`);
            }
        }
        // ─── END REACT SHIELD (BATCH) ───
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
                    try {
                        // Atomic restore — copyFileSync is NOT atomic.
                        // If the process dies mid-copy (OOM, Ctrl+C), the user's
                        // file is left truncated. Write to tmp then rename.
                        const tmpRollback = donePath + ".rollback-" + crypto.randomBytes(4).toString("hex");
                        fs.copyFileSync(backupPath, tmpRollback);
                        fs.renameSync(tmpRollback, donePath);
                    } catch {}
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

    let topologyChanged = false;
    for (const [filePath, virtualContent] of vfs.entries()) {
        const oldContent = originalVfs.get(filePath);
        if (!oldContent) continue;
        const ext = path.extname(filePath).toLowerCase();
        if (extractImports(oldContent, ext).join(",") !== extractImports(virtualContent, ext).join(",") ||
            extractExports(oldContent, ext).join(",") !== extractExports(virtualContent, ext).join(",")) {
            topologyChanged = true;
            break;
        }
    }
    if (!topologyChanged) {
        for (const edit of edits) {
            if (edit.mode && edit.mode !== "replace" && edit.mode !== "patch") continue;
            const key = `${safePath(projectRoot, edit.path)}::${edit.symbol}`;
            const oldRaw = oldRawCodes.get(key);
            const newRaw = newRawCodes.get(key);
            if (oldRaw && newRaw && detectSignatureChange(oldRaw, newRaw)) {
                topologyChanged = true;
                break;
            }
        }
    }

    return {
        success: true,
        editCount: edits.length,
        fileCount: editsByFile.size,
        files: writtenFiles,
        oldRawCodes,
        newRawCodes,
        vfs,
        topologyChanged,
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
    newCode: string | undefined,
    parser: ASTParser,
    sandbox: AstSandbox,
    projectRoot: string,
    mode: EditMode = "replace",
    dryRun: boolean = false,
    searchText?: string,
    replaceText?: string,
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

    // v10.18.1: normalize web symbols at API boundary so LLM-supplied
    // ".foo" / '"key"' match parser-normalized chunk.symbolName.
    const ext = path.extname(filePath).toLowerCase();
    symbolName = normalizeWebSymbol(symbolName, ext);

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
        const codeTokens = new Set((newCode ?? "").match(/[a-zA-Z_]\w*/g) || []);
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

    // ─── LEY 4: GUILLOTINA DE OUTPUT (Doble Filo) ───
    const payloadLines = (newCode ?? replaceText ?? "").split("\n").length;

    // Filo 1: Bloquea payloads monstruosos
    if (payloadLines > 80) {
        return {
            success: false, filePath, symbolName, oldLines,
            newLines: payloadLines, tokensAvoided: 0, syntaxValid: false,
            error: `Blocked: Generated payload is ${payloadLines}L (limit: 80L). Decompose into smaller functions.`,
        };
    }
    // Filo 2: Bloquea rewrite de símbolos grandes
    if ((mode === "replace" || !mode) && oldLines > 40) {
        return {
            success: false, filePath, symbolName, oldLines,
            newLines: 0, tokensAvoided: 0, syntaxValid: false,
            error: `Blocked: Symbol >40L. Use mode:"patch" with search_text and replace_text.`,
        };
    }

    // Apply splice via shared pure function
    let newContent: string;
    let spliceRes: SpliceResult;
    try {
        spliceRes = applySemanticSplice(
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
            searchText,
            replaceText,
        );
        newContent = spliceRes.newContent;
    } catch (err) {
        return {
            success: false,
            filePath,
            symbolName,
            oldLines: rawCode.split("\n").length,
            newLines: newCode ? newCode.split("\n").length : 0,
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
            newLines: (newCode ?? spliceRes.newRawCode).split("\n").length,
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
            newLines: (newCode ?? spliceRes.newRawCode).split("\n").length,
            tokensAvoided: 0,
            syntaxValid: false,
            error:
                `Syntax error in edited code - file NOT modified:\n${errDetails}\n\n${validation.suggestion}`,
        };
    }

    // ─── NREKI L1.5: REACT/JSX SEMANTIC SHIELD ───
    if (language === "typescript" || language === "javascript") {
        try {
            const { reactEslintSidecar } = await import("./eslint-sidecar.js");

            // Anti-Sweep check SOLO sobre el payload nuevo (no archivo legacy completo)
            const payload = newCode ?? spliceRes.newRawCode ?? "";
            if (reactEslintSidecar.checkAntiSweep(payload)) {
                return {
                    success: false,
                    filePath,
                    symbolName,
                    oldLines: rawCode.split("\n").length,
                    newLines: payload.split("\n").length,
                    tokensAvoided: 0,
                    syntaxValid: true,
                    error: `Blocked by Anti-Sweep Shield: ESLint suppression comments (eslint-disable) for React critical rules are forbidden. Fix the underlying architectural flaw.`
                };
            }

            const lintErrors = await reactEslintSidecar.validate(newContent, filePath);

            if (lintErrors.length > 0) {
                const errDetails = lintErrors.slice(0, 3).map(e =>
                    `  L${e.line}:${e.column} [${e.code}] - ${e.message}`
                ).join("\n");

                return {
                    success: false,
                    filePath,
                    symbolName,
                    oldLines: rawCode.split("\n").length,
                    newLines: payload.split("\n").length,
                    tokensAvoided: 0,
                    syntaxValid: true,
                    error: `React/JSX Rule Violation detected - file NOT modified:\n${errDetails}\n\nFix the violation and retry. Do not use suppressions.`
                };
            }
        } catch (e) {
            logger.warn(`React shield bypassed: ${(e as Error).message}`);
        }
    }
    // ─── END REACT SHIELD ───

    // Save backup and write to disk ONLY if not dry run
    if (!dryRun) {
        try {
            saveBackup(projectRoot, filePath);
        } catch {
            // Non-fatal: don't block the edit if backup fails
        }
        // Atomic write via temp+rename. writeFileSync is NOT atomic —
        // OOM/crash mid-write truncates the file to 0 bytes.
        const tmpPath = `${filePath}.nreki-${crypto.randomBytes(4).toString("hex")}.tmp`;
        fs.writeFileSync(tmpPath, newContent, "utf-8");
        fs.renameSync(tmpPath, filePath);
    }

    // Tokens avoided: without NREKI Claude reads full file + sends old symbol code.
    // With NREKI: only sends newCode. Savings = (fullFile + oldSymbol) - newCode.
    const fullFileTokens = Embedder.estimateTokens(content);
    const symbolTokens = Embedder.estimateTokens(rawCode);
    const newCodeTokens = Embedder.estimateTokens(newCode ?? spliceRes.newRawCode);
    const tokensAvoided = Math.max(0, fullFileTokens + symbolTokens - newCodeTokens);

    let topologyChanged = false;
    if (rawCode && spliceRes.newRawCode && detectSignatureChange(rawCode, spliceRes.newRawCode)) {
        topologyChanged = true;
    }
    if (!topologyChanged) {
        const oldImports = extractImports(content, ext);
        const newImports = extractImports(newContent, ext);
        if (oldImports.join(",") !== newImports.join(",")) topologyChanged = true;
        if (!topologyChanged) {
            const oldExports = extractExports(content, ext);
            const newExports = extractExports(newContent, ext);
            if (oldExports.join(",") !== newExports.join(",")) topologyChanged = true;
        }
    }

    return {
        success: true,
        filePath,
        symbolName,
        oldLines,
        newLines: (newCode ?? spliceRes.newRawCode).split("\n").length,
        tokensAvoided,
        syntaxValid: true,
        oldRawCode: rawCode,
        newRawCode: spliceRes.newRawCode,
        newContent,
        topologyChanged,
    };
}
