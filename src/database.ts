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
import { codeTokenize } from "./utils/code-tokenizer.js";

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

// ─── In-Memory Vector Store ──────────────────────────────────────────

/**
 * Fast dot-product similarity for L2-normalized vectors.
 * Jina embeddings output L2-normalized vectors (magnitude = 1),
 * so cosine_similarity = dot_product (no sqrt/division needed).
 * This is ~3x faster than full cosine similarity.
 */
function fastSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
    }
    return dot;
}

// Fallback cosine similarity for non-normalized models:
// function cosineSimilarity(a: Float32Array, aNorm: number, b: Float32Array, bNorm: number): number {
//     let dot = 0;
//     for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
//     return (aNorm > 0 && bNorm > 0) ? dot / (aNorm * bNorm) : 0;
// }

/**
 * Pure JavaScript vector index using brute-force dot-product similarity.
 * For L2-normalized embeddings (Jina), dot product = cosine similarity.
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
            const sim = fastSimilarity(query, vec);
            scored.push({ rowid, distance: 1 - sim });
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
    /** Map from term → Map<rowid, TF> — unified inverted index + term frequency */
    private invertedIndex = new Map<string, Map<number, number>>();
    /** Map from bigram → Set of document rowids (for phrase search) */
    private bigramIndex = new Map<string, Set<number>>();
    /** Map from rowid → tokenized terms (for delete and avgDocLen) */
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

    /** Tokenize text into normalized terms with code-aware splitting. */
    private tokenize(text: string): string[] {
        // FIX 5: Apply code-aware tokenizer before stemming
        const rawTokens = text
            .replace(/[^a-zA-Z0-9_.]/g, " ")
            .split(/\s+/)
            .filter((t) => t.length > 1);

        const allTerms: string[] = [];
        for (const raw of rawTokens) {
            // Code-aware tokenization: split identifiers
            const subTokens = codeTokenize(raw);
            if (subTokens.length > 0) {
                for (const sub of subTokens) {
                    if (sub.length > 1 && !KeywordIndex.STOPWORDS.has(sub)) {
                        allTerms.push(sub);
                    }
                }
            } else {
                const lower = raw.toLowerCase();
                if (!KeywordIndex.STOPWORDS.has(lower)) {
                    allTerms.push(this.stem(lower));
                }
            }
        }
        return allTerms;
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

        // Compute local TF
        const tfMap = new Map<string, number>();
        for (const term of terms) {
            tfMap.set(term, (tfMap.get(term) || 0) + 1);
        }

        // Store TF directly in inverted index for O(1) lookup
        for (const [term, tf] of tfMap) {
            let docMap = this.invertedIndex.get(term);
            if (!docMap) {
                docMap = new Map<number, number>();
                this.invertedIndex.set(term, docMap);
            }
            docMap.set(rowid, tf);
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
            const docMap = this.invertedIndex.get(term);
            if (docMap) {
                docMap.delete(rowid);
                if (docMap.size === 0) {
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
     * Code-tuned parameters: k1 = 1.8, b = 0.35
     * Multi-word queries get a 0.3 weight bigram boost.
     */
    search(
        queryText: string,
        limit: number
    ): Array<{ rowid: number; score: number }> {
        const queryTerms = this.tokenize(queryText);
        if (queryTerms.length === 0) return [];

        const k1 = 1.8;
        const b = 0.35;
        const scores = new Map<number, number>();

        for (const term of queryTerms) {
            const docMap = this.invertedIndex.get(term);
            if (!docMap) continue;

            // IDF = log((N - df + 0.5) / (df + 0.5) + 1)
            const df = docMap.size;
            const idf = Math.log(
                (this.docCount - df + 0.5) / (df + 0.5) + 1
            );

            // TF read directly from inverted index — O(1)
            for (const [rowid, tf] of docMap) {
                const docLen = this.docTerms.get(rowid)!.length;

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

        // Setup schema first (creates metadata table needed for dimension lookup)
        this.setupSchema();

        // Load vector index using stored dimension (default 512)
        const storedDim = parseInt(this.getMetadata("embedding_dim") ?? "512", 10);
        if (fs.existsSync(this.vecPath)) {
            const vecBuffer = fs.readFileSync(this.vecPath);
            this.vecIndex = VectorIndex.deserialize(vecBuffer, storedDim);
        }

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
      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_log(timestamp);

      -- Metadata key-value store (embedding dimension, model name, etc.)
      CREATE TABLE IF NOT EXISTS metadata (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
        const rows = this.db.exec("SELECT id, shorthand FROM chunks");
        if (rows.length === 0) return;

        for (const row of rows[0].values) {
            const [id, shorthand] = row as [number, string];
            this.kwIndex.insert(id, shorthand);
        }
    }

    // ─── Metadata ────────────────────────────────────────────────

    /** Read a metadata value by key, or null if not set. */
    getMetadata(key: string): string | null {
        const stmt = this.db.prepare("SELECT value FROM metadata WHERE key = ?");
        stmt.bind([key]);
        let result: string | null = null;
        if (stmt.step()) {
            result = (stmt.getAsObject() as { value: string }).value;
        }
        stmt.free();
        return result;
    }

    /** Write a metadata key-value pair (upsert). */
    setMetadata(key: string, value: string): void {
        this.db.run(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
            [key, value]
        );
    }

    /**
     * Check if the active embedding dimension matches what was stored.
     * If they differ, clear all vectors and update the stored dimension.
     * Returns true if a re-index is needed.
     */
    checkEmbeddingDimension(activeDim: number): boolean {
        const storedDim = this.getMetadata("embedding_dim");

        if (storedDim && parseInt(storedDim, 10) !== activeDim) {
            console.warn(
                `[TokenGuard] Embedding dimension changed (${storedDim} -> ${activeDim}). Clearing index.`
            );
            // Clear all vectors
            this.vecIndex = new VectorIndex();
            // Clear all chunks and files so they get re-indexed
            this.db.run("DELETE FROM chunks");
            this.db.run("DELETE FROM files");
            this.kwIndex = new KeywordIndex();
            this.setMetadata("embedding_dim", String(activeDim));
            return true;
        }

        if (!storedDim) {
            this.setMetadata("embedding_dim", String(activeDim));
        }

        return false;
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
            startIndex?: number;
            endIndex?: number;
            symbolName?: string;
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
                    chunk.embedding,
                    chunk.startIndex ?? 0,
                    chunk.endIndex ?? 0,
                    chunk.symbolName ?? "",
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
        stmt.bind(ids);
        while (stmt.step()) {
            const row = stmt.getAsObject() as { id: number; path: string };
            result.set(row.id, row.path);
        }
        stmt.free();
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
        stmt.free();
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
        // 1. Vector search — top 60 by cosine similarity
        const vecResults = this.vecIndex.search(queryEmbedding, 60);
        const vecRanks = new Map<number, number>();
        vecResults.forEach((r, i) => vecRanks.set(r.rowid, i + 1));

        // 2. BM25 keyword search — top 60 by term relevance
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
     * Keyword-only search using BM25 (for Lite mode — no embeddings needed).
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

        const escapeRegex = (s: string) =>
            s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
                const safeSym = escapeRegex(dep.symbol);
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
        stmt.free();
        return result;
    }

    /**
     * Find the heaviest files by total raw code size.
     * Zero disk I/O — queries indexed data in SQLite.
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
        stmt.bind([limit]);

        const results: Array<{ path: string; estimated_tokens: number }> = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as { path: string; total_chars: number };
            results.push({
                path: row.path,
                estimated_tokens: Math.ceil(row.total_chars / 3.5),
            });
        }
        stmt.free();
        return results;
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
     * Scan ALL chunks whose raw_code contains the given symbol name.
     * Returns distinct file paths. Used by prepare_refactor for 100% coverage.
     */
    searchRawCode(symbolName: string): string[] {
        if (!this._ready) return [];
        const stmt = this.db.prepare(
            `SELECT DISTINCT path FROM chunks WHERE raw_code LIKE ?`
        );
        stmt.bind([`%${symbolName}%`]);
        const paths: string[] = [];
        while (stmt.step()) {
            paths.push(stmt.getAsObject().path as string);
        }
        stmt.free();
        return paths;
    }

    close(): void {
        this.save();
        this.db.close();
    }
}

// Re-export for testing
export { fastSimilarity };
