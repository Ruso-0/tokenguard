/**
 * compressor-foveal.ts — Hyper-Causal Topological Foveal Compression (TFC-Ultra)
 *
 * Architecture by Jherson Eddie Tintaya Holguin (Ruso-0).
 *
 * Asymmetric context sculpting for Frontier Models.
 * PROMPT CACHE INVERSION:
 * [Imports] -> [Dark Matter] -> [External] -> [Downstream] -> [Upstream] -> [FOVEA]
 *
 * CACHE PHYSICS:
 * Static sections (Imports, Dark Matter, External) MUST remain byte-identical.
 * All dynamic metadata (Foci names, line counts) are pushed to the VOLATILE
 * bottom section to preserve Anthropic's Prefix Cache.
 *
 * v8.6 (TFC-Ultra): O(1) parafoveal overhead
 *   - Upstream vectorial collapse: N callers → 1 plain name line
 *   - Downstream event horizon: top-10 + cleanSignature()
 *   - Density Shield 0.85: fail-safe fallback to legacy aggressive
 *
 * @license Proprietary — @ruso-0/nreki-turbo
 */

import path from "path";
import crypto from "crypto";
import { type ParsedChunk, type ParseResult, normalizeWebSymbol } from "./parser.js";
import { extractDependencies, cleanSignature } from "./utils/imports.js";
import { Embedder } from "./embedder.js";
import type { NrekiEngine } from "./engine.js";

// 🔥 TFC v2: TRUE LRU AST CACHE 🔥
// Prevents re-parsing Tree-sitter when content hasn't mutated.
// Map's insertion order + delete+set on hit = true LRU in O(1).
const tfcParseCache = new Map<string, { hash: string; result: ParseResult }>();
const MAX_CACHE_ENTRIES = 10;

export interface TfcResult {
    compressed: string;
    originalSize: number;
    compressedSize: number;
    ratio: number;
    tokensSaved: number;
    zones: {
        foveas: string[];
        localParafovea: number;
        externalParafovea: number;
        upstream: number;
        darkMatterLines: number;
    };
}

export type TfcResultPayload =
    | { kind: "success"; data: TfcResult }
    | { kind: "not_found" }
    | { kind: "shield_tripped"; ratio: number; originalSize: number; compressedSize: number };

const NOISE_WORDS = new Set([
    "if", "for", "while", "switch", "catch", "return", "throw", "new", "await",
    "function", "class", "typeof", "instanceof", "delete", "void", "yield",
    "import", "export", "from", "as", "console", "require", "module", "process",
    "true", "false", "null", "undefined", "any", "unknown", "never",
    "string", "number", "boolean", "Record", "Partial", "Omit", "Pick",
    "Math", "JSON", "Object", "Array", "String", "Number", "Promise",
    "Map", "Set", "Error", "setTimeout", "setInterval"
]);

