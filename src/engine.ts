/**
 * engine.ts — Core search engine for TokenGuard.
 *
 * Orchestrates the full indexing and retrieval pipeline:
 * 1. File watching via chokidar (real-time re-indexing)
 * 2. AST parsing via Tree-sitter WASM (semantic chunking)
 * 3. Local embeddings via Xenova/transformers (512-dim vectors)
 * 4. Hybrid RRF search: pure-JS VectorIndex (brute-force dot product)
 *    + KeywordIndex (BM25 with Porter stemmer) — no native extensions
 * 5. Merkle-style file diffing (skip unchanged files)
 *
 * All processing is local. Zero cloud dependencies.
 */

import fs from "fs";
import path from "path";
import chokidar, { type FSWatcher } from "chokidar";
import picomatch from "picomatch";

import { TokenGuardDB, type HybridSearchResult } from "./database.js";
import { Embedder, getEmbedder } from "./embedder.js";
import { ASTParser, type ParseResult } from "./parser.js";
import { Compressor, type CompressionResult } from "./compressor.js";
import { AdvancedCompressor, type CompressionLevel, type AdvancedCompressionResult } from "./compressor-advanced.js";
import { safePath } from "./utils/path-jail.js";
import { shouldProcess } from "./utils/file-filter.js";
import { readSource } from "./utils/read-source.js";
import { getOrGenerateRepoMap, type RepoMap, type DependencyGraph } from "./repo-map.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface SearchResult {
    /** File path containing the match. */
    path: string;
    /** Compressed shorthand signature. */
    shorthand: string;
    /** Full raw source code of the chunk. */
    rawCode: string;
    /** AST node type. */
    nodeType: string;
    /** Start line in the source file. */
    startLine: number;
    /** End line in the source file. */
    endLine: number;
    /** Hybrid RRF score (higher = more relevant). */
    score: number;
}

export interface IndexStats {
    /** Total files indexed. */
    filesIndexed: number;
    /** Total AST chunks stored. */
    totalChunks: number;
    /** Total raw code characters indexed. */
    totalRawChars: number;
    /** Total shorthand characters. */
    totalShorthandChars: number;
    /** Overall compression ratio. */
    compressionRatio: number;
    /** Files currently being watched. */
    watchedPaths: string[];
}

export interface EngineConfig {
    /** Path to the SQLite database. Default: .tokenguard.db */
    dbPath?: string;
    /** Directories to watch for changes. Default: ['./src'] */
    watchPaths?: string[];
    /** File extensions to index. Default: ['.ts', '.js', '.py', '.go', ...] */
    extensions?: string[];
    /** Glob patterns to ignore. Default: ['node_modules', 'dist', ...] */
    ignorePaths?: string[];
    /** Path to WASM grammar files. */
    wasmDir?: string;
    /** Enable semantic embeddings (Pro mode). Default: false (Lite mode). */
    enableEmbeddings?: boolean;
}

// ─── Default config ──────────────────────────────────────────────────

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py", ".go"];

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
];

// ─── Engine ──────────────────────────────────────────────────────────

export interface SessionReport {
    /** Session duration in minutes. */
    durationMinutes: number;
    /** Total tokens saved across all compressions. */
    totalTokensSaved: number;
    /** Total original tokens processed. */
    totalOriginalTokens: number;
    /** Overall compression ratio. */
    overallRatio: number;
    /** USD saved at Sonnet pricing ($3/M input). */
    savedUsdSonnet: number;
    /** USD saved at Opus pricing ($15/M input). */
    savedUsdOpus: number;
    /** Per-file-type breakdown. */
    byFileType: Array<{
        ext: string;
        count: number;
        tokensSaved: number;
        originalTokens: number;
        ratio: number;
    }>;
    /** Number of auto-context injections in this session */
    autoContextInjections: number;
}

