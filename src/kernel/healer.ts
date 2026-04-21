// src/kernel/healer.ts
import * as path from "path";
import type {
    NrekiStructuredError,
    MicroUndoState,
    HealingResult,
    TsHealingContext,
    LspHealingContext,
} from "./types.js";

import type { LspCodeAction, LspTextEdit } from "./types.js";

// Patch 5 (v10.5.9) helper: group a CodeAction's TextEdits by file,
// create savepoints for ALL affected files, then apply each file's edits
// bottom-up (descending startLine) to prevent offset drift. Returns the
// per-file micro-undo log and the files touched so the caller can
// roll back atomically on validation failure.
interface ApplyResult {
    microUndoLog: Map<string, MicroUndoState>;
    touchedFiles: string[];
    applyFailed: boolean;
}

function applyCodeActionEdits(
    bestAction: LspCodeAction,
    errorFile: string,
    ctx: LspHealingContext,
    localEditedFiles: Set<string>,
    parentEditedFiles: ReadonlySet<string>,
    newlyTouchedFiles: Set<string>,
    healUndoLog: Map<string, MicroUndoState>,
): ApplyResult | null {
    const editsByFile = new Map<string, LspTextEdit[]>();
    for (const edit of bestAction.edits) {
        const fp = ctx.resolvePath(edit.filePath || errorFile);
        if (!fp) return null;
        const arr = editsByFile.get(fp) || [];
        arr.push(edit);
        editsByFile.set(fp, arr);
    }
    if (editsByFile.size === 0) return null;

    const microUndoLog = new Map<string, MicroUndoState>();
    for (const [affectedPath] of editsByFile) {
        const state = ctx.createSavepoint(affectedPath);
        microUndoLog.set(affectedPath, state);
        if (!healUndoLog.has(affectedPath)) healUndoLog.set(affectedPath, state);
    }

    const touchedFiles: string[] = [];
    let applyFailed = false;
    for (const [affectedPath, fileEdits] of editsByFile.entries()) {
        let content: string;
        try { content = ctx.readContent(affectedPath); }
        catch { applyFailed = true; break; }

        const sorted = [...fileEdits].sort((a, b) => {
            if (a.range.start.line !== b.range.start.line) {
                return b.range.start.line - a.range.start.line;
            }
            return b.range.start.character - a.range.start.character;
        });

        for (const edit of sorted) {
            const startIdx = ctx.getLspOffset(content, edit.range.start.line, edit.range.start.character);
            const endIdx = ctx.getLspOffset(content, edit.range.end.line, edit.range.end.character);
            content = content.slice(0, startIdx) + edit.newText + content.slice(endIdx);
        }

        ctx.applyMicroPatch(affectedPath, content);
        localEditedFiles.add(affectedPath);
        if (!parentEditedFiles.has(affectedPath)) newlyTouchedFiles.add(affectedPath);
        touchedFiles.push(affectedPath);
    }

    return { microUndoLog, touchedFiles, applyFailed };
}

export async function attemptAutoHealing(
    initialErrors: NrekiStructuredError[],
    parentEditedFiles: ReadonlySet<string>,
    filesToEvaluate: Set<string>,
    ctx: TsHealingContext,
): Promise<HealingResult> {
    if (initialErrors.length === 0) {
        return { healed: false, appliedFixes: [], newlyTouchedFiles: new Set(), finalErrors: initialErrors };
    }

    const MAX_ITERATIONS = 10;
    const fixDescriptions = new Set<string>();
    const localEditedFiles = new Set(parentEditedFiles);
    const newlyTouchedFiles = new Set<string>();
    const healUndoLog = new Map<string, MicroUndoState>();
    const failedFixHashes = new Set<string>();

    let currentErrors: NrekiStructuredError[] = initialErrors;
    let iteration = 0;

    while (currentErrors.length > 0 && iteration < MAX_ITERATIONS) {
        let appliedAnyFix = false;

        for (const error of currentErrors) {
            const fixes = await ctx.getAutoFixes(error.file, error);
            if (fixes.length === 0) continue;
            const bestFix = fixes[0];
            const fixHash = `${error.file}:${error.line}:${bestFix.description}`;
            if (failedFixHashes.has(fixHash)) continue;

            const microUndoLog = new Map<string, MicroUndoState>();
            for (const change of bestFix.changes) {
                const state = ctx.createSavepoint(change.filePath);
                microUndoLog.set(change.filePath, state);
                if (!healUndoLog.has(change.filePath)) healUndoLog.set(change.filePath, state);
            }

            for (const change of bestFix.changes) {
                let content = ctx.readContent(change.filePath);
                const sorted = [...change.textChanges].sort((a, b) => b.start - a.start);
                for (const tc of sorted) {
                    content = content.slice(0, tc.start) + tc.newText + content.slice(tc.start + tc.length);
                }
                ctx.applyMicroPatch(change.filePath, content);
                localEditedFiles.add(change.filePath);
                if (!parentEditedFiles.has(change.filePath)) newlyTouchedFiles.add(change.filePath);
            }

            const evalSet = new Set(filesToEvaluate);
            for (const f of localEditedFiles) evalSet.add(f);
            const newErrors = await ctx.recompileAndEvaluate(evalSet, localEditedFiles);

            if (newErrors.length >= currentErrors.length) {
                await ctx.executeRollback(microUndoLog, false);
                for (const [p] of microUndoLog) {
                    if (!parentEditedFiles.has(p)) localEditedFiles.delete(p);
                    newlyTouchedFiles.delete(p);
                }
                failedFixHashes.add(fixHash);
            } else {
                const preview = bestFix.changes.map(c => {
                    const file = path.basename(c.filePath);
                    const texts = c.textChanges.map(t => t.newText.trim()).filter(Boolean);
                    return `${file}: [${texts.join(", ")}]`;
                }).join(" | ");
                fixDescriptions.add(`- ${bestFix.description} -> \`${preview}\``);
                appliedAnyFix = true;
                currentErrors = newErrors;
                break;
            }
        }

        if (!appliedAnyFix) break;
        iteration++;
    }

    if (currentErrors.length > 0) {
        if (healUndoLog.size > 0) {
            await ctx.executeRollback(healUndoLog, true);
        }
        ctx.recordStat(false);
        return { healed: false, appliedFixes: [], newlyTouchedFiles: new Set(), finalErrors: initialErrors };
    }

    ctx.recordStat(true);
    return { healed: true, appliedFixes: Array.from(fixDescriptions), newlyTouchedFiles, finalErrors: [] };
}

