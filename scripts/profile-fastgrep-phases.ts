/**
 * profile-fastgrep-phases.ts - Break down handleFastGrep cost into phases.
 *
 * For the "export" query (156 matches over NREKI src/), measure:
 *   A: SQLite fetch only (engine.fastGrep)
 *   B: + byFile Map construction
 *   C: + outer sort + inner pointer walk (no string allocation)
 *   D: + per-match substring(..).trim() (context extraction)
 *   E: + per-match lines.push() with template literals (reporting)
 *   F: + lines.join() (final serialization)
 *   G: the full handler (handleFastGrep)
 *
 * 20 iterations each, warmup discarded, median reported.
 */

import path from "path";
import fs from "fs";
import { NrekiEngine } from "../src/engine.js";
import { handleFastGrep } from "../src/handlers/navigate.js";
import type { ChunkRecord } from "../src/database.js";
import type { RouterDependencies } from "../src/router.js";

const ROOT = path.resolve(".");
const SRC = path.join(ROOT, "src");
const N = 20;
const WARMUP = 1;
const QUERY = "export";

function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    return Math.round(s[Math.floor(s.length / 2)] * 100) / 100;
}

async function main() {
    const engine = new NrekiEngine({
        dbPath: path.join(ROOT, ".nreki-profile-phases.db"),
        watchPaths: [SRC],
    });
    await engine.initialize();

    console.log("Indexing ...");
    const walkIdx = async (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!["node_modules", "dist", ".git"].includes(e.name)) await walkIdx(full);
            } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && !e.name.endsWith(".d.ts")) {
                try { await engine.indexFile(full); } catch {}
            }
        }
    };
    await walkIdx(SRC);

    const deps = { engine } as unknown as RouterDependencies;

    // Phase A: SQLite fetch only
    const phaseA: number[] = [];
    for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        await engine.fastGrep(QUERY, 1000);
        const dt = performance.now() - t0;
        if (i >= WARMUP) phaseA.push(dt);
    }

    // Baseline: fetch chunks once for in-memory phases
    const chunks = await engine.fastGrep(QUERY, 1000);
    const root = engine.getProjectRoot();

    // Phase B: + byFile Map
    const phaseB: number[] = [];
    for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        const byFile = new Map<string, ChunkRecord[]>();
        for (const c of chunks) {
            const arr = byFile.get(c.path) || [];
            arr.push(c);
            byFile.set(c.path, arr);
        }
        const dt = performance.now() - t0;
        if (i >= WARMUP) phaseB.push(dt);
    }

    // Phase C: + outer sort + pointer walk, no string work
    const phaseC: number[] = [];
    for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        const byFile = new Map<string, ChunkRecord[]>();
        for (const c of chunks) {
            const arr = byFile.get(c.path) || [];
            arr.push(c);
            byFile.set(c.path, arr);
        }
        let matchCount = 0;
        for (const [, fileChunks] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            for (const chunk of fileChunks) {
                let scanPos = chunk.raw_code.indexOf(QUERY);
                if (scanPos === -1) continue;
                const reportedLines = new Set<number>();
                let currentLineOffset = 0;
                let currentLineStart = 0;
                let nextNl = chunk.raw_code.indexOf("\n");
                while (scanPos !== -1) {
                    while (nextNl !== -1 && nextNl < scanPos) {
                        currentLineOffset++;
                        currentLineStart = nextNl + 1;
                        nextNl = chunk.raw_code.indexOf("\n", currentLineStart);
                    }
                    const exactLine = chunk.start_line + currentLineOffset;
                    if (!reportedLines.has(exactLine)) {
                        reportedLines.add(exactLine);
                        matchCount++;
                    }
                    scanPos = chunk.raw_code.indexOf(QUERY, scanPos + QUERY.length);
                }
                void currentLineStart;
            }
        }
        void matchCount;
        const dt = performance.now() - t0;
        if (i >= WARMUP) phaseC.push(dt);
    }

    // Phase D: + context extraction (substring + trim) per match, no push
    const phaseD: number[] = [];
    for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        const byFile = new Map<string, ChunkRecord[]>();
        for (const c of chunks) {
            const arr = byFile.get(c.path) || [];
            arr.push(c);
            byFile.set(c.path, arr);
        }
        let sink = 0;
        for (const [, fileChunks] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            for (const chunk of fileChunks) {
                let scanPos = chunk.raw_code.indexOf(QUERY);
                if (scanPos === -1) continue;
                const reportedLines = new Set<number>();
                let currentLineOffset = 0;
                let currentLineStart = 0;
                let nextNl = chunk.raw_code.indexOf("\n");
                while (scanPos !== -1) {
                    while (nextNl !== -1 && nextNl < scanPos) {
                        currentLineOffset++;
                        currentLineStart = nextNl + 1;
                        nextNl = chunk.raw_code.indexOf("\n", currentLineStart);
                    }
                    const exactLine = chunk.start_line + currentLineOffset;
                    if (!reportedLines.has(exactLine)) {
                        reportedLines.add(exactLine);
                        const lineEnd = nextNl !== -1 ? nextNl : chunk.raw_code.length;
                        const context = chunk.raw_code.substring(currentLineStart, lineEnd).trim();
                        sink += context.length;
                    }
                    scanPos = chunk.raw_code.indexOf(QUERY, scanPos + QUERY.length);
                }
            }
        }
        void sink;
        const dt = performance.now() - t0;
        if (i >= WARMUP) phaseD.push(dt);
    }

    // Phase E: + per-match template literal lines.push() (includes context)
    const phaseE: number[] = [];
    for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        const byFile = new Map<string, ChunkRecord[]>();
        for (const c of chunks) {
            const arr = byFile.get(c.path) || [];
            arr.push(c);
            byFile.set(c.path, arr);
        }
        const lines: string[] = [`## Semantic Fast Grep: "${QUERY}"\n`];
        let matchCount = 0;
        for (const [file, fileChunks] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            const relPath = path.relative(root, file).replace(/\\/g, "/");
            for (const chunk of fileChunks) {
                const symName = chunk.symbol_name || "anonymous";
                let scanPos = chunk.raw_code.indexOf(QUERY);
                if (scanPos === -1) continue;
                const reportedLines = new Set<number>();
                let currentLineOffset = 0;
                let currentLineStart = 0;
                let nextNl = chunk.raw_code.indexOf("\n");
                while (scanPos !== -1) {
                    while (nextNl !== -1 && nextNl < scanPos) {
                        currentLineOffset++;
                        currentLineStart = nextNl + 1;
                        nextNl = chunk.raw_code.indexOf("\n", currentLineStart);
                    }
                    const exactLine = chunk.start_line + currentLineOffset;
                    if (!reportedLines.has(exactLine)) {
                        reportedLines.add(exactLine);
                        matchCount++;
                        const lineEnd = nextNl !== -1 ? nextNl : chunk.raw_code.length;
                        const context = chunk.raw_code.substring(currentLineStart, lineEnd).trim();
                        lines.push(`${relPath} :: ${symName} (L${exactLine})`);
                        lines.push(`  ${context}`);
                    }
                    scanPos = chunk.raw_code.indexOf(QUERY, scanPos + QUERY.length);
                }
            }
        }
        lines.splice(1, 0, `Found ${matchCount} match(es) within ${chunks.length} AST symbol(s).\n`);
        void lines;
        const dt = performance.now() - t0;
        if (i >= WARMUP) phaseE.push(dt);
    }

    // Phase F: + lines.join("\n")
    const phaseF: number[] = [];
    for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        const byFile = new Map<string, ChunkRecord[]>();
        for (const c of chunks) {
            const arr = byFile.get(c.path) || [];
            arr.push(c);
            byFile.set(c.path, arr);
        }
        const lines: string[] = [`## Semantic Fast Grep: "${QUERY}"\n`];
        let matchCount = 0;
        for (const [file, fileChunks] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            const relPath = path.relative(root, file).replace(/\\/g, "/");
            for (const chunk of fileChunks) {
                const symName = chunk.symbol_name || "anonymous";
                let scanPos = chunk.raw_code.indexOf(QUERY);
                if (scanPos === -1) continue;
                const reportedLines = new Set<number>();
                let currentLineOffset = 0;
                let currentLineStart = 0;
                let nextNl = chunk.raw_code.indexOf("\n");
                while (scanPos !== -1) {
                    while (nextNl !== -1 && nextNl < scanPos) {
                        currentLineOffset++;
                        currentLineStart = nextNl + 1;
                        nextNl = chunk.raw_code.indexOf("\n", currentLineStart);
                    }
                    const exactLine = chunk.start_line + currentLineOffset;
                    if (!reportedLines.has(exactLine)) {
                        reportedLines.add(exactLine);
                        matchCount++;
                        const lineEnd = nextNl !== -1 ? nextNl : chunk.raw_code.length;
                        const context = chunk.raw_code.substring(currentLineStart, lineEnd).trim();
                        lines.push(`${relPath} :: ${symName} (L${exactLine})`);
                        lines.push(`  ${context}`);
                    }
                    scanPos = chunk.raw_code.indexOf(QUERY, scanPos + QUERY.length);
                }
            }
        }
        lines.splice(1, 0, `Found ${matchCount} match(es) within ${chunks.length} AST symbol(s).\n`);
        const out = lines.join("\n");
        void out;
        const dt = performance.now() - t0;
        if (i >= WARMUP) phaseF.push(dt);
    }

    // Phase G: full handler (includes Embedder.estimateTokens + logUsage)
    const phaseG: number[] = [];
    for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        await handleFastGrep({ action: "fast_grep", query: QUERY, limit: 1000 }, deps);
        const dt = performance.now() - t0;
        if (i >= WARMUP) phaseG.push(dt);
    }

    const mA = median(phaseA);
    const mB = median(phaseB);
    const mC = median(phaseC);
    const mD = median(phaseD);
    const mE = median(phaseE);
    const mF = median(phaseF);
    const mG = median(phaseG);

    console.log("");
    console.log("=== handleFastGrep phase breakdown (query=\"" + QUERY + "\", " + chunks.length + " chunks) ===");
    console.log("");
    console.log("Phase                                  Median   Delta");
    console.log("-----------------------------------------------------");
    console.log("A  engine.fastGrep (SQLite)           " + mA.toFixed(2).padStart(6) + "ms");
    console.log("B  + byFile Map                       " + mB.toFixed(2).padStart(6) + "ms   +" + (mB - mA).toFixed(2));
    console.log("C  + sort + pointer walk (no strings) " + mC.toFixed(2).padStart(6) + "ms   +" + (mC - mB).toFixed(2));
    console.log("D  + substring+trim per match         " + mD.toFixed(2).padStart(6) + "ms   +" + (mD - mC).toFixed(2));
    console.log("E  + template literal push per match  " + mE.toFixed(2).padStart(6) + "ms   +" + (mE - mD).toFixed(2));
    console.log("F  + lines.join                       " + mF.toFixed(2).padStart(6) + "ms   +" + (mF - mE).toFixed(2));
    console.log("G  handleFastGrep full (incl. tokens) " + mG.toFixed(2).padStart(6) + "ms   +" + (mG - mF).toFixed(2));

    engine.shutdown();
    try { fs.unlinkSync(path.join(ROOT, ".nreki-profile-phases.db")); } catch {}
    try { fs.unlinkSync(path.join(ROOT, ".nreki-profile-phases.vec")); } catch {}
}

main().catch(e => { console.error(e); process.exit(1); });
