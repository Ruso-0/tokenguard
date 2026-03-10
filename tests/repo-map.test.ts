/**
 * repo-map.test.ts — Tests for static repo map generation.
 *
 * Covers:
 * - Deterministic output (same input = same output)
 * - Empty files
 * - Files with no exports
 * - Circular imports
 * - Text rendering format
 * - Cache behavior
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { ASTParser } from "../src/parser.js";
import { generateRepoMap, repoMapToText } from "../src/repo-map.js";

/** Same byte-identical comparator used in repo-map.ts */
const stableCompare = (a: string, b: string): number =>
    a < b ? -1 : a > b ? 1 : 0;

// ─── Test Fixtures ──────────────────────────────────────────────────

const testDir = path.join(os.tmpdir(), `tg-repomap-test-${Date.now()}`);

const TEST_FILES: Record<string, string> = {
    "src/auth.ts": `
import { Request, Response } from "express";
import { db } from "./database.js";

export interface AuthConfig {
    secret: string;
    expiresIn: number;
}

export class AuthService {
    private config: AuthConfig;

    constructor(config: AuthConfig) {
        this.config = config;
    }

    async authenticate(req: Request, res: Response): Promise<boolean> {
        const token = req.headers.authorization;
        return !!token;
    }
}

export function hashPassword(password: string): string {
    return password;
}

function internalHelper(): void {
    // not exported
}
`,
    "src/database.ts": `
import { AuthConfig } from "./auth.js";

export type QueryResult = {
    rows: unknown[];
    count: number;
};

export async function connect(url: string): Promise<void> {
    // connect to db
}

export async function query(sql: string): Promise<QueryResult> {
    return { rows: [], count: 0 };
}
`,
    "src/empty.ts": ``,
    "src/no-exports.ts": `
function privateHelper(x: number): number {
    return x * 2;
}

function anotherPrivate(): void {
    // nothing exported
}
`,
    "src/utils/format.ts": `
export function formatDate(date: Date): string {
    return date.toISOString();
}

export function formatNumber(n: number, decimals: number = 2): string {
    return n.toFixed(decimals);
}
`,
};

// ─── Setup & Teardown ───────────────────────────────────────────────

let parser: ASTParser;

