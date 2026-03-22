/**
 * ast-sandbox.ts - AST-based code validator for NREKI.
 *
 * Intercepts code BEFORE it's written to disk. Parses with tree-sitter
 * and walks the AST looking for ERROR/MISSING nodes. If found, rejects
 * the code with specific error locations and fix suggestions.
 *
 * This prevents the "write broken code → see error → fix → fail again"
 * loop that burns tokens.
 */

import Parser from "web-tree-sitter";
import path from "path";
import { fileURLToPath } from "url";
import { safeParse } from "./utils/safe-parse.js";
import { ParserPool } from "./parser-pool.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface AstError {
    /** 1-indexed line number. */
    line: number;
    /** 1-indexed column number. */
    column: number;
    /** Node type: "ERROR" or "MISSING(<expected>)". */
    nodeType: string;
    /** The source line containing the error. */
    context: string;
}

export interface ValidationResult {
    /** True if the code has zero syntax errors. */
    valid: boolean;
    /** List of all detected syntax errors. */
    errors: AstError[];
    /** Human-readable fix suggestions. */
    suggestion: string;
}

// ─── Language Mapping ────────────────────────────────────────────────

const LANGUAGE_MAP: Record<string, string> = {
    typescript: "tree-sitter-typescript.wasm",
    javascript: "tree-sitter-javascript.wasm",
    python: "tree-sitter-python.wasm",
    go: "tree-sitter-go.wasm",
};

/** Map file extensions to language names. */
const EXT_TO_LANGUAGE: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".go": "go",
};

// ─── AstSandbox ──────────────────────────────────────────────────────

export class AstSandbox {
    private pool: ParserPool;
    private languageCache = new Map<string, Parser.Language>();
    private languagePromises = new Map<string, Promise<Parser.Language | null>>();
    private wasmDir: string;
    private initialized = false;

    constructor(wasmDir?: string) {
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        this.wasmDir = wasmDir ?? path.join(__dirname, "..", "wasm");
        this.pool = new ParserPool(4);
    }

    /** Initialize the Tree-sitter WASM runtime. Must be called once. */
    async initialize(): Promise<void> {
        if (this.initialized) return;
        await this.pool.initialize();
        this.initialized = true;
    }

    /** Get supported language names. */
    getSupportedLanguages(): string[] {
        return Object.keys(LANGUAGE_MAP);
    }

    /** Detect language from a file extension. */
    detectLanguage(filePath: string): string | null {
        const ext = path.extname(filePath).toLowerCase();
        return EXT_TO_LANGUAGE[ext] ?? null;
    }

    // ─── Language Loading ──────────────────────────────────────────

    /** A-08: Deduplicates concurrent WASM loads. */
    private async loadLanguage(language: string): Promise<Parser.Language | null> {
        if (this.languageCache.has(language)) {
            return this.languageCache.get(language)!;
        }

        if (this.languagePromises.has(language)) {
            return this.languagePromises.get(language)!;
        }

        const wasmFile = LANGUAGE_MAP[language];
        if (!wasmFile) return null;

        const promise = (async (): Promise<Parser.Language | null> => {
            try {
                const wasmPath = path.join(this.wasmDir, wasmFile);
                const lang = await Parser.Language.load(wasmPath);
                this.languageCache.set(language, lang);
                return lang;
            } catch {
                return null;
            } finally {
                this.languagePromises.delete(language);
            }
        })();

        this.languagePromises.set(language, promise);
        return promise;
    }

    // ─── Validation ────────────────────────────────────────────────

    /**
     * Validate code syntax using tree-sitter AST analysis.
     *
     * Parses the code and walks the resulting tree looking for
     * ERROR and MISSING nodes. Returns specific error locations
     * with human-readable fix suggestions.
     */
    async validateCode(code: string, language: string): Promise<ValidationResult> {
        await this.initialize();

        const lang = await this.loadLanguage(language);
        if (!lang) {
            return {
                valid: false,
                errors: [
                    {
                        line: 0,
                        column: 0,
                        nodeType: "UNSUPPORTED",
                        context: `Unsupported language: ${language}`,
                    },
                ],
                suggestion: `Language "${language}" is not supported. Supported: ${Object.keys(LANGUAGE_MAP).join(", ")}`,
            };
        }

        const parser = await this.pool.acquire(lang, language);
        try {
            return safeParse(parser, code, (tree) => {
                // Quick check: if no errors in the entire tree, skip the walk
                if (!tree.rootNode.hasError) {
                    return { valid: true, errors: [], suggestion: "" };
                }

                const lines = code.split("\n");
                const errors: AstError[] = [];
                this.walkForErrors(tree.rootNode, lines, errors);

                if (errors.length === 0) {
                    // hasError was true but no ERROR/MISSING nodes found
                    // (can happen with certain recoverable parse states)
                    return { valid: true, errors: [], suggestion: "" };
                }

                const suggestion = this.generateSuggestion(errors, lines);
                return { valid: false, errors, suggestion };
            });
        } finally {
            this.pool.release(language, parser);
        }
    }

