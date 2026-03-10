/**
 * compressor.ts — Semantic compression engine for TokenGuard.
 *
 * Converts full source files into compressed shorthand AST notation,
 * dramatically reducing token count while preserving enough structural
 * context for LLMs to understand and modify the code.
 *
 * Compression tiers:
 * - Tier 1 (signatures only): ~80% reduction — just signatures + markers
 * - Tier 2 (smart body):      ~50% reduction — keeps key logic lines
 * - Tier 3 (docstrings):      ~30% reduction — keeps docs + signatures
 */

import { ASTParser, type ParsedChunk } from "./parser.js";
import { Embedder } from "./embedder.js";

// ─── Types ───────────────────────────────────────────────────────────

export type CompressionTier = 1 | 2 | 3;

export interface CompressionResult {
    /** Compressed output text. */
    compressed: string;
    /** Original size in characters. */
    originalSize: number;
    /** Compressed size in characters. */
    compressedSize: number;
    /** Compression ratio (0.0 - 1.0). Higher = more compression. */
    ratio: number;
    /** Estimated tokens saved. */
    tokensSaved: number;
    /** Tier used for compression. */
    tier: CompressionTier;
    /** Number of AST chunks found. */
    chunksFound: number;
}

export interface CompressorOptions {
    /** Compression aggressiveness. Default: 1 (signatures only). */
    tier?: CompressionTier;
    /** Max number of body lines to keep in Tier 2. Default: 5. */
    maxBodyLines?: number;
    /** Include file header (imports/comments). Default: true. */
    includeHeader?: boolean;
    /** Focus on specific query — ranks chunks by relevance. */
    focusQuery?: string;
}

// ─── Compressor ──────────────────────────────────────────────────────

export class Compressor {
    private parser: ASTParser;
    private embedder: Embedder;

    constructor(parser: ASTParser, embedder: Embedder) {
        this.parser = parser;
        this.embedder = embedder;
    }

    /**
     * Compress a source file into shorthand AST notation.
     *
     * The compression strategy:
     * 1. Parse the file into AST chunks via Tree-sitter
     * 2. Generate shorthand for each chunk based on the tier
     * 3. Optionally rank chunks by relevance to a focus query
     * 4. Reconstruct the file with compressed chunks
     */
    async compress(
        filePath: string,
        content: string,
        options: CompressorOptions = {}
    ): Promise<CompressionResult> {
        const {
            tier = 1,
            maxBodyLines = 5,
            includeHeader = true,
            focusQuery,
        } = options;

        const parseResult = await this.parser.parse(filePath, content);
        const lines = content.split("\n");

        if (parseResult.chunks.length === 0) {
            // No AST chunks found — return as-is with a header comment
            return {
                compressed: `// [TokenGuard] No parseable AST nodes found\n${content}`,
                originalSize: content.length,
                compressedSize: content.length,
                ratio: 0,
                tokensSaved: 0,
                tier,
                chunksFound: 0,
            };
        }

        // ─── Build compressed output ─────────────────────────────────

        const parts: string[] = [];

        // Add file header comment
        parts.push(
            `// [TokenGuard] Compressed: ${filePath} | Tier ${tier} | ${parseResult.chunks.length} chunks`
        );

        // Include imports and top-level declarations (before first chunk)
        if (includeHeader) {
            const firstChunkLine = Math.min(
                ...parseResult.chunks.map((c) => c.startLine)
            );
            const headerLines = lines.slice(0, firstChunkLine - 1);
            const header = headerLines
                .filter(
                    (l) =>
                        l.trim().startsWith("import") ||
                        l.trim().startsWith("export") ||
                        l.trim().startsWith("//") ||
                        l.trim().startsWith("const") ||
                        l.trim().startsWith("type") ||
                        l.trim().startsWith("interface") ||
                        l.trim().length === 0
                )
                .join("\n");
            if (header.trim()) {
                parts.push(header);
            }
        }

        // Rank chunks by relevance if a focus query is provided
        let rankedChunks = parseResult.chunks;
        if (focusQuery) {
            rankedChunks = await this.rankByRelevance(
                parseResult.chunks,
                focusQuery
            );
        }

        // Compress each chunk based on the tier
        for (const chunk of rankedChunks) {
            const compressed = this.compressChunk(chunk, tier, maxBodyLines);
            parts.push(compressed);
        }

        const compressed = parts.join("\n\n");

        // ─── Calculate savings ───────────────────────────────────────

        const originalSize = content.length;
        const compressedSize = compressed.length;
        const ratio = 1 - compressedSize / originalSize;
        const tokensSaved = Embedder.estimateTokens(content) -
            Embedder.estimateTokens(compressed);

        return {
            compressed,
            originalSize,
            compressedSize,
            ratio: Math.max(0, ratio),
            tokensSaved: Math.max(0, tokensSaved),
            tier,
            chunksFound: parseResult.chunks.length,
        };
    }

