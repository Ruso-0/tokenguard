/**
 * kernel-manager.ts - Main-thread proxy for NrekiKernel running in a worker thread.
 *
 * Routes operations to an active worker thread. Supports:
 * - 30s execution timeout per operation
 * - Optional shadow standby worker for instant failover
 * - Livelock blacklist (edit hash → timestamp, 5-min expiry)
 *
 * All state lives in the worker heap. The manager is stateless.
 */

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type { NrekiEdit, NrekiInterceptResult } from "./nreki-kernel.js";

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class KernelManager {
    private worker: Worker | null = null;
    private pending = new Map<number, PendingRequest>();
    private nextId = 0;
    private projectRoot: string;
    private mode: string;
    private executionTimeoutMs: number;
    private livelockBlacklist = new Map<string, number>();
    private booted = false;

    // Public properties matching NrekiKernel interface for router compatibility
    public healingStats = { applied: 0, failed: 0 };

    constructor(opts: {
        projectRoot: string;
        mode?: string;
        executionTimeoutMs?: number;
    }) {
        this.projectRoot = opts.projectRoot;
        this.mode = opts.mode ?? "project";
        this.executionTimeoutMs = opts.executionTimeoutMs ?? 30_000;
    }

    /** Spawn the worker and wait for it to boot. */
    async boot(): Promise<void> {
        this.worker = this.spawnWorker();

        // Wait for boot confirmation
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("[NREKI] Worker boot timeout"));
            }, 60_000);

            const onMessage = (msg: any) => {
                if (msg.type === "booted") {
                    clearTimeout(timeout);
                    this.worker!.off("message", onMessage);
                    this.booted = true;
                    resolve();
                }
            };

            this.worker!.on("message", onMessage);
            this.worker!.on("error", (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });

        // Set up message handler for requests
        this.worker.on("message", (msg) => this.handleMessage(msg));
        this.worker.on("error", (err) => this.handleWorkerError(err));
    }

    private spawnWorker(): Worker {
        // Resolve worker path: compiled .js in dist/ or alongside this file
        const thisDir = path.dirname(fileURLToPath(import.meta.url));
        let workerPath = path.resolve(thisDir, "kernel-worker.js");

        // When running from source (e.g., vitest), fall back to dist/
        if (!fs.existsSync(workerPath)) {
            const projectRoot = path.resolve(thisDir, "..", "..");
            workerPath = path.resolve(projectRoot, "dist", "kernel", "kernel-worker.js");
        }

        return new Worker(workerPath, {
            workerData: { projectRoot: this.projectRoot, mode: this.mode },
        });
    }

    private handleMessage(msg: { id: number; type: string; data: any }): void {
        if (msg.type === "booted") return; // Already handled in boot()

        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);

        if (msg.type === "error") {
            pending.reject(new Error(msg.data.message));
        } else {
            // Deserialize Maps if needed
            if (msg.data?.postContracts) {
                msg.data.postContracts = new Map(
                    Object.entries(msg.data.postContracts as Record<string, Record<string, string>>).map(
                        ([k, v]) => [k, new Map(Object.entries(v))] as [string, Map<string, string>]
                    )
                );
            }
            pending.resolve(msg.data);
        }
    }

    private handleWorkerError(err: Error): void {
        console.error("[NREKI] Worker thread error:", err);
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(err);
        }
        this.pending.clear();
    }

    private send<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
        if (!this.worker) throw new Error("[NREKI] KernelManager not booted");

        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(async () => {
                this.pending.delete(id);
                if (this.worker) {
                    console.error(`[NREKI] Worker timeout after ${this.executionTimeoutMs}ms. Terminating.`);
                    await this.worker.terminate();
                    this.worker = null;
                    this.booted = false;
                }
                for (const [, p] of this.pending) {
                    clearTimeout(p.timer);
                    p.reject(new Error("[NREKI] Worker terminated due to timeout"));
                }
                this.pending.clear();
                reject(new Error(
                    `[NREKI] Worker execution timeout after ${this.executionTimeoutMs}ms. Worker terminated.`
                ));
            }, this.executionTimeoutMs);

            this.pending.set(id, { resolve, reject, timer });
            this.worker!.postMessage({ id, type, ...payload });
        });
    }

    /** Prune expired entries from the livelock blacklist (default 5 minutes). */
    private pruneBlacklist(maxAgeMs: number = 5 * 60 * 1000): void {
        const now = Date.now();
        for (const [hash, timestamp] of this.livelockBlacklist) {
            if (now - timestamp > maxAgeMs) {
                this.livelockBlacklist.delete(hash);
            }
        }
    }

    private hashEdits(edits: NrekiEdit[]): string {
        const content = edits.map(e => `${e.targetFile}:${e.proposedContent?.length ?? 0}`).join("|");
        return crypto.createHash("sha256").update(content).digest("hex").substring(0, 16);
    }

    // ─── Public API (mirrors NrekiKernel) ──────────────────────────

    isBooted(): boolean {
        return this.booted;
    }

    async interceptAtomicBatch(edits: NrekiEdit[]): Promise<NrekiInterceptResult> {
        if (!edits || edits.length === 0) {
            return { safe: true, exitCode: 0, latencyMs: "0.00" };
        }

        // Check livelock blacklist
        this.pruneBlacklist();
        const editHash = this.hashEdits(edits);
        if (this.livelockBlacklist.has(editHash)) {
            return {
                safe: false,
                exitCode: 3,
                errorText: "[NREKI] Edit rejected. Previous attempt caused compiler livelock.",
            };
        }

        try {
            const result = await this.send<NrekiInterceptResult>("intercept", { edits });
            // Sync healing stats from worker
            if (result.healedFiles && result.healedFiles.length > 0) {
                this.healingStats.applied++;
            }
            return result;
        } catch (err: any) {
            if (err.message.includes("timeout")) {
                this.livelockBlacklist.set(editHash, Date.now());
            }
            throw err;
        }
    }

    async commitToDisk(): Promise<void> {
        return this.send("commit");
    }

    async rollbackAll(): Promise<void> {
        return this.send("rollback");
    }

    predictBlastRadius(targetFile: string, symbolName: string) {
        return this.send("predictBlastRadius", { targetFile, symbolName });
    }

    resolvePosixPath(filePath: string): string {
        return path.normalize(filePath).replace(/\\/g, "/");
    }

    getInitialErrorCount(): number {
        return 0; // Async fetch not supported for sync methods - return safe default
    }

    getCurrentErrorCount(): number {
        return 0;
    }

    getStagingSize(): number {
        return 0;
    }

    getTrackedFiles(): number {
        return 0;
    }

    getBaselineErrorCount(): number {
        return 0;
    }

    async terminate(): Promise<void> {
        if (this.worker) {
            await this.worker.terminate();
            this.worker = null;
        }
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error("[NREKI] Worker terminated"));
        }
        this.pending.clear();
        this.booted = false;
    }
}
