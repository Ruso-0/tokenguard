/**
 * benchmark-v10-15-0.ts - Latency comparison: fast path (SQLite) vs slow path (disk walk).
 *
 * Measures findDefinition and findReferences on the NREKI codebase itself.
 * Runs each symbol N_ITER times, discards warm-up, reports median + p50 + p95.
 *
 * Run: npx tsx scripts/benchmark-v10-15-0.ts
 * Output: console + scripts/benchmark-v10-15-0.json
 *
 * NOT a recurring test. One-shot measurement for the v10.15.0 release.
 */

import path from "path";
import fs from "fs";
import { NrekiEngine } from "../src/engine.js";
import { ASTParser } from "../src/parser.js";
import { findDefinition, findReferences } from "../src/ast-navigator.js";

const ROOT = path.resolve(".");
const N_ITER = 20;        // iterations per symbol
const WARMUP_DISCARD = 1; // discard first iteration (file cache cold)

const DEFINITION_SYMBOLS = ["NrekiEngine", "Compressor", "ASTParser", "findDefinition", "handleSearch"];
const REFERENCE_SYMBOLS = ["NrekiDB", "logger", "readSource"];

interface Timing {
    symbol: string;
    slow_ms: number[];
    fast_ms: number[];
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function stats(values: number[]): { mean: number; p50: number; p95: number; min: number; max: number } {
    if (values.length === 0) return { mean: 0, p50: 0, p95: 0, min: 0, max: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return {
        mean: Math.round(mean * 100) / 100,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        min: sorted[0],
        max: sorted[sorted.length - 1],
    };
}

async function measureDef(symbol: string, engine: NrekiEngine, parser: ASTParser): Promise<Timing> {
    const slow: number[] = [];
    const fast: number[] = [];

    // Slow path: N_ITER runs
    for (let i = 0; i < N_ITER; i++) {
        const t0 = performance.now();
        await findDefinition(ROOT, parser, symbol);
        const dt = performance.now() - t0;
        if (i >= WARMUP_DISCARD) slow.push(dt);
    }

    // Fast path: N_ITER runs
    for (let i = 0; i < N_ITER; i++) {
        const t0 = performance.now();
        await findDefinition(ROOT, parser, symbol, "any", engine);
        const dt = performance.now() - t0;
        if (i >= WARMUP_DISCARD) fast.push(dt);
    }

    return { symbol, slow_ms: slow, fast_ms: fast };
}

async function measureRefs(symbol: string, engine: NrekiEngine, parser: ASTParser): Promise<Timing> {
    const slow: number[] = [];
    const fast: number[] = [];

    for (let i = 0; i < N_ITER; i++) {
        const t0 = performance.now();
        await findReferences(ROOT, parser, symbol);
        const dt = performance.now() - t0;
        if (i >= WARMUP_DISCARD) slow.push(dt);
    }

    for (let i = 0; i < N_ITER; i++) {
        const t0 = performance.now();
        await findReferences(ROOT, parser, symbol, engine);
        const dt = performance.now() - t0;
        if (i >= WARMUP_DISCARD) fast.push(dt);
    }

    return { symbol, slow_ms: slow, fast_ms: fast };
}

async function main() {
    console.log("=== v10.15.0 Benchmark: fast path vs slow path ===");
    console.log("Root:", ROOT);
    console.log("Iterations per symbol:", N_ITER, "(first", WARMUP_DISCARD, "discarded)");
    console.log("");

    // Engine setup with full index
    const engine = new NrekiEngine({
        dbPath: path.join(ROOT, ".nreki-benchmark.db"),
        watchPaths: [path.join(ROOT, "src")],
    });
    await engine.initialize();

    // Index the src/ directory so SQLite chunks are populated
    console.log("Indexing src/ ...");
    const indexStart = performance.now();
    const srcDir = path.join(ROOT, "src");
    const walkAndIndex = async (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!["node_modules", "dist", ".git"].includes(entry.name)) await walkAndIndex(full);
            } else if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
                try { await engine.indexFile(full); } catch { /* skip */ }
            }
        }
    };
    await walkAndIndex(srcDir);
    console.log("Indexing done in", Math.round(performance.now() - indexStart), "ms");
    console.log("");

    const parser = new ASTParser();
    await parser.initialize();

    // ─── Definition benchmark ───────────────────────────────────
    console.log("--- findDefinition ---");
    const defResults: Timing[] = [];
    for (const sym of DEFINITION_SYMBOLS) {
        process.stdout.write("  " + sym + " ... ");
        const t = await measureDef(sym, engine, parser);
        defResults.push(t);
        const s = stats(t.slow_ms);
        const f = stats(t.fast_ms);
        const speedup = s.mean > 0 ? (s.mean / Math.max(f.mean, 0.001)).toFixed(2) + "x" : "n/a";
        console.log("slow mean=" + s.mean + "ms p95=" + s.p95 + "ms | fast mean=" + f.mean + "ms p95=" + f.p95 + "ms | speedup=" + speedup);
    }

    // ─── References benchmark ───────────────────────────────────
    console.log("");
    console.log("--- findReferences ---");
    const refResults: Timing[] = [];
    for (const sym of REFERENCE_SYMBOLS) {
        process.stdout.write("  " + sym + " ... ");
        const t = await measureRefs(sym, engine, parser);
        refResults.push(t);
        const s = stats(t.slow_ms);
        const f = stats(t.fast_ms);
        const speedup = s.mean > 0 ? (s.mean / Math.max(f.mean, 0.001)).toFixed(2) + "x" : "n/a";
        console.log("slow mean=" + s.mean + "ms p95=" + s.p95 + "ms | fast mean=" + f.mean + "ms p95=" + f.p95 + "ms | speedup=" + speedup);
    }

    // ─── Save JSON ──────────────────────────────────────────────
    const output = {
        timestamp: new Date().toISOString(),
        root: ROOT,
        iterations: N_ITER,
        warmup_discarded: WARMUP_DISCARD,
        findDefinition: defResults.map(t => ({
            symbol: t.symbol,
            slow: stats(t.slow_ms),
            fast: stats(t.fast_ms),
            speedup_mean: t.slow_ms.length > 0 && t.fast_ms.length > 0
                ? Math.round((stats(t.slow_ms).mean / Math.max(stats(t.fast_ms).mean, 0.001)) * 100) / 100
                : 0,
        })),
        findReferences: refResults.map(t => ({
            symbol: t.symbol,
            slow: stats(t.slow_ms),
            fast: stats(t.fast_ms),
            speedup_mean: t.slow_ms.length > 0 && t.fast_ms.length > 0
                ? Math.round((stats(t.slow_ms).mean / Math.max(stats(t.fast_ms).mean, 0.001)) * 100) / 100
                : 0,
        })),
    };
    fs.writeFileSync("scripts/benchmark-v10-15-0.json", JSON.stringify(output, null, 2));
    console.log("");
    console.log("Saved scripts/benchmark-v10-15-0.json");

    // Cleanup benchmark DB
    engine.shutdown();
    try { fs.unlinkSync(path.join(ROOT, ".nreki-benchmark.db")); } catch {}
    try { fs.unlinkSync(path.join(ROOT, ".nreki-benchmark.vec")); } catch {}
}

main().catch(err => {
    console.error("Benchmark failed:", err);
    process.exit(1);
});
