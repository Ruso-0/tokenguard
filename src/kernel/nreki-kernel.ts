import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { isSensitivePath } from "../utils/path-jail.js";
import { readSource } from "../utils/read-source.js";
import { escapeRegExp } from "../utils/imports.js";

// ─── Async FIFO Mutex (P10) ────────────────────────────────────────

export class AsyncMutex {
    private queue: (() => void)[] = [];
    private locked = false;

    async lock(queueTimeoutMs: number = 60_000): Promise<() => void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer: NodeJS.Timeout;
            const release = () => {
                if (this.queue.length > 0) this.queue.shift()!();
                else this.locked = false;
            };
            const doResolve = () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(release);
                }
            };
            if (!this.locked) {
                this.locked = true;
                doResolve();
            } else {
                timer = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        const idx = this.queue.indexOf(doResolve);
                        if (idx !== -1) this.queue.splice(idx, 1);
                        reject(new Error(`[NREKI] Mutex queue timeout after ${queueTimeoutMs}ms - deadlock prevented`));
                    }
                }, queueTimeoutMs);
                this.queue.push(doResolve);
            }
        });
    }

    async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
        const unlock = await this.lock();
        try {
            return await Promise.resolve().then(fn);
        } finally {
            unlock();
        }
    }
}

// ─── Types ─────────────────────────────────────────────────────────

export interface NrekiStructuredError {
    file: string; line: number; column: number; code: string; message: string;
}

export interface NrekiEdit {
    targetFile: string; proposedContent: string | null;
}

export interface TypeRegression {
    filePath: string;
    symbol: string;
    oldType: string;
    newType: string;
}

export interface NrekiInterceptResult {
    safe: boolean; exitCode: number; latencyMs?: string;
    structured?: NrekiStructuredError[]; errorText?: string;
    healedFiles?: string[]; // Extra files touched by the Auto-Healer (for nreki_undo backups)
    regressions?: TypeRegression[];
    postContracts?: Map<string, Map<string, string>>;
}

export type NrekiMode = "auto" | "syntax" | "file" | "project" | "hologram";

// ─── Environment file classifier (Performance Modes) ─────────────
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

// ─── NREKI Kernel ─────────────────────────────────────────────────
//
// Cross-file semantic and syntactic verification for AI coding agents.
// Uses the TypeScript Compiler API with a Virtual File System in RAM.
// Validates edits before they touch disk. Rolls back on failure.
//
// @author Jherson Eddie Tintaya Holguin (Ruso-0)

interface PreEditContract {
    typeStr: string;    // Visual truncado para logs (150 chars max)
    toxicity: number;   // Toxicidad exacta via TypeFlags O(1)
    isUntyped: boolean; // true si el tipo es bare any o unknown
}

export class NrekiKernel {
    private projectRoot!: string;
    private vfs = new Map<string, string | null>();
    private vfsDirectories = new Set<string>();
    private vfsClock = new Map<string, Date>();
    private logicalTime = Date.now();

    private baselineFrequencies = new Map<string, number>();
    private mutex = new AsyncMutex();
    private editCount = 0;
    private gcThreshold = 100;

    private compilerOptions!: ts.CompilerOptions;
    private rootNames!: Set<string>;
    private host!: ts.CompilerHost;
    private originalReadFile!: (fileName: string) => string | undefined;
    private originalFileExists!: (fileName: string) => boolean;
    private builderProgram?: ts.EmitAndSemanticDiagnosticsBuilderProgram;
    private booted = false;
    private _healingStats = { applied: 0, failed: 0 };

    /** Read-only view of healing statistics. */
    public get healingStats(): Readonly<{ applied: number; failed: number }> {
        return { applied: this._healingStats.applied, failed: this._healingStats.failed };
    }
    private languageService!: ts.LanguageService;
    private documentRegistry!: ts.DocumentRegistry;
    private mutatedFiles = new Set<string>();
    private bootErrorCount: number = -1;
    private tsBuildInfoPath!: string;

    // Performance Modes
    public mode: "file" | "project" | "hologram" = "project";
    private isStateCorrupted = false;

    /** Max file size for JIT classification. Files larger than this are
     *  skipped to prevent synchronous event loop blocking during
     *  TypeScript's module resolution (readFileSync + Tree-sitter parse). */
    private static readonly JIT_MAX_FILE_SIZE = 150_000; // 150KB

    // ─── Hologram mode ─────────────────────────────────
    private prunedFiles = new Set<string>();
    private shadowContent = new Map<string, string>();  // tsPath -> .d.ts content
    private ambientFiles: string[] = [];
    private currentEditTargets = new Set<string>();
    // O(1) pre-computed lookups (built once in setShadows, rebuilt after harvest)
    private shadowDtsLookup = new Set<string>();   // .d.ts paths that exist as shadows
    private prunedTsLookup = new Set<string>();    // .ts paths that are hidden

    // ─── JIT Holography (v6.1) ─────────────────────────────────
    // On-demand shadow generation: no upfront scan needed
    private jitMode = false;           // true when booting without pre-computed shadows
    private jitParser?: any;           // web-tree-sitter Parser instance
    private jitTsLanguage?: any;       // web-tree-sitter Language for TypeScript
    private jitClassifiedCache = new Set<string>();  // tsPath → already classified
    private jitClassifyFn?: (filePath: string, content: string, parser: any, lang: any) => { prunable: boolean; shadow: string | null };

    // P26: POSIX normalization -TS uses forward slashes internally
    private toPosix(p: string): string {
        return path.normalize(p).replace(/\\/g, "/");
    }

    // P30: Only TypeScript-compatible files enter rootNames
    private isTypeScriptFile(filePath: string): boolean {
        // A-05: Specific patterns (d.ts) before general (tsx?) to avoid shadowing
        return /\.(d\.ts|d\.mts|d\.cts|tsx?|jsx?|mts|mjs|cts|cjs)$/i.test(filePath);
    }

    // DRY: Config loading used by boot() and rollbackAll()
    private initConfig(): void {
        const configPath = ts.findConfigFile(this.projectRoot, ts.sys.fileExists, "tsconfig.json");
        if (!configPath) throw new Error("[NREKI] Config error: tsconfig.json not found.");
        const parsed = ts.parseJsonConfigFileContent(
            ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, this.projectRoot
        );
        this.compilerOptions = parsed.options;
        this.rootNames = new Set(
            parsed.fileNames.map((f) => this.toPosix(path.resolve(this.projectRoot, f)))
        );

        // Incremental cache: set tsBuildInfoFile so TS knows where to read/write
        const nrekiDir = path.join(this.projectRoot, ".nreki");
        this.tsBuildInfoPath = this.toPosix(path.join(nrekiDir, "cache.tsbuildinfo"));
        this.compilerOptions.tsBuildInfoFile = this.tsBuildInfoPath;
        this.compilerOptions.incremental = true;
    }

    /** Validate cache against current TS version. Returns true if cache is usable. */
    private validateBuildInfoCache(): boolean {
        const versionFile = path.join(path.dirname(this.tsBuildInfoPath), "ts-version");
        try {
            if (!fs.existsSync(this.tsBuildInfoPath)) return false;
            if (!fs.existsSync(versionFile)) {
                fs.unlinkSync(this.tsBuildInfoPath);
                return false;
            }
            const cached = fs.readFileSync(versionFile, "utf-8").trim();
            if (cached !== ts.version) {
                fs.unlinkSync(this.tsBuildInfoPath);
                console.error(`[NREKI] TS version changed (${cached} -> ${ts.version}). Cache purged.`);
                return false;
            }
            return true;
        } catch {
            return false; // First boot or corrupted cache
        }
    }

