import * as ts from "typescript";
import * as path from "path";
import * as fs from "fs";
import { SpectralTopologist, SpectralMath, SparseEdge } from "../src/kernel/spectral-topology.js";

const externalPath = process.argv[2] || process.cwd();
const projectRoot = path.resolve(externalPath);
const tsConfigPath = path.join(projectRoot, "tsconfig.json");
if (!fs.existsSync(tsConfigPath)) { console.error(`No tsconfig.json at ${projectRoot}`); process.exit(1); }

console.log(`=== NREKI PRECISION BENCHMARK (SPARSE + MARKOV) ===\n`);
console.log(`Project: ${path.basename(projectRoot)}`);

const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectRoot);
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);

const allFiles = new Set<string>();
for (const sf of program.getSourceFiles()) {
    const fileName = sf.fileName.replace(/\\/g, "/");
    if (!fileName.includes("node_modules") && !fileName.includes(".test.") && !fileName.includes("/dist/")) {
        allFiles.add(fileName);
    }
}

const fullGraph = SpectralTopologist.extractConstraintGraph(program, allFiles);

const fileEdgeCount = new Map<string, number>();
for (const edge of fullGraph.edges) {
    const file = edge.sourceId.split("::")[0];
    fileEdgeCount.set(file, (fileEdgeCount.get(file) || 0) + 1);
}
const candidateFiles = Array.from(fileEdgeCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([file]) => file);

console.log(`\nCandidates (top 5):`);
for (const f of candidateFiles) {
    console.log(`  ${path.relative(projectRoot, f)} (${fileEdgeCount.get(f)} edges)`);
}

// EGO-GRAPH LATENCY (Markov Blanket)
console.log(`\n=== EGO-GRAPH LATENCY (Markov Blanket) ===`);
const latencies: number[] = [];

for (const file of candidateFiles) {
    const blanket = SpectralTopologist.getMarkovBlanket(file, fullGraph.edges);
    const blanketFiles = new Set<string>();
    for (const f of allFiles) {
        if (blanket.has(f.replace(/\\/g, "/"))) blanketFiles.add(f);
    }

    const start = performance.now();
    const result = SpectralTopologist.analyze(program, blanketFiles);
    const ms = performance.now() - start;
    latencies.push(ms);
    console.log(`  ${path.basename(file)}: blanket=${blanketFiles.size} files, ${result.nodeCount} nodes, ${result.edgeCount} edges, ${ms.toFixed(1)}ms, λ₂=${result.fiedlerValue.toFixed(4)}`);
}

const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
const maxLatency = Math.max(...latencies);
console.log(`\n  Avg: ${avgLatency.toFixed(1)}ms | Max: ${maxLatency.toFixed(1)}ms | Target: <100ms`);
console.log(`  Verdict: ${maxLatency < 100 ? "✅ PASS" : "❌ FAIL"}`);

// FALSE NEGATIVE TEST
console.log(`\n=== FALSE NEGATIVE TEST ===`);
let falseNegatives = 0;
const totalWideningTests = candidateFiles.length;

for (const file of candidateFiles) {
    const pre = SpectralTopologist.analyze(program, allFiles, file);

    const blanket = SpectralTopologist.getMarkovBlanket(file, fullGraph.edges);
    const egoEdges = fullGraph.edges.filter(e => {
        const sf = e.sourceId.split("::")[0];
        const tf = e.targetId.split("::")[0];
        return blanket.has(sf) && (blanket.has(tf) || tf.startsWith("EXTERNAL"));
    });

    const postEdges = egoEdges.filter(e => e.sourceId.split("::")[0] !== file);
    const postNodes = new Set<string>();
    for (const e of postEdges) { postNodes.add(e.sourceId); postNodes.add(e.targetId); }
    // Add isolated nodes from blanket files
    for (const e of egoEdges) {
        if (blanket.has(e.sourceId.split("::")[0])) postNodes.add(e.sourceId);
        if (blanket.has(e.targetId.split("::")[0])) postNodes.add(e.targetId);
    }

    const { sparseEdges: postSparse, N: postN } = SpectralTopologist.buildSparseGraph(postNodes, postEdges);
    const { fiedler: postFiedler, volume: postVol } = SpectralMath.analyzeTopology(postN, postSparse);

    const post = { fiedlerValue: postFiedler, volume: postVol, nodeCount: postNodes.size, edgeCount: postEdges.length };
    const delta = SpectralTopologist.computeDelta(pre, post);

    const detected = delta.verdict === "REJECTED_ENTROPY";
    if (!detected) falseNegatives++;

    console.log(`  ${path.basename(file)}: pre(λ₂=${pre.fiedlerValue.toFixed(4)}, vol=${pre.volume}) → post(λ₂=${postFiedler.toFixed(4)}, vol=${postVol}) = ${delta.verdict} ${detected ? "✅" : "❌"}`);
}

console.log(`  False negatives: ${falseNegatives}/${totalWideningTests}`);

// FALSE POSITIVE TEST
console.log(`\n=== FALSE POSITIVE TEST ===`);
let falsePositives = 0;

for (const file of candidateFiles) {
    const result = SpectralTopologist.analyze(program, allFiles, file);
    const delta = SpectralTopologist.computeDelta(result, result);
    const approved = delta.verdict === "APPROVED";
    if (!approved) falsePositives++;
    console.log(`  ${path.basename(file)}: ${delta.verdict} ${approved ? "✅" : "❌"}`);
}

console.log(`  False positives: ${falsePositives}/${totalWideningTests}`);

// SUMMARY
console.log(`\n=== SUMMARY ===`);
console.log(`Project: ${path.basename(projectRoot)} | Files: ${allFiles.size} | Nodes: ${fullGraph.nodes.size} | Edges: ${fullGraph.edges.length}`);
console.log(`Latency: avg=${avgLatency.toFixed(1)}ms, max=${maxLatency.toFixed(1)}ms (target <100ms): ${maxLatency < 100 ? "✅" : "❌"}`);
console.log(`False negatives: ${falseNegatives}/${totalWideningTests} (target 0%): ${falseNegatives === 0 ? "✅" : "❌"}`);
console.log(`False positives: ${falsePositives}/${totalWideningTests} (target <5%): ${falsePositives === 0 ? "✅" : "❌"}`);
console.log(`Overall: ${maxLatency < 100 && falseNegatives === 0 && falsePositives === 0 ? "✅ ALL PASS" : "❌ NEEDS WORK"}`);
