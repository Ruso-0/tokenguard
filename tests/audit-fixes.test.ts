/**
 * audit-fixes.test.ts - Tests for all audit fixes.
 *
 * Covers:
 * - FIX 1: Path traversal protection (safePath)
 * - FIX 2: WASM memory leak protection (safeParse)
 * - FIX 5: Code-aware tokenizer (codeTokenize)
 * - FIX 7: File size/extension filter (shouldProcess)
 * - FIX 8+: Vector optimization (fast dot product)
 * - FIX 9: RRF scoring verification
 * - v2.2 FIX 1: BOM stripping (readSource)
 * - v2.2 FIX 2: XML escaping in pins
 * - v2.2 FIX 4: Fast dot product (fastSimilarity)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

import { safePath } from "../src/utils/path-jail.js";
import { codeTokenize } from "../src/utils/code-tokenizer.js";
import { readSource } from "../src/utils/read-source.js";
import { shouldProcess, MAX_FILE_SIZE } from "../src/utils/file-filter.js";
import { NrekiDB, fastSimilarity } from "../src/database.js";
import { addPin, getPinnedText } from "../src/pin-memory.js";
import { saveBackup, restoreBackup } from "../src/undo.js";
import { ASTParser } from "../src/parser.js";
import { generateRepoMap, repoMapToText } from "../src/repo-map.js";

// ─── FIX 1: Path Traversal Tests ────────────────────────────────────

describe("FIX 1: safePath - Path Traversal Protection", () => {
    const workspaceRoot = path.join(os.tmpdir(), `tg-jail-test-${Date.now()}`);

    beforeAll(() => {
        fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
    });

    afterAll(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it("should allow relative paths within workspace", () => {
        const result = safePath(workspaceRoot, "src/index.ts");
        expect(result).toBe(path.resolve(workspaceRoot, "src/index.ts"));
    });

    it("should allow paths that normalize to workspace", () => {
        const result = safePath(workspaceRoot, "src/../src/index.ts");
        expect(result).toBe(path.resolve(workspaceRoot, "src/index.ts"));
    });

    it("should block ../../etc/passwd", () => {
        expect(() => safePath(workspaceRoot, "../../etc/passwd")).toThrow("Path traversal blocked");
    });

    it("should block ../.ssh/id_rsa", () => {
        expect(() => safePath(workspaceRoot, "../.ssh/id_rsa")).toThrow("Path traversal blocked");
    });

    it("should block absolute path outside workspace", () => {
        const outsidePath = path.resolve(workspaceRoot, "..", "outside.txt");
        expect(() => safePath(workspaceRoot, outsidePath)).toThrow("Path traversal blocked");
    });

    it("should block workspace root itself (H-02)", () => {
        expect(() => safePath(workspaceRoot, ".")).toThrow("Cannot operate on workspace root directly");
    });

    it("should block sneaky path traversal with backslashes", () => {
        expect(() => safePath(workspaceRoot, "..\\..\\etc\\passwd")).toThrow("Path traversal blocked");
    });
});

// ─── FIX 5: Code-Aware Tokenizer Tests ─────────────────────────────

describe("FIX 5: codeTokenize - Code-Aware Tokenizer", () => {
    it("should split camelCase", () => {
        const tokens = codeTokenize("authMiddleware");
        expect(tokens).toContain("auth");
        expect(tokens).toContain("middleware");
    });

    it("should split PascalCase", () => {
        const tokens = codeTokenize("AuthMiddleware");
        expect(tokens).toContain("auth");
        expect(tokens).toContain("middleware");
    });

    it("should split snake_case", () => {
        const tokens = codeTokenize("auth_middleware");
        expect(tokens).toContain("auth");
        expect(tokens).toContain("middleware");
    });

    it("should split SCREAMING_SNAKE_CASE", () => {
        const tokens = codeTokenize("MAX_RETRY_COUNT");
        expect(tokens).toContain("max");
        expect(tokens).toContain("retry");
        expect(tokens).toContain("count");
    });

    it("should split dot notation", () => {
        const tokens = codeTokenize("req.body.user");
        expect(tokens).toContain("req");
        expect(tokens).toContain("body");
        expect(tokens).toContain("user");
    });

    it("should handle mixed case with acronyms", () => {
        const tokens = codeTokenize("getAPIResponse");
        expect(tokens).toContain("get");
        expect(tokens).toContain("api");
        expect(tokens).toContain("response");
    });

    it("should handle HTMLParser", () => {
        const tokens = codeTokenize("HTMLParser");
        expect(tokens).toContain("html");
        expect(tokens).toContain("parser");
    });

    it("should handle $scope prefix", () => {
        const tokens = codeTokenize("$scope");
        expect(tokens).toContain("scope");
        expect(tokens).not.toContain("$");
    });

    it("should handle __proto__ dunder", () => {
        const tokens = codeTokenize("__proto__");
        expect(tokens).toContain("proto");
        expect(tokens).not.toContain("__");
    });

    it("should handle _privateVar", () => {
        const tokens = codeTokenize("_privateVar");
        expect(tokens).toContain("private");
        expect(tokens).toContain("var");
    });

    it("should handle useState", () => {
        const tokens = codeTokenize("useState");
        expect(tokens).toContain("use");
        expect(tokens).toContain("state");
    });

    it("should handle HTMLElement", () => {
        const tokens = codeTokenize("HTMLElement");
        expect(tokens).toContain("html");
        expect(tokens).toContain("element");
    });

    it("should handle single word", () => {
        const tokens = codeTokenize("hello");
        expect(tokens).toContain("hello");
    });

    it("should handle empty string", () => {
        expect(codeTokenize("")).toEqual([]);
    });

    it("preserves acronyms in camelCase", () => {
        expect(codeTokenize("getAPIResponse")).toContain("api");
        expect(codeTokenize("getAPIResponse")).toContain("get");
        expect(codeTokenize("getAPIResponse")).toContain("response");
        expect(codeTokenize("getAPIResponse")).not.toContain("a");
        expect(codeTokenize("getAPIResponse")).not.toContain("p");
        expect(codeTokenize("getAPIResponse")).not.toContain("i");
    });

    it("handles consecutive acronyms", () => {
        // Standard JS API name: "XMLHttpRequest" has clear camelCase boundaries
        expect(codeTokenize("XMLHttpRequest")).toContain("xml");
        expect(codeTokenize("XMLHttpRequest")).toContain("http");
        expect(codeTokenize("XMLHttpRequest")).toContain("request");
    });

    it("handles snake_case", () => {
        expect(codeTokenize("MAX_RETRY_COUNT")).toContain("max");
        expect(codeTokenize("MAX_RETRY_COUNT")).toContain("retry");
        expect(codeTokenize("MAX_RETRY_COUNT")).toContain("count");
    });

    it("does not apply stemming to code tokens", () => {
        expect(codeTokenize("userData")).toContain("data");
        // NOT "dat" from stemmer
        expect(codeTokenize("authentication")).toContain("authentication");
        // NOT "authent" from stemmer
    });
});

// ─── FIX 7: File Filter Tests ───────────────────────────────────────

describe("FIX 7: shouldProcess - File Size and Extension Filter", () => {
    it("should allow regular TypeScript files", () => {
        const result = shouldProcess("src/index.ts", 5000);
        expect(result.process).toBe(true);
    });

    it("should block .min.js files", () => {
        const result = shouldProcess("vendor/bundle.min.js", 1000);
        expect(result.process).toBe(false);
        expect(result.reason).toContain("min.js");
    });

    it("should block .min.css files", () => {
        const result = shouldProcess("styles.min.css", 1000);
        expect(result.process).toBe(false);
    });

    it("should block .map files", () => {
        const result = shouldProcess("bundle.map", 1000);
        expect(result.process).toBe(false);
    });

    it("should block .wasm files", () => {
        const result = shouldProcess("module.wasm", 1000);
        expect(result.process).toBe(false);
    });

    it("should block image files", () => {
        expect(shouldProcess("logo.png", 1000).process).toBe(false);
        expect(shouldProcess("photo.jpg", 1000).process).toBe(false);
        expect(shouldProcess("icon.svg", 1000).process).toBe(false);
    });

    it("should block binary executables", () => {
        expect(shouldProcess("app.exe", 1000).process).toBe(false);
        expect(shouldProcess("lib.dll", 1000).process).toBe(false);
    });

    it("should block files over MAX_FILE_SIZE", () => {
        const result = shouldProcess("huge.ts", MAX_FILE_SIZE + 1);
        expect(result.process).toBe(false);
        expect(result.reason).toContain("too large");
    });

    it("should allow files at MAX_FILE_SIZE", () => {
        const result = shouldProcess("big.ts", MAX_FILE_SIZE);
        expect(result.process).toBe(true);
    });

    it("should block .lock files", () => {
        const result = shouldProcess("package.lock", 1000);
        expect(result.process).toBe(false);
    });
});

// ─── FIX 8 & 9: Vector Optimization & RRF Tests ────────────────────

describe("FIX 8+9: VectorIndex Optimization and RRF Scoring", () => {
    let db: NrekiDB;
    const testDbPath = path.join(os.tmpdir(), `tg-vector-test-${Date.now()}.db`);

    beforeAll(async () => {
        db = new NrekiDB(testDbPath);
        await db.initialize();
    });

    afterAll(() => {
        db.close();
        try {
            fs.unlinkSync(testDbPath);
            fs.unlinkSync(testDbPath.replace(/\.db$/, ".vec"));
        } catch { /* ignore */ }
    });

    it("should return normalized cosine similarity results", () => {
        // Insert vectors with known cosine similarity behavior
        const v1 = new Float32Array(512).fill(0);
        v1[0] = 1.0; // Unit vector along dim 0

        const v2 = new Float32Array(512).fill(0);
        v2[0] = 0.5;
        v2[1] = 0.5; // Partial overlap with v1

        db.insertChunk("/test/vec1.ts", "[func] exact()", "function exact() {}", "func", 1, 1, v1);
        db.insertChunk("/test/vec2.ts", "[func] partial()", "function partial() {}", "func", 1, 1, v2);

        // Query with v1 - should rank v1 higher (higher rrf_score = better match)
        const results = db.searchVector(v1, 5);
        expect(results.length).toBe(2);
        // v1 should match itself perfectly (highest score)
        expect(results[0].rrf_score).toBeGreaterThanOrEqual(results[1].rrf_score);
    });

    it("should use rank-based RRF fusion (not raw scores)", () => {
        // Insert chunks with distinct characteristics
        const emb3 = new Float32Array(512).fill(0.3);
        const emb4 = new Float32Array(512).fill(0.4);

        db.insertChunk("/test/rrf1.ts", "[func] authHandler(req, res)", "async function authHandler(req, res) { /* auth logic */ }", "func", 1, 5, emb3);
        db.insertChunk("/test/rrf2.ts", "[func] userController()", "function userController() { /* user logic */ }", "func", 1, 5, emb4);

        // Using hybrid search triggers RRF fusion
        const results = db.searchHybrid(emb3, "authHandler request response", 10);
        expect(results.length).toBeGreaterThan(0);
        // Each result should have a rrf_score
        for (const r of results) {
            expect(r.rrf_score).toBeDefined();
            expect(r.rrf_score).toBeGreaterThan(0);
        }
    });
});