function extractCausalRefs(code: string): Set<string> {
    const refs = new Set<string>();
    for (const m of code.matchAll(/\b([a-zA-Z_]\w*)\s*\(/g)) if (!NOISE_WORDS.has(m[1])) refs.add(m[1]);
    for (const m of code.matchAll(/\b([a-zA-Z_]\w*)\.[a-zA-Z_]\w*\s*\(/g)) if (!NOISE_WORDS.has(m[1])) refs.add(m[1]);
    for (const m of code.matchAll(/(?::\s*|<|extends\s+|implements\s+|as\s+)([A-Z][a-zA-Z0-9_]*)/g)) if (!NOISE_WORDS.has(m[1])) refs.add(m[1]);
    for (const m of code.matchAll(/this\.([a-zA-Z_]\w*)/g)) if (!NOISE_WORDS.has(m[1])) refs.add(m[1]);
    for (const m of code.matchAll(/\b([A-Z_][A-Z0-9_]{2,})\b/g)) if (!NOISE_WORDS.has(m[1])) refs.add(m[1]);
    return refs;
}

export async function tfcCompress(
    filePath: string,
    content: string,
    focusInput: string,
    engine: NrekiEngine
): Promise<TfcResultPayload> {
    const originalSize = content.length;

    // O(1) parse cache by content hash
    const contentHash = crypto.createHash("sha256").update(content).digest("hex");
    let parseResult: ParseResult;

    const cached = tfcParseCache.get(filePath);
    if (cached && cached.hash === contentHash) {
        // TRUE LRU: delete + re-set promotes entry to MRU position
        tfcParseCache.delete(filePath);
        tfcParseCache.set(filePath, cached);
        parseResult = cached.result;
    } else {
        const parser = engine.getParser();
        try {
            parseResult = await parser.parse(filePath, content);
            if (parseResult.chunks.length > 0) {
                // Evict oldest (first key by insertion order)
                if (tfcParseCache.size >= MAX_CACHE_ENTRIES) {
                    const oldestKey = tfcParseCache.keys().next().value;
                    if (oldestKey !== undefined) tfcParseCache.delete(oldestKey);
                }
                tfcParseCache.set(filePath, { hash: contentHash, result: parseResult });
            }
        } catch { return { kind: "not_found" }; }
    }

    if (parseResult.chunks.length === 0) return { kind: "not_found" };

    // 1. MULTI-FOCAL TARGETS + OVERLOAD FIX
    // v10.18.1: shared normalizeWebSymbol covers CSS+HTML+JSON uniformly.
    // Previous inline regex covered only CSS (despite isCss naming HTML too,
    // it ran identical CSS rules). JSON foci were never normalized.
    const ext = path.extname(filePath).toLowerCase();

    const foci = focusInput.split(",").map(s => {
        return normalizeWebSymbol(s.trim(), ext).toLowerCase();
    }).filter(Boolean);
    const foveas = new Set<ParsedChunk>();

    for (const focus of foci) {
        const matches = parseResult.chunks.filter(c =>
            c.symbolName.toLowerCase() === focus ||
            c.symbolName.toLowerCase().includes(focus)
        );
        for (const m of matches) foveas.add(m);
    }
    if (foveas.size === 0) return { kind: "not_found" };

    // 2. CAUSAL RAYTRACING
    const foveaUses = new Set<string>();
    const foveaNames = new Set<string>();

    for (const f of foveas) {
        foveaNames.add(f.symbolName);
        const refs = extractCausalRefs(f.rawCode + "\n" + f.shorthand);
        for (const r of refs) foveaUses.add(r);
    }

    // 🔥 TFC-Ultra: upstream collapses to Set<string> for O(1) overhead
    const upstreamNames = new Set<string>();
    const downstream = new Set<ParsedChunk>();
    let darkMatterLines = 0;

    for (const chunk of parseResult.chunks) {
        if (foveas.has(chunk)) continue;

        const chunkRefs = extractCausalRefs(chunk.rawCode);
        let isUpstream = false;
        for (const fname of foveaNames) {
            if (chunkRefs.has(fname)) {
                isUpstream = true;
                break;
            }
        }

        if (isUpstream) {
            upstreamNames.add(chunk.symbolName || "anonymous");
        } else if (foveaUses.has(chunk.symbolName)) {
            downstream.add(chunk);
        } else {
            // Dark matter: orthogonal logic. Only count lines, no Set needed.
            darkMatterLines += (chunk.endLine - chunk.startLine + 1);
        }
    }

    // 3. CAUSAL PAST (External Imports)
    const allImports = extractDependencies(content, ext);
    const usedImports = allImports.filter(imp => {
        const safeName = imp.localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`(^|[^a-zA-Z0-9_$])${safeName}(?=[^a-zA-Z0-9_$]|$)`);
        for (const f of foveas) {
            if (regex.test(f.rawCode)) return true;
        }
        return false;
    });

    let externalParafoveaText = "";
    let externalCount = 0;
    if (usedImports.length > 0) {
        const rawSignatures = engine.resolveImportSignatures(usedImports.slice(0, 15));
        if (rawSignatures.length > 0) {
            externalCount = rawSignatures.length;
            externalParafoveaText = rawSignatures
                .map(s => `  import ${path.basename(s.path)} -> \`${cleanSignature(s.raw)}\``)
                .join("\n");
            engine.incrementAutoContext();
        }
    }

    // 4. CAUSAL FUTURE (Blast Radius)
    const relPath = path.relative(engine.getProjectRoot(), filePath).replace(/\\/g, "/");
    const dependents = await engine.findDependents(relPath);
    let blastRadiusText = "";
    if (dependents.length > 0) {
        blastRadiusText = `// ⚠️ EXTERNAL BLAST RADIUS: ${dependents.length} file(s) import this module.\n` +
                          `// If you change signatures, use \`batch_edit\` to update:\n` +
                          `// -> ${dependents.slice(0, 3).join(", ")}${dependents.length > 3 ? '...' : ''}`;
    }

    // 5. TOPOLOGICAL INVERSION ASSEMBLY
    const parts: string[] = [];

    // === STATIC PREFIX (Anthropic Cache Safe) ===
    parts.push(`// [NREKI TFC-PRO] File: ${path.basename(filePath)}`);
    parts.push(`// TOPOLOGICAL LAYOUT: Imports -> Dark Matter -> Contracts -> Target\n`);

    const earliestStart = parseResult.chunks.reduce((min, c) => c.startIndex < min ? c.startIndex : min, Infinity);
    const preamble = content.substring(0, earliestStart).split("\n")
        .filter(l => /^(import|export|from|require|type|interface)/.test(l.trim()) || l.trim() === "")
        .join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (preamble) { parts.push(preamble); parts.push(""); }

    if (darkMatterLines > 0) {
        parts.push(`// ... [NREKI: Orthogonal logic omitted for TFC focus] ...\n`);
    }

    if (externalParafoveaText) {
        parts.push(`// ─── EXTERNAL PARAFOVEA (Resolved Imports) ───`);
        parts.push(externalParafoveaText);
        parts.push("");
    }

    if (blastRadiusText) {
        parts.push(blastRadiusText);
        parts.push("");
    }

    // 🔥 O(1) UPSTREAM VECTORIAL COLLAPSE 🔥
    // N callers → 1 line of plain names. Agent sees blast radius without
    // reading signatures. If details needed, agent can outline them separately.
    if (upstreamNames.size > 0) {
        const names = Array.from(upstreamNames).sort();
        parts.push(`// ─── UPSTREAM (Callers) ───`);
        const shown = names.slice(0, 10).join(", ");
        const extra = names.length > 10 ? ` (+${names.length - 10} more)` : "";
        parts.push(`// ${shown}${extra} → calls target\n`);
    }

    // 🔥 O(1) DOWNSTREAM EVENT HORIZON 🔥
    // Top 10 local deps, cleanSignature strips JSDocs and whitespace waste.
    if (downstream.size > 0) {
        parts.push(`// ─── DOWNSTREAM (Local dependencies) ───`);
        const sortedDownstream = Array.from(downstream).sort((a, b) => a.startIndex - b.startIndex);
        const topDownstream = sortedDownstream.slice(0, 10);
        for (const c of topDownstream) parts.push(cleanSignature(c.shorthand));
        if (downstream.size > 10) parts.push(`// ... and ${downstream.size - 10} more omitted`);
        parts.push("");
    }

    // === VOLATILE ZONE (Dynamic - changes with focus) ===
    parts.push(`// ─── TFC METADATA ───`);
    const foveaNamesList = Array.from(foveaNames).join(", ");
    parts.push(`// Foci: [${foveaNamesList}] | Omitted: ${darkMatterLines}L\n`);

    parts.push(`// ─── FOVEA (100% Resolution - Edit Target) ───`);
    const sortedFoveas = Array.from(foveas).sort((a, b) => a.startIndex - b.startIndex);
    for (const f of sortedFoveas) {
        parts.push(`/* L${f.startLine}-L${f.endLine} */`);
        parts.push(f.rawCode);
        parts.push("");
    }

    const compressed = parts.join("\n").trim();
    const compressedSize = compressed.length;

    // 🔥 DENSITY SHIELD 0.85 (stricter — require ≥15% real compression) 🔥
    // v8.6: raised the bar from 0.95 to 0.85. If TFC-Ultra can't beat 15%
    // against the raw file, fall through to legacy aggressive (which averages
    // ~85% reduction). Mathematical guarantee: TFC never loses to baseline.
    //
    // Patterns this catches:
    //  - God Class focus (fovea = entire file, metadata overhead wins)
    //  - Marginal compression cases where the agent's choice of focus is
    //    barely useful (better to give them the full aggressive summary)
    if (compressedSize >= originalSize * 0.85) {
        return {
            kind: "shield_tripped",
            ratio: 1 - (compressedSize / originalSize),
            originalSize,
            compressedSize
        };
    }

    const tokensSaved = Math.max(0, Embedder.estimateTokens(content) - Embedder.estimateTokens(compressed));

    return {
        kind: "success",
        data: {
            compressed, originalSize, compressedSize,
            ratio: 1 - (compressedSize / originalSize),
            tokensSaved,
            zones: {
                foveas: Array.from(foveaNames),
                localParafovea: downstream.size,
                externalParafovea: externalCount,
                upstream: upstreamNames.size,
                darkMatterLines
            }
        }
    };
}
