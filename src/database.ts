/**
 * database.ts - SQLite persistence layer for NREKI.
 *
 * Uses sql.js (SQLite compiled to WASM) for zero-native-dependency
 * operation. Vector search AND keyword search are both implemented
 * in pure JavaScript:
 *
 * - VectorIndex: brute-force cosine similarity on Float32Array
 * - KeywordIndex: inverted index with Porter-inspired BM25 scoring
 *
 * This eliminates the need for FTS5, sqlite-vec, better-sqlite3,
 * node-gyp, and Visual Studio Build Tools - making NREKI
 * portable to any platform without native compilation.
 */

import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { logger } from "./utils/logger.js";
import { escapeRegExp } from "./utils/imports.js";

// ─── Motores de Búsqueda (Segregación de Dominio) ───
import { VectorIndex, fastSimilarity } from "./search/vector-index.js";
import { KeywordIndex } from "./search/keyword-index.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface FileRecord {
    path: string;
    hash: string;
}

export interface ChunkRecord {
    id: number;
    path: string;
    shorthand: string;
    raw_code: string;
    node_type: string;
    start_line: number;
    end_line: number;
    start_index: number;
    end_index: number;
    symbol_name: string;
}

/**
 * Shape returned by fastGrep(): the 4 columns handleFastGrep consumes.
 * Avoids sql.js WASM overhead of serializing unused columns per row.
 */
export interface FastGrepHit {
    path: string;
    raw_code: string;
    start_line: number;
    symbol_name: string;
}

export interface HybridSearchResult {
    id: number;
    path: string;
    shorthand: string;
    raw_code: string;
    node_type: string;
    start_line: number;
    end_line: number;
    start_index: number;
    end_index: number;
    symbol_name: string;
    rrf_score: number;
}

export interface TokenStats {
    total_chunks: number;
    total_files: number;
    total_raw_tokens: number;
    total_shorthand_tokens: number;
    compression_ratio: number;
}


// ─── Database Manager ────────────────────────────────────────────────

export class NrekiDB {
    private db!: SqlJsDatabase;
    private vecIndex = new VectorIndex();
    private kwIndex = new KeywordIndex();
    /** In-memory identifier index: file path → unique identifiers in that file's raw code. */
    private rawIdentsByFile = new Map<string, Set<string>>();
    private rawIdentsLoaded = false;
    private dbPath: string;
    private vecPath: string;
    private initPromise: Promise<void> | null = null;
    private _ready = false;

    constructor(dbPath: string = ".nreki.db") {
        this.dbPath = dbPath;
        this.vecPath = dbPath.replace(/\.db$/, ".vec");
    }

    /** Async initialization - must be called before any DB operation. */
    async initialize(): Promise<void> {
        if (this._ready) return;
        if (!this.initPromise) {
            this.initPromise = this._init();
        }
        await this.initPromise;
    }

    private async _init(): Promise<void> {
        const SQL = await initSqlJs();

        // Load existing database if it exists
        if (fs.existsSync(this.dbPath)) {
            try {
                const fileBuffer = fs.readFileSync(this.dbPath);
                this.db = new SQL.Database(fileBuffer);
            } catch (err) {
                logger.error(`[NREKI] Database corrupted at ${this.dbPath}. Wiping to recover: ${err}`);
                try { fs.unlinkSync(this.dbPath); if (fs.existsSync(this.vecPath)) fs.unlinkSync(this.vecPath); } catch {}
                this.db = new SQL.Database();
            }
        } else {
            this.db = new SQL.Database();
        }

        // Setup schema first (creates metadata table needed for dimension lookup)
        this.setupSchema();

        // ─── Schema Version Gate ──────────────────────────────────────
        // Force full reindex when parser/index format changes between
        // versions. Users on older schema get a clean slate without
        // manual .nreki.db deletion. Bumped in v10.18.1.
        const PARSER_SCHEMA_VERSION = 2;
        const storedSchema = parseInt(this.getMetadata("parser_schema_version") ?? "0", 10);
        if (storedSchema < PARSER_SCHEMA_VERSION) {
            if (storedSchema > 0) {
                logger.warn(
                    `[NREKI] Parser schema upgrade (v${storedSchema} -> v${PARSER_SCHEMA_VERSION}). ` +
                    `Forcing full AST reindex.`
                );
            }
            this.wipeAllIndexedData();
            this.setMetadata("parser_schema_version", String(PARSER_SCHEMA_VERSION));
        }

        // Load vector index using stored dimension (default 512)
        const storedDim = parseInt(this.getMetadata("embedding_dim") ?? "512", 10);
        if (fs.existsSync(this.vecPath)) {
            const vecBuffer = fs.readFileSync(this.vecPath);
            this.vecIndex = VectorIndex.deserialize(vecBuffer, storedDim);
        }

        // Rebuild in-memory indexes from existing data
        this.rebuildKeywordIndex();

        this._ready = true;
    }

