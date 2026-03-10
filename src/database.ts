/**
 * database.ts — SQLite persistence layer for TokenGuard.
 *
 * Uses better-sqlite3 with sqlite-vec (vector search) and FTS5
 * (full-text search) to power hybrid RRF retrieval. All data stays
 * local — zero cloud dependencies.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import crypto from "crypto";
import path from "path";

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
}

export interface HybridSearchResult {
    id: number;
    path: string;
    shorthand: string;
    raw_code: string;
    node_type: string;
    start_line: number;
    end_line: number;
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

export class TokenGuardDB {
    private db: Database.Database;

    constructor(dbPath: string = ".tokenguard.db") {
        this.db = new Database(dbPath);

        // Load sqlite-vec extension for vector similarity search
        sqliteVec.load(this.db);

        // Performance tuning for local-only usage
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = NORMAL");
        this.db.pragma("cache_size = -64000"); // 64 MB cache
        this.db.pragma("temp_store = MEMORY");

        this.setupSchema();
    }

    // ─── Schema ──────────────────────────────────────────────────────

    private setupSchema(): void {
        this.db.exec(`
      -- Indexed files with content hashes for Merkle-style diffing
      CREATE TABLE IF NOT EXISTS files (
        path      TEXT PRIMARY KEY,
        hash      TEXT NOT NULL,
        indexed_at TEXT DEFAULT (datetime('now'))
      );

      -- AST chunks extracted from source files
      CREATE TABLE IF NOT EXISTS chunks (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        path       TEXT NOT NULL,
        shorthand  TEXT NOT NULL,
        raw_code   TEXT NOT NULL,
        node_type  TEXT NOT NULL DEFAULT 'unknown',
        start_line INTEGER NOT NULL DEFAULT 0,
        end_line   INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
      );

      -- Vector embeddings for semantic search (384-dim MiniLM)
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks
        USING vec0(embedding float[384]);

      -- Full-text search index for BM25 keyword matching
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks
        USING fts5(
          shorthand,
          content='chunks',
          content_rowid='id',
          tokenize='porter unicode61'
        );

      -- Auto-sync FTS on insert
      CREATE TRIGGER IF NOT EXISTS chunks_ai
        AFTER INSERT ON chunks BEGIN
          INSERT INTO fts_chunks(rowid, shorthand)
          VALUES (new.id, new.shorthand);
        END;

      -- Auto-sync FTS on delete
      CREATE TRIGGER IF NOT EXISTS chunks_ad
        AFTER DELETE ON chunks BEGIN
          INSERT INTO fts_chunks(fts_chunks, rowid, shorthand)
          VALUES ('delete', old.id, old.shorthand);
        END;

      -- Auto-sync FTS on update
      CREATE TRIGGER IF NOT EXISTS chunks_au
        AFTER UPDATE ON chunks BEGIN
          INSERT INTO fts_chunks(fts_chunks, rowid, shorthand)
          VALUES ('delete', old.id, old.shorthand);
          INSERT INTO fts_chunks(rowid, shorthand)
          VALUES (new.id, new.shorthand);
        END;

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
      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_log(timestamp);
    `);
    }

    // ─── File Operations ─────────────────────────────────────────────

    /** Check if a file needs re-indexing via SHA-256 hash comparison. */
    fileNeedsUpdate(filePath: string, content: string): boolean {
        const newHash = crypto.createHash("sha256").update(content).digest("hex");
        const existing = this.db
            .prepare("SELECT hash FROM files WHERE path = ?")
            .get(filePath) as FileRecord | undefined;
        return existing?.hash !== newHash;
    }

    /** Compute SHA-256 hash of file content. */
    hashContent(content: string): string {
        return crypto.createHash("sha256").update(content).digest("hex");
    }

    /** Upsert a file record. */
    upsertFile(filePath: string, hash: string): void {
        this.db
            .prepare(
                "INSERT OR REPLACE INTO files (path, hash, indexed_at) VALUES (?, ?, datetime('now'))"
            )
            .run(filePath, hash);
    }

    /** Remove all chunks for a given file path. */
    clearChunks(filePath: string): void {
        // Get chunk IDs first to also clean vec_chunks
        const chunks = this.db
            .prepare("SELECT id FROM chunks WHERE path = ?")
            .all(filePath) as { id: number }[];

        if (chunks.length > 0) {
            const deleteVec = this.db.prepare(
                "DELETE FROM vec_chunks WHERE rowid = ?"
            );
            const deleteChunks = this.db.prepare(
                "DELETE FROM chunks WHERE path = ?"
            );

            const transaction = this.db.transaction(() => {
                for (const chunk of chunks) {
                    deleteVec.run(chunk.id);
                }
                deleteChunks.run(filePath);
            });

            transaction();
        }
    }

    // ─── Chunk Operations ────────────────────────────────────────────

    /** Insert a new chunk with its vector embedding. */
    insertChunk(
        filePath: string,
        shorthand: string,
        rawCode: string,
        nodeType: string,
        startLine: number,
        endLine: number,
        embedding: Float32Array
    ): number {
        const info = this.db
            .prepare(
                `INSERT INTO chunks (path, shorthand, raw_code, node_type, start_line, end_line)
         VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(filePath, shorthand, rawCode, nodeType, startLine, endLine);

        const rowid = info.lastInsertRowid as number;

        this.db
            .prepare("INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)")
            .run(rowid, Buffer.from(embedding.buffer));

        return rowid;
    }

    /** Batch insert multiple chunks within a transaction. */
    insertChunksBatch(
        chunks: Array<{
            path: string;
            shorthand: string;
            rawCode: string;
            nodeType: string;
            startLine: number;
            endLine: number;
            embedding: Float32Array;
        }>
    ): void {
        const insertChunk = this.db.prepare(
            `INSERT INTO chunks (path, shorthand, raw_code, node_type, start_line, end_line)
       VALUES (?, ?, ?, ?, ?, ?)`
        );
        const insertVec = this.db.prepare(
            "INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)"
        );

        const transaction = this.db.transaction(() => {
            for (const chunk of chunks) {
                const info = insertChunk.run(
                    chunk.path,
                    chunk.shorthand,
                    chunk.rawCode,
                    chunk.nodeType,
                    chunk.startLine,
                    chunk.endLine
                );
                insertVec.run(
                    info.lastInsertRowid,
                    Buffer.from(chunk.embedding.buffer)
                );
            }
        });

        transaction();
    }

    // ─── Search Operations ───────────────────────────────────────────

    /**
     * Hybrid search using Reciprocal Rank Fusion (RRF).
     * Combines vector similarity (semantic) with BM25 (keyword) for
     * best-of-both-worlds retrieval accuracy.
     *
     * RRF formula: score = Σ 1/(k + rank_i) where k=60
     */
    searchHybrid(
        queryEmbedding: Float32Array,
        queryText: string,
        limit: number = 10
    ): HybridSearchResult[] {
        // Sanitize query for FTS5 — remove special chars, create OR query
        const ftsQuery = queryText
            .replace(/[^a-zA-Z0-9_\s]/g, " ")
            .trim()
            .split(/\s+/)
            .filter((t) => t.length > 1)
            .map((t) => `"${t}"`)
            .join(" OR ");

        if (!ftsQuery) {
            // Fall back to pure vector search if no valid FTS terms
            return this.searchVector(queryEmbedding, limit);
        }

        const results = this.db
            .prepare(
                `
        WITH vector_search AS (
          SELECT rowid, distance,
            ROW_NUMBER() OVER (ORDER BY distance ASC) AS rank_vec
          FROM vec_chunks
          WHERE embedding MATCH ?
          ORDER BY distance ASC
          LIMIT 60
        ),
        bm25_search AS (
          SELECT rowid, bm25(fts_chunks) AS score,
            ROW_NUMBER() OVER (ORDER BY bm25(fts_chunks) ASC) AS rank_bm25
          FROM fts_chunks
          WHERE fts_chunks MATCH ?
          ORDER BY bm25(fts_chunks) ASC
          LIMIT 60
        )
        SELECT
          c.id, c.path, c.shorthand, c.raw_code,
          c.node_type, c.start_line, c.end_line,
          (COALESCE(1.0 / (60 + v.rank_vec), 0.0) +
           COALESCE(1.0 / (60 + b.rank_bm25), 0.0)) AS rrf_score
        FROM chunks c
        LEFT JOIN vector_search v ON c.id = v.rowid
        LEFT JOIN bm25_search  b ON c.id = b.rowid
        WHERE v.rowid IS NOT NULL OR b.rowid IS NOT NULL
        ORDER BY rrf_score DESC
        LIMIT ?
      `
            )
            .all(Buffer.from(queryEmbedding.buffer), ftsQuery, limit) as HybridSearchResult[];

        return results;
    }

    /** Pure vector similarity search fallback. */
    searchVector(
        queryEmbedding: Float32Array,
        limit: number = 10
    ): HybridSearchResult[] {
        const results = this.db
            .prepare(
                `
        SELECT c.id, c.path, c.shorthand, c.raw_code,
               c.node_type, c.start_line, c.end_line,
               v.distance AS rrf_score
        FROM vec_chunks v
        JOIN chunks c ON c.id = v.rowid
        WHERE v.embedding MATCH ?
        ORDER BY v.distance ASC
        LIMIT ?
      `
            )
            .all(Buffer.from(queryEmbedding.buffer), limit) as HybridSearchResult[];

        return results;
    }

    // ─── Usage Tracking ──────────────────────────────────────────────

    /** Log a tool invocation with token usage stats. */
    logUsage(
        toolName: string,
        inputTokens: number,
        outputTokens: number,
        savedTokens: number
    ): void {
        this.db
            .prepare(
                `INSERT INTO usage_log (tool_name, input_tokens, output_tokens, saved_tokens)
         VALUES (?, ?, ?, ?)`
            )
            .run(toolName, inputTokens, outputTokens, savedTokens);
    }

    /** Get aggregated usage stats for a time window. */
    getUsageStats(since?: string): {
        total_input: number;
        total_output: number;
        total_saved: number;
        tool_calls: number;
    } {
        const whereClause = since ? "WHERE timestamp >= ?" : "";
        const params = since ? [since] : [];

        const result = this.db
            .prepare(
                `SELECT
          COALESCE(SUM(input_tokens), 0)  AS total_input,
          COALESCE(SUM(output_tokens), 0) AS total_output,
          COALESCE(SUM(saved_tokens), 0)  AS total_saved,
          COUNT(*)                         AS tool_calls
        FROM usage_log ${whereClause}`
            )
            .get(...params) as any;

        return result;
    }

    // ─── Statistics ──────────────────────────────────────────────────

    /** Get compression statistics across all indexed files. */
    getStats(): TokenStats {
        const result = this.db
            .prepare(
                `SELECT
          COUNT(*)                     AS total_chunks,
          COUNT(DISTINCT path)         AS total_files,
          COALESCE(SUM(LENGTH(raw_code)), 0)   AS total_raw_tokens,
          COALESCE(SUM(LENGTH(shorthand)), 0)  AS total_shorthand_tokens
        FROM chunks`
            )
            .get() as any;

        return {
            ...result,
            compression_ratio:
                result.total_raw_tokens > 0
                    ? 1 - result.total_shorthand_tokens / result.total_raw_tokens
                    : 0,
        };
    }

    /** Get the total number of indexed files. */
    getFileCount(): number {
        const result = this.db
            .prepare("SELECT COUNT(*) AS count FROM files")
            .get() as { count: number };
        return result.count;
    }

    /** Close the database connection. */
    close(): void {
        this.db.close();
    }
}
