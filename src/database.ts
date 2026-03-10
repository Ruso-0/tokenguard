/**
 * database.ts — SQLite persistence layer for TokenGuard.
 *
 * Uses sql.js (SQLite compiled to WASM) for zero-native-dependency
 * operation. Vector search AND keyword search are both implemented
 * in pure JavaScript:
 *
 * - VectorIndex: brute-force cosine similarity on Float32Array
 * - KeywordIndex: inverted index with Porter-inspired BM25 scoring
 *
 * This eliminates the need for FTS5, sqlite-vec, better-sqlite3,
 * node-gyp, and Visual Studio Build Tools — making TokenGuard
 * portable to any platform without native compilation.
 */

import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import crypto from "crypto";
import fs from "fs";
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

// ─── In-Memory Vector Store ──────────────────────────────────────────

/**
 * Pure JavaScript vector index using brute-force cosine similarity.
 * For codebases up to ~50K chunks, brute-force is fast enough (<10ms)
 * and avoids any native dependency.
 */
class VectorIndex {
    private vectors = new Map<number, Float32Array>();

    insert(rowid: number, embedding: Float32Array): void {
        this.vectors.set(rowid, embedding);
    }

    delete(rowid: number): void {
        this.vectors.delete(rowid);
    }

    deleteBulk(rowids: number[]): void {
        for (const id of rowids) {
            this.vectors.delete(id);
        }
    }

    search(
        query: Float32Array,
        limit: number
    ): Array<{ rowid: number; distance: number }> {
        const scored: Array<{ rowid: number; distance: number }> = [];

        for (const [rowid, vec] of this.vectors) {
            let dot = 0;
            for (let i = 0; i < query.length; i++) {
                dot += query[i] * vec[i];
            }
            scored.push({ rowid, distance: 1 - dot });
        }

        scored.sort((a, b) => a.distance - b.distance);
        return scored.slice(0, limit);
    }

    get size(): number {
        return this.vectors.size;
    }

    serialize(): Buffer {
        const entries = Array.from(this.vectors.entries());
        const header = Buffer.alloc(4);
        header.writeUInt32LE(entries.length);

        const chunks: Buffer[] = [header];
        for (const [rowid, vec] of entries) {
            const idBuf = Buffer.alloc(4);
            idBuf.writeUInt32LE(rowid);
            chunks.push(idBuf);
            chunks.push(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
        }
        return Buffer.concat(chunks);
    }

    static deserialize(buf: Buffer, dim: number): VectorIndex {
        const index = new VectorIndex();
        if (buf.length < 4) return index;

        const count = buf.readUInt32LE(0);
        let offset = 4;
        const vecBytes = dim * 4;

        for (let i = 0; i < count; i++) {
            if (offset + 4 + vecBytes > buf.length) break;
            const rowid = buf.readUInt32LE(offset);
            offset += 4;
            const vec = new Float32Array(
                buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + vecBytes)
            );
            index.vectors.set(rowid, vec);
            offset += vecBytes;
        }
        return index;
    }
}

// ─── Porter Stemmer ─────────────────────────────────────────────────

/**
 * Full Porter stemming algorithm in pure TypeScript.
 * Based on the original 1980 paper by Martin Porter.
 */
class PorterStemmer {
    private static isConsonant(word: string, i: number): boolean {
        const c = word[i];
        if (/[aeiou]/.test(c)) return false;
        if (c === "y") return i === 0 || !PorterStemmer.isConsonant(word, i - 1);
        return true;
    }

    /** Measure: count VC sequences in the stem. */
    private static measure(stem: string): number {
        let m = 0;
        let i = 0;
        const len = stem.length;
        // Skip leading consonants
        while (i < len && PorterStemmer.isConsonant(stem, i)) i++;
        while (i < len) {
            // Count vowel sequence
            while (i < len && !PorterStemmer.isConsonant(stem, i)) i++;
            if (i >= len) break;
            // Count consonant sequence
            while (i < len && PorterStemmer.isConsonant(stem, i)) i++;
            m++;
        }
        return m;
    }

    private static containsVowel(stem: string): boolean {
        for (let i = 0; i < stem.length; i++) {
            if (!PorterStemmer.isConsonant(stem, i)) return true;
        }
        return false;
    }

    private static endsWithDouble(word: string): boolean {
        if (word.length < 2) return false;
        return word[word.length - 1] === word[word.length - 2] &&
            PorterStemmer.isConsonant(word, word.length - 1);
    }

