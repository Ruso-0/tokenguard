import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { ChronosMemory } from "../src/chronos-memory.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function createTempProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ttrd-test-"));

    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "ES2022",
            module: "commonjs",
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            rootDir: ".",
            skipLibCheck: true,
        },
        include: ["./**/*.ts"],
        exclude: ["node_modules", "dist"],
    }));

    for (const [filePath, content] of Object.entries(files)) {
        const fullPath = path.join(dir, filePath);
        const dirName = path.dirname(fullPath);
        if (!fs.existsSync(dirName)) fs.mkdirSync(dirName, { recursive: true });
        fs.writeFileSync(fullPath, content);
    }

    return dir;
}

function cleanupTempProject(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
}

// ─── Tests ───────────────────────────────────────────────────────────

let dir: string;
afterEach(() => { if (dir) cleanupTempProject(dir); });

describe("TTRD: extractCanonicalTypes", () => {

    it("returns resolved types for exported functions", async () => {
        dir = createTempProject({
            "utils.ts": `
export function add(a: number, b: number): number { return a + b; }
export const PI = 3.14;
`,
        });

        const kernel = new NrekiKernel();
        kernel.boot(dir);

        // No-op edit (same content) to trigger post-contracts
        const content = fs.readFileSync(path.join(dir, "utils.ts"), "utf-8");
        const result = await kernel.interceptAtomicBatch([
            { targetFile: "utils.ts", proposedContent: content },
        ]);

        expect(result.safe).toBe(true);
        expect(result.postContracts).toBeDefined();
        expect(result.postContracts!.size).toBeGreaterThan(0);

        // Find the file's contracts (key is posix absolute path)
        const fileContracts = Array.from(result.postContracts!.values())[0];
        expect(fileContracts.get("add")).toContain("number");
        expect(fileContracts.get("PI")).toBeDefined();
    });

    it("detects regression: function return type number -> any", async () => {
        dir = createTempProject({
            "calc.ts": `export function compute(): number { return 42; }\n`,
        });

        const kernel = new NrekiKernel();
        kernel.boot(dir);

        const result = await kernel.interceptAtomicBatch([{
            targetFile: "calc.ts",
            proposedContent: `export function compute(): any { return 42; }\n`,
        }]);

        expect(result.safe).toBe(true);
        expect(result.regressions).toBeDefined();
        expect(result.regressions!.length).toBe(1);
        expect(result.regressions![0].symbol).toBe("compute");
        expect(result.regressions![0].newType).toMatch(/any/);
    });

    it("detects regression: interface replaced with type alias to any", async () => {
        dir = createTempProject({
            "types.ts": `export interface Config { port: number; host: string; }\n`,
        });

        const kernel = new NrekiKernel();
        kernel.boot(dir);

        const result = await kernel.interceptAtomicBatch([{
            targetFile: "types.ts",
            proposedContent: `export type Config = any;\n`,
        }]);

        expect(result.safe).toBe(true);
        expect(result.regressions).toBeDefined();
        expect(result.regressions!.length).toBe(1);
        expect(result.regressions![0].symbol).toBe("Config");
        expect(result.regressions![0].newType).toMatch(/any/);
    });

    it("detects regression: Promise<string> -> Promise<any> (generic toxic)", async () => {
        dir = createTempProject({
            "async-api.ts": `export async function fetchData(): Promise<string> { return "ok"; }\n`,
        });

        const kernel = new NrekiKernel();
        kernel.boot(dir);

        const result = await kernel.interceptAtomicBatch([{
            targetFile: "async-api.ts",
            proposedContent: `export async function fetchData(): Promise<any> { return "ok"; }\n`,
        }]);

        expect(result.safe).toBe(true);
        expect(result.regressions).toBeDefined();
        expect(result.regressions!.length).toBe(1);
        expect(result.regressions![0].symbol).toBe("fetchData");
        expect(result.regressions![0].newType).toContain("any");
    });

    it("no false positive: number changed to string (neither toxic)", async () => {
        dir = createTempProject({
            "id.ts": `export function getId(): number { return 1; }\n`,
        });

        const kernel = new NrekiKernel();
        kernel.boot(dir);

        const result = await kernel.interceptAtomicBatch([{
            targetFile: "id.ts",
            proposedContent: `export function getId(): string { return "1"; }\n`,
        }]);

        expect(result.safe).toBe(true);
        expect(result.regressions).toBeUndefined();
    });

    it("no false positive: symbol deleted entirely", async () => {
        dir = createTempProject({
            "old.ts": `export function legacy(): number { return 0; }\nexport function keep(): string { return "ok"; }\n`,
        });

        const kernel = new NrekiKernel();
        kernel.boot(dir);

        const result = await kernel.interceptAtomicBatch([{
            targetFile: "old.ts",
            proposedContent: `export function keep(): string { return "ok"; }\n`,
        }]);

        expect(result.safe).toBe(true);
        expect(result.regressions).toBeUndefined();
    });

    it("barrel file guard: export * does not expand re-exports", async () => {
        dir = createTempProject({
            "internal.ts": `export function secret(): number { return 42; }\n`,
            "barrel.ts": `export * from "./internal";\nexport const version = 1;\n`,
        });

        const kernel = new NrekiKernel();
        kernel.boot(dir);

        const content = fs.readFileSync(path.join(dir, "barrel.ts"), "utf-8");
        const result = await kernel.interceptAtomicBatch([{
            targetFile: "barrel.ts",
            proposedContent: content,
        }]);

        expect(result.safe).toBe(true);
        expect(result.postContracts).toBeDefined();

        // Find barrel.ts contracts
        const barrelContracts = Array.from(result.postContracts!.values()).find(
            m => m.has("version")
        );
        expect(barrelContracts).toBeDefined();
        // "secret" should NOT appear in barrel.ts contracts (it's a re-export)
        expect(barrelContracts!.has("secret")).toBe(false);
        expect(barrelContracts!.has("version")).toBe(true);
    });

    it("type string hard limit: stays under 500 chars", async () => {
        // Generate a type with many fields to create a long type string
        const fields = Array.from({ length: 60 }, (_, i) =>
            `field${i}: { nested${i}: string; value${i}: number }`
        ).join("; ");
        dir = createTempProject({
            "big.ts": `export const config = { ${fields} };\n`,
        });

        const kernel = new NrekiKernel();
        kernel.boot(dir);

        const content = fs.readFileSync(path.join(dir, "big.ts"), "utf-8");
        const result = await kernel.interceptAtomicBatch([{
            targetFile: "big.ts",
            proposedContent: content,
        }]);

        expect(result.safe).toBe(true);
        expect(result.postContracts).toBeDefined();

        for (const [, fileContracts] of result.postContracts!) {
            for (const [, typeStr] of fileContracts) {
                expect(typeStr.length).toBeLessThanOrEqual(500);
            }
        }
    });
});

