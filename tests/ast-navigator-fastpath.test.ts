/**
 * ast-navigator-fastpath.test.ts - Tests for SQLite fast path and fast_grep.
 *
 * Covers:
 * - findDefinition with engine (fast path)
 * - findReferences with engine (fast path + AST-light stripping)
 * - getChunksBySymbolExact (exact + COLLATE NOCASE)
 * - fastGrep (single-line + multi-line + edge cases)
 * - Backward compat: slow path when engine not provided
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { ASTParser } from "../src/parser.js";
import { NrekiEngine } from "../src/engine.js";
import {
    findDefinition,
    findReferences,
} from "../src/ast-navigator.js";

// ─── Test Fixtures ──────────────────────────────────────────────────

const testDir = path.join(os.tmpdir(), `tg-fastpath-${Date.now()}`);
const dbPath = path.join(testDir, ".nreki-test.db");

const FIXTURES: Record<string, string> = {
    "src/billing.ts": `
import { Cart } from "./types.js";

// calculateTax appears in comment — should NOT match in AST-light refs
export function calculateTax(cart: Cart): number {
    return cart.total * 0.08;
}

export class Billing {
    async executeOrder(cart: Cart): Promise<void> {
        const res = await calculateTax(cart);
        console.log("Processing:", res);
    }
}

const url = "http://api.example.com/calculateTax-endpoint";
`,
    "src/types.ts": `
export interface Cart {
    total: number;
    items: string[];
}

export type PaymentMethod = "card" | "cash" | "crypto";
`,
    "src/invoice.ts": `
import { calculateTax } from "./billing.js";

export function generateInvoice(amount: number): string {
    const tax = calculateTax({ total: amount, items: [] });
    return \`Invoice total: \${amount + tax}\`;
}
`,
};

// ─── Setup & Teardown ───────────────────────────────────────────────

let engine: NrekiEngine;
let parser: ASTParser;

beforeAll(async () => {
    fs.mkdirSync(testDir, { recursive: true });
    for (const [relPath, body] of Object.entries(FIXTURES)) {
        const full = path.join(testDir, relPath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    }

    engine = new NrekiEngine({ dbPath, watchPaths: [testDir] });
    await engine.initialize();

    parser = new ASTParser();
    await parser.initialize();

    // Populate chunks table
    for (const relPath of Object.keys(FIXTURES)) {
        await engine.indexFile(path.join(testDir, relPath));
    }
});

afterAll(() => {
    engine.shutdown();
    fs.rmSync(testDir, { recursive: true, force: true });
});

// ─── Fast Path: findDefinition via SQLite ──────────────────────────

describe("findDefinition fast path (engine provided)", () => {
    it("finds function by exact name via SQLite", async () => {
        const results = await findDefinition(testDir, parser, "calculateTax", "any", engine);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].name).toBe("calculateTax");
        expect(results[0].kind).toBe("function");
        expect(results[0].filePath).toBe("src/billing.ts");
        expect(results[0].exportedAs).toBe("named");
    });

    it("finds class via fast path with body intact", async () => {
        const results = await findDefinition(testDir, parser, "Billing", "any", engine);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].kind).toBe("class");
        expect(results[0].body).toContain("executeOrder");
    });

    it("returns empty array for empty symbol name (guard)", async () => {
        const results = await findDefinition(testDir, parser, "", "any", engine);
        expect(results).toEqual([]);
    });

    it("returns empty array for whitespace-only symbol name (guard)", async () => {
        const results = await findDefinition(testDir, parser, "   ", "any", engine);
        expect(results).toEqual([]);
    });

    it("falls back to slow path gracefully when symbol not in DB", async () => {
        // Symbol that doesn't exist anywhere
        const results = await findDefinition(testDir, parser, "nonExistentSymbol123", "any", engine);
        expect(results).toEqual([]);
    });
});

// ─── Backward Compat: slow path preserved ──────────────────────────

describe("findDefinition backward compatibility (no engine)", () => {
    it("still works without engine param (slow path)", async () => {
        const results = await findDefinition(testDir, parser, "calculateTax");
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].name).toBe("calculateTax");
    });
});

// ─── Fast Path: findReferences via SQLite + AST-light ──────────────

describe("findReferences fast path (engine provided)", () => {
    it("finds references across multiple files via searchFilesBySymbol", async () => {
        const results = await findReferences(testDir, parser, "calculateTax", engine);
        // Should find refs in billing.ts AND invoice.ts
        const files = new Set(results.map(r => r.filePath));
        expect(files.has("src/billing.ts")).toBe(true);
        expect(files.has("src/invoice.ts")).toBe(true);
    });

    it("AST-light strips references inside comments", async () => {
        const results = await findReferences(testDir, parser, "calculateTax", engine);
        // Read the fixture back and verify no match reports a line that starts with "//"
        // (which would mean the regex hit inside a comment, not real code)
        const billingContent = fs.readFileSync(path.join(testDir, "src/billing.ts"), "utf-8");
        const fileLines = billingContent.split("\n");
        const billingMatches = results.filter(r => r.filePath === "src/billing.ts");
        for (const m of billingMatches) {
            const lineText = fileLines[m.line - 1] || "";
            expect(lineText.trim().startsWith("//")).toBe(false);
        }
        // Sanity: we do expect at least one real match (the function declaration)
        expect(billingMatches.length).toBeGreaterThan(0);
    });

    it("AST-light strips references inside strings", async () => {
        const results = await findReferences(testDir, parser, "calculateTax", engine);
        // URL string "http://api.example.com/calculateTax-endpoint" should NOT match
        // because "calculateTax" is inside a string literal
        const urlHit = results.find(r =>
            r.filePath === "src/billing.ts" &&
            r.context.includes("api.example.com")
        );
        expect(urlHit).toBeUndefined();
    });
});

// ─── fastGrep: SQLite INSTR substring search ──────────────────────

describe("engine.fastGrep (SQLite INSTR)", () => {
    it("finds exact substring across chunks", async () => {
        const chunks = await engine.fastGrep("calculateTax", 50);
        expect(chunks.length).toBeGreaterThan(0);
        const paths = new Set(chunks.map(c => c.path));
        expect([...paths].some(p => p.includes("billing.ts"))).toBe(true);
    });

    it("respects limit parameter", async () => {
        const chunks = await engine.fastGrep("export", 2);
        expect(chunks.length).toBeLessThanOrEqual(2);
    });

    it("returns empty array for non-existent substring", async () => {
        const chunks = await engine.fastGrep("zzznothingherezzz", 50);
        expect(chunks).toEqual([]);
    });
});
