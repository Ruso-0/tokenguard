/**
 * ts-compiler-wrapper.ts - TypeScript Compiler Wrapper
 *
 * Private wrapper encapsulating TypeScript compiler infrastructure.
 * Uses the "Strada" pattern: Build -> LanguageService -> CompilerHost.
 *
 * The wrapper is a pure computation slave: it computes diagnostics
 * but has no authority over the VFS or disk. The NrekiKernel
 * orchestrates all state transitions.
 *
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 *
 * Compiler Architecture:
 *   CompilerHost → BuilderProgram → LanguageService
 *   One DocumentRegistry shared across all instances.
 */

import * as ts from "typescript";
import * as path from "path";
import * as crypto from "crypto";
// ─── Inlined Types (formerly in language-backend.ts) ────────────────

export interface BackendCapabilities {
    supportsAutoHealing: boolean;
    supportsTTRD: boolean;
}

export interface BackendFix {
    description: string;
    changes: Array<{
        filePath: string;
        textChanges: Array<{ start: number; length: number; newText: string }>;
    }>;
}

export interface VfsAdapter {
    readFile(fileName: string): string | undefined;
    fileExists(fileName: string): boolean;
    getModifiedTime(fileName: string): Date;
    directoryExists(dirName: string): boolean;
    getScriptVersion(fileName: string): string;
    getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined;
}
import type { NrekiStructuredError, PreEditContract, TypeRegression } from "../nreki-kernel.js";
import { escapeRegExp } from "../../utils/imports.js";
import { toPosix as toPosixUtil } from "../../utils/to-posix.js";
import { logger } from "../../utils/logger.js";

// ─── Environment file classifier (copied from kernel) ─────────────
const ENV_FILE_BASENAMES = new Set([
    "tsconfig.json", "jsconfig.json", "package.json",
    "jest.config.ts", "jest.config.js", "jest.config.mjs",
    "vitest.config.ts", "vitest.config.js", "vitest.config.mts",
    "webpack.config.js", "webpack.config.ts",
    "vite.config.ts", "vite.config.js", "vite.config.mts",
    "rollup.config.js", "rollup.config.ts", "rollup.config.mjs",
    "eslint.config.js", "eslint.config.mjs",
    ".eslintrc.json", ".eslintrc.js",
    "prettier.config.js", ".prettierrc.json",
    "babel.config.js", "babel.config.json",
    "next.config.js", "next.config.mjs", "next.config.ts",
    "tailwind.config.js", "tailwind.config.ts",
]);

const isEnvironmentFile = (filePath: string): boolean => {
    const base = path.basename(filePath).toLowerCase();
    return base.endsWith(".d.ts") || base.startsWith(".") || ENV_FILE_BASENAMES.has(base);
};

export class TsCompilerWrapper {
    readonly name = "TypeScript-Strada";

    readonly capabilities: BackendCapabilities = {
        supportsAutoHealing: true,
        supportsTTRD: true,
    };

    // ─── Compiler State (owned by backend, referenced by kernel) ───
    public compilerOptions!: ts.CompilerOptions;
    public rootNames!: Set<string>;
    public tsBuildInfoPath!: string;

    // ─── Compiler Infrastructure (owned by backend, referenced by kernel) ───
    public host!: ts.CompilerHost;
    public originalReadFile!: (fileName: string) => string | undefined;
    public originalFileExists!: (fileName: string) => boolean;
    public documentRegistry!: ts.DocumentRegistry;
    public languageService!: ts.LanguageService;

    // ─── Stored from createCompilerInfra for recovery paths ───
    private projectRoot!: string;
    private vfsAdapter?: VfsAdapter;

    // ─── Compiler Lifecycle (moved from kernel) ───
    private builderProgram?: ts.EmitAndSemanticDiagnosticsBuilderProgram;
    private editCount = 0;
    private gcThreshold = 100;
    private isStateCorrupted = false;

    // ─── Diagnostic State (moved from kernel) ───
    private baselineFrequencies = new Map<string, number>();
    private lastRawDiagnostics: ts.Diagnostic[] = [];