export async function attemptLspAutoHealing(
    initialErrors: NrekiStructuredError[],
    parentEditedFiles: ReadonlySet<string>,
    ctx: LspHealingContext,
): Promise<HealingResult> {
    if (initialErrors.length === 0 || ctx.isDead()) {
        return { healed: false, appliedFixes: [], newlyTouchedFiles: new Set(), finalErrors: initialErrors };
    }

    const MAX_ITERATIONS = 2;
    const fixDescriptions = new Set<string>();
    const localEditedFiles = new Set(parentEditedFiles);
    const newlyTouchedFiles = new Set<string>();
    const healUndoLog = new Map<string, MicroUndoState>();
    const failedFixHashes = new Set<string>();

    let currentErrors = initialErrors;
    let iteration = 0;

    while (currentErrors.length > 0 && iteration < MAX_ITERATIONS) {
        let appliedAnyFix = false;

        for (const error of currentErrors) {
            const lspRange = {
                start: { line: error.line - 1, character: Math.max(0, error.column - 1) },
                end: { line: error.line - 1, character: error.column },
            };
            const diagnostic = {
                range: lspRange,
                message: error.message,
                code: error.code.replace(`${ctx.languageId}-`, ""),
            };

            // AUDIT FIX (Patch 5 / v10.5.9): ALL TextEdits of the chosen
            // CodeAction apply atomically. Pre-fix applied only one TextEdit,
            // triggering a doom-loop when the fix required coupled edits.
            let actions: LspCodeAction[];
            try { actions = await ctx.requestCodeActions(error.file, diagnostic); }
            catch { continue; }
            if (!actions || actions.length === 0) continue;

            const safeActions = actions.filter((a) => {
                const title = (a.title || "").toLowerCase();

                // Ice Wall: reject destructive actions
                if (title.includes("remove") || title.includes("delete")) return false;

                // Anti-Sweep Shield: reject suppression actions disguised as fixes.
                // basedpyright offers "Add `# pyright: ignore[...]`" which would
                // silence errors rather than fix them. Same for noqa, disable,
                // suppress patterns across other linters.
                if (title.includes("ignore") || title.includes("disable") ||
                    title.includes("suppress") || title.includes("noqa")) {
                    return false;
                }

                // Accept structural additions (real imports)
                return title.includes("import") || title.includes("add ");
            });
            if (safeActions.length === 0) continue;

            const bestAction = safeActions[0];
            if (!bestAction) continue;
            const fixDesc = bestAction.title || `Add import in ${path.basename(error.file)}`;
            const fixHash = `${error.file}:${error.line}:${fixDesc}`;
            if (failedFixHashes.has(fixHash)) continue;

            const applyRes = applyCodeActionEdits(
                bestAction, error.file, ctx,
                localEditedFiles, parentEditedFiles, newlyTouchedFiles, healUndoLog,
            );
            if (!applyRes) { failedFixHashes.add(fixHash); continue; }
            const { microUndoLog, touchedFiles, applyFailed } = applyRes;

            if (applyFailed) {
                await ctx.executeRollback(microUndoLog, false);
                for (const p of touchedFiles) {
                    if (!parentEditedFiles.has(p)) localEditedFiles.delete(p);
                    newlyTouchedFiles.delete(p);
                }
                failedFixHashes.add(fixHash);
                continue;
            }

            let newErrors: NrekiStructuredError[];
            try { newErrors = await ctx.validateLspEdits(localEditedFiles); }
            catch { newErrors = currentErrors; }

            if (newErrors.length >= currentErrors.length) {
                await ctx.executeRollback(microUndoLog, false);
                for (const p of touchedFiles) {
                    if (!parentEditedFiles.has(p)) localEditedFiles.delete(p);
                    newlyTouchedFiles.delete(p);
                }
                failedFixHashes.add(fixHash);
            } else {
                fixDescriptions.add(`- LSP Auto-Heal (${ctx.languageId}): ${fixDesc}`);
                appliedAnyFix = true;
                currentErrors = newErrors;
                break;
            }
        }

        if (!appliedAnyFix) break;
        iteration++;
    }

    if (currentErrors.length > 0) {
        if (healUndoLog.size > 0) {
            await ctx.executeRollback(healUndoLog, true);
        }
        ctx.recordStat(false);
        return { healed: false, appliedFixes: [], newlyTouchedFiles: new Set(), finalErrors: initialErrors };
    }

    ctx.recordStat(true);
    return { healed: true, appliedFixes: Array.from(fixDescriptions), newlyTouchedFiles, finalErrors: [] };
}
