/**
 * imports.ts - Dependency extraction and security filters for Auto-Context.
 * Anchors searches to explicit import declarations instead of blind regex on code bodies.
 * Supports: ESM named/default, CommonJS require, Python from-import, Go namespace inference.
 */

export interface ImportDependency {
    /** Original exported name - used for BM25 search in SQLite */
    symbol: string;
    /** Name used in THIS file (may differ due to alias) - used for the Gold Filter */
    localName: string;
    /** Last segment of the import path - used for homonym disambiguation */
    pathHint: string;
}

// Security: exact auth-related tokens only. "tokenize", "TokenStream" pass through.
const SENSITIVE_PATTERNS = [
    /password/i, /secret/i, /private.?key/i, /api.?key/i,
    /credential/i, /encrypt/i, /decrypt/i, /master.?key/i,
    /(auth|access|refresh|secret|api|csrf|bearer|session)_?token/i,
];

/** Prevent leakage of credential-related signatures in auto-injected context */
export function isSensitiveSignature(sig: string): boolean {
    return SENSITIVE_PATTERNS.some(p => p.test(sig));
}

/** Escape special regex characters - prevents ReDoS with symbols like $store */
export function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Clean a shorthand signature for safe injection.
 * - Strips JS/TS block and line comments
 * - Strips ONLY NREKI-specific Python stubs (not legitimate # comments)
 * - Collapses multiline signatures into one line
 * - Falls back to first line if cleanup produces empty string
 */
export function cleanSignature(shorthand: string): string {
    const sig = shorthand
        .replace(/\/\*[\s\S]*?\*\//g, "")              // JS/TS block comments & /*[nreki:4L]*/ stubs
        .replace(/\/\/.*/g, "")                         // JS/TS line comments
        .replace(/#\s*(?:\[NREKI\]|TG:L\d+).*$/gm, "")   // Strip ONLY NREKI stubs in Python
        .replace(/\{\s*$/, "")                          // Remove trailing open brace
        .replace(/\s+/g, " ")                           // Collapse whitespace
        .trim();

    return sig || shorthand.split("\n")[0].trim();
}

/**
 * Extract EXPLICIT dependencies from file imports.
 * Returns symbol (original name for search), localName (alias for Gold Filter),
 * and pathHint (file hint for homonym disambiguation).
 */
export function extractDependencies(code: string, ext: string): ImportDependency[] {
    const deps: ImportDependency[] = [];

    // Local path heuristic: Node needs ./, ~/, @/; Go needs /
    const isLocalPath = (p: string) =>
        ext === ".go" ? p.includes("/") : /^[./~@]/.test(p);

    if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
        // ── Named ESM: import { foo, bar as baz } from "./utils/math" ──
        const namedRe =
            /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
        let match;
        while ((match = namedRe.exec(code)) !== null) {
            if (!isLocalPath(match[2])) continue;
            const pathHint =
                match[2].split("/").pop()?.replace(/\.(ts|js)x?$/, "") || match[2];
            for (const s of match[1].split(",")) {
                if (!s.trim()) continue;
                const parts = s.trim().split(/\s+as\s+/);
                const symbol = parts[0].trim();
                const localName = (parts[1] || parts[0]).trim();
                if (symbol.length > 2) deps.push({ symbol, localName, pathHint });
            }
        }

        // ── Default ESM: import Foo from "..." or import Foo, { bar } from "..." ──
        // A-05: Allow optional ", { ... }" between default identifier and "from"
        const defaultRe =
            /import\s+(?!\s*\{)(?:\*\s+as\s+)?([a-zA-Z0-9_$]+)\s*(?:,\s*\{[^}]*\})?\s+from\s+['"]([^'"]+)['"]/g;
        while ((match = defaultRe.exec(code)) !== null) {
            if (!isLocalPath(match[2])) continue;
            const pathHint =
                match[2].split("/").pop()?.replace(/\.(ts|js)x?$/, "") || match[2];
            const symbol = match[1].trim();
            if (symbol !== "type" && symbol.length > 2) {
                deps.push({ symbol, localName: symbol, pathHint });
            }
        }

        // ── CommonJS: const { hash: myHash } = require('./utils') ──
        const reqRe =
            /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\(['"]([^'"]+)['"]\)/g;
        while ((match = reqRe.exec(code)) !== null) {
            if (!isLocalPath(match[2])) continue;
            const pathHint =
                match[2].split("/").pop()?.replace(/\.(ts|js)x?$/, "") || match[2];
            for (const s of match[1].split(",")) {
                if (!s.trim()) continue;
                const parts = s.trim().split(/\s*:\s*/);
                const symbol = parts[0].trim();
                const localName = (parts[1] || parts[0]).trim();
                if (symbol.length > 2) deps.push({ symbol, localName, pathHint });
            }
        }
    } else if (ext === ".py") {
        // ── Python: from app.core.auth import validate as check_auth ──
        // Support single-line and parenthesized multi-line imports:
        // from foo import (bar, baz)
        const pyFromRe = /^from\s+([a-zA-Z0-9_.]+)\s+import\s+(?:\(([^)]*)\)|([^#\n]+))/gm;
        let match;
        while ((match = pyFromRe.exec(code)) !== null) {
            const pathHint = match[1].split(".").pop() || match[1];
            const importList = (match[2] || match[3] || "").replace(/\\\n/g, " ");
            for (const s of importList.split(",")) {
                if (!s.trim()) continue;
                const parts = s.trim().split(/\s+as\s+/);
                const symbol = parts[0].trim();
                const localName = (parts[1] || parts[0]).trim();
                if (symbol.length > 2) deps.push({ symbol, localName, pathHint });
            }
        }
    } else if (ext === ".go") {
        // ── Go: Namespace-to-Symbol Inference Engine ──
        // Go imports packages, not symbols. We scan the code for Package.ExportedSymbol usage.
        const pkgMap = new Map<string, string>();
        const importBlocks = code.match(
            /import\s*\([\s\S]*?\)|import\s+(?:[a-zA-Z0-9_.]+\s+)?["'][^"']+["']/g,
        );

        if (importBlocks) {
            const lineRe = /(?:([a-zA-Z0-9_.]+)\s+)?"([^"]+)"/g;
            for (const block of importBlocks) {
                // Strip 'import' keyword and parens so lineRe doesn't capture "import" as alias
                const inner = block.replace(/^import\s*\(?\s*/, "").replace(/\)\s*$/, "");
                lineRe.lastIndex = 0;
                let m;
                while ((m = lineRe.exec(inner)) !== null) {
                    const alias = m[1];
                    const fullPath = m[2];
                    // Go stdlib uses slashes (encoding/json, crypto/sha256).
                    // Third-party packages always have a dot in first segment (github.com).
                    const firstSegment = fullPath.split('/')[0];
                    if (!firstSegment.includes('.')) continue;

                    const pathHint = fullPath.split("/").pop() || fullPath;
                    const localName = alias || pathHint;
                    if (localName !== "_" && localName !== ".") {
                        pkgMap.set(localName, pathHint);
                    }
                }
            }
        }

        // Scan body for Package.ExportedSymbol (Go exports start with uppercase)
        for (const [localName, pathHint] of pkgMap.entries()) {
            const usageRe = new RegExp(
                `\\b${escapeRegExp(localName)}\\.([A-Z]\\w*)`,
                "g",
            );
            let uMatch;
            while ((uMatch = usageRe.exec(code)) !== null) {
                deps.push({
                    symbol: uMatch[1],
                    localName: `${localName}.${uMatch[1]}`,
                    pathHint,
                });
            }
        }
    }

    // Deduplicate
    const unique = new Map<string, ImportDependency>();
    for (const d of deps) unique.set(`${d.symbol}:${d.pathHint}`, d);
    return Array.from(unique.values());
}
