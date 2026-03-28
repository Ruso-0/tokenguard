/**
 * compressor-advanced.ts - LLMLingua-2-inspired token-level compression.
 *
 * Three-stage pipeline:
 *   Stage 1: Preprocessing (strip comments, console.log, whitespace)
 *   Stage 2: Self-information token filtering (remove predictable tokens)
 *   Stage 3: Structural compression (strip function bodies via AST)
 *
 * Three compression levels:
 *   - light:      Stage 1 only (~50% reduction)
 *   - medium:     Stage 1 + 2 + key body lines (~75%)
 *   - aggressive: Stage 1 + 2 + 3 body stripping (~90-95%)
 *
 * Pure TypeScript - zero native dependencies, zero Python.
 */

import { ASTParser } from "./parser.js";
import { Embedder } from "./embedder.js";

// ─── Types ───────────────────────────────────────────────────────────

export type CompressionLevel = "light" | "medium" | "aggressive";

export interface AdvancedCompressionResult {
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
    /** Compression level used. */
    level: CompressionLevel;
    /** Per-stage breakdown of chars removed. */
    breakdown: {
        preprocessingReduction: number;
        tokenFilterReduction: number;
        structuralReduction: number;
    };
}

// ─── Language Detection ──────────────────────────────────────────────

type Lang = "typescript" | "javascript" | "python" | "go" | "unknown";

function detectLang(filePath: string): Lang {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "ts" || ext === "tsx") return "typescript";
    if (ext === "js" || ext === "jsx") return "javascript";
    if (ext === "py") return "python";
    if (ext === "go") return "go";
    return "unknown";
}

// ─── Stage 1: Preprocessing ─────────────────────────────────────────

/**
 * Strip function call statements (console.log, print, etc.) that may span multiple lines.
 * Uses balanced paren tracking to handle multi-line calls with nested parens.
 */
function stripCallStatements(text: string, pattern: RegExp): string {
    // Find all match start positions
    const toRemove: Array<{ start: number; end: number }> = [];
    let m: RegExpExecArray | null;

    while ((m = pattern.exec(text)) !== null) {
        const matchStart = m.index;
        // Find the start of the line
        let lineStart = matchStart;
        while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--;

        // Start tracking parens from the opening `(` which is at the end of the regex match
        let depth = 1;
        let pos = m.index + m[0].length;

        while (pos < text.length && depth > 0) {
            const ch = text[pos];
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
            // Skip string contents
            else if (ch === '"' || ch === "'" || ch === "`") {
                const quote = ch;
                pos++;
                while (pos < text.length) {
                    if (text[pos] === "\\") { pos++; } // skip escaped char
                    else if (text[pos] === quote) break;
                    pos++;
                }
            }
            pos++;
        }

        if (depth === 0) {
            // Skip optional semicolon and trailing whitespace
            let end = pos;
            while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
            if (end < text.length && text[end] === ";") end++;
            while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
            if (end < text.length && text[end] === "\n") end++;
            toRemove.push({ start: lineStart, end });
            pattern.lastIndex = end;
        }
    }

    // Remove in reverse to preserve indices
    let result = text;
    for (let i = toRemove.length - 1; i >= 0; i--) {
        result = result.slice(0, toRemove[i].start) + result.slice(toRemove[i].end);
    }
    return result;
}

/**
 * Strip comments, console statements, debugger, normalize whitespace.
 * Returns cleaned text and number of characters removed.
 */