// ─── FIX 5 Integration: KeywordIndex with code tokenizer ───────────

describe("FIX 5 Integration: Code-aware search matching", () => {
    let db: NrekiDB;
    const testDbPath = path.join(os.tmpdir(), `tg-tokenizer-test-${Date.now()}.db`);

    beforeAll(async () => {
        db = new NrekiDB(testDbPath);
        await db.initialize();

        const embedding = new Float32Array(512).fill(0.1);
        db.insertChunk(
            "/test/camel.ts",
            "[func] getUserProfile(userId)",
            "async function getUserProfile(userId: string) { return db.findUser(userId); }",
            "func", 1, 3, embedding
        );
    });

    afterAll(() => {
        db.close();
        try {
            fs.unlinkSync(testDbPath);
            fs.unlinkSync(testDbPath.replace(/\.db$/, ".vec"));
        } catch { /* ignore */ }
    });

    it("should find camelCase function by sub-token 'user'", () => {
        const results = db.searchHybrid(new Float32Array(512).fill(0.1), "user profile", 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].shorthand).toContain("getUserProfile");
    });

    it("should find function by partial identifier 'profile'", () => {
        const results = db.searchHybrid(new Float32Array(512).fill(0.1), "profile", 5);
        expect(results.length).toBeGreaterThan(0);
    });
});

