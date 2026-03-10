/**
 * pin-memory.ts — Persistent pinned rules that Claude never forgets.
 *
 * Pins are injected into every tg_map response, keeping important
 * project conventions permanently in Claude's attention window.
 * Deterministic output (sorted by id) for prompt cache compatibility.
 */

import fs from "fs";
import path from "path";

// ─── Types ───────────────────────────────────────────────────────────

export interface PinnedRule {
    id: string;
    text: string;
    createdAt: number;
    source: "user" | "claude";
}

// ─── Constants ──────────────────────────────────────────────────────

const MAX_PINS = 10;
const MAX_PIN_LENGTH = 200;

/** Byte-identical comparator — same result on every OS (no ICU dependency). */
const stableCompare = (a: string, b: string): number =>
    a < b ? -1 : a > b ? 1 : 0;

// ─── Storage ─────────────────────────────────────────────────────────

function getPinsPath(projectRoot: string): string {
    return path.join(projectRoot, ".tokenguard", "pins.json");
}

function loadPins(projectRoot: string): PinnedRule[] {
    const pinsPath = getPinsPath(projectRoot);
    if (!fs.existsSync(pinsPath)) return [];
    try {
        const data = JSON.parse(fs.readFileSync(pinsPath, "utf-8"));
        if (!Array.isArray(data)) return [];
        return data;
    } catch {
        return [];
    }
}

function savePins(projectRoot: string, pins: PinnedRule[]): void {
    const dir = path.join(projectRoot, ".tokenguard");
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(getPinsPath(projectRoot), JSON.stringify(pins, null, 2));
}

// ─── Next ID ─────────────────────────────────────────────────────────

function nextId(pins: PinnedRule[]): string {
    let maxNum = 0;
    for (const pin of pins) {
        const match = pin.id.match(/^pin_(\d+)$/);
        if (match) {
            const num = parseInt(match[1], 10);
            if (num > maxNum) maxNum = num;
        }
    }
    return `pin_${String(maxNum + 1).padStart(3, "0")}`;
}

// ─── XML Escaping ────────────────────────────────────────────────

/** Escape XML/HTML special characters to prevent prompt injection. */
function escapePinContent(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

// ─── Public API ──────────────────────────────────────────────────────

export function addPin(
    projectRoot: string,
    text: string,
    source: "user" | "claude"
): { success: true; pin: PinnedRule } | { success: false; error: string } {
    if (text.length > MAX_PIN_LENGTH) {
        return {
            success: false,
            error: `Pin text exceeds maximum length of ${MAX_PIN_LENGTH} characters (got ${text.length}).`,
        };
    }

    if (text.trim().length === 0) {
        return { success: false, error: "Pin text cannot be empty." };
    }

    const pins = loadPins(projectRoot);

    if (pins.length >= MAX_PINS) {
        return {
            success: false,
            error: `Maximum of ${MAX_PINS} pins reached. Remove a pin before adding a new one.`,
        };
    }

    const pin: PinnedRule = {
        id: nextId(pins),
        text: escapePinContent(text.trim()),
        createdAt: Date.now(),
        source,
    };

    pins.push(pin);
    savePins(projectRoot, pins);
    return { success: true, pin };
}

export function removePin(
    projectRoot: string,
    id: string
): boolean {
    const pins = loadPins(projectRoot);
    const idx = pins.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    pins.splice(idx, 1);
    savePins(projectRoot, pins);
    return true;
}

export function listPins(projectRoot: string): PinnedRule[] {
    return loadPins(projectRoot);
}

export function getPinnedText(projectRoot: string): string {
    const pins = loadPins(projectRoot);
    if (pins.length === 0) return "";

    // Sort by id for deterministic output
    const sorted = [...pins].sort((a, b) => stableCompare(a.id, b.id));

    const lines: string[] = [];
    lines.push("=== PINNED RULES (do not violate) ===");
    for (let i = 0; i < sorted.length; i++) {
        lines.push(`[${i + 1}] ${sorted[i].text}`);
    }
    lines.push("=====================================");
    lines.push("");

    return lines.join("\n");
}
