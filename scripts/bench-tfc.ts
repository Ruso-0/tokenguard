/**
 * bench-tfc.ts — TFC-Pro Benchmark (v8.5)
 *
 * Dogfooding benchmark: runs TFC-Pro against NREKI itself.
 *
 * Targets: top-N largest TypeScript files in src/
 * Focus selection: auto-extracted top-3 largest symbols per file via AST parser
 * Metrics:
 *   - Raw tokens
 *   - TFC-Pro compressed tokens
 *   - Legacy advanced (aggressive) compressed tokens
 *   - Legacy tier-3 compressed tokens
 *   - Ratios + TFC advantage
 *   - Cache hit latency (1st parse vs 2nd parse with different focus)
 *   - Fovea fidelity (exact substring of focused symbol in output)
 *   - Fallback rate (% focus that return null)
 *
 * Usage: npx tsx scripts/bench-tfc.ts
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { NrekiEngine } from "../src/engine.js";
import { Embedder } from "../src/embedder.js";
import { tfcCompress, type TfcResult } from "../src/compressor-foveal.js";
import type { ParsedChunk } from "../src/parser.js";

// ─── Config ─────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "src");
const TOP_N_FILES = 5;
const TOP_N_FOCI = 3;
const MIN_FILE_BYTES = 5_000; // ignore tiny files
const OUTPUT_JSON = path.join(ROOT, "bench-results-tfc.json");
const OUTPUT_MD = path.join(ROOT, "BENCH-TFC.md");

interface FileBench {
    file: string;
    rawBytes: number;
    rawTokens: number;
    focusResults: FocusBench[];
    boundaryResults: BoundaryCase[];
    legacyAdvancedTokens: number;
    legacyAdvancedRatio: number;
    legacyTier3Tokens: number;
    legacyTier3Ratio: number;
    parseTime1stMs: number;
    parseTime2ndMs: number; // 2nd call with different focus → cache hit
    cacheSpeedup: number;   // 1st / 2nd
}

interface BoundaryCase {
    focus: string;
    focusLines: number;
    focusSize: number;
    tfcRatio: number;
    compressionFactor: number; // originalSize / compressedSize
    tokensSaved: number;
    fellBack: boolean;
}

interface FocusBench {
    focus: string;
    focusSize: number; // chars of target symbol's rawCode
    tfcTokens: number;
    tfcRatio: number;
    tfcAdvantageOverAggressive: number; // tfcRatio - legacyAdvancedRatio
    tfcAdvantageOverTier3: number;
    foveaFidelity: boolean; // exact match of symbol body in output
    zones: TfcResult["zones"];
    fellBack: boolean; // true if tfcCompress returned non-success payload
}

interface BenchSummary {
    totalFiles: number;
    totalFoci: number;
    successfulFoci: number;
    fallbackRate: number;
    foveaFidelityRate: number;
    avgTfcRatio: number;
    avgLegacyAggressiveRatio: number;
    avgLegacyTier3Ratio: number;
    avgTfcAdvantageOverAggressive: number;
    avgTfcAdvantageOverTier3: number;
    avgCacheSpeedup: number;
    p50TfcRatio: number;
    p95TfcRatio: number;
    minTfcRatio: number;
    maxTfcRatio: number;
    // Boundary ceiling
    maxBoundaryRatio: number;          // best case compression ratio
    maxBoundaryFactor: number;         // best case compression factor (raw/compressed)
    maxBoundaryFocus: string;          // focus symbol that achieved it
    maxBoundaryFile: string;           // file that achieved it
}

// ─── Helpers ────────────────────────────────────────────────────────

function walkTsFiles(dir: string, out: string[] = []): string[] {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return out; }
    for (const e of entries) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
            walkTsFiles(fp, out);
        } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
            out.push(fp);
        }
    }
    return out;
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
    console.log("NREKI TFC-Pro Benchmark (v8.5)");
    console.log("━".repeat(70));
    console.log();

    // Initialize engine (no embeddings — we only need parser + DB for signatures)
    const engine = new NrekiEngine({
        dbPath: path.join(ROOT, ".nreki-bench-tfc.db"),
        watchPaths: [ROOT],
        enableEmbeddings: false,
    });
    await engine.initialize();
    await engine.indexDirectory(SRC_DIR);

    // Discover target files: top N largest .ts files in src/
    const allFiles = walkTsFiles(SRC_DIR)
        .map(f => ({ file: f, size: fs.statSync(f).size }))
        .filter(x => x.size >= MIN_FILE_BYTES)
        .sort((a, b) => b.size - a.size)
        .slice(0, TOP_N_FILES);

    console.log(`Discovered ${allFiles.length} target files:`);
    for (const f of allFiles) {
        console.log(`  ${path.relative(ROOT, f.file)} (${(f.size / 1024).toFixed(1)} KB)`);
    }
    console.log();

    const parser = engine.getParser();
    const results: FileBench[] = [];

    for (const { file, size } of allFiles) {
        const relPath = path.relative(ROOT, file);
        console.log(`Benchmarking: ${relPath}`);

        const content = fs.readFileSync(file, "utf-8");
        const rawTokens = Embedder.estimateTokens(content);

        // Parse file to extract top N symbols by raw code size
        const parseResult = await parser.parse(file, content);
        const topSymbols: ParsedChunk[] = [...parseResult.chunks]
            .filter(c => c.symbolName.length > 0)
            .sort((a, b) => b.rawCode.length - a.rawCode.length)
            .slice(0, TOP_N_FOCI);

        if (topSymbols.length === 0) {
            console.log(`  → skipped (no symbols found)`);
            continue;
        }

        // Legacy compressors (same for all foci of this file)
        const legacyAdvanced = await engine.compressFileAdvanced(file, "aggressive", content);
        const legacyAdvancedTokens = Embedder.estimateTokens(legacyAdvanced.compressed);
        const legacyAdvancedRatio = 1 - legacyAdvancedTokens / rawTokens;

        const legacyTier3 = await engine.compressFile(file, 3);
        const legacyTier3Tokens = Embedder.estimateTokens(legacyTier3.compressed);
        const legacyTier3Ratio = 1 - legacyTier3Tokens / rawTokens;

        // TFC-Pro per focus (use parse time diff to measure cache)
        const focusResults: FocusBench[] = [];
        let parseTime1stMs = 0;
        let parseTime2ndMs = 0;

        for (let i = 0; i < topSymbols.length; i++) {
            const sym = topSymbols[i];
            const focus = sym.symbolName;

            const t0 = performance.now();
            const tfcPayload = await tfcCompress(file, content, focus, engine);
            const elapsed = performance.now() - t0;

            if (i === 0) parseTime1stMs = elapsed;
            if (i === 1) parseTime2ndMs = elapsed;

            if (tfcPayload.kind !== "success") {
                focusResults.push({
                    focus,
                    focusSize: sym.rawCode.length,
                    tfcTokens: rawTokens, // worst case: no compression
                    tfcRatio: 0,
                    tfcAdvantageOverAggressive: -legacyAdvancedRatio,
                    tfcAdvantageOverTier3: -legacyTier3Ratio,
                    foveaFidelity: false,
                    zones: { foveas: [], localParafovea: 0, externalParafovea: 0, upstream: 0, darkMatterLines: 0 },
                    fellBack: true,
                });
                continue;
            }

            const tfcResult = tfcPayload.data;

            const tfcTokens = Embedder.estimateTokens(tfcResult.compressed);
            const tfcRatio = tfcResult.ratio;

            // Fovea fidelity: does the output contain the symbol's rawCode verbatim?
            const foveaFidelity = tfcResult.compressed.includes(sym.rawCode);

            focusResults.push({
                focus,
                focusSize: sym.rawCode.length,
                tfcTokens,
                tfcRatio,
                tfcAdvantageOverAggressive: tfcRatio - legacyAdvancedRatio,
                tfcAdvantageOverTier3: tfcRatio - legacyTier3Ratio,
                foveaFidelity,
                zones: tfcResult.zones,
                fellBack: false,
            });
        }

        const cacheSpeedup = parseTime2ndMs > 0 ? parseTime1stMs / parseTime2ndMs : 1;

        // ─── BOUNDARY CASES: THEORETICAL CEILING ───
        // Measure TFC compression when the focus is one of the smallest symbols
        // in the file. This documents the empirical best-case ceiling (limit
        // described by Amdahl's law applied to context compression).
        const smallestSymbols: ParsedChunk[] = [...parseResult.chunks]
            .filter(c => c.symbolName.length > 0 && c.rawCode.length > 0)
            .filter(c => !topSymbols.includes(c)) // avoid re-testing the largest ones
            .sort((a, b) => a.rawCode.length - b.rawCode.length)
            .slice(0, 3);

        const boundaryResults: BoundaryCase[] = [];
        for (const target of smallestSymbols) {
            const boundaryPayload = await tfcCompress(file, content, target.symbolName, engine);
            const focusLines = target.endLine - target.startLine + 1;
            if (boundaryPayload.kind !== "success") {
                boundaryResults.push({
                    focus: target.symbolName,
                    focusLines,
                    focusSize: target.rawCode.length,
                    tfcRatio: 0,
                    compressionFactor: 1,
                    tokensSaved: 0,
                    fellBack: true,
                });
                continue;
            }
            const boundaryResult = boundaryPayload.data;
            boundaryResults.push({
                focus: target.symbolName,
                focusLines,
                focusSize: target.rawCode.length,
                tfcRatio: boundaryResult.ratio,
                compressionFactor: boundaryResult.originalSize / Math.max(1, boundaryResult.compressedSize),
                tokensSaved: boundaryResult.tokensSaved,
                fellBack: false,
            });
        }

        results.push({
            file: relPath,
            rawBytes: size,
            rawTokens,
            focusResults,
            boundaryResults,
            legacyAdvancedTokens,
            legacyAdvancedRatio,
            legacyTier3Tokens,
            legacyTier3Ratio,
            parseTime1stMs,
            parseTime2ndMs,
            cacheSpeedup,
        });

        console.log(`  raw=${rawTokens}t | legacy-aggr=${legacyAdvancedTokens}t (${(legacyAdvancedRatio * 100).toFixed(1)}%) | tier3=${legacyTier3Tokens}t (${(legacyTier3Ratio * 100).toFixed(1)}%)`);
        for (const fr of focusResults) {
            const marker = fr.fellBack ? "✗" : fr.foveaFidelity ? "✓" : "⚠";
            console.log(`  ${marker} focus="${fr.focus}" → ${fr.tfcTokens}t (${(fr.tfcRatio * 100).toFixed(1)}%) Δ=${(fr.tfcAdvantageOverAggressive * 100).toFixed(1)}pp`);
        }
        if (boundaryResults.length > 0) {
            console.log(`  boundary (smallest symbols):`);
            for (const br of boundaryResults) {
                const marker = br.fellBack ? "✗" : "🎯";
                console.log(`    ${marker} ${br.focus} (${br.focusLines}L) → ${(br.tfcRatio * 100).toFixed(1)}% / ${br.compressionFactor.toFixed(0)}x`);
            }
        }
        console.log(`  cache: 1st=${parseTime1stMs.toFixed(1)}ms 2nd=${parseTime2ndMs.toFixed(1)}ms speedup=${cacheSpeedup.toFixed(1)}x`);
        console.log();
    }

    // ─── Summary ────────────────────────────────────────────────────
    const allFoci = results.flatMap(r => r.focusResults);
    const successful = allFoci.filter(f => !f.fellBack);
    const withFovea = successful.filter(f => f.foveaFidelity);
    const tfcRatiosSorted = [...successful.map(f => f.tfcRatio)].sort((a, b) => a - b);

    // Boundary ceiling: best boundary case across all files
    let maxBoundaryRatio = 0;
    let maxBoundaryFactor = 1;
    let maxBoundaryFocus = "";
    let maxBoundaryFile = "";
    for (const r of results) {
        for (const br of r.boundaryResults) {
            if (!br.fellBack && br.tfcRatio > maxBoundaryRatio) {
                maxBoundaryRatio = br.tfcRatio;
                maxBoundaryFactor = br.compressionFactor;
                maxBoundaryFocus = br.focus;
                maxBoundaryFile = r.file;
            }
        }
    }

    const summary: BenchSummary = {
        totalFiles: results.length,
        totalFoci: allFoci.length,
        successfulFoci: successful.length,
        fallbackRate: allFoci.length > 0 ? 1 - successful.length / allFoci.length : 0,
        foveaFidelityRate: successful.length > 0 ? withFovea.length / successful.length : 0,
        avgTfcRatio: successful.length > 0 ? successful.reduce((a, f) => a + f.tfcRatio, 0) / successful.length : 0,
        avgLegacyAggressiveRatio: results.length > 0 ? results.reduce((a, r) => a + r.legacyAdvancedRatio, 0) / results.length : 0,
        avgLegacyTier3Ratio: results.length > 0 ? results.reduce((a, r) => a + r.legacyTier3Ratio, 0) / results.length : 0,
        avgTfcAdvantageOverAggressive: successful.length > 0 ? successful.reduce((a, f) => a + f.tfcAdvantageOverAggressive, 0) / successful.length : 0,
        avgTfcAdvantageOverTier3: successful.length > 0 ? successful.reduce((a, f) => a + f.tfcAdvantageOverTier3, 0) / successful.length : 0,
        avgCacheSpeedup: results.length > 0 ? results.reduce((a, r) => a + r.cacheSpeedup, 0) / results.length : 0,
        p50TfcRatio: percentile(tfcRatiosSorted, 50),
        p95TfcRatio: percentile(tfcRatiosSorted, 95),
        minTfcRatio: tfcRatiosSorted[0] ?? 0,
        maxTfcRatio: tfcRatiosSorted[tfcRatiosSorted.length - 1] ?? 0,
        maxBoundaryRatio,
        maxBoundaryFactor,
        maxBoundaryFocus,
        maxBoundaryFile,
    };

    console.log("━".repeat(70));
    console.log("SUMMARY");
    console.log("━".repeat(70));
    console.log(`Files benchmarked:          ${summary.totalFiles}`);
    console.log(`Total focus probes:         ${summary.totalFoci}`);
    console.log(`Successful (found symbol):  ${summary.successfulFoci}`);
    console.log(`Fallback rate:              ${(summary.fallbackRate * 100).toFixed(1)}%`);
    console.log(`Fovea fidelity rate:        ${(summary.foveaFidelityRate * 100).toFixed(1)}%`);
    console.log();
    console.log(`TFC-Pro avg compression:    ${(summary.avgTfcRatio * 100).toFixed(1)}%`);
    console.log(`Legacy aggressive avg:      ${(summary.avgLegacyAggressiveRatio * 100).toFixed(1)}%`);
    console.log(`Legacy tier-3 avg:          ${(summary.avgLegacyTier3Ratio * 100).toFixed(1)}%`);
    console.log();
    console.log(`TFC advantage over aggr:    ${(summary.avgTfcAdvantageOverAggressive * 100).toFixed(1)}pp`);
    console.log(`TFC advantage over tier-3:  ${(summary.avgTfcAdvantageOverTier3 * 100).toFixed(1)}pp`);
    console.log();
    console.log(`TFC ratio p50 / p95:        ${(summary.p50TfcRatio * 100).toFixed(1)}% / ${(summary.p95TfcRatio * 100).toFixed(1)}%`);
    console.log(`TFC ratio min / max:        ${(summary.minTfcRatio * 100).toFixed(1)}% / ${(summary.maxTfcRatio * 100).toFixed(1)}%`);
    console.log(`Cache speedup (avg):        ${summary.avgCacheSpeedup.toFixed(1)}x`);
    console.log();
    console.log(`Best case boundary:         ${(summary.maxBoundaryRatio * 100).toFixed(1)}% (${summary.maxBoundaryFactor.toFixed(0)}x)`);
    console.log(`  on focus="${summary.maxBoundaryFocus}" in ${summary.maxBoundaryFile}`);

    // ─── Output files ───────────────────────────────────────────────
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify({ summary, results }, null, 2));
    fs.writeFileSync(OUTPUT_MD, generateMarkdown(summary, results));
    console.log();
    console.log(`Wrote: ${path.relative(ROOT, OUTPUT_JSON)}`);
    console.log(`Wrote: ${path.relative(ROOT, OUTPUT_MD)}`);

    engine.shutdown();
    try { fs.unlinkSync(path.join(ROOT, ".nreki-bench-tfc.db")); } catch {}
}

function generateMarkdown(summary: BenchSummary, results: FileBench[]): string {
    const lines: string[] = [];
    lines.push("# NREKI TFC-Pro Benchmark (v8.5)\n");
    lines.push("Dogfooding benchmark against the NREKI codebase itself.\n");
    lines.push("## Summary\n");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Files benchmarked | ${summary.totalFiles} |`);
    lines.push(`| Total focus probes | ${summary.totalFoci} |`);
    lines.push(`| Successful (found symbol) | ${summary.successfulFoci} |`);
    lines.push(`| Fallback rate | ${(summary.fallbackRate * 100).toFixed(1)}% |`);
    lines.push(`| Fovea fidelity rate | ${(summary.foveaFidelityRate * 100).toFixed(1)}% |`);
    lines.push(`| **TFC-Pro avg compression** | **${(summary.avgTfcRatio * 100).toFixed(1)}%** |`);
    lines.push(`| Legacy aggressive avg | ${(summary.avgLegacyAggressiveRatio * 100).toFixed(1)}% |`);
    lines.push(`| Legacy tier-3 avg | ${(summary.avgLegacyTier3Ratio * 100).toFixed(1)}% |`);
    lines.push(`| **TFC advantage (vs aggressive)** | **${(summary.avgTfcAdvantageOverAggressive * 100).toFixed(1)}pp** |`);
    lines.push(`| **TFC advantage (vs tier-3)** | **${(summary.avgTfcAdvantageOverTier3 * 100).toFixed(1)}pp** |`);
    lines.push(`| TFC p50 / p95 | ${(summary.p50TfcRatio * 100).toFixed(1)}% / ${(summary.p95TfcRatio * 100).toFixed(1)}% |`);
    lines.push(`| TFC min / max | ${(summary.minTfcRatio * 100).toFixed(1)}% / ${(summary.maxTfcRatio * 100).toFixed(1)}% |`);
    lines.push(`| Cache speedup (avg) | ${summary.avgCacheSpeedup.toFixed(1)}x |`);
    lines.push(`| **Best case boundary** | **${(summary.maxBoundaryRatio * 100).toFixed(1)}% (${summary.maxBoundaryFactor.toFixed(0)}x)** |`);
    lines.push("");

    lines.push("## Per-file results\n");
    lines.push("| File | Raw | Legacy aggr | Legacy t3 | Foci | Avg TFC | Avg Δ aggr |");
    lines.push("|------|-----|-------------|-----------|------|---------|-----------|");
    for (const r of results) {
        const goodFoci = r.focusResults.filter(f => !f.fellBack);
        const avgTfc = goodFoci.length > 0 ? goodFoci.reduce((a, f) => a + f.tfcRatio, 0) / goodFoci.length : 0;
        const avgDelta = goodFoci.length > 0 ? goodFoci.reduce((a, f) => a + f.tfcAdvantageOverAggressive, 0) / goodFoci.length : 0;
        lines.push(`| \`${r.file}\` | ${r.rawTokens}t | ${(r.legacyAdvancedRatio * 100).toFixed(1)}% | ${(r.legacyTier3Ratio * 100).toFixed(1)}% | ${goodFoci.length}/${r.focusResults.length} | ${(avgTfc * 100).toFixed(1)}% | ${(avgDelta * 100).toFixed(1)}pp |`);
    }
    lines.push("");

    lines.push("## Boundary Analysis — Theoretical Ceiling\n");
    lines.push("TFC compression ratio follows an Amdahl-style law:\n");
    lines.push("```");
    lines.push("Ratio ≈ 1 − (Preamble + Fovea + Markov_Mantle_O(1)) / TotalFileSize");
    lines.push("```\n");
    lines.push("The **smaller the focus** relative to the file, the closer compression approaches 100%. ");
    lines.push("The boundary probes the smallest symbols in each file to document the empirical ceiling.\n");
    lines.push(`**Best case observed**: **${(summary.maxBoundaryRatio * 100).toFixed(1)}% compression** (**${summary.maxBoundaryFactor.toFixed(0)}x**) `);
    lines.push(`on focus \`${summary.maxBoundaryFocus}\` in \`${summary.maxBoundaryFile}\`.\n`);
    lines.push("| File | Focus | Focus lines | TFC ratio | Compression |");
    lines.push("|------|-------|-------------|-----------|-------------|");
    for (const r of results) {
        for (const br of r.boundaryResults) {
            const marker = br.fellBack ? "✗ fallback" : "🎯";
            const compression = br.fellBack ? "—" : `${br.compressionFactor.toFixed(0)}x`;
            lines.push(`| \`${r.file}\` | \`${br.focus}\` | ${br.focusLines}L | ${(br.tfcRatio * 100).toFixed(1)}% | ${compression} ${marker} |`);
        }
    }
    lines.push("");

    lines.push("## Per-focus detail\n");
    for (const r of results) {
        lines.push(`### \`${r.file}\` (raw ${r.rawTokens} tokens)\n`);
        lines.push("| Focus | Size | TFC tokens | TFC ratio | Δ vs aggressive | Fidelity |");
        lines.push("|-------|------|------------|-----------|-----------------|----------|");
        for (const fr of r.focusResults) {
            const fid = fr.fellBack ? "✗ fallback" : fr.foveaFidelity ? "✓" : "⚠ partial";
            lines.push(`| \`${fr.focus}\` | ${fr.focusSize}c | ${fr.tfcTokens}t | ${(fr.tfcRatio * 100).toFixed(1)}% | ${(fr.tfcAdvantageOverAggressive * 100).toFixed(1)}pp | ${fid} |`);
        }
        lines.push("");
        lines.push(`Cache: 1st parse ${r.parseTime1stMs.toFixed(1)}ms → 2nd ${r.parseTime2ndMs.toFixed(1)}ms (${r.cacheSpeedup.toFixed(1)}x speedup)\n`);
    }

    return lines.join("\n");
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
