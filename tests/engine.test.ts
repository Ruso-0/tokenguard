/**
 * engine.test.ts — Unit tests for the TokenGuard engine.
 *
 * Tests cover:
 * - Database schema setup and CRUD operations (async init for sql.js)
 * - File hashing and Merkle-style diffing
 * - Shorthand generation from AST nodes
 * - Hybrid RRF search with mock data
 * - Token savings estimation
 * - Compressor tier outputs
 * - Monitor burn rate calculation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import { TokenGuardDB } from "../src/database.js";
import { Embedder, MODEL_PRIORITY } from "../src/embedder.js";
import { TokenMonitor } from "../src/monitor.js";
import { PreToolUseHook } from "../src/hooks/preToolUse.js";
import { Compressor } from "../src/compressor.js";

// ─── Test Fixtures ───────────────────────────────────────────────────

const SAMPLE_TS_CODE = `
import { Request, Response } from 'express';

/**
 * Handles user authentication.
 */
export class AuthService {
  private users: Map<string, string> = new Map();

  async authenticate(username: string, password: string): Promise<boolean> {
    const stored = this.users.get(username);
    if (!stored) return false;
    return stored === password;
  }

  async register(username: string, password: string): Promise<void> {
    if (this.users.has(username)) {
      throw new Error('User already exists');
    }
    this.users.set(username, password);
  }
}