    /**
     * Validate new code against the original, showing what changed.
     *
     * Parses the NEW code only. If it has errors, enhances the
     * error context by showing the original line vs the new line.
     */
    async validateDiff(
        originalCode: string,
        newCode: string,
        language: string
    ): Promise<ValidationResult> {
        const result = await this.validateCode(newCode, language);

        if (!result.valid) {
            const origLines = originalCode.split("\n");
            const newLines = newCode.split("\n");

            for (const error of result.errors) {
                const lineIdx = error.line - 1;
                if (lineIdx >= 0 && lineIdx < newLines.length) {
                    const newLine = newLines[lineIdx];
                    const origLine =
                        lineIdx < origLines.length
                            ? origLines[lineIdx]
                            : "(new line)";
                    if (newLine !== origLine) {
                        error.context +=
                            `\n  Was: ${origLine.trim()}` +
                            `\n  Now: ${newLine.trim()}`;
                    }
                }
            }
        }

        return result;
    }

    // ─── Tree Walking ──────────────────────────────────────────────

    /**
     * Recursively walk the AST looking for ERROR and MISSING nodes.
     *
     * Uses hasError to skip clean subtrees (optimization for large files).
     * Does not descend into ERROR nodes (their children are unparsed tokens).
     */
    private walkForErrors(
        node: Parser.SyntaxNode,
        lines: string[],
        errors: AstError[],
        depth: number = 0
    ): void {
        // M-09: Guard against stack overflow on deeply nested ASTs
        if (depth > 200) return;

        if (node.type === "ERROR" || node.isMissing) {
            const line = node.startPosition.row + 1;
            const column = node.startPosition.column + 1;
            const lineText = line <= lines.length ? lines[line - 1] : "";

            errors.push({
                line,
                column,
                nodeType: node.isMissing
                    ? `MISSING(${node.type})`
                    : "ERROR",
                context: lineText,
            });
            return; // don't descend into error nodes
        }

        // Optimization: skip subtrees with no errors
        if (!node.hasError) return;

        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) {
                this.walkForErrors(child, lines, errors, depth + 1);
            }
        }
    }

    // ─── Suggestion Generation ─────────────────────────────────────

    /**
     * Generate human-readable fix suggestions from error nodes.
     *
     * Combines error location, context line, and heuristic hints
     * to help Claude understand exactly what went wrong.
     */
    private generateSuggestion(errors: AstError[], _lines: string[]): string {
        const parts: string[] = [];

        for (const error of errors) {
            let detail = `Syntax error at line ${error.line}, column ${error.column}`;

            // MISSING nodes tell us what was expected
            if (error.nodeType.startsWith("MISSING")) {
                const missing =
                    error.nodeType.match(/MISSING\((.+)\)/)?.[1] || "token";
                detail += `: missing ${missing}`;
            }

            // Show the offending line
            const contextLine = error.context.split("\n")[0];
            if (contextLine.trim()) {
                detail += `. The line reads: '${contextLine.trim()}'`;
            }

            // Heuristic hints for common mistakes
            const ctx = contextLine;
            if (ctx.match(/=\s*[;,\]})]/) || ctx.match(/=\s*$/)) {
                detail += ". Likely missing a value after '='";
            } else if (
                (ctx.match(/\{/) && !ctx.match(/\}/)) ||
                error.nodeType === "MISSING(})"
            ) {
                detail += ". Possible unclosed brace '{'";
            } else if (
                (ctx.match(/\(/) && !ctx.match(/\)/)) ||
                error.nodeType === "MISSING())"
            ) {
                detail += ". Possible unclosed parenthesis '('";
            } else if (error.nodeType === "MISSING(;)") {
                detail += ". Add a semicolon ';'";
            }

            parts.push(detail);
        }

        return parts.join("\n");
    }
}
