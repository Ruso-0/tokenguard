/**
 * lsp-sidecar-base.ts — LSP Child Process Sidecar (Base Class)
 *
 * Shared infrastructure for spawning and communicating with LSP servers
 * (gopls, pyright) as child processes. Implements JSON-RPC 2.0 framing,
 * LSP lifecycle (initialize/initialized/shutdown/exit), and virtual file
 * overlay via didOpen/didChange.
 *
 * The sidecar is a "mercenary" — it receives files, returns diagnostics,
 * and dies when told to. It has no opinion about the VFS, ACID, or rollback.
 * The Orchestrator (NrekiKernel) holds all authority.
 *
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 */

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import type { NrekiStructuredError } from "../nreki-kernel.js";
import { toPosix as toPosixUtil } from "../../utils/to-posix.js";
import { logger } from "../../utils/logger.js";

// ─── JSON-RPC 2.0 Types (strict, zero any) ─────────────────────────

interface RpcRequest {
    jsonrpc: "2.0";
    id: number;
    method: string;
    params?: unknown;
}

interface RpcNotification {
    jsonrpc: "2.0";
    method: string;
    params?: unknown;
}

interface RpcResponseError {
    code: number;
    message: string;
}

// ─── LSP Diagnostic Types ───────────────────────────────────────────

interface LspPosition {
    line: number;
    character: number;
}

interface LspRange {
    start: LspPosition;
    end: LspPosition;
}

interface LspDiagnostic {
    range: LspRange;
    severity?: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
    code?: number | string;
    source?: string;
    message: string;
}

// ─── Pending Request Tracker ────────────────────────────────────────

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

// ─── Base Class ─────────────────────────────────────────────────────

export abstract class LspSidecarBase {
    /** LSP command to spawn (e.g., ["gopls", "serve"]) */
    public readonly command: readonly string[];
    /** LSP language identifier (e.g., "go", "python") */
    public readonly languageId: string;

    private proc?: ChildProcess;
    private buffer: Buffer = Buffer.alloc(0);
    private requestId = 0;
    private pendingRequests = new Map<number, PendingRequest>();
    private diagnostics = new Map<string, LspDiagnostic[]>();
    private openedFiles = new Set<string>();

    private realProjectRoot: string;
    private workspaceUri: string;

    /** True if the process has exited or failed to boot. */
    public isDead = false;

    // ─── Settle Debounce ────────────────────────────────────────────
    private settleResolvers: Array<() => void> = [];
    private settleTimer?: ReturnType<typeof setTimeout>;
    private settleMs = 150;

    // ─── Anti-Zombie Guard ──────────────────────────────────────────
    private readonly killFn: () => void;

    constructor(projectRoot: string, command: string[], languageId: string) {
        this.realProjectRoot = projectRoot;
        this.command = command;
        this.languageId = languageId;
        // The workspace IS the real project. No tmp dirs. No fake go.mod.
        this.workspaceUri = this.toUri(projectRoot);

        // Anti-Zombie Guard: kill child process if Node exits unexpectedly.
        // Listeners are attached in ensureReady() (when proc exists) and removed
        // in shutdown() and proc "exit" to prevent MaxListenersExceededWarning.
        this.killFn = () => { if (this.proc) { try { this.proc.kill("SIGKILL"); } catch { /* already dead */ } } };
    }

    // ─── Path Utilities ─────────────────────────────────────────────

    // POSIX normalization — delegates to shared utility
    private toPosix(p: string): string { return toPosixUtil(p); }

    private toUri(p: string): string {
        const n = this.toPosix(p);
        return n.startsWith("/") ? `file://${n}` : `file:///${n}`;
    }

    // ─── Lifecycle ──────────────────────────────────────────────────

