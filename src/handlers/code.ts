/**
 * handlers/code.ts - Pure code handlers (DAG: no circular dependencies).
 *
 * Each handler takes params + deps, returns McpToolResponse.
 * ensureHologramReady lives here (domain-specific to edit/batch_edit).
 * Heartbeat wrapping is the router's responsibility.
 */

import fs from "fs";
import path from "path";
import type { McpToolResponse, CodeParams, RouterDependencies } from "../router.js";
import type { CompressionLevel } from "../compressor.js";
import type { NrekiInterceptResult, TypeRegression } from "../kernel/nreki-kernel.js";
import { Embedder } from "../embedder.js";
import { safePath } from "../utils/path-jail.js";
import { shouldProcess } from "../utils/file-filter.js";
import { readSource } from "../utils/read-source.js";
import { semanticEdit, batchSemanticEdit, detectSignatureChange, type EditMode, type BatchEditOp } from "../semantic-edit.js";
import { saveBackup, restoreBackup } from "../undo.js";
import { acquireFileLock, releaseFileLock } from "../middleware/file-lock.js";
import { filterTerminalOutput } from "../terminal-filter.js";
import { extractDependencies, cleanSignature, isSensitiveSignature } from "../utils/imports.js";
import { logger } from "../utils/logger.js";
import type { NrekiKernel } from "../kernel/nreki-kernel.js";

// ─── Domain-specific helper (NOT shared) ────────────────────────────

async function ensureHologramReady(kernel: NrekiKernel, nrekiMode: string): Promise<void> {
    if (nrekiMode !== "hologram" || kernel.hasShadows() || kernel.hasJitHologram()) return;
    try {
        const Parser = (await import("web-tree-sitter")).default;
        await Parser.init();
        const jitParser = new Parser();
        const wasmDir = path.join(
            path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1")),
            "..", "..", "wasm",
        );
        const tsLangPath = path.join(wasmDir, "tree-sitter-typescript.wasm").replace(/\\/g, "/");
        const tsLanguage = await Parser.Language.load(tsLangPath);
        jitParser.setLanguage(tsLanguage);
        const { classifyAndGenerateShadow } = await import("../hologram/shadow-generator.js");
        kernel.setJitParser(jitParser, tsLanguage);
        kernel.setJitClassifier(classifyAndGenerateShadow);
        logger.info("JIT Holography: parser loaded on-demand.");
    } catch (err) {
        logger.warn(`JIT init failed: ${(err as Error).message}. Falling back to eager scan.`);
        const { ParserPool } = await import("../parser-pool.js");
        const { scanProject } = await import("../hologram/shadow-generator.js");
        const pool = new ParserPool(4);
        const scanResult = await scanProject(process.cwd(), pool);
        kernel.setShadows(scanResult.prunable, scanResult.unprunable, scanResult.ambientFiles);
    }
}

