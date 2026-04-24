/**
 * path-jail.ts - Path traversal protection for NREKI.
 *
 * Ensures all file paths resolve within the workspace root,
 * preventing directory traversal attacks (e.g., ../../etc/passwd),
 * symlink escapes, and access to sensitive files.
 */

import fs from "fs";
import path from "path";

// ─── Sensitive File Blocklist ───────────────────────────────────────

const SENSITIVE_PATTERNS: RegExp[] = [
    /\.env($|\.)/i,                     // .env, .env.local, .env.production
    /\.envrc($|\.)/i,                   // direnv RCE vector — executes on cd
    /[/\\]\.git[/\\]hooks[/\\]/i,       // Git hooks — CRITICAL RCE vector (pre-commit, post-merge, etc.)
    /[/\\]\.claude[/\\]hooks[/\\]/i,    // Claude hooks — CRITICAL RCE vector (PreToolUse injection)
    /[/\\]\.claude[/\\]settings.*?\.json$/i, // Claude settings (settings.json + settings.local.json) — RCE vector via PreToolUse
    /(?:^|[/\\])\.mcp\.json$/i,         // MCP config — CRITICAL RCE vector via rogue server injection
    /[/\\]\.ssh[/\\]/i,                 // .ssh/*
    /[/\\]\.gnupg[/\\]/i,              // .gnupg/*
    /[/\\]\.aws[/\\]/i,                // .aws/*
    /id_rsa/i,                          // SSH RSA keys
    /id_ed25519/i,                      // SSH Ed25519 keys
    /\.pem$/i,                          // PEM certificates/keys
    /\.key$/i,                          // Private key files
    /[/\\]\.npmrc$/i,                   // npm auth tokens
    /[/\\]\.pypirc$/i,                  // PyPI auth tokens
    /[/\\]\.git[/\\]credentials$/i,     // Git credential store
    /[/\\]\.git[/\\]config$/i,          // Git config (may contain tokens)
    /[/\\]\.docker[/\\]config\.json$/i, // Docker auth
    /[/\\]credentials\.json$/i,         // GCP / generic credentials
    /[/\\]\.netrc$/i,                   // FTP/HTTP auth tokens
    /[/\\]\.htpasswd$/i,               // Apache password file
    /[/\\]\.git-credentials$/i,         // Git credential file
    /[/\\]\.kube[/\\]config$/i,         // Kubernetes config
    /\.age$/i,                          // age encryption keys
    /[/\\]\.age[/\\]/i,                // age key directories (recipients, identities)
    /[/\\]vault-token$/i,               // HashiCorp Vault token
    /[/\\]\.terraform[/\\]/i,           // Terraform state (may contain secrets)
];

function normalizeForRootCheck(filePath: string): string {
    return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

function isInsideRoot(candidatePath: string, rootPath: string): boolean {
    const candidate = normalizeForRootCheck(candidatePath);
    const root = normalizeForRootCheck(rootPath);
    return candidate.startsWith(root + path.sep) || candidate === root;
}

/**
 * Check if a file path matches known sensitive file patterns.
 * These files should never be read/written by an LLM tool.
 */
export function isSensitivePath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, "/");
    return SENSITIVE_PATTERNS.some(pattern => pattern.test(normalized));
}

/**
 * Resolve and validate a file path, ensuring it stays within the workspace root.
 *
 * Security layers:
 *   1. Path traversal check (../ sequences)
 *   2. Symlink resolution (prevents symlink escapes)
 *   3. Sensitive file blocklist (.env, .ssh, .pem, etc.)
 *
 * @param workspaceRoot - The allowed root directory
 * @param inputPath - User-supplied file path (relative or absolute)
 * @returns The resolved absolute path within the workspace
 * @throws Error if the path resolves outside the workspace root or is sensitive
 */
export function safePath(workspaceRoot: string, inputPath: string): string {
    // Normalize backslashes to forward slashes so traversal detection works on Linux/macOS
    // NFC normalization: macOS uses NFD (decomposed), Linux uses NFC.
    // Without this, an attacker can bypass .env blocklist with NFD-encoded paths.
    const normalized = inputPath.normalize("NFC").replace(/\\/g, "/");
    const resolved = path.resolve(workspaceRoot, normalized);
    const resolvedRoot = path.resolve(workspaceRoot);

    if (!isInsideRoot(resolved, resolvedRoot)) {
        throw new Error(`Path traversal blocked: ${inputPath}`);
    }

    // H-02: Block operating on the workspace root itself
    if (resolved === resolvedRoot) {
        throw new Error(`Cannot operate on workspace root directly: ${inputPath}`);
    }

    // Resolve symlinks to detect symlink escapes.
    // Both resolved and root must be real-pathed so that systems where the
    // workspace sits under a symlinked directory (e.g. macOS /tmp → /private/tmp)
    // don't produce false-positive "escape" errors.
    try {
        const realPath = fs.realpathSync(resolved);
        let realRoot: string;
        try {
            realRoot = fs.realpathSync(resolvedRoot);
        } catch {
            realRoot = resolvedRoot;
        }
        if (!isInsideRoot(realPath, realRoot)) {
            throw new Error(`Symlink escape blocked: ${inputPath} resolves outside workspace`);
        }
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            // File doesn't exist yet — resolve parent chain to catch symlink escapes
            let parent = path.dirname(resolved);
            // Walk up until we find an existing directory
            while (!fs.existsSync(parent) && parent !== path.dirname(parent)) {
                parent = path.dirname(parent);
            }
            try {
                const realParent = fs.realpathSync(parent);
                let realRoot: string;
                try {
                    realRoot = fs.realpathSync(resolvedRoot);
                } catch {
                    realRoot = resolvedRoot;
                }
                if (!isInsideRoot(realParent, realRoot)) {
                    throw new Error(`Symlink escape blocked in parent directory: ${inputPath}`);
                }
            } catch (parentErr) {
                if ((parentErr as Error).message.includes("Symlink escape blocked")) {
                    throw parentErr;
                }
                // FAIL-CLOSED: Any I/O error during security validation MUST deny access.
                // EACCES (no permission), ELOOP (symlink loop), or any other OS error
                // means we cannot verify the path is safe. Block it.
                throw new Error(`Path validation failed securely during parent resolution: ${(parentErr as Error).message}`);
            }
        } else {
            throw err;
        }
    }

    // Block access to sensitive files — check BOTH logical and physical paths.
    // Without this, a symlink like `temp -> .env` bypasses the blocklist.
    let realTarget = resolved;
    try {
        realTarget = fs.realpathSync(resolved);
    } catch (err: unknown) {
        // Only tolerate ENOENT (new file, no symlink to resolve).
        // Any other error (EACCES, EPERM, EIO) = fail-closed — block access.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new Error(`[NREKI] Path validation failed for "${resolved}": ${(err as NodeJS.ErrnoException).code}`);
        }
    }

    if (isSensitivePath(resolved) || isSensitivePath(realTarget)) {
        throw new Error(`Access to sensitive file blocked: ${inputPath}`);
    }

    return resolved;
}