export class TokenGuardEngine {
    private db: TokenGuardDB;
    private embedder: Embedder;
    private parser: ASTParser;
    private compressor: Compressor;
    private advancedCompressor: AdvancedCompressor;
    private watcher: FSWatcher | null = null;
    private config: Required<EngineConfig>;
    private indexingQueue = new Set<string>();
    private isIndexing = false;
    private initialized = false;
    private embedderReady = false;

    /** Files that have been read (raw or compressed) in this session. */
    private safelyReadFiles = new Set<string>();

    /** Session-level savings tracker. */
    private sessionSavings = {
        totalTokensSaved: 0,
        totalOriginalTokens: 0,
        compressionsByType: new Map<string, { count: number; saved: number; original: number }>(),
        startTime: Date.now(),
        autoContextInjections: 0,
    };

    constructor(config: EngineConfig = {}) {
        this.config = {
            dbPath: config.dbPath ?? ".tokenguard.db",
            watchPaths: config.watchPaths ?? ["./src"],
            extensions: config.extensions ?? DEFAULT_EXTENSIONS,
            ignorePaths: config.ignorePaths ?? DEFAULT_IGNORE,
            wasmDir: config.wasmDir ?? "",
            enableEmbeddings: config.enableEmbeddings ?? false,
        };

        this.db = new TokenGuardDB(this.config.dbPath);
        this.embedder = getEmbedder();
        this.parser = new ASTParser(
            this.config.wasmDir || undefined
        );
        this.compressor = new Compressor(this.parser, this.embedder);
        this.advancedCompressor = new AdvancedCompressor(this.parser, this.embedder);
    }

    // ─── Initialization ────────────────────────────────────────────

    /**
     * Fast initialization: SQLite + Tree-sitter only.
     * Completes in ~100ms. Does NOT load the ONNX embedding model.
     * Safe to call from any tool — most tools don't need embeddings.
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        await this.db.initialize();
        await this.parser.initialize();

        this.initialized = true;
    }

    /**
     * Full initialization: fast init + ONNX embedding model.
     * Only needed for search, indexing, and repo map generation.
     * The embedding model load can take 5-10s on first call (model download + WASM init).
     */
    async initializeEmbedder(): Promise<void> {
        await this.initialize();
        if (this.embedderReady) return;

        await this.embedder.initialize();

        // Guard: if embedding model changed, clear stale vectors
        this.db.checkEmbeddingDimension(this.embedder.getDimension());

        this.embedderReady = true;
    }

    // ─── File Indexing ─────────────────────────────────────────────