/** Shared kernel boot logic for edit handlers. */
async function ensureKernelBooted(deps: RouterDependencies): Promise<boolean> {
    if (!deps.kernel || deps.nrekiMode === "syntax") return false;
    if (!deps.kernel.isBooted()) {
        logger.info(
            `Booting kernel (${deps.nrekiMode} mode). First edit will be slower.`
        );
        try {
            await ensureHologramReady(deps.kernel, deps.nrekiMode ?? "");
            deps.kernel.boot(
                process.cwd(),
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
async function processKernelResult(
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
                try { saveBackup(process.cwd(), fp); } catch {}
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
                `  \u2192 ${path.relative(process.cwd(), e.file)} (${e.line},${e.column}): ${e.code} - ${e.message}`
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
                        `\ud83d\udee1\ufe0f **DISK UNTOUCHED: Caught in RAM. No files modified.**${structuredInfo}\n\n` +
                        `Fix the type errors and retry. If you changed a function signature, ` +
                        `use \`nreki_code action:"batch_edit"\` to update all callers in one atomic transaction.\n\n` +
                        `[NREKI: validated in ${kernelResult.latencyMs}ms]`,
                }],
                isError: true,
            },
        };
    }

    // ─── Safe: backup → commit → TTRD ───
    for (const fp of committedFiles) {
        try { saveBackup(process.cwd(), fp); } catch {}
    }

    if (kernelResult.healedFiles) {
        for (const hf of kernelResult.healedFiles) {
            try { saveBackup(process.cwd(), path.resolve(process.cwd(), hf)); } catch {}
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
                deps.chronos.recordRegressions(path.resolve(process.cwd(), fPath), regs);
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

    return { committed: true, ttrdFeedback };
}

// ─── Read ───────────────────────────────────────────────────────────

export async function handleRead(
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    const file_path = params.path ?? "";
    let resolvedPath: string;
    try {
        resolvedPath = safePath(process.cwd(), file_path);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}\n\n[NREKI saved ~0 tokens]`,
            }],
        };
    }

    try {
        const stat = fs.statSync(resolvedPath);

        const filterResult = shouldProcess(resolvedPath, stat.size);
        if (!filterResult.process) {
            return {
                content: [{
                    type: "text" as const,
                    text: `File skipped: ${filterResult.reason}\n\n[NREKI saved ~0 tokens]`,
                }],
            };
        }

        const rawContent = readSource(resolvedPath);

        const autoContext = params.auto_context !== false;
        let autoContextBlock = "";
        let extraTokens = 0;

        if (autoContext) {
            try {
                const ext = path.extname(resolvedPath).toLowerCase();
                const depsList = extractDependencies(rawContent, ext);

                if (depsList.length > 0) {
                    const rawSignatures = engine.resolveImportSignatures(depsList.slice(0, 15));
                    const safeSigs = rawSignatures
                        .map(s => `- \`${cleanSignature(s.raw)}\` (from ${path.basename(s.path)})`)
                        .filter(s => !isSensitiveSignature(s));

                    if (safeSigs.length > 0) {
                        autoContextBlock =
                            `\n\n### Related Signatures (auto-detected, may be incomplete)\n` +
                            `NREKI resolved these external dependencies imported in this file:\n` +
                            safeSigs.join("\n");
                        extraTokens = Embedder.estimateTokens(autoContextBlock);
                        engine.incrementAutoContext();
                    }
                }
            } catch {
                // Never crash on auto-context failure
            }
        }

        if (stat.size < 1024) {
            const jitWarning = deps.chronos ? deps.chronos.getContextWarnings(resolvedPath) : "";

            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## ${path.basename(resolvedPath)} (raw - ${stat.size} bytes, below 1KB threshold)\n\n` +
                        jitWarning +
                        `\`\`\`\n${rawContent}\n\`\`\`\n\n` +
                        autoContextBlock +
                        `[NREKI: file too small to compress]`,
                }],
            };
        }

        const compress = params.compress !== false;
        const level: CompressionLevel = (typeof params.level === "string" &&
            ["light", "medium", "aggressive"].includes(params.level))
            ? params.level as CompressionLevel
            : "medium";

        if (!compress) {
            engine.markFileRead(resolvedPath);

            if (deps.chronos) deps.chronos.markReadUncompressed(resolvedPath);

            let advice = "";
            if (deps.hook) {
                const intercept = deps.hook.evaluateFileRead(resolvedPath, rawContent);
                if (intercept.shouldIntercept) {
                    advice = `\n\n${intercept.suggestion}`;
                }
            }

            const jitWarning = deps.chronos ? deps.chronos.getContextWarnings(resolvedPath) : "";

            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## ${path.basename(resolvedPath)} (raw)\n\n` +
                        jitWarning +
                        `\`\`\`\n${rawContent}\n\`\`\`\n\n` +
                        autoContextBlock +
                        `[NREKI: raw read, no compression applied]${advice}`,
                }],
            };
        }

        const result = await engine.compressFileAdvanced(resolvedPath, level, rawContent);
        engine.markFileRead(resolvedPath);
        const saved = result.tokensSaved;

        engine.logUsage(
            "nreki_read",
            Embedder.estimateTokens(result.compressed) + extraTokens,
            Embedder.estimateTokens(result.compressed) + extraTokens,
            saved,
        );

        const sessionReport = engine.getSessionReport();

        const mapHint = level === "aggressive"
            ? "See nreki_navigate action:\"map\" for full project structure. Showing only the requested code:\n\n"
            : "";

        const jitWarning = deps.chronos ? deps.chronos.getContextWarnings(resolvedPath) : "";

        return {
            content: [{
                type: "text" as const,
                text:
                    `## ${path.basename(resolvedPath)} (${level} compression)\n` +
                    `${result.originalSize.toLocaleString()} → ${result.compressedSize.toLocaleString()} chars ` +
                    `(${(result.ratio * 100).toFixed(1)}% reduction)\n\n` +
                    mapHint +
                    jitWarning +
                    `\`\`\`\n${result.compressed}\n\`\`\`\n\n` +
                    autoContextBlock +
                    `[NREKI saved ~${saved.toLocaleString()} tokens | ` +
                    `Session: ~${sessionReport.totalTokensSaved.toLocaleString()} tokens saved]`,
            }],
        };
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Error reading ${file_path}: ${(err as Error).message}\n\n[NREKI saved ~0 tokens]`,
            }],
        };
    }
}

// ─── Compress ───────────────────────────────────────────────────────

export async function handleCompress(
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    const file_path = params.path ?? "";
    let resolvedPath: string;
    try {
        resolvedPath = safePath(process.cwd(), file_path);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}\n\n[NREKI saved ~0 tokens on this query]`,
            }],
        };
    }

    try {
        const compression_level = typeof params.level === "string" &&
            ["light", "medium", "aggressive"].includes(params.level)
            ? params.level as CompressionLevel
            : undefined;

        const focus = typeof params.focus === "string" ? params.focus : undefined;

        if (compression_level) {
            const result = await engine.compressFileAdvanced(resolvedPath, compression_level);
            const saved = result.tokensSaved;
            const sessionReport = engine.getSessionReport();

            engine.logUsage(
                "nreki_compress",
                Embedder.estimateTokens(result.compressed),
                Embedder.estimateTokens(result.compressed),
                saved,
            );

            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## NREKI Advanced Compress: ${path.basename(resolvedPath)}\n` +
                        `Level: ${compression_level} | ` +
                        `${result.originalSize.toLocaleString()} → ${result.compressedSize.toLocaleString()} chars ` +
                        `(${(result.ratio * 100).toFixed(1)}% reduction)\n` +
                        `  Preprocessing: -${result.breakdown.preprocessingReduction.toLocaleString()} chars\n` +
                        `  Token filtering: -${result.breakdown.tokenFilterReduction.toLocaleString()} chars\n` +
                        `  Structural: -${result.breakdown.structuralReduction.toLocaleString()} chars\n\n` +
                        `\`\`\`\n${result.compressed}\n\`\`\`\n\n` +
                        `[NREKI saved ~${saved.toLocaleString()} tokens | ` +
                        `Session total: ~${sessionReport.totalTokensSaved.toLocaleString()} tokens ` +
                        `($${sessionReport.savedUsdSonnet.toFixed(3)} Sonnet / $${sessionReport.savedUsdOpus.toFixed(3)} Opus)]`,
                }],
            };
        }

        const tier = typeof params.tier === "number"
            ? Math.min(3, Math.max(1, params.tier)) as 1 | 2 | 3
            : 1;

        const result = await engine.compressFile(resolvedPath, tier, focus);
        const saved = result.tokensSaved;

        engine.logUsage(
            "nreki_compress",
            Embedder.estimateTokens(result.compressed),
            Embedder.estimateTokens(result.compressed),
            saved,
        );

        return {
            content: [{
                type: "text" as const,
                text:
                    `## NREKI Compressed: ${path.basename(resolvedPath)}\n` +
                    `Tier ${tier} | ${result.chunksFound} chunks | ` +
                    `${result.originalSize.toLocaleString()} → ${result.compressedSize.toLocaleString()} chars ` +
                    `(${(result.ratio * 100).toFixed(1)}% reduction)\n\n` +
                    `\`\`\`\n${result.compressed}\n\`\`\`\n\n` +
                    `[NREKI saved ~${saved.toLocaleString()} tokens on this query]`,
            }],
        };
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Error compressing ${file_path}: ${(err as Error).message}\n\n[NREKI saved ~0 tokens on this query]`,
            }],
        };
    }
}

// ─── Edit ───────────────────────────────────────────────────────────

export async function handleEdit(
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine, sandbox } = deps;
    await engine.initialize();

    const file = params.path ?? "";
    const symbol = typeof params.symbol === "string" ? params.symbol : "";
    const new_code = typeof params.new_code === "string" ? params.new_code : "";

    if (!symbol || !new_code) {
        return {
            content: [{
                type: "text" as const,
                text: `Error: "symbol" and "new_code" are required for the edit action.\n\n[NREKI saved ~0 tokens]`,
            }],
        };
    }

    let resolvedPath: string;
    try {
        resolvedPath = safePath(process.cwd(), file);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}\n\n[NREKI saved ~0 tokens]`,
            }],
            isError: true,
        };
    }

    const lockResult = acquireFileLock(resolvedPath, "nreki_code:edit");
    if (!lockResult.acquired) {
        return {
            content: [{
                type: "text" as const,
                text:
                    `## Semantic Edit: BLOCKED\n\n` +
                    `File is currently locked by a concurrent edit (${lockResult.heldBy}, ${lockResult.heldForMs}ms ago).\n` +
                    `Wait for the current edit to complete and retry.\n\n` +
                    `[NREKI saved ~0 tokens]`,
            }],
            isError: true,
        };
    }

    if (deps.chronos && deps.chronos.isHighFriction(resolvedPath)) {
        if (!deps.chronos.hasReadUncompressed(resolvedPath)) {
            releaseFileLock(resolvedPath);
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## Edit Blocked - High Friction File\n\n` +
                        `File \`${path.basename(resolvedPath)}\` has high historical error rate (high Cognitive Friction Index).\n` +
                        `You attempted a blind edit without mapping its full logic into your context.\n\n` +
                        `**ACTION REQUIRED**: Run \`nreki_code action:"read" compress:false path:"${file}"\` first.\n` +
                        `NREKI will unlock the edit once you have read the uncompressed code.\n\n` +
                        `[NREKI: Chronos edit gating active]`,
                }],
                isError: true,
            };
        }
    }

    try {
        const parser = engine.getParser();
        const mode = (typeof params.mode === "string" && ["replace", "insert_before", "insert_after"].includes(params.mode))
            ? params.mode as EditMode
            : "replace";

        const useKernel = await ensureKernelBooted(deps);

        const result = await semanticEdit(
            resolvedPath,
            symbol,
            new_code,
            parser,
            sandbox,
            mode,
            useKernel,
        );

        if (!result.success || (useKernel && !result.newContent)) {
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## Semantic Edit: FAILED\n\n` +
                        `**Symbol:** ${symbol}\n` +
                        `**File:** ${file}\n\n` +
                        `${result.error}\n\n` +
                        `[NREKI saved ~0 tokens]`,
                }],
                isError: true,
            };
        }

        // ─── NREKI Layer 2: Cross-file semantic verification ─────────
        let kernelResult: NrekiInterceptResult | undefined;
        let ttrdFeedback = "";
        if (useKernel && deps.kernel) {
            let dependentsToInject: string[] = [];
            if (deps.nrekiMode === "hologram") {
                try {
                    const relPath = path.relative(process.cwd(), resolvedPath).replace(/\\/g, "/");
                    const allDependents = await engine.findDependents(relPath);
                    if (allDependents.length <= 50) {
                        dependentsToInject = allDependents;
                    } else {
                        const oldContent = fs.readFileSync(resolvedPath, "utf-8");
                        const newContent = result.newContent!;
                        const oldExports = oldContent.split("\n").filter(l => l.trim().startsWith("export")).join("\n");
                        const newExports = newContent.split("\n").filter(l => l.trim().startsWith("export")).join("\n");
                        if (oldExports !== newExports) {
                            releaseFileLock(resolvedPath);
                            return {
                                content: [{
                                    type: "text" as const,
                                    text: `[NREKI] Edit blocked: signature change affects ${allDependents.length} files. ` +
                                        `Validating this cascade exceeds safe limits. ` +
                                        `Use batch_edit to migrate callers explicitly.`
                                }],
                                isError: true
                            };
                        }
                        dependentsToInject = [];
                    }
                } catch {
                    dependentsToInject = [];
                }
            }

            try {
                kernelResult = await deps.kernel.interceptAtomicBatch([
                    { targetFile: resolvedPath, proposedContent: result.newContent! },
                ], dependentsToInject);

                const verifyResult = await processKernelResult(
                    kernelResult,
                    [resolvedPath],
                    deps,
                    `## Semantic Edit: BLOCKED BY NREKI (Layer 2)\n\n` +
                    `**Symbol:** ${symbol}\n` +
                    `**File:** ${file}\n\n`,
                );
                if (verifyResult.response) return verifyResult.response;
                ttrdFeedback = verifyResult.ttrdFeedback;

            } catch (kernelError) {
                logger.error(`Kernel error during edit verification: ${kernelError}`);
                try { await deps.kernel.rollbackAll(); } catch (e) {
                    logger.error(`Rollback after kernel crash also failed: ${e}`);
                }
                return {
                    content: [{
                        type: "text" as const,
                        text:
                            `## Edit: KERNEL ERROR\n\n` +
                            `The edit passed AST validation (Layer 1) but the kernel crashed during ` +
                            `cross-file semantic verification (Layer 2).\n\n` +
                            `**Error:** ${kernelError}\n\n` +
                            `The file was NOT modified. The kernel has been reset.\n` +
                            `Retry the edit, or apply manually if you trust the change.\n\n` +
                            `[NREKI saved ~0 tokens]`,
                    }],
                    isError: true,
                };
            }
        }
        // ─── End NREKI Layer 2 ───────────────────────────────────────

        engine.logUsage(
            "nreki_code:edit",
            Embedder.estimateTokens(new_code),
            Embedder.estimateTokens(new_code),
            result.tokensAvoided,
        );

        let blastRadiusWarning = "";
        if (result.oldRawCode && mode === "replace") {
            try {
                const sigChanged = detectSignatureChange(result.oldRawCode, new_code);
                if (sigChanged) {
                    const relPath = path.relative(process.cwd(), resolvedPath).replace(/\\/g, "/");
                    const dependents = await engine.findDependents(relPath);
                    if (dependents.length > 0) {
                        const depList = dependents.map(d => `  - ${d}`).join("\n");
                        blastRadiusWarning =
                            `\n\n**[BLAST RADIUS]** Signature of \`${symbol}\` changed.\n` +
                            `This file is imported by:\n${depList}\n\n` +
                            `If you altered parameters or return types, use \`nreki_code action:"batch_edit"\` ` +
                            `to update those files before running tests.`;
                    }
                }
            } catch { /* non-fatal */ }
        }

        return {
            content: [{
                type: "text" as const,
                text:
                    `## Semantic Edit: SUCCESS\n\n` +
                    `**Symbol:** ${symbol}\n` +
                    `**File:** ${file}\n` +
                    `**Lines:** ${result.oldLines} → ${result.newLines}\n` +
                    `**Syntax:** validated ✓\n\n` +
                    `[NREKI saved ~${result.tokensAvoided.toLocaleString()} tokens vs native read+edit]` +
                    (kernelResult?.errorText ? `\n\n${kernelResult.errorText}` : "") +
                    (kernelResult?.warnings?.length ? `\n\n${kernelResult.warnings.join("\n")}` : "") +
                    ttrdFeedback +
                    blastRadiusWarning,
            }],
        };
    } finally {
        releaseFileLock(resolvedPath);
    }
}

