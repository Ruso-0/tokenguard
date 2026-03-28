/**
 * undo.ts - Auto-rollback for nreki_code action:"edit".
 *
 * Before any semantic edit writes a file, we save a backup to
 * .nreki/backups/<base64-encoded-filepath>. Only the LAST
 * backup per file is kept (not a full history).
 *
 * nreki_undo restores the file to its state before the last edit.
 */

import fs from "fs";
import path from "path";

// ─── Helpers ────────────────────────────────────────────────────────

/** Encode a file path as a safe filename for the backup directory. */
function encodeFilePath(filePath: string): string {
    return Buffer.from(path.resolve(filePath)).toString("base64url");
}

function getBackupsDir(projectRoot: string): string {
    return path.join(projectRoot, ".nreki", "backups");
}

export function getBackupPath(projectRoot: string, filePath: string): string {
    // AUDIT FIX: Always normalize to absolute path relative to projectRoot
    // before encoding, so "src/foo.ts" and "/abs/path/src/foo.ts" produce same key
    const normalized = path.resolve(projectRoot, filePath);
    return path.join(getBackupsDir(projectRoot), encodeFilePath(normalized));
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Save a backup of the current file content before editing.
 * Only keeps the LAST backup per file.
 * Skips binary files (non-UTF-8) to prevent silent corruption.
 */
export function saveBackup(projectRoot: string, filePath: string): void {
    // AUDIT FIX: Always resolve against projectRoot (consistent with getBackupPath)
    const resolved = path.resolve(projectRoot, filePath);

    // AUDIT FIX: Skip binary files — readFileSync("utf-8") silently corrupts non-text
    let content: string;
    try {
        content = fs.readFileSync(resolved, "utf-8");
    } catch {
        return; // File doesn't exist or read error — nothing to backup
    }

    // Heuristic binary check: null bytes in first 8KB indicate binary
    if (content.slice(0, 8192).includes("\0")) return;

    const dir = getBackupsDir(projectRoot);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(getBackupPath(projectRoot, filePath), content, "utf-8");
}

/**
 * Restore a file from its backup.
 * Throws a clear error if no backup exists.
 * Returns a success message.
 */
export function restoreBackup(projectRoot: string, filePath: string): string {
    const backupPath = getBackupPath(projectRoot, filePath);

    if (!fs.existsSync(backupPath)) {
        throw new Error(
            `No backup found for "${filePath}". ` +
            `nreki_undo only works after nreki_code action:"edit" has modified a file.`
        );
    }

    const content = fs.readFileSync(backupPath, "utf-8");
    const resolved = path.resolve(projectRoot, filePath);
    fs.writeFileSync(resolved, content, "utf-8");

    // Remove the backup after restore (one-shot undo)
    fs.unlinkSync(backupPath);

    return `Restored "${filePath}" to its state before the last nreki_code action:"edit".`;
}
