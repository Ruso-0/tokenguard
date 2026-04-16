import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type Parser from "web-tree-sitter";
import { isSensitivePath } from "../utils/path-jail.js";
import { readSource } from "../utils/read-source.js";
import { toPosix as toPosixUtil } from "../utils/to-posix.js";
import { logger, setTxId, clearTxId } from "../utils/logger.js";
import { latencyTracker } from "../utils/latency-tracker.js";
import { TsCompilerWrapper } from "./backends/ts-compiler-wrapper.js";
import type { LspSidecarBase } from "./backends/lsp-sidecar-base.js";
import { AsyncMutex } from "./mutex.js";
import type {
    NrekiStructuredError, NrekiEdit,
    NrekiInterceptResult,
    TsHealingContext, LspHealingContext,
} from "./types.js";
import { extractRawSignatures, detectSignatureRegression, isToxicType } from "./ttrd.js";
import { attemptAutoHealing, attemptLspAutoHealing } from "./healer.js";

export { AsyncMutex } from "./mutex.js";
export type {
    NrekiStructuredError, NrekiEdit, TypeRegression,
    NrekiInterceptResult, NrekiMode, PreEditContract,
} from "./types.js";



// ─── NREKI Kernel ─────────────────────────────────────────────────
//
// Cross-file semantic and syntactic verification for AI coding agents.
// Uses the TypeScript Compiler API with a Virtual File System in RAM.
// Validates edits before they touch disk. Rolls back on failure.
//
// @author Jherson Eddie Tintaya Holguin (Ruso-0)


/**
 * LineMap — precomputes newline offsets for O(1) line extraction.
 * Used by predictBlastRadius to avoid O(N × refs) split operations.
 * Cached per ts.SourceFile via WeakMap (auto-invalidated on rebuild).
 */
class LineMap {
    private offsets: number[];
    constructor(text: string) {
        this.offsets = [0];
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\n') this.offsets.push(i + 1);
        }
    }
    getLine(lineNum: number, text: string): string {
        if (lineNum < 0 || lineNum >= this.offsets.length) return "";
        const start = this.offsets[lineNum];
        const end = this.offsets[lineNum + 1] ?? text.length;
        return text.slice(start, end).replace(/\n$/, '');
    }
}

export class NrekiKernel {
    private projectRoot!: string;
    private vfs = new Map<string, string | null>();
    private vfsDirectories = new Set<string>();
    private vfsClock = new Map<string, Date>();
    private logicalTime = Date.now();

    private mutex = new AsyncMutex();
    private compilerOptions!: ts.CompilerOptions;
    private rootNames!: Set<string>;
    // Exposed for test access (JIT holography tests use (kernel as any).host)
    public host!: ts.CompilerHost;
    private booted = false;
    private _healingStats = { applied: 0, failed: 0 };

    /** Read-only view of healing statistics. */
    public get healingStats(): Readonly<{ applied: number; failed: number }> {
        return { applied: this._healingStats.applied, failed: this._healingStats.failed };
    }
    private mutatedFiles = new Set<string>();
    private bootErrorCount: number = -1;

    // ─── LSP Sidecars (Go, Python — async child processes) ────
    private lspSidecars = new Map<string, LspSidecarBase>();
    private tsBuildInfoPath!: string;

    // ─── TypeScript Compiler Wrapper ──────────────────────────
    // Direct composition. No polymorphic interface. The kernel
    // owns the VFS + ACID; the wrapper encapsulates TS API brujería.
    private tsBackend = new TsCompilerWrapper();

    // Performance Modes
    public mode: "file" | "project" | "hologram" = "project";

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
    private jitParser?: Parser;        // web-tree-sitter Parser instance
    private jitTsLanguage?: Parser.Language; // web-tree-sitter Language for TypeScript
    private jitClassifiedCache = new Set<string>();  // tsPath → already classified
    private jitClassifyFn?: (filePath: string, content: string, parser: Parser, lang: Parser.Language) => { prunable: boolean; shadow: string | null };
    /** v10.5.2: cache LineMaps per SourceFile to avoid O(N × refs) splits in predictBlastRadius. */
    private lineMapCache = new WeakMap<ts.SourceFile, LineMap>();

    // P26: POSIX normalization — delegates to shared utility
    private toPosix(p: string): string { return toPosixUtil(p); }

    // P30: Only TypeScript-compatible files enter rootNames
    private isTypeScriptFile(filePath: string): boolean {
        // A-05: Specific patterns (d.ts) before general (tsx?) to avoid shadowing
        if (/\.(d\.ts|d\.mts|d\.cts|tsx?|mts|cts)$/i.test(filePath)) return true;
        // AUDIT FIX: Only allow JS files if tsconfig.json explicitly enables allowJs
        if (this.compilerOptions?.allowJs && /\.(jsx?|mjs|cjs)$/i.test(filePath)) return true;
        return false;
    }

    /**
     * Convierte una posición LSP (Línea, Carácter 0-indexed)
     * a un índice absoluto de string. Sobrevive \r\n (Windows).
     */
    private getLspOffset(content: string, line: number, character: number): number {
        let currentLine = 0;
        let offset = 0;

        while (currentLine < line && offset < content.length) {
            const nl = content.indexOf('\n', offset);
            if (nl === -1) break;
            offset = nl + 1;
            currentLine++;
        }

        return Math.min(offset + character, content.length);
    }

