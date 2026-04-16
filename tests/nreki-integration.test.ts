import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import { semanticEdit, batchSemanticEdit } from "../src/semantic-edit.js";

function createTempProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-integ-"));
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "ES2022", module: "Node16", moduleResolution: "Node16",
            strict: true, esModuleInterop: true, outDir: "dist", rootDir: ".", skipLibCheck: true,
        },
        include: ["./**/*.ts"], exclude: ["node_modules", "dist"],
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
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

describe("NREKI Integration - Full Zero-Disk-Touch Path", () => {
    let dir: string;
    let kernel: NrekiKernel;

    beforeEach(() => {
        dir = createTempProject({
            "auth.ts": 'export function getUserId(): number { return 1; }\nexport function getName(): string { return "test"; }',
            "billing.ts": 'import { getUserId } from "./auth";\nconst id: number = getUserId();\nexport function charge(): number { return id * 100; }',
        });
        kernel = new NrekiKernel();
        kernel.boot(dir);
    });

    afterEach(() => {
        cleanupTempProject(dir);
    });

    it("F1: dryRun=true should NOT write to disk", async () => {
        const sandbox = new AstSandbox();
        await sandbox.initialize();
        const filePath = path.join(dir, "auth.ts");
        const original = fs.readFileSync(filePath, "utf-8");

        const { ASTParser } = await import("../src/parser.js");
        const parser = new ASTParser();
        await parser.initialize();

        const result = await semanticEdit(
            filePath, "getUserId",
            'export function getUserId(): number { return 42; }',
            parser, sandbox, dir, "replace",
            true // dryRun
        );

        expect(result.success).toBe(true);
        expect(result.newContent).toBeDefined();
        expect(result.newContent).toContain("return 42");

        // CRITICAL: File on disk must be UNCHANGED
        const afterDisk = fs.readFileSync(filePath, "utf-8");
        expect(afterDisk).toBe(original);
    });

    it("F1: full path - valid edit through kernel to commitToDisk", async () => {
        const filePath = path.join(dir, "auth.ts");

        const newContent = 'export function getUserId(): number { return 42; }\nexport function getName(): string { return "test"; }';
        const result = await kernel.interceptAtomicBatch([
            { targetFile: filePath, proposedContent: newContent },
        ]);

        expect(result.safe).toBe(true);

        await kernel.commitToDisk();

        const afterDisk = fs.readFileSync(filePath, "utf-8");
        expect(afterDisk).toContain("return 42");
    });

    it("F1: full path - type-breaking edit blocked, disk untouched", async () => {
        const filePath = path.join(dir, "auth.ts");
        const original = fs.readFileSync(filePath, "utf-8");

        // Break the return type: number → string (billing.ts expects number)
        const brokenContent = original.replace(
            'export function getUserId(): number { return 1; }',
            'export function getUserId(): string { return "bad"; }'
        );

        const result = await kernel.interceptAtomicBatch([
            { targetFile: filePath, proposedContent: brokenContent },
        ]);

        expect(result.safe).toBe(false);
        expect(result.structured).toBeDefined();
        expect(result.structured!.length).toBeGreaterThan(0);

        await kernel.rollbackAll();

        // CRITICAL: Disk must be UNCHANGED
        const afterDisk = fs.readFileSync(filePath, "utf-8");
        expect(afterDisk).toBe(original);
    });

    it("F1: batch dryRun returns VFS without writing", async () => {
        const sandbox = new AstSandbox();
        await sandbox.initialize();
        const { ASTParser } = await import("../src/parser.js");
        const parser = new ASTParser();
        await parser.initialize();

        const authOriginal = fs.readFileSync(path.join(dir, "auth.ts"), "utf-8");

        const result = await batchSemanticEdit(
            [{ path: path.join(dir, "auth.ts"), symbol: "getUserId",
               new_code: 'export function getUserId(): number { return 99; }' }],
            parser, sandbox, dir,
            true // dryRun
        );

        expect(result.success).toBe(true);
        expect(result.vfs).toBeDefined();
        expect(result.vfs!.size).toBeGreaterThan(0);

        // Disk unchanged
        expect(fs.readFileSync(path.join(dir, "auth.ts"), "utf-8")).toBe(authOriginal);
    });

    it("F1: commitToDisk creates atomic write", async () => {
        const filePath = path.join(dir, "auth.ts");

        const newContent = 'export function getUserId(): number { return 999; }\nexport function getName(): string { return "test"; }';
        const result = await kernel.interceptAtomicBatch([
            { targetFile: filePath, proposedContent: newContent },
        ]);

        expect(result.safe).toBe(true);
        await kernel.commitToDisk();

        const disk = fs.readFileSync(filePath, "utf-8");
        expect(disk).toContain("return 999");
    });

    it("F3: kernel rejects path traversal attempts", async () => {
        await expect(
            kernel.interceptAtomicBatch([
                { targetFile: "../../etc/passwd", proposedContent: "pwned" },
            ])
        ).rejects.toThrow();
    });

    it("F3: kernel rejects absolute paths outside project", async () => {
        await expect(
            kernel.interceptAtomicBatch([
                { targetFile: "/etc/shadow", proposedContent: "pwned" },
            ])
        ).rejects.toThrow();
    });
});

describe("NREKI Kernel - Path Normalization", () => {
    it("should normalize Windows-style backslash paths", () => {
        const dir = createTempProject({
            "src/utils/helper.ts": 'export function help(): string { return "ok"; }',
        });
        const kernel = new NrekiKernel();
        kernel.boot(dir);
        expect(kernel.getTrackedFiles()).toBeGreaterThan(0);
        cleanupTempProject(dir);
    });
});
