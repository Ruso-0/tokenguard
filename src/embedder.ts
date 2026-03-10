/**
 * embedder.ts — Local embedding generation for TokenGuard.
 *
 * Uses Xenova/transformers (ONNX Runtime) to run all-MiniLM-L6-v2
 * entirely on-device. No Ollama, no API keys, no cloud calls.
 * Produces 384-dimensional normalized embeddings for semantic search.
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface EmbeddingResult {
    /** Normalized 384-dim embedding vector. */
    embedding: Float32Array;
    /** Time taken in milliseconds. */
    durationMs: number;
}

export interface BatchEmbeddingResult {
    /** Array of normalized embedding vectors. */
    embeddings: Float32Array[];
    /** Total time taken in milliseconds. */
    durationMs: number;
    /** Number of texts embedded. */
    count: number;
}

// ─── Embedder ────────────────────────────────────────────────────────

/**
 * Singleton embedding engine backed by Xenova/all-MiniLM-L6-v2.
 *
 * Design decisions:
 * - Lazy initialization: model loads only when first embedding is requested
 * - Quantized mode: uses INT8 quantization for faster inference & smaller memory
 * - Mean pooling + L2 normalization: standard for sentence embeddings
 * - Singleton pattern: avoids loading ~32 MB model multiple times
 */
export class Embedder {
    private pipeline: any = null;
    private initPromise: Promise<void> | null = null;
    private modelId: string;
    private isReady = false;

    constructor(modelId: string = "Xenova/all-MiniLM-L6-v2") {
        this.modelId = modelId;
    }

    // ─── Initialization ────────────────────────────────────────────

    /** Lazy-load the transformer pipeline. Thread-safe via promise dedup. */
    async initialize(): Promise<void> {
        if (this.isReady) return;

        if (!this.initPromise) {
            this.initPromise = this._loadModel();
        }

        await this.initPromise;
    }

    private async _loadModel(): Promise<void> {
        // Dynamic import to avoid loading 32 MB at require-time
        const { pipeline } = await import("@xenova/transformers");

        this.pipeline = await pipeline("feature-extraction", this.modelId, {
            quantized: true, // INT8 quantization — 4x smaller, ~same accuracy
        });

        this.isReady = true;
    }

    // ─── Single Embedding ──────────────────────────────────────────

    /** Generate a normalized embedding for a single text. */
    async embed(text: string): Promise<EmbeddingResult> {
        await this.initialize();

        const start = performance.now();

        const output = await this.pipeline(text, {
            pooling: "mean",
            normalize: true,
        });

        const embedding = new Float32Array(output.data);
        const durationMs = Math.round(performance.now() - start);

        return { embedding, durationMs };
    }

    // ─── Batch Embedding ──────────────────────────────────────────

    /**
     * Generate embeddings for multiple texts.
     * Processes sequentially to avoid OOM on large batches.
     */
    async embedBatch(texts: string[]): Promise<BatchEmbeddingResult> {
        await this.initialize();

        const start = performance.now();
        const embeddings: Float32Array[] = [];

        for (const text of texts) {
            const output = await this.pipeline(text, {
                pooling: "mean",
                normalize: true,
            });
            embeddings.push(new Float32Array(output.data));
        }

        const durationMs = Math.round(performance.now() - start);

        return { embeddings, durationMs, count: texts.length };
    }

    // ─── Utilities ────────────────────────────────────────────────

    /** Get the dimensionality of the embedding model. */
    getDimension(): number {
        return 384; // all-MiniLM-L6-v2 always produces 384-dim vectors
    }

    /** Check if the model is loaded and ready. */
    ready(): boolean {
        return this.isReady;
    }

    /**
     * Estimate the approximate token count of a string.
     * Uses a simple heuristic: ~4 chars per token for English text,
     * ~3.5 for code (more symbols/short identifiers).
     */
    static estimateTokens(text: string, isCode: boolean = true): number {
        const charsPerToken = isCode ? 3.5 : 4.0;
        return Math.ceil(text.length / charsPerToken);
    }
}

// ─── Singleton Instance ──────────────────────────────────────────────

let _instance: Embedder | null = null;

/** Get or create the global Embedder singleton. */
export function getEmbedder(modelId?: string): Embedder {
    if (!_instance) {
        _instance = new Embedder(modelId);
    }
    return _instance;
}
