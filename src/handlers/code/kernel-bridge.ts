/**
 * kernel-bridge.ts - Kernel boot + post-intercept verification pipeline.
 *
 * ensureHologramReady, ensureKernelBooted, processKernelResult
 */

import path from "path";
import type { McpToolResponse, RouterDependencies } from "../../router.js";
import type { NrekiInterceptResult, TypeRegression } from "../../kernel/nreki-kernel.js";
import type { NrekiKernel } from "../../kernel/nreki-kernel.js";
import { saveBackup } from "../../undo.js";
import { logger } from "../../utils/logger.js";

// ─── Domain-specific helper (NOT shared) ────────────────────────────

export async function ensureHologramReady(kernel: NrekiKernel, nrekiMode: string, projectRoot: string): Promise<void> {
    if (nrekiMode !== "hologram" || kernel.hasShadows() || kernel.hasJitHologram()) return;
    try {
        const Parser = (await import("web-tree-sitter")).default;
        await Parser.init();
        const jitParser = new Parser();
        const wasmDir = path.join(
            path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1")),
            "..", "..", "..", "wasm",
        );
        const tsLangPath = path.join(wasmDir, "tree-sitter-typescript.wasm").replace(/\\/g, "/");
        const tsLanguage = await Parser.Language.load(tsLangPath);
        jitParser.setLanguage(tsLanguage);
        const { classifyAndGenerateShadow } = await import("../../hologram/shadow-generator.js");
        kernel.setJitParser(jitParser, tsLanguage);
        kernel.setJitClassifier(classifyAndGenerateShadow);
        logger.info("JIT Holography: parser loaded on-demand.");
    } catch (err) {
        logger.warn(`JIT init failed: ${(err as Error).message}. Falling back to eager scan.`);
        const { ParserPool } = await import("../../parser-pool.js");
        const { scanProject } = await import("../../hologram/shadow-generator.js");
        const pool = new ParserPool(4);
        const scanResult = await scanProject(projectRoot, pool);
        kernel.setShadows(scanResult.prunable, scanResult.unprunable, scanResult.ambientFiles);
    }
}

/** Shared kernel boot logic for edit handlers. */
export async function ensureKernelBooted(deps: RouterDependencies): Promise<boolean> {
    if (!deps.kernel || deps.nrekiMode === "syntax") return false;
    if (!deps.kernel.isBooted()) {
        logger.info(
            `Booting kernel (${deps.nrekiMode} mode). First edit will be slower.`
        );
        try {
            await ensureHologramReady(deps.kernel, deps.nrekiMode ?? "", deps.engine.getProjectRoot());
            deps.kernel.boot(
                deps.engine.getProjectRoot(),
                deps.nrekiMode as "file" | "project" | "hologram",
            );
        } catch (err) {
            logger.error(
                `Kernel boot failed: ${(err as Error).message}. Falling back to Layer 1.`
            );
        }
    }
    return deps.kernel.isBooted();
}

// ─── H-07: Shared kernel verification + TTRD + Chronos logic ────────
//
// Extracted from handleEdit and handleBatchEdit to eliminate ~150 lines
// of duplicated post-intercept logic.

/**
 * Shared kernel verification pipeline (Layer 2).
 *
 * Given a kernel intercept result, performs:
 *   1. node_modules error filtering
 *   2. Chronos error recording
 *   3. Backup + commit/rollback
 *   4. TTRD regression tracking + debt payment
 *   5. Chronos friction sync
 *
 * @param kernelResult - result from interceptAtomicBatch
 * @param committedFiles - paths that were committed (for backup + Chronos)
 * @param deps - router dependencies (kernel, chronos)
 * @param rejectionHeader - header text for the rejection response
 */