    get ready(): boolean {
        return this._ready;
    }

    // ─── Schema ──────────────────────────────────────────────────

    private setupSchema(): void {
        this.db.run(`
      -- Indexed files with content hashes for Merkle-style diffing
      CREATE TABLE IF NOT EXISTS files (
        path      TEXT PRIMARY KEY,
        hash      TEXT NOT NULL,
        indexed_at TEXT DEFAULT (datetime('now'))
      );

      -- AST chunks extracted from source files
      CREATE TABLE IF NOT EXISTS chunks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        path        TEXT NOT NULL,
        shorthand   TEXT NOT NULL,
        raw_code    TEXT NOT NULL,
        node_type   TEXT NOT NULL DEFAULT 'unknown',
        start_line  INTEGER NOT NULL DEFAULT 0,
        end_line    INTEGER NOT NULL DEFAULT 0,
        start_index INTEGER NOT NULL DEFAULT 0,
        end_index   INTEGER NOT NULL DEFAULT 0,
        symbol_name TEXT NOT NULL DEFAULT ''
      );

      -- Token usage tracking
      CREATE TABLE IF NOT EXISTS usage_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp  TEXT DEFAULT (datetime('now')),
        tool_name  TEXT NOT NULL,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        saved_tokens  INTEGER NOT NULL DEFAULT 0
      );

      -- Indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      CREATE INDEX IF NOT EXISTS idx_chunks_symbol_name ON chunks(symbol_name);
      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_log(timestamp);

      -- Metadata key-value store (embedding dimension, model name, etc.)
      CREATE TABLE IF NOT EXISTS metadata (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Long-term symbol memories (Exocortex Engrams)
      CREATE TABLE IF NOT EXISTS engrams (
        path        TEXT NOT NULL,
        symbol_name TEXT NOT NULL,
        ast_hash    TEXT NOT NULL,
        insight     TEXT NOT NULL,
        created_at  TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (path, symbol_name)
      );
    `);

        // Migration: add columns for existing DBs that lack them
        const migrationColumns = [
            "ALTER TABLE chunks ADD COLUMN start_index INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE chunks ADD COLUMN end_index INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE chunks ADD COLUMN symbol_name TEXT NOT NULL DEFAULT ''",
        ];
        for (const sql of migrationColumns) {
            try { this.db.run(sql); } catch { /* column already exists */ }
        }
    }