    /**
     * Spawn the LSP server and perform the initialize handshake.
     * Throws if the binary is not found or initialize times out.
     */
    async boot(): Promise<void> {
        if (this.proc) return;
        this.isDead = false;

        return new Promise<void>((resolve, reject) => {
            try {
                this.proc = spawn(this.command[0], this.command.slice(1), {
                    cwd: this.realProjectRoot,
                    stdio: ["pipe", "pipe", "pipe"],
                });

                // Attach anti-zombie listeners now that proc exists
                process.on("exit", this.killFn);
                process.on("SIGINT", this.killFn);
                process.on("SIGTERM", this.killFn);

                // ENOENT handler: binary not found in PATH
                this.proc.on("error", (err: NodeJS.ErrnoException) => {
                    const isNotFound = err.code === "ENOENT";
                    logger.error(
                        `${this.command[0]} spawn failed: ${
                            isNotFound
                                ? `not found in PATH`
                                : err.message
                        }`,
                    );
                    this.isDead = true;
                    this.proc = undefined;
                    // PATCH-8: Remove anti-zombie listeners on spawn failure.
                    // Without this, each failed boot() accumulates 3 orphan listeners
                    // on the global process, triggering MaxListenersExceededWarning
                    // and leaking memory after ~4 retries.
                    process.removeListener("exit", this.killFn);
                    process.removeListener("SIGINT", this.killFn);
                    process.removeListener("SIGTERM", this.killFn);
                    // Reject all pending requests
                    for (const { reject: r } of this.pendingRequests.values()) {
                        r(new Error(`${this.command[0]} not available`));
                    }
                    this.pendingRequests.clear();
                });

                // Capture stderr for debugging
                if (this.proc.stderr) {
                    this.proc.stderr.on("data", (chunk: Buffer) => {
                        const msg = chunk.toString("utf-8").trim();
                        if (msg) logger.debug(`[${this.languageId}] ${msg}`);
                    });
                }

                // JSON-RPC frame parser
                if (this.proc.stdout) {
                    this.proc.stdout.on("data", (chunk: Buffer) => this.handleData(chunk));
                }

                // Clean exit: no redundant kill, prevent Windows ESRCH crash
                this.proc.on("exit", () => {
                    this.isDead = true;
                    this.proc = undefined;
                    this.diagnostics.clear();
                    for (const { reject: r } of this.pendingRequests.values()) {
                        r(new Error(`${this.command[0]} process exited unexpectedly`));
                    }
                    this.pendingRequests.clear();
                    // Remove anti-zombie listeners to prevent accumulation
                    process.removeListener("exit", this.killFn);
                    process.removeListener("SIGINT", this.killFn);
                    process.removeListener("SIGTERM", this.killFn);
                });

                // LSP initialize handshake (10s timeout)
                this.request("initialize", {
                    processId: process.pid,
                    rootUri: this.workspaceUri,
                    capabilities: {
                        textDocument: {
                            publishDiagnostics: { relatedInformation: true },
                        },
                    },
                    workspaceFolders: [
                        { uri: this.workspaceUri, name: path.basename(this.realProjectRoot) },
                    ],
                }, 10_000)
                    .then(() => {
                        this.notifyLsp("initialized", {});
                        logger.info(`${this.command[0]} sidecar booted successfully.`);
                        resolve();
                    })
                    .catch((e) => {
                        this.isDead = true;
                        if (this.proc) {
                            try { this.proc.kill("SIGKILL"); } catch { /* already dead */ }
                        }
                        this.proc = undefined;
                        reject(e);
                    });
            } catch (e) {
                this.isDead = true;
                this.proc = undefined;
                reject(e);
            }
        });
    }

    /** Check if the child process is alive and responding. */
    isHealthy(): boolean {
        return !!this.proc && this.proc.exitCode === null && !this.isDead;
    }

    /**
     * Graceful shutdown: send LSP shutdown → exit.
     * If unresponsive after 3s, SIGKILL.
     */
    async shutdown(): Promise<void> {
        if (!this.proc) return;
        try {
            await this.request("shutdown", null, 3_000);
            this.notifyLsp("exit", null);
        } catch {
            // Unresponsive — force kill
        }
        if (this.proc) {
            try { this.proc.kill("SIGKILL"); } catch { /* already dead */ }
        }
        this.proc = undefined;
        this.isDead = true;
        this.openedFiles.clear();
        this.diagnostics.clear();
        // Remove anti-zombie listeners to prevent MaxListenersExceededWarning
        process.removeListener("exit", this.killFn);
        process.removeListener("SIGINT", this.killFn);
        process.removeListener("SIGTERM", this.killFn);
    }

    // ─── Validation ─────────────────────────────────────────────────

    /**
     * Send virtual edits to the LSP server and collect diagnostics.
     * Uses didOpen (first time) or didChange (subsequent) to overlay
     * file content in the LSP server's memory.
     *
     * Waits for diagnostics to settle (150ms quiet period, 5s max).
     * Returns only severity=1 (Error) diagnostics as NrekiStructuredError[].
     */
    async validateEdits(
        edits: Array<{ filePath: string; content: string | null }>,
    ): Promise<NrekiStructuredError[]> {
        if (!this.proc || this.isDead) return [];

        let changed = false;
        for (const edit of edits) {
            // Preserve directory structure (Go packages, Python packages)
            const relPath = this.toPosix(path.relative(this.realProjectRoot, edit.filePath));
            const uri = `${this.workspaceUri}/${relPath}`;

            if (edit.content === null) {
                // Tombstone: close the file in LSP
                if (this.openedFiles.has(uri)) {
                    this.notifyLsp("textDocument/didClose", { textDocument: { uri } });
                    this.openedFiles.delete(uri);
                    this.diagnostics.delete(uri);
                    changed = true;
                }
            } else if (!this.openedFiles.has(uri)) {
                // First time: didOpen
                this.notifyLsp("textDocument/didOpen", {
                    textDocument: { uri, languageId: this.languageId, version: 1, text: edit.content },
                });
                this.openedFiles.add(uri);
                changed = true;
            } else {
                // Subsequent: didChange (full content replacement)
                this.notifyLsp("textDocument/didChange", {
                    textDocument: { uri, version: Date.now() },
                    contentChanges: [{ text: edit.content }],
                });
                changed = true;
            }
        }

        // Wait for diagnostics to settle
        if (changed) {
            await this.waitForSettle(5_000, 150);
        }

        // Collect errors (severity 1 only)
        const errors: NrekiStructuredError[] = [];
        for (const edit of edits) {
            if (edit.content === null) continue;
            const relPath = this.toPosix(path.relative(this.realProjectRoot, edit.filePath));
            const uri = `${this.workspaceUri}/${relPath}`;
            const diags = this.diagnostics.get(uri) || [];

            for (const d of diags) {
                if (d.severity === 1) {
                    errors.push({
                        file: this.toPosix(edit.filePath),
                        line: d.range.start.line + 1,
                        column: d.range.start.character + 1,
                        code: d.source ? `${this.languageId}-${d.source}` : this.languageId,
                        message: d.message,
                    });
                }
            }
        }
        return errors;
    }

