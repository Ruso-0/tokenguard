/**
 * pin-memory.test.ts - Tests for persistent pinned rules.
 *
 * Covers:
 * - Add pin → appears in list
 * - Remove pin → gone from list
 * - List empty → returns empty
 * - Max 10 pins → rejects 11th with message
 * - Max 200 chars → rejects longer with message
 * - getPinnedText() is deterministic
 * - Pins appear in nreki_map output
 * - Pins persist to disk (write and re-read)
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { addPin, removePin, listPins, getPinnedText } from "../src/pin-memory.js";
import { ASTParser } from "../src/parser.js";
import { generateRepoMap, repoMapToText } from "../src/repo-map.js";

// ─── Test Fixtures ──────────────────────────────────────────────────

const testDir = path.join(os.tmpdir(), `tg-pin-test-${Date.now()}`);

const TEST_FILES: Record<string, string> = {
    "src/app.ts": `
export function main(): void {
    console.log("hello");
}
`,
};

// ─── Setup & Teardown ───────────────────────────────────────────────

let parser: ASTParser;

beforeAll(async () => {
    // Create test directory and source files
    for (const [relPath, content] of Object.entries(TEST_FILES)) {
        const fullPath = path.join(testDir, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
    }

    parser = new ASTParser();
    await parser.initialize();
});

beforeEach(() => {
    // Clear pins before each test
    const pinsPath = path.join(testDir, ".nreki", "pins.json");
    if (fs.existsSync(pinsPath)) {
        fs.unlinkSync(pinsPath);
    }
});

afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────

describe("Pin Memory - Add & List", () => {
    it("should add a pin and return it in the list", () => {
        const result = addPin(testDir, "Always use fetch, not axios", "user");
        expect(result.success).toBe(true);
        if (!result.success) return;

        expect(result.pin.id).toBe("pin_001");
        expect(result.pin.text).toBe("Always use fetch, not axios");
        expect(result.pin.source).toBe("user");

        const pins = listPins(testDir);
        expect(pins).toHaveLength(1);
        expect(pins[0].text).toBe("Always use fetch, not axios");
    });

    it("should assign sequential IDs", () => {
        addPin(testDir, "Rule one", "user");
        addPin(testDir, "Rule two", "claude");
        addPin(testDir, "Rule three", "user");

        const pins = listPins(testDir);
        expect(pins.map((p) => p.id)).toEqual(["pin_001", "pin_002", "pin_003"]);
    });

    it("should list empty when no pins exist", () => {
        const pins = listPins(testDir);
        expect(pins).toEqual([]);
    });

    it("should trim whitespace from pin text", () => {
        const result = addPin(testDir, "  spaces around  ", "user");
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.pin.text).toBe("spaces around");
    });

    it("should store source correctly for both user and claude", () => {
        addPin(testDir, "User rule", "user");
        addPin(testDir, "Claude rule", "claude");

        const pins = listPins(testDir);
        expect(pins[0].source).toBe("user");
        expect(pins[1].source).toBe("claude");
    });
});

describe("Pin Memory - Remove", () => {
    it("should remove a pin by id", () => {
        addPin(testDir, "Rule to remove", "user");
        addPin(testDir, "Rule to keep", "user");

        const removed = removePin(testDir, "pin_001");
        expect(removed).toBe(true);

        const pins = listPins(testDir);
        expect(pins).toHaveLength(1);
        expect(pins[0].text).toBe("Rule to keep");
    });

    it("should return false when removing non-existent pin", () => {
        const removed = removePin(testDir, "pin_999");
        expect(removed).toBe(false);
    });

    it("should return false when removing from empty list", () => {
        const removed = removePin(testDir, "pin_001");
        expect(removed).toBe(false);
    });
});

describe("Pin Memory - Limits", () => {
    it("should reject pin text exceeding 200 characters", () => {
        const longText = "x".repeat(201);
        const result = addPin(testDir, longText, "user");
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error).toContain("200");
    });

    it("should accept pin text at exactly 200 characters", () => {
        const exactText = "x".repeat(200);
        const result = addPin(testDir, exactText, "user");
        expect(result.success).toBe(true);
    });

    it("should reject the 11th pin with a message", () => {
        for (let i = 0; i < 10; i++) {
            const result = addPin(testDir, `Rule ${i + 1}`, "user");
            expect(result.success).toBe(true);
        }

        const result = addPin(testDir, "One too many", "user");
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error).toContain("10");
    });

    it("should reject empty pin text", () => {
        const result = addPin(testDir, "", "user");
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error).toContain("empty");
    });

    it("should reject whitespace-only pin text", () => {
        const result = addPin(testDir, "   ", "user");
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error).toContain("empty");
    });
});

describe("Pin Memory - getPinnedText()", () => {
    it("should return empty string when no pins exist", () => {
        const text = getPinnedText(testDir);
        expect(text).toBe("");
    });

    it("should format pins as a compact text block", () => {
        addPin(testDir, "Always use fetch, not axios", "user");
        addPin(testDir, "Use try/catch on all DB calls", "claude");
        addPin(testDir, "API base: /api/v2", "user");

        const text = getPinnedText(testDir);
        expect(text).toContain("=== PINNED RULES (do not violate) ===");
        expect(text).toContain("[1] Always use fetch, not axios");
        expect(text).toContain("[2] Use try/catch on all DB calls");
        expect(text).toContain("[3] API base: /api/v2");
        expect(text).toContain("=====================================");
    });

    it("should produce deterministic output (sorted by id)", () => {
        addPin(testDir, "Rule C", "user");
        addPin(testDir, "Rule A", "user");
        addPin(testDir, "Rule B", "user");

        const text1 = getPinnedText(testDir);
        const text2 = getPinnedText(testDir);
        expect(text1).toBe(text2); // BYTE IDENTICAL
    });

    it("should not contain timestamps in text output", () => {
        addPin(testDir, "Some rule", "user");
        const text = getPinnedText(testDir);
        expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    });
});

describe("Pin Memory - nreki_map Integration", () => {
    it("should append pinned rules after repo map text", async () => {
        addPin(testDir, "Always use fetch", "user");
        addPin(testDir, "Use Tailwind, not CSS modules", "claude");

        const map = await generateRepoMap(testDir, parser);
        const mapText = repoMapToText(map);
        const pinnedText = getPinnedText(testDir);

        // FIX 6: repo map first, pins after (preserves prompt cache)
        const fullText = mapText + "\n" + pinnedText;

        const mapIdx = fullText.indexOf("=== NREKI STATIC REPO MAP ===");
        const pinIdx = fullText.indexOf("=== PINNED RULES");
        expect(mapIdx).toBeGreaterThanOrEqual(0);
        expect(pinIdx).toBeGreaterThan(mapIdx);
    });

    it("should not affect repo map when no pins exist", async () => {
        const map = await generateRepoMap(testDir, parser);
        const mapText = repoMapToText(map);
        const pinnedText = getPinnedText(testDir);

        expect(pinnedText).toBe("");
        expect(mapText).toContain("=== NREKI STATIC REPO MAP ===");
        expect(mapText).not.toContain("PINNED RULES");
    });
});

describe("Pin Memory - Disk Persistence", () => {
    it("should persist pins to disk and re-read them", () => {
        addPin(testDir, "Persisted rule 1", "user");
        addPin(testDir, "Persisted rule 2", "claude");

        // Verify file exists on disk
        const pinsPath = path.join(testDir, ".nreki", "pins.json");
        expect(fs.existsSync(pinsPath)).toBe(true);

        // Read directly from disk - simulates a fresh process
        const rawData = JSON.parse(fs.readFileSync(pinsPath, "utf-8"));
        expect(rawData).toHaveLength(2);
        expect(rawData[0].text).toBe("Persisted rule 1");
        expect(rawData[1].text).toBe("Persisted rule 2");

        // listPins re-reads from disk
        const pins = listPins(testDir);
        expect(pins).toHaveLength(2);
        expect(pins[0].id).toBe("pin_001");
        expect(pins[1].id).toBe("pin_002");
    });

    it("should handle corrupted pins.json gracefully", () => {
        const dir = path.join(testDir, ".nreki");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "pins.json"), "not valid json{{{");

        const pins = listPins(testDir);
        expect(pins).toEqual([]);
    });

    it("should continue ID sequence after remove and re-add", () => {
        addPin(testDir, "Rule 1", "user");
        addPin(testDir, "Rule 2", "user");
        addPin(testDir, "Rule 3", "user");

        removePin(testDir, "pin_002");

        const result = addPin(testDir, "Rule 4", "user");
        expect(result.success).toBe(true);
        if (!result.success) return;
        // Should use pin_004, not reuse pin_002
        expect(result.pin.id).toBe("pin_004");
    });
});
