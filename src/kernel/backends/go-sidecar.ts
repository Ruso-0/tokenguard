/**
 * go-sidecar.ts — Go LSP Sidecar (gopls)
 *
 * Spawns gopls as a child process for semantic validation of Go files.
 * Boot requires `gopls` in PATH (install: go install golang.org/x/tools/gopls@latest).
 * If gopls is not found, the sidecar fails gracefully and the kernel
 * falls back to Layer 1 (AST syntax only) for Go files.
 *
 * Capabilities:
 *   - supportsAutoHealing: false (v1 — shield only, no magic)
 *   - supportsTTRD: false (gopls hover is imprecise for type contracts)
 *
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 */

import { LspSidecarBase } from "./lsp-sidecar-base.js";

export class GoLspSidecar extends LspSidecarBase {
    constructor(projectRoot: string) {
        super(projectRoot, ["gopls", "serve"], "go");
    }
}