// ─── Batch Edit ─────────────────────────────────────────────────────

export async function handleBatchEdit(
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine, sandbox } = deps;
    await engine.initialize();

    const edits = params.edits;
    if (!edits || edits.length === 0) {
        return {
            content: [{
                type: "text" as const,
                text: `Error: "edits" array is required for batch_edit.\n\n[NREKI saved ~0 tokens]`,
            }],
            isError: true,
        };
    }

    for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        if (!e.path || !e.symbol || !e.new_code) {
            return {
                content: [{
                    type: "text" as const,
                    text: `Error: edit[${i}] missing required fields (path, symbol, new_code).\n\n[NREKI saved ~0 tokens]`,
                }],
                isError: true,
            };
        }
    }

    const uniquePathSet = new Set<string>();
    const uniquePaths: string[] = [];
    for (const e of edits) {
        try {
            const resolved = safePath(process.cwd(), e.path);
            if (!uniquePathSet.has(resolved)) { uniquePathSet.add(resolved); uniquePaths.push(resolved); }
        } catch (err) {
            return {
                content: [{ type: "text" as const, text: `Security error in edit path "${e.path}": ${(err as Error).message}` }],
                isError: true,
            };
        }
    }

    uniquePaths.sort();
    const acquiredLocks: string[] = [];
    for (const p of uniquePaths) {
        const lock = acquireFileLock(p, "nreki_code:batch_edit");
        if (!lock.acquired) {
            for (const rp of acquiredLocks) releaseFileLock(rp);
            return {
                content: [{ type: "text" as const, text:
                    `## Batch Edit: BLOCKED\n\n` +
                    `File \`${path.relative(process.cwd(), p)}\` is locked by another edit (${lock.heldBy}, ${lock.heldForMs}ms).\n` +
                    `Wait for it to finish, then resend the full batch.\n\n[NREKI saved ~0 tokens]`
                }],
                isError: true,
            };
        }
        acquiredLocks.push(p);
    }

    if (deps.chronos) {
        for (const p of uniquePaths) {
            if (deps.chronos.isHighFriction(p) && !deps.chronos.hasReadUncompressed(p)) {
                for (const rp of acquiredLocks) releaseFileLock(rp);
                return {
                    content: [{
                        type: "text" as const,
                        text:
                            `## Edit Blocked - High Friction File\n\n` +
                            `File \`${path.relative(process.cwd(), p)}\` has high historical error rate.\n` +
                            `You MUST read it uncompressed before including it in a batch edit.\n\n` +
                            `**ACTION REQUIRED**: Run \`nreki_code action:"read" compress:false path:"${path.relative(process.cwd(), p)}"\` first.\n\n` +
                            `[NREKI: Chronos edit gating active]`,
                    }],
                    isError: true,
                };
            }
        }
    }

    try {
        const parser = engine.getParser();
        const batchOps: BatchEditOp[] = edits.map(e => ({
            path: e.path,
            symbol: e.symbol,
            new_code: e.new_code,
            mode: (e.mode && ["replace", "insert_before", "insert_after"].includes(e.mode))
                ? e.mode as EditMode
                : "replace",
        }));

        const useKernel = await ensureKernelBooted(deps);

        const result = await batchSemanticEdit(batchOps, parser, sandbox, process.cwd(), useKernel);

        if (!result.success || (useKernel && !result.vfs)) {
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## Batch Edit: TRANSACTION ABORTED\n\n` +
                        `**Edits requested:** ${result.editCount}\n` +
                        `**Files involved:** ${result.fileCount}\n\n` +
                        `${result.error}\n\n` +
                        `No files were modified.\n\n` +
                        `[NREKI saved ~0 tokens]`,
                }],
                isError: true,
            };
        }

        // ─── NREKI Layer 2: Cross-file semantic verification ─────────
        let batchTtrdFeedback = "";
        if (useKernel && deps.kernel) {
            try {
                const kernelEdits: Array<{ targetFile: string; proposedContent: string | null }> = [];
                for (const [filePath, content] of result.vfs!.entries()) {
                    kernelEdits.push({ targetFile: filePath, proposedContent: content });
                }

                let batchDependents: string[] = [];
                if (deps.nrekiMode === "hologram" && result.oldRawCodes) {
                    try {
                        const changedFiles = new Set<string>();
                        for (const edit of batchOps) {
                            if (edit.mode && edit.mode !== "replace") continue;
                            const key = `${edit.path}::${edit.symbol}`;
                            const oldRaw = result.oldRawCodes.get(key);
                            if (oldRaw && detectSignatureChange(oldRaw, edit.new_code)) {
                                changedFiles.add(
                                    path.relative(process.cwd(), safePath(process.cwd(), edit.path)).replace(/\\/g, "/")
                                );
                            }
                        }
                        if (changedFiles.size > 0) {
                            const allDepSet = new Set<string>();
                            for (const fp of changedFiles) {
                                const fileDeps2 = await engine.findDependents(fp);
                                for (const d of fileDeps2) allDepSet.add(d);
                            }
                            for (const fp of result.files) {
                                allDepSet.delete(fp);
                            }
                            if (allDepSet.size <= 50) {
                                batchDependents = [...allDepSet];
                            }
                        }
                    } catch { /* non-fatal */ }
                }

                if (kernelEdits.length > 0) {
                    const kernelResult = await deps.kernel.interceptAtomicBatch(kernelEdits, batchDependents);
                    const committedFiles = Array.from(result.vfs!.keys());

                    const verifyResult = await processKernelResult(
                        kernelResult,
                        committedFiles,
                        deps,
                        `## Batch Edit: BLOCKED BY NREKI (Layer 2)\n\n` +
                        `**Edits attempted:** ${result.editCount}\n` +
                        `**Files involved:** ${result.fileCount}\n\n`,
                    );
                    if (verifyResult.response) return verifyResult.response;
                    batchTtrdFeedback = verifyResult.ttrdFeedback;
                }
            } catch (kernelError) {
                logger.error(`Kernel error during batch verification: ${kernelError}`);
                try { await deps.kernel.rollbackAll(); } catch (e) {
                    logger.error(`Rollback after kernel crash also failed: ${e}`);
                }
                for (const rp of acquiredLocks) releaseFileLock(rp);
                return {
                    content: [{
                        type: "text" as const,
                        text:
                            `## Batch Edit: KERNEL ERROR\n\n` +
                            `All ${result.editCount} edits passed AST validation (Layer 1) but the kernel ` +
                            `crashed during cross-file semantic verification (Layer 2).\n\n` +
                            `**Error:** ${kernelError}\n\n` +
                            `No files were modified. The kernel has been reset.\n` +
                            `Retry the batch edit, or apply edits individually.\n\n` +
                            `[NREKI saved ~0 tokens]`,
                    }],
                    isError: true,
                };
            }
        }
        // ─── End NREKI Layer 2 ───────────────────────────────────────

        const fileList = result.files.map(f => `  - ${f}`).join("\n");

        let blastRadiusWarning = "";
        if (result.oldRawCodes) {
            try {
                const changedSymbols: string[] = [];
                for (const edit of batchOps) {
                    if (edit.mode && edit.mode !== "replace") continue;
                    const key = `${edit.path}::${edit.symbol}`;
                    const oldRaw = result.oldRawCodes.get(key);
                    if (oldRaw && detectSignatureChange(oldRaw, edit.new_code)) {
                        changedSymbols.push(edit.symbol);
                    }
                }
                if (changedSymbols.length > 0) {
                    const allDependents = new Set<string>();
                    for (const filePath of result.files) {
                        try {
                            const fileDeps = await engine.findDependents(filePath);
                            for (const d of fileDeps) allDependents.add(d);
                        } catch { /* non-fatal */ }
                    }
                    for (const f of result.files) allDependents.delete(f);

                    const depList = allDependents.size > 0
                        ? `\nFiles that import these modules:\n${[...allDependents].map(d => `  - ${d}`).join("\n")}\n`
                        : "";

                    blastRadiusWarning =
                        `\n\n**[BLAST RADIUS]** Signature changed for: ${changedSymbols.map(s => `\`${s}\``).join(", ")}.` +
                        depList +
                        `\nIf you altered parameters or return types, use \`nreki_code action:"batch_edit"\` to update those files before running tests.`;
                }
            } catch { /* non-fatal */ }
        }

        return {
            content: [{
                type: "text" as const,
                text:
                    `## Batch Edit: SUCCESS\n\n` +
                    `**Edits applied:** ${result.editCount}\n` +
                    `**Files modified:** ${result.fileCount}\n` +
                    `${fileList}\n\n` +
                    `All files passed syntax validation.\n` +
                    `Run \`npm run typecheck\` or your tests to verify types.\n\n` +
                    `[NREKI batch edit complete]` +
                    batchTtrdFeedback +
                    blastRadiusWarning,
            }],
        };
    } finally {
        for (const p of acquiredLocks) releaseFileLock(p);
    }
}