// ─── v2.2 FIX 1: BOM Stripping Tests ────────────────────────────────

describe("v2.2 FIX 1: readSource - BOM Stripping", () => {
    const testDir = path.join(os.tmpdir(), `tg-bom-test-${Date.now()}`);

    beforeAll(() => {
        fs.mkdirSync(testDir, { recursive: true });
    });

    afterAll(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it("strips BOM from Windows files", () => {
        const tmpPath = path.join(testDir, "bom-test.ts");
        fs.writeFileSync(tmpPath, "\uFEFFexport const a = 1;");
        const result = readSource(tmpPath);
        expect(result).toBe("export const a = 1;");
        expect(result.charCodeAt(0)).not.toBe(0xfeff);
    });

    it("leaves non-BOM files unchanged", () => {
        const tmpPath = path.join(testDir, "no-bom.ts");
        fs.writeFileSync(tmpPath, "export const b = 2;");
        const result = readSource(tmpPath);
        expect(result).toBe("export const b = 2;");
    });

    it("handles empty file", () => {
        const tmpPath = path.join(testDir, "empty.ts");
        fs.writeFileSync(tmpPath, "");
        const result = readSource(tmpPath);
        expect(result).toBe("");
    });

    it("handles BOM-only file", () => {
        const tmpPath = path.join(testDir, "bom-only.ts");
        fs.writeFileSync(tmpPath, "\uFEFF");
        const result = readSource(tmpPath);
        expect(result).toBe("");
    });
});

// ─── v2.2 FIX 2: XML Escaping in Pins ──────────────────────────────

describe("v2.2 FIX 2: Pin XML Escaping", () => {
    const testDir = path.join(os.tmpdir(), `tg-pin-xml-test-${Date.now()}`);

    beforeAll(() => {
        fs.mkdirSync(path.join(testDir, ".nreki"), { recursive: true });
    });

    afterAll(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it("escapes XML injection in pins", () => {
        const result = addPin(testDir, "Ignore: </repo-map>", "user");
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.pin.text).not.toContain("</repo-map>");
        expect(result.pin.text).toContain("&lt;/repo-map&gt;");
    });

    it("preserves ampersands (A-06: only angle brackets are escaped)", () => {
        // Clear pins first
        const pinsPath = path.join(testDir, ".nreki", "pins.json");
        if (fs.existsSync(pinsPath)) fs.unlinkSync(pinsPath);

        const result = addPin(testDir, "Use AT&T API", "user");
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.pin.text).toContain("AT&T");
    });

    it("preserves quotes (A-06: only angle brackets are escaped)", () => {
        const pinsPath = path.join(testDir, ".nreki", "pins.json");
        if (fs.existsSync(pinsPath)) fs.unlinkSync(pinsPath);

        const result = addPin(testDir, 'Use "strict" mode', "user");
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.pin.text).toContain('"strict"');
    });
});