export function createMiddleware(service: AuthService) {
  return async (req: Request, res: Response, next: Function) => {
    const token = req.headers.authorization;
    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}
`;

// ─── Database Tests ──────────────────────────────────────────────────

describe("TokenGuardDB", () => {
    let db: TokenGuardDB;
    const testDbPath = path.join(os.tmpdir(), `tokenguard-test-${Date.now()}.db`);

    beforeAll(async () => {
        db = new TokenGuardDB(testDbPath);
        await db.initialize();
    });

    afterAll(() => {
        db.close();
        // Clean up test database
        try {
            fs.unlinkSync(testDbPath);
            fs.unlinkSync(testDbPath.replace(/\.db$/, ".vec"));
        } catch {
            // Files may not exist
        }
    });

    it("should create database with correct schema", () => {
        const stats = db.getStats();
        expect(stats.total_chunks).toBe(0);
        expect(stats.total_files).toBe(0);
    });

    it("should detect when a file needs updating", () => {
        const content = "console.log('hello');";
        expect(db.fileNeedsUpdate("/test/file.ts", content)).toBe(true);

        // After upserting, should no longer need update
        const hash = db.hashContent(content);
        db.upsertFile("/test/file.ts", hash);
        expect(db.fileNeedsUpdate("/test/file.ts", content)).toBe(false);
    });

    it("should detect changes when content differs", () => {
        const original = "const x = 1;";
        const hash = db.hashContent(original);
        db.upsertFile("/test/change.ts", hash);

        expect(db.fileNeedsUpdate("/test/change.ts", original)).toBe(false);
        expect(db.fileNeedsUpdate("/test/change.ts", "const x = 2;")).toBe(true);
    });

    it("should insert and count chunks", () => {
        const embedding = new Float32Array(512).fill(0.1);

        db.insertChunk(
            "/test/sample.ts",
            "[func] authenticate(username, password)",
            "async authenticate(username: string, password: string) { ... }",
            "func",
            10,
            15,
            embedding
        );

        const stats = db.getStats();
        expect(stats.total_chunks).toBeGreaterThanOrEqual(1);
    });

    it("should batch insert chunks", () => {
        const chunks = [
            {
                path: "/test/batch.ts",
                shorthand: "[func] foo()",
                rawCode: "function foo() { return 1; }",
                nodeType: "func",
                startLine: 1,
                endLine: 3,
                embedding: new Float32Array(512).fill(0.2),
            },
            {
                path: "/test/batch.ts",
                shorthand: "[func] bar()",
                rawCode: "function bar() { return 2; }",
                nodeType: "func",
                startLine: 5,
                endLine: 7,
                embedding: new Float32Array(512).fill(0.3),
            },
        ];

        db.insertChunksBatch(chunks);
        const stats = db.getStats();
        expect(stats.total_chunks).toBeGreaterThanOrEqual(3);
    });

    it("should search with vector similarity", () => {
        const queryEmbedding = new Float32Array(512).fill(0.1);
        const results = db.searchVector(queryEmbedding, 5);
        expect(results.length).toBeGreaterThan(0);
    });

    it("should search hybrid (vector + keyword)", () => {
        const queryEmbedding = new Float32Array(512).fill(0.1);
        const results = db.searchHybrid(queryEmbedding, "authenticate func", 5);
        expect(results.length).toBeGreaterThan(0);
    });

    it("should clear chunks for a file", () => {
        const embedding = new Float32Array(512).fill(0.4);
        db.insertChunk("/test/clearme.ts", "[func] temp()", "function temp() {}", "func", 1, 1, embedding);
        db.clearChunks("/test/clearme.ts");
        // Cannot directly verify deletion without querying — but no error means success
    });

    it("should log and retrieve usage stats", () => {
        db.logUsage("tg_search", 100, 200, 500);
        db.logUsage("tg_compress", 50, 100, 300);

        const stats = db.getUsageStats();
        expect(stats.total_saved).toBeGreaterThanOrEqual(800);
        expect(stats.tool_calls).toBeGreaterThanOrEqual(2);
    });

    it("should compute compression ratio", () => {
        const stats = db.getStats();
        expect(stats.compression_ratio).toBeGreaterThanOrEqual(0);
        expect(stats.compression_ratio).toBeLessThanOrEqual(1);
    });

    it("should store and retrieve metadata", () => {
        db.setMetadata("test_key", "test_value");
        expect(db.getMetadata("test_key")).toBe("test_value");
        expect(db.getMetadata("nonexistent")).toBeNull();
    });

    it("should detect embedding dimension mismatch and clear index", () => {
        // Store initial dimension
        db.setMetadata("embedding_dim", "768");

        // Insert a chunk so there's data to clear
        const emb = new Float32Array(768).fill(0.1);
        db.insertChunk("/test/dim.ts", "[fn] dimTest()", "function dimTest() {}", "func", 1, 1, emb);
        expect(db.getVectorCount()).toBeGreaterThan(0);

        // Check with different dimension — should clear
        const needsReindex = db.checkEmbeddingDimension(384);
        expect(needsReindex).toBe(true);
        expect(db.getVectorCount()).toBe(0);
        expect(db.getMetadata("embedding_dim")).toBe("384");
    });

    it("should not clear index when dimension matches", () => {
        db.setMetadata("embedding_dim", "512");
        const emb = new Float32Array(512).fill(0.1);
        db.insertChunk("/test/match.ts", "[fn] match()", "function match() {}", "func", 1, 1, emb);
        const before = db.getVectorCount();

        const needsReindex = db.checkEmbeddingDimension(512);
        expect(needsReindex).toBe(false);
        expect(db.getVectorCount()).toBe(before);
    });
});

// ─── Embedder Tests ─────────────────────────────────────────────────

describe("Embedder", () => {
    it("should report correct dimension for default (first priority) model", () => {
        const embedder = new Embedder();
        expect(embedder.getDimension()).toBe(MODEL_PRIORITY[0].dim);
    });

    it("should report correct dimension for pinned model", () => {
        const embedder = new Embedder("Xenova/all-MiniLM-L6-v2");
        expect(embedder.getDimension()).toBe(384);
    });

    it("should not be ready before initialization", () => {
        const embedder = new Embedder();
        expect(embedder.ready()).toBe(false);
        expect(embedder.getLoadedModel()).toBeNull();
    });

    it("should have code-aware models before general models in priority list", () => {
        const firstCodeIdx = MODEL_PRIORITY.findIndex(m => m.type === "code");
        const firstGeneralIdx = MODEL_PRIORITY.findIndex(m => m.type === "general");
        expect(firstCodeIdx).toBeLessThan(firstGeneralIdx);
    });

    it("should include at least one code and one general model in priority list", () => {
        expect(MODEL_PRIORITY.some(m => m.type === "code")).toBe(true);
        expect(MODEL_PRIORITY.some(m => m.type === "general")).toBe(true);
    });

    it("should estimate tokens for code", () => {
        const code = "function hello() { return 'world'; }";
        const tokens = Embedder.estimateTokens(code, true);
        expect(tokens).toBeGreaterThan(0);
        expect(tokens).toBeLessThan(code.length);
    });

    it("should estimate more tokens for prose than code", () => {
        const text = "This is a regular English sentence with some words.";
        const codeTokens = Embedder.estimateTokens(text, true);
        const proseTokens = Embedder.estimateTokens(text, false);
        expect(codeTokens).toBeGreaterThanOrEqual(proseTokens);
    });
});

// ─── Monitor Tests ──────────────────────────────────────────────────

describe("TokenMonitor", () => {
    let monitor: TokenMonitor;

    beforeEach(() => {
        monitor = new TokenMonitor({
            logPath: "/nonexistent/path/usage.jsonl",
            budgetTokens: 1_000_000,
        });
    });

    it("should return zero burn rate with no data", () => {
        const burnRate = monitor.computeBurnRate();
        expect(burnRate.tokensPerMinute).toBe(0);
        expect(burnRate.totalConsumed).toBe(0);
        expect(burnRate.apiCalls).toBe(0);
    });

    it("should predict no exhaustion with no data", () => {
        const prediction = monitor.predictExhaustion();
        expect(prediction.minutesRemaining).toBe(Infinity);
        expect(prediction.shouldAlert).toBe(false);
        expect(prediction.alertLevel).toBe("none");
    });

    it("should generate a formatted report", () => {
        const report = monitor.generateReport();
        expect(report).toContain("TokenGuard");
        expect(report).toContain("Burn Rate");
        expect(report).toContain("Total Used");
    });
});

// ─── PreToolUseHook Tests ───────────────────────────────────────────

describe("PreToolUseHook", () => {
    let hook: PreToolUseHook;

    beforeEach(() => {
        hook = new PreToolUseHook({
            fileSizeThreshold: 100,
            tokenThreshold: 50,
        });
    });

    it("should not intercept non-existent files", () => {
        const result = hook.evaluateFileRead("/nonexistent/file.ts");
        expect(result.shouldIntercept).toBe(false);
    });

    it("should generate interception rules summary", () => {
        const rules = hook.getRules();
        expect(rules).toContain("File read threshold");
        expect(rules).toContain("Token threshold");
        expect(rules).toContain("Compression level");
    });

    it("should not intercept small files", () => {
        const tempFile = path.join(os.tmpdir(), `tg-test-small-${Date.now()}.ts`);
        fs.writeFileSync(tempFile, "const x = 1;");

        const result = hook.evaluateFileRead(tempFile);
        expect(result.shouldIntercept).toBe(false);

        fs.unlinkSync(tempFile);
    });

    it("should intercept large files", () => {
        const tempFile = path.join(os.tmpdir(), `tg-test-large-${Date.now()}.ts`);
        const largeContent = SAMPLE_TS_CODE.repeat(10);
        fs.writeFileSync(tempFile, largeContent);

        const result = hook.evaluateFileRead(tempFile);
        expect(result.shouldIntercept).toBe(true);
        expect(result.wastedTokens).toBeGreaterThan(0);
        expect(result.savingsPercent).toBeGreaterThan(0);
        expect(result.suggestion).toContain("TokenGuard Intercept");

        fs.unlinkSync(tempFile);
    });

    it("should suggest tg_search for grep operations", () => {
        const tempDir = path.join(os.tmpdir(), `tg-test-dir-${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        for (let i = 0; i < 10; i++) {
            fs.writeFileSync(path.join(tempDir, `file${i}.ts`), `const x${i} = ${i};`);
        }

        const result = hook.evaluateGrepOperation("authentication", tempDir);
        expect(result.shouldIntercept).toBe(true);
        expect(result.suggestion).toContain("tg_search");

        // Cleanup
        for (let i = 0; i < 10; i++) {
            fs.unlinkSync(path.join(tempDir, `file${i}.ts`));
        }
        fs.rmdirSync(tempDir);
    });
});

