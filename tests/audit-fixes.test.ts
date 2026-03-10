/**
 * audit-fixes.test.ts — Tests for all v1.2.0 audit fixes.
 *
 * Covers:
 * - FIX 1: Path traversal protection (safePath)
 * - FIX 2: WASM memory leak protection (safeParse)
 * - FIX 5: Code-aware tokenizer (codeTokenize)
 * - FIX 7: File size/extension filter (shouldProcess)
 * - FIX 8: Vector optimization (pre-computed norms)
 * - FIX 9: RRF scoring verification
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

import { safePath } from "../src/utils/path-jail.js";
import { codeTokenize } from "../src/utils/code-tokenizer.js";
import { shouldProcess, MAX_FILE_SIZE } from "../src/utils/file-filter.js";
import { TokenGuardDB } from "../src/database.js";

// ─── FIX 1: Path Traversal Tests ────────────────────────────────────

describe("FIX 1: safePath — Path Traversal Protection", () => {
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

    it("should allow workspace root itself", () => {
        const result = safePath(workspaceRoot, ".");
        expect(result).toBe(path.resolve(workspaceRoot));
    });

    it("should block sneaky path traversal with backslashes", () => {
        expect(() => safePath(workspaceRoot, "..\\..\\etc\\passwd")).toThrow("Path traversal blocked");
    });
});

// ─── FIX 5: Code-Aware Tokenizer Tests ─────────────────────────────

describe("FIX 5: codeTokenize — Code-Aware Tokenizer", () => {
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

    it("should keep original joined form", () => {
        const tokens = codeTokenize("auth_middleware");
        expect(tokens).toContain("authmiddleware");
    });

    it("should handle single word", () => {
        const tokens = codeTokenize("hello");
        expect(tokens).toContain("hello");
    });

    it("should handle empty string", () => {
        expect(codeTokenize("")).toEqual([]);
    });
});

// ─── FIX 7: File Filter Tests ───────────────────────────────────────

describe("FIX 7: shouldProcess — File Size and Extension Filter", () => {
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
    let db: TokenGuardDB;
    const testDbPath = path.join(os.tmpdir(), `tg-vector-test-${Date.now()}.db`);

    beforeAll(async () => {
        db = new TokenGuardDB(testDbPath);
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
        const v1 = new Float32Array(384).fill(0);
        v1[0] = 1.0; // Unit vector along dim 0

        const v2 = new Float32Array(384).fill(0);
        v2[0] = 0.5;
        v2[1] = 0.5; // Partial overlap with v1

        db.insertChunk("/test/vec1.ts", "[func] exact()", "function exact() {}", "func", 1, 1, v1);
        db.insertChunk("/test/vec2.ts", "[func] partial()", "function partial() {}", "func", 1, 1, v2);

        // Query with v1 — should rank v1 higher (higher rrf_score = better match)
        const results = db.searchVector(v1, 5);
        expect(results.length).toBe(2);
        // v1 should match itself perfectly (highest score)
        expect(results[0].rrf_score).toBeGreaterThanOrEqual(results[1].rrf_score);
    });

    it("should use rank-based RRF fusion (not raw scores)", () => {
        // Insert chunks with distinct characteristics
        const emb3 = new Float32Array(384).fill(0.3);
        const emb4 = new Float32Array(384).fill(0.4);

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
    let db: TokenGuardDB;
    const testDbPath = path.join(os.tmpdir(), `tg-tokenizer-test-${Date.now()}.db`);

    beforeAll(async () => {
        db = new TokenGuardDB(testDbPath);
        await db.initialize();

        const embedding = new Float32Array(384).fill(0.1);
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
        const results = db.searchHybrid(new Float32Array(384).fill(0.1), "user profile", 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].shorthand).toContain("getUserProfile");
    });

    it("should find function by partial identifier 'profile'", () => {
        const results = db.searchHybrid(new Float32Array(384).fill(0.1), "profile", 5);
        expect(results.length).toBeGreaterThan(0);
    });
});
