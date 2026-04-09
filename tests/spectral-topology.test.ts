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

    it("should detect disconnection via Phi metric (breaking a dense hub)", () => {
        const connected: SparseEdge[] = [
            { u: 0, v: 1, weight: 1 },
            { u: 1, v: 2, weight: 1 },
            { u: 0, v: 2, weight: 1 },
        ];
        const weakened: SparseEdge[] = [
            { u: 0, v: 1, weight: 1 },
        ];
        const r1 = SpectralMath.analyzeTopology(3, connected);
        const r2 = SpectralMath.analyzeTopology(3, weakened);
        const phi1 = r1.fiedler / 3;
        const phi2 = r2.fiedler / 3;
        expect(phi1).toBeGreaterThan(phi2);
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

    it("should return v2, lambda3, and v3 for non-trivial graph", () => {
        const edges: SparseEdge[] = [
            { u: 0, v: 1, weight: 1 },
            { u: 1, v: 2, weight: 1 },
            { u: 0, v: 2, weight: 1 },
            { u: 2, v: 3, weight: 1 },
        ];
        const result = SpectralMath.analyzeTopology(4, edges);

        expect(result.v2).toBeDefined();
        expect(result.v2!.length).toBe(4);
        expect(result.lambda3).toBeDefined();
        expect(result.lambda3!).toBeGreaterThanOrEqual(result.fiedler);
        expect(result.v3).toBeDefined();
        expect(result.v3!.length).toBe(4);

        const v2Sum = result.v2!.reduce((a, b) => a + Math.abs(b), 0);
        expect(v2Sum).toBeGreaterThan(0);
    });

    it("should produce deterministic gauge-fixed vectors", () => {
        const edges: SparseEdge[] = [
            { u: 0, v: 1, weight: 1 },
            { u: 1, v: 2, weight: 1 },
            { u: 0, v: 2, weight: 1 },
        ];
        const r1 = SpectralMath.analyzeTopology(3, edges);
        const r2 = SpectralMath.analyzeTopology(3, edges);

        for (let i = 0; i < 3; i++) {
            expect(r1.v2![i]).toBe(r2.v2![i]);
            expect(r1.v3![i]).toBe(r2.v3![i]);
        }
    });

    it("should have gauge-fixed v2 with positive dominant component", () => {
        const edges: SparseEdge[] = [
            { u: 0, v: 1, weight: 1 },
            { u: 1, v: 2, weight: 1 },
            { u: 2, v: 3, weight: 1 },
            { u: 0, v: 3, weight: 1 },
        ];
        const result = SpectralMath.analyzeTopology(4, edges);

        let maxAbs = -1;
        let maxVal = 0;
        for (let i = 0; i < result.v2!.length; i++) {
            if (Math.abs(result.v2![i]) > maxAbs) {
                maxAbs = Math.abs(result.v2![i]);
                maxVal = result.v2![i];
            }
        }
        expect(maxVal).toBeGreaterThan(0);
    });

    it("should gracefully fail-closed on hub-heavy graphs causing IEEE 754 overflow (Numerical Sanity Firewall)", () => {
        // MATEMÁTICA DEL OVERFLOW IEEE 754:
        // En un grafo estrella K_{1,N-1}, tras la normalización L2, vec[i] ≈ 1/√N.
        // El factor de desplazamiento c ≈ 2(N-1)w. Por tanto, val = c * vec[i] ≈ 2w√N.
        // En el hot loop acumulamos norm += val * val.
        // val² ≈ 4w²N, por lo que Σ(val²) ≈ 4w²N².
        // Para desbordar Float64 (MAX_VALUE ≈ 1.79e308), necesitamos 4w²N² > 1.79e308.
        // Con N=1000, el umbral exacto de desbordamiento es w > 6.7e150.
        // Usamos w = 1e160 para garantizar el overflow térmico desde el interior
        // del power iteration (Inf - Inf -> NaN) sin inyectar inputs malformados.
        const N = 1000;
        const edges: SparseEdge[] = [];
        for (let i = 1; i < N; i++) {
            edges.push({ u: 0, v: i, weight: 1e160 }); // Inyección de tensión térmica
        }

        const result = SpectralMath.analyzeTopology(N, edges);

        // El firewall DEBE atrapar el NaN/Infinity interno y hacer fallback
        // a la variante degenerada de la unión discriminada.
        expect(result.fiedler).toBe(0);
        expect(result.volume).toBeGreaterThan(0);

        // El tipado y el runtime garantizan que los vectores espectrales no existen
        expect(result.v2).toBeUndefined();
        expect(result.lambda3).toBeUndefined();
        expect(result.v3).toBeUndefined();
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

    it("should pass nodeIndex through analyze bridge", () => {
        const program = createProject({
            "a.ts": `
                export interface Foo { x: number; }
            `,
            "b.ts": `
                import { Foo } from "./a.js";
                export function useFoo(f: Foo): Foo { return f; }
            `,
        });
        const targets = new Set<string>();
        for (const sf of program.getSourceFiles()) {
            if (!sf.fileName.includes("node_modules")) targets.add(sf.fileName.replace(/\\/g, "/"));
        }
        const result = SpectralTopologist.analyze(program, targets);

        if (result.nodeCount > 1) {
            expect(result.nodeIndex).toBeDefined();
            expect(result.nodeIndex!.size).toBe(result.nodeCount);
            expect(result.v2).toBeDefined();
            expect(result.v2!.length).toBe(result.nodeCount);
        }
    });
});
