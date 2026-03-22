import { describe, it, expect, afterEach } from "vitest";
import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SpectralMath, SpectralTopologist, SparseEdge } from "../src/kernel/spectral-topology.js";

describe("SpectralMath.analyzeTopology", () => {

    it("should return 0 for single node", () => {
        const { fiedler } = SpectralMath.analyzeTopology(1, []);
        expect(fiedler).toBe(0);
    });

    it("should return 0 for no nodes", () => {
        const { fiedler } = SpectralMath.analyzeTopology(0, []);
        expect(fiedler).toBe(0);
    });

    it("should return positive value for complete graph K3", () => {
        const edges: SparseEdge[] = [
            { u: 0, v: 1, weight: 1 },
            { u: 1, v: 2, weight: 1 },
            { u: 0, v: 2, weight: 1 },
        ];
        const { fiedler } = SpectralMath.analyzeTopology(3, edges);
        expect(fiedler).toBeGreaterThan(0);
        expect(fiedler).toBeCloseTo(3, 0);
    });

    it("should return 0 for disconnected graph", () => {
        const { fiedler } = SpectralMath.analyzeTopology(2, []);
        expect(fiedler).toBe(0);
    });

    it("should detect edge removal (fiedler drops)", () => {
        const connected: SparseEdge[] = [
            { u: 0, v: 1, weight: 1 },
            { u: 1, v: 2, weight: 1 },
        ];
        const weakened: SparseEdge[] = [
            { u: 0, v: 1, weight: 1 },
        ];
        const f1 = SpectralMath.analyzeTopology(3, connected).fiedler;
        const f2 = SpectralMath.analyzeTopology(3, weakened).fiedler;
        expect(f1).toBeGreaterThan(f2);
    });

    it("should be deterministic", () => {
        const edges: SparseEdge[] = [
            { u: 0, v: 1, weight: 1 },
            { u: 1, v: 2, weight: 1 },
            { u: 2, v: 3, weight: 1 },
            { u: 0, v: 3, weight: 1 },
        ];
        const r1 = SpectralMath.analyzeTopology(4, edges).fiedler;
        const r2 = SpectralMath.analyzeTopology(4, edges).fiedler;
        expect(r1).toBe(r2);
    });

    it("should symmetrize directed edges", () => {
        const directed: SparseEdge[] = [
            { u: 0, v: 1, weight: 1 },
            { u: 1, v: 2, weight: 1 },
        ];
        const { fiedler } = SpectralMath.analyzeTopology(3, directed);
        expect(fiedler).toBeGreaterThan(0);
    });

    it("should reflect weight differences", () => {
        const strong: SparseEdge[] = [{ u: 0, v: 1, weight: 1.0 }];
        const weak: SparseEdge[] = [{ u: 0, v: 1, weight: 0.5 }];
        expect(SpectralMath.analyzeTopology(2, strong).fiedler).toBeGreaterThan(
            SpectralMath.analyzeTopology(2, weak).fiedler
        );
    });

    it("should handle 10-node ring", () => {
        const N = 10;
        const edges: SparseEdge[] = [];
        for (let i = 0; i < N; i++) {
            edges.push({ u: i, v: (i + 1) % N, weight: 1 });
        }
        const { fiedler } = SpectralMath.analyzeTopology(N, edges);
        expect(fiedler).toBeGreaterThan(0);
        expect(fiedler).toBeLessThan(1);
    });

    it("should compute volume correctly", () => {
        const edges: SparseEdge[] = [
            { u: 0, v: 1, weight: 1.0 },
            { u: 1, v: 2, weight: 0.5 },
        ];
        const { volume } = SpectralMath.analyzeTopology(3, edges);
        expect(volume).toBeCloseTo(1.5, 1);
    });
});

