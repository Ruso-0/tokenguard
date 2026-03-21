import * as ts from "typescript";
import * as path from "path";
import * as fs from "fs";
import { SpectralTopologist, SpectralMath } from "../src/kernel/spectral-topology.js";

const externalPath = process.argv[2];
if (!externalPath) { console.error("Usage: tsx tests/benchmark-spectral-external.ts /path/to/project"); process.exit(1); }

const projectRoot = path.resolve(externalPath);
const tsConfigPath = path.join(projectRoot, "tsconfig.json");
if (!fs.existsSync(tsConfigPath)) { console.error(`No tsconfig.json at ${projectRoot}`); process.exit(1); }

console.log(`=== NREKI SPECTRAL BENCHMARK EXTERNAL (SPARSE) ===\n`);
console.log(`Project: ${path.basename(projectRoot)}`);

const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectRoot);
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);

const targetFiles = new Set<string>();
for (const sf of program.getSourceFiles()) {
    const fileName = sf.fileName.replace(/\\/g, "/");
    if (!fileName.includes("node_modules") && !fileName.includes(".test.") && !fileName.includes("/dist/")) {
        targetFiles.add(fileName);
    }
}

console.log(`Source files: ${targetFiles.size}`);

const startExtract = performance.now();
const memBefore = process.memoryUsage().heapUsed;
const { nodes, edges } = SpectralTopologist.extractConstraintGraph(program, targetFiles);
const extractMs = performance.now() - startExtract;
const memAfter = process.memoryUsage().heapUsed;

const { sparseEdges, N } = SpectralTopologist.buildSparseGraph(nodes, edges);
const startFiedler = performance.now();
const { fiedler, volume } = SpectralMath.analyzeTopology(N, sparseEdges);
const fiedlerMs = performance.now() - startFiedler;

console.log(`\n--- Results ---`);
console.log(`Nodes: ${nodes.size} | Edges: ${edges.length} | Sparse edges: ${sparseEdges.length}`);
console.log(`Fiedler (λ₂): ${fiedler.toFixed(6)} | Volume: ${volume}`);
console.log(`Extract: ${extractMs.toFixed(1)}ms | Fiedler (sparse): ${fiedlerMs.toFixed(1)}ms`);
console.log(`RAM delta: ${((memAfter - memBefore) / 1024).toFixed(0)}KB`);
