/**
 * cache-tickets.test.ts — Cryptographic tickets for internal-edit detection.
 *
 * Verifies that processQueue distinguishes internal edits (NREKI wrote the file)
 * from external edits (human/git/linter wrote the file) and only invalidates
 * the in-memory topology cache when the change is external or topology-changing.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import { NrekiEngine } from "../src/engine.js";

type EnginePrivate = {
    cachedGraph: unknown;
    expectedInternalHashes: Map<string, string>;
    indexingQueue: Set<string>;
    processQueue: () => Promise<void>;
};

function asPrivate(engine: NrekiEngine): EnginePrivate {
    return engine as unknown as EnginePrivate;
}

async function runQueue(engine: NrekiEngine, filePath: string): Promise<void> {
    const priv = asPrivate(engine);
    priv.indexingQueue.add(filePath);
    await priv.processQueue();
}

function writeFileAtomic(filePath: string, content: string): void {
    fs.writeFileSync(filePath, content);
}

function makeProject(tmpDir: string): { files: Record<string, string> } {
    const src = path.join(tmpDir, "src");
    fs.mkdirSync(src, { recursive: true });

    const aPath = path.join(src, "a.ts");
    const bPath = path.join(src, "b.ts");
    const cPath = path.join(src, "c.ts");
    const dPath = path.join(src, "d.ts");
    const ePath = path.join(src, "e.ts");

    fs.writeFileSync(aPath, `export function alpha(x: number): number { return x + 1; }\n`);
    fs.writeFileSync(bPath, `import { alpha } from "./a.js";\nexport function beta(x: number): number { return alpha(x) * 2; }\n`);
    fs.writeFileSync(cPath, `import { beta } from "./b.js";\nexport function gamma(x: number): number { return beta(x) - 3; }\n`);
    fs.writeFileSync(dPath, `export const delta = 42;\n`);
    fs.writeFileSync(ePath, `export const epsilon = "eps";\n`);

    return { files: { a: aPath, b: bPath, c: cPath, d: dPath, e: ePath } };
}

async function setupEngine(tmpDir: string): Promise<NrekiEngine> {
    const engine = new NrekiEngine({
        dbPath: path.join(tmpDir, ".nreki.db"),
        watchPaths: [tmpDir],
    });
    await engine.initialize();
    return engine;
}

describe("cache-tickets: cryptographic ticket API", () => {
    let tmpDir: string;
    let files: Record<string, string>;
    let engine: NrekiEngine;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-tix-"));
        files = makeProject(tmpDir).files;
        engine = await setupEngine(tmpDir);
        await engine.getRepoMap();
    });

    afterAll(() => {
        try { engine.shutdown(); } catch { /* ignore */ }
    });

    it("Test 1: cache persists across internal edits without import changes", async () => {
        const priv = asPrivate(engine);
        const cacheBefore = priv.cachedGraph;
        expect(cacheBefore).not.toBeNull();

        const newBody = `export function alpha(x: number): number { return x + 100; }\n`;
        engine.expectInternalEdit(files.a, newBody);
        writeFileAtomic(files.a, newBody);
        await runQueue(engine, files.a);

        expect(priv.cachedGraph).toBe(cacheBefore);
    });

    it("Test 2: cache invalidated when external modification lacks ticket", async () => {
        const priv = asPrivate(engine);
        const cacheBefore = priv.cachedGraph;
        expect(cacheBefore).not.toBeNull();

        const withNewImport = `import { epsilon } from "./e.js";\nexport function alpha(x: number): number { return x + (epsilon.length); }\n`;
        writeFileAtomic(files.a, withNewImport);
        await runQueue(engine, files.a);

        expect(priv.cachedGraph).toBeNull();
    });

    it("Test 3: cancelInternalEdit removes ticket (no leak)", () => {
        const priv = asPrivate(engine);
        const sizeBefore = priv.expectedInternalHashes.size;

        engine.expectInternalEdit(files.a, "irrelevant content");
        expect(priv.expectedInternalHashes.size).toBe(sizeBefore + 1);

        engine.cancelInternalEdit(files.a);
        expect(priv.expectedInternalHashes.size).toBe(sizeBefore);
    });

    it("Test 4: external writeFileSync without ticket invalidates cache", async () => {
        const priv = asPrivate(engine);
        const cacheBefore = priv.cachedGraph;
        expect(cacheBefore).not.toBeNull();

        writeFileAtomic(files.d, `export const delta = 999;\n// edited externally\n`);
        await runQueue(engine, files.d);

        expect(priv.cachedGraph).toBeNull();
    });

    it("Test 5: OOM guard caps tickets at 100", () => {
        const priv = asPrivate(engine);
        for (let i = 0; i < 150; i++) {
            engine.expectInternalEdit(path.join(tmpDir, `synthetic-${i}.ts`), `export const v${i} = ${i};\n`);
        }
        expect(priv.expectedInternalHashes.size).toBeLessThanOrEqual(100);
    });

    it("Test 6: indexFile runs for internal edits (SQLite/search stays fresh)", async () => {
        const newBody = `export function alpha(x: number): number { /* NEW_INTERNAL_MARKER */ return x + 777; }\n`;
        engine.expectInternalEdit(files.a, newBody);
        writeFileAtomic(files.a, newBody);
        await runQueue(engine, files.a);

        const hits = await engine.search("NEW_INTERNAL_MARKER", 5);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.some(h => h.rawCode.includes("NEW_INTERNAL_MARKER"))).toBe(true);
    });
});