    /**
     * Index a single file: parse AST → generate embeddings → store chunks.
     * Skips files whose SHA-256 hash hasn't changed (Merkle diffing).
     *
     * In Lite mode, stores chunks without embeddings (keyword search only).
     * In Pro mode, generates embeddings for hybrid search.
     */
    async indexFile(filePath: string): Promise<ParseResult | null> {
        if (this.config.enableEmbeddings) {
            await this.initializeEmbedder();
        } else {
            await this.initialize();
        }

        // FIX 7: Check file size and extension before processing
        let stat: fs.Stats;
        try {
            stat = fs.statSync(filePath);
        } catch {
            return null;
        }

        const filterResult = shouldProcess(filePath, stat.size);
        if (!filterResult.process) {
            return null;
        }

        // Read file content (BOM-safe for tree-sitter)
        let content: string;
        try {
            content = readSource(filePath);
        } catch {
            return null; // File may have been deleted
        }

        // Check extension support — unsupported files get plaintext fallback
        const ext = path.extname(filePath).toLowerCase();
        if (!this.parser.isSupported(ext)) {
            // Plaintext fallback: index entire file as one chunk for BM25 keyword search.
            // No AST features (no validation, no structural compression, no semantic edit)
            // but search WILL find content in this file.
            if (!this.db.fileNeedsUpdate(filePath, content)) return null;

            const lineCount = content.split("\n").length;
            // Use content as shorthand so BM25 keyword index can search it
            const shorthand = `[file] ${path.basename(filePath)} (${lineCount} lines)\n${content}`;

            this.db.clearChunks(filePath);

            if (this.config.enableEmbeddings) {
                await this.initializeEmbedder();
                const { embedding } = await this.embedder.embed(content.slice(0, 1000));
                this.db.insertChunk(filePath, shorthand, content, "file", 1, lineCount, embedding);
            } else {
                this.db.insertChunk(filePath, shorthand, content, "file", 1, lineCount, new Float32Array(0));
            }

            const hash = this.db.hashContent(content);
            this.db.upsertFile(filePath, hash);

            return {
                filePath,
                chunks: [{ shorthand, rawCode: content, nodeType: "file", startLine: 1, endLine: lineCount, startIndex: 0, endIndex: content.length, symbolName: "" }],
                totalLines: lineCount,
                language: ext.slice(1),
            };
        }

        // Merkle diffing: skip unchanged files
        if (!this.db.fileNeedsUpdate(filePath, content)) return null;

        // Parse AST
        const result = await this.parser.parse(filePath, content);
        if (result.chunks.length === 0) return result;

        // Clear old chunks for this file
        this.db.clearChunks(filePath);

        // Generate embeddings (or null placeholder) and store in batch
        const chunkData: Array<{
            path: string;
            shorthand: string;
            rawCode: string;
            nodeType: string;
            startLine: number;
            endLine: number;
            embedding: Float32Array;
            startIndex: number;
            endIndex: number;
            symbolName: string;
        }> = [];

        for (const chunk of result.chunks) {
            let embedding: Float32Array;
            if (this.config.enableEmbeddings) {
                ({ embedding } = await this.embedder.embed(chunk.shorthand));
            } else {
                // Lite mode: empty embedding placeholder
                embedding = new Float32Array(0);
            }
            chunkData.push({
                path: filePath,
                shorthand: chunk.shorthand,
                rawCode: chunk.rawCode,
                nodeType: chunk.nodeType,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                embedding,
                startIndex: chunk.startIndex,
                endIndex: chunk.endIndex,
                symbolName: chunk.symbolName,
            });
        }

        // Batch insert with transaction
        this.db.insertChunksBatch(chunkData);

        // Update file hash
        const hash = this.db.hashContent(content);
        this.db.upsertFile(filePath, hash);

        return result;
    }

    /**
     * Index an entire directory recursively.
     * Walks all supported files and indexes them in sequence.
     */
    async indexDirectory(dirPath: string): Promise<{
        indexed: number;
        skipped: number;
        errors: number;
    }> {
        if (this.config.enableEmbeddings) {
            await this.initializeEmbedder();
        } else {
            await this.initialize();
        }

        let indexed = 0;
        let skipped = 0;
        let errors = 0;

        const files = this.walkDirectory(dirPath);
        let processedCount = 0;

        for (const file of files) {
            try {
                const result = await this.indexFile(file);
                if (result && result.chunks.length > 0) {
                    indexed++;
                } else {
                    skipped++;
                }
            } catch (err) {
                console.error(
                    `[TokenGuard] Error indexing ${file}: ${(err as Error).message}`
                );
                errors++;
            }

            // FIX 3: Yield event loop every 100 files to avoid blocking
            processedCount++;
            if (processedCount % 100 === 0) {
                await new Promise<void>(resolve => setImmediate(resolve));
            }
        }

        // Persist to disk after batch indexing
        this.db.save();

        return { indexed, skipped, errors };
    }