export async function processKernelResult(
    kernelResult: NrekiInterceptResult,
    committedFiles: string[],
    deps: RouterDependencies,
    rejectionHeader: string,
): Promise<{ committed: boolean; ttrdFeedback: string; response?: McpToolResponse }> {
    const kernel = deps.kernel!;
    let ttrdFeedback = "";

    if (!kernelResult.safe) {
        const agentErrors = kernelResult.structured?.filter(e =>
            !e.file.match(/[/\\]node_modules[/\\]/)
        ) || [];

        if (agentErrors.length === 0) {
            // All errors are in node_modules — safe to commit
            logger.warn(
                `${kernelResult.structured?.length} error(s) in node_modules ignored.`
            );
            for (const fp of committedFiles) {
                try { saveBackup(deps.engine.getProjectRoot(), fp); } catch {}
            }
            await kernel.commitToDisk();
            return { committed: true, ttrdFeedback };
        }

        // Real errors in agent code — record + rollback
        if (deps.chronos) {
            const errorByFile = new Map<string, string>();
            for (const e of agentErrors) {
                if (!errorByFile.has(e.file)) errorByFile.set(e.file, e.message);
            }
            for (const [fragileFile, firstMsg] of errorByFile.entries()) {
                deps.chronos.recordSemanticError(fragileFile, firstMsg);
            }
        }

        await kernel.rollbackAll();

        const structuredInfo = "\n\nSemantic errors:\n" +
            agentErrors.map(e =>
                `  \u2192 ${path.relative(deps.engine.getProjectRoot(), e.file)} (${e.line},${e.column}): ${e.code} - ${e.message}`
            ).join("\n");

        return {
            committed: false,
            ttrdFeedback,
            response: {
                content: [{
                    type: "text" as const,
                    text:
                        `${rejectionHeader}` +
                        `Layer 1 (syntax) passed, but Layer 2 (cross-file semantics) detected errors.\n` +
                        `DISK UNTOUCHED — caught in RAM, no files modified.${structuredInfo}\n\n` +
                        `Fix the type errors and retry. If you changed a function signature, ` +
                        `use \`nreki_code action:"batch_edit"\` to update all callers in one atomic transaction.`,
                }],
                isError: true,
            },
        };
    }

    // ─── Safe: backup → commit → TTRD ───
    for (const fp of committedFiles) {
        try { saveBackup(deps.engine.getProjectRoot(), fp); } catch {}
    }

    if (kernelResult.healedFiles) {
        for (const hf of kernelResult.healedFiles) {
            try { saveBackup(deps.engine.getProjectRoot(), path.resolve(deps.engine.getProjectRoot(), hf)); } catch {}
            if (deps.chronos) deps.chronos.recordHeal(hf);
        }
    }

    await kernel.commitToDisk();

    if (deps.chronos && kernelResult.postContracts) {
        // Regression tracking
        if (kernelResult.regressions && kernelResult.regressions.length > 0) {
            const byFile = new Map<string, TypeRegression[]>();
            for (const r of kernelResult.regressions) {
                const arr = byFile.get(r.filePath) || [];
                arr.push(r);
                byFile.set(r.filePath, arr);
            }

            const penaltyList: string[] = [];
            for (const [fPath, regs] of byFile.entries()) {
                deps.chronos.recordRegressions(path.resolve(deps.engine.getProjectRoot(), fPath), regs);
                for (const r of regs) {
                    penaltyList.push(`  - \`${r.symbol}\` in \`${path.basename(fPath)}\`: \`${r.oldType}\` -> \`${r.newType}\``);
                }
            }

            ttrdFeedback += `\n\n**TYPE REGRESSION DETECTED**\n` +
                `The edit compiled successfully, but weakened type safety:\n` +
                `${penaltyList.join("\n")}\n` +
                `This technical debt has been logged. Restore strict typing instead of using any/unknown.`;
        }

        // Debt payment tracking
        const allPaid: string[] = [];
        for (const fp of committedFiles) {
            const posixPath = kernel.resolvePosixPath(fp);
            const fileContracts = kernelResult.postContracts.get(posixPath);
            const paid = deps.chronos.assessDebtPayments(fp, fileContracts);
            if (paid.length > 0) {
                allPaid.push(`\`${path.basename(fp)}\`: ${paid.join(", ")}`);
            }

            const hasRegressionHere = kernelResult.regressions?.some(
                r => r.filePath === posixPath
            );
            if (!hasRegressionHere) {
                deps.chronos.recordSuccess(fp);
            }
        }

        if (allPaid.length > 0) {
            ttrdFeedback += `\n\n**TYPE DEBT PAID**\n` +
                `Strict typing restored for: ${allPaid.map(s => s).join(", ")}.\n` +
                `Friction score reduced.`;
        }

        deps.chronos.syncTechDebt(
            kernel.getInitialErrorCount(),
            kernel.getCurrentErrorCount(),
        );
    } else if (deps.chronos) {
        for (const fp of committedFiles) {
            deps.chronos.recordSuccess(fp);
        }
        deps.chronos.syncTechDebt(
            kernel.getInitialErrorCount(),
            kernel.getCurrentErrorCount(),
        );
    }

    if (kernelResult.architectureDiff) {
        ttrdFeedback += kernelResult.architectureDiff;
    }

    return { committed: true, ttrdFeedback };
}
