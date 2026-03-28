/**
 * to-posix.ts — Cross-platform path normalization
 *
 * Converts Windows backslash paths to forward-slash POSIX format.
 * Single source of truth — eliminates 4 duplicated copies across
 * the kernel, backends, and hologram modules.
 */

import * as path from "path";

export function toPosix(p: string): string {
    return path.normalize(p).replace(/\\/g, "/");
}