function preprocess(content: string, filePath: string): { cleaned: string; removed: number } {
    const lang = detectLang(filePath);
    let text = content;

    // Strip multi-line comments (/* ... */ and /** ... */)
    if (lang !== "python") {
        text = text.replace(/\/\*[\s\S]*?\*\//g, "");
    }

    // Strip single-line comments
    if (lang === "python") {
        // Python: strip triple-quoted strings/docstrings FIRST (before # comments)
        text = text.replace(/"""[\s\S]*?"""/g, '""');
        text = text.replace(/'''[\s\S]*?'''/g, "''");

        // Protect shebang
        text = text.replace(/^(#!.*)$/m, "___SHEBANG___$1");

        // Protect remaining string literals from # stripping
        const pyStrings: string[] = [];
        text = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (m) => {
            pyStrings.push(m);
            return `__NREKI_STR${pyStrings.length - 1}__`;
        });

        // Now safe to strip # comments
        text = text.replace(/#[^\n]*/gm, "");

        // Restore strings and shebang
        text = text.replace(/__NREKI_STR(\d+)__/g, (_, i) => pyStrings[parseInt(i)]);
        text = text.replace(/___SHEBANG___/g, "");
    } else {
        // JS/TS/Go: // comments
        text = text.replace(/\/\/[^\n]*/g, "");
    }

    // Strip console.log/warn/error/debug/info (handles multi-line with balanced parens)
    text = stripCallStatements(text, /^\s*console\.(log|warn|error|debug|info|assert|trace|dir|table|time|timeEnd|group|groupEnd)\s*\(/gm);

    // Strip Python print() statements (multi-line safe)
    if (lang === "python") {
        text = stripCallStatements(text, /^\s*print\s*\(/gm);
    }

    // Strip debugger statements
    text = text.replace(/\bdebugger\s*;?/g, "");

    // Collapse consecutive empty lines to single blank line
    text = text.replace(/\n{3,}/g, "\n\n");

    // Remove trailing whitespace per line
    text = text.replace(/[ \t]+$/gm, "");

    // Remove leading blank lines
    text = text.replace(/^\n+/, "");

    // Remove trailing blank lines
    text = text.replace(/\n+$/, "\n");

    const removed = content.length - text.length;
    return { cleaned: text, removed: Math.max(0, removed) };
}

// ─── Stage 2: Self-Information Token Filtering ──────────────────────

/**
 * Unigram frequency table - ~300 most common English + code tokens.
 * Tokens NOT in this table default to probability 0.0001 (rare = keep).
 */
const UNIGRAM_FREQ = new Map<string, number>([
    // English function words & articles
    ["the", 0.072], ["be", 0.042], ["to", 0.033], ["of", 0.032],
    ["and", 0.030], ["a", 0.024], ["in", 0.021], ["that", 0.016],
    ["have", 0.013], ["i", 0.012], ["it", 0.011], ["for", 0.011],
    ["not", 0.010], ["on", 0.009], ["with", 0.009], ["he", 0.008],
    ["as", 0.008], ["you", 0.008], ["do", 0.007], ["at", 0.007],
    ["this", 0.006], ["but", 0.006], ["his", 0.005], ["by", 0.005],
    ["from", 0.005], ["they", 0.005], ["we", 0.004], ["say", 0.004],
    ["her", 0.004], ["she", 0.004], ["or", 0.004], ["an", 0.004],
    ["will", 0.004], ["my", 0.003], ["one", 0.003], ["all", 0.003],
    ["would", 0.003], ["there", 0.003], ["their", 0.003], ["what", 0.002],
    ["so", 0.002], ["up", 0.002], ["out", 0.002], ["if", 0.004],
    ["about", 0.002], ["who", 0.002], ["get", 0.002], ["which", 0.002],
    ["go", 0.002], ["me", 0.002], ["when", 0.002], ["make", 0.002],
    ["can", 0.002], ["like", 0.002], ["time", 0.002], ["no", 0.002],
    ["just", 0.002], ["him", 0.002], ["know", 0.002], ["take", 0.002],
    ["people", 0.001], ["into", 0.001], ["year", 0.001], ["your", 0.001],
    ["good", 0.001], ["some", 0.001], ["could", 0.001], ["them", 0.001],
    ["see", 0.001], ["other", 0.001], ["than", 0.001], ["then", 0.001],
    ["now", 0.001], ["look", 0.001], ["only", 0.001], ["come", 0.001],
    ["its", 0.001], ["over", 0.001], ["think", 0.001], ["also", 0.001],
    ["back", 0.001], ["after", 0.001], ["use", 0.001], ["two", 0.001],
    ["how", 0.001], ["our", 0.001], ["work", 0.001], ["first", 0.001],
    ["well", 0.001], ["way", 0.001], ["even", 0.001], ["new", 0.001],
    ["want", 0.001], ["because", 0.001], ["any", 0.001], ["these", 0.001],
    ["give", 0.001], ["day", 0.001], ["most", 0.001], ["us", 0.001],
    ["is", 0.009], ["are", 0.005], ["was", 0.005], ["were", 0.003],
    ["been", 0.002], ["being", 0.001], ["has", 0.003], ["had", 0.003],
    ["does", 0.002], ["did", 0.002], ["should", 0.002], ["may", 0.001],
    ["might", 0.001], ["shall", 0.001], ["must", 0.001],
    ["very", 0.002], ["much", 0.001], ["more", 0.002], ["each", 0.001],
    ["such", 0.001], ["here", 0.001], ["those", 0.001],
    ["through", 0.001], ["during", 0.001], ["before", 0.001],
    ["between", 0.001], ["under", 0.001], ["above", 0.001],
    ["below", 0.001], ["while", 0.001], ["where", 0.001],

    // Common code tokens (high freq = predictable = removable)
    ["const", 0.005], ["let", 0.004], ["var", 0.003],
    ["function", 0.004], ["return", 0.004], ["else", 0.003],
    ["true", 0.003], ["false", 0.003], ["null", 0.003], ["undefined", 0.002],
    ["string", 0.003], ["number", 0.003], ["boolean", 0.002],
    ["void", 0.002], ["any", 0.002], ["object", 0.002],
    ["class", 0.002], ["extends", 0.001], ["implements", 0.001],
    ["interface", 0.002], ["type", 0.002], ["enum", 0.001],
    ["import", 0.003], ["export", 0.003], ["default", 0.002],
    ["async", 0.002], ["await", 0.002], ["promise", 0.002],
    ["try", 0.001], ["catch", 0.001], ["finally", 0.001],
    ["throw", 0.001], ["throws", 0.001],
    ["public", 0.002], ["private", 0.002], ["protected", 0.001],
    ["static", 0.001], ["readonly", 0.001], ["abstract", 0.001],
    ["super", 0.001], ["constructor", 0.001],
    ["switch", 0.001], ["case", 0.001], ["break", 0.001],
    ["continue", 0.001], ["delete", 0.001], ["typeof", 0.001],
    ["instanceof", 0.001], ["yield", 0.001],
    ["param", 0.002], ["returns", 0.002], ["throws", 0.001],

    // Very common filler in code comments / prose
    ["todo", 0.002], ["fixme", 0.001], ["hack", 0.001], ["note", 0.001],
    ["see", 0.001], ["e.g", 0.001], ["i.e", 0.001], ["etc", 0.001],
    ["following", 0.001], ["example", 0.001], ["used", 0.001],
    ["using", 0.001], ["based", 0.001], ["given", 0.001],
    ["provided", 0.001], ["specified", 0.001], ["defined", 0.001],
    ["called", 0.001], ["currently", 0.001], ["already", 0.001],
    ["whether", 0.001], ["however", 0.001], ["therefore", 0.001],
    ["otherwise", 0.001], ["basically", 0.001], ["actually", 0.001],
    ["simply", 0.001], ["really", 0.001], ["just", 0.002],
    ["always", 0.001], ["never", 0.001], ["sometimes", 0.001],
    ["usually", 0.001], ["often", 0.001], ["typically", 0.001],
    ["generally", 0.001], ["probably", 0.001], ["perhaps", 0.001],
    ["maybe", 0.001], ["likely", 0.001], ["possible", 0.001],
    ["necessary", 0.001], ["important", 0.001], ["required", 0.001],
    ["optional", 0.001], ["available", 0.001], ["specific", 0.001],
    ["particular", 0.001], ["different", 0.001], ["similar", 0.001],
    ["same", 0.001], ["various", 0.001], ["several", 0.001],
    ["multiple", 0.001], ["additional", 0.001], ["corresponding", 0.001],
    ["appropriate", 0.001], ["relevant", 0.001], ["respective", 0.001],

    // Python-specific common tokens
    ["def", 0.004], ["self", 0.005], ["none", 0.003],
    ["elif", 0.001], ["except", 0.001], ["raise", 0.001],
    ["pass", 0.001], ["lambda", 0.001], ["with", 0.002],
    ["print", 0.002], ["len", 0.001], ["range", 0.001],

    // Go-specific
    ["func", 0.004], ["fmt", 0.002], ["err", 0.002],
    ["nil", 0.003], ["struct", 0.002], ["defer", 0.001],
    ["chan", 0.001], ["goroutine", 0.001], ["package", 0.002],
    ["main", 0.002],
]);

/** Tokens that are NEVER removed regardless of score. */
const PROTECTED_PATTERNS = /^[{}()\[\];:,=<>!&|+\-*/%^~?@#]$|^=>$|^\.\.\.$/;

/** Keywords whose following token must also be protected. */
const KEYWORD_PROTECTORS = new Set([
    "function", "class", "interface", "type", "import", "export",
    "return", "throw", "await", "const", "let", "var", "new",
    "extends", "implements", "from", "as", "enum", "def", "func",
    "struct", "package", "async", "yield",
]);

interface ScoredToken {
    token: string;
    score: number;
    protected: boolean;
    lineBreak: boolean; // true if this token is a newline
}

/**
 * Score each token by self-information + TF-IDF.
 * Higher score = more important = keep.
 */
function scoreTokens(text: string, alpha: number): ScoredToken[] {
    // Split into tokens preserving line structure
    const lines = text.split("\n");
    const allTokens: ScoredToken[] = [];

    // Build document TF
    const tf = new Map<string, number>();
    const allWords: string[] = [];
    for (const line of lines) {
        const words = line.split(/\s+/).filter(w => w.length > 0);
        for (const w of words) {
            const lower = w.toLowerCase();
            allWords.push(lower);
            tf.set(lower, (tf.get(lower) || 0) + 1);
        }
    }
    const totalWords = allWords.length;
    if (totalWords === 0) return [];

    // Compute max TF for normalization
    let maxTf = 1;
    for (const count of tf.values()) {
        if (count > maxTf) maxTf = count;
    }

    // Unique terms count for IDF approximation (within-document IDF)
    const uniqueTerms = tf.size;

    let prevToken = "";
    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const words = line.split(/(\s+)/).filter(w => w.length > 0);

        for (const raw of words) {
            // AUDIT FIX: Preserve whitespace as protected tokens (critical for Python)
            if (/^\s+$/.test(raw)) {
                allTokens.push({ token: raw, score: Infinity, protected: true, lineBreak: false });
                continue;
            }

            const lower = raw.toLowerCase();

            // Self-information: -log2(P(token))
            const prob = UNIGRAM_FREQ.get(lower) ?? 0.0001;
            const selfInfo = -Math.log2(prob);

            // TF-IDF (within-document approximation)
            const termFreq = (tf.get(lower) || 1) / maxTf;
            // IDF approximation: rare in this doc = high IDF
            const docFreq = tf.get(lower) || 1;
            const idf = Math.log2(1 + uniqueTerms / docFreq);
            const tfidf = termFreq * idf;

            // Combined importance
            const score = alpha * selfInfo + (1 - alpha) * tfidf;

            // Protection rules
            const isProtected =
                PROTECTED_PATTERNS.test(raw) ||               // operators, braces
                /^\d+(\.\d+)?$/.test(raw) ||                  // numbers
                /^[A-Z]/.test(raw) ||                          // PascalCase identifiers
                raw.includes(".") ||                           // property access
                raw.includes("(") || raw.includes(")") ||     // fn calls
                KEYWORD_PROTECTORS.has(prevToken.toLowerCase()) || // follows keyword
                KEYWORD_PROTECTORS.has(lower);                 // is a keyword

            allTokens.push({ token: raw, score, protected: isProtected, lineBreak: false });
            prevToken = raw;
        }

        // Add line break marker (except after last line)
        if (li < lines.length - 1) {
            allTokens.push({ token: "\n", score: Infinity, protected: true, lineBreak: true });
        }
    }

    return allTokens;
}

/**
 * Filter tokens below the threshold percentile.
 * Removal percentiles: light=10%, medium=30%, aggressive=50%.
 */
function filterTokens(scored: ScoredToken[], level: CompressionLevel): string {
    const removePct = level === "light" ? 0.10 : level === "medium" ? 0.30 : 0.50;

    // Compute threshold from non-protected, non-linebreak tokens
    const removable = scored.filter(t => !t.protected && !t.lineBreak);
    if (removable.length === 0) {
        let out = "";
        for (let i = 0; i < scored.length; i++) {
            const tok = scored[i].token;
            if (scored[i].lineBreak) { out += "\n"; }
            else {
                if (i > 0 && !scored[i - 1].lineBreak) out += " ";
                out += tok;
            }
        }
        return out;
    }

    const sorted = [...removable].sort((a, b) => a.score - b.score);
    const cutoffIdx = Math.floor(sorted.length * removePct);
    const threshold = cutoffIdx < sorted.length ? sorted[cutoffIdx].score : -Infinity;

    // Rebuild text keeping tokens above threshold (or protected)
    const kept: string[] = [];
    for (const t of scored) {
        if (t.lineBreak) {
            kept.push("\n");
        } else if (t.protected || t.score >= threshold) {
            kept.push(t.token);
        }
    }

    // Reconstruct: no extra spaces around preserved whitespace tokens
    let result = "";
    for (let i = 0; i < kept.length; i++) {
        if (i > 0 && !/^\s+$/.test(kept[i]) && !/^\s+$/.test(kept[i - 1]) && kept[i] !== "\n" && kept[i - 1] !== "\n") {
            result += " ";
        }
        result += kept[i];
    }
    result = result.replace(/ \n /g, "\n");
    result = result.replace(/ \n/g, "\n");
    result = result.replace(/\n /g, "\n");
    result = result.replace(/  +/g, " ");
    result = result.replace(/\n{3,}/g, "\n\n");

    return result.trim();
}

// ─── Stage 3: Structural Compression ────────────────────────────────

/**
 * Extract key references from function body code.
 * Identifies imports, function calls, and important variables.
 */
function extractKeyReferences(code: string): string[] {
    const refs = new Set<string>();

    // Find function/method calls: word(
    const callMatches = code.matchAll(/\b([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)\s*\(/g);
    for (const m of callMatches) {
        const name = m[1];
        // Skip common keywords
        if (!["if", "for", "while", "switch", "catch", "return", "throw", "new", "await", "function", "class"].includes(name)) {
            refs.add(name);
        }
    }

    // Find imports: from "..."
    const importMatches = code.matchAll(/from\s+["']([^"']+)["']/g);
    for (const m of importMatches) {
        refs.add(m[1]);
    }

    // Limit to 5 most useful refs
    return Array.from(refs).slice(0, 5);
}

/**
 * For code files, strip function bodies using AST.
 * - aggressive: replace bodies with /* TG compressed *​/
 * - medium: keep only key body lines (return, throw, await, assignments)
 */
async function structuralCompress(
    text: string,
    filePath: string,
    parser: ASTParser,
    level: CompressionLevel,
    originalContent: string
): Promise<string> {
    const lang = detectLang(filePath);
    if (lang === "unknown") return text;

    // Parse the ORIGINAL content to get accurate AST positions
    let parseResult;
    try {
        parseResult = await parser.parse(filePath, originalContent);
    } catch {
        return text; // If parsing fails, return text as-is
    }

    if (parseResult.chunks.length === 0) return text;

    // For aggressive: rebuild from AST chunks (signatures + imports)
    if (level === "aggressive") {
        // STRATEGY: Splice approach. Start from the ORIGINAL content and
        // replace function/method BODIES with compact stubs, preserving all
        // module-level code (app.use(), Router(), dotenv.config(), etc.).
        // Previous approach rebuilt from chunks, silently deleting everything
        // between functions.

        // Sort chunks by startIndex descending (bottom-up) to preserve byte offsets
        const sortedChunks = [...parseResult.chunks].sort(
            (a, b) => b.startIndex - a.startIndex
        );

        let result = originalContent;

        for (const chunk of sortedChunks) {
            const bodyLineCount = chunk.rawCode.split("\n").length;
            const refs = extractKeyReferences(chunk.rawCode);
            const refsStr = refs.length > 0 ? ` refs:${refs.join(",")}` : "";
            const compactStub = `/*[nreki:${bodyLineCount}L${refsStr}]*/`;

            // Conservation law: replacement must be strictly smaller than original
            const replacement = `${chunk.shorthand}\n${compactStub}`;
            if (replacement.length < chunk.rawCode.length) {
                result = result.substring(0, chunk.startIndex) +
                         replacement +
                         result.substring(chunk.endIndex);
            }
            // If stub would bloat, leave the original code untouched
        }

        return `// [NREKI] ${filePath} | aggressive | ${parseResult.chunks.length} chunks\n${result}`;
    }

    // For medium: keep signatures + key body lines
    if (level === "medium") {
        const parts: string[] = [];
        const lines = originalContent.split("\n");

        parts.push(`// [NREKI] ${filePath} | medium | ${parseResult.chunks.length} chunks`);

        // Keep imports
        const firstChunkLine = Math.min(...parseResult.chunks.map(c => c.startLine));
        for (let i = 0; i < Math.min(firstChunkLine - 1, lines.length); i++) {
            const trimmed = lines[i].trim();
            if (
                trimmed.startsWith("import") ||
                trimmed.startsWith("export") ||
                trimmed.startsWith("type ") ||
                trimmed.startsWith("interface ") ||
                trimmed.startsWith("from ") ||
                trimmed.startsWith("package ") ||
                trimmed.startsWith("require")
            ) {
                parts.push(lines[i]);
            }
        }

        for (const chunk of parseResult.chunks) {
            // Signature
            parts.push(chunk.shorthand);

            // Key body lines
            const bodyLines = chunk.rawCode.split("\n");
            const keyLines = bodyLines.filter(line => {
                const trimmed = line.trim();
                return (
                    trimmed.startsWith("return ") ||
                    trimmed.startsWith("throw ") ||
                    trimmed.startsWith("await ") ||
                    trimmed.startsWith("yield ") ||
                    trimmed.includes("= new ") ||
                    trimmed.startsWith("if (") ||
                    trimmed.startsWith("for (") ||
                    trimmed.startsWith("while (") ||
                    trimmed.includes("this.") ||
                    (trimmed.startsWith("const ") && trimmed.includes("="))
                );
            });

            if (keyLines.length > 0) {
                parts.push("  // Key lines:");
                for (const kl of keyLines.slice(0, 5)) {
                    parts.push(`  ${kl.trim()}`);
                }
            }
        }

        return parts.join("\n");
    }

    return text;
}

// ─── AdvancedCompressor Class ────────────────────────────────────────

export class AdvancedCompressor {
    private parser: ASTParser;

    constructor(parser: ASTParser, _embedder: Embedder) {
        this.parser = parser;
    }

    /**
     * Compress content through the 3-stage LLMLingua-2-inspired pipeline.
     */
    async compress(
        filePath: string,
        content: string,
        level: CompressionLevel = "medium"
    ): Promise<AdvancedCompressionResult> {
        const originalSize = content.length;

        // ─── Stage 1: Preprocessing ──────────────────────────
        const { cleaned, removed: preprocessingReduction } = preprocess(content, filePath);
        const afterPreprocess = cleaned;

        // ─── Stage 2: Token Filtering ────────────────────────
        let afterFilter = afterPreprocess;
        let tokenFilterReduction = 0;

        if (level === "medium" || level === "aggressive") {
            const alpha = level === "medium" ? 0.5 : 0.7;
            const scored = scoreTokens(afterPreprocess, alpha);
            afterFilter = filterTokens(scored, level);
            tokenFilterReduction = Math.max(0, afterPreprocess.length - afterFilter.length);
        }

        // ─── Stage 3: Structural Compression ─────────────────
        let afterStructural = afterFilter;
        let structuralReduction = 0;

        if (level === "medium" || level === "aggressive") {
            try {
                const structResult = await structuralCompress(
                    afterFilter,
                    filePath,
                    this.parser,
                    level,
                    content // pass original for AST parsing
                );
                // Guard: only use structural result if it's actually smaller
                if (structResult.length < afterFilter.length) {
                    afterStructural = structResult;
                    structuralReduction = afterFilter.length - structResult.length;
                }
                // Otherwise keep afterFilter (structuralReduction stays 0)
            } catch {
                // If structural compression fails, use the filtered version
                afterStructural = afterFilter;
            }
        }

        const compressed = afterStructural;
        const compressedSize = compressed.length;
        const ratio = originalSize > 0 ? 1 - compressedSize / originalSize : 0;
        const tokensSaved = Embedder.estimateTokens(content) - Embedder.estimateTokens(compressed);

        return {
            compressed,
            originalSize,
            compressedSize,
            ratio: Math.max(0, ratio),
            tokensSaved: Math.max(0, tokensSaved),
            level,
            breakdown: {
                preprocessingReduction,
                tokenFilterReduction,
                structuralReduction,
            },
        };
    }

    /**
     * Quick estimate of advanced compression savings.
     */
    static estimateSavings(
        fileContent: string,
        level: CompressionLevel = "medium"
    ): { estimatedRatio: number; estimatedTokensSaved: number } {
        const tokens = Embedder.estimateTokens(fileContent);
        const ratioByLevel: Record<CompressionLevel, number> = {
            light: 0.50,
            medium: 0.75,
            aggressive: 0.92,
        };
        const ratio = ratioByLevel[level];
        return {
            estimatedRatio: ratio,
            estimatedTokensSaved: Math.round(tokens * ratio),
        };
    }
}

// Re-export for convenience
export { preprocess, scoreTokens, filterTokens };

// ─── Legacy Compressor (Tier-based, backward compat) ──────────────────

export type CompressionTier = 1 | 2 | 3;

export interface CompressionResult {
    compressed: string;
    originalSize: number;
    compressedSize: number;
    ratio: number;
    tokensSaved: number;
    tier: CompressionTier;
    chunksFound: number;
}

interface CompressorOptions {
    tier?: CompressionTier;
    maxBodyLines?: number;
    includeHeader?: boolean;
    focusQuery?: string;
}

/**
 * Legacy tier-based compressor. Kept for backward compatibility.
 * New code should use AdvancedCompressor (3-stage pipeline).
 */
export class Compressor {
    private parser: ASTParser;
    private embedder: Embedder;

    constructor(parser: ASTParser, embedder: Embedder) {
        this.parser = parser;
        this.embedder = embedder;
    }

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
            return {
                compressed: `// [NREKI] No parseable AST nodes found\n${content}`,
                originalSize: content.length,
                compressedSize: content.length,
                ratio: 0,
                tokensSaved: 0,
                tier,
                chunksFound: 0,
            };
        }

        const parts: string[] = [];
        parts.push(
            `// [NREKI] Compressed: ${filePath} | Tier ${tier} | ${parseResult.chunks.length} chunks`
        );

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

        let rankedChunks = parseResult.chunks;
        if (focusQuery) {
            rankedChunks = await this.rankByRelevance(
                parseResult.chunks,
                focusQuery
            );
        }

        for (const chunk of rankedChunks) {
            const compressed = this.compressChunk(chunk, tier, maxBodyLines);
            parts.push(compressed);
        }

        const compressed = parts.join("\n\n");
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

    private compressChunk(
        chunk: import("./parser.js").ParsedChunk,
        tier: CompressionTier,
        maxBodyLines: number
    ): string {
        if (tier === 1) return chunk.shorthand;
        if (tier === 2) return this.compressTier2(chunk, maxBodyLines);
        if (tier === 3) return this.compressTier3(chunk, maxBodyLines);
        return chunk.shorthand;
    }

    private compressTier2(chunk: import("./parser.js").ParsedChunk, maxBodyLines: number): string {
        const lines = chunk.rawCode.split("\n");
        if (lines.length <= maxBodyLines + 2) {
            return `[${chunk.nodeType}] ${chunk.rawCode.trim()}`;
        }
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
        return body ? `${signature}\n  // Key lines:\n    ${body}` : signature;
    }

    private compressTier3(chunk: import("./parser.js").ParsedChunk, maxBodyLines: number): string {
        const lines = chunk.rawCode.split("\n");
        const docLines: string[] = [];
        let inDoc = false;
        let pastHeader = false;
        for (const line of lines) {
            const trimmed = line.trim();
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
                continue;
            }
            if (!pastHeader && (trimmed.startsWith("//") || trimmed.startsWith("#"))) {
                docLines.push(line);
                continue;
            }
            if (trimmed.length > 0) {
                pastHeader = true;
            }
        }
        const tier2 = this.compressTier2(chunk, maxBodyLines);
        if (docLines.length > 0) {
            return `${docLines.join("\n")}\n${tier2}`;
        }
        return tier2;
    }

    private async rankByRelevance(
        chunks: import("./parser.js").ParsedChunk[],
        query: string
    ): Promise<import("./parser.js").ParsedChunk[]> {
        const { embedding: queryEmbedding } = await this.embedder.embed(query);
        const scored: Array<{ chunk: import("./parser.js").ParsedChunk; score: number }> = [];
        for (const chunk of chunks) {
            const { embedding } = await this.embedder.embed(chunk.shorthand);
            const score = this.cosineSimilarity(queryEmbedding, embedding);
            scored.push({ chunk, score });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.map((s) => s.chunk);
    }

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

    static estimateSavings(
        fileContent: string,
        tier: CompressionTier = 1
    ): { estimatedRatio: number; estimatedTokensSaved: number } {
        const tokens = Embedder.estimateTokens(fileContent);
        const ratioByTier: Record<CompressionTier, number> = { 1: 0.75, 2: 0.5, 3: 0.3 };
        const ratio = ratioByTier[tier];
        return {
            estimatedRatio: ratio,
            estimatedTokensSaved: Math.round(tokens * ratio),
        };
    }
}