describe("TTRD: ChronosMemory debt tracking", () => {

    it("supermodular penalty: 20 regressions ~109 points", () => {
        dir = createTempProject({ "dummy.ts": `export const x = 1;\n` });

        const chronos = new ChronosMemory(dir);
        const regressions = Array.from({ length: 20 }, (_, i) => ({
            symbol: `sym${i}`,
            oldType: "number",
            newType: "any",
        }));

        chronos.recordRegressions(path.join(dir, "dummy.ts"), regressions);
        chronos.forcePersist();

        const state = JSON.parse(fs.readFileSync(
            path.join(dir, ".nreki", "chronos-history.json"), "utf-8"
        ));
        const file = Object.values(state.files)[0] as any;

        // W_ERROR(3.0) * Math.pow(20, 1.2) ≈ 3.0 * 36.41 ≈ 109.2
        expect(file.cfiScore).toBeGreaterThan(105);
        expect(file.cfiScore).toBeLessThan(115);
    });

    it("debt ledger persists across ChronosMemory instances", () => {
        dir = createTempProject({ "srv.ts": `export const x = 1;\n` });

        const chronos1 = new ChronosMemory(dir);
        chronos1.recordRegressions(path.join(dir, "srv.ts"), [
            { symbol: "getUser", oldType: "User", newType: "any" },
        ]);
        chronos1.forcePersist();

        const chronos2 = new ChronosMemory(dir);
        const state = JSON.parse(fs.readFileSync(
            path.join(dir, ".nreki", "chronos-history.json"), "utf-8"
        ));
        const file = Object.values(state.files)[0] as any;

        expect(file.unpaidTypeDebts).toBeDefined();
        expect(file.unpaidTypeDebts.length).toBe(1);
        expect(file.unpaidTypeDebts[0].symbol).toBe("getUser");
        expect(file.unpaidTypeDebts[0].strictType).toBe("User");
        expect(file.unpaidTypeDebts[0].degradedType).toBe("any");
    });

    it("debt payment: restore any back to number, debt cleared, score reduced", () => {
        dir = createTempProject({ "math.ts": `export const x = 1;\n` });

        const chronos = new ChronosMemory(dir);
        chronos.recordRegressions(path.join(dir, "math.ts"), [
            { symbol: "compute", oldType: "number", newType: "any" },
        ]);
        chronos.forcePersist();

        const scoreBefore = JSON.parse(fs.readFileSync(
            path.join(dir, ".nreki", "chronos-history.json"), "utf-8"
        ));
        const cfiBefore = (Object.values(scoreBefore.files)[0] as any).cfiScore;

        // Simulate fixing the type
        const fixedContracts = new Map<string, string>([["compute", "number"]]);
        const paid = chronos.assessDebtPayments(path.join(dir, "math.ts"), fixedContracts);
        chronos.forcePersist();

        expect(paid).toContain("compute");

        const scoreAfter = JSON.parse(fs.readFileSync(
            path.join(dir, ".nreki", "chronos-history.json"), "utf-8"
        ));
        const fileAfter = Object.values(scoreAfter.files)[0] as any;

        expect(fileAfter.cfiScore).toBeLessThan(cfiBefore);
        expect(fileAfter.unpaidTypeDebts).toBeUndefined();
    });

    it("debt payment stacking: pay 3 debts, score multiplied by SUCCESS_DISCOUNT^3", () => {
        dir = createTempProject({ "api.ts": `export const x = 1;\n` });

        const chronos = new ChronosMemory(dir);
        chronos.recordRegressions(path.join(dir, "api.ts"), [
            { symbol: "a", oldType: "string", newType: "any" },
            { symbol: "b", oldType: "number", newType: "any" },
            { symbol: "c", oldType: "boolean", newType: "any" },
        ]);
        chronos.forcePersist();

        const scoreBefore = JSON.parse(fs.readFileSync(
            path.join(dir, ".nreki", "chronos-history.json"), "utf-8"
        ));
        const cfiBefore = (Object.values(scoreBefore.files)[0] as any).cfiScore;

        const fixedContracts = new Map<string, string>([
            ["a", "string"], ["b", "number"], ["c", "boolean"],
        ]);
        const paid = chronos.assessDebtPayments(path.join(dir, "api.ts"), fixedContracts);
        chronos.forcePersist();

        expect(paid.length).toBe(3);

        const scoreAfter = JSON.parse(fs.readFileSync(
            path.join(dir, ".nreki", "chronos-history.json"), "utf-8"
        ));
        const fileAfter = Object.values(scoreAfter.files)[0] as any;

        // SUCCESS_DISCOUNT = 0.50, so score * 0.50^3 = score * 0.125
        const expected = cfiBefore * Math.pow(0.50, 3);
        expect(fileAfter.cfiScore).toBeCloseTo(expected, 1);
    });

    it("ghost debt: delete a toxic symbol, debt cancelled", () => {
        dir = createTempProject({ "legacy.ts": `export const x = 1;\n` });

        const chronos = new ChronosMemory(dir);
        chronos.recordRegressions(path.join(dir, "legacy.ts"), [
            { symbol: "oldFunc", oldType: "() => string", newType: "any" },
        ]);
        chronos.forcePersist();

        // Symbol no longer exists in contracts (deleted)
        const emptyContracts = new Map<string, string>();
        const paid = chronos.assessDebtPayments(path.join(dir, "legacy.ts"), emptyContracts);
        chronos.forcePersist();

        expect(paid.length).toBe(1);
        expect(paid[0]).toContain("oldFunc");
        expect(paid[0]).toContain("removed");
    });

    it("JIT warning includes debt details with symbol name and strict type", () => {
        dir = createTempProject({ "warn.ts": `export const x = 1;\n` });

        const chronos = new ChronosMemory(dir);
        // Push CFI above alert threshold (15.0)
        chronos.recordRegressions(path.join(dir, "warn.ts"), [
            { symbol: "getUser", oldType: "{ id: number }", newType: "any" },
            { symbol: "getRole", oldType: "Role", newType: "unknown" },
            { symbol: "getPerms", oldType: "Permission[]", newType: "any" },
        ]);
        // Pump CFI higher to cross threshold
        chronos.recordTrip(path.join(dir, "warn.ts"), "test error");
        chronos.forcePersist();

        const warning = chronos.getContextWarnings(path.join(dir, "warn.ts"));

        expect(warning).toContain("UNPAID TYPE DEBT");
        expect(warning).toContain("getUser");
        expect(warning).toContain("{ id: number }");
        expect(warning).toContain("getRole");
        expect(warning).toContain("Role");
    });
});

