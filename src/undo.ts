/**
 * undo.ts — Auto-rollback for tg_semantic_edit.
 *
 * Before any semantic edit writes a file, we save a backup to
 * .tokenguard/backups/<base64-encoded-filepath>. Only the LAST
 * backup per file is kept (not a full history).
 *
 * tg_undo restores the file to its state before the last edit.
 */

import fs from "fs";
import path from "path";

// ─── Helpers ────────────────────────────────────────────────────────

/** Encode a file path as a safe filename for the backup directory. */
function encodeFilePath(filePath: string): string {
    return Buffer.from(path.resolve(filePath)).toString("base64url");
}

function getBackupsDir(projectRoot: string): string {
    return path.join(projectRoot, ".tokenguard", "backups");
}

function getBackupPath(projectRoot: string, filePath: string): string {
    return path.join(getBackupsDir(projectRoot), encodeFilePath(filePath));
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Save a backup of the current file content before editing.
 * Only keeps the LAST backup per file.
 */
export function saveBackup(projectRoot: string, filePath: string): void {
    const resolved = path.resolve(filePath);
    const content = fs.readFileSync(resolved, "utf-8");

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
            `tg_undo only works after tg_semantic_edit has modified a file.`
        );
    }

    const content = fs.readFileSync(backupPath, "utf-8");
    const resolved = path.resolve(filePath);
    fs.writeFileSync(resolved, content, "utf-8");

    // Remove the backup after restore (one-shot undo)
    fs.unlinkSync(backupPath);

    return `Restored "${filePath}" to its state before the last tg_semantic_edit.`;
}
