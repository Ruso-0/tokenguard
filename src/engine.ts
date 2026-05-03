/**
 * engine.ts - Core Orchestrator Facade for NREKI (v8.5+)
 *
 * Thin facade over:
 *  - NrekiDB (persistence)
 *  - ASTParser (Tree-sitter)
 *  - Embedder (ONNX local embeddings)
 *  - IndexPipeline (write side — see engine/indexer.ts)
 *  - SearchEngine (read side — see engine/searcher.ts)
 *  - SessionTracker (token savings telemetry)
 *
 * All processing is local. Zero cloud dependencies.
 */

import fs from "fs";
import path from "path";
import chokidar, { type FSWatcher } from "chokidar";

import { NrekiDB, type ChunkRecord, type FastGrepHit } from "./database.js";
import { Embedder, getEmbedder } from "./embedder.js";
import { ASTParser, type ParseResult } from "./parser.js";
import { Compressor, type CompressionResult } from "./compressor.js";
import { AdvancedCompressor, type CompressionLevel, type AdvancedCompressionResult } from "./compressor.js";
import { shouldProcess } from "./utils/file-filter.js";
import { readSource } from "./utils/read-source.js";
import { safePath } from "./utils/path-jail.js";
import { getOrGenerateRepoMap, type RepoMap, type DependencyGraph } from "./repo-map.js";
import { logger } from "./utils/logger.js";

// ─── Sub-pipelines (v8.5 decomposition) ──────────────────────────────
import { IndexPipeline } from "./engine/indexer.js";
import { SearchEngine } from "./engine/searcher.js";

// ─── Shared types (re-exported for backward compatibility) ──────────
export type { SearchResult, IndexStats, EngineConfig, SessionReport } from "./engine-types.js";
import type { EngineConfig, IndexStats, SessionReport } from "./engine-types.js";

// ─── Default config ──────────────────────────────────────────────────

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".css", ".json", ".html"];

const DEFAULT_IGNORE = [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
    "**/coverage/**",
    "**/.next/**",
    "**/__pycache__/**",
    "**/*.min.js",
    "**/*.d.ts",
    // NREKI's own artifacts (prevents auto-indexing of self in dogfooding
    // and contamination of corpus benchmarks against external repos)
    "**/.nreki/**",
    "**/.nreki.db*",
];

// ─── Session Tracker ─────────────────────────────────────────────────

class SessionTracker {
    private totalTokensSaved = 0;
    private totalOriginalTokens = 0;
    private compressionsByType = new Map<string, { count: number; saved: number; original: number }>();
    private startTime = Date.now();
    private autoContextInjections = 0;

    public recordCompression(ext: string, originalTokens: number, savedTokens: number): void {
        this.totalTokensSaved += savedTokens;
        this.totalOriginalTokens += originalTokens;
        const entry = this.compressionsByType.get(ext) ?? { count: 0, saved: 0, original: 0 };
        entry.count++;
        entry.saved += savedTokens;
        entry.original += originalTokens;
        this.compressionsByType.set(ext, entry);
    }

    public incrementAutoContext(): void {
        this.autoContextInjections++;
    }

    public getReport(): SessionReport {
        const durationMs = Date.now() - this.startTime;
        const durationMinutes = durationMs / 60_000;
        const totalSaved = this.totalTokensSaved;
        const totalOriginal = this.totalOriginalTokens;

        const byFileType: SessionReport["byFileType"] = [];
        for (const [ext, data] of this.compressionsByType) {
            byFileType.push({
                ext,
                count: data.count,
                tokensSaved: data.saved,
                originalTokens: data.original,
                ratio: data.original > 0 ? 1 - (data.original - data.saved) / data.original : 0,
            });
        }
        byFileType.sort((a, b) => b.tokensSaved - a.tokensSaved);

        return {
            durationMinutes: Math.round(durationMinutes * 10) / 10,
            totalTokensSaved: totalSaved,
            totalOriginalTokens: totalOriginal,
            overallRatio: totalOriginal > 0 ? totalSaved / totalOriginal : 0,
            savedUsdSonnet: (totalSaved / 1_000_000) * 3,
            savedUsdOpus: (totalSaved / 1_000_000) * 15,
            byFileType,
            autoContextInjections: this.autoContextInjections,
        };
    }
}