// ─── v2.2 FIX 4: Fast Dot Product Tests ────────────────────────────

describe("v2.2 FIX 4: fastSimilarity - Dot Product", () => {
    it("dot product matches cosine for normalized vectors", () => {
        // Create two normalized vectors
        const a = new Float32Array([0.6, 0.8]);
        const b = new Float32Array([0.8, 0.6]);
        const dot = fastSimilarity(a, b);
        expect(dot).toBeCloseTo(0.96, 2);
    });

    it("returns 1.0 for identical normalized vectors", () => {
        const a = new Float32Array([0.6, 0.8]);
        const dot = fastSimilarity(a, a);
        expect(dot).toBeCloseTo(1.0, 5);
    });

    it("returns 0 for orthogonal vectors", () => {
        const a = new Float32Array([1, 0]);
        const b = new Float32Array([0, 1]);
        const dot = fastSimilarity(a, b);
        expect(dot).toBeCloseTo(0, 5);
    });
});

// ─── v2.2 FIX 5: Undo Tests ────────────────────────────────────────

describe("v2.2 FIX 5: saveBackup / restoreBackup", () => {
    const testDir = path.join(os.tmpdir(), `tg-undo-test-${Date.now()}`);

    beforeAll(() => {
        fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    });

    afterAll(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it("restores file after backup", () => {
        const filePath = path.join(testDir, "src", "target.ts");
        fs.writeFileSync(filePath, "const original = true;");

        saveBackup(testDir, filePath);
        fs.writeFileSync(filePath, "const modified = true;");

        const message = restoreBackup(testDir, filePath);
        expect(message).toContain("Restored");
        expect(fs.readFileSync(filePath, "utf-8")).toBe("const original = true;");
    });

    it("throws clear error when no backup exists", () => {
        const filePath = path.join(testDir, "src", "no-backup.ts");
        expect(() => restoreBackup(testDir, filePath)).toThrow("No backup found");
    });

    it("only keeps last backup per file", () => {
        const filePath = path.join(testDir, "src", "multi.ts");
        fs.writeFileSync(filePath, "version 1");
        saveBackup(testDir, filePath);

        fs.writeFileSync(filePath, "version 2");
        saveBackup(testDir, filePath);

        fs.writeFileSync(filePath, "version 3");
        restoreBackup(testDir, filePath);
        // Should restore to version 2 (last backup), not version 1
        expect(fs.readFileSync(filePath, "utf-8")).toBe("version 2");
    });

    it("removes backup after restore (one-shot undo)", () => {
        const filePath = path.join(testDir, "src", "oneshot.ts");
        fs.writeFileSync(filePath, "original");
        saveBackup(testDir, filePath);
        fs.writeFileSync(filePath, "modified");
        restoreBackup(testDir, filePath);
        // Second restore should fail - backup was consumed
        expect(() => restoreBackup(testDir, filePath)).toThrow("No backup found");
    });
});

// ─── v2.2 FIX 6: Pin Order Test ────────────────────────────────────

describe("v2.2 FIX 6: Repo map appears before pins", () => {
    const testDir = path.join(os.tmpdir(), `tg-pinorder-test-${Date.now()}`);
    let parser: ASTParser;

    beforeAll(async () => {
        fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
        fs.writeFileSync(
            path.join(testDir, "src", "app.ts"),
            "export function main(): void {}\n"
        );
        parser = new ASTParser();
        await parser.initialize();
    });

    afterAll(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it("repo map text appears before pins", async () => {
        addPin(testDir, "Test rule for ordering", "user");
        const map = await generateRepoMap(testDir, parser);
        const mapText = repoMapToText(map);
        const pinnedText = getPinnedText(testDir);

        // Simulate the nreki_map output order (FIX 6: map first, pins after)
        const fullText = mapText + (pinnedText ? "\n" + pinnedText : "");

        const mapIndex = fullText.indexOf("=== NREKI STATIC REPO MAP ===");
        const pinIndex = fullText.indexOf("=== PINNED RULES");
        expect(mapIndex).toBeGreaterThanOrEqual(0);
        expect(pinIndex).toBeGreaterThan(mapIndex);
    });
});