    // ─── Chunk Compression ────────────────────────────────────────

    /**
     * Compress a single AST chunk based on the tier level.
     *
     * Tier 1: Signature only — maximum compression
     * Tier 2: Signature + key body lines (returns, throws, awaits)
     * Tier 3: Signature + docstring + key body lines
     */
    private compressChunk(
        chunk: ParsedChunk,
        tier: CompressionTier,
        maxBodyLines: number
    ): string {
        switch (tier) {
            case 1:
                return chunk.shorthand;

            case 2:
                return this.compressTier2(chunk, maxBodyLines);

            case 3:
                return this.compressTier3(chunk, maxBodyLines);

            default:
                return chunk.shorthand;
        }
    }

    /** Tier 2: Keep signature + semantically important lines. */
    private compressTier2(chunk: ParsedChunk, maxBodyLines: number): string {
        const lines = chunk.rawCode.split("\n");

        if (lines.length <= maxBodyLines + 2) {
            // Chunk is small enough — keep everything
            return `[${chunk.nodeType}] ${chunk.rawCode.trim()}`;
        }

        // Extract key lines: returns, throws, awaits, assignments
        const keyLines = lines.filter((line) => {
            const trimmed = line.trim();
            return (
                trimmed.startsWith("return ") ||
                trimmed.startsWith("throw ") ||
                trimmed.startsWith("await ") ||
                trimmed.startsWith("yield ") ||
                trimmed.includes("= new ") ||
                trimmed.includes("this.") ||
                trimmed.startsWith("if (") ||
                trimmed.startsWith("for (") ||
                trimmed.startsWith("while (")
            );
        });

        const signature = chunk.shorthand;
        const body = keyLines.slice(0, maxBodyLines).join("\n    ");

        return body
            ? `${signature}\n  // Key lines:\n    ${body}`
            : signature;
    }

    /** Tier 3: Keep signature + JSDoc/docstring + key lines. */
    private compressTier3(chunk: ParsedChunk, maxBodyLines: number): string {
        const lines = chunk.rawCode.split("\n");

        // Extract docstring (JSDoc, Python docstring, etc.)
        const docLines: string[] = [];
        let inDoc = false;

        for (const line of lines) {
            const trimmed = line.trim();

            // JSDoc
            if (trimmed.startsWith("/**") || trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
                inDoc = true;
            }
            if (inDoc) {
                docLines.push(line);
                if (
                    trimmed.endsWith("*/") ||
                    (trimmed.endsWith('"""') && docLines.length > 1) ||
                    (trimmed.endsWith("'''") && docLines.length > 1)
                ) {
                    inDoc = false;
                }
            }
            // Single-line comments above the signature
            if (trimmed.startsWith("//") || trimmed.startsWith("#")) {
                docLines.push(line);
            }
        }

        const tier2 = this.compressTier2(chunk, maxBodyLines);

        if (docLines.length > 0) {
            return `${docLines.join("\n")}\n${tier2}`;
        }

        return tier2;
    }

    // ─── Relevance Ranking ────────────────────────────────────────

    /** Rank chunks by semantic similarity to a focus query. */
    private async rankByRelevance(
        chunks: ParsedChunk[],
        query: string
    ): Promise<ParsedChunk[]> {
        const { embedding: queryEmbedding } = await this.embedder.embed(query);
        const scored: Array<{ chunk: ParsedChunk; score: number }> = [];

        for (const chunk of chunks) {
            const { embedding } = await this.embedder.embed(chunk.shorthand);
            const score = this.cosineSimilarity(queryEmbedding, embedding);
            scored.push({ chunk, score });
        }

        // Sort by descending similarity
        scored.sort((a, b) => b.score - a.score);

        return scored.map((s) => s.chunk);
    }

    /** Compute cosine similarity between two vectors. */
    private cosineSimilarity(a: Float32Array, b: Float32Array): number {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        const denominator = Math.sqrt(normA) * Math.sqrt(normB);
        return denominator === 0 ? 0 : dotProduct / denominator;
    }

    // ─── Utilities ────────────────────────────────────────────────

    /**
     * Quick estimate of compression savings for a file.
     * Does not actually parse — uses heuristics based on file size and type.
     */
    static estimateSavings(
        fileContent: string,
        tier: CompressionTier = 1
    ): { estimatedRatio: number; estimatedTokensSaved: number } {
        const tokens = Embedder.estimateTokens(fileContent);
        const ratioByTier: Record<CompressionTier, number> = {
            1: 0.75,
            2: 0.5,
            3: 0.3,
        };
        const ratio = ratioByTier[tier];
        return {
            estimatedRatio: ratio,
            estimatedTokensSaved: Math.round(tokens * ratio),
        };
    }
}