    // POSIX normalization — delegates to shared utility
    private toPosix(p: string): string { return toPosixUtil(p); }

    // Pre-compiled regexes for getFingerprint (avoids 3 RegExp per diagnostic)
    private rootRegex?: RegExp;
    private nativeRootRegex?: RegExp;
    private nativePosixRegex?: RegExp;

    /**
     * Read tsconfig.json and initialize compilerOptions + rootNames.
     * Extracted from NrekiKernel.initConfig().
     *
     * Called by kernel.boot() and kernel.rollbackAll().
     * The kernel copies references after this call.
     */
    public initConfig(projectRoot: string): void {
        const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, "tsconfig.json");
        if (!configPath) throw new Error("[NREKI] Config error: tsconfig.json not found.");
        const parsed = ts.parseJsonConfigFileContent(
            ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, projectRoot
        );
        this.compilerOptions = parsed.options;
        this.rootNames = new Set(
            parsed.fileNames.map((f) => this.toPosix(path.resolve(projectRoot, f)))
        );

        // Incremental cache: set tsBuildInfoFile so TS knows where to read/write
        const nrekiDir = path.join(projectRoot, ".nreki");
        this.tsBuildInfoPath = this.toPosix(path.join(nrekiDir, "cache.tsbuildinfo"));
        this.compilerOptions.tsBuildInfoFile = this.tsBuildInfoPath;
        this.compilerOptions.incremental = true;
    }

    /**
     * Create the TypeScript CompilerHost with VFS overrides.
     * The VfsAdapter callbacks are owned by the kernel — the backend
     * only READS through them. The kernel's VFS, hologram state,
     * and JIT cache stay in the kernel.
     *
     * Also creates DocumentRegistry and LanguageService.
     *
     * Extracted from NrekiKernel.boot().
     */
    public createCompilerInfra(
        projectRoot: string,
        vfsAdapter: VfsAdapter,
    ): void {
        this.projectRoot = projectRoot;
        this.vfsAdapter = vfsAdapter;

        // Create base host from TS
        this.host = ts.createIncrementalCompilerHost(this.compilerOptions, ts.sys);

        // Save originals for fallback (kernel closures use these via tsBackend)
        this.originalReadFile = this.host.readFile;
        this.originalFileExists = this.host.fileExists;

        // Override with VfsAdapter (kernel's eyes)
        this.host.readFile = (fileName: string): string | undefined => {
            // .tsbuildinfo bypasses VFS — it's infrastructure
            if (fileName.endsWith(".tsbuildinfo")) {
                return this.originalReadFile.call(this.host, fileName);
            }
            return vfsAdapter.readFile(fileName);
        };

        this.host.fileExists = (fileName: string): boolean => {
            return vfsAdapter.fileExists(fileName);
        };

        (this.host as any).getModifiedTime = (fileName: string): Date => {
            return vfsAdapter.getModifiedTime(fileName);
        };

        this.host.directoryExists = (dirName: string): boolean => {
            return vfsAdapter.directoryExists(dirName);
        };

        // DocumentRegistry
        this.documentRegistry = ts.createDocumentRegistry(
            ts.sys.useCaseSensitiveFileNames,
            projectRoot,
        );

        // LanguageService
        this.languageService = ts.createLanguageService({
            getCompilationSettings: () => this.compilerOptions,
            getScriptFileNames: () => Array.from(this.rootNames),
            getScriptVersion: (fileName: string) => vfsAdapter.getScriptVersion(fileName),
            getScriptSnapshot: (fileName: string) => vfsAdapter.getScriptSnapshot(fileName),
            getCurrentDirectory: () => projectRoot,
            getDefaultLibFileName: (options: ts.CompilerOptions) => ts.getDefaultLibFilePath(options),
            fileExists: this.host.fileExists,
            readFile: this.host.readFile,
            directoryExists: this.host.directoryExists,
            readDirectory: ts.sys.readDirectory,
        }, this.documentRegistry);
    }

    /**
     * Create a LanguageServiceHost using the stored VfsAdapter.
     * Used by updateProgram() during recovery (recreate after corruption).
     * Extracted from NrekiKernel.createLSHost().
     */
    public createLSHost(): ts.LanguageServiceHost {
        if (!this.vfsAdapter) {
            throw new Error("[NREKI] Cannot create LSHost: VfsAdapter not initialized. Call createCompilerInfra first.");
        }
        return {
            getCompilationSettings: () => this.compilerOptions,
            getScriptFileNames: () => Array.from(this.rootNames),
            getScriptVersion: (fileName: string) => this.vfsAdapter!.getScriptVersion(fileName),
            getScriptSnapshot: (fileName: string) => this.vfsAdapter!.getScriptSnapshot(fileName),
            getCurrentDirectory: () => this.projectRoot,
            getDefaultLibFileName: (options: ts.CompilerOptions) => ts.getDefaultLibFilePath(options),
            fileExists: this.host.fileExists,
            readFile: this.host.readFile,
            directoryExists: this.host.directoryExists,
            readDirectory: ts.sys.readDirectory,
        };
    }

    /**
     * Rebuild the incremental TypeScript program.
     * Handles corruption recovery (recreate DocumentRegistry + LanguageService)
     * and periodic GC (kill builder every N edits).
     *
     * Extracted from NrekiKernel.updateProgram().
     */
    public updateProgram(): void {
        if (this.isStateCorrupted) {
            logger.warn("Purging builder and LanguageService after early exit. Warm rebuild ~2-5s.");
            this.builderProgram = undefined;

            this.documentRegistry = ts.createDocumentRegistry(
                ts.sys.useCaseSensitiveFileNames,
                this.projectRoot
            );
            this.languageService = ts.createLanguageService(this.createLSHost(), this.documentRegistry);

            this.isStateCorrupted = false;
        } else if (++this.editCount >= this.gcThreshold) {
            this.builderProgram = undefined;
            this.editCount = 0;
        }
        this.builderProgram = ts.createEmitAndSemanticDiagnosticsBuilderProgram(
            Array.from(this.rootNames), this.compilerOptions, this.host,
            this.builderProgram // undefined after purge = fresh rebuild with cached files
        );
    }

    /**
     * Release cached AST data for files that have been mutated.
     * mutatedFiles is owned by the kernel — passed as parameter.
     *
     * Extracted from NrekiKernel.releaseMutatedDocuments().
     */
    public releaseMutatedDocuments(mutatedFiles: Set<string>): void {
        if (!this.documentRegistry || mutatedFiles.size === 0) return;

        const registryKey = this.documentRegistry.getKeyForCompilationSettings(
            this.compilerOptions
        );

        for (const file of mutatedFiles) {
            try {
                const scriptKind =
                    file.endsWith(".tsx") ? ts.ScriptKind.TSX :
                    file.endsWith(".jsx") ? ts.ScriptKind.JSX :
                    file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs") ? ts.ScriptKind.JS :
                    ts.ScriptKind.TS;
                this.documentRegistry.releaseDocumentWithKey(
                    file as ts.Path,
                    registryKey,
                    scriptKind,
                    undefined,
                );
            } catch { /* Best effort: version may already be released */ }
        }
        mutatedFiles.clear();
    }

    /**
     * Kill the compiler cache. Called by the Orchestrator when a transaction
     * fails or times out.
     *
     * markCorrupted=false: warm rebuild (just kill incremental cache)
     * markCorrupted=true: full rebuild (recreate DR + LS on next updateProgram)
     */
    public purgeCache(markCorrupted: boolean = false): void {
        this.builderProgram = undefined;
        this.isStateCorrupted = markCorrupted;
    }

    // ─── Diagnostic Methods (moved from kernel) ───

    private getFingerprint(diag: ts.Diagnostic): string {
        const file = diag.file
            ? this.toPosix(path.resolve(this.projectRoot, diag.file.fileName))
            : "GLOBAL";
        let msg = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
        // FIX: Use pre-compiled regexes instead of creating 3 new RegExp per diagnostic.
        if (!this.rootRegex) {
            const nativeRoot = path.resolve(this.projectRoot);
            const nativePosix = nativeRoot.replace(/\\/g, "/");
            this.rootRegex = new RegExp(escapeRegExp(this.projectRoot), "ig");
            this.nativeRootRegex = new RegExp(escapeRegExp(nativeRoot), "ig");
            this.nativePosixRegex = new RegExp(escapeRegExp(nativePosix), "ig");
        }
        msg = msg.replace(this.rootRegex, "<ROOT>");
        msg = msg.replace(this.nativeRootRegex!, "<ROOT>");
        msg = msg.replace(this.nativePosixRegex!, "<ROOT>");
        return crypto.createHash("sha256").update(`${file}|TS${diag.code}|${msg}`).digest("hex");
    }

    private toStructured(diag: ts.Diagnostic): NrekiStructuredError {
        const pos = diag.file && diag.start != null
            ? ts.getLineAndCharacterOfPosition(diag.file, diag.start)
            : { line: 0, character: 0 };
        return {
            file: diag.file
                ? this.toPosix(path.relative(this.projectRoot, diag.file.fileName))
                : "global",
            line: pos.line + 1,
            column: pos.character + 1,
            code: `TS${diag.code}`,
            message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
        };
    }

    public captureBaseline(targetFiles: Set<string> | undefined, mode: string): void {
        this.baselineFrequencies.clear();
        if (!this.builderProgram) return;
        const program = this.builderProgram.getProgram();
        const processDiag = (diag: ts.Diagnostic) => {
            const hash = this.getFingerprint(diag);
            this.baselineFrequencies.set(hash, (this.baselineFrequencies.get(hash) || 0) + 1);
        };

        if (mode === "project") {
            for (const file of program.getSourceFiles()) {
                for (const diag of program.getSyntacticDiagnostics(file)) processDiag(diag);
                // Use program.getSemanticDiagnostics(file) per file instead of
                // builderProgram.getSemanticDiagnostics() to avoid consuming the
                // builder's stateful affected-file iterator.
                for (const diag of program.getSemanticDiagnostics(file)) processDiag(diag);
            }
            for (const diag of program.getGlobalDiagnostics()) processDiag(diag);
            return;
        }

        const filesToScan = targetFiles
            ? Array.from(targetFiles)
                .map(p => program.getSourceFile(p))
                .filter((sf): sf is ts.SourceFile => sf !== undefined)
            : Array.from(program.getSourceFiles());

        for (const sf of filesToScan) {
            for (const diag of program.getSyntacticDiagnostics(sf)) processDiag(diag);
            for (const diag of program.getSemanticDiagnostics(sf)) processDiag(diag);
        }
        for (const diag of program.getGlobalDiagnostics()) processDiag(diag);
    }

    public getBaselineErrorCount(): number {
        let total = 0;
        for (const count of this.baselineFrequencies.values()) total += count;
        return total;
    }

    // ─── TTRD Methods (moved from kernel) ───

    private getToxicityScoreFromType(
        type: ts.Type,
        checker: ts.TypeChecker,
        depth: number = 0,
        visited: Set<ts.Type> = new Set()
    ): number {
        if (depth > 3) return 0;
        if (type.flags & ts.TypeFlags.Object) {
            if (visited.has(type)) return 0;
            visited.add(type);
        }

        let score = 0;

        if (type.flags & ts.TypeFlags.Any) score += 10;
        else if (type.flags & ts.TypeFlags.Unknown) score += 2;

        if (type.symbol && type.symbol.name === "Function") score += 5;

        for (const sig of type.getCallSignatures()) {
            for (const param of sig.parameters) {
                const paramDecl = param.valueDeclaration || param.declarations?.[0];
                const paramType = paramDecl
                    ? checker.getTypeOfSymbolAtLocation(param, paramDecl)
                    : checker.getDeclaredTypeOfSymbol(param);
                score += this.getToxicityScoreFromType(paramType, checker, depth + 1, visited);
            }
            score += this.getToxicityScoreFromType(sig.getReturnType(), checker, depth + 1, visited);
        }

        if (type.flags & ts.TypeFlags.Object) {
            for (const prop of type.getProperties()) {
                const propDecl = prop.valueDeclaration || prop.declarations?.[0];
                const propType = propDecl
                    ? checker.getTypeOfSymbolAtLocation(prop, propDecl)
                    : checker.getDeclaredTypeOfSymbol(prop);
                score += this.getToxicityScoreFromType(propType, checker, depth + 1, visited);
            }
        }

        const typeRef = type as ts.TypeReference;
        if (typeRef.typeArguments) {
            for (const arg of typeRef.typeArguments) {
                score += this.getToxicityScoreFromType(arg, checker, depth + 1, visited);
            }
        }

        if (type.isUnionOrIntersection()) {
            for (const sub of type.types) {
                score += this.getToxicityScoreFromType(sub, checker, depth + 1, visited);
            }
        }

        return score;
    }

    async extractCanonicalTypes(files: Set<string>): Promise<Map<string, Map<string, PreEditContract>>> {
        const contracts = new Map<string, Map<string, PreEditContract>>();
        if (!this.builderProgram) return contracts;

        const program = this.builderProgram.getProgram();
        const checker = program.getTypeChecker();

        for (const posixPath of files) {
            const sf = program.getSourceFile(posixPath);
            if (!sf) continue;

            const fileSymbol = checker.getSymbolAtLocation(sf);
            if (!fileSymbol || !fileSymbol.exports) continue;

            const fileContracts = new Map<string, PreEditContract>();
            const exports = checker.getExportsOfModule(fileSymbol);

            for (const exp of exports) {
                const decl = exp.valueDeclaration || exp.declarations?.[0];
                if (!decl || decl.getSourceFile().fileName !== posixPath) continue;

                let type: ts.Type;
                if (exp.flags & ts.SymbolFlags.TypeAlias || exp.flags & ts.SymbolFlags.Interface) {
                    type = checker.getDeclaredTypeOfSymbol(exp);
                } else {
                    type = checker.getTypeOfSymbolAtLocation(exp, decl);
                }

                const toxicity = this.getToxicityScoreFromType(type, checker);
                const isUntyped = (type.flags & ts.TypeFlags.Any) !== 0 || (type.flags & ts.TypeFlags.Unknown) !== 0;

                let typeStr = checker.typeToString(type, undefined, ts.TypeFormatFlags.UseFullyQualifiedType);
                const cleanType = typeStr.replace(/\s+/g, " ");
                const safeType = cleanType.length > 150 ? cleanType.substring(0, 147) + "..." : cleanType;

                fileContracts.set(exp.getName(), { typeStr: safeType, toxicity, isUntyped });
            }
            if (fileContracts.size > 0) contracts.set(posixPath, fileContracts);
        }
        return contracts;
    }

    public computeTypeRegressions(
        preContracts: Map<string, Map<string, PreEditContract>>,
        postContracts: Map<string, Map<string, PreEditContract>>
    ): TypeRegression[] {
        const regressions: TypeRegression[] = [];

        for (const [filePath, preSymbols] of preContracts.entries()) {
            const postSymbols = postContracts.get(filePath);
            if (!postSymbols) continue;

            for (const [symbol, oldData] of preSymbols.entries()) {
                const newData = postSymbols.get(symbol);
                if (!newData) continue;

                if (newData.toxicity > oldData.toxicity || (newData.isUntyped && !oldData.isUntyped)) {
                    regressions.push({
                        filePath, symbol,
                        oldType: oldData.typeStr,
                        newType: newData.typeStr,
                    });
                }
            }

            // DETECT NEW TOXIC EXPORTS injected by AI to bypass TTRD
            for (const [symbol, newData] of postSymbols.entries()) {
                if (preSymbols.has(symbol)) continue;
                if (newData.toxicity > 0 || newData.isUntyped) {
                    regressions.push({
                        filePath, symbol,
                        oldType: "(new export)",
                        newType: newData.typeStr,
                    });
                }
            }
        }

        // Detect toxic exports in entirely NEW files
        for (const [filePath, postSymbols] of postContracts.entries()) {
            if (preContracts.has(filePath)) continue;
            for (const [symbol, newData] of postSymbols.entries()) {
                if (newData.toxicity > 0 || newData.isUntyped) {
                    regressions.push({
                        filePath, symbol,
                        oldType: "(new file)",
                        newType: newData.typeStr,
                    });
                }
            }
        }

        return regressions;
    }

    /** @internal Strangler Fig bridge: inject pre-loaded builderProgram from cache */
    public _injectBuilderProgram(program: ts.EmitAndSemanticDiagnosticsBuilderProgram): void {
        this.builderProgram = program;
    }

    // ─── Temporary Bridge Getters (Strangler Fig) ───
    // These exist ONLY so the kernel can access compiler state
    // for methods not yet migrated (captureBaseline, getFatalErrors,
    // extractCanonicalTypes, attemptAutoHealing, predictBlastRadius).
    // They will be DELETED when those methods move to the backend.

    get tsBuilder(): ts.EmitAndSemanticDiagnosticsBuilderProgram | undefined {
        return this.builderProgram;
    }

    get tsProgram(): ts.Program | undefined {
        return this.builderProgram?.getProgram();
    }

    get tsLanguageService(): ts.LanguageService {
        return this.languageService;
    }

    get isCorrupted(): boolean {
        return this.isStateCorrupted;
    }

    // ─── Bridge for attemptAutoHealing (deleted in Act 5) ───
    get tsLastDiagnostics(): ts.Diagnostic[] {
        return this.lastRawDiagnostics;
    }

    get baselineCount(): number {
        return this.baselineFrequencies.size;
    }



    async getDiagnostics(
        filesToEvaluate: Set<string>,
        explicitlyEditedFiles?: Set<string>,
        mode?: string,
    ): Promise<NrekiStructuredError[]> {
        if (!this.builderProgram) return [];

        const editedFiles = explicitlyEditedFiles || filesToEvaluate;
        const currentMode = mode || "project";

        const currentFrequencies = new Map<string, number>();
        const fatalErrors: ts.Diagnostic[] = [];
        const program = this.builderProgram.getProgram();

        const errorThreshold = Math.min(500, 50 + (editedFiles.size * 20));
        const touchedEnvironment = Array.from(editedFiles).some(isEnvironmentFile);

        const processDiag = (diag: ts.Diagnostic) => {
            if (!diag.file && !touchedEnvironment) return;
            const hash = this.getFingerprint(diag);
            const count = (currentFrequencies.get(hash) || 0) + 1;
            currentFrequencies.set(hash, count);
            if (count > (this.baselineFrequencies.get(hash) || 0)) {
                fatalErrors.push(diag);
            }
        };

        // Shield 1: Global diagnostics
        if (touchedEnvironment) {
            for (const diag of program.getGlobalDiagnostics()) processDiag(diag);
            for (const diag of program.getOptionsDiagnostics()) processDiag(diag);
        }

        // Shield 2: Syntactic + Semantic
        for (const posixPath of filesToEvaluate) {
            const sf = program.getSourceFile(posixPath);
            if (sf) {
                if (editedFiles.has(posixPath)) {
                    for (const diag of program.getSyntacticDiagnostics(sf)) processDiag(diag);
                }
                if (currentMode === "file" || currentMode === "hologram") {
                    for (const diag of program.getSemanticDiagnostics(sf)) processDiag(diag);
                }
            }
        }

        // Shield 3: PROJECT mode cascade
        if (currentMode === "project") {
            let cascadeCount = 0;
            let nextAffected: ts.AffectedFileResult<readonly ts.Diagnostic[]>;

            while ((nextAffected = this.builderProgram!.getSemanticDiagnosticsOfNextAffectedFile())) {
                for (const diag of nextAffected.result as ts.Diagnostic[]) {
                    processDiag(diag);
                    if (diag.file && !editedFiles.has(this.toPosix(diag.file.fileName))) {
                        cascadeCount++;
                    }
                }
                if (cascadeCount > errorThreshold) {
                    this.isStateCorrupted = true;
                    // Include first 5 cascade errors so the LLM can diagnose the root cause
                    const cascadeSample = fatalErrors
                        .filter(d => d.file && !editedFiles.has(this.toPosix(d.file.fileName)))
                        .slice(0, 5)
                        .map(d => this.toStructured(d));
                    const sampleText = cascadeSample.length > 0
                        ? `\nSample: ${cascadeSample.map(e => `${e.file}:${e.line} ${e.code} ${e.message.slice(0, 80)}`).join(" | ")}`
                        : "";
                    fatalErrors.push({
                        file: undefined,
                        start: undefined,
                        length: undefined,
                        category: ts.DiagnosticCategory.Error,
                        code: 9999,
                        messageText:
                            `Cascade exceeded threshold (${errorThreshold}). ` +
                            `${cascadeCount} errors in non-edited files. Edit rejected.${sampleText}`,
                    });
                    break;
                }
            }
        }

        // Store raw diagnostics for attemptAutoHealing bridge (until Act 5)
        this.lastRawDiagnostics = fatalErrors;

        return fatalErrors.map(d => this.toStructured(d));
    }

    // Safe fix whitelist: only 100% structural fixes that don't mutate business logic.
    // Safe fix whitelist: only 100% structural fixes that don't mutate business logic.
    // REMOVED: fixClassDoesntImplementInheritedAbstractMember — inserts throw stubs
    // REMOVED: fixAddMissingMember — inserts throw stubs
    // Both generate `throw new Error("Method not implemented.")` which compiles
    // but crashes unconditionally at runtime. Better to return the error to the LLM.
    private static readonly SAFE_FIXES = new Set([
        "import",
        "fixMissingImport",
        "fixAwaitInSyncFunction",
        "fixPromiseResolve",
        "fixMissingProperties",
        "fixAddOverrideModifier",
    ]);

    async getAutoFixes(filePath: string, error: NrekiStructuredError): Promise<BackendFix[]> {
        if (!this.languageService) return [];

        // Find the matching raw diagnostic (need byte offsets for TS API)
        const errorCode = Number(error.code.replace("TS", ""));
        // FIX: Match by line+column too. Without this, duplicate error codes
        // (e.g., two TS2304 in the same file) always return the first diagnostic,
        // causing the healer to apply the wrong fix in an infinite micro-rollback loop.
        const rawDiag = this.lastRawDiagnostics.find(d => {
            if (!d.file || d.code !== errorCode || d.start === undefined || d.length === undefined) return false;
            const matchPath = this.toPosix(d.file.fileName) === filePath || this.toPosix(d.file.fileName).endsWith("/" + filePath);
            if (!matchPath) return false;
            const pos = ts.getLineAndCharacterOfPosition(d.file, d.start);
            return (pos.line + 1) === error.line && (pos.character + 1) === error.column;
        });

        if (!rawDiag || rawDiag.start === undefined || rawDiag.length === undefined || !rawDiag.file) {
            return [];
        }

        const posixPath = this.toPosix(rawDiag.file.fileName);
        const formatOptions = ts.getDefaultFormatCodeSettings();
        const preferences: ts.UserPreferences = {};

        const tsFixes = this.languageService.getCodeFixesAtPosition(
            posixPath, rawDiag.start, rawDiag.start + rawDiag.length,
            [errorCode], formatOptions, preferences
        );

        const results: BackendFix[] = [];
        for (const fix of tsFixes) {
            if (!TsCompilerWrapper.SAFE_FIXES.has(fix.fixName)) continue;

            results.push({
                description: fix.description,
                changes: fix.changes.map(change => ({
                    filePath: this.toPosix(change.fileName),
                    textChanges: change.textChanges.map(tc => ({
                        start: tc.span.start,
                        length: tc.span.length,
                        newText: tc.newText,
                    })),
                })),
            });
        }

        return results;
    }


}
