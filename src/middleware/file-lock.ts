/**
 * file-lock.ts - Synchronous file-level mutex for edit operations.
 *
 * Prevents concurrent edits to the same file from corrupting it.
 * Non-queuing: if the file is already locked, the caller gets an
 * immediate rejection (the LLM should retry on the next turn).
 *
 * Usage:
 *   const lock = acquireFileLock(filePath, "nreki_code:edit");
 *   if (!lock.acquired) return errorResponse;
 *   try { ... } finally { releaseFileLock(filePath); }
 */

import path from "path";

// ─── Types ───────────────────────────────────────────────────────────

interface LockEntry {
    toolAction: string;
    acquiredAt: number;
}

// ─── State ───────────────────────────────────────────────────────────

const activeLocks = new Map<string, LockEntry>();

/** Auto-expire stale locks after 5 minutes (safety net for large batch_edits). */
const LOCK_TIMEOUT_MS = 300_000;

// ─── Helpers ─────────────────────────────────────────────────────────

function normalizeLockKey(filePath: string): string {
    const resolved = path.resolve(filePath).replace(/\\/g, "/");
    // PATCH-9: macOS APFS is case-insensitive by default (like NTFS).
    // Case-sensitive APFS volumes are opt-in and rare (<5% of Macs).
    // Without this, concurrent edits to "App.ts" and "app.ts" get separate
    // locks on macOS, causing file corruption.
    // On the rare case-sensitive APFS volume, this is a false-positive lock
    // collision (safe — just blocks the second edit until the first finishes).
    const isCaseInsensitive = process.platform === "win32" || process.platform === "darwin";
    return isCaseInsensitive ? resolved.toLowerCase() : resolved;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Attempt to acquire a lock on a file path.
 * Returns immediately - does NOT queue or wait.
 */
export function acquireFileLock(
    filePath: string,
    toolAction: string,
): { acquired: true } | { acquired: false; heldBy: string; heldForMs: number } {
    const key = normalizeLockKey(filePath);
    const existing = activeLocks.get(key);

    if (existing) {
        const elapsed = Date.now() - existing.acquiredAt;
        if (elapsed < LOCK_TIMEOUT_MS) {
            return { acquired: false, heldBy: existing.toolAction, heldForMs: elapsed };
        }
        // Stale lock - reclaim it
    }

    activeLocks.set(key, { toolAction, acquiredAt: Date.now() });
    return { acquired: true };
}

/**
 * Release a previously acquired lock.
 * Safe to call even if the lock doesn't exist (idempotent).
 */
export function releaseFileLock(filePath: string): void {
    const key = normalizeLockKey(filePath);
    activeLocks.delete(key);
}

/**
 * Clear all locks. For testing only.
 */
export function resetFileLocks(): void {
    activeLocks.clear();
}