beforeAll(async () => {
    // Create test directory structure
    for (const [relPath, content] of Object.entries(TEST_FILES)) {
        const fullPath = path.join(testDir, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
    }

    parser = new ASTParser();
    await parser.initialize();
});

afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────

describe("Repo Map Generation", () => {
    it("should produce deterministic output (same input = same output)", async () => {
        const map1 = await generateRepoMap(testDir, parser);
        const text1 = repoMapToText(map1);

        const map2 = await generateRepoMap(testDir, parser);
        const text2 = repoMapToText(map2);

        // Text must be identical (deterministic)
        expect(text1).toBe(text2);

        // Entries must be sorted alphabetically by file path
        const paths = map1.entries.map(e => e.filePath);
        const sorted = [...paths].sort(stableCompare);
        expect(paths).toEqual(sorted);
    });

    it("should include all source files", async () => {
        const map = await generateRepoMap(testDir, parser);

        // Should find all 5 test files
        expect(map.totalFiles).toBe(5);
        expect(map.entries.length).toBe(5);
    });

    it("should extract exports correctly", async () => {
        const map = await generateRepoMap(testDir, parser);

        const authEntry = map.entries.find(e => e.filePath === "src/auth.ts")!;
        expect(authEntry).toBeDefined();
        expect(authEntry.exports).toContain("AuthConfig");
        expect(authEntry.exports).toContain("AuthService");
        expect(authEntry.exports).toContain("hashPassword");
        // Should NOT include non-exported function
        expect(authEntry.exports).not.toContain("internalHelper");

        const dbEntry = map.entries.find(e => e.filePath === "src/database.ts")!;
        expect(dbEntry.exports).toContain("QueryResult");
        expect(dbEntry.exports).toContain("connect");
        expect(dbEntry.exports).toContain("query");
    });

    it("should extract imports correctly", async () => {
        const map = await generateRepoMap(testDir, parser);

        const authEntry = map.entries.find(e => e.filePath === "src/auth.ts")!;
        expect(authEntry.imports).toContain("express");
        expect(authEntry.imports).toContain("./database.js");

        const dbEntry = map.entries.find(e => e.filePath === "src/database.ts")!;
        expect(dbEntry.imports).toContain("./auth.js");
    });

    it("should extract function signatures", async () => {
        const map = await generateRepoMap(testDir, parser);

        const authEntry = map.entries.find(e => e.filePath === "src/auth.ts")!;
        // Should have signatures for the class and exported function
        expect(authEntry.signatures.length).toBeGreaterThan(0);

        // Check that signatures contain cleaned function names
        const sigText = authEntry.signatures.join("\n");
        expect(sigText).toContain("hashPassword");
        expect(sigText).toContain("AuthService");
    });

    it("should handle empty files", async () => {
        const map = await generateRepoMap(testDir, parser);

        const emptyEntry = map.entries.find(e => e.filePath === "src/empty.ts")!;
        expect(emptyEntry).toBeDefined();
        expect(emptyEntry.lineCount).toBe(1); // empty file has 1 line
        expect(emptyEntry.exports).toEqual([]);
        expect(emptyEntry.signatures).toEqual([]);
        expect(emptyEntry.imports).toEqual([]);
    });

    it("should handle files with no exports", async () => {
        const map = await generateRepoMap(testDir, parser);

        const noExportEntry = map.entries.find(e => e.filePath === "src/no-exports.ts")!;
        expect(noExportEntry).toBeDefined();
        expect(noExportEntry.exports).toEqual([]);
        // Should still have signatures for the private functions
        expect(noExportEntry.signatures.length).toBeGreaterThan(0);
    });

    it("should handle circular imports without infinite loops", async () => {
        const map = await generateRepoMap(testDir, parser);

        // auth.ts imports from database.ts and database.ts imports from auth.ts
        const authEntry = map.entries.find(e => e.filePath === "src/auth.ts")!;
        const dbEntry = map.entries.find(e => e.filePath === "src/database.ts")!;

        expect(authEntry.imports).toContain("./database.js");
        expect(dbEntry.imports).toContain("./auth.js");
        // No infinite loop — both files processed independently
    });

    it("should count total lines correctly", async () => {
        const map = await generateRepoMap(testDir, parser);

        const totalFromEntries = map.entries.reduce((sum, e) => sum + e.lineCount, 0);
        expect(map.totalLines).toBe(totalFromEntries);
    });
});

describe("Repo Map Text Rendering", () => {
    it("should produce well-formatted text", async () => {
        const map = await generateRepoMap(testDir, parser);
        const text = repoMapToText(map);

        // Header line
        expect(text).toContain("=== Repo Map (");
        expect(text).toContain("files,");
        expect(text).toContain("lines) ===");

        // File entries
        expect(text).toContain("src/auth.ts (");
        expect(text).toContain("lines)");

        // Exports section
        expect(text).toContain("exports:");

        // Imports section
        expect(text).toContain("imports:");
    });

    it("should not contain timestamps in the text output", async () => {
        const map = await generateRepoMap(testDir, parser);
        const text = repoMapToText(map);

        // No ISO timestamp pattern in text
        expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    });

    it("should use forward slashes in all paths", async () => {
        const map = await generateRepoMap(testDir, parser);
        const text = repoMapToText(map);

        // No backslashes in paths
        for (const entry of map.entries) {
            expect(entry.filePath).not.toContain("\\");
        }
    });

    it("should sort entries alphabetically by path", async () => {
        const map = await generateRepoMap(testDir, parser);

        for (let i = 1; i < map.entries.length; i++) {
            expect(
                stableCompare(map.entries[i - 1].filePath, map.entries[i].filePath)
            ).toBeLessThan(0);
        }
    });

    it("should sort exports alphabetically within each entry", async () => {
        const map = await generateRepoMap(testDir, parser);

        for (const entry of map.entries) {
            const sorted = [...entry.exports].sort(stableCompare);
            expect(entry.exports).toEqual(sorted);
        }
    });

    it("should sort imports alphabetically within each entry", async () => {
        const map = await generateRepoMap(testDir, parser);

        for (const entry of map.entries) {
            const sorted = [...entry.imports].sort(stableCompare);
            expect(entry.imports).toEqual(sorted);
        }
    });

    it("should sort signatures alphabetically within each entry", async () => {
        const map = await generateRepoMap(testDir, parser);

        for (const entry of map.entries) {
            const sorted = [...entry.signatures].sort(stableCompare);
            expect(entry.signatures).toEqual(sorted);
        }
    });

    it("should produce byte-identical output on repeated calls", async () => {
        const map1 = await generateRepoMap(testDir, parser);
        const text1 = repoMapToText(map1);

        // Small delay to ensure any time-dependent behavior shows
        await new Promise(r => setTimeout(r, 100));

        const map2 = await generateRepoMap(testDir, parser);
        const text2 = repoMapToText(map2);

        expect(text1).toBe(text2); // BYTE IDENTICAL
    });

    it("should not use locale-dependent number formatting", async () => {
        const map = await generateRepoMap(testDir, parser);
        const text = repoMapToText(map);

        // The header should use plain numbers, not locale-formatted (e.g., no commas in "1,234")
        const headerMatch = text.match(/=== Repo Map \((\d+) files, (\d+) lines\) ===/);
        expect(headerMatch).not.toBeNull();
        expect(Number(headerMatch![1])).toBe(map.totalFiles);
        expect(Number(headerMatch![2])).toBe(map.totalLines);
    });
});
