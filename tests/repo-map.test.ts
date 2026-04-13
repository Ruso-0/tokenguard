/**
 * repo-map.test.ts - Tests for static repo map generation.
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
import { generateRepoMap, repoMapToText, computePageRank } from "../src/repo-map.js";

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
        // No infinite loop - both files processed independently
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
        expect(text).toContain("=== NREKI STATIC REPO MAP ===");

        // File entries (skeleton format: [TIER] file.ts (NL) exports: ...)
        expect(text).toContain("auth.ts");
        expect(text).toMatch(/\[\w+\] auth\.ts \(\d+L\)/);

        // Exports section
        expect(text).toContain("exports:");
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
        const text = repoMapToText(map, "full");

        // Metadata in footer should use plain numbers, not locale-formatted (e.g., no commas in "1,234")
        const metadataMatch = text.match(/Files: (\d+) \| Lines: (\d+) \| lambda2: [\d.]+/);
        expect(metadataMatch).not.toBeNull();
        expect(Number(metadataMatch![1])).toBe(map.totalFiles);
        expect(Number(metadataMatch![2])).toBe(map.totalLines);
    });
});

describe("PageRank Architecture Scoring", () => {
    it("should rank files imported by important files higher than files imported by leaf files", () => {
        const files = ["core.ts", "service-a.ts", "service-b.ts", "util.ts", "leaf-1.ts", "leaf-2.ts", "leaf-3.ts"];

        // core.ts is imported by service-a and service-b (important files)
        // util.ts is imported by leaf-1, leaf-2, leaf-3 (unimportant files)
        // Both have inDegree = 2-3, but core.ts should rank higher
        const importedBy = new Map<string, Set<string>>([
            ["core.ts", new Set(["service-a.ts", "service-b.ts"])],
            ["service-a.ts", new Set(["leaf-1.ts"])],
            ["service-b.ts", new Set(["leaf-2.ts"])],
            ["util.ts", new Set(["leaf-1.ts", "leaf-2.ts", "leaf-3.ts"])],
            ["leaf-1.ts", new Set()],
            ["leaf-2.ts", new Set()],
            ["leaf-3.ts", new Set()],
        ]);

        const scores = computePageRank(files, importedBy);

        // core.ts should score higher than util.ts despite similar inDegree
        // because its importers (service-a, service-b) are themselves imported
        expect(scores.get("core.ts")).toBeGreaterThan(scores.get("util.ts")!);

        // Leaf files should have the lowest scores
        expect(scores.get("leaf-1.ts")).toBeLessThan(scores.get("service-a.ts")!);
    });

    it("should handle empty file list", () => {
        const scores = computePageRank([], new Map());
        expect(scores.size).toBe(0);
    });

    it("should handle single file with no dependencies", () => {
        const scores = computePageRank(["solo.ts"], new Map([["solo.ts", new Set()]]));
        expect(scores.get("solo.ts")).toBeDefined();
    });

    it("should converge in under 1000ms for 1000 files", () => {
        // Generate synthetic graph with 1000 files
        const files: string[] = [];
        const importedBy = new Map<string, Set<string>>();
        for (let i = 0; i < 1000; i++) {
            const name = `file-${i}.ts`;
            files.push(name);
            importedBy.set(name, new Set());
        }
        // Create random edges (each file imports 2-5 others)
        for (let i = 0; i < 1000; i++) {
            const numImports = 2 + Math.floor(Math.random() * 4);
            for (let j = 0; j < numImports; j++) {
                const target = Math.floor(Math.random() * 1000);
                if (target !== i) {
                    importedBy.get(files[target])!.add(files[i]);
                }
            }
        }

        const t0 = performance.now();
        const scores = computePageRank(files, importedBy);
        const elapsed = performance.now() - t0;

        expect(scores.size).toBe(1000);
        expect(elapsed).toBeLessThan(1000); // Must converge in under 1000ms (relaxed for CI)
    });
});