    /** Ends with consonant-vowel-consonant where last C is not w, x, or y. */
    private static cvc(word: string): boolean {
        const len = word.length;
        if (len < 3) return false;
        const last = word[len - 1];
        if (!PorterStemmer.isConsonant(word, len - 1)) return false;
        if (PorterStemmer.isConsonant(word, len - 2)) return false;
        if (!PorterStemmer.isConsonant(word, len - 3)) return false;
        return last !== "w" && last !== "x" && last !== "y";
    }

    static stem(word: string): string {
        if (word.length <= 2) return word;
        let w = word.toLowerCase();

        // Step 1a: Plurals
        if (w.endsWith("sses")) w = w.slice(0, -2);
        else if (w.endsWith("ies")) w = w.slice(0, -2);
        else if (!w.endsWith("ss") && w.endsWith("s")) w = w.slice(0, -1);

        // Step 1b: Past participles / gerunds
        let step1bFlag = false;
        if (w.endsWith("eed")) {
            const stem = w.slice(0, -3);
            if (PorterStemmer.measure(stem) > 0) w = w.slice(0, -1); // eed -> ee
        } else if (w.endsWith("ed")) {
            const stem = w.slice(0, -2);
            if (PorterStemmer.containsVowel(stem)) { w = stem; step1bFlag = true; }
        } else if (w.endsWith("ing")) {
            const stem = w.slice(0, -3);
            if (PorterStemmer.containsVowel(stem)) { w = stem; step1bFlag = true; }
        }

        if (step1bFlag) {
            if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) {
                w += "e";
            } else if (PorterStemmer.endsWithDouble(w) &&
                !/[lsz]$/.test(w)) {
                w = w.slice(0, -1);
            } else if (PorterStemmer.measure(w) === 1 && PorterStemmer.cvc(w)) {
                w += "e";
            }
        }

        // Step 1c: y -> i
        if (w.endsWith("y") && PorterStemmer.containsVowel(w.slice(0, -1))) {
            w = w.slice(0, -1) + "i";
        }

        // Step 2: Double suffixes
        const step2: [string, string][] = [
            ["ational", "ate"], ["tional", "tion"], ["enci", "ence"],
            ["anci", "ance"], ["izer", "ize"], ["abli", "able"],
            ["alli", "al"], ["entli", "ent"], ["eli", "e"],
            ["ousli", "ous"], ["ization", "ize"], ["ation", "ate"],
            ["ator", "ate"], ["alism", "al"], ["iveness", "ive"],
            ["fulness", "ful"], ["ousness", "ous"], ["aliti", "al"],
            ["iviti", "ive"], ["biliti", "ble"],
        ];
        for (const [suffix, replacement] of step2) {
            if (w.endsWith(suffix)) {
                const stem = w.slice(0, -suffix.length);
                if (PorterStemmer.measure(stem) > 0) w = stem + replacement;
                break;
            }
        }

        // Step 3
        const step3: [string, string][] = [
            ["icate", "ic"], ["ative", ""], ["alize", "al"],
            ["iciti", "ic"], ["ical", "ic"], ["ful", ""], ["ness", ""],
        ];
        for (const [suffix, replacement] of step3) {
            if (w.endsWith(suffix)) {
                const stem = w.slice(0, -suffix.length);
                if (PorterStemmer.measure(stem) > 0) w = stem + replacement;
                break;
            }
        }

        // Step 4: Remove suffixes
        const step4 = [
            "al", "ance", "ence", "er", "ic", "able", "ible", "ant",
            "ement", "ment", "ent", "ion", "ou", "ism", "ate", "iti",
            "ous", "ive", "ize",
        ];
        for (const suffix of step4) {
            if (w.endsWith(suffix)) {
                const stem = w.slice(0, -suffix.length);
                if (PorterStemmer.measure(stem) > 1) {
                    if (suffix === "ion") {
                        if (stem.endsWith("s") || stem.endsWith("t")) w = stem;
                    } else {
                        w = stem;
                    }
                }
                break;
            }
        }

        // Step 5a: Remove trailing e
        if (w.endsWith("e")) {
            const stem = w.slice(0, -1);
            const m = PorterStemmer.measure(stem);
            if (m > 1 || (m === 1 && !PorterStemmer.cvc(stem))) {
                w = stem;
            }
        }

        // Step 5b: Remove double l
        if (w.endsWith("ll") && PorterStemmer.measure(w) > 1) {
            w = w.slice(0, -1);
        }

        return w;
    }
}

// ─── In-Memory Keyword Index ─────────────────────────────────────────

