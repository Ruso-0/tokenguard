/**
 * harvester.ts - Background .d.ts extractor for hologram mode.
 *
 * Extracts real .d.ts declarations from the TypeScript compiler during idle time,
 * replacing heuristic Tree-sitter shadows with compiler-grade ones.
 *
 * Cooperative scheduler: processes 3 files per event loop cycle using setImmediate.
 * Epoch-aware: aborts if kernel.logicalTime changed (new edit arrived).
 * TS4023 errors: marks file as UNPRUNABLE_FOREVER in the cache.
 */

import type { NrekiKernel } from "../kernel/nreki-kernel.js";
import { logger } from "../utils/logger.js";
import type { ShadowCache } from "./shadow-cache.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface HarvestResult {
    filesHarvested: number;
    filesMarkedUnprunable: number;
    aborted: boolean;
    durationMs: number;
}

// ─── Harvester ───────────────────────────────────────────────────────

export class DtsHarvester {
    private queue = new Set<string>();
    private isHarvesting = false;

    constructor(
        private kernel: NrekiKernel,
        private cache: ShadowCache,
    ) {}

    /** Queue files for .d.ts harvest during idle time. */
    queueForHarvest(unprunableFiles: string[]): void {
        for (const file of unprunableFiles) {
            if (!this.cache.isUnprunableForever(file)) {
                this.queue.add(file);
            }
        }

        if (!this.isHarvesting && this.queue.size > 0) {
            this.startHarvesting(this.kernel.getLogicalTime()).catch(err => {
                logger.warn(`Harvester cycle failed: ${err}`);
            });
        }
    }

    /** Abort current harvest (called when an edit arrives). */
    abort(): void {
        this.isHarvesting = false;
    }

    /**
     * Cooperative scheduler: 3 files per event loop cycle.
     * Uses setImmediate to yield the event loop between batches.
     * Aborts if kernel.logicalTime changed (new edit arrived).
     */
    private async startHarvesting(epochId: number): Promise<HarvestResult> {
        if (this.isHarvesting) {
            return { filesHarvested: 0, filesMarkedUnprunable: 0, aborted: false, durationMs: 0 };
        }

        this.isHarvesting = true;
        const t0 = performance.now();
        let filesHarvested = 0;
        let filesMarkedUnprunable = 0;
        const BATCH_SIZE = 3;

        try {
            // While loop drains queue until empty. The old
            // snapshot+clear pattern orphaned files enqueued during awaits.
            while (this.queue.size > 0) {
                // Abort check: stop if abort() was called or a new edit arrived
                if (!this.isHarvesting || this.kernel.getLogicalTime() !== epochId) {
                    return {
                        filesHarvested,
                        filesMarkedUnprunable,
                        aborted: true,
                        durationMs: performance.now() - t0,
                    };
                }

                const batch = Array.from(this.queue).slice(0, BATCH_SIZE);
                for (const f of batch) this.queue.delete(f);

                for (const filePath of batch) {
                    const result = this.harvestSingleFile(filePath);
                    if (result === "harvested") {
                        filesHarvested++;
                    } else if (result === "unprunable") {
                        filesMarkedUnprunable++;
                    }
                }

                // Yield event loop for cooperative scheduling
                if (this.queue.size > 0) {
                    await new Promise<void>(resolve => {
                        if (typeof globalThis.setImmediate === "function") {
                            setImmediate(resolve);
                        } else {
                            setTimeout(resolve, 0);
                        }
                    });
                }
            }
        } finally {
            this.isHarvesting = false;
        }

        return {
            filesHarvested,
            filesMarkedUnprunable,
            aborted: false,
            durationMs: performance.now() - t0,
        };
    }

    /**
     * Harvest a single file: extract real .d.ts from the compiler.
     * Returns "harvested" on success, "unprunable" if TS4023, or "skipped".
     */
    private harvestSingleFile(filePath: string): "harvested" | "unprunable" | "skipped" {
        const program = this.kernel.getProgram();
        if (!program) return "skipped";

        const sourceFile = program.getSourceFile(filePath);
        if (!sourceFile) return "skipped";

        let dtsContent = "";
        let hasTs4023 = false;

        const emitResult = program.emit(
            sourceFile,
            (fileName: string, text: string) => {
                if (fileName.endsWith(".d.ts")) {
                    dtsContent = text;
                }
            },
            undefined,
            true, // emitOnlyDtsFiles
        );

        // Check for TS4023: "Exported variable has or is using name from external module"
        for (const diag of emitResult.diagnostics) {
            if (diag.code === 4023) {
                hasTs4023 = true;
                break;
            }
        }

        if (hasTs4023) {
            this.cache.markAsUnprunableForever(filePath);
            return "unprunable";
        }

        if (dtsContent) {
            this.cache.setShadow(filePath, dtsContent, "harvested");
            return "harvested";
        }

        return "skipped";
    }
}
