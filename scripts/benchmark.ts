/**
 * benchmark.ts — Self-benchmark: run TokenGuard against its own source code.
 * Outputs structured results for README documentation.
 */

import path from "path";
import fs from "fs";
import { TokenGuardEngine } from "../src/engine.js";
import { Embedder } from "../src/embedder.js";
import { filterTerminalOutput } from "../src/terminal-filter.js";
import { findDefinition, findReferences, getFileSymbols } from "../src/ast-navigator.js";
import { AstSandbox } from "../src/ast-sandbox.js";

const ROOT = path.resolve(".");

async function main() {
    const engine = new TokenGuardEngine({
        dbPath: path.join(ROOT, ".tokenguard-bench.db"),
        watchPaths: [ROOT],
    });

    await engine.initialize();

    console.log("═══════════════════════════════════════════════════");
    console.log("  TokenGuard Self-Benchmark");
    console.log("═══════════════════════════════════════════════════\n");

    // 1. Index
    console.log("--- Indexing ---");
    const idxStart = performance.now();
    const idxResult = await engine.indexDirectory(ROOT);
    const idxTime = performance.now() - idxStart;
    console.log(`Indexed: ${idxResult.indexed} files, ${idxResult.skipped} skipped, ${idxResult.errors} errors (${idxTime.toFixed(0)}ms)`);

    // 1. tg_map
    console.log("\n--- 1. tg_map ---");
    const mapStart = performance.now();
    const { text: mapText, fromCache } = await engine.getRepoMap(true);
    const mapTime = performance.now() - mapStart;
    const mapTokens = Embedder.estimateTokens(mapText);
    const mapLines = mapText.split("\n").length;
    // Count symbols by looking for signature patterns
    const symbolCount = (mapText.match(/^\s+(func|class|method|interface|type|export_func|export_class)\s/gm) || []).length;
    console.log(`Files mapped: ${engine.getStats().filesIndexed}`);
    console.log(`Lines in map: ${mapLines}`);
    console.log(`Symbols found: ${symbolCount}`);
    console.log(`Map size: ${mapTokens.toLocaleString()} tokens`);
    console.log(`Time: ${mapTime.toFixed(0)}ms (cache: ${fromCache})`);

    // 2. tg_search "compression"
    console.log("\n--- 2. tg_search 'compression' ---");
    const searchStart = performance.now();
    const searchResults = await engine.search("compression", 10);
    const searchTime = performance.now() - searchStart;
    console.log(`Results: ${searchResults.length}`);
    console.log(`Time: ${searchTime.toFixed(0)}ms`);
    console.log("Top 3:");
    for (const r of searchResults.slice(0, 3)) {
        const rel = path.relative(ROOT, r.path);
        console.log(`  - ${rel}:L${r.startLine}-L${r.endLine} [${r.nodeType}] score=${r.score.toFixed(4)}`);
        console.log(`    ${r.shorthand.split("\n")[0].slice(0, 100)}`);
    }

    // 3. tg_def "TokenGuardEngine"
    console.log("\n--- 3. tg_def 'TokenGuardEngine' ---");
    const parser = engine.getParser();
    const defStart = performance.now();
    const defResults = await findDefinition(ROOT, parser, "TokenGuardEngine");
    const defTime = performance.now() - defStart;
    console.log(`Found: ${defResults.length} definition(s)`);
    for (const d of defResults) {
        console.log(`  - ${d.filePath}:L${d.startLine}-L${d.endLine} (${d.kind})`);
    }
    console.log(`Time: ${defTime.toFixed(0)}ms`);

    // 4. tg_refs "safePath"
    console.log("\n--- 4. tg_refs 'safePath' ---");
    const refsStart = performance.now();
    const refsResults = await findReferences(ROOT, parser, "safePath");
    const refsTime = performance.now() - refsStart;
    const refsFiles = new Set(refsResults.map(r => r.filePath));
    console.log(`References: ${refsResults.length}`);
    console.log(`Files: ${[...refsFiles].join(", ")}`);
    console.log(`Time: ${refsTime.toFixed(0)}ms`);

    // 5. tg_outline for src/engine.ts
    console.log("\n--- 5. tg_outline 'src/engine.ts' ---");
    const outlinePath = path.join(ROOT, "src/engine.ts");
    const outStart = performance.now();
    const symbols = await getFileSymbols(outlinePath, parser, ROOT);
    const outTime = performance.now() - outStart;
    console.log(`Symbols: ${symbols.length}`);
    for (const s of symbols.slice(0, 10)) {
        console.log(`  - [${s.kind}] ${s.name} L${s.startLine}-L${s.endLine}`);
    }
    if (symbols.length > 10) console.log(`  ... and ${symbols.length - 10} more`);
    console.log(`Time: ${outTime.toFixed(0)}ms`);

    // 6. tg_compress src/engine.ts at all 3 levels
    console.log("\n--- 6. tg_compress 'src/engine.ts' (3 levels) ---");
    const engineContent = fs.readFileSync(outlinePath, "utf-8");
    const originalTokens = Embedder.estimateTokens(engineContent);
    console.log(`Original: ${originalTokens.toLocaleString()} tokens`);

    for (const level of ["light", "medium", "aggressive"] as const) {
        const cStart = performance.now();
        const cResult = await engine.compressFileAdvanced(outlinePath, level);
        const cTime = performance.now() - cStart;
        const compTokens = Embedder.estimateTokens(cResult.compressed);
        console.log(`${level.padEnd(10)}: ${compTokens.toLocaleString()} tokens (${(cResult.ratio * 100).toFixed(1)}% reduction) ${cTime.toFixed(0)}ms`);
    }

    // 7. tg_terminal with fake 500-line error output
    console.log("\n--- 7. tg_terminal (500-line fake error) ---");
    const fakeLines: string[] = [];
    for (let i = 0; i < 500; i++) {
        if (i % 50 === 0) {
            fakeLines.push(`ERROR: TypeError: Cannot read properties of undefined (reading 'map')`);
            fakeLines.push(`    at processData (src/engine.ts:${100 + i}:15)`);
            fakeLines.push(`    at Object.<anonymous> (node_modules/some-lib/index.js:42:12)`);
        } else if (i % 10 === 0) {
            fakeLines.push(`\x1b[31m  ● Test Suite: src/__tests__/engine.test.ts\x1b[0m`);
        } else {
            fakeLines.push(`    at node_modules/.pnpm/vitest@3.2.4/node_modules/vitest/dist/chunk-${i}.js:${i}:${i}`);
        }
    }
    const fakeOutput = fakeLines.join("\n");
    const termResult = filterTerminalOutput(fakeOutput, 100);
    console.log(`Original: ${termResult.original_tokens.toLocaleString()} tokens`);
    console.log(`Filtered: ${termResult.filtered_tokens.toLocaleString()} tokens`);
    console.log(`Reduction: ${termResult.reduction_percent}%`);

    // 8. tg_validate
    console.log("\n--- 8. tg_validate ---");
    const sandbox = new AstSandbox();
    await sandbox.initialize();

    const validCode = `export function greet(name: string): string { return "Hello, " + name; }`;
    const validResult = await sandbox.validateCode(validCode, "typescript");
    console.log(`Valid TS: valid=${validResult.valid}, errors=${validResult.errors.length}`);

    const invalidCode = `const config = { a: 1 b: 2 };`;
    const invalidResult = await sandbox.validateCode(invalidCode, "typescript");
    console.log(`Invalid TS: valid=${invalidResult.valid}, errors=${invalidResult.errors.length}`);
    for (const e of invalidResult.errors) {
        console.log(`  Line ${e.line}, Col ${e.column}: ${e.nodeType} — ${e.context.trim().slice(0, 60)}`);
    }

    // 9. tg_audit
    console.log("\n--- 9. tg_audit ---");
    const usageStats = engine.getUsageStats();
    console.log(`Tool calls: ${usageStats.tool_calls}`);
    console.log(`Tokens saved: ${usageStats.total_saved.toLocaleString()}`);
    console.log(`Input routed: ${usageStats.total_input.toLocaleString()}`);

    // 10. tg_session_report
    console.log("\n--- 10. tg_session_report ---");
    const session = engine.getSessionReport();
    console.log(`Duration: ${session.durationMinutes} min`);
    console.log(`Total tokens saved: ${session.totalTokensSaved.toLocaleString()}`);
    console.log(`Total processed: ${session.totalOriginalTokens.toLocaleString()}`);
    console.log(`Overall compression: ${(session.overallRatio * 100).toFixed(1)}%`);
    console.log(`USD saved (Sonnet): $${session.savedUsdSonnet.toFixed(4)}`);
    console.log(`USD saved (Opus): $${session.savedUsdOpus.toFixed(4)}`);

    console.log("\n═══════════════════════════════════════════════════");
    console.log("  Benchmark Complete");
    console.log("═══════════════════════════════════════════════════");

    // Cleanup
    engine.shutdown();
    try { fs.unlinkSync(path.join(ROOT, ".tokenguard-bench.db")); } catch {}
}

main().catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
});
