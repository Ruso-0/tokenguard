#!/usr/bin/env node
/**
 * apply-v10-13-1.mjs — NREKI v10.13.1 hotfix
 *
 * Aplica tres fixes mínimos, verificados en audit cross Pipipi/Claude:
 *
 *   F1 [CSV parse en compress focus]
 *      src/hooks/cognitive-enforcer.ts — "A, B, C" como focus ya suma los tres
 *      símbolos al passport, no el string literal como una entrada única.
 *
 *   F2 [Passport persiste post-edit]
 *      src/hooks/cognitive-enforcer.ts — se elimina el decay agresivo
 *      (focusedSymbols.delete + rawRead = false) que forzaba recompress
 *      después de cada edit. Capas AST + TS-RAM + Cache Tickets ya cubren
 *      correctitud; revocar acá era micro-gestión que causaba deadlocks.
 *
 *   F3 [Hook case-insensitive en Windows]
 *      .claude/hooks/nreki-enforcer.mjs — path.resolve no normaliza case del
 *      drive letter en Windows; la comparación ahora es case-insensitive solo
 *      en win32, sin afectar POSIX.
 *
 * Filosofía del script:
 *   - Search textual exacto (normalizado de CRLF/LF). Si el pattern no matchea
 *     el archivo cambió — ABORTA sin tocar nada. NO intenta "adivinar".
 *   - Escritura atómica (temp + rename) por archivo, igual que NREKI kernel.
 *   - Reporte textual al final. Éxito = exit 0, cualquier falla = exit != 0.
 *
 * Uso:
 *   node scripts/apply-v10-13-1.mjs              # aplica los fixes
 *   node scripts/apply-v10-13-1.mjs --dry-run    # simula, no toca archivos
 *   node scripts/apply-v10-13-1.mjs --self-delete  # auto-borra al terminar OK
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const SELF_DELETE = args.has("--self-delete");

// ─── Fix definitions ────────────────────────────────────────────────
// Patterns usan String.raw para que los backslashes del regex en el código
// fuente se preserven literalmente (p.ej. /\\/g es 2 backslashes reales).

const fixes = [
    {
        id: "F1-csv-parse",
        file: "src/hooks/cognitive-enforcer.ts",
        search: String.raw`                } else if (action === "compress" && params.focus && params.path) {
                    const p = path.resolve(this.projectRoot, params.path).replace(/\\/g, "/");
                    this.getPassport(p).focusedSymbols.add(params.focus);
                    this.getPassport(p).outlined = true;
                    changed = true;
                }`,
        replace: String.raw`                } else if (action === "compress" && params.focus && params.path) {
                    const p = path.resolve(this.projectRoot, params.path).replace(/\\/g, "/");
                    // v10.13.1: parse CSV — "A, B, C" registra los tres símbolos separados.
                    for (const raw of params.focus.split(",")) {
                        const clean = raw.trim();
                        if (clean) this.getPassport(p).focusedSymbols.add(clean);
                    }
                    this.getPassport(p).outlined = true;
                    changed = true;
                }`,
    },
    {
        id: "F2-passport-preserve",
        file: "src/hooks/cognitive-enforcer.ts",
        search: String.raw`                } else if (action === "edit" && params.symbol && params.path) {
                    const p = path.resolve(this.projectRoot, params.path).replace(/\\/g, "/");
                    this.getPassport(p).focusedSymbols.delete(params.symbol);
                    this.getPassport(p).rawRead = false;
                    changed = true;
                } else if (action === "batch_edit" && params.edits) {
                    for (const edit of params.edits) {
                        if (edit.path && edit.symbol) {
                            const p = path.resolve(this.projectRoot, edit.path).replace(/\\/g, "/");
                            this.getPassport(p).focusedSymbols.delete(edit.symbol);
                            this.getPassport(p).rawRead = false;
                            changed = true;
                        }
                    }
                }`,
        replace: String.raw`                } else if (action === "edit" && params.symbol && params.path) {
                    // v10.13.1: passport persiste post-edit. El LLM tiene el símbolo fresco
                    // en su ventana de contexto tras haberlo escrito. Forzar recompress
                    // generaba deadlocks en refactors multi-paso. Capas AST + TS-RAM +
                    // Cache Tickets cubren correctitud e invalidación por edits externos.
                } else if (action === "batch_edit" && params.edits) {
                    // v10.13.1: idem — ver F2 arriba.
                }`,
    },
    {
        id: "F3-hook-windows-case",
        file: ".claude/hooks/nreki-enforcer.mjs",
        search: String.raw`        try {
            absPath = path.resolve(process.cwd(), targetPath).replace(/\\/g, "/");
            const cwdPosix = process.cwd().replace(/\\/g, "/");
            if (!absPath.startsWith(cwdPosix + "/") && absPath !== cwdPosix) {
                console.error("Blocked: Path traversal attempt.");
                process.exit(2);
            }
            size = fs.statSync(absPath).size;
        } catch {`,
        replace: String.raw`        try {
            absPath = path.resolve(process.cwd(), targetPath).replace(/\\/g, "/");
            const cwdPosix = process.cwd().replace(/\\/g, "/");
            // v10.13.1: Windows path.resolve no normaliza case del drive letter.
            // Comparar case-insensitive SOLO en win32 evita falsos positivos con
            // "d:/Nreki/..." vs "D:/Nreki/..." sin afectar semántica en POSIX.
            const isWin = process.platform === "win32";
            const checkAbs = isWin ? absPath.toLowerCase() : absPath;
            const checkCwd = isWin ? cwdPosix.toLowerCase() : cwdPosix;
            if (!checkAbs.startsWith(checkCwd + "/") && checkAbs !== checkCwd) {
                console.error("Blocked: Path traversal attempt.");
                process.exit(2);
            }
            size = fs.statSync(absPath).size;
        } catch {`,
    },
];

// ─── Utilities ──────────────────────────────────────────────────────

function normalizeLE(s) { return s.replace(/\r\n/g, "\n"); }

function writeAtomic(absPath, newContent) {
    const tmp = absPath + ".v10131.tmp";
    fs.writeFileSync(tmp, newContent, "utf8");
    fs.renameSync(tmp, absPath);
}

// ─── Pre-flight: verify all patterns BEFORE writing anything ────────

console.log(`[v10.13.1] repo root: ${repoRoot}`);
console.log(`[v10.13.1] mode: ${DRY_RUN ? "DRY RUN" : "APPLY"}${SELF_DELETE ? " (+ self-delete on success)" : ""}`);
console.log("");

const plan = [];

for (const fix of fixes) {
    const abs = path.join(repoRoot, fix.file);

    if (!fs.existsSync(abs)) {
        console.error(`[ABORT] ${fix.id}: archivo no existe: ${fix.file}`);
        console.error(`        No se tocó ningún archivo.`);
        process.exit(1);
    }

    const raw = fs.readFileSync(abs, "utf8");
    const isCRLF = raw.includes("\r\n");
    const contentLF = normalizeLE(raw);
    const searchLF = normalizeLE(fix.search);
    const replaceLF = normalizeLE(fix.replace);

    const occurrences = contentLF.split(searchLF).length - 1;
    if (occurrences === 0) {
        console.error(`[ABORT] ${fix.id}: patrón no encontrado en ${fix.file}`);
        console.error(`        El archivo cambió desde el diseño del patch.`);
        console.error(`        No se tocó ningún archivo. Revisá manualmente.`);
        process.exit(1);
    }
    if (occurrences > 1) {
        console.error(`[ABORT] ${fix.id}: patrón aparece ${occurrences} veces en ${fix.file} (esperaba 1).`);
        console.error(`        No se tocó ningún archivo. Revisá manualmente.`);
        process.exit(1);
    }

    const newContentLF = contentLF.replace(searchLF, replaceLF);
    const newContent = isCRLF ? newContentLF.replace(/\n/g, "\r\n") : newContentLF;

    plan.push({ fix, abs, newContent });
    console.log(`[VERIFIED] ${fix.id}: pattern único encontrado en ${fix.file}`);
}

console.log("");
console.log(`[v10.13.1] 3/3 patterns verified. ${DRY_RUN ? "Simulating." : "Applying."}`);

if (DRY_RUN) {
    console.log(`[v10.13.1] dry-run complete. No files modified.`);
    process.exit(0);
}

// ─── Apply ──────────────────────────────────────────────────────────

for (const { fix, abs, newContent } of plan) {
    writeAtomic(abs, newContent);
    console.log(`[APPLIED] ${fix.id}: ${fix.file}`);
}

console.log("");
console.log(`[v10.13.1] 3 fixes applied.`);
console.log(`[v10.13.1] Siguiente paso manual:`);
console.log(`            npx tsc --noEmit`);
console.log(`            npx vitest run tests/cognitive-enforcer.test.ts`);
console.log(`            npx vitest run tests/batch-edit.test.ts`);
console.log(`            npx vitest run tests/cache-tickets.test.ts`);

if (SELF_DELETE) {
    try {
        fs.unlinkSync(__filename);
        console.log(`[v10.13.1] self-deleted: ${__filename}`);
    } catch (e) {
        console.warn(`[v10.13.1] self-delete failed: ${e.message}`);
    }
}
