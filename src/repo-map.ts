/**
 * repo-map.ts — Static repository map for Anthropic prompt cache optimization.
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
}

export interface CachedRepoMap {
    digest: string;
    map: RepoMap;
    text: string;
}

// ─── Constants ──────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go"]);

const IGNORE_DIRS = new Set([
    "node_modules", "dist", "build", ".git", "coverage",
    ".next", "__pycache__", ".tokenguard",
]);

const STRIP_KEYWORD = /^(?:export|default|declare|abstract|public|private|protected|static|readonly|async|function|class|interface|type|enum|const|let|var|def|func)\s+/;

/** Byte-identical comparator — same result on every OS (no ICU dependency). */
const stableCompare = (a: string, b: string): number =>
    a < b ? -1 : a > b ? 1 : 0;

// ─── Extraction Helpers ─────────────────────────────────────────────

/** Extract signature from raw AST code (everything before opening `{` or `:` for Python). */
function extractSignature(rawCode: string): string {
    const lines = rawCode.split("\n");
    if (lines.length <= 1) return rawCode.trim();

    let parenDepth = 0;
    let angleDepth = 0;

    for (let i = 0; i < rawCode.length; i++) {
        const ch = rawCode[i];
        if (ch === "(") parenDepth++;
        else if (ch === ")") parenDepth--;
        else if (ch === "<") angleDepth++;
        else if (ch === ">") angleDepth--;
        else if (ch === "{" && parenDepth === 0 && angleDepth === 0) {
            return rawCode.slice(0, i).trim();
        }
    }

    // Python: colon after def/class
    if (/^(?:async\s+)?def\s|^class\s/.test(rawCode)) {
        const colonIdx = rawCode.indexOf(":");
        if (colonIdx > 0) return rawCode.slice(0, colonIdx).trim();
    }

    return lines[0].trim();
}

/** Strip keyword prefixes from a signature, leaving just name + params + return type. */
function cleanSignature(rawSig: string): string {
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

    return {
        version: "1.0.0",
        generatedAt: new Date().toISOString(),
        totalFiles: entries.length,
        totalLines,
        entries,
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
            hash.update(`${rel}:${stat.size}:${stat.mtimeMs}\n`);
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
    const cacheDir = path.join(projectRoot, ".tokenguard");
    const cachePath = path.join(cacheDir, "repo-map.json");

    const currentDigest = computeFileDigest(projectRoot);

    // Check cache
    if (!forceRefresh && fs.existsSync(cachePath)) {
        try {
            const cached: CachedRepoMap = JSON.parse(
                fs.readFileSync(cachePath, "utf-8")
            );
            if (cached.digest === currentDigest) {
                return { map: cached.map, text: cached.text, fromCache: true };
            }
        } catch {
            // Cache corrupted, regenerate
        }
    }

    // Generate fresh map
    const map = await generateRepoMap(projectRoot, parser);
    const text = repoMapToText(map);

    // Save to cache
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
    const cacheData: CachedRepoMap = { digest: currentDigest, map, text };
    fs.writeFileSync(cachePath, JSON.stringify(cacheData));

    return { map, text, fromCache: false };
}