// ─── NREKI Engine ────────────────────────────────────────────────────

export class NrekiEngine {
    private db: NrekiDB;
    private embedder: Embedder;
    private parser: ASTParser;
    private compressor: Compressor;
    private advancedCompressor: AdvancedCompressor;

    // Sub-pipelines (injected after initialize)
    private indexer!: IndexPipeline;
    private searcher!: SearchEngine;

    private watcher: FSWatcher | null = null;
    private watcherReady: Promise<void> | null = null;
    private config: Required<EngineConfig>;
    private indexingQueue = new Set<string>();
    private isIndexing = false;
    private initialized = false;
    private saveTimeout: NodeJS.Timeout | null = null;
    private embedderReady = false;

    /** Files that have been read (raw or compressed) in this session. */
    private safelyReadFiles = new Set<string>();

    /** Session-level savings tracker. */
    private sessionTracker = new SessionTracker();

    /** Lazy-loaded topology cache (invalidated on file changes). */
    private cachedGraph: DependencyGraph | null = null;

    /** Cryptographic tickets for in-flight internal edits (expected disk hash). */
    private expectedInternalHashes = new Map<string, string>();

    constructor(config: EngineConfig = {}) {
        this.config = {
            dbPath: config.dbPath ?? ".nreki.db",
            watchPaths: config.watchPaths ?? ["./src"],
            extensions: config.extensions ?? DEFAULT_EXTENSIONS,
            ignorePaths: config.ignorePaths ?? DEFAULT_IGNORE,
            wasmDir: config.wasmDir ?? "",
            enableEmbeddings: config.enableEmbeddings ?? false,
        };

        // Defensive: empty watchPaths is a programmer error
        if (this.config.watchPaths.length === 0) {
            throw new Error("[NREKI] watchPaths cannot be empty");
        }

        this.db = new NrekiDB(this.config.dbPath);
        this.embedder = getEmbedder();
        this.parser = new ASTParser(this.config.wasmDir || undefined);
        this.compressor = new Compressor(this.parser, this.embedder);
        this.advancedCompressor = new AdvancedCompressor(this.parser, this.embedder);
    }

    // ─── Initialization ────────────────────────────────────────────

    /**
     * Fast initialization: SQLite + Tree-sitter only.
     * Completes in ~100ms. Does NOT load the ONNX embedding model.
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;
        await this.db.initialize();
        await this.parser.initialize();

        // Inject dependencies into sub-pipelines
        this.indexer = new IndexPipeline(
            this.db, this.parser, this.embedder, this.config,
            () => this.initialize(),
            () => this.initializeEmbedder(),
        );
        this.searcher = new SearchEngine(
            this.db, this.embedder, this.config,
            () => this.getDependencyGraph(),
            () => this.getProjectRoot(),
            () => this.initialize(),
            () => this.initializeEmbedder(),
        );

        this.initialized = true;
    }

    /**
     * Full initialization: adds ONNX embedding model on top of fast init.
     * First call takes ~5-10s (model download + warm-up). Subsequent calls are O(1).
     */
    async initializeEmbedder(): Promise<void> {
        await this.initialize();
        if (this.embedderReady) return;

        await this.embedder.initialize();
        this.db.checkEmbeddingDimension(this.embedder.getDimension());
        this.embedderReady = true;
    }

    // ─── Indexing (delegated to IndexPipeline) ─────────────────────

    async indexFile(filePath: string): Promise<ParseResult | null> {
        await this.initialize();
        return this.indexer.indexFile(filePath);
    }

    async indexDirectory(dirPath: string): Promise<{ indexed: number; skipped: number; errors: number }> {
        await this.initialize();
        return this.indexer.indexDirectory(dirPath);
    }

    // ─── Search (delegated to SearchEngine) ─────────────────────────

    async search(query: string, limit: number = 10) {
        await this.initialize();
        return this.searcher.search(query, limit);
    }

    // ─── Compression ───────────────────────────────────────────────

