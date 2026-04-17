/**
 * Patch 3 — saveBackup OOM guard.
 *
 * Pre-fix: saveBackup called fs.readFileSync(path, "utf-8") BEFORE the
 * null-byte check. A misdirected 2GB binary file was loaded into the V8
 * heap as a UTF-8 string before being tested for binary-ness, crashing
 * the MCP server with "Allocation failed - JavaScript heap out of memory".
 *
 * Post-fix: open FD, stat, reject > 100MB, probe first 8KB for null bytes,
 * then (and only then) call readFileSync.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { saveBackup, getBackupPath, restoreBackup } from "../src/undo.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("saveBackup — OOM guard (Patch 3)", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-undo-"));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("refuses binary files without loading them into memory", () => {
        const binaryFile = path.join(tmpDir, "bin.dat");
        const buf = Buffer.alloc(1024 * 1024, 0x41); // 1MB of 'A'
        buf[50] = 0x00; // null byte in the first 8KB
        fs.writeFileSync(binaryFile, buf);

        expect(() => saveBackup(tmpDir, "bin.dat")).not.toThrow();
        expect(fs.existsSync(getBackupPath(tmpDir, "bin.dat"))).toBe(false);
    });

    it("refuses files > 100MB without loading them (synthetic via truncate)", () => {
        const bigFile = path.join(tmpDir, "big.log");
        const fd = fs.openSync(bigFile, "w");
        try {
            fs.ftruncateSync(fd, 150 * 1024 * 1024); // 150MB sparse file
        } finally {
            fs.closeSync(fd);
        }

        const before = process.memoryUsage().heapUsed;
        expect(() => saveBackup(tmpDir, "big.log")).not.toThrow();
        const after = process.memoryUsage().heapUsed;

        expect(fs.existsSync(getBackupPath(tmpDir, "big.log"))).toBe(false);
        // Heap delta should be tiny — nowhere near 150MB.
        // If we accidentally loaded the file, delta would be >100MB.
        expect(after - before).toBeLessThan(50 * 1024 * 1024);
    });

    it("backs up a normal text file correctly (regression)", () => {
        const codeFile = path.join(tmpDir, "code.ts");
        const original = "const x = 42;\n".repeat(1000);
        fs.writeFileSync(codeFile, original, "utf-8");

        saveBackup(tmpDir, "code.ts");

        const backupPath = getBackupPath(tmpDir, "code.ts");
        expect(fs.existsSync(backupPath)).toBe(true);
        expect(fs.readFileSync(backupPath, "utf-8")).toBe(original);
    });

    it("handles empty files without throwing (probeSize === 0 branch)", () => {
        const emptyFile = path.join(tmpDir, "empty.ts");
        fs.writeFileSync(emptyFile, "", "utf-8");

        expect(() => saveBackup(tmpDir, "empty.ts")).not.toThrow();
        const backupPath = getBackupPath(tmpDir, "empty.ts");
        expect(fs.existsSync(backupPath)).toBe(true);
        expect(fs.readFileSync(backupPath, "utf-8")).toBe("");
    });

    it("silently returns when the target file does not exist (no throw)", () => {
        expect(() => saveBackup(tmpDir, "missing.ts")).not.toThrow();
        expect(fs.existsSync(getBackupPath(tmpDir, "missing.ts"))).toBe(false);
    });

    it("round-trip: save + restore a code file yields identical content", () => {
        const file = path.join(tmpDir, "roundtrip.ts");
        const original = "export function f() { return 'original'; }\n";
        fs.writeFileSync(file, original, "utf-8");

        saveBackup(tmpDir, "roundtrip.ts");
        fs.writeFileSync(file, "export function f() { return 'modified'; }\n", "utf-8");
        restoreBackup(tmpDir, "roundtrip.ts");

        expect(fs.readFileSync(file, "utf-8")).toBe(original);
    });
});