    /** Rebuild the in-memory keyword index from all existing chunks. */
    private rebuildKeywordIndex(): void {
        // AUDIT FIX: Use prepared statement + iterator to avoid loading all rows into RAM
        const stmt = this.db.prepare("SELECT id, shorthand FROM chunks");
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject() as { id: number; shorthand: string };
                this.kwIndex.insert(row.id, row.shorthand);
            }
        } finally {
            stmt.free();
        }
    }

    /** Lazy-build the in-memory raw identifier index on first searchRawCode call. */
    private buildRawIdentsIfNeeded(): void {
        if (this.rawIdentsLoaded) return;
        this.rawIdentsByFile.clear();
        const stmt = this.db.prepare("SELECT path, raw_code FROM chunks");
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject() as { path: string; raw_code: string };
                let idents = this.rawIdentsByFile.get(row.path);
                if (!idents) { idents = new Set(); this.rawIdentsByFile.set(row.path, idents); }
                const matches = row.raw_code.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g);
                if (matches) for (const m of matches) idents.add(m);
            }
        } finally {
            stmt.free();
        }
        this.rawIdentsLoaded = true;
    }

    /** Extract identifiers from raw code and add to the per-file index. */
    private addRawIdents(filePath: string, rawCode: string): void {
        if (!this.rawIdentsLoaded && this._ready) return; // Skip if lazy cache not yet built
        let idents = this.rawIdentsByFile.get(filePath);
        if (!idents) { idents = new Set(); this.rawIdentsByFile.set(filePath, idents); }
        const matches = rawCode.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g);
        if (matches) for (const m of matches) idents.add(m);
    }

    // ─── Metadata ────────────────────────────────────────────────

    /** Read a metadata value by key, or null if not set. */
    getMetadata(key: string): string | null {
        const stmt = this.db.prepare("SELECT value FROM metadata WHERE key = ?");
        try {
            stmt.bind([key]);
            if (stmt.step()) {
                return (stmt.getAsObject() as { value: string }).value;
            }
            return null;
        } finally {
            stmt.free();
        }
    }

    /** Write a metadata key-value pair (upsert). */
    setMetadata(key: string, value: string): void {
        this.db.run(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
            [key, value]
        );
    }

    /**
     * Wipes all indexed data from RAM and disk.
     * Prevents ghost vectors and ID drift by cleaning up sequence counters
     * and orphaned .vec files. Used during cache invalidation.
     */
    private wipeAllIndexedData(): void {
        // 1. Purge disk artifacts to prevent ghost data on next boot
        if (fs.existsSync(this.vecPath)) {
            try {
                fs.unlinkSync(this.vecPath);
            } catch (err) {
                logger.warn(`[NREKI] Could not delete stale vector index ${this.vecPath}: ${err}`);
            }
        }

        // 2. Wipe SQL tables
        this.db.run("DELETE FROM chunks");
        this.db.run("DELETE FROM files");

        // 3. Reset AUTOINCREMENT sequences (ONLY for wiped tables)
        try {
            this.db.run("DELETE FROM sqlite_sequence WHERE name = 'chunks'");
        } catch {
            // Ignored: sqlite_sequence is created automatically by SQLite on first INSERT
        }

        // 4. Reset RAM state
        this.vecIndex = new VectorIndex();
        this.kwIndex = new KeywordIndex();
        this.rawIdentsByFile.clear();
        this.rawIdentsLoaded = false;
    }

    /**
     * Check if the active embedding dimension matches what was stored.
     * If they differ, wipe all indexed data and update the stored dimension.
     * Returns true if a re-index is needed.
     */
    checkEmbeddingDimension(activeDim: number): boolean {
        const storedDim = this.getMetadata("embedding_dim");

        if (storedDim && parseInt(storedDim, 10) !== activeDim) {
            logger.warn(`Embedding dimension changed (${storedDim} -> ${activeDim}). Clearing index.`);
            this.wipeAllIndexedData();
            this.setMetadata("embedding_dim", String(activeDim));
            return true;
        }

        if (!storedDim) {
            this.setMetadata("embedding_dim", String(activeDim));
        }

        return false;
    }

    // ─── Persistence ─────────────────────────────────────────────

    upsertEngram(filePath: string, symbolName: string, astHash: string, insight: string): void {
        this.db.run(
            "INSERT OR REPLACE INTO engrams (path, symbol_name, ast_hash, insight) VALUES (?, ?, ?, ?)",
            [filePath, symbolName, astHash, insight],
        );
        this.save();
    }

    getEngramsForFile(filePath: string): Map<string, { astHash: string; insight: string }> {
        const stmt = this.db.prepare("SELECT symbol_name, ast_hash, insight FROM engrams WHERE path = ?");
        const result = new Map<string, { astHash: string; insight: string }>();
        try {
            stmt.bind([filePath]);
            while (stmt.step()) {
                const row = stmt.getAsObject() as { symbol_name: string; ast_hash: string; insight: string };
                result.set(row.symbol_name, { astHash: row.ast_hash, insight: row.insight });
            }
        } finally {
            stmt.free();
        }
        return result;
    }

    deleteEngram(filePath: string, symbolName: string): void {
        this.db.run(
            "DELETE FROM engrams WHERE path = ? AND symbol_name = ?",
            [filePath, symbolName],
        );
        this.save();
    }

    /** Persist database and vector index to disk. */
    save(): void {
        if (!this.db) return;
        // Save SQLite database — atomic via temp+rename.
        // writeFileSync overwrites in-place and is NOT atomic.
        // OOM/crash mid-write truncates the file to 0 bytes.
        // rename() is atomic on POSIX (single inode pointer swap).
        const data = this.db.export();
        const buffer = Buffer.from(data);
        const dir = path.dirname(this.dbPath);
        if (dir && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        // Random suffix prevents collision between concurrent
        // MCP processes (Cursor + Claude Code terminal) writing the same DB.
        const tmpDb = `${this.dbPath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
        fs.writeFileSync(tmpDb, buffer);
        fs.renameSync(tmpDb, this.dbPath);

        // Save vector index (skip if unchanged since last persist)
        if (this.vecIndex.dirty) {
            const vecData = this.vecIndex.serialize();
            // Random suffix prevents cross-process collision.
            const tmpVec = `${this.vecPath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
            fs.writeFileSync(tmpVec, vecData);
            fs.renameSync(tmpVec, this.vecPath);
        }
    }

    // ─── File Operations ─────────────────────────────────────────

    fileNeedsUpdate(filePath: string, content: string): boolean {
        const newHash = crypto.createHash("sha256").update(content).digest("hex");
        const stmt = this.db.prepare("SELECT hash FROM files WHERE path = ?");
        try {
            stmt.bind([filePath]);
            if (stmt.step()) {
                const row = stmt.getAsObject() as { hash: string };
                return row.hash !== newHash;
            }
            return true;
        } finally {
            stmt.free();
        }
    }

    hashContent(content: string): string {
        return crypto.createHash("sha256").update(content).digest("hex");
    }

    upsertFile(filePath: string, hash: string): void {
        this.db.run(
            "INSERT OR REPLACE INTO files (path, hash, indexed_at) VALUES (?, ?, datetime('now'))",
            [filePath, hash]
        );
    }

    clearChunks(filePath: string): void {
        const stmt = this.db.prepare("SELECT id FROM chunks WHERE path = ?");
        const ids: number[] = [];
        try {
            stmt.bind([filePath]);
            while (stmt.step()) {
                const row = stmt.getAsObject() as { id: number };
                ids.push(row.id);
            }
        } finally {
            stmt.free();
        }

        if (ids.length > 0) {
            this.vecIndex.deleteBulk(ids);
            this.kwIndex.deleteBulk(ids);
            if (this.rawIdentsLoaded) this.rawIdentsByFile.delete(filePath);
            this.db.run("DELETE FROM chunks WHERE path = ?", [filePath]);
        }
        // PATCH-6: Also remove from files table so fileNeedsUpdate() doesn't
        // skip re-indexing when the file is recreated with the same content.
        this.db.run("DELETE FROM files WHERE path = ?", [filePath]);
    }

    // ─── Chunk Operations ────────────────────────────────────────

    insertChunk(
        filePath: string,
        shorthand: string,
        rawCode: string,
        nodeType: string,
        startLine: number,
        endLine: number,
        embedding: Float32Array,
        startIndex: number = 0,
        endIndex: number = 0,
        symbolName: string = "",
    ): number {
        this.db.run(
            `INSERT INTO chunks (path, shorthand, raw_code, node_type, start_line, end_line, start_index, end_index, symbol_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [filePath, shorthand, rawCode, nodeType, startLine, endLine, startIndex, endIndex, symbolName]
        );

        const rowid = (this.db.exec("SELECT last_insert_rowid() AS id")[0]
            .values[0][0] as number);

        // A-04: Only insert non-empty vectors (Lite mode uses Float32Array(0))
        if (embedding.length > 0) {
            this.vecIndex.insert(rowid, embedding);
        }
        this.kwIndex.insert(rowid, shorthand);
        this.addRawIdents(filePath, rawCode);
        return rowid;
    }

    insertChunksBatch(
        chunks: Array<{
            path: string;
            shorthand: string;
            rawCode: string;
            nodeType: string;
            startLine: number;
            endLine: number;
            embedding: Float32Array;
            startIndex?: number;
            endIndex?: number;
            symbolName?: string;
        }>
    ): void {
        this.db.run("BEGIN TRANSACTION");
        // Track inserted IDs so we can purge RAM indexes on rollback.
        // Without this, SQLite rows are reverted but vecIndex/kwIndex
        // retain phantom entries that crash the result hydrator.
        const insertedIds: number[] = [];
        try {
            for (const chunk of chunks) {
                const id = this.insertChunk(
                    chunk.path,
                    chunk.shorthand,
                    chunk.rawCode,
                    chunk.nodeType,
                    chunk.startLine,
                    chunk.endLine,
                    chunk.embedding,
                    chunk.startIndex ?? 0,
                    chunk.endIndex ?? 0,
                    chunk.symbolName ?? "",
                );
                insertedIds.push(id);
            }
            this.db.run("COMMIT");
        } catch (err) {
            this.db.run("ROLLBACK");
            // Purge phantom entries from in-memory indexes
            this.vecIndex.deleteBulk(insertedIds);
            this.kwIndex.deleteBulk(insertedIds);
            throw err;
        }
    }

    // ─── Path Boosting ────────────────────────────────────────────

    /** Apply path-based weighting: boost src/, penalize tests/node_modules/. */
    private getPathBoost(filePath: string): number {
        const normalized = filePath.replace(/\\/g, "/").toLowerCase();
        if (normalized.includes("/node_modules/")) return 0.3;
        if (normalized.includes("/dist/") || normalized.includes("/build/")) return 0.5;
        if (normalized.includes("/test") || normalized.includes("/__test")) return 0.7;
        if (normalized.includes("/src/")) return 1.2;
        if (normalized.includes("/lib/") || normalized.includes("/core/")) return 1.1;
        return 1.0;
    }

    // ─── Batch Helpers ─────────────────────────────────────────────

    /**
     * Batch-fetch paths for an array of chunk IDs. Single SQL query.
     * Used by RRF fusion to apply path boosting without N+1 queries.
     */
    private fetchPathsBatch(ids: number[]): Map<number, string> {
        const result = new Map<number, string>();
        if (ids.length === 0) return result;
        const placeholders = ids.map(() => "?").join(",");
        const stmt = this.db.prepare(
            `SELECT id, path FROM chunks WHERE id IN (${placeholders})`,
        );
        try {
            stmt.bind(ids);
            while (stmt.step()) {
                const row = stmt.getAsObject() as { id: number; path: string };
                result.set(row.id, row.path);
            }
        } finally {
            stmt.free();
        }
        return result;
    }

    /**
     * Batch-fetch full chunk data for an array of chunk IDs. Single SQL query.
     * Used by all search methods to hydrate final results without N+1 queries.
     */
    private fetchChunksBatch(ids: number[]): Map<number, ChunkRecord> {
        const result = new Map<number, ChunkRecord>();
        if (ids.length === 0) return result;
        const placeholders = ids.map(() => "?").join(",");
        const stmt = this.db.prepare(
            `SELECT id, path, shorthand, raw_code, node_type, start_line, end_line, start_index, end_index, symbol_name
             FROM chunks WHERE id IN (${placeholders})`,
        );
        try {
            stmt.bind(ids);
            while (stmt.step()) {
                const row = stmt.getAsObject() as Record<string, number | string>;
                result.set(row.id as number, {
                    id: row.id as number,
                    path: row.path as string,
                    shorthand: row.shorthand as string,
                    raw_code: row.raw_code as string,
                    node_type: row.node_type as string,
                    start_line: row.start_line as number,
                    end_line: row.end_line as number,
                    start_index: (row.start_index as number) ?? 0,
                    end_index: (row.end_index as number) ?? 0,
                    symbol_name: (row.symbol_name as string) ?? "",
                });
            }
        } finally {
            stmt.free();
        }
        return result;
    }

    // ─── Search Operations ───────────────────────────────────────

    /**
     * Hybrid search using Reciprocal Rank Fusion (RRF).
     * Combines:
     *   - Vector similarity (semantic, cosine distance)
     *   - BM25 keyword matching (in pure JS inverted index)
     *
     * RRF formula: score = Σ 1/(k + rank_i) where k=10
     */
    searchHybrid(
        queryEmbedding: Float32Array,
        queryText: string,
        limit: number = 10
    ): HybridSearchResult[] {
        // 1. Vector search - top 60 by cosine similarity
        const vecResults = this.vecIndex.search(queryEmbedding, 60);
        const vecRanks = new Map<number, number>();
        vecResults.forEach((r, i) => vecRanks.set(r.rowid, i + 1));

        // 2. BM25 keyword search - top 60 by term relevance
        const kwResults = this.kwIndex.search(queryText, 60);
        const kwRanks = new Map<number, number>();
        kwResults.forEach((r, i) => kwRanks.set(r.rowid, i + 1));

        // 3. RRF fusion with path boosting (batch query)
        const allIds = new Set([...vecRanks.keys(), ...kwRanks.keys()]);
        const pathMap = this.fetchPathsBatch([...allIds]);
        const scored: Array<{ id: number; rrf: number }> = [];

        for (const id of allIds) {
            const vecRank = vecRanks.get(id);
            const kwRank = kwRanks.get(id);
            let rrf =
                (vecRank ? 1.0 / (10 + vecRank) : 0) +
                (kwRank ? 1.0 / (10 + kwRank) : 0);

            const filePath = pathMap.get(id);
            if (filePath) {
                rrf *= this.getPathBoost(filePath);
            }

            scored.push({ id, rrf });
        }

        scored.sort((a, b) => b.rrf - a.rrf);
        const topIds = scored.slice(0, limit);

        // 4. Fetch full chunk data (batch query)
        const chunkMap = this.fetchChunksBatch(topIds.map(t => t.id));
        const results: HybridSearchResult[] = [];
        for (const { id, rrf } of topIds) {
            const row = chunkMap.get(id);
            if (row) {
                results.push({
                    id: row.id, path: row.path, shorthand: row.shorthand,
                    raw_code: row.raw_code, node_type: row.node_type,
                    start_line: row.start_line, end_line: row.end_line,
                    start_index: row.start_index, end_index: row.end_index,
                    symbol_name: row.symbol_name,
                    rrf_score: rrf,
                });
            }
        }

        return results;
    }

    /**
     * Keyword-only search using BM25 (for Lite mode - no embeddings needed).
     * Uses the in-memory KeywordIndex with path boosting.
     */
    searchKeywordOnly(
        queryText: string,
        limit: number = 10,
    ): HybridSearchResult[] {
        const kwResults = this.kwIndex.search(queryText, limit * 2);
        if (kwResults.length === 0) return [];

        const chunkMap = this.fetchChunksBatch(kwResults.map(r => r.rowid));
        const results: HybridSearchResult[] = [];

        for (const { rowid, score } of kwResults) {
            const row = chunkMap.get(rowid);
            if (row) {
                const boostedScore = score * this.getPathBoost(row.path);
                results.push({
                    id: row.id, path: row.path, shorthand: row.shorthand,
                    raw_code: row.raw_code, node_type: row.node_type,
                    start_line: row.start_line, end_line: row.end_line,
                    start_index: row.start_index, end_index: row.end_index,
                    symbol_name: row.symbol_name,
                    rrf_score: boostedScore,
                });
            }
        }

        results.sort((a, b) => b.rrf_score - a.rrf_score);
        return results.slice(0, limit);
    }

    /**
     * BM25-powered fast resolution for import-anchored auto-context.
     * Searches "symbol pathHint" together to defeat homonyms.
     * Enforces a 150ms hard timeout to prevent event loop blocking.
     */
    resolveImportSignatures(
        deps: Array<{ symbol: string; pathHint: string }>,
        maxTimeMs: number = 150,
    ): Array<{ raw: string; path: string }> {
        if (!this._ready || deps.length === 0) return [];

        const start = performance.now();
        const results: Array<{ raw: string; path: string }> = [];
        const seenSymbols = new Set<string>();

        for (const dep of deps) {
            if (seenSymbols.has(dep.symbol)) continue;
            seenSymbols.add(dep.symbol);
            if (performance.now() - start > maxTimeMs) break;

            // BM25 with two terms: symbol + path hint defeats homonyms
            const cleanHint = dep.pathHint.replace(/['"%_]/g, " ").trim();
            const queryText = cleanHint
                ? `${dep.symbol} ${cleanHint}`
                : dep.symbol;

            const hits = this.searchKeywordOnly(queryText, 3);

            if (hits.length > 0) {
                // Final validation: symbol must appear textually in the shorthand
                // Uses safe boundaries (not \b) to handle $store etc.
                const safeSym = escapeRegExp(dep.symbol);
                const exactRegex = new RegExp(
                    `(^|[^a-zA-Z0-9_$])${safeSym}(?=[^a-zA-Z0-9_$]|$)`,
                );

                for (const hit of hits) {
                    if (exactRegex.test(hit.shorthand)) {
                        results.push({ raw: hit.shorthand, path: hit.path });
                        break;
                    }
                }
            }
        }

        return results;
    }

    searchVector(
        queryEmbedding: Float32Array,
        limit: number = 10
    ): HybridSearchResult[] {
        const vecResults = this.vecIndex.search(queryEmbedding, limit);
        if (vecResults.length === 0) return [];

        const chunkMap = this.fetchChunksBatch(vecResults.map(r => r.rowid));
        const results: HybridSearchResult[] = [];

        for (const { rowid, distance } of vecResults) {
            const row = chunkMap.get(rowid);
            if (row) {
                results.push({
                    id: row.id, path: row.path, shorthand: row.shorthand,
                    raw_code: row.raw_code, node_type: row.node_type,
                    start_line: row.start_line, end_line: row.end_line,
                    start_index: row.start_index, end_index: row.end_index,
                    symbol_name: row.symbol_name,
                    rrf_score: 1 - distance,
                });
            }
        }

        return results;
    }

    // ─── Usage Tracking ──────────────────────────────────────────

    logUsage(
        toolName: string,
        inputTokens: number,
        outputTokens: number,
        savedTokens: number
    ): void {
        this.db.run(
            `INSERT INTO usage_log (tool_name, input_tokens, output_tokens, saved_tokens)
       VALUES (?, ?, ?, ?)`,
            [toolName, inputTokens, outputTokens, savedTokens]
        );
    }

    getUsageStats(since?: string): {
        total_input: number;
        total_output: number;
        total_saved: number;
        tool_calls: number;
    } {
        const whereClause = since ? "WHERE timestamp >= ?" : "";
        const params = since ? [since] : [];

        const stmt = this.db.prepare(
            `SELECT
        COALESCE(SUM(input_tokens), 0)  AS total_input,
        COALESCE(SUM(output_tokens), 0) AS total_output,
        COALESCE(SUM(saved_tokens), 0)  AS total_saved,
        COUNT(*)                         AS tool_calls
      FROM usage_log ${whereClause}`
        );

        try {
            if (params.length > 0) stmt.bind(params);

            let result = { total_input: 0, total_output: 0, total_saved: 0, tool_calls: 0 };
            if (stmt.step()) {
                const row = stmt.getAsObject() as Record<string, number>;
                result = {
                    total_input: row.total_input ?? 0,
                    total_output: row.total_output ?? 0,
                    total_saved: row.total_saved ?? 0,
                    tool_calls: row.tool_calls ?? 0,
                };
            }
            return result;
        } finally {
            stmt.free();
        }
    }

    /**
     * Find the heaviest files by total raw code size.
     * Zero disk I/O - queries indexed data in SQLite.
     */
    getTopHeavyFiles(limit: number = 5): Array<{ path: string; estimated_tokens: number }> {
        if (!this._ready) return [];
        const stmt = this.db.prepare(`
            SELECT path, SUM(LENGTH(raw_code)) as total_chars
            FROM chunks
            GROUP BY path
            ORDER BY total_chars DESC
            LIMIT ?
        `);
        try {
            stmt.bind([limit]);

            const results: Array<{ path: string; estimated_tokens: number }> = [];
            while (stmt.step()) {
                const row = stmt.getAsObject() as { path: string; total_chars: number };
                results.push({
                    path: row.path,
                    estimated_tokens: Math.ceil(row.total_chars / 3.5),
                });
            }
            return results;
        } finally {
            stmt.free();
        }
    }

    // ─── Statistics ──────────────────────────────────────────────

    getStats(): TokenStats {
        const rows = this.db.exec(`
      SELECT
        COUNT(*)                     AS total_chunks,
        COUNT(DISTINCT path)         AS total_files,
        COALESCE(SUM(LENGTH(raw_code)), 0)   AS total_raw_tokens,
        COALESCE(SUM(LENGTH(shorthand)), 0)  AS total_shorthand_tokens
      FROM chunks
    `);

        if (rows.length === 0 || rows[0].values.length === 0) {
            return {
                total_chunks: 0,
                total_files: 0,
                total_raw_tokens: 0,
                total_shorthand_tokens: 0,
                compression_ratio: 0,
            };
        }

        const [total_chunks, total_files, total_raw_tokens, total_shorthand_tokens] =
            rows[0].values[0] as number[];

        return {
            total_chunks,
            total_files,
            total_raw_tokens,
            total_shorthand_tokens,
            compression_ratio:
                total_raw_tokens > 0
                    ? 1 - total_shorthand_tokens / total_raw_tokens
                    : 0,
        };
    }

    getFileCount(): number {
        const rows = this.db.exec("SELECT COUNT(*) AS count FROM files");
        if (rows.length === 0) return 0;
        return rows[0].values[0][0] as number;
    }

    getVectorCount(): number {
        return this.vecIndex.size;
    }

    /**
     * Find all files whose raw code contains the given symbol name.
     * Returns distinct file paths. Used by prepare_refactor for 100% coverage.
     *
     * Uses the in-memory rawIdentsByFile index (lazy-built on first call via
     * buildRawIdentsIfNeeded). Substring match on identifiers — same
     * semantics as the previous LIKE %term% scan but O(unique_idents) instead
     * of O(total_raw_code_bytes).
     */
    searchRawCode(symbolName: string): string[] {
        if (!this._ready) return [];
        this.buildRawIdentsIfNeeded();
        const results: string[] = [];
        for (const [filePath, idents] of this.rawIdentsByFile) {
            if (idents.has(symbolName)) { results.push(filePath); }
        }
        return results;
    }

    /**
     * Exact symbol definition lookup. Used by ast-navigator findDefinition fast path.
     * Replaces the O(N) full-disk walk. Requires idx_chunks_symbol_name.
     */
    getChunksBySymbolExact(symbolName: string, exact: boolean = true): ChunkRecord[] {
        if (!this._ready) return [];
        const sql = exact
            ? "SELECT id, path, shorthand, raw_code, node_type, start_line, end_line, start_index, end_index, symbol_name FROM chunks WHERE symbol_name = ?"
            : "SELECT id, path, shorthand, raw_code, node_type, start_line, end_line, start_index, end_index, symbol_name FROM chunks WHERE symbol_name = ? COLLATE NOCASE";
        const stmt = this.db.prepare(sql);
        const results: ChunkRecord[] = [];
        try {
            stmt.bind([symbolName]);
            while (stmt.step()) {
                const row = stmt.getAsObject() as Record<string, unknown>;
                results.push({
                    id: row.id as number,
                    path: row.path as string,
                    shorthand: row.shorthand as string,
                    raw_code: row.raw_code as string,
                    node_type: row.node_type as string,
                    start_line: row.start_line as number,
                    end_line: row.end_line as number,
                    start_index: (row.start_index as number) ?? 0,
                    end_index: (row.end_index as number) ?? 0,
                    symbol_name: (row.symbol_name as string) ?? "",
                });
            }
        } finally {
            stmt.free();
        }
        return results;
    }

    /**
     * Fast substring search over AST chunks raw code. Used by nreki_navigate fast_grep.
     * Returns chunks whose raw_code contains the query as substring. LIMIT-bounded.
     */
    searchRawCodeLike(queryText: string, limit: number = 50): ChunkRecord[] {
        if (!this._ready) return [];
        const stmt = this.db.prepare(
            "SELECT id, path, shorthand, raw_code, node_type, start_line, end_line, start_index, end_index, symbol_name FROM chunks WHERE raw_code LIKE ? LIMIT ?"
        );
        const results: ChunkRecord[] = [];
        try {
            stmt.bind(["%" + queryText + "%", limit]);
            while (stmt.step()) {
                const row = stmt.getAsObject() as Record<string, unknown>;
                results.push({
                    id: row.id as number,
                    path: row.path as string,
                    shorthand: row.shorthand as string,
                    raw_code: row.raw_code as string,
                    node_type: row.node_type as string,
                    start_line: row.start_line as number,
                    end_line: row.end_line as number,
                    start_index: (row.start_index as number) ?? 0,
                    end_index: (row.end_index as number) ?? 0,
                    symbol_name: (row.symbol_name as string) ?? "",
                });
            }
        } finally {
            stmt.free();
        }
        return results;
    }

    /**
     * Exact substring search for the nreki_navigate fast_grep action.
     * Uses SQLite INSTR (no wildcard interpretation — safe for arbitrary queries)
     * and SELECTs only the 4 columns handleFastGrep consumes to minimize
     * sql.js WASM row-serialization cost.
     */
    fastGrep(queryText: string, limit: number = 50): FastGrepHit[] {
        if (!this._ready) return [];
        const stmt = this.db.prepare(
            "SELECT path, raw_code, start_line, symbol_name FROM chunks WHERE INSTR(raw_code, ?) > 0 LIMIT ?"
        );
        const results: FastGrepHit[] = [];
        try {
            stmt.bind([queryText, limit]);
            while (stmt.step()) {
                const row = stmt.getAsObject() as Record<string, unknown>;
                results.push({
                    path: row.path as string,
                    raw_code: row.raw_code as string,
                    start_line: row.start_line as number,
                    symbol_name: (row.symbol_name as string) ?? "",
                });
            }
        } finally {
            stmt.free();
        }
        return results;
    }

    close(): void {
        if (!this.db) return;
        this.save();
        this.db.close();
    }
}

// Re-export for testing
export { fastSimilarity };


