#!/usr/bin/env node
/**
 * apply-v10-14-0-block3.mjs — NREKI v10.14.0 Block 3: Multi-Patch Transactional
 *
 * Reemplaza el bloque de mapeo+splice de `batchSemanticEdit` en
 * src/semantic-edit.ts por la arquitectura "Clustering + Micro-Splicing en RAM".
 *
 * Arquitectura base: Pipipi Furia (cross-audit 2026-04-22).
 * Fixes aplicados sobre esa base en audit Claude:
 *
 *   FIX-1  [regex /g flag anti-pattern]
 *          Fuzzy pre-check usaba `new RegExp(pattern, "g")` + `.test()`, lo que
 *          mantiene lastIndex entre llamadas (fragilidad latente). Removido "g".
 *
 *   FIX-2  [batchOldLines mal derivado]
 *          En el loop interno, Pipipi calculaba batchOldLines sobre
 *          currentRawCode (post-mutación), no sobre chunk.rawCode original.
 *          En la práctica no rompía porque replace está rechazado en multi-patch,
 *          pero es semántica incorrecta. Restaurado a chunk.rawCode.
 *
 *   FIX-3  [error message "top-to-bottom" engañoso]
 *          El mensaje decía "apply sequentially top-to-bottom", sugiriendo
 *          orden espacial. El orden real es el del array edits. LLMs leyendo
 *          errores pueden ajustar comportamiento en base a esto. Clarificado.
 *
 *   FIX-4  [re-indent heredado no documentado]
 *          Agregado comentario JSDoc-style antes del loop interno explicando
 *          que mutaciones de patches previos afectan fuzzy-match de siguientes.
 *          Es intencional (permite wrapping en try/catch + edits internos),
 *          pero sin doc es comportamiento oculto.
 *
 * Filosofía del script:
 *   - Search textual exacto del bloque viejo completo. Si no matchea: ABORT.
 *   - Escritura atómica (temp + rename).
 *   - Pre-validación total antes de tocar archivos.
 *
 * Uso:
 *   node scripts/apply-v10-14-0-block3.mjs --dry-run     # simular
 *   node scripts/apply-v10-14-0-block3.mjs               # aplicar
 *
 * NOTA: Este script NO agrega tests nuevos. Esos se mergean en paso 2 tras
 * confirmar que la suite existente (827/827) sigue verde con el nuevo motor.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");

// ─── Target file ────────────────────────────────────────────────────
const TARGET_FILE = "src/semantic-edit.ts";

// ─── Search block: exact code being replaced ────────────────────────
// Escapes: ${ -> \${, ` -> \`, \\ in regex -> \\\\
const SEARCH_BLOCK = `    // 3. For each file: parse ONCE, map edits, reverse splice
    for (const [filePath, fileEdits] of editsByFile.entries()) {
        let virtualCode = vfs.get(filePath)!;
        const parseResult = await parser.parse(filePath, virtualCode);

        // Map each edit to its AST chunk
        const mappedEdits: Array<{ edit: BatchEditOp; chunk: ParsedChunk }> = [];
        for (const edit of fileEdits) {
            // AMBIGUITY CHECK: Reject if multiple symbols share the same name.
            // Without this, batch_edit silently overwrites the first match
            // when the user intended a different overload or getter/setter.
            const allMatches = parseResult.chunks.filter(c => {
                const name = c.symbolName || extractName(c);
                return name === edit.symbol;
            });
            if (allMatches.length > 1) {
                return {
                    success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                    error: \`Ambiguous batch edit: \${allMatches.length} symbols named "\${edit.symbol}" in \${edit.path}. \` +
                           \`Use nreki_navigate action:"outline" to identify exact targets, then edit individually.\`,
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
                    error: \`Symbol "\${edit.symbol}" not found in \${edit.path}. Available: \${available}\`,
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
                        error: \`Overlapping edits: "\${mappedEdits[i].edit.symbol}" and "\${mappedEdits[j].edit.symbol}" \` +
                            \`overlap in \${path.relative(projectRoot, filePath)}. Separate them into two calls.\`,
                    };
                }
            }
        }

        // Reverse splice: sort by startIndex DESCENDING (bottom-up)
        mappedEdits.sort((a, b) => b.chunk.startIndex - a.chunk.startIndex);

        for (const { edit, chunk } of mappedEdits) {
            const key = \`\${edit.path}::\${edit.symbol}\`;
            oldRawCodes.set(key, chunk.rawCode);

            // ─── LEY 4: GUILLOTINA DE OUTPUT (batch) ───
            const batchPayloadLines = (edit.new_code ?? edit.replace_text ?? "").split("\\n").length;
            const batchOldLines = chunk.rawCode.split("\\n").length;
            if (batchPayloadLines > 80) {
                return {
                    success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                    error: \`Blocked: Payload for "\${edit.symbol}" is \${batchPayloadLines}L (limit: 80L). Decompose into smaller functions.\`,
                };
            }
            const batchMode = edit.mode || "replace";
            if ((batchMode === "replace") && batchOldLines > 40) {
                return {
                    success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                    error: \`Blocked: Symbol "\${edit.symbol}" is \${batchOldLines}L (>40L). Use mode:"patch" with search_text and replace_text.\`,
                };
            }

            try {
                const spliceRes = applySemanticSplice(
                    virtualCode,
                    {
                        startIndex: chunk.startIndex,
                        endIndex: chunk.endIndex,
                        rawCode: chunk.rawCode,
                        symbolName: chunk.symbolName || extractName(chunk),
                        startLine: chunk.startLine,
                    },
                    edit.new_code,
                    (edit.mode || "replace") as EditMode,
                    edit.search_text,
                    edit.replace_text,
                );
                virtualCode = spliceRes.newContent;
                newRawCodes.set(key, spliceRes.newRawCode);
            } catch (err) {
                return {
                    success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                    error: \`Error splicing "\${edit.symbol}" in \${edit.path}: \${(err as Error).message}. No files modified.\`,
                };
            }
        }

        vfs.set(filePath, virtualCode);
    }`;

// ─── Replace block: new architecture with 4 fixes applied ───────────
const REPLACE_BLOCK = `    // 3. For each file: parse ONCE, cluster edits by AST node, enforce ACID, apply sequentially
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

        // ─── PHASE A: Cluster edits by AST node identity (startIndex) ───
        const chunkGroups = new Map<number, { chunk: ParsedChunk; edits: BatchEditOp[] }>();

        for (const edit of fileEdits) {
            // AMBIGUITY CHECK: Reject if multiple symbols share the same name.
            const allMatches = parseResult.chunks.filter(c => {
                const name = c.symbolName || extractName(c);
                return name === edit.symbol;
            });
            if (allMatches.length > 1) {
                return {
                    success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                    error: \`Ambiguous batch edit: \${allMatches.length} symbols named "\${edit.symbol}" in \${edit.path}. \` +
                           \`Use nreki_navigate action:"outline" to identify exact targets, then edit individually.\`,
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
                    error: \`Symbol "\${edit.symbol}" not found in \${edit.path}. Available: \${available}\`,
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
                        error: \`Overlapping edits: "\${a.symbolName || extractName(a)}" and "\${b.symbolName || extractName(b)}" \` +
                            \`overlap structurally in \${path.relative(projectRoot, filePath)}. Separate them into two calls.\`,
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
                        error: \`Multiple edits to symbol "\${symName}" detected. \` +
                               \`ALL edits to the same symbol must use mode:"patch". Cannot mix replace/insert.\`,
                    };
                }

                // ACID pre-check: each search_text must exist in the ORIGINAL chunk.
                // Prevents cross-patch corruption where P2 matches content P1 injected.
                const originalRawCode = group.chunk.rawCode;
                const isCRLF = originalRawCode.includes("\\r\\n");

                for (let i = 0; i < group.edits.length; i++) {
                    const edit = group.edits[i];
                    if (!edit.search_text) continue;

                    const normSearch = isCRLF
                        ? edit.search_text.replace(/(?<!\\r)\\n/g, "\\r\\n")
                        : edit.search_text.replace(/\\r\\n/g, "\\n");

                    if (originalRawCode.indexOf(normSearch) === -1) {
                        // Fuzzy fallback — replicates applySemanticSplice's Tier 2 permissiveness.
                        // FIX-1 (audit): no /g flag — .test() with /g mutates lastIndex (anti-pattern).
                        const escapeRegExp = (s: string) => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, m => "\\\\" + m);
                        const lines = normSearch.split(isCRLF ? "\\r\\n" : "\\n");
                        const flexiblePattern = lines.map(line => {
                            const trimmed = line.trimStart();
                            return trimmed ? \`[ \\\\t]*\${escapeRegExp(trimmed)}\` : \`[ \\\\t]*\`;
                        }).join(isCRLF ? "\\\\r\\\\n" : "\\\\n");

                        const fuzzyRegex = new RegExp(flexiblePattern);
                        if (!fuzzyRegex.test(originalRawCode)) {
                            return {
                                success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                                error: \`ACID violation on "\${symName}": search_text for patch #\${i + 1} \` +
                                       \`does not exist in the ORIGINAL source. Rejected to prevent cross-patch corruption. \` +
                                       \`Patches must target the original file state, not content injected by preceding patches.\`,
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
            const key = \`\${filePath}::\${symName}\`;
            oldRawCodes.set(key, chunk.rawCode);

            // Isolated string — the "Limbo". Each patch mutates this, not virtualCode.
            let currentRawCode = chunk.rawCode;

            for (const edit of group.edits) {
                // LEY 4 / guillotine (per-payload).
                // FIX-2 (audit): batchOldLines uses chunk.rawCode (original), not currentRawCode.
                const batchPayloadLines = (edit.new_code ?? edit.replace_text ?? "").split("\\n").length;
                const batchOldLines = chunk.rawCode.split("\\n").length;
                const batchMode = edit.mode || "replace";

                if (batchPayloadLines > 80) {
                    return {
                        success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                        error: \`Blocked: Payload for "\${symName}" is \${batchPayloadLines}L (limit: 80L). Decompose into smaller functions.\`,
                    };
                }

                if ((batchMode === "replace") && batchOldLines > 40) {
                    return {
                        success: false, editCount: edits.length, fileCount: editsByFile.size, files: [],
                        error: \`Blocked: Symbol "\${symName}" is \${batchOldLines}L (>40L). Use mode:"patch" with search_text and replace_text.\`,
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
                        error: \`Error splicing "\${symName}" in \${path.relative(projectRoot, filePath)}: \${(err as Error).message}\\n\` +
                               \`(Note: multiple patches to the same symbol are applied in array order; each patch sees mutations from preceding patches.) No files modified.\`,
                    };
                }
            }

            // ─── PHASE D: Macro-splice — inject the final mutated chunk into virtualCode ───
            virtualCode = virtualCode.slice(0, chunk.startIndex) + currentRawCode + virtualCode.slice(chunk.endIndex);
            newRawCodes.set(key, currentRawCode);
        }

        vfs.set(filePath, virtualCode);
    }`;

// ─── Utilities ──────────────────────────────────────────────────────

function normalizeLE(s) { return s.replace(/\r\n/g, "\n"); }

function writeAtomic(absPath, newContent) {
    const tmp = absPath + ".v10140.tmp";
    fs.writeFileSync(tmp, newContent, "utf8");
    fs.renameSync(tmp, absPath);
}

// ─── Pre-flight ─────────────────────────────────────────────────────

console.log(`[v10.14.0-block3] repo root: ${repoRoot}`);
console.log(`[v10.14.0-block3] mode: ${DRY_RUN ? "DRY RUN" : "APPLY"}`);
console.log("");

const abs = path.join(repoRoot, TARGET_FILE);

if (!fs.existsSync(abs)) {
    console.error(`[ABORT] archivo no existe: ${TARGET_FILE}`);
    process.exit(1);
}

const raw = fs.readFileSync(abs, "utf8");
const isCRLF = raw.includes("\r\n");
const contentLF = normalizeLE(raw);
const searchLF = normalizeLE(SEARCH_BLOCK);
const replaceLF = normalizeLE(REPLACE_BLOCK);

const occurrences = contentLF.split(searchLF).length - 1;
if (occurrences === 0) {
    console.error(`[ABORT] patrón no encontrado en ${TARGET_FILE}.`);
    console.error(`        El archivo cambió desde el diseño del patch.`);
    console.error(`        No se tocó nada. Revisá manualmente.`);
    console.error(``);
    console.error(`        Pista: el bloque a reemplazar empieza con`);
    console.error(`        "// 3. For each file: parse ONCE, map edits, reverse splice"`);
    console.error(`        y termina antes de "// 4. Validate ALL virtual files".`);
    process.exit(1);
}
if (occurrences > 1) {
    console.error(`[ABORT] patrón aparece ${occurrences} veces (esperaba 1).`);
    console.error(`        No se tocó nada. Revisá manualmente.`);
    process.exit(1);
}

console.log(`[VERIFIED] bloque encontrado, ocurrencia única en ${TARGET_FILE}`);
console.log(`[VERIFIED] search block: ${searchLF.split("\n").length} líneas`);
console.log(`[VERIFIED] replace block: ${replaceLF.split("\n").length} líneas`);
console.log("");

if (DRY_RUN) {
    console.log(`[v10.14.0-block3] dry-run complete. No files modified.`);
    process.exit(0);
}

// ─── Apply ──────────────────────────────────────────────────────────

const newContentLF = contentLF.replace(searchLF, replaceLF);
const newContent = isCRLF ? newContentLF.replace(/\n/g, "\r\n") : newContentLF;

writeAtomic(abs, newContent);

console.log(`[APPLIED] ${TARGET_FILE}`);
console.log("");
console.log(`[v10.14.0-block3] bloque reemplazado.`);
console.log(`[v10.14.0-block3] Siguiente paso manual:`);
console.log(`            npx tsc --noEmit`);
console.log(`            npx vitest run tests/batch-edit.test.ts`);
console.log(`            npx vitest run          # suite completa (827/827 esperado)`);
console.log(``);
console.log(`[v10.14.0-block3] Los 3 tests nuevos (happy multi-patch, ACID rejection,`);
console.log(`                  mixed-mode rejection) se agregan en un segundo script`);
console.log(`                  tras confirmar que la suite existente sigue verde.`);
