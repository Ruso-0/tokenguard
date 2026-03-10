/**
 * schemas.ts — Zod validation schemas for all TokenGuard tool inputs.
 *
 * Validates and constrains all inputs before processing, preventing
 * crashes from hallucinated or malformed arguments from LLMs.
 */

import { z } from "zod";

// ─── Tool Input Schemas ──────────────────────────────────────────────

export const TgSearchInput = z.object({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(50).default(10),
    include_raw: z.boolean().default(false),
});

export const TgReadInput = z.object({
    file_path: z.string().min(1).max(1000),
    level: z.enum(["light", "medium", "aggressive"]).default("medium"),
});

export const TgCompressInput = z.object({
    file_path: z.string().min(1).max(1000),
    tier: z.number().int().min(1).max(3).default(1),
    compression_level: z.enum(["light", "medium", "aggressive"]).optional(),
    focus: z.string().max(500).optional(),
});

export const TgAuditInput = z.object({
    since: z.string().max(100).optional(),
});

export const TgStatusInput = z.object({});

export const TgSessionReportInput = z.object({});

export type TgSearchArgs = z.infer<typeof TgSearchInput>;
export type TgReadArgs = z.infer<typeof TgReadInput>;
export type TgCompressArgs = z.infer<typeof TgCompressInput>;
export type TgAuditArgs = z.infer<typeof TgAuditInput>;
