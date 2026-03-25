/**
 * repo-map.ts - Static repository map for Anthropic prompt cache optimization.
 *
 * Generates a deterministic text representation of all file signatures,
 * exports, and imports. Same repo state produces identical text output,
 * enabling Anthropic's prompt caching ($0.30/M vs $3.00/M input tokens).
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { ASTParser } from "./parser.js";
import { shouldProcess } from "./utils/file-filter.js";
import { readSource } from "./utils/read-source.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface RepoMapEntry {
    filePath: string;
    exports: string[];
    signatures: string[];
    imports: string[];
    lineCount: number;
}

export interface RepoMap {
    version: string;
    generatedAt: string;
    totalFiles: number;
    totalLines: number;
    entries: RepoMapEntry[];
    graph?: DependencyGraph;
}

/** Cache format version. Bump when CachedRepoMap structure changes. */
const CACHE_FORMAT_VERSION = 1;

export interface CachedRepoMap {
    formatVersion?: number;
    digest: string;
    map: RepoMap;
    text: string;
    graph?: DependencyGraphData;
}

export interface DependencyGraph {
    /** Files that import this file (reverse edges). */
    importedBy: Map<string, Set<string>>;
    /** Number of files importing each file. */
    inDegree: Map<string, number>;
    /** Tier classification by in-degree percentile. */
    tiers: Map<string, "core" | "logic" | "leaf">;
}

/** JSON-serializable form of DependencyGraph for caching. */
interface DependencyGraphData {
    importedBy: Record<string, string[]>;
    inDegree: Record<string, number>;
    tiers: Record<string, "core" | "logic" | "leaf">;
}

// ─── Constants ──────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go"]);

const IGNORE_DIRS = new Set([
    "node_modules", "dist", "build", ".git", "coverage",
    ".next", "__pycache__", ".nreki",
]);

const STRIP_KEYWORD = /^(?:export|default|declare|abstract|public|private|protected|static|readonly|async|function|class|interface|type|enum|const|let|var|def|func)\s+/;

/** Byte-identical comparator - same result on every OS (no ICU dependency). */
const stableCompare = (a: string, b: string): number =>
    a < b ? -1 : a > b ? 1 : 0;

// ─── Extraction Helpers ─────────────────────────────────────────────

/** Extract signature from raw AST code (everything before opening `{` or `:` for Python). */
export function extractSignature(rawCode: string): string {
    const lines = rawCode.split("\n");
    if (lines.length <= 1) return rawCode.trim();

    let parenDepth = 0;
    let angleDepth = 0;
    let braceDepthInTemplate = 0;
    let inString: string | null = null;
    let inTemplateExpr = false;

    for (let i = 0; i < rawCode.length; i++) {
        const ch = rawCode[i];

        // Track string state - skip everything inside strings
        if (inString) {
            if (ch === "\\" && i + 1 < rawCode.length) {
                i++; // Skip escaped character
            } else if (inString === '`' && ch === '$' && i + 1 < rawCode.length && rawCode[i + 1] === '{') {
                // Enter template expression ${...}
                inTemplateExpr = true;
                braceDepthInTemplate = 1;
                inString = null;
                i++; // skip the {
            } else if (ch === inString) {
                inString = null;
            }
            continue;
        }

        // Track closing of template expressions with proper brace nesting
        if (inTemplateExpr) {
            if (ch === '{') {
                braceDepthInTemplate++;
            } else if (ch === '}') {
                braceDepthInTemplate--;
                if (braceDepthInTemplate === 0) {
                    inTemplateExpr = false;
                    inString = '`'; // Re-enter template literal
                }
            }
            // Track strings inside template expressions too
            if (ch === '"' || ch === "'" || ch === '`') {
                inString = ch;
            }
            continue;
        }

        // Detect string start
        if (ch === '"' || ch === "'" || ch === '`') {
            inString = ch;
            continue;
        }

        if (ch === "(") parenDepth++;
        else if (ch === ")") parenDepth--;
        else if (ch === "<") angleDepth++;
        else if (ch === ">") angleDepth--;
        else if (ch === "{" && parenDepth === 0 && angleDepth === 0) {
            return rawCode.slice(0, i).trim();
        }
        // A-02: Python colon - only match at depth 0 (skip colons inside type hints)
        else if (ch === ":" && parenDepth === 0 && angleDepth === 0) {
            if (/^(?:async\s+)?def\s|^class\s/.test(rawCode)) {
                return rawCode.slice(0, i).trim();
            }
        }
    }

    return lines[0].trim();
}

