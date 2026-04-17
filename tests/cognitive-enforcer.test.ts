/**
 * Patch 1 — batch_edit bypass fix.
 *
 * Pre-fix: `evaluate()` only validated batches where length === 1.
 * Any batch of 2+ edits bypassed the cognitive firewall because
 * execution fell through to the unconditional `return { blocked: false }`.
 * An agent could send "1 real blind edit + 1 dummy" to smuggle in blind edits.
 *
 * Post-fix: every edit in the batch is validated independently via
 * `validateSingleBatchEdit`. Any single blind edit blocks the whole batch.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CognitiveEnforcer } from "../src/hooks/cognitive-enforcer.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("CognitiveEnforcer — Patch 1 (batch_edit validates every edit)", () => {
    let tmpDir: string;
    let enforcer: CognitiveEnforcer;
    const largeFilePath = "big.ts";
    const smallFilePath = "small.ts";

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-enforcer-"));
        fs.writeFileSync(path.join(tmpDir, largeFilePath), "x".repeat(200_000), "utf-8");
        fs.writeFileSync(path.join(tmpDir, smallFilePath), "x".repeat(10_000), "utf-8");
        enforcer = new CognitiveEnforcer(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("blocks batch_edit with 2 blind replace-mode edits on a large file", () => {
        const result = enforcer.evaluate("nreki_code", "batch_edit", {
            edits: [
                { path: largeFilePath, symbol: "foo" },
                { path: largeFilePath, symbol: "bar" },
            ],
        });
        expect(result.blocked).toBe(true);
        expect(result.errorText).toContain("Blind batch_edit");
    });

    it("blocks batch_edit when ANY edit is blind, even if others are legitimate", () => {
        enforcer.registerSuccess("nreki_code", "compress", { path: largeFilePath, focus: "foo" });
        const result = enforcer.evaluate("nreki_code", "batch_edit", {
            edits: [
                { path: largeFilePath, symbol: "foo" },
                { path: largeFilePath, symbol: "uninspected" },
            ],
        });
        expect(result.blocked).toBe(true);
        expect(result.errorText).toContain("uninspected");
    });

    it("passes batch_edit where all edits use patch mode (patch is self-guarded)", () => {
        const result = enforcer.evaluate("nreki_code", "batch_edit", {
            edits: [
                { path: largeFilePath, symbol: "foo", mode: "patch" },
                { path: largeFilePath, symbol: "bar", mode: "patch" },
            ],
        });
        expect(result.blocked).toBe(false);
    });

    it("passes batch_edit on small files regardless of passport state", () => {
        const result = enforcer.evaluate("nreki_code", "batch_edit", {
            edits: [
                { path: smallFilePath, symbol: "foo", mode: "insert_after" },
                { path: smallFilePath, symbol: "bar", mode: "insert_after" },
            ],
        });
        expect(result.blocked).toBe(false);
    });

    it("passes batch_edit where every edit has a valid passport", () => {
        enforcer.registerSuccess("nreki_code", "compress", { path: largeFilePath, focus: "foo" });
        enforcer.registerSuccess("nreki_code", "compress", { path: largeFilePath, focus: "bar" });
        const result = enforcer.evaluate("nreki_code", "batch_edit", {
            edits: [
                { path: largeFilePath, symbol: "foo" },
                { path: largeFilePath, symbol: "bar" },
            ],
        });
        expect(result.blocked).toBe(false);
    });

    it("blocks single-edit batch if the edit is blind (regression — original behavior preserved)", () => {
        const result = enforcer.evaluate("nreki_code", "batch_edit", {
            edits: [{ path: largeFilePath, symbol: "foo" }],
        });
        expect(result.blocked).toBe(true);
    });

    it("blocks blind insert on large file even when mixed with a legitimate patch edit", () => {
        const result = enforcer.evaluate("nreki_code", "batch_edit", {
            edits: [
                { path: largeFilePath, symbol: "foo", mode: "patch" },
                { path: largeFilePath, symbol: "bar", mode: "insert_after" },
            ],
        });
        expect(result.blocked).toBe(true);
        expect(result.errorText).toContain("Blind insert");
    });
});