    /** Compress a file for token-efficient reading. */
    async compressFile(
        filePath: string,
        tier: 1 | 2 | 3 = 1,
        focusQuery?: string,
    ): Promise<CompressionResult> {
        await this.initialize();

        // PATH JAIL: Validate path before any I/O.
        const projectRoot = this.config.watchPaths[0] || process.cwd();
        filePath = safePath(projectRoot, filePath);

        // FIX 7: Check file size/extension
        const stat = fs.statSync(filePath);
        const filterResult = shouldProcess(filePath, stat.size);
        if (!filterResult.process) {
            throw new Error(`File skipped: ${filterResult.reason}`);
        }

        const content = readSource(filePath);
        return this.compressor.compress(filePath, content, { tier, focusQuery });
    }

    /** Compress a file using the advanced LLMLingua-2-inspired pipeline. */
    async compressFileAdvanced(
        filePath: string,
        level: CompressionLevel = "medium",
        preloadedContent?: string,
    ): Promise<AdvancedCompressionResult> {
        await this.initialize();

        // PATH JAIL: Validate path before any I/O.
        const projectRoot = this.config.watchPaths[0] || process.cwd();
        filePath = safePath(projectRoot, filePath);

        // Validate size ALWAYS - even with preloaded content (prevents bypass)
        let sizeInBytes: number;
        if (preloadedContent !== undefined) {
            sizeInBytes = Buffer.byteLength(preloadedContent, "utf8");
        } else {
            try {
                sizeInBytes = fs.statSync(filePath).size;
            } catch {
                throw new Error(`Cannot access file: ${filePath}`);
            }
        }
        const filterResult = shouldProcess(filePath, sizeInBytes);
        if (!filterResult.process) {
            throw new Error(`File skipped: ${filterResult.reason}`);
        }

        const content = preloadedContent ?? readSource(filePath);
        const result = await this.advancedCompressor.compress(filePath, content, level);

        // Track session savings
        const ext = path.extname(filePath).toLowerCase() || ".unknown";
        this.sessionTracker.recordCompression(ext, Embedder.estimateTokens(content), result.tokensSaved);

        return result;
    }

    /**
     * Mark a file as safely read (raw or compressed) in this session.
     * Used by Danger Zones to filter out files that are no longer a risk.
     */
    markFileRead(filePath: string): void {
        this.safelyReadFiles.add(path.resolve(filePath));
    }

    /** Resolve import signatures via BM25 for Auto-Context injection */
    resolveImportSignatures(deps: Array<{ symbol: string; pathHint: string }>): Array<{ raw: string; path: string }> {
        return this.db.resolveImportSignatures(deps);
    }

    upsertEngram(filePath: string, symbolName: string, astHash: string, insight: string): void {
        this.db.upsertEngram(filePath, symbolName, astHash, insight);
    }

    getEngramsForFile(filePath: string): Map<string, { astHash: string; insight: string }> {
        return this.db.getEngramsForFile(filePath);
    }

    deleteEngram(filePath: string, symbolName: string): void {
        this.db.deleteEngram(filePath, symbolName);
    }

    /** Increment the auto-context injection counter */
    incrementAutoContext(): void {
        this.sessionTracker.incrementAutoContext();
    }

    /**
     * Get the heaviest files that haven't been safely read yet.
     * Filters out files already compressed/read in this session.
     */
    getTopHeavyFiles(limit: number = 5): Array<{ path: string; estimated_tokens: number }> {
        const allHeavy = this.db.getTopHeavyFiles(limit + 20);
        return allHeavy
            .filter(f => !this.safelyReadFiles.has(path.resolve(f.path)))
            .slice(0, limit);
    }

    /** Get a comprehensive session savings report. */
    getSessionReport(): SessionReport {
        return this.sessionTracker.getReport();
    }

    // ─── Accessors ─────────────────────────────────────────────────

    /** Get the AST parser instance (for use by AST navigator). */
    getParser(): ASTParser {
        return this.parser;
    }

    /** Get the project root directory. */
    getProjectRoot(): string {
        return this.config.watchPaths[0] || process.cwd();
    }

    // ─── DB Delegation Wrappers (Facade) ───────────────────────────

