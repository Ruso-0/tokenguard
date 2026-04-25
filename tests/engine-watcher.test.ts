import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NrekiEngine } from "../src/engine.js";
import { handleFastGrep } from "../src/handlers/navigate.js";
import type { RouterDependencies } from "../src/router.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (err) {
            lastError = err;
            await sleep(100);
        }
    }
    if (lastError) throw lastError;
}

describe("engine watcher and fast_grep bootstrap", () => {
    let tmpDir: string;
    let engine: NrekiEngine;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-watch-"));
        const srcDir = path.join(tmpDir, "src");
        fs.mkdirSync(srcDir, { recursive: true });
        const watchRoot = srcDir.replace(/\\/g, "/");
        engine = new NrekiEngine({
            dbPath: path.join(tmpDir, ".nreki.db"),
            watchPaths: [watchRoot],
            enableEmbeddings: false,
        });
    });

    afterEach(() => {
        engine.shutdown();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    async function fastGrepText(query: string): Promise<string> {
        const response = await handleFastGrep(
            { action: "fast_grep", query, limit: 10 },
            { engine } as unknown as RouterDependencies,
        );
        return response.content[0]?.text ?? "";
    }

    function expectFastGrepHit(text: string, query: string): void {
        expect(text).toContain(`## Semantic Fast Grep: "${query}"`);
        expect(text).not.toContain("No matches found");
        expect(text).toContain(query);
    }

    it("bootstraps an empty index synchronously on first fast_grep", async () => {
        fs.writeFileSync(path.join(tmpDir, "src", "cold.ts"), [
            "export function coldStart(): string {",
            "    return 'COLD_START_TOKEN';",
            "}",
        ].join("\n"), "utf-8");

        await engine.initialize();
        expect(engine.getStats().filesIndexed).toBe(0);

        const text = await fastGrepText("COLD_START_TOKEN");

        expectFastGrepHit(text, "COLD_START_TOKEN");
        expect(engine.getStats().filesIndexed).toBe(1);
    });

    it("updates stale chunks after an external write", async () => {
        const file = path.join(tmpDir, "src", "reactive.ts");
        fs.writeFileSync(file, [
            "export function reactive(): string {",
            "    return 'REACTIVE_OLD_TOKEN';",
            "}",
        ].join("\n"), "utf-8");

        await engine.initialize();
        await engine.startWatcher();
        expectFastGrepHit(await fastGrepText("REACTIVE_OLD_TOKEN"), "REACTIVE_OLD_TOKEN");

        fs.writeFileSync(file, [
            "export function reactive(): string {",
            "    return 'REACTIVE_NEW_TOKEN';",
            "}",
        ].join("\n"), "utf-8");

        await waitFor(async () => {
            expectFastGrepHit(await fastGrepText("REACTIVE_NEW_TOKEN"), "REACTIVE_NEW_TOKEN");
        });
    });

    it("does not duplicate chunks during watcher and fast_grep bootstrap race", async () => {
        fs.writeFileSync(path.join(tmpDir, "src", "race.ts"), [
            "export function race(): string {",
            "    return 'RACE_BOOTSTRAP_TOKEN';",
            "}",
        ].join("\n"), "utf-8");

        await engine.initialize();
        engine.startWatcher();
        const before = engine.getStats().totalChunks;
        const text = await fastGrepText("RACE_BOOTSTRAP_TOKEN");
        await sleep(700);
        const after = engine.getStats().totalChunks;

        expect(before).toBe(0);
        expectFastGrepHit(text, "RACE_BOOTSTRAP_TOKEN");
        expect(after).toBe(1);
    });

    it("configures the watcher as reactive-only", () => {
        const source = fs.readFileSync(path.resolve("src", "engine.ts"), "utf-8");
        expect(source).toContain("ignoreInitial: true");
    });

    it("starts the watcher without indexing initial files", async () => {
        fs.writeFileSync(path.join(tmpDir, "src", "idle.ts"), [
            "export function idle(): string {",
            "    return 'IDLE_BOOT_TOKEN';",
            "}",
        ].join("\n"), "utf-8");

        await engine.initialize();
        await engine.startWatcher();

        expect(engine.getStats().filesIndexed).toBe(0);
        expect(engine.getStats().totalChunks).toBe(0);
    });

    it("starts the reactive watcher after server connect", () => {
        const source = fs.readFileSync(path.resolve("src", "index.ts"), "utf-8");
        const connectIndex = source.indexOf("await server.connect(transport);");
        const watcherIndex = source.indexOf("engine.startWatcher();", connectIndex);

        expect(connectIndex).toBeGreaterThan(-1);
        expect(watcherIndex).toBeGreaterThan(connectIndex);
    });
});
