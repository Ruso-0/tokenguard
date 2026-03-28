/**
 * pin-memory.ts - Persistent pinned rules that Claude never forgets.
 *
 * Pins are injected into every nreki_map response, keeping important
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
    source: "user" | "claude" | "agent";
}

// ─── Constants ──────────────────────────────────────────────────────

const MAX_PINS = 10;
const MAX_PIN_LENGTH = 200;

/** Byte-identical comparator - same result on every OS (no ICU dependency). */
const stableCompare = (a: string, b: string): number =>
    a < b ? -1 : a > b ? 1 : 0;

// ─── Storage ─────────────────────────────────────────────────────────

function getPinsPath(projectRoot: string): string {
    return path.join(projectRoot, ".nreki", "pins.json");
}

function loadPins(projectRoot: string): PinnedRule[] {
    const pinsPath = getPinsPath(projectRoot);
    if (!fs.existsSync(pinsPath)) return [];
    try {
        const raw = JSON.parse(fs.readFileSync(pinsPath, "utf-8"));
        if (!Array.isArray(raw)) return [];
        // A9: Prevent prototype pollution
        return raw.filter((item: unknown) =>
            typeof item === "object" && item !== null && !Object.hasOwn(item as object, "__proto__")
        );
    } catch {
        return [];
    }
}

function savePins(projectRoot: string, pins: PinnedRule[]): void {
    const dir = path.join(projectRoot, ".nreki");
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const pinsPath = getPinsPath(projectRoot);
    const tmp = `${pinsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(pins, null, 2));
    fs.renameSync(tmp, pinsPath);
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

// ─── Pin Sanitization ────────────────────────────────────────────

/** Patterns that should never appear in pinned rules (anti-poisoning). */
const BLOCKED_PIN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /https?:\/\/[^\s]+/i, label: "URLs" },
    { pattern: /\bsudo\b/i, label: "sudo commands" },
    { pattern: /\brm\s+-rf\b/i, label: "destructive commands" },
    { pattern: /\b(?:curl|wget)\b/i, label: "download commands" },
    { pattern: /\.\.\//,            label: "path traversal" },
    { pattern: /\$\(/,              label: "command substitution" },
    { pattern: /`[^`]*\$[({][^`]*`/, label: "backtick command substitution" },
    { pattern: /<script\b/i,        label: "script injection" },
    { pattern: /\beval\s*\(/i,      label: "eval calls" },
    { pattern: /\bexec\s*\(/i,      label: "exec calls" },
];

/**
 * Validate pin text against poisoning patterns.
 * Blocks URLs, shell commands, path traversal, and injection attempts.
 */
export function sanitizePin(text: string): { valid: true; normalized: string } | { valid: false; reason: string } {
    // A8: Reject null bytes
    if (text.includes("\0")) {
        return { valid: false, reason: "Pin text contains null bytes." };
    }
    // A8: Normalize Unicode to prevent homoglyph bypass
    const normalized = text.normalize("NFKC");
    for (const { pattern, label } of BLOCKED_PIN_PATTERNS) {
        if (pattern.test(normalized)) {
            return { valid: false, reason: `Pin text contains blocked pattern (${label}).` };
        }
    }
    // A-08: Return normalized text so callers store the canonical form
    return { valid: true, normalized };
}

// ─── Tag Escaping ────────────────────────────────────────────────

/**
 * Escape only angle brackets to prevent XML-like prompt injection.
 * A-06: Do NOT escape &, ", ' - these corrupt plain-text pins for the LLM.
 * The MCP SDK handles JSON-RPC string encoding at the transport layer.
 */
function escapePinContent(text: string): string {
    return text
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// ─── Public API ──────────────────────────────────────────────────────

export function addPin(
    projectRoot: string,
    text: string,
    source: "user" | "claude" | "agent"
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

    const sanitizeResult = sanitizePin(text.trim());
    if (!sanitizeResult.valid) {
        return { success: false, error: sanitizeResult.reason };
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
        // A-08: Use normalized text from sanitizePin
        text: escapePinContent(sanitizeResult.normalized),
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
