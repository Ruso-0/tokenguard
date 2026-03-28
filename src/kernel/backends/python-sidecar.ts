/**
 * python-sidecar.ts — Python LSP Sidecar (pyright)
 *
 * Spawns pyright-langserver as a child process for semantic validation
 * of Python files. Boot requires `pyright-langserver` in PATH
 * (install: npm install -g pyright).
 *
 * If pyright is not found, the sidecar fails gracefully and the kernel
 * falls back to Layer 1 (AST syntax only) for Python files.
 *
 * Capabilities:
 *   - supportsAutoHealing: false (v1 — shield only, no magic)
 *   - supportsTTRD: false (pyright hover is imprecise for type contracts)
 *
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 */

import { LspSidecarBase } from "./lsp-sidecar-base.js";

export class PythonLspSidecar extends LspSidecarBase {
    constructor(projectRoot: string) {
        super(projectRoot, ["pyright-langserver", "--stdio"], "python");
    }
}
