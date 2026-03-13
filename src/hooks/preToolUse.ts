/**
 * hooks/preToolUse.ts — Pre-tool-use interceptor for TokenGuard.
 *
 * Detects when Claude is about to read large files directly and
 * suggests more efficient alternatives. This is a defensive guard
 * that prevents token waste from naive file reads.
 *
 * Intercepted patterns:
 * - Read Tool reading files > threshold
 * - Grep/glob operations that could use tg_navigate action:"search"
 * - Full file reads that should use tg_code action:"compress"
 */

import fs from "fs";
import path from "path";
import { Embedder } from "../embedder.js";
import { readSource } from "../utils/read-source.js";
import type { CompressionLevel } from "../compressor-advanced.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface InterceptResult {
    /** Whether the operation should be intercepted. */
    shouldIntercept: boolean;
    /** Suggested alternative action. */
    suggestion: string;
    /** Estimated tokens that would be wasted. */
    wastedTokens: number;
    /** Estimated tokens if using the suggested alternative. */
    optimizedTokens: number;
    /** Savings as a percentage. */
    savingsPercent: number;
    /** Pre-compressed content (if compressor is available). */
    compressedContent?: string;
    /** Compression level used. */
    compressionLevel?: CompressionLevel;
    /** Original token count. */
    originalTokens?: number;
    /** Compressed token count. */
    compressedTokens?: number;
}

export interface PreToolUseConfig {
    /** File size threshold in bytes to trigger interception. Default: 1024 */
    fileSizeThreshold?: number;
    /** Maximum tokens before suggesting compression. Default: 500 */
    tokenThreshold?: number;
    /** Whether to intercept grep/glob operations. Default: true */
    interceptGrep?: boolean;
    /** Whether to intercept file reads. Default: true */
    interceptRead?: boolean;
    /** Default compression level for interception. Default: "medium" */
    compressionLevel?: CompressionLevel;
}

// ─── Interceptor ─────────────────────────────────────────────────────

export class PreToolUseHook {
    private config: Required<PreToolUseConfig>;

    constructor(config: PreToolUseConfig = {}) {
        this.config = {
            fileSizeThreshold: config.fileSizeThreshold ?? 1024,
            tokenThreshold: config.tokenThreshold ?? 500,
            interceptGrep: config.interceptGrep ?? true,
            interceptRead: config.interceptRead ?? true,
            compressionLevel: config.compressionLevel ?? "medium",
        };
    }

    /**
     * Evaluate a file read operation and determine if it should be intercepted.
     *
     * Returns an InterceptResult with:
     * - Whether to intercept
     * - A suggestion message for the LLM
     * - Token savings estimate
     */
    evaluateFileRead(filePath: string, preloadedContent?: string): InterceptResult {
        if (!this.config.interceptRead) return this.passThrough();

        let stats: fs.Stats;
        try { stats = fs.statSync(filePath); } catch { return this.passThrough(); }
        if (stats.size <= this.config.fileSizeThreshold) return this.passThrough();

        const ext = path.extname(filePath).toLowerCase();
        const supported = [".ts", ".tsx", ".js", ".jsx", ".py", ".go"];
        if (!supported.includes(ext)) return this.passThrough();

        // Use preloaded content to avoid double I/O
        const content = preloadedContent ?? readSource(filePath);
        const fullTokens = Embedder.estimateTokens(content);

        const ratioByLevel: Record<string, number> = {
            light: 0.50, medium: 0.75, aggressive: 0.92,
        };
        const level = this.config.compressionLevel;
        const estimatedRatio = ratioByLevel[level] ?? 0.75;
        const compressedTokens = Math.round(fullTokens * (1 - estimatedRatio));

        if (fullTokens <= this.config.tokenThreshold) return this.passThrough();

        return {
            shouldIntercept: true,
            suggestion: [
                `⚡ **TokenGuard Advice**: You just read "${path.basename(filePath)}" raw (~${fullTokens.toLocaleString()} tokens).`,
                `→ Reading massive files raw burns your context window unnecessarily.`,
                `→ Next time, omit 'compress: false' (it defaults to true) or use \`tg_code action:"compress" path:"${filePath}" level:"${level}"\`.`,
                `→ You would have saved ~${(fullTokens - compressedTokens).toLocaleString()} tokens (${Math.round(estimatedRatio * 100)}% reduction) while keeping all structural context.`,
            ].join("\n"),
            wastedTokens: fullTokens,
            optimizedTokens: compressedTokens,
            savingsPercent: Math.round(estimatedRatio * 100),
            compressionLevel: level,
            originalTokens: fullTokens,
            compressedTokens,
        };
    }

    /** Generate a summary of all interception rules. */
    getRules(): string {
        return [
            "TokenGuard Pre-Tool-Use Rules:",
            `  • File read threshold: ${this.config.fileSizeThreshold} bytes`,
            `  • Token threshold: ${this.config.tokenThreshold} tokens`,
            `  • Grep interception: ${this.config.interceptGrep ? "enabled" : "disabled"}`,
            `  • Read interception: ${this.config.interceptRead ? "enabled" : "disabled"}`,
            `  • Compression level: ${this.config.compressionLevel}`,
        ].join("\n");
    }

    // ─── Helpers ──────────────────────────────────────────────────

    /** No interception needed — pass through. */
    private passThrough(): InterceptResult {
        return {
            shouldIntercept: false,
            suggestion: "",
            wastedTokens: 0,
            optimizedTokens: 0,
            savingsPercent: 0,
        };
    }

}