    /** Recursively walk a directory and return all supported files. */
    private walkDirectory(dirPath: string): string[] {
        const files: string[] = [];
        const isIgnored = picomatch(this.config.ignorePaths);

        const walk = (dir: string) => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relativePath = path.relative(dirPath, fullPath).replace(/\\/g, "/");

                if (entry.isDirectory()) {
                    // Check directory name and relative path against glob patterns
                    if (!isIgnored(entry.name) && !isIgnored(relativePath) && !isIgnored(relativePath + "/")) {
                        walk(fullPath);
                    }
                    continue;
                }

                // Check file against ignore patterns, then check extension
                if (isIgnored(relativePath) || isIgnored(entry.name)) continue;
                const ext = path.extname(entry.name).toLowerCase();
                if (this.config.extensions.includes(ext)) {
                    files.push(fullPath);
                }
            }
        };

        walk(dirPath);
        return files;
    }

    // ─── Search ────────────────────────────────────────────────────

    /**
     * Hybrid semantic + keyword search using RRF fusion.
     *
     * This is the main search API — replaces grep/glob with a query
     * that understands code semantics. Returns ranked results with
     * shorthand signatures and full source code.
     *
     * In Lite mode (enableEmbeddings=false), uses BM25 keyword-only search.
     * In Pro mode (enableEmbeddings=true), uses hybrid semantic + BM25 with RRF fusion.
     */
    async search(query: string, limit: number = 10): Promise<SearchResult[]> {
        if (!this.config.enableEmbeddings) {
            // Lite mode: BM25 keyword-only search
            await this.initialize();
            const results = this.db.searchKeywordOnly(query, limit);
            return results.map((r: HybridSearchResult) => ({
                path: r.path,
                shorthand: r.shorthand,
                rawCode: r.raw_code,
                nodeType: r.node_type,
                startLine: r.start_line,
                endLine: r.end_line,
                score: r.rrf_score,
            }));
        }

        // Pro mode: hybrid semantic + BM25
        await this.initializeEmbedder();
        const { embedding } = await this.embedder.embed(query);
        const results = this.db.searchHybrid(embedding, query, limit);

        return results.map((r: HybridSearchResult) => ({
            path: r.path,
            shorthand: r.shorthand,
            rawCode: r.raw_code,
            nodeType: r.node_type,
            startLine: r.start_line,
            endLine: r.end_line,
            score: r.rrf_score,
        }));
    }

    // ─── Compression ──────────────────────────────────────────────

    /** Compress a file for token-efficient reading. */
    async compressFile(
        filePath: string,
        tier: 1 | 2 | 3 = 1,
        focusQuery?: string
    ): Promise<CompressionResult> {
        await this.initialize();

        // FIX 7: Check file size/extension
        const stat = fs.statSync(filePath);
        const filterResult = shouldProcess(filePath, stat.size);
        if (!filterResult.process) {
            throw new Error(`File skipped: ${filterResult.reason}`);
        }

        const content = readSource(filePath);
        return this.compressor.compress(filePath, content, {
            tier,
            focusQuery,
        });
    }

    // ─── Advanced Compression ───────────────────────────────────

    /** Compress a file using the advanced LLMLingua-2-inspired pipeline. */
    async compressFileAdvanced(
        filePath: string,
        level: CompressionLevel = "medium",
        preloadedContent?: string,
    ): Promise<AdvancedCompressionResult> {
        await this.initialize();

        // Validate size ALWAYS — even with preloaded content (prevents bypass)
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
        this.sessionSavings.totalTokensSaved += result.tokensSaved;
        this.sessionSavings.totalOriginalTokens += Embedder.estimateTokens(content);

        const entry = this.sessionSavings.compressionsByType.get(ext) ?? { count: 0, saved: 0, original: 0 };
        entry.count++;
        entry.saved += result.tokensSaved;
        entry.original += Embedder.estimateTokens(content);
        this.sessionSavings.compressionsByType.set(ext, entry);

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

    /** Increment the auto-context injection counter */
    incrementAutoContext(): void {
        this.sessionSavings.autoContextInjections++;
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
        const durationMs = Date.now() - this.sessionSavings.startTime;
        const durationMinutes = Math.max(1, durationMs / 60_000);
        const totalSaved = this.sessionSavings.totalTokensSaved;
        const totalOriginal = this.sessionSavings.totalOriginalTokens;

        const byFileType: SessionReport["byFileType"] = [];
        for (const [ext, data] of this.sessionSavings.compressionsByType) {
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
            autoContextInjections: this.sessionSavings.autoContextInjections,
        };
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

    /** Generate or return cached static repo map for prompt cache optimization. */
    async getRepoMap(forceRefresh: boolean = false): Promise<{ map: RepoMap; text: string; fromCache: boolean }> {
        // Repo map only needs parser (tree-sitter), not embedder
        await this.initialize();
        const root = this.config.watchPaths[0] || process.cwd();
        return getOrGenerateRepoMap(root, this.parser, forceRefresh);
    }

    private cachedGraph: DependencyGraph | null = null;

    /** Get the dependency graph (computed from repo map, cached). */
    async getDependencyGraph(): Promise<DependencyGraph> {
        if (this.cachedGraph) return this.cachedGraph;

        const { map } = await this.getRepoMap();
        if (map.graph) {
            this.cachedGraph = map.graph;
            return map.graph;
        }

        // Fallback: empty graph if map has no graph data
        const emptyGraph: DependencyGraph = {
            importedBy: new Map(),
            inDegree: new Map(),
            tiers: new Map(),
        };
        return emptyGraph;
    }

    /**
     * Find ALL files whose code contains the given symbol name.
     * Exhaustive scan — no limit, no ranking. For refactoring, not discovery.
     */
    async searchFilesBySymbol(symbolName: string): Promise<string[]> {
        await this.initialize();
        return this.db.searchRawCode(symbolName);
    }

    /** Find all files that import the given file path (relative). */
    async findDependents(filePath: string): Promise<string[]> {
        const graph = await this.getDependencyGraph();
        const normalized = filePath.replace(/\\/g, "/");
        const deps = graph.importedBy.get(normalized);
        return deps ? [...deps] : [];
    }

    // ─── File Watching ────────────────────────────────────────────

    /**
     * Start watching configured paths for file changes.
     * Automatically re-indexes files when they are added or modified.
     */
    startWatcher(): void {
        if (this.watcher) return;

        const globPatterns = this.config.watchPaths.map((p) => {
            const exts = this.config.extensions.map((e) => e.slice(1)).join(",");
            return `${p}/**/*.{${exts}}`;
        });

        this.watcher = chokidar.watch(globPatterns, {
            ignored: this.config.ignorePaths,
            persistent: true,
            ignoreInitial: false,
        });

        this.watcher
            .on("add", (fp: string) => this.queueIndexing(fp))
            .on("change", (fp: string) => this.queueIndexing(fp))
            .on("unlink", (fp: string) => {
                this.db.clearChunks(fp);
                this.db.save();
            });
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

        try {
            while (this.indexingQueue.size > 0) {
                const [filePath] = this.indexingQueue;
                this.indexingQueue.delete(filePath);

                try {
                    const res = await this.indexFile(filePath);
                    if (res) madeChanges = true;
                } catch (err) {
                    console.error(
                        `[TokenGuard] Queue error for ${filePath}: ${(err as Error).message}`
                    );
                }
            }
        } finally {
            if (madeChanges) {
                this.db.save(); // Persist SQLite to disk after watcher changes
            }
            this.isIndexing = false; // Always reset to prevent deadlocks
        }
    }

    /** Stop the file watcher. */
    stopWatcher(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
    }

    // ─── Statistics ────────────────────────────────────────────────

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

    // ─── Token Tracking ───────────────────────────────────────────

    /** Log token usage for a tool invocation. */
    logUsage(
        toolName: string,
        inputTokens: number,
        outputTokens: number,
        savedTokens: number
    ): void {
        this.db.logUsage(toolName, inputTokens, outputTokens, savedTokens);
    }

    /** Get aggregated usage statistics. */
    getUsageStats(since?: string) {
        return this.db.getUsageStats(since);
    }

    // ─── Cleanup ──────────────────────────────────────────────────

    /** Shutdown engine: stop watcher and close database. */
    shutdown(): void {
        this.stopWatcher();
        this.db.close();
    }
}