/**
 * Pure JavaScript inverted index for BM25-style keyword search.
 * Replaces FTS5 entirely — no native extensions needed.
 *
 * Tokenization: lowercases, splits on non-alphanumeric chars,
 * filters stopwords, applies basic stemming (suffix removal).
 */
class KeywordIndex {
    /** Map from term → Set of document rowids containing that term */
    private invertedIndex = new Map<string, Set<number>>();
    /** Map from bigram → Set of document rowids (for phrase search) */
    private bigramIndex = new Map<string, Set<number>>();
    /** Map from rowid → tokenized terms (for TF computation) */
    private docTerms = new Map<number, string[]>();
    /** Total number of documents */
    private docCount = 0;
    /** Average document length in terms */
    private avgDocLen = 0;

    private static STOPWORDS = new Set([
        "a", "an", "the", "is", "are", "was", "were", "be", "been",
        "being", "have", "has", "had", "do", "does", "did", "will",
        "would", "could", "should", "may", "might", "shall", "can",
        "to", "of", "in", "for", "on", "with", "at", "by", "from",
        "as", "into", "through", "during", "before", "after", "above",
        "below", "and", "but", "or", "not", "no", "if", "then",
        "else", "this", "that", "it", "its", "new", "old",
    ]);

    /** Tokenize text into normalized terms. */
    private tokenize(text: string): string[] {
        return text
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, " ")
            .split(/\s+/)
            .filter((t) => t.length > 1 && !KeywordIndex.STOPWORDS.has(t))
            .map((t) => this.stem(t));
    }

    /**
     * Porter stemmer — full implementation of the Porter stemming algorithm.
     * 5 steps with consonant-vowel pattern analysis for accurate English stemming.
     */
    private stem(word: string): string {
        if (word.length <= 2) return word;
        return PorterStemmer.stem(word);
    }

    /** Add a document to the index. */
    insert(rowid: number, text: string): void {
        const terms = this.tokenize(text);
        this.docTerms.set(rowid, terms);

        for (const term of terms) {
            if (!this.invertedIndex.has(term)) {
                this.invertedIndex.set(term, new Set());
            }
            this.invertedIndex.get(term)!.add(rowid);
        }

        // Generate bigrams for phrase search
        for (let i = 0; i < terms.length - 1; i++) {
            const bigram = terms[i] + "_" + terms[i + 1];
            if (!this.bigramIndex.has(bigram)) {
                this.bigramIndex.set(bigram, new Set());
            }
            this.bigramIndex.get(bigram)!.add(rowid);
        }

        this.docCount++;
        this.updateAvgDocLen();
    }

    /** Remove a document from the index. */
    delete(rowid: number): void {
        const terms = this.docTerms.get(rowid);
        if (!terms) return;

        for (const term of terms) {
            const docs = this.invertedIndex.get(term);
            if (docs) {
                docs.delete(rowid);
                if (docs.size === 0) {
                    this.invertedIndex.delete(term);
                }
            }
        }

        // Clean up bigram entries
        for (let i = 0; i < terms.length - 1; i++) {
            const bigram = terms[i] + "_" + terms[i + 1];
            const docs = this.bigramIndex.get(bigram);
            if (docs) {
                docs.delete(rowid);
                if (docs.size === 0) {
                    this.bigramIndex.delete(bigram);
                }
            }
        }

        this.docTerms.delete(rowid);
        this.docCount = Math.max(0, this.docCount - 1);
        this.updateAvgDocLen();
    }

    deleteBulk(rowids: number[]): void {
        for (const id of rowids) {
            this.delete(id);
        }
    }

    private updateAvgDocLen(): void {
        if (this.docCount === 0) {
            this.avgDocLen = 0;
            return;
        }
        let totalLen = 0;
        for (const terms of this.docTerms.values()) {
            totalLen += terms.length;
        }
        this.avgDocLen = totalLen / this.docCount;
    }

    /**
     * BM25 search with bigram phrase boosting.
     * Standard parameters: k1 = 1.2, b = 0.75
     * Multi-word queries get a 0.3 weight bigram boost.
     */
    search(
        queryText: string,
        limit: number
    ): Array<{ rowid: number; score: number }> {
        const queryTerms = this.tokenize(queryText);
        if (queryTerms.length === 0) return [];

        const k1 = 1.2;
        const b = 0.75;
        const scores = new Map<number, number>();

        for (const term of queryTerms) {
            const docs = this.invertedIndex.get(term);
            if (!docs) continue;

            // IDF = log((N - df + 0.5) / (df + 0.5) + 1)
            const df = docs.size;
            const idf = Math.log(
                (this.docCount - df + 0.5) / (df + 0.5) + 1
            );

            for (const rowid of docs) {
                const docTerms = this.docTerms.get(rowid)!;
                const docLen = docTerms.length;

                // TF = count of term in document
                const tf = docTerms.filter((t) => t === term).length;

                // BM25 formula
                const tfNorm =
                    (tf * (k1 + 1)) /
                    (tf + k1 * (1 - b + b * (docLen / (this.avgDocLen || 1))));
                const score = idf * tfNorm;

                scores.set(rowid, (scores.get(rowid) || 0) + score);
            }
        }

        // Bigram phrase boost for multi-word queries
        if (queryTerms.length >= 2) {
            const bigramWeight = 0.3;
            for (let i = 0; i < queryTerms.length - 1; i++) {
                const bigram = queryTerms[i] + "_" + queryTerms[i + 1];
                const docs = this.bigramIndex.get(bigram);
                if (!docs) continue;
                for (const rowid of docs) {
                    const existing = scores.get(rowid) || 0;
                    scores.set(rowid, existing + bigramWeight);
                }
            }
        }

        return Array.from(scores.entries())
            .map(([rowid, score]) => ({ rowid, score }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }
}

// ─── Database Manager ────────────────────────────────────────────────

export class TokenGuardDB {
    private db!: SqlJsDatabase;
    private vecIndex = new VectorIndex();
    private kwIndex = new KeywordIndex();
    private dbPath: string;
    private vecPath: string;
    private initPromise: Promise<void> | null = null;
    private _ready = false;

    constructor(dbPath: string = ".tokenguard.db") {
        this.dbPath = dbPath;
        this.vecPath = dbPath.replace(/\.db$/, ".vec");
    }

    /** Async initialization — must be called before any DB operation. */
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
            const fileBuffer = fs.readFileSync(this.dbPath);
            this.db = new SQL.Database(fileBuffer);
        } else {
            this.db = new SQL.Database();
        }

        // Load vector index if it exists
        if (fs.existsSync(this.vecPath)) {
            const vecBuffer = fs.readFileSync(this.vecPath);
            this.vecIndex = VectorIndex.deserialize(vecBuffer, 384);
        }

        this.setupSchema();

        // Rebuild keyword index from existing data
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
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        path       TEXT NOT NULL,
        shorthand  TEXT NOT NULL,
        raw_code   TEXT NOT NULL,
        node_type  TEXT NOT NULL DEFAULT 'unknown',
        start_line INTEGER NOT NULL DEFAULT 0,
        end_line   INTEGER NOT NULL DEFAULT 0
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
      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_log(timestamp);
    `);
    }

    /** Rebuild the in-memory keyword index from all existing chunks. */
    private rebuildKeywordIndex(): void {
        const rows = this.db.exec("SELECT id, shorthand FROM chunks");
        if (rows.length === 0) return;

        for (const row of rows[0].values) {
            const [id, shorthand] = row as [number, string];
            this.kwIndex.insert(id, shorthand);
        }
    }

    // ─── Persistence ─────────────────────────────────────────────

    /** Persist database and vector index to disk. */
    save(): void {
        // Save SQLite database
        const data = this.db.export();
        const buffer = Buffer.from(data);
        const dir = path.dirname(this.dbPath);
        if (dir && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.dbPath, buffer);

        // Save vector index
        const vecData = this.vecIndex.serialize();
        fs.writeFileSync(this.vecPath, vecData);
    }

    // ─── File Operations ─────────────────────────────────────────

    fileNeedsUpdate(filePath: string, content: string): boolean {
        const newHash = crypto.createHash("sha256").update(content).digest("hex");
        const stmt = this.db.prepare("SELECT hash FROM files WHERE path = ?");
        stmt.bind([filePath]);

        if (stmt.step()) {
            const row = stmt.getAsObject() as { hash: string };
            stmt.free();
            return row.hash !== newHash;
        }
        stmt.free();
        return true;
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
        stmt.bind([filePath]);

        const ids: number[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as { id: number };
            ids.push(row.id);
        }
        stmt.free();

        if (ids.length > 0) {
            this.vecIndex.deleteBulk(ids);
            this.kwIndex.deleteBulk(ids);
            this.db.run("DELETE FROM chunks WHERE path = ?", [filePath]);
        }
    }

    // ─── Chunk Operations ────────────────────────────────────────

    insertChunk(
        filePath: string,
        shorthand: string,
        rawCode: string,
        nodeType: string,
        startLine: number,
        endLine: number,
        embedding: Float32Array
    ): number {
        this.db.run(
            `INSERT INTO chunks (path, shorthand, raw_code, node_type, start_line, end_line)
       VALUES (?, ?, ?, ?, ?, ?)`,
            [filePath, shorthand, rawCode, nodeType, startLine, endLine]
        );

        const rowid = (this.db.exec("SELECT last_insert_rowid() AS id")[0]
            .values[0][0] as number);

        this.vecIndex.insert(rowid, embedding);
        this.kwIndex.insert(rowid, shorthand);
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
        }>
    ): void {
        this.db.run("BEGIN TRANSACTION");
        try {
            for (const chunk of chunks) {
                this.insertChunk(
                    chunk.path,
                    chunk.shorthand,
                    chunk.rawCode,
                    chunk.nodeType,
                    chunk.startLine,
                    chunk.endLine,
                    chunk.embedding
                );
            }
            this.db.run("COMMIT");
        } catch (err) {
            this.db.run("ROLLBACK");
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

    // ─── Search Operations ───────────────────────────────────────

    /**
     * Hybrid search using Reciprocal Rank Fusion (RRF).
     * Combines:
     *   - Vector similarity (semantic, cosine distance)
     *   - BM25 keyword matching (in pure JS inverted index)
     *
     * RRF formula: score = Σ 1/(k + rank_i) where k=60
     */
    searchHybrid(
        queryEmbedding: Float32Array,
        queryText: string,
        limit: number = 10
    ): HybridSearchResult[] {
        // 1. Vector search — top 60 by cosine similarity
        const vecResults = this.vecIndex.search(queryEmbedding, 60);
        const vecRanks = new Map<number, number>();
        vecResults.forEach((r, i) => vecRanks.set(r.rowid, i + 1));

        // 2. BM25 keyword search — top 60 by term relevance
        const kwResults = this.kwIndex.search(queryText, 60);
        const kwRanks = new Map<number, number>();
        kwResults.forEach((r, i) => kwRanks.set(r.rowid, i + 1));

        // 3. RRF fusion with path boosting
        const allIds = new Set([...vecRanks.keys(), ...kwRanks.keys()]);
        const scored: Array<{ id: number; rrf: number }> = [];

        for (const id of allIds) {
            const vecRank = vecRanks.get(id);
            const kwRank = kwRanks.get(id);
            let rrf =
                (vecRank ? 1.0 / (60 + vecRank) : 0) +
                (kwRank ? 1.0 / (60 + kwRank) : 0);

            // Apply path boost — look up the file path for this chunk
            const pathStmt = this.db.prepare("SELECT path FROM chunks WHERE id = ?");
            pathStmt.bind([id]);
            if (pathStmt.step()) {
                const row = pathStmt.getAsObject() as { path: string };
                rrf *= this.getPathBoost(row.path);
            }
            pathStmt.free();

            scored.push({ id, rrf });
        }

        scored.sort((a, b) => b.rrf - a.rrf);
        const topIds = scored.slice(0, limit);

        // 4. Fetch full chunk data
        const results: HybridSearchResult[] = [];
        for (const { id, rrf } of topIds) {
            const stmt = this.db.prepare(
                `SELECT id, path, shorthand, raw_code, node_type, start_line, end_line
         FROM chunks WHERE id = ?`
            );
            stmt.bind([id]);
            if (stmt.step()) {
                const row = stmt.getAsObject() as any;
                results.push({
                    id: row.id,
                    path: row.path,
                    shorthand: row.shorthand,
                    raw_code: row.raw_code,
                    node_type: row.node_type,
                    start_line: row.start_line,
                    end_line: row.end_line,
                    rrf_score: rrf,
                });
            }
            stmt.free();
        }

        return results;
    }

    searchVector(
        queryEmbedding: Float32Array,
        limit: number = 10
    ): HybridSearchResult[] {
        const vecResults = this.vecIndex.search(queryEmbedding, limit);
        const results: HybridSearchResult[] = [];

        for (const { rowid, distance } of vecResults) {
            const stmt = this.db.prepare(
                `SELECT id, path, shorthand, raw_code, node_type, start_line, end_line
         FROM chunks WHERE id = ?`
            );
            stmt.bind([rowid]);
            if (stmt.step()) {
                const row = stmt.getAsObject() as any;
                results.push({ ...row, rrf_score: 1 - distance });
            }
            stmt.free();
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

        if (params.length > 0) stmt.bind(params);

        let result = { total_input: 0, total_output: 0, total_saved: 0, tool_calls: 0 };
        if (stmt.step()) {
            result = stmt.getAsObject() as any;
        }
        stmt.free();
        return result;
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

    close(): void {
        this.save();
        this.db.close();
    }
}