/** Strip keyword prefixes from a signature, leaving just name + params + return type. */
export function cleanSignature(rawSig: string): string {
    let sig = rawSig.trim();
    let prev = "";
    while (prev !== sig) {
        prev = sig;
        sig = sig.replace(STRIP_KEYWORD, "");
    }
    return sig;
}

/** Extract exported symbol names from file content using regex. */
function extractExports(content: string, ext: string): string[] {
    const exports = new Set<string>();

    if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
        // export function/class/interface/type/enum/const name
        const declRe = /export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+(\w+)/g;
        let m;
        while ((m = declRe.exec(content)) !== null) {
            exports.add(m[1]);
        }
        // export { name1, name2 }
        const namedRe = /export\s*\{([^}]+)\}/g;
        while ((m = namedRe.exec(content)) !== null) {
            for (const name of m[1].split(",")) {
                const clean = name.trim().split(/\s+as\s+/).pop()!.trim();
                if (clean && /^\w+$/.test(clean)) exports.add(clean);
            }
        }
    } else if (ext === ".py") {
        // Python: top-level def/class (non-underscore) are public
        const pyRe = /^(?:async\s+)?(?:def|class)\s+(\w+)/gm;
        let m;
        while ((m = pyRe.exec(content)) !== null) {
            if (!m[1].startsWith("_")) exports.add(m[1]);
        }
    } else if (ext === ".go") {
        // Go: capitalized names are exported
        const goRe = /^(?:func|type)\s+(?:\([^)]*\)\s+)?([A-Z]\w*)/gm;
        let m;
        while ((m = goRe.exec(content)) !== null) {
            exports.add(m[1]);
        }
    }

    return [...exports].sort(stableCompare);
}

/** Extract import module names from file content. */
function extractImports(content: string, ext: string): string[] {
    const imports = new Set<string>();

    if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
        const fromRe = /from\s+["']([^"']+)["']/g;
        let m;
        while ((m = fromRe.exec(content)) !== null) {
            imports.add(m[1]);
        }
        const reqRe = /require\(["']([^"']+)["']\)/g;
        while ((m = reqRe.exec(content)) !== null) {
            imports.add(m[1]);
        }
    } else if (ext === ".py") {
        const pyFromRe = /^from\s+(\S+)\s+import/gm;
        let m;
        while ((m = pyFromRe.exec(content)) !== null) {
            imports.add(m[1]);
        }
        const pyImportRe = /^import\s+(\S+)/gm;
        while ((m = pyImportRe.exec(content)) !== null) {
            imports.add(m[1]);
        }
    } else if (ext === ".go") {
        const importBlocks = content.match(/import\s*\([\s\S]*?\)|import\s+"[^"]+"/g);
        if (importBlocks) {
            const goRe = /"([^"]+)"/g;
            for (const block of importBlocks) {
                let m;
                while ((m = goRe.exec(block)) !== null) {
                    imports.add(m[1]);
                }
            }
        }
    }

    return [...imports].sort(stableCompare);
}

/** Shorten an import path for display: strip leading ./ and trailing .js/.ts */
function shortenImport(imp: string): string {
    return imp.replace(/^\.\//, "").replace(/\.js$|\.ts$/, "");
}

// ─── Directory Walking ──────────────────────────────────────────────

function walkFiles(dirPath: string): string[] {
    const files: string[] = [];

    const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        // Sort directory entries for deterministic walk order
        entries.sort((a, b) => stableCompare(a.name, b.name));

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (!IGNORE_DIRS.has(entry.name)) walk(fullPath);
                continue;
            }

            const ext = path.extname(entry.name).toLowerCase();
            if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

            // Skip .d.ts files (auto-generated type definitions)
            if (entry.name.endsWith(".d.ts")) continue;

            try {
                const stat = fs.statSync(fullPath);
                const filter = shouldProcess(fullPath, stat.size);
                if (filter.process) files.push(fullPath);
            } catch {
                // Skip inaccessible files
            }
        }
    };

    walk(dirPath);
    return files.sort(stableCompare);
}

// ─── PageRank ───────────────────────────────────────────────────────

/**
 * PageRank via Power Iteration on a Markov Chain.
 * PR(A) = (1-d)/N + d * Σ (PR(Ti) / OutDegree(Ti))
 * Convergence for 5,000 files: < 8ms (20 iterations).
 *
 * @param files All file paths in the project
 * @param importedBy Reverse dependency map: file → set of files that import it
 * @returns Map of file → normalized PageRank score (0 to 1)
 */