    /** Persistent key-value store for session state (uses existing metadata table in SQLite) */
    getMetadata(key: string): string | null {
        if (!this.db.ready) return null;
        return this.db.getMetadata(key);
    }

    setMetadata(key: string, value: string): void {
        if (!this.db.ready) return;
        this.db.setMetadata(key, value);
        this.db.save();
    }

    // ─── Repo Map ──────────────────────────────────────────────────

    async getRepoMap(forceRefresh: boolean = false): Promise<{ map: RepoMap; text: string; fromCache: boolean }> {
        await this.initialize();
        const result = await getOrGenerateRepoMap(this.getProjectRoot(), this.parser, forceRefresh);
        if (result.map.graph && !this.cachedGraph && !forceRefresh) {
            this.cachedGraph = result.map.graph;
        }
        return result;
    }

    /**
     * Lazy-load and cache the dependency graph for T-RAG scoring.
     * First call: O(N log N) in repo-map generation (parser scan + graph build).
     * Subsequent calls: O(1) cache hit.
     * Invalidated on file changes by the watcher.
     */
    async getDependencyGraph(): Promise<DependencyGraph> {
        if (this.cachedGraph) return this.cachedGraph;
        const { map } = await this.getRepoMap();
        if (map.graph) {
            this.cachedGraph = map.graph;
            return map.graph;
        }
        return { importedBy: new Map(), inDegree: new Map(), tiers: new Map() };
    }

    // ─── Cryptographic ticket API (internal-edit detection) ────────

    private normalizeInternalPath(filePath: string): string {
        return path.resolve(this.getProjectRoot(), filePath).replace(/\\/g, "/");
    }

    public expectInternalEdit(filePath: string, content: string): void {
        const posixPath = this.normalizeInternalPath(filePath);
        this.expectedInternalHashes.set(posixPath, this.db.hashContent(content));
        if (this.expectedInternalHashes.size > 100) {
            const firstKey = this.expectedInternalHashes.keys().next().value;
            if (firstKey !== undefined) {
                this.expectedInternalHashes.delete(firstKey);
            }
        }
    }

    public cancelInternalEdit(filePath: string): void {
        this.expectedInternalHashes.delete(this.normalizeInternalPath(filePath));
    }

    public invalidateCachedGraph(): void {
        this.cachedGraph = null;
        logger.info("Topology cache invalidated due to structural changes.");
    }

    /**
     * Exhaustive scan for files containing a symbol.
     * Used by AST navigator for definition/references lookup.
     */
    async searchFilesBySymbol(symbolName: string): Promise<string[]> {
        await this.initialize();
        return this.db.searchRawCode(symbolName);
    }

    /**
     * Fast symbol lookup via SQLite. Used by ast-navigator findDefinition fast path.
     * Returns chunks matching symbol_name. If exact=false, COLLATE NOCASE fallback.
     */
    async getChunksBySymbolExact(symbolName: string, exact: boolean = true): Promise<ChunkRecord[]> {
        await this.initialize();
        return this.db.getChunksBySymbolExact(symbolName, exact);
    }

    /**
     * Fast raw_code substring search via SQLite. Used by nreki_navigate fast_grep.
     */
    async searchRawCodeLike(queryText: string, limit: number = 50): Promise<ChunkRecord[]> {
        await this.initialize();
        return this.db.searchRawCodeLike(queryText, limit);
    }

    /**
     * Exact substring search via SQLite INSTR. Returns only (path, raw_code,
     * start_line, symbol_name). Used by the nreki_navigate fast_grep handler.
     */
    async fastGrep(queryText: string, limit: number = 50): Promise<FastGrepHit[]> {
        await this.initialize();
        return this.db.fastGrep(queryText, limit);
    }

    /** Find all files that import the given file path (relative). */
    async findDependents(filePath: string): Promise<string[]> {
        const graph = await this.getDependencyGraph();
        const normalized = filePath.replace(/\\/g, "/");
        const deps = graph.importedBy.get(normalized);
        return deps ? [...deps] : [];
    }

    // ─── File Watching ────────────────────────────────────────────

