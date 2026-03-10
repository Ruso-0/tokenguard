/**
 * path-jail.ts — Path traversal protection for TokenGuard.
 *
 * Ensures all file paths resolve within the workspace root,
 * preventing directory traversal attacks (e.g., ../../etc/passwd).
 */

import path from "path";

/**
 * Resolve and validate a file path, ensuring it stays within the workspace root.
 * Blocks path traversal attacks by verifying the resolved path starts with
 * the resolved workspace root.
 *
 * @param workspaceRoot - The allowed root directory
 * @param inputPath - User-supplied file path (relative or absolute)
 * @returns The resolved absolute path within the workspace
 * @throws Error if the path resolves outside the workspace root
 */
export function safePath(workspaceRoot: string, inputPath: string): string {
    const resolvedRoot = path.resolve(workspaceRoot);
    const resolved = path.resolve(resolvedRoot, inputPath);
    if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
        throw new Error(`Path traversal blocked: ${inputPath}`);
    }
    return resolved;
}
