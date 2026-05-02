/**
 * benchmark-fastgrep-vs-rg.ts - Latency comparison: nreki fast_grep vs ripgrep.
 *
 * Mirrors scripts/benchmark-fastgrep.ts methodology (5 queries x 10 iterations,
 * P50/P99, first iteration discarded as warmup) but the baseline is ripgrep
 * (BurntSushi/ripgrep) which has parallelism, mmap, and a SIMD-optimized regex
 * engine - a much harder baseline than `grep -rF`.
 *
 * ripgrep flags chosen for fairness:
 *   -F            literal pattern (matches fast_grep semantics)
 *   --type-add 'src:*.{ts,tsx,js,jsx,mjs}' --type src
 *                 same file extensions fast_grep indexes
 *   --no-config   ignore user/global ripgrep config
 *   --no-ignore-vcs / --no-ignore-dot
 *                 do not honor .gitignore (fast_grep also ignores nothing
 *                 except node_modules/dist/.git which we exclude explicitly
 *                 below to match ripgrep's view of the tree)
 *   -g '!node_modules' -g '!dist' -g '!.git'
 *                 mirror the indexing walker's exclusions
 *   -c            count matching LINES (fastest output mode; we still pay the
 *                 full scan cost). We do not pipe lines, only the count.
 *
 * Run: npx tsx scripts/benchmark-fastgrep-vs-rg.ts
 *      RG_PATH=/path/to/rg.exe npx tsx scripts/benchmark-fastgrep-vs-rg.ts
 *
 * Output: scripts/benchmark-fastgrep-vs-rg-<YYYYMMDD>.json + console table
 */

import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { NrekiEngine } from "../src/engine.js";

const ROOT = path.resolve(".");
const SRC = path.join(ROOT, "src");
const N_ITER = 10;
const WARMUP_DISCARD = 1;

const RG_PATH = process.env.RG_PATH
    || (process.platform === "win32"
        ? "/tmp/rg-bench/node_modules/@vscode/ripgrep/bin/rg.exe"
        : "rg");

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

function rgMatchCount(stdout: string): number {
    // -c outputs "<file>:<count>" per file. Sum the counts.
    if (!stdout) return 0;
    let total = 0;
    for (const line of stdout.split(/\r?\n/)) {
        const idx = line.lastIndexOf(":");
        if (idx < 0) continue;
        const n = parseInt(line.slice(idx + 1), 10);
        if (!isNaN(n)) total += n;
    }
    return total;
}

async function main() {
    // Sanity check rg before spinning up the engine.
    const rgVer = spawnSync(RG_PATH, ["--version"], { encoding: "utf8" });
    if (rgVer.status !== 0) {
        console.error("ripgrep not runnable at:", RG_PATH);
        console.error("Set RG_PATH env var, or install via: npm i -g @vscode/ripgrep");
        process.exit(1);
    }
    const rgVersionLine = (rgVer.stdout || "").split(/\r?\n/)[0];

    console.log("=== fast_grep vs ripgrep benchmark ===");
    console.log("ripgrep  :", rgVersionLine, "(" + RG_PATH + ")");
    console.log("Root     :", ROOT, "| Source:", SRC);
    console.log("Iterations per query:", N_ITER, "(first", WARMUP_DISCARD, "discarded)");
    console.log("");

    const engine = new NrekiEngine({
        dbPath: path.join(ROOT, ".nreki-benchmark-fg-rg.db"),
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
    const idxMs = Math.round(performance.now() - idxStart);
    console.log("Indexed in", idxMs, "ms\n");

    const RG_BASE_ARGS = [
        "--no-config",
        "--no-ignore-vcs",
        "--no-ignore-dot",
        "--type-add", "src:*.ts",
        "--type-add", "src:*.tsx",
        "--type-add", "src:*.js",
        "--type-add", "src:*.jsx",
        "--type-add", "src:*.mjs",
        "--type", "src",
        "-g", "!node_modules",
        "-g", "!dist",
        "-g", "!.git",
        "-g", "!*.d.ts",
        "-F",
        "-c",
    ];

    const results: Record<string, {
        pattern: string;
        fast: ReturnType<typeof stats> & { matches: number };
        rg: ReturnType<typeof stats> & { matches: number };
        speedup_p50: number;
    }> = {};

    for (const q of QUERIES) {
        console.log("--- Query: " + q.name + " | pattern: \"" + q.pattern + "\" ---");

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

        const rgTimes: number[] = [];
        let rgMatches = 0;
        for (let i = 0; i < N_ITER; i++) {
            const t0 = performance.now();
            const res = spawnSync(
                RG_PATH,
                [...RG_BASE_ARGS, q.pattern, SRC],
                { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
            );
            const dt = performance.now() - t0;
            if (i >= WARMUP_DISCARD) {
                rgTimes.push(dt);
                rgMatches = res.status === 0 ? rgMatchCount(res.stdout || "") : 0;
            }
        }

        const fs_ = stats(fastTimes);
        const rs = stats(rgTimes);
        const speedup = rs.p50 > 0 && fs_.p50 > 0 ? Math.round((rs.p50 / fs_.p50) * 100) / 100 : 0;

        console.log("  fast_grep: P50=" + fs_.p50 + "ms  P99=" + fs_.p99 + "ms  matches=" + fastMatches);
        console.log("  ripgrep  : P50=" + rs.p50 + "ms  P99=" + rs.p99 + "ms  matches=" + rgMatches);
        console.log("  Speedup (rg/fast_grep P50): " + speedup + "x\n");

        results[q.name] = {
            pattern: q.pattern,
            fast: { ...fs_, matches: fastMatches },
            rg: { ...rs, matches: rgMatches },
            speedup_p50: speedup,
        };
    }

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const outFile = "scripts/benchmark-fastgrep-vs-rg-" + date + ".json";
    fs.writeFileSync(outFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        baseline: "ripgrep",
        baseline_version: rgVersionLine,
        baseline_path: RG_PATH,
        root: ROOT,
        iterations: N_ITER,
        warmup_discarded: WARMUP_DISCARD,
        index_ms: idxMs,
        results,
    }, null, 2));
    console.log("Saved " + outFile);

    engine.shutdown();
    try { fs.unlinkSync(path.join(ROOT, ".nreki-benchmark-fg-rg.db")); } catch {}
    try { fs.unlinkSync(path.join(ROOT, ".nreki-benchmark-fg-rg.vec")); } catch {}
}

main().catch(e => { console.error(e); process.exit(1); });
