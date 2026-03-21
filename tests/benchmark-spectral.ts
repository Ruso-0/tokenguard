import * as ts from "typescript";
import * as path from "path";
import * as fs from "fs";
import { SpectralTopologist, SpectralMath } from "../src/kernel/spectral-topology.js";

const projectRoot = path.resolve(process.cwd());
const tsConfigPath = path.join(projectRoot, "tsconfig.json");

console.log("=== NREKI SPECTRAL BENCHMARK (SPARSE) ===\n");
console.log(`Project: ${projectRoot}`);

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

const startTotal = performance.now();
const { nodes, edges } = SpectralTopologist.extractConstraintGraph(program, targetFiles);
const extractMs = performance.now() - startTotal;

const { sparseEdges, N } = SpectralTopologist.buildSparseGraph(nodes, edges);
const startFiedler = performance.now();
const { fiedler, volume } = SpectralMath.analyzeTopology(N, sparseEdges);
const fiedlerMs = performance.now() - startFiedler;

console.log(`\nNodes: ${nodes.size} | Edges: ${edges.length}`);
console.log(`Fiedler (λ₂): ${fiedler.toFixed(6)} | Volume: ${volume}`);
console.log(`Extract: ${extractMs.toFixed(1)}ms | Fiedler: ${fiedlerMs.toFixed(1)}ms`);
