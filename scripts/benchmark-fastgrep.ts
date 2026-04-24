/**
 * benchmark-fastgrep.ts - Latency comparison: nreki fast_grep vs bash grep -rF.
 *
 * 5 queries × 10 iterations each. Reports P50 and P99 per query.
 * Records match counts for sanity (both tools should find similar numbers,
 * though fast_grep scopes to AST chunks while grep scans raw files).
 *
 * Run: npx tsx scripts/benchmark-fastgrep.ts
 * Output: scripts/benchmark-fastgrep-<YYYYMMDD>.json + console table
 */

import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { NrekiEngine } from "../src/engine.js";

const ROOT = path.resolve(".");
const SRC = path.join(ROOT, "src");
const N_ITER = 10;
const WARMUP_DISCARD = 1;

const QUERIES = [
    { name: "common",   pattern: "export" },
    { name: "specific", pattern: "chronosMemory" },
    { name: "function", pattern: "findDefinition" },
    { name: "string",   pattern: "[OK]" },
    { name: "rare",     pattern: "TTRD_BOUNTY" },
];

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function stats(values: number[]) {
    if (values.length === 0) return { p50: 0, p99: 0, mean: 0, min: 0, max: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return {
        p50: Math.round(percentile(sorted, 50) * 100) / 100,
        p99: Math.round(percentile(sorted, 99) * 100) / 100,
        mean: Math.round(mean * 100) / 100,
        min: Math.round(sorted[0] * 100) / 100,
        max: Math.round(sorted[sorted.length - 1] * 100) / 100,
    };
}

async function main() {
    console.log("=== fast_grep vs bash grep -rF benchmark ===");
    console.log("Root:", ROOT, "| Source:", SRC);
    console.log("Iterations per query:", N_ITER, "(first", WARMUP_DISCARD, "discarded)");
    console.log("");

    // Setup engine + index src/
    const engine = new NrekiEngine({
        dbPath: path.join(ROOT, ".nreki-benchmark-fg.db"),
        watchPaths: [SRC],
    });
    await engine.initialize();

    console.log("Indexing src/ ...");
    const idxStart = performance.now();
    const walkAndIndex = async (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!["node_modules", "dist", ".git"].includes(entry.name)) await walkAndIndex(full);
            } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
                try { await engine.indexFile(full); } catch { /* skip */ }
            }
        }
    };
    await walkAndIndex(SRC);
    console.log("Indexed in", Math.round(performance.now() - idxStart), "ms\n");

    const results: Record<string, {
        pattern: string;
        fast: ReturnType<typeof stats> & { matches: number };
        grep: ReturnType<typeof stats> & { matches: number };
        speedup_p50: number;
    }> = {};

    for (const q of QUERIES) {
        console.log("--- Query: " + q.name + " | pattern: \"" + q.pattern + "\" ---");

        // fast_grep timings
        const fastTimes: number[] = [];
        let fastMatches = 0;
        for (let i = 0; i < N_ITER; i++) {
            const t0 = performance.now();
            const chunks = await engine.fastGrep(q.pattern, 1000);
            const dt = performance.now() - t0;
            if (i >= WARMUP_DISCARD) {
                fastTimes.push(dt);
                fastMatches = chunks.length;
            }
        }

        // grep -rF timings
        const grepTimes: number[] = [];
        let grepMatches = 0;
        for (let i = 0; i < N_ITER; i++) {
            const t0 = performance.now();
            const res = spawnSync(
                "grep",
                ["-rF", "--include=*.ts", "--include=*.tsx", "--include=*.js", "--include=*.jsx", "--include=*.mjs", q.pattern, SRC],
                { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
            );
            const dt = performance.now() - t0;
            if (i >= WARMUP_DISCARD) {
                grepTimes.push(dt);
                // grep exit 0 = matches, 1 = no match, 2 = error
                if (res.status === 0 && res.stdout) {
                    grepMatches = res.stdout.split("\n").filter(l => l.length > 0).length;
                } else {
                    grepMatches = 0;
                }
            }
        }

        const fs_ = stats(fastTimes);
        const gs = stats(grepTimes);
        const speedup = gs.p50 > 0 && fs_.p50 > 0 ? Math.round((gs.p50 / fs_.p50) * 100) / 100 : 0;

        console.log("  fast_grep: P50=" + fs_.p50 + "ms  P99=" + fs_.p99 + "ms  matches=" + fastMatches);
        console.log("  grep -rF : P50=" + gs.p50 + "ms  P99=" + gs.p99 + "ms  matches=" + grepMatches);
        console.log("  Speedup (grep/fast_grep P50): " + speedup + "x\n");

        results[q.name] = {
            pattern: q.pattern,
            fast: { ...fs_, matches: fastMatches },
            grep: { ...gs, matches: grepMatches },
            speedup_p50: speedup,
        };
    }

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const outFile = "scripts/benchmark-fastgrep-" + date + ".json";
    fs.writeFileSync(outFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        root: ROOT,
        iterations: N_ITER,
        warmup_discarded: WARMUP_DISCARD,
        results,
    }, null, 2));
    console.log("Saved " + outFile);

    engine.shutdown();
    try { fs.unlinkSync(path.join(ROOT, ".nreki-benchmark-fg.db")); } catch {}
    try { fs.unlinkSync(path.join(ROOT, ".nreki-benchmark-fg.vec")); } catch {}
}

main().catch(e => { console.error(e); process.exit(1); });