    startWatcher(): Promise<void> {
        if (this.watcher) return this.watcherReady ?? Promise.resolve();

        const shouldWatchFile = (fp: string) => this.config.extensions.includes(path.extname(fp).toLowerCase());

        this.watcher = chokidar.watch(this.config.watchPaths, {
            ignored: this.config.ignorePaths,
            persistent: true,
            ignoreInitial: true, // prevent race with handler bootstrap
        });

        this.watcherReady = new Promise((resolve, reject) => {
            this.watcher!.once("ready", resolve);
            this.watcher!.once("error", reject);
        });

        this.watcher
            .on("add", (fp: string) => { if (shouldWatchFile(fp)) this.queueIndexing(fp); })
            .on("change", (fp: string) => { if (shouldWatchFile(fp)) this.queueIndexing(fp); })
            .on("unlink", (fp: string) => {
                if (!shouldWatchFile(fp)) return;
                this.db.clearChunks(fp);
                this.scheduleSave();
            });

        return this.watcherReady;
    }

    /** Queue a file for indexing (debounced). */
    private queueIndexing(filePath: string): void {
        this.indexingQueue.add(filePath);
        this.processQueue();
    }

    /** Process the indexing queue. */
    private async processQueue(): Promise<void> {
        if (this.isIndexing) return;
        this.isIndexing = true;
        let madeChanges = false;
        let externalTopologyChange = false;

        try {
            while (this.indexingQueue.size > 0) {
                const [filePath] = this.indexingQueue;
                this.indexingQueue.delete(filePath);

                const posixPath = this.normalizeInternalPath(filePath);
                const expectedHash = this.expectedInternalHashes.get(posixPath);

                let diskContent: string | null = null;
                try {
                    diskContent = readSource(filePath);
                } catch { /* file deleted or read error */ }

                if (diskContent !== null) {
                    const currentHash = this.db.hashContent(diskContent);
                    if (expectedHash && expectedHash === currentHash) {
                        this.expectedInternalHashes.delete(posixPath);
                    } else {
                        externalTopologyChange = true;
                        this.expectedInternalHashes.delete(posixPath);
                    }
                } else {
                    externalTopologyChange = true;
                    this.expectedInternalHashes.delete(posixPath);
                }

                try {
                    const res = await this.indexFile(filePath);
                    if (res || diskContent === null) madeChanges = true;
                } catch (err) {
                    logger.error(
                        `Queue error for ${filePath}: ${(err as Error).message}`
                    );
                }
            }
        } finally {
            if (madeChanges) {
                this.scheduleSave();
                if (externalTopologyChange) {
                    this.cachedGraph = null;
                    logger.info("Topology cache invalidated by Watcher (external modification).");
                }
            }
            this.isIndexing = false;
        }
    }

    /** Stop the file watcher. */
    stopWatcher(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
            this.watcherReady = null;
        }
    }

    // ─── DB Delegation Wrappers (Stats & Tracking) ─────────────────

    /** Get indexing statistics. */
    getStats(): IndexStats {
        const dbStats = this.db.getStats();
        return {
            filesIndexed: dbStats.total_files,
            totalChunks: dbStats.total_chunks,
            totalRawChars: dbStats.total_raw_tokens,
            totalShorthandChars: dbStats.total_shorthand_tokens,
            compressionRatio: dbStats.compression_ratio,
            watchedPaths: this.config.watchPaths,
        };
    }

    /** Log token usage for a tool invocation. */
    logUsage(
        toolName: string,
        inputTokens: number,
        outputTokens: number,
        savedTokens: number,
    ): void {
        this.db.logUsage(toolName, inputTokens, outputTokens, savedTokens);
    }

    /** Get aggregated usage statistics. */
    getUsageStats(since?: string) {
        return this.db.getUsageStats(since);
    }

    // ─── Cleanup ──────────────────────────────────────────────────

    /** Debounced save — coalesces rapid-fire events (e.g., folder deletion). */
    private scheduleSave(): void {
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => {
            this.saveTimeout = null;
            this.db.save();
        }, 1_000);
    }

    /** Shutdown engine: stop watcher and close database. */
    shutdown(): void {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        this.stopWatcher();
        this.db.close();
    }
}
