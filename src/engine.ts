/**
 * engine.ts — Core search engine for TokenGuard.
 *
 * Orchestrates the full indexing and retrieval pipeline:
 * 1. File watching via chokidar (real-time re-indexing)
 * 2. AST parsing via Tree-sitter WASM (semantic chunking)
 * 3. Local embeddings via Xenova/transformers (512-dim vectors)
 * 4. Hybrid RRF search via SQLite + sqlite-vec + FTS5
 * 5. Merkle-style file diffing (skip unchanged files)
 *
 * All processing is local. Zero cloud dependencies.
 */

import fs from "fs";
import path from "path";
import chokidar, { type FSWatcher } from "chokidar";

import { TokenGuardDB, type HybridSearchResult } from "./database.js";
import { Embedder, getEmbedder } from "./embedder.js";
import { ASTParser, type ParseResult } from "./parser.js";
import { Compressor, type CompressionResult } from "./compressor.js";
import { AdvancedCompressor, type CompressionLevel, type AdvancedCompressionResult } from "./compressor-advanced.js";
import { safePath } from "./utils/path-jail.js";
import { shouldProcess } from "./utils/file-filter.js";
import { readSource } from "./utils/read-source.js";
import { getOrGenerateRepoMap, type RepoMap } from "./repo-map.js";

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

    /** Session-level savings tracker. */
    private sessionSavings = {
        totalTokensSaved: 0,
        totalOriginalTokens: 0,
        compressionsByType: new Map<string, { count: number; saved: number; original: number }>(),
        startTime: Date.now(),
    };

    constructor(config: EngineConfig = {}) {
        this.config = {
            dbPath: config.dbPath ?? ".tokenguard.db",
            watchPaths: config.watchPaths ?? ["./src"],
            extensions: config.extensions ?? DEFAULT_EXTENSIONS,
            ignorePaths: config.ignorePaths ?? DEFAULT_IGNORE,
            wasmDir: config.wasmDir ?? "",
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
     * Initialize all subsystems: SQLite WASM + Tree-sitter WASM + embedding model.
     * Call this once before using search or indexing.
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        await this.db.initialize();
        await this.parser.initialize();
        await this.embedder.initialize();

        // Guard: if embedding model changed, clear stale vectors
        this.db.checkEmbeddingDimension(this.embedder.getDimension());

        this.initialized = true;
    }

    // ─── File Indexing ─────────────────────────────────────────────

    /**
     * Index a single file: parse AST → generate embeddings → store chunks.
     * Skips files whose SHA-256 hash hasn't changed (Merkle diffing).
     */
    async indexFile(filePath: string): Promise<ParseResult | null> {
        await this.initialize();

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

        // Check extension support
        const ext = path.extname(filePath).toLowerCase();
        if (!this.parser.isSupported(ext)) return null;

        // Merkle diffing: skip unchanged files
        if (!this.db.fileNeedsUpdate(filePath, content)) return null;

        // Parse AST
        const result = await this.parser.parse(filePath, content);
        if (result.chunks.length === 0) return result;

        // Clear old chunks for this file
        this.db.clearChunks(filePath);

        // Generate embeddings and store in batch
        const chunkData: Array<{
            path: string;
            shorthand: string;
            rawCode: string;
            nodeType: string;
            startLine: number;
            endLine: number;
            embedding: Float32Array;
        }> = [];

        for (const chunk of result.chunks) {
            const { embedding } = await this.embedder.embed(chunk.shorthand);
            chunkData.push({
                path: filePath,
                shorthand: chunk.shorthand,
                rawCode: chunk.rawCode,
                nodeType: chunk.nodeType,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                embedding,
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
        await this.initialize();

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

        const walk = (dir: string) => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                // Skip ignored directories
                if (entry.isDirectory()) {
                    const shouldIgnore = this.config.ignorePaths.some((pattern) => {
                        const simpleName = pattern.replace(/\*\*/g, "").replace(/\//g, "");
                        return entry.name === simpleName;
                    });

                    if (!shouldIgnore) {
                        walk(fullPath);
                    }
                    continue;
                }

                // Check extension
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
     */
    async search(query: string, limit: number = 10): Promise<SearchResult[]> {
        await this.initialize();

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
    ): Promise<AdvancedCompressionResult> {
        await this.initialize();

        // FIX 7: Check file size/extension
        const stat = fs.statSync(filePath);
        const filterResult = shouldProcess(filePath, stat.size);
        if (!filterResult.process) {
            throw new Error(`File skipped: ${filterResult.reason}`);
        }

        const content = readSource(filePath);
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

    // ─── Repo Map ──────────────────────────────────────────────────

    /** Generate or return cached static repo map for prompt cache optimization. */
    async getRepoMap(forceRefresh: boolean = false): Promise<{ map: RepoMap; text: string; fromCache: boolean }> {
        await this.initialize();
        const root = this.config.watchPaths[0] || process.cwd();
        return getOrGenerateRepoMap(root, this.parser, forceRefresh);
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
            .on("unlink", (fp: string) => this.db.clearChunks(fp));
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

        while (this.indexingQueue.size > 0) {
            const [filePath] = this.indexingQueue;
            this.indexingQueue.delete(filePath);

            try {
                await this.indexFile(filePath);
            } catch (err) {
                console.error(
                    `[TokenGuard] Queue error for ${filePath}: ${(err as Error).message}`
                );
            }
        }

        this.isIndexing = false;
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