    /**
     * TTRD Sintáctico - Micro-Scanner Híbrido (O(N), Cero dependencias).
     * Extrae firmas de Python y Go crudas del VFS a prueba de
     * formateadores (Black/Ruff/gofmt) y strings embebidos.
     * Usa Regex SOLO para anclar el inicio (def/func), y un
     * Bracket Balancer para parsear el interior.
     */
    // DRY: Config loading delegated to backend (Strangler Fig Phase 2A).
    // Kernel copies references after the call. All 32 usages of this.rootNames
    // and 13 usages of this.compilerOptions continue working unchanged.
    private initConfig(): void {
        this.tsBackend.initConfig(this.projectRoot);
        this.compilerOptions = this.tsBackend.compilerOptions;
        this.rootNames = this.tsBackend.rootNames;
        this.tsBuildInfoPath = this.tsBackend.tsBuildInfoPath;
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
                logger.warn(`TS version changed (${cached} -> ${ts.version}). Cache purged.`);
                return false;
            }
            return true;
        } catch {
            return false; // First boot or corrupted cache
        }
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
        logger.info(`Booting VFS-LSP Kernel (${this.mode} mode). Applying CompilerHost overrides...`);
        this.projectRoot = this.toPosix(path.resolve(workspacePath));
        this.initConfig();

        // Hologram mode: override rootNames and compilerOptions
        if (this.mode === "hologram") {
            if (this.hasJitHologram() && this.prunedFiles.size === 0) {
                // JIT mode: no pre-computed shadows. Keep only .d.ts/.d.mts/.d.cts from rootNames.
                this.jitMode = true;
                this.rootNames = new Set(
                    [...this.rootNames].filter(f => /\.d\.[mc]?ts$/i.test(f)),
                );
                logger.info(`JIT Holography active. rootNames: ${this.rootNames.size} (.d.ts only). Shadows on-demand.`);
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
            // Sync filtered rootNames back to backend (hologram creates new Set)
            this.tsBackend.rootNames = this.rootNames;
        }

        // ─── Delegate CompilerHost creation to backend (Strangler Fig 2B) ───
        // The kernel creates VfsAdapter closures over its own state.
        // The backend uses them to create CompilerHost + LanguageService.
        // VFS, hologram, JIT state stay in the kernel. Always.
        const self = this;
        const vfsAdapter: import("./backends/ts-compiler-wrapper.js").VfsAdapter = {
            readFile(fileName: string): string | undefined {
                const posixPath = self.toPosix(path.resolve(self.projectRoot, fileName));

                // HOLOGRAM INTERCEPT: serve shadow .d.ts or hide pruned .ts
                if (self.mode === "hologram") {
                    if (/\.d\.[mc]?ts$/i.test(fileName)) {
                        const tsPath = posixPath.replace(/\.d\.([mc]?)ts$/i, ".$1ts");
                        const shadow = self.shadowContent.get(tsPath);
                        if (shadow !== undefined) return shadow;
                        const tsxPath = posixPath.replace(/\.d\.([mc]?)ts$/i, ".$1tsx");
                        const shadow2 = self.shadowContent.get(tsxPath);
                        if (shadow2 !== undefined) return shadow2;
                        if (self.jitMode) {
                            if (!self.jitClassifiedCache.has(tsPath)) {
                                self.jitClassifyFile(tsPath);
                                const shadowJ = self.shadowContent.get(tsPath);
                                if (shadowJ !== undefined) return shadowJ;
                            }
                            if (!self.jitClassifiedCache.has(tsxPath)) {
                                self.jitClassifyFile(tsxPath);
                                const shadowJ2 = self.shadowContent.get(tsxPath);
                                if (shadowJ2 !== undefined) return shadowJ2;
                            }
                        }
                    }
                    if (self.prunedTsLookup.has(posixPath) && !self.currentEditTargets.has(posixPath)) {
                        // FIX: Check VFS FIRST. A pruned file that was edited in a prior
                        // transaction has real content in RAM that the compiler must see.
                        if (self.vfs.has(posixPath)) {
                            const content = self.vfs.get(posixPath);
                            return content === null ? undefined : content;
                        }
                        return undefined;
                    }
                }

                if (self.vfs.has(posixPath)) {
                    const content = self.vfs.get(posixPath);
                    return content === null ? undefined : content;
                }
                if (isSensitivePath(fileName)) {
                    return undefined;
                }
                // Fallback to disk via backend's original readFile
                return self.tsBackend.originalReadFile.call(self.tsBackend.host, fileName);
            },

            fileExists(fileName: string): boolean {
                const posixPath = self.toPosix(path.resolve(self.projectRoot, fileName));

                if (self.mode === "hologram") {
                    if (self.currentEditTargets.has(posixPath)) {
                        return self.tsBackend.originalFileExists.call(self.tsBackend.host, fileName);
                    }
                    if (self.prunedTsLookup.has(posixPath)) return false;
                    if (self.shadowDtsLookup.has(posixPath)) return true;

                    if (self.jitMode) {
                        if (/\.tsx?$/.test(fileName) && !/\.d\.[mc]?ts$/i.test(fileName)) {
                            if (self.tsBackend.originalFileExists.call(self.tsBackend.host, fileName)) {
                                self.jitClassifyFile(posixPath);
                                if (self.prunedTsLookup.has(posixPath)) return false;
                            }
                        }
                        if (/\.d\.[mc]?ts$/i.test(fileName)) {
                            const tsPath = posixPath.replace(/\.d\.([mc]?)ts$/i, ".$1ts");
                            const tsxPath = posixPath.replace(/\.d\.([mc]?)ts$/i, ".$1tsx");
                            if (!self.jitClassifiedCache.has(tsPath) && self.tsBackend.originalFileExists.call(self.tsBackend.host, tsPath)) {
                                if (self.jitClassifyFile(tsPath)) return true;
                            }
                            if (!self.jitClassifiedCache.has(tsxPath) && self.tsBackend.originalFileExists.call(self.tsBackend.host, tsxPath)) {
                                if (self.jitClassifyFile(tsxPath)) return true;
                            }
                        }
                    }
                }

                if (self.vfs.has(posixPath)) return self.vfs.get(posixPath) !== null;
                return self.tsBackend.originalFileExists.call(self.tsBackend.host, fileName);
            },

            getModifiedTime(fileName: string): Date {
                const posixPath = self.toPosix(path.resolve(self.projectRoot, fileName));
                if (self.vfsClock.has(posixPath)) return self.vfsClock.get(posixPath)!;
                return ts.sys.getModifiedTime?.(fileName) ?? new Date();
            },

            directoryExists(dirName: string): boolean {
                const posixDir = self.toPosix(path.resolve(self.projectRoot, dirName));
                if (ts.sys.directoryExists(dirName)) return true;
                return self.vfsDirectories.has(posixDir);
            },

            getScriptVersion(fileName: string): string {
                const posixPath = self.toPosix(path.resolve(self.projectRoot, fileName));
                return self.vfsClock.get(posixPath)?.getTime().toString() || "1";
            },

            getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
                const posixPath = self.toPosix(path.resolve(self.projectRoot, fileName));

                // HOLOGRAM INTERCEPT for LanguageService
                if (self.mode === "hologram" && /\.d\.[mc]?ts$/i.test(fileName)) {
                    const tsPath = posixPath.replace(/\.d\.([mc]?)ts$/i, ".$1ts");
                    const shadow = self.shadowContent.get(tsPath);
                    if (shadow !== undefined) return ts.ScriptSnapshot.fromString(shadow);
                    const tsxPath = posixPath.replace(/\.d\.([mc]?)ts$/i, ".$1tsx");
                    const shadow2 = self.shadowContent.get(tsxPath);
                    if (shadow2 !== undefined) return ts.ScriptSnapshot.fromString(shadow2);
                }

                if (self.vfs.has(posixPath)) {
                    const content = self.vfs.get(posixPath);
                    if (content === null || content === undefined) return undefined;
                    return ts.ScriptSnapshot.fromString(content);
                }
                if (!self.tsBackend.originalFileExists.call(self.tsBackend.host, fileName)) return undefined;
                const content = self.tsBackend.originalReadFile.call(self.tsBackend.host, fileName);
                if (!content) return undefined;
                return ts.ScriptSnapshot.fromString(content);
            },
        };

        this.tsBackend.createCompilerInfra(this.projectRoot, vfsAdapter);

        // Sync host reference for test access (JIT holography tests)
        this.host = this.tsBackend.host;
        // ──────────────────────────────────────────────────────────────

        // Incremental cache: delegate to backend
        if (this.validateBuildInfoCache()) {
            try {
                const readBuildHost: ts.ReadBuildProgramHost = {
                    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
                    getCurrentDirectory: () => this.projectRoot,
                    readFile: (fileName: string) => {
                        if (fileName.endsWith(".tsbuildinfo")) {
                            return ts.sys.readFile(fileName);
                        }
                        return this.tsBackend.host.readFile(fileName);
                    },
                };
                const oldProgram = ts.readBuilderProgram(
                    this.tsBackend.compilerOptions, readBuildHost
                ) as ts.EmitAndSemanticDiagnosticsBuilderProgram | undefined;
                if (oldProgram) {
                    this.tsBackend._injectBuilderProgram(oldProgram);
                }
            } catch {
                // Corrupted cache, cold boot — backend starts fresh
            }
        }

        this.tsBackend.updateProgram();
        // Hologram/file mode: skip boot baseline - JIT baseline in interceptAtomicBatch
        // handles it scoped to target files.
        if (this.mode === "project") {
            this.tsBackend.captureBaseline(undefined, this.mode);
        }
        // D2: WAL-aware crash recovery.
        // If a previous session crashed mid-commit, the WAL tells us
        // exactly which files to restore from their .bak backups.
        const txDir = path.join(this.projectRoot, ".nreki", "transactions");
        const walPath = path.join(txDir, "wal.json");
        if (fs.existsSync(walPath)) {
            try {
                const wal = JSON.parse(fs.readFileSync(walPath, "utf-8"));
                if (wal.status === "pending" && Array.isArray(wal.files)) {
                    logger.warn(`WAL recovery: restoring ${wal.files.length} file(s) from crashed transaction`);
                    for (const entry of wal.files) {
                        // Per-entry try-catch: one failed restore must not abort the rest.
                        // Without this, a lock on one file destroys backups for all others.
                        try {
                            if (entry.backup && fs.existsSync(entry.backup)) {
                                fs.renameSync(entry.backup, entry.target);
                            } else if (!entry.backup && fs.existsSync(entry.target)) {
                                // File was newly created in the crashed tx — remove it
                                fs.unlinkSync(entry.target);
                            }
                        } catch (entryErr) {
                            logger.error(`WAL recovery failed for ${entry.target}: ${entryErr}`);
                        }
                    }
                }
            } catch (walErr) {
                logger.error(`WAL recovery failed: ${walErr}`);
            }
        }
        if (fs.existsSync(txDir)) {
            try { fs.rmSync(txDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }

        // Capture initial error count at boot (immutable after this point)
        this.bootErrorCount = this.getBaselineErrorCount();

        this.booted = true;
        // Log backend info for diagnostics
        logger.info(`Backend: ${this.tsBackend.name} (healing: ${this.tsBackend.capabilities.supportsAutoHealing}, ttrd: ${this.tsBackend.capabilities.supportsTTRD})`);
        logger.info(
            `Kernel booted. Tracking ${this.rootNames.size} files. ` +
            `Baseline: ${this.tsBackend.baselineCount} invariants. ` +
            `Boot errors: ${this.bootErrorCount}.`
        );
    }

    public isBooted(): boolean {
        return this.booted;
    }

    // ─── TTRD: Temporal Type Regression Detection ─────────────────────

    /**
     * Extract the compiler's resolved type for each locally-declared export.
     * Uses TypeChecker to read resolved types, not AST text.
     * Cost: O(K) where K = exports in the given files only.
     */
    // extractCanonicalTypes moved to backend (Strangler Fig Act 4)

    /**
     * Check if a type string contains toxic type patterns.
     * Uses word boundaries to avoid false positives on identifiers
     * like "Company" or "ManyToMany".
     *
     * Shared with file fragility tracker via static method.
     */
    public static isToxicType(typeStr: string): boolean {
        return isToxicType(typeStr);
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
    // getToxicityScoreFromType + computeTypeRegressions moved to backend (Strangler Fig Act 4)

    // ─── NREKI L3.3: Self-Healing Agent Loop ─────────────────────────


    /**
     * SINGLE ENTRY POINT (P21, P22).
     * Atomic batch validation: inject all edits into VFS, evaluate macro-state.
     * Triple shield: Global → Syntactic → Semantic.
     */
    public async interceptAtomicBatch(
        edits: NrekiEdit[],
        dependents: string[] = [],
        computeDiff: boolean = false
    ): Promise<NrekiInterceptResult> {
        if (!this.booted) throw new Error("[NREKI] Kernel not booted");
        if (!edits || edits.length === 0) return { safe: true, exitCode: 0, latencyMs: "0.00" };

        return this.mutex.withLock(async () => {
        // Corruption guard: if a previous timeout left the VFS in a partial state, rebuild
        // Moved inside mutex to prevent concurrent purgeCache() calls.
        if (this.tsBackend.isCorrupted) {
            this.tsBackend.purgeCache();
            logger.warn("Rebuilding after timeout-corrupted state.");
        }
        const txId = crypto.randomBytes(4).toString("hex");
        setTxId(txId);
        logger.info(`interceptAtomicBatch: ${edits.length} file(s)`);
        try {
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

            // PATCH-1: Track which files THIS transaction adds to mutatedFiles.
            // On rollback, only these are removed — preserving prior valid mutations.
            const transactionMutated = new Set<string>();

            // v10.5.2 #4: tracks paths added to rootNames for the FIRST time in this tx.
            // On rollback, force-removed regardless of the wasInRoot snapshot (which is
            // captured AFTER the add and therefore lies for brand-new files).
            const hologramTxNewRoots = new Set<string>();

            // HOLOGRAM: set currentEditTargets so VFS hooks show them as real .ts
            if (this.mode === "hologram") {
                for (const edit of edits) {
                    if (edit.proposedContent !== null) {
                        const posixPath = this.toPosix(path.resolve(this.projectRoot, edit.targetFile));
                        this.currentEditTargets.add(posixPath);
                        // Ensure edited file is in rootNames for hologram lazy subgraph
                        if (this.isTypeScriptFile(posixPath) && !this.rootNames.has(posixPath)) {
                            this.rootNames.add(posixPath);
                            hologramTxNewRoots.add(posixPath); // <-- TRACKEAR AQUÍ
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
                        this.shadowDtsLookup.delete(posixDep.replace(/\.([mc]?)tsx?$/, ".d.$1ts"));
                        if (!this.rootNames.has(posixDep)) {
                            this.rootNames.add(posixDep);
                        }
                        temporarilyUnveiled.add(posixDep);
                    }
                }
            }

            // JIT baseline: recapture baseline scoped to files we will evaluate
            if (this.mode === "hologram" || this.mode === "file") {
                this.tsBackend.updateProgram();
                // DR/LS synced via tsBackend
                this.tsBackend.captureBaseline(filesToEvaluate, this.mode);
                if (this.bootErrorCount === -1) {
                    this.bootErrorCount = this.getBaselineErrorCount();
                }
            }

            // TTRD: Extract pre-mutation type contracts (before VFS injection)
            const preContracts = await this.tsBackend.extractCanonicalTypes(explicitlyEditedFiles);

            // TTRD SINTÁCTICO PRE-SCAN: Python/Go
            const preRawSignatures = new Map<string, Map<string, string>>();
            const rootPosixTTRD = this.toPosix(path.resolve(this.projectRoot));
            for (const edit of edits) {
                if (edit.proposedContent !== null) {
                    const posixPath = this.toPosix(path.resolve(this.projectRoot, edit.targetFile));
                    // PATH JAIL: Block traversal BEFORE any I/O.
                    // Without this, the LLM can read arbitrary files via targetFile.
                    if (!posixPath.startsWith(rootPosixTTRD + "/") && posixPath !== rootPosixTTRD) {
                        continue; // Phase 1 will throw the security error — skip silently here
                    }
                    const ext = path.extname(posixPath).toLowerCase();
                    if (ext === ".py" || ext === ".go") {
                        const vfsEntry = this.vfs.has(posixPath) ? this.vfs.get(posixPath) : undefined;
                        const oldContent = vfsEntry !== undefined ? (vfsEntry ?? "") : (this.tsBackend.host.readFile(posixPath) ?? "");
                        preRawSignatures.set(posixPath, extractRawSignatures(oldContent, ext));
                    }
                }
            }

            // ─── PRE-MUTATION TOPOLOGY (OPT-IN LATENCY SHIELD) ───
            const isStructuralBatch = computeDiff
                && explicitlyEditedFiles.size > 1
                && this.rootNames.size <= 1000;

            let preTopology: { fiedlerValue: number; volume: number; nodeCount: number; edgeCount: number; cyclomaticComplexity?: number; activeNodes?: number; v2?: Float64Array; lambda3?: number; v3?: Float64Array; nodeIndex?: Map<string, number> } | undefined;
            if (isStructuralBatch && this.mode === "project" && this.tsBackend.tsProgram) {
                try {
                    const { SpectralTopologist } = await import("./spectral-topology.js");
                    preTopology = SpectralTopologist.analyze(this.tsBackend.tsProgram, this.rootNames);
                } catch { /* silent on hot path */ }
            }

            // Helper DRY: reused in healed path AND clean path
            const computeArchitectureDiff = async (): Promise<string | undefined> => {
                if (!isStructuralBatch || !preTopology
                    || this.mode !== "project" || !this.tsBackend.tsProgram) return undefined;
                try {
                    const { SpectralTopologist } = await import("./spectral-topology.js");
                    const postTopology = SpectralTopologist.analyze(
                        this.tsBackend.tsProgram, this.rootNames);

                    const eulerPre = preTopology.cyclomaticComplexity ?? 0;
                    const eulerPost = postTopology.cyclomaticComplexity ?? 0;
                    const eulerShift = eulerPost - eulerPre;
                    const eulerShiftStr = eulerShift > 0 ? `+${eulerShift}` : `${eulerShift}`;
                    const eulerIcon = eulerShift < 0 ? "📉 (Decoupled)"
                        : eulerShift > 0 ? "🍝 (Tangled)"
                        : "⚖️ (Stable)";

                    const delta = SpectralTopologist.computeDelta(preTopology, postTopology);
                    const fiedlerShift = preTopology.fiedlerValue > 0
                        ? ((delta.fiedlerPost - delta.fiedlerPre) / preTopology.fiedlerValue) * 100
                        : 0;
                    const icon = delta.verdict === "APPROVED" ? "✅"
                        : delta.verdict === "APPROVED_DECOUPLING" ? "🚀 DECOUPLED"
                        : "⚠️ FRACTURE RISK";

                    // Combinatorial Laplacian: λ₂ not scale-invariant across different N.
                    // Valid here: pre/post share same rootNames within a batch.
                    return `\n\n**[NREKI ARCHITECTURE DIFF]** *(symbol-level topology)*\n` +
                        `λ₂ (Algebraic Connectivity): ${delta.fiedlerPre.toFixed(4)} → ` +
                        `${delta.fiedlerPost.toFixed(4)} ` +
                        `(${fiedlerShift > 0 ? '+' : ''}${fiedlerShift.toFixed(1)}%) ${icon}\n` +
                        `Circuit Rank β₁: ${eulerPre} → ${eulerPost} ` +
                        `(${eulerShiftStr}) ${eulerIcon}\n` +
                        `Verdict: ${delta.verdict.replace(/_/g, " ")}`;
                } catch { return undefined; }
            };

            // A-01: Wrap Phase 1-4 so partial VFS mutations are rolled back on throw
            // Sidecar edits hoisted for catch-path compensatory rollback (Bomba 1)
            let sidecarEdits = new Map<LspSidecarBase, Array<{filePath: string; content: string | null}>>();
            try {

            // PHASE 1: Inject entire batch into VFS
            this.phase1_injectVfs(edits, rollbackState, transactionMutated, explicitlyEditedFiles);

            // PHASE 2: Rebuild incremental program
            this.tsBackend.updateProgram();

            // BUG 3 FIXED: Compute AI errors exactly ONCE.
            const originalFatalErrors = await this.tsBackend.getDiagnostics(filesToEvaluate, explicitlyEditedFiles, this.mode);

            // ─── Phase 2.5: LSP Sidecar Validation (Go, Python) ─────────
            const sidecarResult = await this.phase2_validateSidecars(edits, originalFatalErrors);
            sidecarEdits = sidecarResult.sidecarEdits;
            const sidecarWarnings = sidecarResult.sidecarWarnings;
            // ─── End Phase 2.5 ───────────────────────────────────────────

            // ─── TTRD SINTÁCTICO: Evaluación Post-Mutación ───
            for (const [posixPath, oldSigsMap] of preRawSignatures.entries()) {
                const newContent = this.vfs.get(posixPath) ?? "";
                const ext = path.extname(posixPath).toLowerCase();
                const newSigsMap = extractRawSignatures(newContent, ext);
                for (const [symbol, oldSig] of oldSigsMap.entries()) {
                    const newSig = newSigsMap.get(symbol);
                    if (newSig) {
                        const { isRegression, reason } = detectSignatureRegression(oldSig, newSig, ext);
                        if (isRegression) {
                            sidecarWarnings.push(
                                `[⚠️ TTRD WARNING] Type degradation detected in ${path.basename(posixPath)}::${symbol}().\n  Reason: ${reason}\n  Old: \`${oldSig}\`\n  New: \`${newSig}\``
                            );
                        }
                    }
                }
            }

            // PHASE 4: Verdict
            if (originalFatalErrors.length > 0) {

                // ─── NREKI L3.3: Iterative Auto-Healing (Dual Cascade) ─────────────────
                const tHealStart = performance.now();
                const healing = await this.phase4_healingCascade(
                    originalFatalErrors, explicitlyEditedFiles, filesToEvaluate, transactionMutated
                );

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

                    // Group fixes by type for readable output
                    const tsFixes = healing.appliedFixes.filter(f => !f.includes("LSP Auto-Heal"));
                    const lspFixes = healing.appliedFixes.filter(f => f.includes("LSP Auto-Heal"));

                    let fixSummary = "";
                    if (tsFixes.length > 0) {
                        fixSummary += `\n  TypeScript (CodeFix API):\n${tsFixes.join("\n")}`;
                    }
                    if (lspFixes.length > 0) {
                        fixSummary += `\n  Go/Python (LSP codeAction):\n${lspFixes.join("\n")}`;
                    }

                    // TTRD post-contracts (healed path)
                    const finalEditedFiles = new Set(explicitlyEditedFiles);
                    for (const f of healing.newlyTouchedFiles) finalEditedFiles.add(f);
                    const postContracts = await this.tsBackend.extractCanonicalTypes(finalEditedFiles);
                    const regressions = this.tsBackend.computeTypeRegressions(preContracts, postContracts);

                    this.restoreHologramVeil(temporarilyUnveiled);

                    const architectureDiff = await computeArchitectureDiff();

                    return {
                        safe: true,
                        exitCode: 0,
                        latencyMs: latency,
                        healedFiles: Array.from(healing.newlyTouchedFiles),
                        errorText:
                            `[NREKI AUTO-HEAL: ${healLatency}ms] ` +
                            `Your code had structural errors. NREKI applied deterministic fixes in RAM:\n` +
                            fixSummary +
                            patchNotice,
                        regressions: regressions.length > 0 ? regressions : undefined,
                        postContracts: postContracts.size > 0
                            ? new Map([...postContracts].map(([file, syms]) =>
                                [file, new Map([...syms].map(([sym, contract]) => [sym, contract.typeStr]))]
                              ))
                            : undefined,
                        warnings: sidecarWarnings.length > 0 ? sidecarWarnings : undefined,
                        architectureDiff,
                    };
                }
                // ─── END Auto-Healing ────────────────────────────────────

                // Healing failed. Use the ORIGINAL error matrix (do not recalculate).
                const structured = originalFatalErrors; // Already NrekiStructuredError[]

                // ACID rollback of the original edit
                for (const [posixPath, state] of rollbackState.entries()) {
                    if (state.content !== undefined) this.vfs.set(posixPath, state.content);
                    else this.vfs.delete(posixPath);

                    if (state.time) this.vfsClock.set(posixPath, state.time);
                    else this.vfsClock.delete(posixPath);

                    if (state.wasInRoot) this.rootNames.add(posixPath);
                    else this.rootNames.delete(posixPath);
                }
                // FIX BUG #4: Revert newly injected roots for hologram mode
                for (const newRoot of hologramTxNewRoots) {
                    this.rootNames.delete(newRoot);
                }

                // BOMBA 1 FIX: Compensatory Rollback — heal sidecar VFS
                // Without this, the LSP's internal VFS retains the rejected
                // edit and future validations run against a phantom state.
                await this.rollbackSidecars(sidecarEdits, rollbackState);

                // PATCH-1: Remove this transaction's files from mutatedFiles
                // to prevent ghost deletion in the next commitToDisk().
                for (const file of transactionMutated) this.mutatedFiles.delete(file);

                // B6: Restore logicalTime on rollback
                this.logicalTime = savedLogicalTime;
                // A-02: Restore vfsDirectories
                this.vfsDirectories = savedDirectories;
                // FIX: Clear hologram edit targets to prevent ghost unpruning
                this.currentEditTargets.clear();
                // P17 + P2 WARM-PATH: Advance clock instead of destroying program.
                this.logicalTime += 1000;
                for (const [posixPath] of rollbackState.entries()) {
                    this.vfsClock.set(posixPath, new Date(this.logicalTime));
                }
                this.tsBackend.updateProgram();
                // DR/LS synced via tsBackend

                const latency = (performance.now() - t0).toFixed(2);
                latencyTracker.record("intercept", parseFloat(latency));

                this.restoreHologramVeil(temporarilyUnveiled);

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
            const postContracts = await this.tsBackend.extractCanonicalTypes(explicitlyEditedFiles);
            const regressions = this.tsBackend.computeTypeRegressions(preContracts, postContracts);

            this.restoreHologramVeil(temporarilyUnveiled);

            const architectureDiff = await computeArchitectureDiff();

            return {
                safe: true,
                exitCode: 0,
                latencyMs: (() => { const l = (performance.now() - t0).toFixed(2); latencyTracker.record("intercept", parseFloat(l)); return l; })(),
                regressions: regressions.length > 0 ? regressions : undefined,
                postContracts: postContracts.size > 0
                    ? new Map([...postContracts].map(([file, syms]) =>
                        [file, new Map([...syms].map(([sym, contract]) => [sym, contract.typeStr]))]
                      ))
                    : undefined,
                warnings: sidecarWarnings.length > 0 ? sidecarWarnings : undefined,
                architectureDiff,
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
                // FIX BUG #4: Revert newly injected roots for hologram mode
                for (const newRoot of hologramTxNewRoots) {
                    this.rootNames.delete(newRoot);
                }
                // BOMBA 1 FIX: Compensatory Rollback on crash path
                await this.rollbackSidecars(sidecarEdits, rollbackState);

                // PATCH-1: Remove this transaction's files from mutatedFiles (crash path)
                for (const file of transactionMutated) this.mutatedFiles.delete(file);

                // A-02: Restore vfsDirectories
                this.vfsDirectories = savedDirectories;
                this.logicalTime = savedLogicalTime;
                // FIX: Clear hologram edit targets to prevent ghost unpruning
                this.currentEditTargets.clear();
                this.restoreHologramVeil(temporarilyUnveiled);
                // FIX: Poison the compiler cache to force cold rebuild.
                // Without this, the TypeScript BuilderProgram retains state
                // from the failed transaction, causing phantom errors on
                // the next interceptAtomicBatch call.
                this.tsBackend.purgeCache(true);
                throw phaseError;
            }
        } finally {
            clearTxId();
        }
        });
    }

    // ─── Extracted Phases (v8.3) ──────────────────────────────────────

    private phase1_injectVfs(
        edits: NrekiEdit[],
        rollbackState: Map<string, { content: string | null | undefined; time: Date | undefined; wasInRoot: boolean }>,
        transactionMutated: Set<string>,
        explicitlyEditedFiles: Set<string>,
    ): void {
        for (const edit of edits) {
            const posixPath = this.toPosix(path.resolve(this.projectRoot, edit.targetFile));
            const rootPosix = this.toPosix(path.resolve(this.projectRoot));

            if (!posixPath.startsWith(rootPosix + "/") && posixPath !== rootPosix) {
                throw new Error(
                    `[NREKI] Security rejection: Path traversal blocked. ` +
                    `"${edit.targetFile}" resolves outside project root.`
                );
            }

            const currentlyInRoots = this.rootNames.has(posixPath);

            if (!rollbackState.has(posixPath)) {
                rollbackState.set(posixPath, {
                    content: this.vfs.has(posixPath) ? this.vfs.get(posixPath) : undefined,
                    time: this.vfsClock.get(posixPath),
                    wasInRoot: currentlyInRoots,
                });
            }

            this.vfs.set(posixPath, edit.proposedContent);
            this.vfsClock.set(posixPath, new Date(this.logicalTime));
            if (!this.mutatedFiles.has(posixPath)) transactionMutated.add(posixPath);
            this.mutatedFiles.add(posixPath);

            if (edit.proposedContent === null) {
                this.rootNames.delete(posixPath);
            } else {
                explicitlyEditedFiles.add(posixPath);
                if (!currentlyInRoots && this.isTypeScriptFile(posixPath)) {
                    this.rootNames.add(posixPath);
                }
                let dir = path.posix.dirname(posixPath);
                const rootPosixDir = this.toPosix(path.resolve(this.projectRoot));
                while (dir.length >= rootPosixDir.length && dir !== rootPosixDir && dir !== ".") {
                    this.vfsDirectories.add(dir);
                    dir = path.posix.dirname(dir);
                }
            }
        }
    }

    private async phase2_validateSidecars(
        edits: NrekiEdit[],
        originalFatalErrors: NrekiStructuredError[],
    ): Promise<{
        sidecarEdits: Map<LspSidecarBase, Array<{ filePath: string; content: string | null }>>;
        sidecarWarnings: string[];
    }> {
        const sidecarEdits = new Map<LspSidecarBase, Array<{ filePath: string; content: string | null }>>();
        const sidecarWarnings: string[] = [];

        for (const edit of edits) {
            const posixPath = this.toPosix(path.resolve(this.projectRoot, edit.targetFile));
            const ext = path.extname(posixPath).toLowerCase();
            const sidecar = this.lspSidecars.get(ext);
            if (!sidecar) continue;
            const list = sidecarEdits.get(sidecar) || [];
            list.push({ filePath: posixPath, content: edit.proposedContent });
            sidecarEdits.set(sidecar, list);
        }

        for (const [sidecar, scEdits] of sidecarEdits) {
            if (!sidecar.isHealthy()) {
                try {
                    await sidecar.boot();
                } catch {
                    sidecarWarnings.push(
                        `[⚠️ NREKI WARNING: '${sidecar.command[0]}' not found or crashed. ` +
                        `Layer 2 Semantic Shield OFFLINE for ${sidecar.languageId} files. ` +
                        `Code passed syntax only. Install to enable strict validation.]`,
                    );
                    continue;
                }
            }
            try {
                const sidecarErrors = await sidecar.validateEdits(scEdits);
                originalFatalErrors.push(...sidecarErrors);
            } catch {
                sidecarWarnings.push(
                    `[⚠️ NREKI WARNING: ${sidecar.languageId} validation timed out. ` +
                    `Code passed without semantic check.]`,
                );
            }
        }

        return { sidecarEdits, sidecarWarnings };
    }

    private async phase4_healingCascade(
        originalFatalErrors: NrekiStructuredError[],
        explicitlyEditedFiles: Set<string>,
        filesToEvaluate: Set<string>,
        transactionMutated: Set<string>,
    ): Promise<{
        healed: boolean;
        appliedFixes: string[];
        newlyTouchedFiles: Set<string>;
        finalErrors: NrekiStructuredError[];
    }> {
        const tsOnlyErrors = originalFatalErrors.filter(e => this.isTypeScriptFile(e.file));
        const lspOnlyErrors = originalFatalErrors.filter(e => !this.isTypeScriptFile(e.file));

        let isFullyHealed = true;
        const allAppliedFixes: string[] = [];
        const allNewlyTouchedFiles = new Set<string>();

        let remainingTsErrors: NrekiStructuredError[] = tsOnlyErrors;
        if (tsOnlyErrors.length > 0) {
            const tsContext: TsHealingContext = {
                mode: this.mode,
                readContent: (p) => {
                    // v10.5.2: distinguish tombstone (null) from absent (undefined).
                    // Tombstone = file deleted in pending tx → return "" (no zombie disk read).
                    // Absent = file not in VFS → fall through to disk.
                    if (this.vfs.has(p)) {
                        const v = this.vfs.get(p);
                        return v ?? "";
                    }
                    return this.tsBackend.host.readFile(p) ?? "";
                },
                getAutoFixes: (f, e) => this.tsBackend.getAutoFixes(f, e),
                createSavepoint: (p) => ({
                    content: this.vfs.has(p) ? this.vfs.get(p) : undefined,
                    time: this.vfsClock.get(p),
                    wasInRoot: this.rootNames.has(p),
                }),
                applyMicroPatch: (p, content) => {
                    this.vfs.set(p, content);
                    this.vfsClock.set(p, new Date(this.logicalTime));
                    if (this.isTypeScriptFile(p) && !this.rootNames.has(p)) {
                        this.rootNames.add(p);
                    }
                },
                recompileAndEvaluate: async (evalSet, editSet) => {
                    this.logicalTime += 1000;
                    this.tsBackend.updateProgram();
                    return await this.tsBackend.getDiagnostics(evalSet, editSet, this.mode);
                },
                executeRollback: (undoLog, isMacro) => {
                    for (const [p, state] of undoLog.entries()) {
                        if (state.content !== undefined) this.vfs.set(p, state.content);
                        else this.vfs.delete(p);
                        if (state.time) this.vfsClock.set(p, state.time);
                        else this.vfsClock.delete(p);
                        if (state.wasInRoot) this.rootNames.add(p);
                        else this.rootNames.delete(p);
                    }
                    this.logicalTime += 1000;
                    if (isMacro) {
                        for (const p of undoLog.keys()) {
                            if (this.vfs.has(p)) this.vfsClock.set(p, new Date(this.logicalTime));
                        }
                    }
                    this.tsBackend.updateProgram();
                },
                recordStat: (healed) => {
                    if (healed) this._healingStats.applied++;
                    else this._healingStats.failed++;
                },
            };

            const tsHealing = await attemptAutoHealing(
                tsOnlyErrors, explicitlyEditedFiles, filesToEvaluate, tsContext
            );
            if (!tsHealing.healed) isFullyHealed = false;
            remainingTsErrors = tsHealing.finalErrors;
            allAppliedFixes.push(...tsHealing.appliedFixes);
            for (const f of tsHealing.newlyTouchedFiles) allNewlyTouchedFiles.add(f);
            if (tsHealing.healed) {
                for (const f of tsHealing.newlyTouchedFiles) explicitlyEditedFiles.add(f);
            }
        }

        let remainingLspErrors: NrekiStructuredError[] = lspOnlyErrors;
        if (isFullyHealed && lspOnlyErrors.length > 0) {
            const errorsBySidecar = new Map<LspSidecarBase, NrekiStructuredError[]>();
            for (const err of lspOnlyErrors) {
                const ext = path.extname(err.file).toLowerCase();
                const sidecar = this.lspSidecars.get(ext);
                if (sidecar) {
                    const arr = errorsBySidecar.get(sidecar) || [];
                    arr.push(err);
                    errorsBySidecar.set(sidecar, arr);
                }
            }
            remainingLspErrors = [];
            for (const [sidecar, errors] of errorsBySidecar.entries()) {
                const lspContext: LspHealingContext = {
                    languageId: sidecar.languageId,
                    isDead: () => sidecar.isDead,
                    readContent: (p) => {
                        const v = this.vfs.get(p);
                        if (v !== undefined && v !== null) return v;
                        return fs.readFileSync(p, "utf-8");
                    },
                    resolvePath: (rawPath) => {
                        const resolved = this.toPosix(path.resolve(this.projectRoot, rawPath));
                        const rootPosix = this.toPosix(path.resolve(this.projectRoot));
                        if (!resolved.startsWith(rootPosix + "/") && resolved !== rootPosix) {
                            return null;
                        }
                        return resolved;
                    },
                    getLspOffset: (content, line, character) =>
                        this.getLspOffset(content, line, character),
                    requestCodeActions: (file, diagnostic) =>
                        (sidecar as any).requestCodeActions(file, diagnostic),
                    validateLspEdits: async (editedFiles) => {
                        this.logicalTime += 1000;
                        const scEdits = Array.from(editedFiles).map(f => ({
                            filePath: f, content: this.vfs.get(f) ?? null,
                        }));
                        return await sidecar.validateEdits(scEdits);
                    },
                    createSavepoint: (p) => ({
                        content: this.vfs.has(p) ? this.vfs.get(p) : undefined,
                        time: this.vfsClock.get(p),
                    }),
                    applyMicroPatch: (p, content) => {
                        this.vfs.set(p, content);
                        this.vfsClock.set(p, new Date(this.logicalTime));
                    },
                    executeRollback: async (undoLog, isMacro) => {
                        const rollbacks: Array<{ filePath: string; content: string | null }> = [];
                        for (const [p, state] of undoLog.entries()) {
                            if (state.content !== undefined) this.vfs.set(p, state.content);
                            else this.vfs.delete(p);
                            if (state.time) this.vfsClock.set(p, state.time);
                            else this.vfsClock.delete(p);
                            rollbacks.push({ filePath: p, content: state.content ?? null });
                        }
                        if (isMacro) this.logicalTime += 1000;
                        if (rollbacks.length > 0) {
                            try {
                                await sidecar.validateEdits(rollbacks);
                            } catch {
                                sidecar.isDead = true;
                            }
                        }
                    },
                    recordStat: (healed) => {
                        if (healed) this._healingStats.applied++;
                        else this._healingStats.failed++;
                    },
                };

                const lspHealing = await attemptLspAutoHealing(errors, explicitlyEditedFiles, lspContext);
                if (!lspHealing.healed) {
                    isFullyHealed = false;
                    remainingLspErrors.push(...lspHealing.finalErrors);
                } else {
                    allAppliedFixes.push(...lspHealing.appliedFixes);
                    for (const f of lspHealing.newlyTouchedFiles) allNewlyTouchedFiles.add(f);
                    for (const f of lspHealing.newlyTouchedFiles) explicitlyEditedFiles.add(f);
                }
            }
        }

        const healed = isFullyHealed && (remainingTsErrors.length + remainingLspErrors.length) === 0;

        if (healed) {
            for (const f of allNewlyTouchedFiles) {
                if (!this.mutatedFiles.has(f)) transactionMutated.add(f);
                this.mutatedFiles.add(f);
            }
        }

        return {
            healed,
            appliedFixes: allAppliedFixes,
            newlyTouchedFiles: allNewlyTouchedFiles,
            finalErrors: [...remainingTsErrors, ...remainingLspErrors],
        };
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
        const createdTmps: string[] = [];

        // Scope writes to files mutated in the current transaction only.
        // Prevents stale VFS entries from prior intercepts leaking into this commit.
        const filesToCommit = new Set(this.mutatedFiles);

        try {
            // PHASE 1: Physical backup
            for (const posixPath of filesToCommit) {
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

            // WAL: Write intent log before destructive Phase 2.
            // If the process crashes between Phase 1 (backup) and Phase 2 (write),
            // boot() will find this WAL and automatically restore from backups.
            const txDir = path.join(this.projectRoot, ".nreki", "transactions");
            const walPath = path.join(txDir, "wal.json");
            try {
                if (!fs.existsSync(txDir)) fs.mkdirSync(txDir, { recursive: true });
                // Atomic write via temp+rename. writeFileSync overwrites in-place
                // and is NOT atomic — OOM/crash mid-write truncates the WAL.
                // rename() is atomic on POSIX (single inode pointer swap).
                const walTmpPath = `${walPath}.tmp`;
                fs.writeFileSync(walTmpPath, JSON.stringify({
                    status: "pending",
                    ts: new Date().toISOString(),
                    files: physicalUndoLog.map(l => ({ target: l.target, backup: l.backup })),
                }), "utf-8");
                fs.renameSync(walTmpPath, walPath);
            } catch (walErr) {
                // WAL write failure is non-fatal but must be logged — proceeding
                // without crash safety means a power failure during Phase 2 is unrecoverable.
                logger.warn(`WAL write failed: ${walErr}. Proceeding without crash recovery safety.`);
            }

            // PHASE 2: Destructive writes
            for (const posixPath of filesToCommit) {
                const content = this.vfs.get(posixPath) ?? null;
                const osPath = path.normalize(posixPath);
                if (content === null) {
                    if (fs.existsSync(osPath)) fs.unlinkSync(osPath);
                } else {
                    const dir = path.dirname(osPath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    const tmp = `${osPath}.nreki-${crypto.randomBytes(4).toString("hex")}.tmp`;
                    createdTmps.push(tmp); // Push BEFORE write so catch can clean up on ENOSPC
                    fs.writeFileSync(tmp, content, "utf-8");
                    fs.renameSync(tmp, osPath);
                    createdTmps.pop(); // Rename succeeded — no longer orphan
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
            this.tsBackend.purgeCache();
            try {
                this.tsBackend.updateProgram();
                // DR/LS synced via tsBackend
                this.tsBackend.captureBaseline(undefined, this.mode);
            } catch (rebuildErr) {
                // A-10: Force full rebuild on next operation
                this.tsBackend.purgeCache();
                // Restore VFS to pre-clear state for consistency with rolled-back disk
                for (const [k, v] of savedVfs) this.vfs.set(k, v);
                for (const [k, v] of savedClock) this.vfsClock.set(k, v);
                for (const d of savedDirs) this.vfsDirectories.add(d);
                throw rebuildErr;
            }

            // Persist build state for next session (warm boot)
            try {
                this.tsBackend.tsBuilder!.emit(
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
            // WAL: Transaction complete — delete intent log
            try { if (fs.existsSync(walPath)) fs.unlinkSync(walPath); } catch { /* best effort */ }

            // Release stale AST versions from DocumentRegistry
            this.tsBackend.releaseMutatedDocuments(this.mutatedFiles);
            this.mutatedFiles.clear();

            logger.info("Atomic commit materialized. Disk synchronized.");
        } catch (error) {
            // PHYSICAL ROLLBACK
            logger.error(`OS write failure! Physical rollback: ${error}`);

            // AUDIT FIX: Clean orphan .tmp files written before the crash
            for (const tmpPath of createdTmps) {
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best effort */ }
            }

            for (const log of physicalUndoLog) {
                try {
                    if (log.backup) {
                        if (fs.existsSync(log.backup)) fs.renameSync(log.backup, log.target);
                    } else {
                        if (fs.existsSync(log.target)) fs.unlinkSync(log.target);
                    }
                } catch { /* Cascade panic - best effort */ }
            }

            // VFS ZOMBIE FIX: Purge RAM state that never reached disk.
            // Without this, the next readFile() serves ghost content
            // desynchronized from the real filesystem.
            this.vfs.clear();
            this.vfsClock.clear();
            this.vfsDirectories.clear();
            // CRITICAL FIX: Clear mutatedFiles to prevent the next commitToDisk()
            // from iterating stale entries, reading null from empty VFS,
            // and executing fs.unlinkSync() on real user files.
            this.mutatedFiles.clear();
            this.logicalTime += 1000;

            // Force cold rebuild from disk reality
            this.tsBackend.purgeCache();
            try {
                this.tsBackend.updateProgram();
                // DR/LS synced via tsBackend
                this.tsBackend.captureBaseline(undefined, this.mode);
            } catch {
                // If rebuild also fails, mark kernel for full reconstruction
                this.tsBackend.purgeCache(true);
            }

            throw new Error(`[NREKI] Physical ACID commit failed. Repository and VFS restored. Reason: ${error}`);
        }
        });
    }

    /** Emergency rollback - purge all staged changes (P3). */
    public async rollbackAll(): Promise<void> {
        return this.mutex.withLock(async () => {
            this.vfs.clear();
            this.vfsClock.clear();
            this.vfsDirectories.clear();
            // CRITICAL FIX: Prevent stale mutatedFiles from deleting real files
            // in the next commitToDisk() call.
            this.tsBackend.releaseMutatedDocuments(new Set(this.mutatedFiles));
            this.mutatedFiles.clear();
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
                        [...this.rootNames].filter(f => /\.d\.[mc]?ts$/i.test(f)),
                    );
                    this.tsBackend.rootNames = this.rootNames;
                } else if (this.ambientFiles.length > 0) {
                    // Eager mode: re-filter to ambient-only
                    const ambientSet = new Set(
                        this.ambientFiles.map(f => this.toPosix(path.resolve(this.projectRoot, f))),
                    );
                    this.rootNames = new Set(
                        [...this.rootNames].filter(f => ambientSet.has(f)),
                    );
                    this.tsBackend.rootNames = this.rootNames;
                    this.buildShadowLookups();
                }
            }
            // WARM-PATH: Advance clock to invalidate cached files.
            // Only destroy builderProgram if it doesn't exist yet.
            this.logicalTime += 1000;
            this.tsBackend.updateProgram();
                // DR/LS synced via tsBackend
            // Release stale AST versions from DocumentRegistry
            this.tsBackend.releaseMutatedDocuments(this.mutatedFiles);
            logger.warn("Hard rollback executed. VFS purged.");
        });
    }

    // ─── Utilities ─────────────────────────────────────────────────

    /**
     * Restore the hologram veil for temporarily unveiled files.
     * Re-adds files to the pruned/shadow lookups, removes them from rootNames,
     * and invalidates JIT classification cache. Clears currentEditTargets.
     */
    private restoreHologramVeil(temporarilyUnveiled: Set<string>): void {
        if (this.mode === "hologram" && temporarilyUnveiled.size > 0) {
            for (const file of temporarilyUnveiled) {
                this.prunedTsLookup.add(file);
                this.shadowDtsLookup.add(file.replace(/\.([mc]?)tsx?$/, ".d.$1ts"));
                this.rootNames.delete(file);
                this.vfsClock.set(file, new Date(this.logicalTime + 1));
                this.jitClassifiedCache.delete(file);
            }
        }
        this.currentEditTargets.clear();
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
        if (!this.booted || !this.tsBackend.tsLanguageService || !this.tsBackend.tsBuilder) {
            throw new Error("[NREKI] Kernel or Language Service not booted.");
        }

        const posixPath = this.toPosix(path.resolve(this.projectRoot, targetFile));
        const program = this.tsBackend.tsLanguageService.getProgram();
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
                ) && (parent as ts.NamedDeclaration).name === node) {
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
        const references = this.tsBackend.tsLanguageService.findReferences(posixPath, targetPos);
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
                let lineMap = this.lineMapCache.get(refSourceFile);
                if (!lineMap) {
                    lineMap = new LineMap(refSourceFile.text);
                    this.lineMapCache.set(refSourceFile, lineMap);
                }
                const lineText = lineMap.getLine(line, refSourceFile.text).trim();

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

    public getTypeShape(targetFile: string, symbolName: string): string | null {
        if (!this.booted) throw new Error("Kernel not booted.");
        const posixPath = this.resolvePosixPath(targetFile);
        return this.tsBackend.getTypeShape(posixPath, symbolName);
    }

    public getStagingSize(): number { return this.vfs.size; }
    public getTrackedFiles(): number { return this.rootNames.size; }
    /**
     * @internal
     * For test assertions only. Checks if a file is currently tracked in rootNames.
     */
    public hasRootName(filePath: string): boolean {
        return this.rootNames.has(this.resolvePosixPath(filePath));
    }
    public getBaselineErrorCount(): number {
        return this.tsBackend.getBaselineErrorCount();
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
    public setJitParser(parser: Parser, tsLanguage: Parser.Language): void {
        this.jitParser = parser;
        this.jitTsLanguage = tsLanguage;
    }

    /** Set JIT classifier function (classifyAndGenerateShadow). */
    public setJitClassifier(fn: (filePath: string, content: string, parser: Parser, lang: Parser.Language) => { prunable: boolean; shadow: string | null }): void {
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
        return this.tsBackend.tsProgram;
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
            const dtsPath = tsPath.replace(/\.([mc]?)tsx?$/, ".d.$1ts");
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
            const dtsPath = tsPath.replace(/\.([mc]?)tsx?$/, ".d.$1ts");
            this.shadowDtsLookup.add(dtsPath);
            this.prunedTsLookup.add(tsPath);
        }
    }

    // ─── LSP Sidecar Management ─────────────────────────────────────

    /**
     * Compensatory Rollback — heal sidecar VFS on ACID abort.
     *
     * When `interceptAtomicBatch` rejects a transaction, the TypeScript VFS
     * is rolled back via the `rollbackState` map. But LSP sidecars (gopls,
     * pyright) have their OWN VFS in RAM. If we don't re-inject the original
     * content, the sidecar's next `validateEdits` call will run against the
     * phantom (rejected) code, causing a brain-split.
     *
     * Awaits all rollbacks via Promise.all to ensure sidecar VFS consistency
     * before returning. If a rollback fails, marks the sidecar dead for respawn.
     */
    private async rollbackSidecars(
        sidecarEdits: Map<LspSidecarBase, Array<{filePath: string; content: string | null}>>,
        rollbackState: Map<string, {content: string | null | undefined; time: Date | undefined; wasInRoot: boolean}>,
    ): Promise<void> {
        if (sidecarEdits.size === 0) return;

        const promises: Promise<void | NrekiStructuredError[]>[] = [];
        for (const [sidecar, scEdits] of sidecarEdits) {
            if (sidecar.isDead) continue;
            const rollbacks: Array<{filePath: string; content: string | null}> = [];

            for (const edit of scEdits) {
                const posixPath = this.toPosix(path.resolve(this.projectRoot, edit.filePath));
                const state = rollbackState.get(posixPath);

                let originalContent: string | null = null;
                if (state && state.content !== undefined) {
                    originalContent = state.content;
                } else {
                    // File didn't exist in VFS, try reading from disk
                    try { originalContent = fs.readFileSync(edit.filePath, "utf-8"); } catch { originalContent = null; }
                }

                rollbacks.push({ filePath: edit.filePath, content: originalContent });
            }

            if (rollbacks.length > 0) {
                promises.push(
                    sidecar.validateEdits(rollbacks).catch(() => {
                        sidecar.isDead = true;
                    })
                );
            }
        }
        await Promise.all(promises);
    }

    /**
     * Register an LSP sidecar for a file extension.
     * Called during initialization (index.ts) when project markers are detected.
     * Example: kernel.registerSidecar(".go", new GoLspSidecar(root));
     */
    public registerSidecar(ext: string, sidecar: LspSidecarBase): void {
        this.lspSidecars.set(ext, sidecar);
    }

    /**
     * Shutdown all LSP sidecars (kill child processes).
     * Called on MCP server close to prevent orphan processes.
     */
    public async shutdownSidecars(): Promise<void> {
        const unique = new Set(this.lspSidecars.values());
        for (const sidecar of unique) {
            try { await sidecar.shutdown(); } catch { /* best effort */ }
        }
        this.lspSidecars.clear();
    }
}
