import { describe, it, expect } from "vitest";
import { SpectralMath } from "../src/kernel/spectral-topology.js";

describe("SpectralMath.getFiedlerValue", () => {

    it("should return 0 for single node", () => {
        expect(SpectralMath.getFiedlerValue([[0]])).toBe(0);
    });

    it("should return 0 for empty matrix", () => {
        expect(SpectralMath.getFiedlerValue([])).toBe(0);
    });

    it("should return positive value for complete graph K3", () => {
        const adj = [
            [0, 1, 1],
            [1, 0, 1],
            [1, 1, 0],
        ];
        const fiedler = SpectralMath.getFiedlerValue(adj);
        expect(fiedler).toBeGreaterThan(0);
        expect(fiedler).toBeCloseTo(3, 0);
    });

    it("should return 0 for disconnected graph", () => {
        const adj = [
            [0, 0],
            [0, 0],
        ];
        expect(SpectralMath.getFiedlerValue(adj)).toBe(0);
    });

    it("should detect edge removal (fiedler drops)", () => {
        const connected = [
            [0, 1, 0],
            [1, 0, 1],
            [0, 1, 0],
        ];
        const weakened = [
            [0, 1, 0],
            [1, 0, 0],
            [0, 0, 0],
        ];
        const f1 = SpectralMath.getFiedlerValue(connected);
        const f2 = SpectralMath.getFiedlerValue(weakened);
        expect(f1).toBeGreaterThan(f2);
    });

    it("should be deterministic (exact same output for same input)", () => {
        const adj = [
            [0, 1, 0, 1],
            [1, 0, 1, 0],
            [0, 1, 0, 1],
            [1, 0, 1, 0],
        ];
        const r1 = SpectralMath.getFiedlerValue(adj);
        const r2 = SpectralMath.getFiedlerValue(adj);
        expect(r1).toBe(r2);
    });

    it("should symmetrize directed graph", () => {
        const directed = [
            [0, 1, 0],
            [0, 0, 1],
            [0, 0, 0],
        ];
        const fiedler = SpectralMath.getFiedlerValue(directed);
        expect(fiedler).toBeGreaterThan(0);
    });

    it("should reflect weight differences", () => {
        const strong = [
            [0, 1.0],
            [1.0, 0],
        ];
        const weak = [
            [0, 0.5],
            [0.5, 0],
        ];
        expect(SpectralMath.getFiedlerValue(strong)).toBeGreaterThan(
            SpectralMath.getFiedlerValue(weak)
        );
    });

    it("should handle larger graph (10 nodes ring)", () => {
        const N = 10;
        const adj: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
        for (let i = 0; i < N; i++) {
            adj[i][(i + 1) % N] = 1;
            adj[(i + 1) % N][i] = 1;
        }
        const fiedler = SpectralMath.getFiedlerValue(adj);
        expect(fiedler).toBeGreaterThan(0);
        expect(fiedler).toBeLessThan(1);
    });
});