export function computePageRank(
    files: string[],
    importedBy: Map<string, Set<string>>,
): Map<string, number> {
    const N = files.length;
    let pr = new Map<string, number>();
    if (N === 0) return pr;

    const d = 0.85; // Standard damping factor
    const outDegree = new Map<string, number>();

    // Initialize uniform distribution
    for (const f of files) {
        pr.set(f, 1 / N);
        outDegree.set(f, 0);
    }

    // Compute out-degree (how many things each file imports)
    for (const consumers of importedBy.values()) {
        for (const consumer of consumers) {
            outDegree.set(consumer, (outDegree.get(consumer) || 0) + 1);
        }
    }

    // Power iteration (20 cycles is sufficient for convergence)
    for (let iter = 0; iter < 20; iter++) {
        const nextPr = new Map<string, number>();

        // Sink nodes: files that don't import anything (rank leaks without redistribution)
        let sinkSum = 0;
        for (const f of files) {
            if (outDegree.get(f) === 0) sinkSum += pr.get(f)!;
        }

        for (const target of files) {
            let rankSum = 0;
            const consumers = importedBy.get(target);
            if (consumers) {
                for (const consumer of consumers) {
                    rankSum += pr.get(consumer)! / (outDegree.get(consumer) || 1);
                }
            }
            nextPr.set(target, ((1 - d) / N) + d * (rankSum + sinkSum / N));
        }
        pr = nextPr;
    }

    // Normalize to 0-1 range for percentile calculation
    let maxPr = 0;
    for (const rank of pr.values()) {
        if (rank > maxPr) maxPr = rank;
    }
    if (maxPr > 0) {
        for (const [file, rank] of pr.entries()) {
            pr.set(file, rank / maxPr);
        }
    }

    return pr;
}

// ─── Dependency Graph ───────────────────────────────────────────────

/**
 * Build a fast-lookup index for resolving imports to file paths in O(1).
 * Maps extensionless, with-extension, src/-stripped, and index-collapsed variants.
 */
/**
 * Build a fast-lookup index for resolving imports to file paths in O(1).
 * Maps extensionless, with-extension, src/-stripped, index-collapsed variants,
 * AND Monorepo Workspaces.
 */
export function buildFastLookup(allFiles: string[]): Map<string, string> {
    const lookup = new Map<string, string>();
    for (const file of allFiles) {
        const normalized = file.replace(/\\/g, "/");
        const noExt = normalized.replace(/\.[^/.]+$/, "");
        lookup.set(noExt, normalized);
        lookup.set(normalized, normalized);
        if (noExt.startsWith("src/")) {
            lookup.set(noExt.slice(4), normalized);
        }
        if (noExt.endsWith("/index")) {
            const dir = noExt.slice(0, -6);
            lookup.set(dir, normalized);
            if (dir.startsWith("src/")) {
                lookup.set(dir.slice(4), normalized);
            }
        }
        const match = noExt.match(/^(?:packages|workspaces|libs|apps)\/([^/]+)\/(?:src\/|lib\/)?(.*)$/);
        if (match) {
            const pkgName = match[1];
            const internalPath = match[2];
            const aliasKey = internalPath ? `${pkgName}/${internalPath}` : pkgName;
            lookup.set(aliasKey, normalized);
            if (internalPath.endsWith("/index")) {
                const dirAlias = internalPath.slice(0, -6);
                lookup.set(dirAlias ? `${pkgName}/${dirAlias}` : pkgName, normalized);
            }
        }
    }
    return lookup;
}
/**
 * Resolve an import string to an actual project file path.
 * Returns null for external dependencies.
 */
