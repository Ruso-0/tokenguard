/**
 * code/read.ts - handleRead + handleCompress handlers.
 */

import fs from "fs";
import path from "path";
import type { McpToolResponse, CodeParams, RouterDependencies } from "../../router.js";
import type { CompressionLevel } from "../../compressor.js";
import { Embedder } from "../../embedder.js";
import { safePath } from "../../utils/path-jail.js";
import { shouldProcess } from "../../utils/file-filter.js";
import { readSource } from "../../utils/read-source.js";
import { extractDependencies, cleanSignature, isSensitiveSignature } from "../../utils/imports.js";
import { tfcCompress } from "../../compressor-foveal.js";

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
        resolvedPath = safePath(engine.getProjectRoot(), file_path);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}`,
            }],
            isError: true,
        };
    }

    try {
        const stat = fs.statSync(resolvedPath);

        const filterResult = shouldProcess(resolvedPath, stat.size);
        if (!filterResult.process) {
            return {
                content: [{
                    type: "text" as const,
                    text: `File skipped: ${filterResult.reason}`,
                }],
            };
        }

        const rawContent = readSource(resolvedPath);

        const autoContext = params.auto_context === true;
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

        const lineCount = rawContent.split("\n").length;
        if (stat.size < 1024 || lineCount < 100) {
            engine.markFileRead(resolvedPath);
            if (deps.chronos) deps.chronos.markReadUncompressed(resolvedPath);
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `${path.basename(resolvedPath)} (raw, ${lineCount}L)\n\n` +
                        (deps.chronos ? deps.chronos.getContextWarnings(resolvedPath) : "") +
                        `\`\`\`\n${rawContent}\n\`\`\`\n\n` +
                        autoContextBlock,
                }],
            };
        }

        const compress = params.compress !== false;
        const level: CompressionLevel = (typeof params.level === "string" &&
            ["light", "medium", "aggressive"].includes(params.level))
            ? params.level as CompressionLevel
            : "medium";

        if (!compress) {
            const forceRaw = params._nreki_bypass === "chronos_recovery";
            const fullTokens = Embedder.estimateTokens(rawContent);

            // ─── ZERO-BOUNCE I/O (v9.0) ─────────────────────────────
            if (!forceRaw && fullTokens > 12000) {
                const zbResult = await engine.compressFileAdvanced(resolvedPath, "medium", rawContent);
                engine.markFileRead(resolvedPath);
                // CRITICAL: Do NOT call chronos.markReadUncompressed here.
                // The agent did not see the raw logic. Edit gating stays active for fragile files.

                engine.logUsage(
                    "nreki_read",
                    Embedder.estimateTokens(zbResult.compressed) + extraTokens,
                    Embedder.estimateTokens(zbResult.compressed) + extraTokens,
                    zbResult.tokensSaved,
                );

                return {
                    content: [{
                        type: "text" as const,
                        text:
                            `[AUTO-SHIELD: File >12k tokens (${fullTokens.toLocaleString()}t). Auto-compressed to 'medium'. ` +
                            `To inspect bodies, use compress with focus:"<symbol>".]\n\n` +
                            `\`\`\`\n${zbResult.compressed}\n\`\`\`` +
                            (autoContextBlock ? `\n\n${autoContextBlock}` : ""),
                    }],
                };
            }
            // ─── END ZERO-BOUNCE ─────────────────────────────────────

            engine.markFileRead(resolvedPath);

            if (deps.chronos) deps.chronos.markReadUncompressed(resolvedPath);

            const jitWarning = deps.chronos ? deps.chronos.getContextWarnings(resolvedPath) : "";

            return {
                content: [{
                    type: "text" as const,
                    text:
                        `${path.basename(resolvedPath)} (raw)\n\n` +
                        jitWarning +
                        `\`\`\`\n${rawContent}\n\`\`\`\n\n` +
                        autoContextBlock,
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

        const mapHint = level === "aggressive"
            ? "See nreki_navigate action:\"map\" for full project structure. Showing only the requested code:\n\n"
            : "";

        const jitWarning = deps.chronos ? deps.chronos.getContextWarnings(resolvedPath) : "";

        return {
            content: [{
                type: "text" as const,
                text:
                    `${path.basename(resolvedPath)} (${level} compression)\n` +
                    `${result.originalSize.toLocaleString()} → ${result.compressedSize.toLocaleString()} chars ` +
                    `(${(result.ratio * 100).toFixed(1)}% reduction)\n\n` +
                    mapHint +
                    jitWarning +
                    `\`\`\`\n${result.compressed}\n\`\`\`\n\n` +
                    autoContextBlock,
            }],
        };
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Error reading ${file_path}: ${(err as Error).message}`,
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
        resolvedPath = safePath(engine.getProjectRoot(), file_path);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}`,
            }],
            isError: true,
        };
    }

    try {
        const compression_level = typeof params.level === "string" &&
            ["light", "medium", "aggressive"].includes(params.level)
            ? params.level as CompressionLevel
            : undefined;

        const focus = typeof params.focus === "string" ? params.focus : undefined;

        // Small file bypass for compress
        if (!focus) {
            const rawForBypass = readSource(resolvedPath);
            const bypassLineCount = rawForBypass.split("\n").length;
            if (bypassLineCount < 100) {
                engine.markFileRead(resolvedPath);
                return {
                    content: [{
                        type: "text" as const,
                        text: `${path.basename(resolvedPath)} (raw, ${bypassLineCount}L — below threshold)\n\n\`\`\`\n${rawForBypass}\n\`\`\``,
                    }],
                };
            }
        }

        // TFC-PRO INJECTION
        if (focus) {
            const ext = path.extname(resolvedPath).toLowerCase();
            const isWeb = [".css", ".html", ".json"].includes(ext);

            if (!isWeb && focus && /\s/.test(focus) && !focus.includes(",")) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error: focus="${focus}" appears to be multiple symbols separated by spaces. Use comma-separated format: focus:"a,b,c". For exact strings with spaces, this validation only triggers in non-web file types.`
                    }],
                    isError: true,
                };
            }

            const content = readSource(resolvedPath);
            const tfcPayload = await tfcCompress(resolvedPath, content, focus, engine);

            if (tfcPayload.kind === "success") {
                const tfcResult = tfcPayload.data;
                engine.markFileRead(resolvedPath);

                const compressedTokens = Embedder.estimateTokens(tfcResult.compressed);
                engine.logUsage("nreki_compress_tfc",
                    compressedTokens,
                    compressedTokens,
                    tfcResult.tokensSaved
                );

                return {
                    content: [{
                        type: "text" as const,
                        text:
                            `TFC-Pro: ${path.basename(resolvedPath)} [${tfcResult.zones.foveas.join(", ")}] ` +
                            `${tfcResult.originalSize.toLocaleString()}→${tfcResult.compressedSize.toLocaleString()} chars ` +
                            `(${(tfcResult.ratio * 100).toFixed(1)}% reduction)\n` +
                            `Fovea: 100% | Upstream: ${tfcResult.zones.upstream} | Downstream: ${tfcResult.zones.localParafovea}+${tfcResult.zones.externalParafovea} | Dark: ${tfcResult.zones.darkMatterLines}L\n\n` +
                            `\`\`\`\n${tfcResult.compressed}\n\`\`\``,
                        }],
                    };
            } else if (tfcPayload.kind === "shield_tripped") {
                return {
                    content: [{
                        type: "text" as const,
                        text: `TFC-Pro shield tripped: focus "${focus}" spans >85% of file (compression ratio ${(tfcPayload.ratio * 100).toFixed(1)}%). Use action:"read" compress:false to read raw, or omit focus for aggressive compression.`
                    }],
                    isError: true,
                };
            } else {
                // kind === "not_found"
                const parser = engine.getParser();
                if (!parser.isSupported(ext)) {
                    return {
                        content: [{
                            type: "text" as const,
                            text: `TFC-Pro: language AST not supported for '${ext}'. Use action:"read" compress:false.`
                        }],
                        isError: true,
                    };
                }

                return {
                    content: [{
                        type: "text" as const,
                        text: `TFC-Pro: symbol "${focus}" not found in ${path.basename(resolvedPath)}. Run action:"outline" first to verify exact name.`
                    }],
                    isError: true,
                };
            }
        }

        if (compression_level) {
            const result = await engine.compressFileAdvanced(resolvedPath, compression_level);
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
                        `${path.basename(resolvedPath)} (${compression_level}) ` +
                        `${result.originalSize.toLocaleString()}→${result.compressedSize.toLocaleString()} chars ` +
                        `(${(result.ratio * 100).toFixed(1)}% reduction)\n\n` +
                        `\`\`\`\n${result.compressed}\n\`\`\``,
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
                    `${path.basename(resolvedPath)} (tier ${tier}, ${result.chunksFound} chunks) ` +
                    `${result.originalSize.toLocaleString()}→${result.compressedSize.toLocaleString()} chars ` +
                    `(${(result.ratio * 100).toFixed(1)}% reduction)\n\n` +
                    `\`\`\`\n${result.compressed}\n\`\`\``,
            }],
        };
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Error compressing ${file_path}: ${(err as Error).message}`,
            }],
        };
    }
}
