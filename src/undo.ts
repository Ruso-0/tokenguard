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
import crypto from "crypto";

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

    // AUDIT FIX (Patch 3): Binary check + size cap BEFORE full-file load (OOM guard).
    // Pre-fix: readFileSync(..., "utf-8") of a 2GB misdirected file crashed MCP
    // with OOM before the null-byte check fired.
    let fd: number;
    try {
        fd = fs.openSync(resolved, "r");
    } catch {
        return; // File doesn't exist or permission denied
    }

    try {
        const stats = fs.fstatSync(fd);

        // Hard cap: refuse to backup files > 100MB. No code file is ever this big;
        // hitting this means the agent pointed at a log/dump/db by mistake.
        if (stats.size > 100 * 1024 * 1024) return;

        const probeSize = Math.min(8192, stats.size);
        if (probeSize > 0) {
            const probe = new Uint8Array(probeSize);
            const bytesRead = fs.readSync(fd, probe, 0, probeSize, 0);
            for (let i = 0; i < bytesRead; i++) {
                if (probe[i] === 0) return; // Binary file — skip backup
            }
        }
    } catch {
        return;
    } finally {
        try { fs.closeSync(fd); } catch { /* already closed or invalid fd */ }
    }

    // Safe to load: non-binary, under size cap.
    let content: string;
    try {
        content = fs.readFileSync(resolved, "utf-8");
    } catch {
        return;
    }

    const dir = getBackupsDir(projectRoot);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const backupDest = getBackupPath(projectRoot, filePath);
    const tmpPath = `${backupDest}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, backupDest);
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