// ─── Undo ───────────────────────────────────────────────────────────

export async function handleUndo(
    params: CodeParams,
    _deps: RouterDependencies,
): Promise<McpToolResponse> {
    const file = params.path ?? "";
    let resolvedPath: string;
    try {
        resolvedPath = safePath(process.cwd(), file);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}\n\n[NREKI saved ~0 tokens]`,
            }],
        };
    }

    try {
        const message = restoreBackup(process.cwd(), resolvedPath);
        return {
            content: [{
                type: "text" as const,
                text: `## nreki_undo: SUCCESS\n\n${message}\n\n[NREKI: file restored]`,
            }],
        };
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `## nreki_undo: FAILED\n\n${(err as Error).message}\n\n[NREKI saved ~0 tokens]`,
            }],
        };
    }
}

// ─── Filter Output ──────────────────────────────────────────────────

export async function handleFilterOutput(
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine, circuitBreaker } = deps;

    const output = typeof params.output === "string" ? params.output : "";
    const max_lines = typeof params.max_lines === "number"
        ? Math.min(1000, Math.max(1, params.max_lines))
        : 100;

    if (!output) {
        return {
            content: [{
                type: "text" as const,
                text: `Error: "output" is required for the filter_output action.\n\n[NREKI saved ~0 tokens]`,
            }],
        };
    }

    const result = filterTerminalOutput(output, max_lines);

    engine.logUsage(
        "nreki_filter_output",
        result.filtered_tokens,
        result.filtered_tokens,
        Math.max(0, result.original_tokens - result.filtered_tokens),
    );

    let circuitWarning = "";
    if (result.error_summary.errorCount > 0) {
        const loopCheck = circuitBreaker.recordToolCall(
            "nreki_filter_output",
            output,
            result.error_summary.affectedFiles[0] ?? undefined,
        );
        if (loopCheck.tripped) {
            circuitWarning =
                "\n\n## ⚠️ CIRCUIT BREAKER TRIPPED\n" +
                `**${loopCheck.reason}**\n` +
                "**STOP all fix attempts and ask the human for guidance.**\n";
        }
    }

    const summaryLines = [
        `## Terminal Filter Results`,
        `${result.original_tokens.toLocaleString()} → ${result.filtered_tokens.toLocaleString()} tokens ` +
        `(${result.reduction_percent}% reduction)`,
        "",
    ];

    if (result.error_summary.errorCount > 0) {
        summaryLines.push(`### Error Summary`);
        summaryLines.push(`${result.error_summary.summary}`);
        summaryLines.push("");
        if (result.error_summary.uniqueErrors.length > 0) {
            summaryLines.push(`**Unique errors (${result.error_summary.uniqueErrors.length}):**`);
            for (const err of result.error_summary.uniqueErrors.slice(0, 20)) {
                summaryLines.push(`- ${err}`);
            }
            summaryLines.push("");
        }
        if (result.error_summary.affectedFiles.length > 0) {
            summaryLines.push(`**Affected files:** ${result.error_summary.affectedFiles.join(", ")}`);
            summaryLines.push("");
        }
    }

    summaryLines.push("### Filtered Output");
    summaryLines.push("```");
    summaryLines.push(result.filtered_text);
    summaryLines.push("```");

    const saved = Math.max(0, result.original_tokens - result.filtered_tokens);
    summaryLines.push("");
    summaryLines.push(`[NREKI saved ~${saved.toLocaleString()} tokens on this filter]`);

    return {
        content: [{
            type: "text" as const,
            text: summaryLines.join("\n") + circuitWarning,
        }],
    };
}