export function resolveImportFast(
    importStr: string,
    currentFile: string,
    lookup: Map<string, string>,
): string | null {
    if (!importStr.startsWith(".") && !importStr.startsWith("/") && !importStr.startsWith("@/")) {
        let resolved = lookup.get(importStr);
        if (resolved) return resolved;
        if (importStr.startsWith("@")) {
            const parts = importStr.split("/");
            if (parts.length > 1) {
                const withoutOrg = parts.slice(1).join("/");
                resolved = lookup.get(withoutOrg);
                if (resolved) return resolved;
            }
        }
        return null;
    }
    let target = importStr.replace(/^@\//, "src/");
    if (target.startsWith(".")) {
        target = path.posix.join(
            path.posix.dirname(currentFile.replace(/\\/g, "/")),
            target,
        );
    }
    target = target.replace(/\.(ts|tsx|js|jsx)$/, "");
    return lookup.get(target) || null;
}
/**
 * Build a dependency graph from repo map entries.
 * Computes in-degree (how many files import each file) and classifies by percentile.
 */
export function buildDependencyGraph(
    entries: RepoMapEntry[],
    allFiles: string[],
): DependencyGraph {
    const lookup = buildFastLookup(allFiles);
    const importedBy = new Map<string, Set<string>>();
    const inDegree = new Map<string, number>();

    // Initialize all files with 0
    for (const file of allFiles) {
        inDegree.set(file, 0);
        importedBy.set(file, new Set());
    }

    // Build reverse graph
    for (const entry of entries) {
        for (const imp of entry.imports) {
            const resolved = resolveImportFast(imp, entry.filePath, lookup);
            if (resolved && resolved !== entry.filePath) {
                inDegree.set(resolved, (inDegree.get(resolved) || 0) + 1);
                const deps = importedBy.get(resolved) || new Set();
                deps.add(entry.filePath);
                importedBy.set(resolved, deps);
            }
        }
    }

    // PageRank classification (recursive importance, not naive inDegree)
    const prScores = computePageRank(allFiles, importedBy);
    const prScoresArray = Array.from(prScores.values()).sort((a, b) => a - b);
    const p85 = prScoresArray[Math.floor(allFiles.length * 0.85)] || 0;
    const p50 = prScoresArray[Math.floor(allFiles.length * 0.50)] || 0;

    const tiers = new Map<string, "core" | "logic" | "leaf">();
    for (const [file, score] of prScores.entries()) {
        // Only CORE/LOGIC if someone actually imports it (prevents orphan anomalies)
        if (score >= p85 && (inDegree.get(file) || 0) > 0) tiers.set(file, "core");
        else if (score >= p50 && (inDegree.get(file) || 0) > 0) tiers.set(file, "logic");
        else tiers.set(file, "leaf");
    }

    return { importedBy, inDegree, tiers };
}

/** Serialize DependencyGraph to JSON-safe format. */
function serializeGraph(graph: DependencyGraph): DependencyGraphData {
    const importedBy: Record<string, string[]> = {};
    for (const [k, v] of graph.importedBy) {
        if (v.size > 0) importedBy[k] = [...v];
    }
    const inDegree: Record<string, number> = {};
    for (const [k, v] of graph.inDegree) {
        if (v > 0) inDegree[k] = v;
    }
    const tiers: Record<string, "core" | "logic" | "leaf"> = {};
    for (const [k, v] of graph.tiers) {
        tiers[k] = v;
    }
    return { importedBy, inDegree, tiers };
}

/** Deserialize DependencyGraphData back to DependencyGraph. */
function deserializeGraph(data: DependencyGraphData): DependencyGraph {
    const importedBy = new Map<string, Set<string>>();
    for (const [k, v] of Object.entries(data.importedBy)) {
        importedBy.set(k, new Set(v));
    }
    const inDegree = new Map<string, number>(Object.entries(data.inDegree));
    const tiers = new Map<string, "core" | "logic" | "leaf">(
        Object.entries(data.tiers) as [string, "core" | "logic" | "leaf"][],
    );
    return { importedBy, inDegree, tiers };
}

// ─── Repo Map Generation ────────────────────────────────────────────

export async function generateRepoMap(
    projectRoot: string,
    parser: ASTParser
): Promise<RepoMap> {
    await parser.initialize();

    const files = walkFiles(projectRoot);
    const entries: RepoMapEntry[] = [];
    let totalLines = 0;

    for (const filePath of files) {
        let content: string;
        try {
            content = readSource(filePath);
        } catch {
            continue;
        }

        const ext = path.extname(filePath).toLowerCase();
        const lineCount = content.split("\n").length;
        totalLines += lineCount;

        const imports = extractImports(content, ext);
        const exports = extractExports(content, ext);

        // Parse with tree-sitter for signatures
        const signatures: string[] = [];
        if (parser.isSupported(ext)) {
            const result = await parser.parse(filePath, content);
            for (const chunk of result.chunks) {
                const rawSig = extractSignature(chunk.rawCode);
                const cleaned = cleanSignature(rawSig);
                const prefix =
                    chunk.nodeType === "class" ? "class" :
                    chunk.nodeType === "interface" ? "iface" :
                    chunk.nodeType === "type" ? "type" :
                    chunk.nodeType === "method" ? "method" : "fn";
                signatures.push(`${prefix}: ${cleaned}`);
            }
        }

        // Sort signatures alphabetically for deterministic output
        signatures.sort(stableCompare);

        const relPath = path.relative(projectRoot, filePath).replace(/\\/g, "/");
        entries.push({ filePath: relPath, exports, signatures, imports, lineCount });
    }

    // Sort by file path for deterministic output (locale-independent)
    entries.sort((a, b) => stableCompare(a.filePath, b.filePath));

    const allRelPaths = entries.map(e => e.filePath);
    const graph = buildDependencyGraph(entries, allRelPaths);

    return {
        version: "1.0.0",
        generatedAt: new Date().toISOString(),
        totalFiles: entries.length,
        totalLines,
        entries,
        graph,
    };
}

// ─── Text Rendering (Deterministic) ─────────────────────────────────

export function repoMapToText(map: RepoMap): string {
    const lines: string[] = [];

    lines.push(`=== Repo Map (${map.totalFiles} files, ${map.totalLines} lines) ===`);
    lines.push("");

    for (const entry of map.entries) {
        lines.push(`${entry.filePath} (${entry.lineCount} lines)`);

        if (entry.exports.length > 0) {
            lines.push(`  exports: ${entry.exports.join(", ")}`);
        }

        for (const sig of entry.signatures) {
            lines.push(`  ${sig}`);
        }

        if (entry.imports.length > 0) {
            const shortened = entry.imports.map(shortenImport);
            lines.push(`  imports: ${shortened.join(", ")}`);
        }

        lines.push("");
    }

    // Architecture tier summary (if graph available)
    if (map.graph) {
        const graph = map.graph;
        const coreFiles: string[] = [];
        const logicFiles: string[] = [];
        let leafCount = 0;

        for (const entry of map.entries) {
            const tier = graph.tiers.get(entry.filePath);
            const degree = graph.inDegree.get(entry.filePath) ?? 0;
            if (tier === "core") {
                coreFiles.push(`  ${entry.filePath} (imported by ${degree} files)`);
            } else if (tier === "logic") {
                logicFiles.push(`  ${entry.filePath} (imported by ${degree} files)`);
            } else {
                leafCount++;
            }
        }

        if (coreFiles.length > 0) {
            lines.push("=== CORE DOMAIN (Top 25% - modify with caution) ===");
            for (const f of coreFiles) lines.push(f);
            lines.push("");
        }

        if (logicFiles.length > 0) {
            lines.push("=== BUSINESS LOGIC (Middle tier) ===");
            for (const f of logicFiles) lines.push(f);
            lines.push("");
        }

        if (leafCount > 0) {
            lines.push(`=== LEAF NODES (${leafCount} files - safe to experiment) ===`);
            lines.push("");
        }
    }

    return lines.join("\n");
}

// ─── Caching ─────────────────────────────────────────────────────────

function computeFileDigest(projectRoot: string): string {
    const files = walkFiles(projectRoot);
    const hash = crypto.createHash("sha256");

    for (const file of files) {
        try {
            const stat = fs.statSync(file);
            const rel = path.relative(projectRoot, file).replace(/\\/g, "/");
            hash.update(`${rel}:${stat.size}:${Math.floor(stat.mtimeMs)}\n`);
        } catch {
            // Skip
        }
    }

    return hash.digest("hex");
}

export async function getOrGenerateRepoMap(
    projectRoot: string,
    parser: ASTParser,
    forceRefresh: boolean = false
): Promise<{ map: RepoMap; text: string; fromCache: boolean }> {
    const cacheDir = path.join(projectRoot, ".nreki");
    const cachePath = path.join(cacheDir, "repo-map.json");

    const currentDigest = computeFileDigest(projectRoot);

    // Check cache
    if (!forceRefresh && fs.existsSync(cachePath)) {
        try {
            const cached: CachedRepoMap = JSON.parse(
                fs.readFileSync(cachePath, "utf-8")
            );
            if (cached.digest === currentDigest && (cached.formatVersion ?? 0) === CACHE_FORMAT_VERSION) {
                // Restore graph from cached serialized form
                if (cached.graph) {
                    cached.map.graph = deserializeGraph(cached.graph);
                }
                return { map: cached.map, text: cached.text, fromCache: true };
            }
        } catch {
            // Cache corrupted, regenerate
        }
    }

    // Generate fresh map (includes graph)
    const map = await generateRepoMap(projectRoot, parser);
    const text = repoMapToText(map);

    // Save to cache (serialize graph for JSON storage)
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
    const graphData = map.graph ? serializeGraph(map.graph) : undefined;
    // Strip non-serializable graph from the map for JSON storage
    const mapForCache = { ...map, graph: undefined };
    const cacheData: CachedRepoMap = { formatVersion: CACHE_FORMAT_VERSION, digest: currentDigest, map: mapForCache, text, graph: graphData };
    fs.writeFileSync(cachePath, JSON.stringify(cacheData));

    return { map, text, fromCache: false };
}
