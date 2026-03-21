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

/** Auto-expire stale locks after 30 seconds (safety net). */
const LOCK_TIMEOUT_MS = 30_000;

// ─── Helpers ─────────────────────────────────────────────────────────

function normalizeLockKey(filePath: string): string {
    const resolved = path.resolve(filePath).replace(/\\/g, "/");
    // Windows and macOS (APFS default) are case-insensitive
    return (process.platform === "win32" || process.platform === "darwin")
        ? resolved.toLowerCase()
        : resolved;
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