    // ─── JSON-RPC Engine ────────────────────────────────────────────

    /** Parse incoming JSON-RPC frames from stdout. Uses Buffer (not string) for emoji safety. */
    /** Max buffer size (10MB) — prevents unbounded growth from malformed LSP responses. */
    private static MAX_BUFFER = 10 * 1024 * 1024;

    private handleData(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);

        if (this.buffer.length > LspSidecarBase.MAX_BUFFER) {
            logger.error(`[${this.languageId}] LSP buffer exceeded 10MB — resetting`);
            this.buffer = Buffer.alloc(0);
            return;
        }

        while (true) {
            const headerEnd = this.buffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) break;

            const headerStr = this.buffer.toString("utf-8", 0, headerEnd);
            const match = headerStr.match(/Content-Length:\s*(\d+)/i);
            if (!match) {
                // Malformed header — skip it
                this.buffer = this.buffer.subarray(headerEnd + 4);
                continue;
            }

            const bodyLen = parseInt(match[1], 10);
            const bodyStart = headerEnd + 4;
            if (this.buffer.length < bodyStart + bodyLen) break; // Wait for more TCP data

            const bodyBuf = this.buffer.subarray(bodyStart, bodyStart + bodyLen);
            this.buffer = this.buffer.subarray(bodyStart + bodyLen);

            try {
                const msg = JSON.parse(bodyBuf.toString("utf-8"));

                // Response to a request we sent
                if (
                    typeof msg.id === "number" &&
                    this.pendingRequests.has(msg.id)
                ) {
                    const pending = this.pendingRequests.get(msg.id)!;
                    this.pendingRequests.delete(msg.id);
                    if (msg.error) {
                        pending.reject(new Error((msg.error as RpcResponseError).message));
                    } else {
                        pending.resolve(msg.result);
                    }
                }
                // Notification from server (diagnostics)
                else if (msg.method === "textDocument/publishDiagnostics") {
                    const params = msg.params as { uri: string; diagnostics: LspDiagnostic[] };
                    this.diagnostics.set(params.uri, params.diagnostics);
                    this.triggerSettle();
                }
                // Other notifications (window/logMessage, etc.) — ignore
            } catch {
                // Malformed JSON — skip isolated frame
            }
        }
    }

    /** Send a JSON-RPC request and wait for response. Rejects on timeout. */
    private request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
        if (!this.proc || this.isDead) {
            return Promise.reject(new Error(`${this.command[0]} is not running`));
        }
        const id = ++this.requestId;
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`[NREKI] LSP request '${method}' timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pendingRequests.set(id, {
                resolve: (v: unknown) => { clearTimeout(timer); resolve(v); },
                reject: (e: Error) => { clearTimeout(timer); reject(e); },
            });

            const msg: RpcRequest = { jsonrpc: "2.0", id, method, params };
            this.sendRaw(msg);
        });
    }

    /** Send a JSON-RPC notification (no response expected). */
    private notifyLsp(method: string, params: unknown): void {
        const msg: RpcNotification = { jsonrpc: "2.0", method, params };
        this.sendRaw(msg);
    }

    /** Write a JSON-RPC message to the child process stdin. */
    private sendRaw(msg: RpcRequest | RpcNotification): void {
        if (!this.proc?.stdin || this.isDead) return;
        const body = JSON.stringify(msg);
        try {
            this.proc.stdin.write(
                `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`,
            );
        } catch {
            // Broken pipe — process is dying
        }
    }

    // ─── Settle Debounce ────────────────────────────────────────────

    /** Signal that new diagnostics arrived — reset the settle timer. */
    private triggerSettle(): void {
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => {
            const queue = this.settleResolvers;
            this.settleResolvers = [];
            for (const r of queue) r();
        }, this.settleMs);
    }

    /** Wait until diagnostics stop arriving, with a hard timeout. */
    private waitForSettle(maxMs: number, settleMs: number): Promise<void> {
        this.settleMs = settleMs;
        return new Promise<void>((resolve) => {
            let settled = false;
            const done = () => { if (!settled) { settled = true; resolve(); } };
            const timeout = setTimeout(() => {
                const idx = this.settleResolvers.indexOf(settleCallback);
                if (idx !== -1) this.settleResolvers.splice(idx, 1);
                done();
            }, maxMs);

            const settleCallback = () => {
                clearTimeout(timeout);
                done();
            };
            this.settleResolvers.push(settleCallback);
        });
    }
}
