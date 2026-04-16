import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Parser from "web-tree-sitter";
import { fileURLToPath } from "url";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { ParserPool } from "../src/parser-pool.js";
import {
    scanProject,
    classifyAndGenerateShadow,
} from "../src/hologram/shadow-generator.js";
import { ShadowCache } from "../src/hologram/shadow-cache.js";

const toPosix = (p: string) => path.normalize(p).replace(/\\/g, "/");

function createTempProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-holo-int-"));
    for (const [filePath, content] of Object.entries(files)) {
        const fullPath = path.join(dir, filePath);
        const dirName = path.dirname(fullPath);
        if (!fs.existsSync(dirName)) fs.mkdirSync(dirName, { recursive: true });
        fs.writeFileSync(fullPath, content);
    }
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "ES2022", module: "commonjs", strict: true,
            noEmit: true, esModuleInterop: true, rootDir: ".", skipLibCheck: true,
        },
        include: ["./**/*.ts"],
        exclude: ["node_modules", "dist"],
    }));
    return dir;
}

function cleanupDir(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

describe("hologram integration", () => {
    let dir: string;

    afterEach(() => { if (dir) cleanupDir(dir); });

    it("41. Full cycle: scan -> generate shadows -> boot -> intercept -> validate", async () => {
        dir = createTempProject({
            // Prunable: all exports have explicit types
            "types.ts": [
                `export interface User { name: string; age: number; }`,
                `export type Role = "admin" | "user" | "guest";`,
                `export const MAX_AGE: number = 120;`,
            ].join("\n"),
            // Prunable: function has return type, const has annotation
            "utils.ts": [
                `export function clamp(val: number, min: number, max: number): number {`,
                `  return Math.max(min, Math.min(max, val));`,
                `}`,
                `export const DEFAULT_MIN: number = 0;`,
            ].join("\n"),
            // Unprunable: function without return type
            "service.ts": [
                `import { User, Role } from "./types";`,
                `import { clamp } from "./utils";`,
                `export function createUser(name: string, age: number) {`,
                `  return { name, age: clamp(age, 0, 120) } as User;`,
                `}`,
            ].join("\n"),
        });

        // Step 1: Scan project
        const pool = new ParserPool(2);
        const scanResult = await scanProject(dir, pool);

        expect(scanResult.stats.pruned).toBeGreaterThanOrEqual(2); // types.ts, utils.ts
        expect(scanResult.stats.unpruned).toBeGreaterThanOrEqual(1); // service.ts

        // Step 2: Boot kernel in hologram mode with shadows
        const kernel = new NrekiKernel();
        kernel.setShadows(
            scanResult.prunable,
            scanResult.unprunable,
            scanResult.ambientFiles,
        );
        kernel.boot(dir, "hologram");
        expect(kernel.isBooted()).toBe(true);

        // Step 3: Intercept a valid edit to service.ts
        const result = await kernel.interceptAtomicBatch([{
            targetFile: path.join(dir, "service.ts"),
            proposedContent: [
                `import { User, Role } from "./types";`,
                `import { clamp } from "./utils";`,
                `export function createUser(name: string, age: number): User {`,
                `  return { name, age: clamp(age, 0, 120) };`,
                `}`,
            ].join("\n"),
        }]);
        expect(result.safe).toBe(true);
        await kernel.rollbackAll();

        // Step 4: Intercept a BREAKING edit
        const result2 = await kernel.interceptAtomicBatch([{
            targetFile: path.join(dir, "service.ts"),
            proposedContent: [
                `import { User } from "./types";`,
                `export function createUser(name: string, age: number): User {`,
                `  return { name, age, nonExistent: true };`,
                `}`,
            ].join("\n"),
        }]);
        expect(result2.safe).toBe(false);
    }, 120_000);

    it("42. Re-classification after edit changes export type", async () => {
        dir = createTempProject({
            "api.ts": [
                `export function init(): void {}`,
                `export const VERSION: number = 1;`,
            ].join("\n"),
        });

        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const wasmDir = path.join(__dirname, "..", "wasm");

        await Parser.init();
        const parser = new Parser();
        const lang = await Parser.Language.load(
            path.join(wasmDir, "tree-sitter-typescript.wasm"),
        );

        // Initially prunable (all explicit)
        const content1 = fs.readFileSync(path.join(dir, "api.ts"), "utf-8");
        const result1 = classifyAndGenerateShadow("api.ts", content1, parser, lang);
        expect(result1.prunable).toBe(true);

        // After edit: now has inferred export -> unprunable
        const content2 = [
            `export function init(): void {}`,
            `export const VERSION: number = 1;`,
            `export const config = { port: 3000 };`,  // object literal, no type annotation
        ].join("\n");
        const result2 = classifyAndGenerateShadow("api.ts", content2, parser, lang);
        expect(result2.prunable).toBe(false);
    });

    it("43. Shadow cache persists between instantiations", () => {
        dir = createTempProject({});

        const cache1 = new ShadowCache(dir);
        cache1.setVersions("6.0.0", "5.9.3");
        cache1.setShadow("/test/file.ts", "export declare const x: number;", "pruned");
        cache1.save(new Map([["/test/file.ts", "export declare const x: number;"]]));

        // Create a new instance and load
        const cache2 = new ShadowCache(dir);
        const shadows = cache2.load();

        expect(shadows.size).toBe(1);
        expect(shadows.get("/test/file.ts")).toContain("export declare const x: number");
    });

    it("44. Pre-warming completes before first edit (simulated)", async () => {
        dir = createTempProject({
            "lib.ts": `export interface Lib { name: string; }`,
            "app.ts": `import { Lib } from "./lib";\nexport function use(l: Lib): string { return l.name; }`,
        });

        // Simulate pre-warming: scan + setShadows + boot
        const pool = new ParserPool(2);
        const scanResult = await scanProject(dir, pool);

        const kernel = new NrekiKernel();
        kernel.setShadows(
            scanResult.prunable,
            scanResult.unprunable,
            scanResult.ambientFiles,
        );
        expect(kernel.hasShadows()).toBe(true);

        // Boot should succeed with pre-warmed shadows
        kernel.boot(dir, "hologram");
        expect(kernel.isBooted()).toBe(true);

        // Edit should work against shadows
        const result = await kernel.interceptAtomicBatch([{
            targetFile: path.join(dir, "app.ts"),
            proposedContent: [
                `import { Lib } from "./lib";`,
                `export function use(l: Lib): string { return l.name.toUpperCase(); }`,
            ].join("\n"),
        }]);
        expect(result.safe).toBe(true);
    }, 30_000);

    it("45. prevents rootNames leak on failed transaction (Bug #4)", async () => {
        // Setup: new_file.ts existe en disco con contenido VÁLIDO (baseline limpio).
        // api.ts lo importa → TypeScript lo compilará cuando sea agregado a rootNames.
        dir = createTempProject({
            "api.ts": `import { newFn } from "./new_file";\nexport function init() { return newFn(); }`,
            "new_file.ts": `export function newFn(): string { return "ok"; }`,
        });

        const kernel = new NrekiKernel();
        kernel.setShadows(new Map(), new Set(), ["api.ts"]);
        kernel.boot(dir, "hologram");

        const newFilePath = path.join(dir, "new_file.ts");

        // INVARIANT DE DISEÑO: new_file.ts NO está en rootNames antes de la tx
        // (hologram mode lo mantiene fuera del root hasta que sea editado).
        // Si este assert falla, el escenario del bug #4 no aplica a este setup —
        // hay que cambiar la estrategia del test.
        expect(kernel.hasRootName(newFilePath)).toBe(false);

        // Intentar sobreescribir new_file.ts con syntax error.
        // Como api.ts ya lo importa válidamente (baseline clean), el nuevo error
        // SÍ se dispara como diff respecto al baseline → batch debe fallar.
        const result = await kernel.interceptAtomicBatch([{
            targetFile: newFilePath,
            proposedContent: `export const BROKEN syntax error here =`,
        }]);

        // Batch debe fallar (syntax error es unambiguo)
        expect(result.safe).toBe(false);

        // INVARIANT CRÍTICO Bug #4: new_file.ts NO debe leak en rootNames
        expect(kernel.hasRootName(newFilePath)).toBe(false);
    }, 30_000);
});