describe("SpectralTopologist integration", () => {
    let tmpDir: string;

    function createProject(files: Record<string, string>): ts.Program {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-spectral-"));
        const filePaths: string[] = [];
        for (const [name, content] of Object.entries(files)) {
            const fullPath = path.join(tmpDir, name);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(fullPath, content);
            filePaths.push(fullPath);
        }
        return ts.createProgram(filePaths, {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.ES2020,
            moduleResolution: ts.ModuleResolutionKind.Node10,
            strict: true,
            declaration: true,
        });
    }

    afterEach(() => {
        if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("should extract nodes and edges from a simple project", () => {
        const program = createProject({
            "models.ts": `
                export interface User { id: string; name: string; }
                export interface Config { timeout: number; }
            `,
            "service.ts": `
                import { User, Config } from "./models.js";
                export function getUser(config: Config): User {
                    return { id: "1", name: "test" };
                }
            `,
        });
        const targetFiles = new Set<string>();
        for (const sf of program.getSourceFiles()) {
            if (!sf.fileName.includes("node_modules")) {
                targetFiles.add(sf.fileName.replace(/\\/g, "/"));
            }
        }
        const { nodes, edges } = SpectralTopologist.extractConstraintGraph(program, targetFiles);
        expect(nodes.size).toBeGreaterThanOrEqual(3);
        expect(edges.length).toBeGreaterThanOrEqual(2);
    });

    it("should detect fiedler drop on type widening", () => {
        const programPre = createProject({
            "models.ts": `
                export interface RetryConfig { maxRetries: number; delay: number; }
            `,
            "service.ts": `
                import { RetryConfig } from "./models.js";
                export function retry(config: RetryConfig): RetryConfig { return config; }
            `,
        });
        const targetPre = new Set<string>();
        for (const sf of programPre.getSourceFiles()) {
            if (!sf.fileName.includes("node_modules")) targetPre.add(sf.fileName.replace(/\\/g, "/"));
        }
        const pre = SpectralTopologist.analyze(programPre, targetPre);

        const programPost = createProject({
            "models.ts": `
                export interface RetryConfig { maxRetries: number; delay: number; }
            `,
            "service.ts": `
                import { RetryConfig } from "./models.js";
                export function retry(config: any): any { return config; }
            `,
        });
        const targetPost = new Set<string>();
        for (const sf of programPost.getSourceFiles()) {
            if (!sf.fileName.includes("node_modules")) targetPost.add(sf.fileName.replace(/\\/g, "/"));
        }
        const post = SpectralTopologist.analyze(programPost, targetPost);

        expect(pre.fiedlerValue).toBeGreaterThan(post.fiedlerValue);
        expect(pre.volume).toBeGreaterThan(post.volume);
    });

    it("should REJECT entropy injection (ghost nodes)", () => {
        // K3 pre-edit: 3 nodes, all connected, λ₂=3.0
        // Post-edit: AI puts any on node A. A is ghost (0 edges). B,C survive. λ₂=2.0
        // Φ_pre = 3.0/3 = 1.0, Φ_post = 2.0/3 = 0.666 → 33% drop → REJECT
        const pre = { fiedlerValue: 3.0, volume: 3, nodeCount: 3, edgeCount: 3, activeNodes: 3 };
        const post = { fiedlerValue: 2.0, volume: 1, nodeCount: 3, edgeCount: 1, activeNodes: 2 };
        const delta = SpectralTopologist.computeDelta(pre, post);
        expect(delta.verdict).toBe("REJECTED_ENTROPY");
    });

    it("should APPROVE legitimate decoupling (node deleted from AST)", () => {
        // K3 pre-edit: 3 nodes, all connected, λ₂=3.0
        // Post-edit: Human DELETES function A entirely. N_AST drops to 2. B,C survive. λ₂=2.0
        // Φ_pre = 3.0/3 = 1.0, Φ_post = 2.0/2 = 1.0 → 0% drop → APPROVE
        const pre = { fiedlerValue: 3.0, volume: 3, nodeCount: 3, edgeCount: 3, activeNodes: 3 };
        const post = { fiedlerValue: 2.0, volume: 1, nodeCount: 2, edgeCount: 1, activeNodes: 2 };
        const delta = SpectralTopologist.computeDelta(pre, post);
        expect(delta.verdict).not.toBe("REJECTED_ENTROPY");
    });

    it("should REJECT with adaptive epsilon on small graph", () => {
        // Small graph: N_AST=4, ε capped at 0.30
        // Φ drops 35% → exceeds 0.30 → REJECT
        const pre = { fiedlerValue: 2.0, volume: 5, nodeCount: 4, edgeCount: 4, activeNodes: 4 };
        const post = { fiedlerValue: 1.3, volume: 3, nodeCount: 4, edgeCount: 2, activeNodes: 3 };
        const delta = SpectralTopologist.computeDelta(pre, post);
        expect(delta.verdict).toBe("REJECTED_ENTROPY");
    });

    it("should APPROVE cosmetic refactor", () => {
        const programA = createProject({
            "utils.ts": `
                export interface Logger { log(msg: string): void; }
                export function createLogger(): Logger {
                    return { log: (msg: string) => console.log(msg) };
                }
            `,
        });
        const targetA = new Set<string>();
        for (const sf of programA.getSourceFiles()) {
            if (!sf.fileName.includes("node_modules")) targetA.add(sf.fileName.replace(/\\/g, "/"));
        }
        const a = SpectralTopologist.analyze(programA, targetA);

        const programB = createProject({
            "utils.ts": `
                export interface Logger { log(message: string): void; }
                export function createLogger(): Logger {
                    return { log: (message: string) => console.log(message) };
                }
            `,
        });
        const targetB = new Set<string>();
        for (const sf of programB.getSourceFiles()) {
            if (!sf.fileName.includes("node_modules")) targetB.add(sf.fileName.replace(/\\/g, "/"));
        }
        const b = SpectralTopologist.analyze(programB, targetB);

        const delta = SpectralTopologist.computeDelta(a, b);
        expect(delta.verdict).toBe("APPROVED");
    });
});