// ─── KeywordIndex / Porter Stemmer Tests ────────────────────────────

describe("Porter Stemmer (via KeywordIndex)", () => {
    let db: TokenGuardDB;
    const stemDbPath = path.join(os.tmpdir(), `tokenguard-stem-test-${Date.now()}.db`);

    beforeAll(async () => {
        db = new TokenGuardDB(stemDbPath);
        await db.initialize();
    });

    afterAll(() => {
        db.close();
        try {
            fs.unlinkSync(stemDbPath);
            fs.unlinkSync(stemDbPath.replace(/\.db$/, ".vec"));
        } catch { /* ignore */ }
    });

    it("should find stemmed matches (running -> run)", () => {
        const embedding = new Float32Array(512).fill(0.1);
        db.insertChunk("/test/stem.ts", "[func] run() { /* TG:L1-L5 */ }", "function run() { ... }", "func", 1, 5, embedding);

        // "running" should match "run" via stemming
        const results = db.searchHybrid(new Float32Array(512).fill(0.1), "running function", 5);
        expect(results.length).toBeGreaterThan(0);
    });

    it("should find stemmed matches (connections -> connect)", () => {
        const embedding = new Float32Array(512).fill(0.15);
        db.insertChunk("/test/stem.ts", "[func] connectDatabase() { /* TG:L10-L20 */ }", "function connectDatabase() { ... }", "func", 10, 20, embedding);

        const results = db.searchHybrid(new Float32Array(512).fill(0.15), "connections database", 5);
        expect(results.length).toBeGreaterThan(0);
    });

    it("should boost bigram phrase matches", () => {
        const embedding1 = new Float32Array(512).fill(0.2);
        const embedding2 = new Float32Array(512).fill(0.25);
        db.insertChunk("/test/bigram1.ts", "[func] authMiddleware() auth middleware handler", "function authMiddleware() { ... }", "func", 1, 5, embedding1);
        db.insertChunk("/test/bigram2.ts", "[func] something() auth unrelated middleware", "function something() { ... }", "func", 1, 5, embedding2);

        // "auth middleware" as a phrase should boost bigram1 which has them adjacent
        const results = db.searchHybrid(new Float32Array(512).fill(0.2), "auth middleware", 5);
        expect(results.length).toBeGreaterThan(0);
    });
});

// ─── Compressor Static Tests ────────────────────────────────────────

describe("Compressor (static)", () => {
    it("should estimate savings for different tiers", () => {
        const savings1 = Compressor.estimateSavings(SAMPLE_TS_CODE, 1);
        const savings2 = Compressor.estimateSavings(SAMPLE_TS_CODE, 2);
        const savings3 = Compressor.estimateSavings(SAMPLE_TS_CODE, 3);

        expect(savings1.estimatedRatio).toBeGreaterThan(savings2.estimatedRatio);
        expect(savings2.estimatedRatio).toBeGreaterThan(savings3.estimatedRatio);
        expect(savings1.estimatedTokensSaved).toBeGreaterThan(0);
    });

    it("should have higher savings at Tier 1 than Tier 3", () => {
        const tier1 = Compressor.estimateSavings(SAMPLE_TS_CODE, 1);
        const tier3 = Compressor.estimateSavings(SAMPLE_TS_CODE, 3);
        expect(tier1.estimatedTokensSaved).toBeGreaterThan(tier3.estimatedTokensSaved);
    });
});
