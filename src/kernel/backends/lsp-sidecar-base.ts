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

export interface LspPosition {
    line: number;
    character: number;
}

export interface LspRange {
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
    timer: NodeJS.Timeout;
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

    protected readonly spawnEnv?: Record<string, string>;
    protected realProjectRoot: string;
    protected workspaceUri: string;

    /** True if the process has exited or failed to boot. */
    public isDead = false;

    /** True if the LSP server supports textDocument/diagnostic (pull model) */
    protected supportsPullDiagnostics = false;

    // ─── Settle Debounce ────────────────────────────────────────────
    private settleResolvers: Array<() => void> = [];
    private settleTimer?: ReturnType<typeof setTimeout>;
    private settleMs = 150;

    // ─── Anti-Zombie Guard ──────────────────────────────────────────
    private readonly killFn: () => void;

    constructor(
        projectRoot: string,
        command: string[],
        languageId: string,
        spawnEnv?: Record<string, string>,
    ) {
        this.realProjectRoot = projectRoot;
        this.command = command;
        this.languageId = languageId;
        this.spawnEnv = spawnEnv;
        // The workspace IS the real project. No tmp dirs. No fake go.mod.
        this.workspaceUri = this.toUri(projectRoot);

        // Anti-Zombie Guard: kill child process if Node exits unexpectedly.
        // Listeners are attached in ensureReady() (when proc exists) and removed
        // in shutdown() and proc "exit" to prevent MaxListenersExceededWarning.
        this.killFn = () => { this.forceKill(); };
    }

    // ─── Path Utilities ─────────────────────────────────────────────

    // POSIX normalization — delegates to shared utility
    protected toPosix(p: string): string { return toPosixUtil(p); }

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
                // ENV WHITELIST: Never propagate secrets (API keys, DB passwords, tokens)
                // to third-party LSP binaries operating on untrusted code.
                const SAFE_ENV_KEYS = [
                    "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
                    "TMPDIR", "TEMP", "TMP", "TERM",
                    // Go toolchain
                    "GOPATH", "GOROOT", "GOMODCACHE", "GOFLAGS", "GOPROXY", "GONOSUMCHECK",
                    // Python toolchain
                    "PYTHONPATH", "VIRTUAL_ENV", "CONDA_DEFAULT_ENV", "CONDA_PREFIX",
                    // Node (for tsx wrappers)
                    "NODE_PATH", "NODE_OPTIONS",
                ];
                const safeEnv: Record<string, string> = {};
                for (const key of SAFE_ENV_KEYS) {
                    if (process.env[key] !== undefined) safeEnv[key] = process.env[key]!;
                }
                const finalEnv = this.spawnEnv ? { ...safeEnv, ...this.spawnEnv } : safeEnv;

                this.proc = spawn(this.command[0], this.command.slice(1), {
                    cwd: this.realProjectRoot,
                    env: finalEnv,
                    stdio: ["pipe", "pipe", "pipe"],
                    detached: process.platform !== "win32",
                });

                // Attach anti-zombie listeners now that proc exists
                process.on("exit", this.killFn);
                process.on("SIGINT", this.killFn);
                process.on("SIGTERM", this.killFn);

                // ENOENT handler: binary not found in PATH
                this.proc.on("error", (err: NodeJS.ErrnoException) => {
                    const isNotFound = err.code === "ENOENT";
                    const msg = `[NREKI] ${this.command[0]} spawn failed: ${isNotFound ? "not found in PATH" : err.message}`;
                    logger.error(msg);
                    this.cleanupState(msg);
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
                    this.cleanupState(`[NREKI] ${this.command[0]} process exited unexpectedly`);
                });

