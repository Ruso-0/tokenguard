/**
 * python-sidecar.ts — Python LSP Sidecar (basedpyright / pyright fallback)
 *
 * Spawns a Python LSP server as a child process for semantic validation.
 * PREFERS basedpyright-langserver (exposes auto-import codeActions via
 * standard LSP — unlocks full auto-healing). Falls back to pyright-
 * langserver if basedpyright is not installed (validation only, no healing).
 *
 * Capabilities:
 *   - supportsAutoHealing: true when basedpyright is active, false otherwise
 *   - supportsTTRD: false (both servers return imprecise hover for type contracts)
 *
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 */

import { spawnSync } from "child_process";
import { LspSidecarBase } from "./lsp-sidecar-base.js";
import { logger } from "../../utils/logger.js";

/**
 * Synchronous check whether basedpyright is installed and callable.
 * Uses the `basedpyright` CLI binary (not -langserver, which requires
 * stdio connection to respond). Times out in 3s to prevent boot hang
 * on weird environments.
 */
function isBasedPyrightAvailable(): boolean {
    try {
        // Single-string command + shell:true silences Node's DEP0190
        // (that deprecation fires when passing args array alongside shell:true).
        // shell:true is required on Windows because npm installs
        // basedpyright as a .cmd shim, and Node 18+ refuses to spawn
        // .cmd files without a shell (CVE-2024-27980 mitigation).
        const res = spawnSync("basedpyright --version", {
            encoding: "utf8",
            windowsHide: true,
            timeout: 3000,
            shell: true,
        });
        return res.status === 0 && !res.error;
    } catch {
        return false;
    }
}

export class PythonLspSidecar extends LspSidecarBase {
    constructor(projectRoot: string) {
        const isBased = isBasedPyrightAvailable();
        const cmd = isBased
            ? ["basedpyright-langserver", "--stdio"]
            : ["pyright-langserver", "--stdio"];

        super(projectRoot, cmd, "python");

        if (!isBased) {
            logger.warn(
                "basedpyright not found. Falling back to pyright (Python Auto-Healing disabled — validation only). " +
                "Install basedpyright for full healing: npm install -g basedpyright"
            );
        }
    }
}