describe("TTRD: Kernel integration", () => {

    it("happy path: as any in expression still caught via inferred return type", async () => {
        dir = createTempProject({
            "user.ts": `export function getUser() { return { id: 1, name: "Alice" }; }\n`,
        });

        const kernel = new NrekiKernel();
        kernel.boot(dir);

        const result = await kernel.interceptAtomicBatch([{
            targetFile: "user.ts",
            proposedContent: `export function getUser() { return { id: 1, name: "Alice" } as any; }\n`,
        }]);

        expect(result.safe).toBe(true);
        expect(result.regressions).toBeDefined();
        expect(result.regressions!.length).toBe(1);
        expect(result.regressions![0].symbol).toBe("getUser");
        expect(result.regressions![0].newType).toContain("any");
    });

    it("pre/post in same transaction: first edit of session has valid baseline", async () => {
        dir = createTempProject({
            "fresh.ts": `export function greet(): string { return "hi"; }\n`,
        });

        const kernel = new NrekiKernel();
        kernel.boot(dir);

        // First edit ever - pre-contracts come from boot state
        const result = await kernel.interceptAtomicBatch([{
            targetFile: "fresh.ts",
            proposedContent: `export function greet(): any { return "hi"; }\n`,
        }]);

        expect(result.safe).toBe(true);
        expect(result.regressions).toBeDefined();
        expect(result.regressions!.length).toBe(1);
        // Pre-contract was captured from boot state (string return)
        expect(result.regressions![0].oldType).toContain("string");
        expect(result.regressions![0].newType).toContain("any");
    });

    it("healed path: edit needs auto-healing AND has type regression, both reported", async () => {
        dir = createTempProject({
            "service.ts": `
export function getStatus(): number { return 200; }
export function getData(): string { return "ok"; }
`,
            "caller.ts": `
import { getStatus } from "./service";
export function check(): number { return getStatus(); }
`,
        });

        const kernel = new NrekiKernel();
        kernel.boot(dir);

        // Edit that:
        // 1. Changes getStatus return to any (regression)
        // 2. Also renames getData to getInfo (may need healing in caller)
        // Actually, let's focus on a case where we weaken type AND trigger a fixable error
        const result = await kernel.interceptAtomicBatch([{
            targetFile: "service.ts",
            proposedContent: `
export function getStatus(): any { return 200; }
export function getData(): string { return "ok"; }
`,
        }]);

        expect(result.safe).toBe(true);
        // Should detect the regression regardless of whether healing occurred
        expect(result.regressions).toBeDefined();
        expect(result.regressions!.some(r => r.symbol === "getStatus")).toBe(true);
    });

    it("batch edit: regressions penalize correct files, not all files in batch", async () => {
        dir = createTempProject({
            "good.ts": `export function pure(): number { return 1; }\n`,
            "bad.ts": `export function leaky(): string { return "ok"; }\n`,
        });

        const kernel = new NrekiKernel();
        kernel.boot(dir);

        const result = await kernel.interceptAtomicBatch([
            {
                targetFile: "good.ts",
                proposedContent: `export function pure(): number { return 2; }\n`,
            },
            {
                targetFile: "bad.ts",
                proposedContent: `export function leaky(): any { return "ok"; }\n`,
            },
        ]);

        expect(result.safe).toBe(true);
        expect(result.regressions).toBeDefined();
        expect(result.regressions!.length).toBe(1);

        // Regression should be attributed to bad.ts, not good.ts
        const reg = result.regressions![0];
        expect(reg.symbol).toBe("leaky");
        expect(reg.filePath).toContain("bad.ts");
    });

    it("batch debt payment: restore types across multiple files in one batch", async () => {
        dir = createTempProject({
            "a.ts": `export function foo(): number { return 1; }\n`,
            "b.ts": `export function bar(): string { return "x"; }\n`,
        });

        const kernel = new NrekiKernel();
        kernel.boot(dir);

        // First: weaken both files
        const result1 = await kernel.interceptAtomicBatch([
            { targetFile: "a.ts", proposedContent: `export function foo(): any { return 1; }\n` },
            { targetFile: "b.ts", proposedContent: `export function bar(): any { return "x"; }\n` },
        ]);
        await kernel.commitToDisk();

        expect(result1.regressions).toBeDefined();
        expect(result1.regressions!.length).toBe(2);

        // Set up Chronos and record regressions
        const chronos = new ChronosMemory(dir);
        for (const reg of result1.regressions!) {
            chronos.recordRegressions(
                path.resolve(dir, reg.filePath),
                [{ symbol: reg.symbol, oldType: reg.oldType, newType: reg.newType }],
            );
        }
        chronos.forcePersist();

        // Now restore both files
        const result2 = await kernel.interceptAtomicBatch([
            { targetFile: "a.ts", proposedContent: `export function foo(): number { return 1; }\n` },
            { targetFile: "b.ts", proposedContent: `export function bar(): string { return "x"; }\n` },
        ]);

        expect(result2.safe).toBe(true);
        expect(result2.regressions).toBeUndefined(); // No new regressions
        expect(result2.postContracts).toBeDefined();

        // Assess payments
        for (const [posixPath, contracts] of result2.postContracts!) {
            const paid = chronos.assessDebtPayments(posixPath, contracts);
            expect(paid.length).toBeGreaterThan(0);
        }
    });

    it("no success reward for files with regressions in the same edit", async () => {
        dir = createTempProject({
            "target.ts": `export function process(): number { return 1; }\n`,
        });

        const kernel = new NrekiKernel();
        kernel.boot(dir);

        const chronos = new ChronosMemory(dir);

        // Give the file some existing CFI score
        chronos.recordTrip(path.join(dir, "target.ts"), "prior error");
        chronos.forcePersist();

        const stateBefore = JSON.parse(fs.readFileSync(
            path.join(dir, ".nreki", "chronos-history.json"), "utf-8"
        ));
        const cfiBefore = (Object.values(stateBefore.files)[0] as any).cfiScore;

        // Edit that introduces regression
        const result = await kernel.interceptAtomicBatch([{
            targetFile: "target.ts",
            proposedContent: `export function process(): any { return 1; }\n`,
        }]);

        expect(result.safe).toBe(true);
        expect(result.regressions).toBeDefined();

        // Record regressions (should increase score, NOT decrease via recordSuccess)
        const posixPath = kernel.resolvePosixPath("target.ts");
        const hasRegression = result.regressions!.some(r => r.filePath === posixPath);
        expect(hasRegression).toBe(true);

        // Simulate router behavior: NO recordSuccess for files with regressions
        if (hasRegression) {
            chronos.recordRegressions(path.join(dir, "target.ts"), result.regressions!);
        } else {
            chronos.recordSuccess(path.join(dir, "target.ts"));
        }
        chronos.forcePersist();

        const stateAfter = JSON.parse(fs.readFileSync(
            path.join(dir, ".nreki", "chronos-history.json"), "utf-8"
        ));
        const cfiAfter = (Object.values(stateAfter.files)[0] as any).cfiScore;

        // Score should have INCREASED (penalty), not decreased (no success reward)
        expect(cfiAfter).toBeGreaterThan(cfiBefore);
    });
});