                // LSP initialize handshake (10s timeout)
                this.request("initialize", {
                    processId: process.pid,
                    rootUri: this.workspaceUri,
                    capabilities: {
                        textDocument: {
                            publishDiagnostics: { relatedInformation: true },
                            diagnostic: { dynamicRegistration: false },
                        },
                    },
                    workspaceFolders: [
                        { uri: this.workspaceUri, name: path.basename(this.realProjectRoot) },
                    ],
                }, 10_000)
                    .then((initResult) => {
                        // Detect pull diagnostics support from server capabilities
                        const serverCaps = initResult as any;
                        if (serverCaps?.capabilities?.diagnosticProvider) {
                            this.supportsPullDiagnostics = true;
                            logger.info(`${this.command[0]} supports pull diagnostics (deterministic mode).`);
                        }
                        this.notifyLsp("initialized", {});
                        logger.info(`${this.command[0]} sidecar booted successfully.`);
                        resolve();
                    })
                    .catch((e) => {
                        this.forceKill();
                        reject(e);
                    });
            } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e);
                this.cleanupState(`[NREKI] Synchronous boot failure for ${this.command[0]}: ${errMsg}`);
                reject(e);
            }
        });
    }

    /** Check if the child process is alive and responding. */
    isHealthy(): boolean {
        return !!this.proc && this.proc.exitCode === null && !this.isDead;
    }

    /**
     * SSOT (Single Source of Truth) para el ciclo de vida final.
     * Idempotente: previene ejecución redundante si exit y forceKill colisionan.
     * Simétrico: limpia TODO sin importar por qué murió el proceso.
     */
    private cleanupState(reasonMsg: string): void {
        if (this.isDead) return;
        this.isDead = true;
        this.openedFiles.clear();
        this.diagnostics.clear();

        // 1. Settle Timers
        if (this.settleTimer) {
            clearTimeout(this.settleTimer);
            this.settleTimer = undefined;
        }
        const queue = this.settleResolvers;
        this.settleResolvers = [];
        for (const r of queue) r();

        // 2. Pending Request Timers (limpieza explícita, sin closures)
        const err = new Error(reasonMsg);
        for (const { reject, timer } of this.pendingRequests.values()) {
            clearTimeout(timer);
            reject(err);
        }
        this.pendingRequests.clear();

        // 3. Process listeners
        process.removeListener("exit", this.killFn);
        process.removeListener("SIGINT", this.killFn);
        process.removeListener("SIGTERM", this.killFn);

        this.proc = undefined;
    }

    public forceKill(): void {
        if (this.proc) {
            try {
                if (this.proc.stdin && !this.proc.stdin.destroyed) {
                    this.proc.stdin.end();
                    this.proc.stdin.destroy();
                }
                // Kill the entire process group (-pid) on POSIX to prevent
                // orphaned workers (gopls analyzers, pyright background threads).
                if (process.platform !== "win32" && this.proc.pid) {
                    try {
                        process.kill(-this.proc.pid, "SIGKILL");
                    } catch {
                        this.proc.kill("SIGKILL");
                    }
                } else {
                    this.proc.kill("SIGKILL");
                }
            } catch { /* already dead */ }
        }
        this.cleanupState(`[NREKI] ${this.command[0]} process tree terminated forcefully`);
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
        this.forceKill();
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

        // Collect diagnostics: pull (deterministic) or push (settle timer)
        if (changed) {
            if (this.supportsPullDiagnostics) {
                // PULL MODE: Request diagnostics for ALL open files, not just edited ones.
                // This catches cross-file breakage (editing api.py breaks consumer.py).
                const pullPromises: Promise<void>[] = [];
                for (const uri of this.openedFiles) {
                    pullPromises.push(this.pullDiagnostics(uri));
                }
                await Promise.all(pullPromises);
            } else {
                // PUSH MODE (fallback): Wait for server to push diagnostics.
                await this.waitForSettle(5_000, 150);
            }
        }

        // Collect errors from ALL open files (severity 1 only).
        // Cross-file: if editing file A breaks file B, we catch it here.
        const errors: NrekiStructuredError[] = [];
        for (const uri of this.openedFiles) {
            const diags = this.diagnostics.get(uri) || [];
            const relPath = uri.replace(`${this.workspaceUri}/`, "");

            for (const d of diags) {
                if (d.severity === 1) {
                    errors.push({
                        file: this.toPosix(path.resolve(this.realProjectRoot, relPath)),
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

    /**
     * Pull diagnostics for a specific file (LSP 3.17+).
     * Deterministic: waits for the server's actual response.
     * No timers. No race conditions.
     */
    private async pullDiagnostics(uri: string): Promise<void> {
        try {
            const result = await this.request("textDocument/diagnostic", {
                textDocument: { uri },
            }, 10_000) as any;

            // Pull response contains items directly (not via notification)
            if (result?.items && Array.isArray(result.items)) {
                this.diagnostics.set(uri, result.items);
            }
        } catch {
            // Server may not support it for this file — fall through to push
        }
    }

    /**
     * Request code actions (quickfixes) for a diagnostic.
     * Returns TextEdit[] that the kernel can apply to VFS.
     * The kernel decides if the fix is safe (whitelist).
     */
    async requestCodeActions(
        filePath: string,
        diagnostic: { range: LspRange; message: string; code?: number | string; source?: string }
    ): Promise<Array<{ filePath: string; range: LspRange; newText: string; title: string }>> {
        if (!this.proc || this.isDead) return [];

        const relPath = this.toPosix(path.relative(this.realProjectRoot, filePath));
        const uri = `${this.workspaceUri}/${relPath}`;

        try {
            const result = await this.request("textDocument/codeAction", {
                textDocument: { uri },
                range: diagnostic.range,
                context: {
                    diagnostics: [{
                        range: diagnostic.range,
                        message: diagnostic.message,
                        code: diagnostic.code,
                        source: diagnostic.source,
                    }],
                    only: ["quickfix"],
                },
            }, 5_000) as any[];

            if (!result || !Array.isArray(result)) return [];

            const edits: Array<{ filePath: string; range: LspRange; newText: string; title: string }> = [];

            for (const action of result) {
                if (!action.edit?.documentChanges && !action.edit?.changes) continue;

                // WorkspaceEdit.changes format
                const changes = action.edit?.changes || {};
                for (const [changeUri, textEdits] of Object.entries(changes)) {
                    for (const te of textEdits as any[]) {
                        edits.push({
                            filePath: changeUri.replace(this.workspaceUri + "/", ""),
                            range: te.range,
                            newText: te.newText,
                            title: action.title || "",
                        });
                    }
                }

                // WorkspaceEdit.documentChanges format
                for (const dc of action.edit?.documentChanges || []) {
                    if (!dc.edits) continue;
                    const dcUri = dc.textDocument?.uri || "";
                    for (const te of dc.edits) {
                        edits.push({
                            filePath: dcUri.replace(this.workspaceUri + "/", ""),
                            range: te.range,
                            newText: te.newText,
                            title: action.title || "",
                        });
                    }
                }
            }

            return edits;
        } catch {
            return [];
        }
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

                    clearTimeout(pending.timer);

                    if (msg.error) {
                        pending.reject(new Error((msg.error as RpcResponseError).message));
                    } else {
                        pending.resolve(msg.result);
                    }
                }
                // Notification from server (diagnostics)
                else if (msg.method === "textDocument/publishDiagnostics") {
                    // RACE CONDITION GUARD: In pull mode, ignore async push notifications.
                    // The LSP may send stale pushes after we've already received the
                    // authoritative pull response, overwriting fresh data with old data.
                    if (!this.supportsPullDiagnostics) {
                        const params = msg.params as { uri: string; diagnostics: LspDiagnostic[] };
                        this.diagnostics.set(params.uri, params.diagnostics);
                        this.triggerSettle();
                    }
                }
                // Other notifications (window/logMessage, etc.) — ignore
            } catch {
                // Malformed JSON — skip isolated frame
            }
        }
    }

    /** Send a JSON-RPC request and wait for response. Rejects on timeout. */
    protected request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
        if (!this.proc || this.isDead) {
            return Promise.reject(new Error(`[NREKI] ${this.command[0]} is not running`));
        }
        const id = ++this.requestId;
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`[NREKI] LSP request '${method}' timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pendingRequests.set(id, { resolve, reject, timer });

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
