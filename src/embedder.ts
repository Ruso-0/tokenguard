/**
 * embedder.ts — Local embedding generation for TokenGuard.
 *
 * Uses Xenova/transformers (ONNX Runtime) to run embedding models
 * entirely on-device. No Ollama, no API keys, no cloud calls.
 * Tries code-aware models first, falls back to general-purpose ones.
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface EmbeddingResult {
    /** Normalized embedding vector. */
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

// ─── Model Priority ─────────────────────────────────────────────────

export interface ModelSpec {
    name: string;
    dim: number;
    type: "code" | "general";
}

export const MODEL_PRIORITY: ModelSpec[] = [
    { name: "Xenova/jina-embeddings-v2-small-code", dim: 512, type: "code" },
    { name: "Xenova/codebert-base", dim: 768, type: "code" },
    { name: "Xenova/jina-embeddings-v2-small-en", dim: 512, type: "general" },
    { name: "Xenova/all-MiniLM-L6-v2", dim: 384, type: "general" },
];

// ─── Embedder ────────────────────────────────────────────────────────

/**
 * Singleton embedding engine with model fallback chain.
 *
 * Design decisions:
 * - Model priority: tries code-aware models first (higher NDCG on CodeSearchNet),
 *   falls back to general-purpose models if unavailable
 * - Lazy initialization: model loads only when first embedding is requested
 * - Quantized mode: uses INT8 quantization for faster inference & smaller memory
 * - Mean pooling + L2 normalization: standard for sentence embeddings
 * - Singleton pattern: avoids loading model multiple times
 */
export class Embedder {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FeatureExtractionPipeline from @xenova/transformers uses Tensor with incompatible DataArray union type
    private pipeline: any = null; // FeatureExtractionPipeline
    private initPromise: Promise<void> | null = null;
    private loadedModel: ModelSpec | null = null;
    private isReady = false;

    /** Optional: pin to a specific model, skipping the fallback chain. */
    private pinnedModelId: string | null;

    constructor(modelId?: string) {
        this.pinnedModelId = modelId ?? null;
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

        // If a specific model was pinned, try only that one
        if (this.pinnedModelId) {
            const spec = MODEL_PRIORITY.find(m => m.name === this.pinnedModelId)
                ?? { name: this.pinnedModelId, dim: 512, type: "general" as const };

            this.pipeline = await pipeline("feature-extraction", spec.name, {
                quantized: true,
            });
            this.loadedModel = spec;
            this.isReady = true;
            console.log(`[TokenGuard] Loaded embedding model: ${spec.name} (${spec.type})`);
            return;
        }

        // Try models in priority order
        for (const spec of MODEL_PRIORITY) {
            try {
                this.pipeline = await pipeline("feature-extraction", spec.name, {
                    quantized: true,
                });
                this.loadedModel = spec;
                this.isReady = true;
                console.log(`[TokenGuard] Loaded embedding model: ${spec.name} (${spec.type})`);
                return;
            } catch {
                console.log(`[TokenGuard] Model ${spec.name} not available, trying next...`);
            }
        }

        throw new Error(
            "[TokenGuard] No embedding model could be loaded. Tried: " +
            MODEL_PRIORITY.map(m => m.name).join(", ")
        );
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

    /** Get the dimensionality of the loaded (or default) embedding model. */
    getDimension(): number {
        if (this.loadedModel) return this.loadedModel.dim;
        // Before initialization, return dimension of the first priority model
        // (or the pinned model if set)
        if (this.pinnedModelId) {
            const spec = MODEL_PRIORITY.find(m => m.name === this.pinnedModelId);
            return spec?.dim ?? 512;
        }
        return MODEL_PRIORITY[0].dim;
    }

    /** Get the spec of the currently loaded model, or null if not yet loaded. */
    getLoadedModel(): ModelSpec | null {
        return this.loadedModel;
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