    /**
     * Release cached AST data for files that have been mutated.
     * Uses releaseDocumentWithKey + getKeyForCompilationSettings to
     * precisely target the correct registry bucket. Prevents
     * DocumentRegistry from accumulating stale AST versions.
     */
    private releaseMutatedDocuments(): void {
        if (!this.documentRegistry || this.mutatedFiles.size === 0) return;

        const registryKey = this.documentRegistry.getKeyForCompilationSettings(
            this.compilerOptions
        );

        for (const file of this.mutatedFiles) {
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
        this.mutatedFiles.clear();
    }

    /** Write TS version guard file alongside the cache. */
    private writeTsVersionGuard(): void {
        const dir = path.dirname(this.tsBuildInfoPath);
        const versionFile = path.join(dir, "ts-version");
        try {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(versionFile, ts.version, "utf-8");
        } catch { /* Non-fatal */ }
    }

    /**
     * Boot the kernel. Applies CompilerHost overrides for VFS I/O.
     * Cost: ~5-10s for initial semantic graph. Runs in background.
     */
    public boot(workspacePath: string, mode?: "file" | "project" | "hologram"): void {
        if (this.booted) throw new Error("[NREKI] Kernel already booted");
        if (mode) this.mode = mode;
        console.error(`[NREKI] Booting VFS-LSP Kernel (${this.mode} mode). Applying CompilerHost overrides...`);
        this.projectRoot = this.toPosix(path.resolve(workspacePath));
        this.initConfig();

        // Hologram mode: override rootNames and compilerOptions
        if (this.mode === "hologram") {
            if (this.hasJitHologram() && this.prunedFiles.size === 0) {
                // JIT mode: no pre-computed shadows. Keep only .d.ts from rootNames.
                this.jitMode = true;
                this.rootNames = new Set(
                    [...this.rootNames].filter(f => f.endsWith(".d.ts")),
                );
                console.error(`[NREKI] JIT Holography active. rootNames: ${this.rootNames.size} (.d.ts only). Shadows on-demand.`);
            } else {
                // Eager mode: pre-computed shadows available
                this.jitMode = false;
                const ambientSet = new Set(
                    this.ambientFiles.map(f => this.toPosix(path.resolve(this.projectRoot, f))),
                );
                this.rootNames = new Set(
                    [...this.rootNames].filter(f => ambientSet.has(f)),
                );
            }
            // CompilerOptions: always set for hologram
            this.compilerOptions.noEmit = false;
            this.compilerOptions.declaration = true;
            this.compilerOptions.emitDeclarationOnly = true;
            this.compilerOptions.isolatedModules = false;
        }

        this.host = ts.createIncrementalCompilerHost(this.compilerOptions, ts.sys);

        const originalReadFile = this.host.readFile;
        const originalFileExists = this.host.fileExists;
        this.originalReadFile = originalReadFile;
        this.originalFileExists = originalFileExists;
        const originalGetModifiedTime = (this.host as any).getModifiedTime || ts.sys.getModifiedTime;
        const originalDirectoryExists = this.host.directoryExists || ts.sys.directoryExists;

        // VFS override: read from RAM staging first, fallthrough to disk
        this.host.readFile = (fileName: string): string | undefined => {
            // VFS bypass: .tsbuildinfo is infrastructure, not source code
            if (fileName.endsWith(".tsbuildinfo")) {
                return originalReadFile.call(this.host, fileName);
            }
            const posixPath = this.toPosix(path.resolve(this.projectRoot, fileName));

            // HOLOGRAM INTERCEPT: serve shadow .d.ts or hide pruned .ts
            if (this.mode === "hologram") {
                if (fileName.endsWith(".d.ts")) {
                    // Map .d.ts path back to .ts to find shadow content
                    const tsPath = posixPath.replace(/\.d\.ts$/, ".ts");
                    const shadow = this.shadowContent.get(tsPath);
                    if (shadow !== undefined) return shadow;
                    // Try .tsx variant
                    const tsxPath = posixPath.replace(/\.d\.ts$/, ".tsx");
                    const shadow2 = this.shadowContent.get(tsxPath);
                    if (shadow2 !== undefined) return shadow2;
                    // JIT fallback: classify on-demand if not yet cached
                    if (this.jitMode) {
                        if (!this.jitClassifiedCache.has(tsPath)) {
                            this.jitClassifyFile(tsPath);
                            const shadowJ = this.shadowContent.get(tsPath);
                            if (shadowJ !== undefined) return shadowJ;
                        }
                        if (!this.jitClassifiedCache.has(tsxPath)) {
                            this.jitClassifyFile(tsxPath);
                            const shadowJ2 = this.shadowContent.get(tsxPath);
                            if (shadowJ2 !== undefined) return shadowJ2;
                        }
                    }
                }
                // Pruned .ts: hide from compiler (returns undefined)
                if (this.prunedTsLookup.has(posixPath) && !this.currentEditTargets.has(posixPath)) {
                    return undefined;
                }
            }

            if (this.vfs.has(posixPath)) {
                const content = this.vfs.get(posixPath);
                return content === null ? undefined : content;
            }
            // A10: Block sensitive files from disk fallback (unified with path-jail blocklist)
            if (isSensitivePath(fileName)) {
                return undefined;
            }
            return originalReadFile.call(this.host, fileName);
        };

        this.host.fileExists = (fileName: string): boolean => {
            const posixPath = this.toPosix(path.resolve(this.projectRoot, fileName));

            // HOLOGRAM INTERCEPT: shadow .d.ts exists, pruned .ts does not
            if (this.mode === "hologram") {
                // Target file being edited: always real
                if (this.currentEditTargets.has(posixPath)) {
                    return originalFileExists.call(this.host, fileName);
                }
                // Pre-computed or previously JIT'd
                if (this.prunedTsLookup.has(posixPath)) return false;
                if (this.shadowDtsLookup.has(posixPath)) return true;

                // ── JIT: classify on-demand ──
                if (this.jitMode) {
                    // TS asks for a .ts/.tsx → classify, maybe hide it
                    if (/\.tsx?$/.test(fileName) && !fileName.endsWith(".d.ts")) {
                        if (originalFileExists.call(this.host, fileName)) {
                            this.jitClassifyFile(posixPath);
                            if (this.prunedTsLookup.has(posixPath)) return false;
                        }
                    }
                    // TS asks for a .d.ts → check if we can generate a shadow
                    if (fileName.endsWith(".d.ts")) {
                        const tsPath = posixPath.replace(/\.d\.ts$/, ".ts");
                        const tsxPath = posixPath.replace(/\.d\.ts$/, ".tsx");
                        if (!this.jitClassifiedCache.has(tsPath) && originalFileExists.call(this.host, tsPath)) {
                            if (this.jitClassifyFile(tsPath)) return true;
                        }
                        if (!this.jitClassifiedCache.has(tsxPath) && originalFileExists.call(this.host, tsxPath)) {
                            if (this.jitClassifyFile(tsxPath)) return true;
                        }
                    }
                }
            }

            if (this.vfs.has(posixPath)) return this.vfs.get(posixPath) !== null;
            return originalFileExists.call(this.host, fileName);
        };

        // P8: Monotonic clock forces cache invalidation
        (this.host as any).getModifiedTime = (fileName: string): Date => {
            const posixPath = this.toPosix(path.resolve(this.projectRoot, fileName));
            if (this.vfsClock.has(posixPath)) return this.vfsClock.get(posixPath)!;
            return originalGetModifiedTime ? originalGetModifiedTime.call(ts.sys, fileName)! : new Date();
        };

        // P31 + E1: Virtual directory resolution in O(1)
        this.host.directoryExists = (dirName: string): boolean => {
            const posixDir = this.toPosix(path.resolve(this.projectRoot, dirName));
            if (originalDirectoryExists.call(ts.sys, dirName)) return true;
            return this.vfsDirectories.has(posixDir);
        };

        // ─── LanguageService: VS Code's brain connected to our VFS ───
        this.documentRegistry = ts.createDocumentRegistry(
            ts.sys.useCaseSensitiveFileNames,
            this.projectRoot
        );
        this.languageService = ts.createLanguageService(this.createLSHost(), this.documentRegistry);
        // ──────────────────────────────────────────────────────────────

        // Incremental cache: try to load previous build state for warm boot
        if (this.validateBuildInfoCache()) {
            try {
                const readBuildHost: ts.ReadBuildProgramHost = {
                    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
                    getCurrentDirectory: () => this.projectRoot,
                    readFile: (fileName: string) => {
                        // Always read .tsbuildinfo from disk
                        if (fileName.endsWith(".tsbuildinfo")) {
                            return ts.sys.readFile(fileName);
                        }
                        return this.host.readFile(fileName);
                    },
                };
                this.builderProgram = ts.readBuilderProgram(
                    this.compilerOptions, readBuildHost
                ) as ts.EmitAndSemanticDiagnosticsBuilderProgram | undefined;
            } catch {
                this.builderProgram = undefined; // Corrupted cache, cold boot
            }
        }

        this.updateProgram();
        // Hologram/file mode: skip boot baseline - JIT baseline in interceptAtomicBatch
        // handles it scoped to target files.
        if (this.mode === "project") {
            this.captureBaseline();
        }
        // D2: Clean orphaned transaction backups from previous crashes
        const txDir = path.join(this.projectRoot, ".nreki", "transactions");
        if (fs.existsSync(txDir)) {
            try { fs.rmSync(txDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }

        // Capture initial error count at boot (immutable after this point)
        this.bootErrorCount = this.getBaselineErrorCount();

        this.booted = true;
        console.error(
            `[NREKI] Kernel booted. Tracking ${this.rootNames.size} files. ` +
            `Baseline: ${this.baselineFrequencies.size} invariants. ` +
            `Boot errors: ${this.bootErrorCount}.`
        );
    }

    public isBooted(): boolean {
        return this.booted;
    }

    private createLSHost(): ts.LanguageServiceHost {
        return {
            getCompilationSettings: () => this.compilerOptions,
            getScriptFileNames: () => Array.from(this.rootNames),
            getScriptVersion: (fileName) => {
                const posixPath = this.toPosix(path.resolve(this.projectRoot, fileName));
                return this.vfsClock.get(posixPath)?.getTime().toString() || "1";
            },
            getScriptSnapshot: (fileName) => {
                const posixPath = this.toPosix(path.resolve(this.projectRoot, fileName));

                // HOLOGRAM INTERCEPT: serve shadow content for .d.ts
                if (this.mode === "hologram" && fileName.endsWith(".d.ts")) {
                    const tsPath = posixPath.replace(/\.d\.ts$/, ".ts");
                    const shadow = this.shadowContent.get(tsPath);
                    if (shadow !== undefined) return ts.ScriptSnapshot.fromString(shadow);
                    const tsxPath = posixPath.replace(/\.d\.ts$/, ".tsx");
                    const shadow2 = this.shadowContent.get(tsxPath);
                    if (shadow2 !== undefined) return ts.ScriptSnapshot.fromString(shadow2);
                }

                if (this.vfs.has(posixPath)) {
                    const content = this.vfs.get(posixPath);
                    if (content === null || content === undefined) return undefined;
                    return ts.ScriptSnapshot.fromString(content);
                }
                if (!this.originalFileExists.call(this.host, fileName)) return undefined;
                const content = this.originalReadFile.call(this.host, fileName);
                if (!content) return undefined;
                return ts.ScriptSnapshot.fromString(content);
            },
            getCurrentDirectory: () => this.projectRoot,
            getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
            fileExists: this.host.fileExists,
            readFile: this.host.readFile,
            directoryExists: this.host.directoryExists,
            readDirectory: ts.sys.readDirectory,
        };
    }

    // P11 + P19: Periodic GC with counter reset
    private updateProgram(): void {
        // Purge corrupted builder after early exit
        if (this.isStateCorrupted) {
            console.error("[NREKI] Purging builder and LanguageService after early exit. Warm rebuild ~2-5s.");
            this.builderProgram = undefined;

            // FIX OOM: DocumentRegistry retains AST references from the corrupted
            // builder. Recreating it allows V8 GC to reclaim the dead ASTs.
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

    // P9 + P15: Position-independent fingerprint with path sanitization
    private getFingerprint(diag: ts.Diagnostic): string {
        const file = diag.file
            ? this.toPosix(path.resolve(this.projectRoot, diag.file.fileName))
            : "GLOBAL";
        let msg = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
        const nativeRoot = path.resolve(this.projectRoot);
        const nativePosix = nativeRoot.replace(/\\/g, "/");
        msg = msg.replace(new RegExp(escapeRegExp(this.projectRoot), "ig"), "<ROOT>");
        msg = msg.replace(new RegExp(escapeRegExp(nativeRoot), "ig"), "<ROOT>");
        msg = msg.replace(new RegExp(escapeRegExp(nativePosix), "ig"), "<ROOT>");
        return crypto.createHash("sha256").update(`${file}|TS${diag.code}|${msg}`).digest("hex");
    }


    // P9 + P28: Baseline captures syntactic + global + semantic errors
    private captureBaseline(targetFiles?: Set<string>): void {
        this.baselineFrequencies.clear();
        if (!this.builderProgram) return;
        const program = this.builderProgram.getProgram();
        const processDiag = (diag: ts.Diagnostic) => {
            const hash = this.getFingerprint(diag);
            this.baselineFrequencies.set(hash, (this.baselineFrequencies.get(hash) || 0) + 1);
        };

        if (this.mode === "project") {
            // Project mode: full global baseline (existing behavior, unchanged)
            for (const file of program.getSourceFiles()) {
                for (const diag of program.getSyntacticDiagnostics(file)) processDiag(diag);
            }
            for (const diag of program.getGlobalDiagnostics()) processDiag(diag);
            for (const diag of this.builderProgram.getSemanticDiagnostics()) processDiag(diag);
            return;
        }

        // Hologram / File mode: JIT local baseline
        // Only scan the files we are about to mutate or evaluate. ~0.05s instead of ~5.3s.
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

    // ─── NREKI L3.3: Centralized Semantic Evaluation ───────────────
    /**
     * Re-evaluates the current AST and returns only errors that exceed the original baseline.
     * Centralizes the 3 NREKI shields logic. Mode-aware: file mode skips cascade,
     * project mode evaluates full cascade with early exit.
     *
     * PRECONDITION: this.updateProgram() MUST have been called before this method.
     * WARNING: getSemanticDiagnosticsOfNextAffectedFile() is a stateful iterator.
     *          Do NOT call this method twice without updateProgram() in between.
     */
    private getFatalErrors(explicitlyEditedFiles: Set<string>, filesToEvaluate: Set<string>): ts.Diagnostic[] {
        const currentFrequencies = new Map<string, number>();
        const fatalErrors: ts.Diagnostic[] = [];
        const program = this.builderProgram!.getProgram();

        // Elastic threshold: base 50 + 20 per file in a batch edit.
        const errorThreshold = 50 + (explicitlyEditedFiles.size * 20);

        const touchedEnvironment = Array.from(explicitlyEditedFiles).some(isEnvironmentFile);

        const processDiag = (diag: ts.Diagnostic) => {
            // Global diagnostic + no environment file touched = noise. Skip.
            if (!diag.file && !touchedEnvironment) return;

            const hash = this.getFingerprint(diag);
            const count = (currentFrequencies.get(hash) || 0) + 1;
            currentFrequencies.set(hash, count);
            if (count > (this.baselineFrequencies.get(hash) || 0)) {
                fatalErrors.push(diag);
            }
        };

        // Shield 1: Global diagnostics - only if environment was touched
        if (touchedEnvironment) {
            for (const diag of program.getGlobalDiagnostics()) processDiag(diag);
            for (const diag of program.getOptionsDiagnostics()) processDiag(diag);
        }

        // Shield 2: Syntactic (edited files only) + Semantic (all evaluated files)
        for (const posixPath of filesToEvaluate) {
            const sf = program.getSourceFile(posixPath);
            if (sf) {
                // Syntactic: only on files the LLM actually edited
                if (explicitlyEditedFiles.has(posixPath)) {
                    for (const diag of program.getSyntacticDiagnostics(sf)) processDiag(diag);
                }
                // Semantic: on ALL evaluated files (edited + dependents)
                if (this.mode === "file" || this.mode === "hologram") {
                    for (const diag of program.getSemanticDiagnostics(sf)) processDiag(diag);
                }
            }
        }

        // Shield 3: PROJECT mode - full cascade evaluation with early exit
        if (this.mode === "project") {
            let cascadeCount = 0;
            let nextAffected: ts.AffectedFileResult<readonly ts.Diagnostic[]>;

            while ((nextAffected = this.builderProgram!.getSemanticDiagnosticsOfNextAffectedFile())) {
                for (const diag of nextAffected.result as ts.Diagnostic[]) {
                    processDiag(diag);
                    if (diag.file && !explicitlyEditedFiles.has(this.toPosix(diag.file.fileName))) {
                        cascadeCount++;
                    }
                }

                // Early exit: enough evidence to reject the edit.
                // The TypeScript BuilderProgram iterator is now in a partial state.
                // Flag it for cleanup in updateProgram().
                if (cascadeCount > errorThreshold) {
                    this.isStateCorrupted = true;
                    fatalErrors.push({
                        file: undefined,
                        start: undefined,
                        length: undefined,
                        category: ts.DiagnosticCategory.Error,
                        code: 9999,
                        messageText:
                            `Cascade exceeded threshold (${errorThreshold}). ` +
                            `${cascadeCount} errors in non-edited files. Edit rejected.`,
                    });
                    break;
                }
            }
        }

        return fatalErrors;
    }

    // ─── TTRD: Temporal Type Regression Detection ─────────────────────

    /**
     * Extract the compiler's resolved type for each locally-declared export.
     * Uses TypeChecker to read resolved types, not AST text.
     * Cost: O(K) where K = exports in the given files only.
     */
    private extractCanonicalTypes(files: Set<string>): Map<string, Map<string, PreEditContract>> {
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
                // Only process symbols declared in this file.
                // Skips re-exports from barrel files (export * from './x')
                // to prevent expanding thousands of transitive symbols.
                const decl = exp.valueDeclaration || exp.declarations?.[0];
                if (!decl || decl.getSourceFile().fileName !== posixPath) continue;

                let type: ts.Type;
                if (exp.flags & ts.SymbolFlags.TypeAlias || exp.flags & ts.SymbolFlags.Interface) {
                    type = checker.getDeclaredTypeOfSymbol(exp);
                } else {
                    type = checker.getTypeOfSymbolAtLocation(exp, decl);
                }

                // MATH TRUTH: Calculate toxicity from TypeFlags bits, not strings
                const toxicity = this.getToxicityScoreFromType(type, checker);
                const isUntyped = (type.flags & ts.TypeFlags.Any) !== 0 || (type.flags & ts.TypeFlags.Unknown) !== 0;

                // Visual string for human logs only (truncated safely — never used for scoring)
                let typeStr = checker.typeToString(type, undefined, ts.TypeFormatFlags.UseFullyQualifiedType);
                const cleanType = typeStr.replace(/\s+/g, " ");
                const safeType = cleanType.length > 150 ? cleanType.substring(0, 147) + "..." : cleanType;

                fileContracts.set(exp.getName(), { typeStr: safeType, toxicity, isUntyped });
            }
            if (fileContracts.size > 0) contracts.set(posixPath, fileContracts);
        }
        return contracts;
    }

    /**
     * Check if a type string contains toxic type patterns.
     * Uses word boundaries to avoid false positives on identifiers
     * like "Company" or "ManyToMany".
     *
     * Shared with file fragility tracker via static method.
     */
    public static isToxicType(typeStr: string): boolean {
        const s = typeStr.trim();
        // Bare empty types
        if (s === "object" || s.replace(/\s/g, "") === "{}") return true;
        // Toxic keywords anywhere in the type string (handles parameters, returns, generics)
        if (/\b(any|unknown|Function)\b/.test(s)) return true;
        return false;
    }

    /**
     * Walk a ts.Type tree and compute a toxicity score using TypeFlags.
     * No regex. No string matching. Reads bits directly from the TypeChecker.
     *
     * Asymmetric weights:
     *   any = 10 (disables all checking)
     *   unknown = 2 (safe but unresolved)
     *   Function = 5 (callable but untyped)
     *
     * Depth limit prevents CPU freeze on deeply nested types (Prisma, tRPC).
     * Cycle-safe via Set<ts.Type> pointer comparison (TS interns types).
     */
    private getToxicityScoreFromType(
        type: ts.Type,
        checker: ts.TypeChecker,
        depth: number = 0,
        visited: Set<ts.Type> = new Set()
    ): number {
        if (depth > 3) return 0;
        // FIX SINGLETONS: Only track Object types in visited for cycle prevention.
        // Primitive singletons (any, unknown, string, number) are shared instances
        // in the TS compiler. Adding them to visited would skip scoring after
        // the first occurrence, making (a: any, b: any) score the same as (a: any).
        if (type.flags & ts.TypeFlags.Object) {
            if (visited.has(type)) return 0;
            visited.add(type);
        }

        let score = 0;

        // Direct flag checks -O(1) bit operations
        if (type.flags & ts.TypeFlags.Any) score += 10;
        else if (type.flags & ts.TypeFlags.Unknown) score += 2;

        // Global Function interface
        if (type.symbol && type.symbol.name === "Function") score += 5;

        // Walk function signatures (parameters + return type)
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

        // Walk object properties (interfaces, classes, object literals)
        if (type.flags & ts.TypeFlags.Object) {
            for (const prop of type.getProperties()) {
                const propDecl = prop.valueDeclaration || prop.declarations?.[0];
                const propType = propDecl
                    ? checker.getTypeOfSymbolAtLocation(prop, propDecl)
                    : checker.getDeclaredTypeOfSymbol(prop);
                score += this.getToxicityScoreFromType(propType, checker, depth + 1, visited);
            }
        }

        // Walk generic type arguments (Promise<any>, Map<string, any>)
        const typeRef = type as ts.TypeReference;
        if (typeRef.typeArguments) {
            for (const arg of typeRef.typeArguments) {
                score += this.getToxicityScoreFromType(arg, checker, depth + 1, visited);
            }
        }

        // Walk union and intersection types
        if (type.isUnionOrIntersection()) {
            for (const sub of type.types) {
                score += this.getToxicityScoreFromType(sub, checker, depth + 1, visited);
            }
        }

        return score;
    }


    /**
     * Compare pre-edit and post-edit resolved types using toxicity scoring.
     *
     * Uses TypeFlags-based scoring for post-edit types (zero false positives)
     * and string-based fallback for pre-edit types (compiler state is gone).
     *
     * Asymmetric weights ensure unknown→any is always detected:
     *   unknown=2, any=10. Score delta = 8. Regression fires.
     */
    private computeTypeRegressions(
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

    // ─── NREKI L3.3: Self-Healing Agent Loop ─────────────────────────

    /**
     * Iterative AST healing engine.
     * Repairs structural errors one by one, incrementally recompiling
     * the universe in RAM between each fix to ensure perfect byte offsets.
     * If a fix causes cascade, performs micro-rollback and discards it.
     *
     * Strict Entropy Reduction Invariant:
     *   |E(S₀ + Δ)| ≤ |E₀| - 1
     *   Any patch resulting in ≥ |E₀| errors is reverted in O(1).
     *
     * Fixed bugs:
     *   BUG 1: String(diag.code) → safe Number cast (TS expects number[])
     *   BUG 2: explicitlyEditedFiles mutated by reference → cloned on entry
     *   BUG 3: getSemanticDiagnosticsOfNextAffectedFile is stateful → compute ONCE
     *   BUG 4: new Map(this.vfs) copied entire VFS → micro-UndoLog O(touched files)
     *   BUG 5: localEditedFiles.delete(p) in micro-rollback blinded Shield 2 →
     *          only delete files the healer added, never the LLM's files
     */
    private attemptAutoHealing(
        initialErrors: ts.Diagnostic[],
        parentEditedFiles: Set<string>,
        filesToEvaluate: Set<string>
    ): { healed: boolean; appliedFixes: string[]; newlyTouchedFiles: Set<string>; finalErrors: ts.Diagnostic[] } {
        if (!this.languageService || initialErrors.length === 0) {
            return { healed: false, appliedFixes: [], newlyTouchedFiles: new Set(), finalErrors: initialErrors };
        }

        const formatOptions = ts.getDefaultFormatCodeSettings();
        const preferences: ts.UserPreferences = {};

        // Safe fix whitelist: only 100% structural fixes that don't mutate business logic.
        // fixAwaitInSyncFunction is an optimistic lock: if it causes cascade, the invariant aborts it.
        // fixOverrideModifier: the actual internal name in TS 5.x is "fixAddOverrideModifier".
        const SAFE_FIXES = new Set([
            "import",                                         // TS2304: Cannot find name → add import
            "fixMissingImport",                               // TS2686: Alternative internal name
            "fixAwaitInSyncFunction",                         // TS1308: LLM wrote await but forgot async
            "fixPromiseResolve",                              // Wraps returns in Promise.resolve()
            "fixMissingProperties",                           // TS2739/TS2741: Incomplete interfaces
            "fixClassDoesntImplementInheritedAbstractMember", // TS2515: Abstract classes
            "fixAddMissingMember",                            // TS2339: Property declarations
            "fixAddOverrideModifier",                         // TS4114: Add 'override' keyword
        ]);

        const MAX_ITERATIONS = 10; // Safety limit against infinite loops (redundant due to the invariant, but safe)
        const fixDescriptions = new Set<string>(); // Deduplicator

        // BUG 2 FIXED: Clone the scan set to isolate caller state
        const localEditedFiles = new Set(parentEditedFiles);
        const newlyTouchedFiles = new Set<string>();

        // BUG 4 FIXED: Micro-UndoLog - only copies files the healer touches, not the entire VFS
        const healUndoLog = new Map<string, {
            content: string | null | undefined; time: Date | undefined; wasInRoot: boolean;
        }>();

        // Blacklist: avoid retrying fixes that already caused cascade at the same coordinate
        const failedFixHashes = new Set<string>();

        let currentErrors = initialErrors;
        let iteration = 0;

        // Fix iteration loop: Evaluate → Patch 1 → Recompile → Repeat
        while (currentErrors.length > 0 && iteration < MAX_ITERATIONS) {
            let appliedAnyFix = false;

            for (const diag of currentErrors) {
                if (!diag.file || diag.start === undefined || diag.length === undefined) continue;

                const posixPath = this.toPosix(path.resolve(this.projectRoot, diag.file.fileName));

                // BUG 1 FIXED: diag.code may come as string. getCodeFixesAtPosition expects number[].
                const errorCode = typeof diag.code === "number" ? diag.code : Number(diag.code);

                const fixes = this.languageService.getCodeFixesAtPosition(
                    posixPath, diag.start, diag.start + diag.length, [errorCode], formatOptions, preferences
                );

                const safeFix = fixes.find(f => SAFE_FIXES.has(f.fixName));

                if (safeFix) {
                    const fixHash = `${posixPath}:${diag.start}:${safeFix.fixName}`;
                    if (failedFixHashes.has(fixHash)) continue;

                    // Backup state before applying fix (rollback if fix increases errors)
                    const microUndoLog = new Map<string, {
                        content: string | null | undefined; time: Date | undefined; wasInRoot: boolean;
                    }>();

                    for (const change of safeFix.changes) {
                        const changePath = this.toPosix(path.resolve(this.projectRoot, change.fileName));
                        const state = {
                            content: this.vfs.has(changePath) ? this.vfs.get(changePath) : undefined,
                            time: this.vfsClock.get(changePath),
                            wasInRoot: this.rootNames.has(changePath),
                        };
                        microUndoLog.set(changePath, state);

                        // Macro-UndoLog: save original state ONLY the first time during entire healing
                        if (!healUndoLog.has(changePath)) healUndoLog.set(changePath, state);
                    }

                    // Apply fix to VFS
                    for (const change of safeFix.changes) {
                        const changePath = this.toPosix(path.resolve(this.projectRoot, change.fileName));
                        let content = this.vfs.get(changePath) ?? this.host.readFile(change.fileName) ?? "";

                        // Sort descending (bottom-up) to protect intra-fix offsets
                        const sortedChanges = [...change.textChanges].sort((a, b) => b.span.start - a.span.start);

                        for (const textChange of sortedChanges) {
                            const start = textChange.span.start;
                            const end = start + textChange.span.length;
                            content = content.slice(0, start) + textChange.newText + content.slice(end);
                        }

                        this.vfs.set(changePath, content);
                        this.vfsClock.set(changePath, new Date(this.logicalTime));
                        localEditedFiles.add(changePath);

                        if (!parentEditedFiles.has(changePath)) newlyTouchedFiles.add(changePath);
                        if (!this.rootNames.has(changePath) && this.isTypeScriptFile(changePath)) {
                            this.rootNames.add(changePath);
                        }
                    }

                    // Recompile after fix (~20ms)
                    this.logicalTime += 1000;
                    this.updateProgram();
                    const newEvaluate = new Set(filesToEvaluate);
                    for (const f of localEditedFiles) newEvaluate.add(f);
                    const newErrors = this.getFatalErrors(localEditedFiles, newEvaluate);

                    // Fix must reduce error count. If not, rollback.
                    if (newErrors.length >= currentErrors.length) {
                        // MICRO-ROLLBACK: mutation caused cascade or was ineffective
                        for (const [p, state] of microUndoLog.entries()) {
                            if (state.content !== undefined) this.vfs.set(p, state.content); else this.vfs.delete(p);
                            if (state.time) this.vfsClock.set(p, state.time); else this.vfsClock.delete(p);
                            if (state.wasInRoot) this.rootNames.add(p); else this.rootNames.delete(p);

                            // BUG 5 FIXED: Never blind Shield 2 to files the LLM edited
                            if (!parentEditedFiles.has(p)) {
                                localEditedFiles.delete(p);
                            }
                            newlyTouchedFiles.delete(p);
                        }
                        this.logicalTime += 1000;
                        this.updateProgram();
                        failedFixHashes.add(fixHash); // Add to blacklist
                    } else {
                        // FIX ACCEPTED
                        const changesPreview = safeFix.changes.map(c => {
                            const file = path.basename(c.fileName);
                            const texts = c.textChanges.map(t => t.newText.trim()).filter(Boolean);
                            return `${file}: [${texts.join(", ")}]`;
                        }).join(" | ");

                        fixDescriptions.add(`- ${safeFix.description} -> \`${changesPreview}\``);
                        appliedAnyFix = true;
                        currentErrors = newErrors;

                        // Break: AST mutated, old offsets invalid.
                        // Return to while loop with fresh offsets from updateProgram().
                        break;
                    }
                }
            }

            if (!appliedAnyFix) break; // No valid fix for any remaining error
            iteration++;
        }

        // Healing result evaluation
        if (currentErrors.length > 0) {
            // ACID Rollback: Full healing failed.
            // Restore VFS to exact pre-healing state to return clean errors to the agent.
            if (healUndoLog.size > 0) {
                for (const [p, state] of healUndoLog.entries()) {
                    if (state.content !== undefined) this.vfs.set(p, state.content); else this.vfs.delete(p);
                    if (state.time) this.vfsClock.set(p, state.time); else this.vfsClock.delete(p);
                    if (state.wasInRoot) this.rootNames.add(p); else this.rootNames.delete(p);
                }
                this.logicalTime += 1000;
                // A-03: Only set clock for files that remain in VFS (avoid orphaned entries)
                for (const p of healUndoLog.keys()) {
                    if (this.vfs.has(p)) this.vfsClock.set(p, new Date(this.logicalTime));
                }
                this.updateProgram();
            }

            this._healingStats.failed++;
            // BUG 3 FIXED: Return initialErrors, do NOT recalculate (semantic iterator was consumed)
            return { healed: false, appliedFixes: [], newlyTouchedFiles: new Set(), finalErrors: initialErrors };
        }

        this._healingStats.applied++;
        // On success: merge newly touched files into the parent's edited set
        for (const file of localEditedFiles) parentEditedFiles.add(file);

        return {
            healed: true,
            appliedFixes: Array.from(fixDescriptions),
            newlyTouchedFiles,
            finalErrors: []
        };
    }

    /**
     * SINGLE ENTRY POINT (P21, P22).
     * Atomic batch validation: inject all edits into VFS, evaluate macro-state.
     * Triple shield: Global → Syntactic → Semantic.
     */
    public async interceptAtomicBatch(edits: NrekiEdit[], dependents: string[] = []): Promise<NrekiInterceptResult> {
        if (!this.booted) throw new Error("[NREKI] Kernel not booted");
        if (!edits || edits.length === 0) return { safe: true, exitCode: 0, latencyMs: "0.00" };

        // Corruption guard: if a previous timeout left the VFS in a partial state, rebuild
        if (this.isStateCorrupted) {
            this.isStateCorrupted = false;
            this.builderProgram = undefined;
            console.error("[NREKI] Rebuilding after timeout-corrupted state.");
        }

        return this.mutex.withLock(async () => {
        const t0 = performance.now();

        const rollbackState = new Map<string, {
            content: string | null | undefined;
            time: Date | undefined;
            wasInRoot: boolean;
        }>();

            // B6: Save logicalTime for rollback
            const savedLogicalTime = this.logicalTime;
            this.logicalTime += 1000;
            const explicitlyEditedFiles = new Set<string>();
            // A-02: Snapshot vfsDirectories for rollback
            const savedDirectories = new Set(this.vfsDirectories);

            // HOLOGRAM: set currentEditTargets so VFS hooks show them as real .ts
            if (this.mode === "hologram") {
                for (const edit of edits) {
                    if (edit.proposedContent !== null) {
                        const posixPath = this.toPosix(path.resolve(this.projectRoot, edit.targetFile));
                        this.currentEditTargets.add(posixPath);
                        // Ensure edited file is in rootNames for hologram lazy subgraph
                        if (this.isTypeScriptFile(posixPath) && !this.rootNames.has(posixPath)) {
                            this.rootNames.add(posixPath);
                        }
                    }
                }
            }

            // TTRD PRE-SCAN: Identify files that will be edited (before VFS mutation)
            for (const edit of edits) {
                if (edit.proposedContent !== null) {
                    const posixPath = this.toPosix(path.resolve(this.projectRoot, edit.targetFile));
                    explicitlyEditedFiles.add(posixPath);
                }
            }

            // TOPOLOGICAL INJECTION: unveil dependents in hologram mode
            const filesToEvaluate = new Set<string>(explicitlyEditedFiles);
            const temporarilyUnveiled = new Set<string>();

            if (this.mode === "hologram") {
                for (const dep of dependents) {
                    const posixDep = this.toPosix(path.resolve(this.projectRoot, dep));
                    filesToEvaluate.add(posixDep);
                    if (this.prunedTsLookup.has(posixDep)) {
                        this.prunedTsLookup.delete(posixDep);
                        this.shadowDtsLookup.delete(posixDep.replace(/\.tsx?$/, ".d.ts"));
                        if (!this.rootNames.has(posixDep)) {
                            this.rootNames.add(posixDep);
                        }
                        temporarilyUnveiled.add(posixDep);
                    }
                }
            }

            // JIT baseline: recapture baseline scoped to files we will evaluate
            if (this.mode === "hologram" || this.mode === "file") {
                this.updateProgram();
                this.captureBaseline(filesToEvaluate);
                if (this.bootErrorCount === -1) {
                    this.bootErrorCount = this.getBaselineErrorCount();
                }
            }

            // TTRD: Extract pre-mutation type contracts (before VFS injection)
            const preContracts = this.extractCanonicalTypes(explicitlyEditedFiles);

            // A-01: Wrap Phase 1-4 so partial VFS mutations are rolled back on throw
            try {

            // PHASE 1: Inject entire batch into VFS
            for (const edit of edits) {
                const posixPath = this.toPosix(path.resolve(this.projectRoot, edit.targetFile));
                const rootPosix = this.toPosix(path.resolve(this.projectRoot));

                // A1: Path Jail - block traversal attempts at kernel level
                if (!posixPath.startsWith(rootPosix + "/") && posixPath !== rootPosix) {
                    throw new Error(
                        `[NREKI] Security rejection: Path traversal blocked. ` +
                        `"${edit.targetFile}" resolves outside project root.`
                    );
                }

                const currentlyInRoots = this.rootNames.has(posixPath);

                // P25: Idempotent undo-log - first touch only
                if (!rollbackState.has(posixPath)) {
                    rollbackState.set(posixPath, {
                        content: this.vfs.has(posixPath) ? this.vfs.get(posixPath) : undefined,
                        time: this.vfsClock.get(posixPath),
                        wasInRoot: currentlyInRoots,
                    });
                }

                this.vfs.set(posixPath, edit.proposedContent);
                this.vfsClock.set(posixPath, new Date(this.logicalTime));
                this.mutatedFiles.add(posixPath);

                // P29: Tombstone removes from rootNames
                // P30: Only TS files enter rootNames
                if (edit.proposedContent === null) {
                    this.rootNames.delete(posixPath);
                } else {
                    explicitlyEditedFiles.add(posixPath);
                    if (!currentlyInRoots && this.isTypeScriptFile(posixPath)) {
                        this.rootNames.add(posixPath);
                    }
                    // E1: Build directory hierarchy for O(1) lookup
                    let dir = path.posix.dirname(posixPath);
                    while (dir.length >= rootPosix.length && dir !== rootPosix && dir !== ".") {
                        this.vfsDirectories.add(dir);
                        dir = path.posix.dirname(dir);
                    }
                }
            }

            // PHASE 2: Rebuild incremental program
            this.updateProgram();

            // BUG 3 FIXED: Compute AI errors exactly ONCE.
            // getFatalErrors consumes the stateful getSemanticDiagnosticsOfNextAffectedFile iterator.
            // Cannot call it again without updateProgram() in between.
            const originalFatalErrors = this.getFatalErrors(explicitlyEditedFiles, filesToEvaluate);

            // PHASE 4: Verdict
            if (originalFatalErrors.length > 0) {

                // ─── NREKI L3.3: Iterative Auto-Healing ─────────────────
                const tHealStart = performance.now();
                const healing = this.attemptAutoHealing(originalFatalErrors, explicitlyEditedFiles, filesToEvaluate);

                if (healing.healed) {
                    const latency = (performance.now() - t0).toFixed(2);
                    const healLatency = (performance.now() - tHealStart).toFixed(2);

                    // Patch notice: tell the agent what NOT to overwrite in its next edit
                    let extraFilesWarning = "";
                    if (healing.newlyTouchedFiles.size > 0) {
                        const files = Array.from(healing.newlyTouchedFiles)
                            .map(f => path.relative(this.projectRoot, f)).join(", ");
                        extraFilesWarning = `\nWARNING: NREKI also auto-patched collateral files: ${files}. Do NOT revert them.`;
                    }

                    const patchNotice =
                        `\n\nIMPORTANT: NREKI applied these patches automatically.\n` +
                        `Your code on disk already contains these fixes. ` +
                        `Do not revert or overwrite them in your next edit.` +
                        extraFilesWarning;

                    // TTRD post-contracts (healed path)
                    const finalEditedFiles = new Set(explicitlyEditedFiles);
                    for (const f of healing.newlyTouchedFiles) finalEditedFiles.add(f);
                    const postContracts = this.extractCanonicalTypes(finalEditedFiles);
                    const regressions = this.computeTypeRegressions(preContracts, postContracts);

                    // Restore hologram veil after healed success
                    if (this.mode === "hologram" && temporarilyUnveiled.size > 0) {
                        for (const file of temporarilyUnveiled) {
                            this.prunedTsLookup.add(file);
                            this.shadowDtsLookup.add(file.replace(/\.tsx?$/, ".d.ts"));
                            this.rootNames.delete(file);
                            this.vfsClock.set(file, new Date(this.logicalTime + 1));
                            // JIT: force re-classify on next access (content may have changed)
                            this.jitClassifiedCache.delete(file);
                        }
                    }
                    this.currentEditTargets.clear();

                    return {
                        safe: true,
                        exitCode: 0,
                        latencyMs: latency,
                        healedFiles: Array.from(healing.newlyTouchedFiles),
                        errorText:
                            `[NREKI AUTO-HEAL: ${healLatency}ms] ` +
                            `Your code had structural errors. NREKI applied deterministic fixes in RAM:\n\n` +
                            healing.appliedFixes.join("\n") +
                            patchNotice,
                        regressions: regressions.length > 0 ? regressions : undefined,
                        postContracts: postContracts.size > 0
                            ? new Map([...postContracts].map(([file, syms]) =>
                                [file, new Map([...syms].map(([sym, contract]) => [sym, contract.typeStr]))]
                              ))
                            : undefined,
                    };
                }
                // ─── END Auto-Healing ────────────────────────────────────

                // Healing failed. Use the ORIGINAL error matrix (do not recalculate).
                const structured = originalFatalErrors.map((d) => this.toStructured(d));

                // ACID rollback of the original edit
                for (const [posixPath, state] of rollbackState.entries()) {
                    if (state.content !== undefined) this.vfs.set(posixPath, state.content);
                    else this.vfs.delete(posixPath);

                    if (state.time) this.vfsClock.set(posixPath, state.time);
                    else this.vfsClock.delete(posixPath);

                    if (state.wasInRoot) this.rootNames.add(posixPath);
                    else this.rootNames.delete(posixPath);
                }

                // B6: Restore logicalTime on rollback
                this.logicalTime = savedLogicalTime;
                // A-02: Restore vfsDirectories
                this.vfsDirectories = savedDirectories;
                // P17 + P2 WARM-PATH: Advance clock instead of destroying program.
                this.logicalTime += 1000;
                for (const [posixPath] of rollbackState.entries()) {
                    this.vfsClock.set(posixPath, new Date(this.logicalTime));
                }
                this.updateProgram();

                const latency = (performance.now() - t0).toFixed(2);

                // Restore hologram veil after rejection
                if (this.mode === "hologram" && temporarilyUnveiled.size > 0) {
                    for (const file of temporarilyUnveiled) {
                        this.prunedTsLookup.add(file);
                        this.shadowDtsLookup.add(file.replace(/\.tsx?$/, ".d.ts"));
                        this.rootNames.delete(file);
                        this.vfsClock.set(file, new Date(this.logicalTime + 1));
                        // JIT: force re-classify on next access (content may have changed)
                        this.jitClassifiedCache.delete(file);
                    }
                }
                this.currentEditTargets.clear();

                return {
                    safe: false, exitCode: 2, latencyMs: latency, structured,
                    errorText:
                        `[Edit rejected - ${latency}ms] Atomic transaction aborted. ` +
                        `${originalFatalErrors.length} violation(s) detected in RAM.\n` +
                        structured.map((e) =>
                            `  → ${e.file} (${e.line},${e.column}): ${e.code} - ${e.message}`
                        ).join("\n") +
                        `\nACTION: Disk untouched. Fix the code and retry.`,
                };
            }

            // TTRD post-contracts (clean path)
            const postContracts = this.extractCanonicalTypes(explicitlyEditedFiles);
            const regressions = this.computeTypeRegressions(preContracts, postContracts);

            // Restore hologram veil after successful intercept
            if (this.mode === "hologram" && temporarilyUnveiled.size > 0) {
                for (const file of temporarilyUnveiled) {
                    this.prunedTsLookup.add(file);
                    this.shadowDtsLookup.add(file.replace(/\.tsx?$/, ".d.ts"));
                    this.rootNames.delete(file);
                    this.vfsClock.set(file, new Date(this.logicalTime + 1));
                    // JIT: force re-classify on next access (content may have changed)
                    this.jitClassifiedCache.delete(file);
                }
            }
            this.currentEditTargets.clear();

            return {
                safe: true,
                exitCode: 0,
                latencyMs: (performance.now() - t0).toFixed(2),
                regressions: regressions.length > 0 ? regressions : undefined,
                postContracts: postContracts.size > 0
                    ? new Map([...postContracts].map(([file, syms]) =>
                        [file, new Map([...syms].map(([sym, contract]) => [sym, contract.typeStr]))]
                      ))
                    : undefined,
            };

            } catch (phaseError) {
                // A-01: Rollback partial VFS mutations from Phase 1 on any throw
                for (const [posixPath, state] of rollbackState.entries()) {
                    if (state.content !== undefined) this.vfs.set(posixPath, state.content);
                    else this.vfs.delete(posixPath);
                    if (state.time) this.vfsClock.set(posixPath, state.time);
                    else this.vfsClock.delete(posixPath);
                    if (state.wasInRoot) this.rootNames.add(posixPath);
                    else this.rootNames.delete(posixPath);
                }
                // A-02: Restore vfsDirectories
                this.vfsDirectories = savedDirectories;
                this.logicalTime = savedLogicalTime;
                // Restore hologram veil on failure
                if (this.mode === "hologram" && temporarilyUnveiled.size > 0) {
                    for (const file of temporarilyUnveiled) {
                        this.prunedTsLookup.add(file);
                        this.shadowDtsLookup.add(file.replace(/\.tsx?$/, ".d.ts"));
                        this.rootNames.delete(file);
                        this.vfsClock.set(file, new Date(this.logicalTime + 1));
                        // JIT: force re-classify on next access (content may have changed)
                        this.jitClassifiedCache.delete(file);
                    }
                }
                this.currentEditTargets.clear();
                throw phaseError;
            }
        });
    }

    /**
     * Two-Phase Atomic Commit with physical rollback (P2, P18, P27, P32).
     * Phase 1: Backup existing files to .bak
     * Phase 2: Write new content via temp+rename
     * Phase 3: Clean backups on success
     * On failure: restore all .bak files
     */
    public async commitToDisk(): Promise<void> {
        return this.mutex.withLock(async () => {
        const physicalUndoLog: { target: string; backup: string | null }[] = [];

        try {
            // PHASE 1: Physical backup
            for (const posixPath of this.vfs.keys()) {
                const osPath = path.normalize(posixPath);
                if (fs.existsSync(osPath)) {
                    const txDir = path.join(this.projectRoot, ".nreki", "transactions");
                    if (!fs.existsSync(txDir)) fs.mkdirSync(txDir, { recursive: true });
                    const bak = path.join(txDir, `${crypto.randomBytes(4).toString("hex")}.bak`);
                    fs.copyFileSync(osPath, bak);
                    physicalUndoLog.push({ target: osPath, backup: bak });
                } else {
                    physicalUndoLog.push({ target: osPath, backup: null });
                }
            }

            // PHASE 2: Destructive writes
            for (const [posixPath, content] of this.vfs.entries()) {
                const osPath = path.normalize(posixPath);
                if (content === null) {
                    if (fs.existsSync(osPath)) fs.unlinkSync(osPath);
                } else {
                    const dir = path.dirname(osPath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    const tmp = `${osPath}.nreki-${crypto.randomBytes(4).toString("hex")}.tmp`;
                    fs.writeFileSync(tmp, content, "utf-8");
                    fs.renameSync(tmp, osPath);
                }
            }

            // P18: VFS clear and rebuild
            // C-02: Save VFS state before clearing so we can restore on rebuild failure
            const savedVfs = new Map(this.vfs);
            const savedClock = new Map(this.vfsClock);
            const savedDirs = new Set(this.vfsDirectories);
            this.vfs.clear();
            this.vfsClock.clear();
            this.vfsDirectories.clear();
            this.builderProgram = undefined;
            this.editCount = 0;
            try {
                this.updateProgram();
                this.captureBaseline();
            } catch (rebuildErr) {
                // A-10: Force full rebuild on next operation
                this.builderProgram = undefined;
                // Restore VFS to pre-clear state for consistency with rolled-back disk
                for (const [k, v] of savedVfs) this.vfs.set(k, v);
                for (const [k, v] of savedClock) this.vfsClock.set(k, v);
                for (const d of savedDirs) this.vfsDirectories.add(d);
                throw rebuildErr;
            }

            // Persist build state for next session (warm boot)
            try {
                this.builderProgram!.emit(
                    undefined,
                    (fileName, text) => {
                        // Only write .tsbuildinfo, not .js/.d.ts
                        if (fileName.endsWith(".tsbuildinfo")) {
                            const dir = path.dirname(fileName);
                            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                            fs.writeFileSync(fileName, text, "utf-8");
                        }
                    },
                    undefined,
                    true, // emitOnlyDtsFiles - suppresses .js output
                );
                this.writeTsVersionGuard();
            } catch { /* Non-fatal: next boot will cold-start */ }

            // A-01: Phase 3 AFTER successful rebuild - backups survive if rebuild throws
            for (const log of physicalUndoLog) {
                if (log.backup && fs.existsSync(log.backup)) fs.unlinkSync(log.backup);
            }

            // Release stale AST versions from DocumentRegistry
            this.releaseMutatedDocuments();

            console.error("[NREKI] Atomic commit materialized. Disk synchronized.");
        } catch (error) {
            // PHYSICAL ROLLBACK
            console.error(`[NREKI FATAL] OS write failure! Physical rollback: ${error}`);
            for (const log of physicalUndoLog) {
                try {
                    if (log.backup) {
                        if (fs.existsSync(log.backup)) fs.renameSync(log.backup, log.target);
                    } else {
                        if (fs.existsSync(log.target)) fs.unlinkSync(log.target);
                    }
                } catch { /* Cascade panic - best effort */ }
            }
            throw new Error(`[NREKI] Physical ACID commit failed. Repository restored. Reason: ${error}`);
        }
        });
    }

    /** Emergency rollback - purge all staged changes (P3). */
    public async rollbackAll(): Promise<void> {
        return this.mutex.withLock(async () => {
            this.vfs.clear();
            this.vfsClock.clear();
            this.vfsDirectories.clear();
            this.initConfig(); // Re-sync rootNames from disk
            // BUG 1: In hologram mode, re-filter rootNames
            if (this.mode === "hologram") {
                if (this.jitMode) {
                    // SURGICAL JIT CACHE INVALIDATION:
                    // jitClassifyFile() reads from DISK, not VFS. Classifications
                    // remain valid after rollback because disk content is unchanged.
                    // Only invalidate files that were being edited in this transaction.
                    // This preserves the ~1.94s of accumulated JIT work.
                    for (const target of this.currentEditTargets) {
                        this.jitClassifiedCache.delete(target);
                        this.prunedFiles.delete(target);
                        this.shadowContent.delete(target);
                    }
                    this.buildShadowLookups();
                    this.currentEditTargets.clear();
                    this.rootNames = new Set(
                        [...this.rootNames].filter(f => f.endsWith(".d.ts")),
                    );
                } else if (this.ambientFiles.length > 0) {
                    // Eager mode: re-filter to ambient-only
                    const ambientSet = new Set(
                        this.ambientFiles.map(f => this.toPosix(path.resolve(this.projectRoot, f))),
                    );
                    this.rootNames = new Set(
                        [...this.rootNames].filter(f => ambientSet.has(f)),
                    );
                    this.buildShadowLookups();
                }
            }
            // WARM-PATH: Advance clock to invalidate cached files.
            // Only destroy builderProgram if it doesn't exist yet.
            this.logicalTime += 1000;
            this.updateProgram();
            // Release stale AST versions from DocumentRegistry
            this.releaseMutatedDocuments();
            console.error("[NREKI] Hard rollback executed. VFS purged.");
        });
    }

    // ─── Utilities ─────────────────────────────────────────────────

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

    /**
     * Show which files depend on a symbol before the agent edits it.
     * Uses LanguageService.findReferences(). Cost: ~20ms per call.
     */
    public predictBlastRadius(targetFile: string, symbolName: string): { safe: boolean; report: string } {
        if (this.mode === "hologram") {
            throw new Error(
                "[NREKI] Cannot use predictBlastRadius in hologram mode. " +
                "Use Layer 1 AST navigator for reference queries.",
            );
        }
        if (!this.booted || !this.languageService || !this.builderProgram) {
            throw new Error("[NREKI] Kernel or Language Service not booted.");
        }

        const posixPath = this.toPosix(path.resolve(this.projectRoot, targetFile));
        const program = this.languageService.getProgram();
        if (!program) throw new Error("[NREKI] Could not get program from LanguageService");
        const sourceFile = program.getSourceFile(posixPath);
        if (!sourceFile) throw new Error(`[NREKI] File not tracked: ${targetFile}`);

        // 1. Find the declaration's byte offset
        let targetPos = -1;
        const findNode = (node: ts.Node) => {
            if (ts.isIdentifier(node) && node.text === symbolName) {
                const parent = node.parent;
                if (parent && (
                    ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) ||
                    ts.isMethodDeclaration(parent) || ts.isVariableDeclaration(parent) ||
                    ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) ||
                    ts.isPropertySignature(parent) || ts.isMethodSignature(parent)
                ) && (parent as any).name === node) {
                    targetPos = node.getStart(sourceFile);
                    return;
                }
            }
            if (targetPos === -1) ts.forEachChild(node, findNode);
        };
        findNode(sourceFile);

        if (targetPos === -1) {
            throw new Error(`[NREKI] Declaration for '${symbolName}' not found in ${targetFile}`);
        }

        // 2. Fire the LanguageService reference scanner
        const references = this.languageService.findReferences(posixPath, targetPos);
        if (!references || references.length === 0) {
            return {
                safe: true,
                report: `No external dependents found for ${symbolName}. Safe to change.`,
            };
        }

        const dependents = new Map<string, Array<{ line: number; context: string; reason: string }>>();
        let totalUsages = 0;

        for (const ref of references) {
            for (const curr of ref.references) {
                if (curr.isDefinition) continue;

                const refFile = this.toPosix(path.resolve(this.projectRoot, curr.fileName));
                if (refFile === posixPath) continue;

                const refSourceFile = program.getSourceFile(refFile);
                if (!refSourceFile) continue;

                const { line } = ts.getLineAndCharacterOfPosition(refSourceFile, curr.textSpan.start);
                const lineText = (refSourceFile.text.split("\n")[line] ?? "").trim();

                // Extract WHY this usage matters (Demand Inference)
                let reason = "Structural usage";
                let usageNode: ts.Node | undefined;
                const findUsage = (n: ts.Node) => {
                    if (curr.textSpan.start >= n.getStart(refSourceFile) && curr.textSpan.start < n.getEnd()) {
                        usageNode = n;
                        ts.forEachChild(n, findUsage);
                    }
                };
                findUsage(refSourceFile);

                if (usageNode && usageNode.parent) {
                    const p = usageNode.parent;
                    if (ts.isCallExpression(p)) reason = "Function call (expects specific arguments/return type)";
                    else if (ts.isPropertyAccessExpression(p)) reason = "Property access";
                    else if (ts.isBinaryExpression(p)) reason = "Binary operation / Assignment";
                    else if (ts.isVariableDeclaration(p)) reason = "Assigned to explicitly typed variable";
                    else if (ts.isTypeReferenceNode(p)) reason = "Type contract (Type Reference)";
                    else if (ts.isImportSpecifier(p) || ts.isImportClause(p)) reason = "Module import";
                    else if (ts.isExportSpecifier(p) || ts.isExportAssignment(p)) reason = "Module export";
                    else if (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) reason = "JSX Component instantiation";
                }

                const relPath = path.relative(this.projectRoot, curr.fileName).replace(/\\/g, "/");
                const arr = dependents.get(relPath) || [];
                arr.push({ line: line + 1, context: lineText, reason });
                dependents.set(relPath, arr);
                totalUsages++;
            }
        }

        if (dependents.size === 0) {
            return {
                safe: true,
                report: `${symbolName} is only used internally in ${path.relative(this.projectRoot, posixPath)}. Safe to change.`,
            };
        }

        // 3. Format tactical report for the LLM
        const lines: string[] = [
            `${totalUsages} references across ${dependents.size} files will break if you change this signature.`,
            `Dependent files:\n`,
        ];

        for (const [file, usages] of dependents.entries()) {
            lines.push(`${file} (${usages.length} usages)`);
            for (const u of usages) {
                lines.push(`  L${u.line}: ${u.context} (${u.reason})`);
            }
        }

        lines.push(
            `\nUse nreki_code action:"batch_edit" to update all dependent files in the same transaction.`,
        );

        return { safe: false, report: lines.join("\n") };
    }

    /** Resolve a file path to the kernel's internal POSIX format. */
    public resolvePosixPath(filePath: string): string {
        return this.toPosix(path.resolve(this.projectRoot, filePath));
    }

    public getStagingSize(): number { return this.vfs.size; }
    public getTrackedFiles(): number { return this.rootNames.size; }
    public getBaselineErrorCount(): number {
        let total = 0;
        for (const count of this.baselineFrequencies.values()) total += count;
        return total;
    }

    /**
     * Error count captured once at boot time. Immutable after boot.
     * Used by the file fragility tracker for session health delta calculation.
     */
    public getInitialErrorCount(): number {
        return Math.max(0, this.bootErrorCount);
    }

    /**
     * Current project error count via baseline cache.
     *
     * Between tool calls the VFS is empty (each intercept ends in
     * commit → captureBaseline() or rollback → VFS clean).
     * Therefore baselineFrequencies reflects the current disk state.
     *
     * Cost: O(1) - no compiler invocation needed.
     */
    public getCurrentErrorCount(): number {
        return this.getBaselineErrorCount();
    }

    // ─── Hologram mode API ─────────────────────────────────

    /** Receive shadow scan results BEFORE boot(). */
    public setShadows(
        prunable: Map<string, string>,
        _unprunable: Set<string>,
        ambientFiles: string[],
    ): void {
        this.prunedFiles = new Set(prunable.keys());
        this.shadowContent = new Map(prunable);
        this.ambientFiles = ambientFiles;
        this.buildShadowLookups();
    }

    /** Check if shadows have been loaded. */
    public hasShadows(): boolean {
        return this.prunedFiles.size > 0;
    }

    /** Set JIT parser for on-demand shadow generation. Call BEFORE boot(). */
    public setJitParser(parser: any, tsLanguage: any): void {
        this.jitParser = parser;
        this.jitTsLanguage = tsLanguage;
    }

    /** Set JIT classifier function (classifyAndGenerateShadow). */
    public setJitClassifier(fn: (filePath: string, content: string, parser: any, lang: any) => { prunable: boolean; shadow: string | null }): void {
        this.jitClassifyFn = fn;
    }

    /** Check if JIT hologram mode is initialized. */
    public hasJitHologram(): boolean {
        return !!this.jitParser && !!this.jitClassifyFn;
    }

    /** Get number of files classified on-demand by JIT. */
    public getJitCacheSize(): number {
        return this.jitClassifiedCache.size;
    }

    /** Get the monotonic logical clock (for harvester epoch detection). */
    public getLogicalTime(): number {
        return this.logicalTime;
    }

    /** Get the current TypeScript Program (for harvester .d.ts emission). */
    public getProgram(): ts.Program | undefined {
        return this.builderProgram?.getProgram();
    }

    /**
     * JIT classify a single .ts/.tsx file and populate shadow data structures.
     * Returns true if file was prunable (shadow generated), false otherwise.
     * Synchronous: reads file from disk, classifies with pre-loaded tree-sitter parser.
     */
    private jitClassifyFile(tsPath: string): boolean {
        if (this.jitClassifiedCache.has(tsPath)) return this.prunedTsLookup.has(tsPath);
        if (!this.jitParser || !this.jitTsLanguage || !this.jitClassifyFn) return false;

        this.jitClassifiedCache.add(tsPath);

        // SIZE GUARD: Skip large auto-generated files (GraphQL codegen,
        // Prisma client, protobuf output) that would block the event loop.
        try {
            const stat = fs.statSync(path.normalize(tsPath));
            if (stat.size > NrekiKernel.JIT_MAX_FILE_SIZE) return false;
        } catch { return false; }

        let content: string;
        try { content = readSource(path.normalize(tsPath)); }
        catch { return false; }

        const result = this.jitClassifyFn(tsPath, content, this.jitParser, this.jitTsLanguage);
        if (result.prunable && result.shadow) {
            this.prunedFiles.add(tsPath);
            this.shadowContent.set(tsPath, result.shadow);
            const dtsPath = tsPath.replace(/\.tsx?$/, ".d.ts");
            this.shadowDtsLookup.add(dtsPath);
            this.prunedTsLookup.add(tsPath);
            return true;
        }
        return false;
    }

    private buildShadowLookups(): void {
        this.shadowDtsLookup.clear();
        this.prunedTsLookup.clear();
        for (const tsPath of this.prunedFiles) {
            const dtsPath = tsPath.replace(/\.tsx?$/, ".d.ts");
            this.shadowDtsLookup.add(dtsPath);
            this.prunedTsLookup.add(tsPath);
        }
    }
}
