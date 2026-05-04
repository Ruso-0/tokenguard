/**
 * parser.ts - Universal AST parser for NREKI.
 *
 * Wraps web-tree-sitter to parse TypeScript, JavaScript, Python, and Go
 * source files into semantic chunks. Each chunk is an AST node (class,
 * function, method, interface) compressed into shorthand notation.
 *
 * Shorthand format: `[type] signature { /* TG:L42-L67 *​/ }`
 * This preserves structure while stripping implementation - ~18% savings.
 */

import Parser from "web-tree-sitter";
import path from "path";
import { fileURLToPath } from "url";
import { safeParse } from "./utils/safe-parse.js";
import { logger } from "./utils/logger.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface ParsedChunk {
    /** Shorthand AST signature (compressed). */
    shorthand: string;
    /** Full raw source code of the node. */
    rawCode: string;
    /** AST node type: class, func, method, interface, etc. */
    nodeType: string;
    /** 1-indexed start line in the source file. */
    startLine: number;
    /** 1-indexed end line in the source file. */
    endLine: number;
    /** Absolute byte offset of the node start in the source file. */
    startIndex: number;
    /** Absolute byte offset of the node end in the source file. */
    endIndex: number;
    /** Symbol name extracted directly from AST name captures. */
    symbolName: string;
}

export interface ParseResult {
    /** File path that was parsed. */
    filePath: string;
    /** Extracted AST chunks. */
    chunks: ParsedChunk[];
    /** Total lines in the source file. */
    totalLines: number;
    /** Language that was detected. */
    language: string;
}

/** Supported language extensions. */
export type SupportedExtension =
    | ".ts"
    | ".tsx"
    | ".js"
    | ".jsx"
    | ".mjs"
    | ".cjs"
    | ".mts"
    | ".cts"
    | ".py"
    | ".go"
    | ".css"
    | ".json"
    | ".html";

// ─── Language Configuration ──────────────────────────────────────────

interface LanguageConfig {
    wasmFile: string;
    /** Tree-sitter S-expression query to capture semantic nodes. */
    query: string;
}

const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
    ".ts": {
        wasmFile: "tree-sitter-typescript.wasm",
        query: `
      (class_declaration name: (type_identifier) @class_name) @class
      (function_declaration name: (identifier) @func_name) @func
      (method_definition name: (property_identifier) @method_name) @method
      (interface_declaration name: (type_identifier) @iface_name) @interface
      (type_alias_declaration name: (type_identifier) @type_name) @type_alias
      (export_statement declaration: (function_declaration name: (identifier) @exp_func_name)) @export_func
      (export_statement declaration: (class_declaration name: (type_identifier) @exp_class_name)) @export_class
      (lexical_declaration (variable_declarator name: (identifier) @var_name value: [(arrow_function) (function_expression)])) @arrow_func
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @exp_var_name value: [(arrow_function) (function_expression)]))) @export_arrow_func
      (lexical_declaration (variable_declarator name: (identifier) @var_name)) @var_decl
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @exp_var_name))) @export_var_decl
    `,
    },
    ".tsx": {
        wasmFile: "tree-sitter-tsx.wasm",
        query: `
      (class_declaration name: (type_identifier) @class_name) @class
      (function_declaration name: (identifier) @func_name) @func
      (method_definition name: (property_identifier) @method_name) @method
      (interface_declaration name: (type_identifier) @iface_name) @interface
      (type_alias_declaration name: (type_identifier) @type_name) @type_alias
      (export_statement declaration: (function_declaration name: (identifier) @exp_func_name)) @export_func
      (export_statement declaration: (class_declaration name: (type_identifier) @exp_class_name)) @export_class
      (lexical_declaration (variable_declarator name: (identifier) @var_name value: [(arrow_function) (function_expression)])) @arrow_func
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @exp_var_name value: [(arrow_function) (function_expression)]))) @export_arrow_func
      (lexical_declaration (variable_declarator name: (identifier) @var_name)) @var_decl
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @exp_var_name))) @export_var_decl
    `,
    },
    ".js": {
        wasmFile: "tree-sitter-javascript.wasm",
        query: `
      (class_declaration name: (identifier) @class_name) @class
      (function_declaration name: (identifier) @func_name) @func
      (method_definition name: (property_identifier) @method_name) @method
      (export_statement declaration: (function_declaration name: (identifier) @exp_func_name)) @export_func
      (lexical_declaration (variable_declarator name: (identifier) @var_name value: [(arrow_function) (function_expression)])) @arrow_func
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @exp_var_name value: [(arrow_function) (function_expression)]))) @export_arrow_func
      (lexical_declaration (variable_declarator name: (identifier) @var_name)) @var_decl
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @exp_var_name))) @export_var_decl
    `,
    },
    ".jsx": {
        wasmFile: "tree-sitter-javascript.wasm",
        query: `
      (class_declaration name: (identifier) @class_name) @class
      (function_declaration name: (identifier) @func_name) @func
      (method_definition name: (property_identifier) @method_name) @method
      (export_statement declaration: (function_declaration name: (identifier) @exp_func_name)) @export_func
      (lexical_declaration (variable_declarator name: (identifier) @var_name value: [(arrow_function) (function_expression)])) @arrow_func
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @exp_var_name value: [(arrow_function) (function_expression)]))) @export_arrow_func
      (lexical_declaration (variable_declarator name: (identifier) @var_name)) @var_decl
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @exp_var_name))) @export_var_decl
    `,
    },
    ".py": {
        wasmFile: "tree-sitter-python.wasm",
        query: `
      (class_definition name: (identifier) @class_name) @class
      (function_definition name: (identifier) @func_name) @func
    `,
    },
    ".go": {
        wasmFile: "tree-sitter-go.wasm",
        query: `
      (function_declaration name: (identifier) @func_name) @func
      (method_declaration name: (field_identifier) @method_name) @method
      (type_declaration (type_spec name: (type_identifier) @type_name)) @type_decl
    `,
    },
    // Modern TS/JS module extensions — alias to their base configs.
    // Queries inlined (copy-paste) to avoid TDZ from self-referencing
    // LANGUAGE_CONFIGS inside its own initializer.
    ".mts": {
        wasmFile: "tree-sitter-typescript.wasm",
        query: `
      (class_declaration name: (type_identifier) @class_name) @class
      (function_declaration name: (identifier) @func_name) @func
      (method_definition name: (property_identifier) @method_name) @method
      (interface_declaration name: (type_identifier) @iface_name) @interface
      (type_alias_declaration name: (type_identifier) @type_name) @type_alias
      (export_statement declaration: (function_declaration name: (identifier) @exp_func_name)) @export_func
      (export_statement declaration: (class_declaration name: (type_identifier) @exp_class_name)) @export_class
      (lexical_declaration (variable_declarator name: (identifier) @var_name value: [(arrow_function) (function_expression)])) @arrow_func
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @exp_var_name value: [(arrow_function) (function_expression)]))) @export_arrow_func
      (lexical_declaration (variable_declarator name: (identifier) @var_name)) @var_decl
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @exp_var_name))) @export_var_decl
    `,
    },
    ".cts": {
        wasmFile: "tree-sitter-typescript.wasm",
        query: `
      (class_declaration name: (type_identifier) @class_name) @class
      (function_declaration name: (identifier) @func_name) @func
      (method_definition name: (property_identifier) @method_name) @method
      (interface_declaration name: (type_identifier) @iface_name) @interface
      (type_alias_declaration name: (type_identifier) @type_name) @type_alias
      (export_statement declaration: (function_declaration name: (identifier) @exp_func_name)) @export_func
      (export_statement declaration: (class_declaration name: (type_identifier) @exp_class_name)) @export_class
      (lexical_declaration (variable_declarator name: (identifier) @var_name value: [(arrow_function) (function_expression)])) @arrow_func
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @exp_var_name value: [(arrow_function) (function_expression)]))) @export_arrow_func
      (lexical_declaration (variable_declarator name: (identifier) @var_name)) @var_decl
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @exp_var_name))) @export_var_decl
    `,
    },
    ".mjs": {
        wasmFile: "tree-sitter-javascript.wasm",
        query: `
      (class_declaration name: (identifier) @class_name) @class
      (function_declaration name: (identifier) @func_name) @func
      (method_definition name: (property_identifier) @method_name) @method
      (export_statement declaration: (function_declaration name: (identifier) @exp_func_name)) @export_func
      (lexical_declaration (variable_declarator name: (identifier) @var_name value: [(arrow_function) (function_expression)])) @arrow_func
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @exp_var_name value: [(arrow_function) (function_expression)]))) @export_arrow_func
      (lexical_declaration (variable_declarator name: (identifier) @var_name)) @var_decl
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @exp_var_name))) @export_var_decl
    `,
    },
    ".cjs": {
        wasmFile: "tree-sitter-javascript.wasm",
        query: `
      (class_declaration name: (identifier) @class_name) @class
      (function_declaration name: (identifier) @func_name) @func
      (method_definition name: (property_identifier) @method_name) @method
      (export_statement declaration: (function_declaration name: (identifier) @exp_func_name)) @export_func
      (lexical_declaration (variable_declarator name: (identifier) @var_name value: [(arrow_function) (function_expression)])) @arrow_func
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @exp_var_name value: [(arrow_function) (function_expression)]))) @export_arrow_func
      (lexical_declaration (variable_declarator name: (identifier) @var_name)) @var_decl
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @exp_var_name))) @export_var_decl
    `,
    },
    ".css": {
        wasmFile: "tree-sitter-css.wasm",
        query: `
          (rule_set (selectors) @symbol_name) @class
          (keyframes_statement (keyframes_name) @symbol_name) @class
          (media_statement (feature_query) @symbol_name) @class
          (import_statement (string_value) @symbol_name) @class
          (at_rule (at_keyword) @symbol_name) @class
        `,
    },
    ".json": {
        wasmFile: "tree-sitter-json.wasm",
        query: `(document (object (pair key: (string) @symbol_name) @class))`,
    },
    ".html": {
        wasmFile: "tree-sitter-html.wasm",
        query: `
          (element
            (start_tag
              (attribute
                (attribute_name) @attr_name
                [(quoted_attribute_value (attribute_value) @symbol_name)
                 (attribute_value) @symbol_name]
              )
            )
          ) @class
        `,
    },
};

// ─── Parser ──────────────────────────────────────────────────────────

export class ASTParser {
    private parser!: Parser;
    private languageCache = new Map<string, Parser.Language>();
    private loadGate: Promise<unknown> = Promise.resolve();
    private queryCache = new Map<string, Parser.Query>();
    private wasmDir: string;
    private initialized = false;
    private initGate: Promise<void> | null = null;

    constructor(wasmDir?: string) {
        // Default: look for wasm/ relative to this file's directory
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        this.wasmDir = wasmDir ?? path.join(__dirname, "..", "wasm");
    }

    /** Initialize the Tree-sitter WASM runtime. Must be called once. */
    async initialize(): Promise<void> {
        if (this.initialized) return;
        if (!this.initGate) {
            this.initGate = Parser.init().then(() => {
                this.parser = new Parser();
                this.initialized = true;
            });
        }
        return this.initGate;
    }

    // ─── Language Loading ──────────────────────────────────────────

    /** Check if a file extension is supported. */
    isSupported(ext: string): boolean {
        return ext in LANGUAGE_CONFIGS;
    }

    /** Get supported file extensions. */
    getSupportedExtensions(): string[] {
        return Object.keys(LANGUAGE_CONFIGS);
    }

    /** Load a Tree-sitter language grammar from WASM. A-08: Serializes concurrent loads. */
    private async loadLanguage(ext: string): Promise<Parser.Language | null> {
        if (this.languageCache.has(ext)) {
            return this.languageCache.get(ext)!;
        }

        const load = this.loadGate.then(async () => {
            if (this.languageCache.has(ext)) {
                return this.languageCache.get(ext)!;
            }

            const config = LANGUAGE_CONFIGS[ext];
            if (!config) return null;

            try {
                const wasmPath = path.join(this.wasmDir, config.wasmFile);
                const language = await Parser.Language.load(wasmPath);
                this.languageCache.set(ext, language);
                return language;
            } catch (err) {
                logger.error(`Failed to load grammar for ${ext}: ${(err as Error).message}`);
                return null;
            }
        });

        this.loadGate = load.then(() => {}, () => {});
        return load;
    }

    /** Get or create a Tree-sitter query for a language. */
    private getQuery(ext: string, language: Parser.Language): Parser.Query | null {
        if (this.queryCache.has(ext)) {
            return this.queryCache.get(ext)!;
        }

        const config = LANGUAGE_CONFIGS[ext];
        if (!config) return null;

        try {
            const query = language.query(config.query);
            this.queryCache.set(ext, query);
            return query;
        } catch (err) {
            logger.error(`Failed to create query for ${ext}: ${(err as Error).message}`);
            return null;
        }
    }

    // ─── Parsing ───────────────────────────────────────────────────

    /**
     * Parse a source file into semantic AST chunks.
     *
     * Each chunk contains:
     * - shorthand: compressed signature (e.g., `[func] processFile(path: string) { /* TG:L12-L45 *​/ }`)
     * - rawCode: the full implementation
     * - nodeType: class, func, method, etc.
     * - startLine/endLine: location in the original file
     */
    async parse(filePath: string, content: string): Promise<ParseResult> {
        await this.initialize();

        const ext = path.extname(filePath).toLowerCase();
        const language = await this.loadLanguage(ext);

        if (!language) {
            return {
                filePath,
                chunks: [],
                totalLines: content.split("\n").length,
                language: "unsupported",
            };
        }

        this.parser.setLanguage(language);
        const query = this.getQuery(ext, language);

        if (!query) {
            return {
                filePath,
                chunks: [],
                totalLines: content.split("\n").length,
                language: ext.slice(1),
            };
        }

        // Use safeParse to ensure tree.delete() is always called (FIX 2: WASM memory)
        const chunks = safeParse(this.parser, content, (tree) => {
            const matches = query.matches(tree.rootNode);
            const result: ParsedChunk[] = [];
            const seen = new Set<string>(); // Deduplicate overlapping captures

            for (const match of matches) {
                // Get the main capture (exclude _name suffix AND html attr_name)
                const mainCapture = match.captures.find(
                    (c) => !c.name.endsWith("_name") && c.name !== "attr_name"
                );
                if (!mainCapture) continue;

                // Extract symbol name (FIX CRIMEN 2: exclude attr_name which ends in _name)
                const nameCapture = match.captures.find(
                    (c) => c.name.endsWith("_name") && c.name !== "attr_name"
                );
                let symbolName = nameCapture ? nameCapture.node.text : "";

                // HTML filter: skip match if attr is not id/class
                if (ext === ".html") {
                    const attrCapture = match.captures.find(c => c.name === "attr_name");
                    if (!attrCapture) continue;
                    const attrText = attrCapture.node.text;
                    if (attrText !== "id" && attrText !== "class") continue;
                }

                // JSON filter: ONLY top-level pairs (prevents nested blowup)
                if (ext === ".json") {
                    if (mainCapture.node.parent?.type !== "object" ||
                        mainCapture.node.parent?.parent?.type !== "document") {
                        continue;
                    }
                }

                // Web symbol name normalization (D1) — extracted to shared utility (v10.18.1)
                if (symbolName) {
                    symbolName = normalizeWebSymbol(symbolName, ext);
                }

                const node = mainCapture.node;

                if (mainCapture.name === "var_decl" && node.parent?.type !== "program") continue;
                if (mainCapture.name === "export_var_decl" && node.parent?.type !== "program") continue;

                // Fix Punto 1: minified JSON / multi-attr HTML dedup by absolute bytes + symbolName
                const isWebExt = ext === ".json" || ext === ".html" || ext === ".css";
                const nodeKey = isWebExt
                    ? `${node.startIndex}:${node.endIndex}:${symbolName}`
                    : `${node.startIndex}:${node.endIndex}`;

                // Skip duplicates from overlapping query patterns
                if (seen.has(nodeKey)) continue;
                if (!isWebExt && result.some(c =>
                    c.symbolName === symbolName && node.startIndex < c.endIndex && c.startIndex < node.endIndex
                )) continue;
                seen.add(nodeKey);

                // OOM Parachute (D2): truncate on files with pathological symbol counts
                if (result.length >= 2000) {
                    logger.warn(`Max chunks (2000) reached for ${filePath}. Truncating to prevent OOM.`);
                    break;
                }

                const rawCode = node.text;
                const nodeType = this.normalizeNodeType(mainCapture.name);
                const startLine = node.startPosition.row + 1; // 1-indexed
                const endLine = node.endPosition.row + 1;

                // Generate shorthand: keep signature, collapse body
                const shorthand = this.generateShorthand(
                    rawCode,
                    nodeType,
                    startLine,
                    endLine
                );

                result.push({ shorthand, rawCode, nodeType, startLine, endLine, startIndex: node.startIndex, endIndex: node.endIndex, symbolName });
            }

            return result;
        });

        return {
            filePath,
            chunks,
            totalLines: content.split("\n").length,
            language: ext.slice(1),
        };
    }

    /**
     * Parse a file and provide raw tree-sitter tree access via callback.
     * Guarantees WASM memory cleanup via try/finally.
     * Returns null if the file extension is unsupported.
     */
    async parseRaw<T>(
        filePath: string,
        content: string,
        callback: (tree: Parser.Tree, language: Parser.Language) => T,
    ): Promise<T | null> {
        await this.initialize();
        const ext = path.extname(filePath).toLowerCase();
        const language = await this.loadLanguage(ext);
        if (!language) return null;
        this.parser.setLanguage(language);
        return safeParse(this.parser, content, (tree) => callback(tree, language));
    }

    // ─── Shorthand Generation ─────────────────────────────────────

    /**
     * Generate compressed shorthand for an AST node.
     *
     * Strategy:
     * 1. Extract the signature (everything before the first `{` or `:`)
     * 2. Collapse the body into a TG marker with line range
     * 3. Result: `[func] myFunction(a: string, b: number): void { /* TG:L12-L45 *​/ }`
     *
     * This preserves enough context for semantic search while
     * cutting token count by ~60-80% per chunk.
     */
    private generateShorthand(
        rawCode: string,
        nodeType: string,
        startLine: number,
        endLine: number
    ): string {
        const lines = rawCode.split("\n");

        // For single-line nodes, keep as-is
        if (lines.length <= 2) {
            return `[${nodeType}] ${rawCode.trim()}`;
        }

        // Find the signature boundary
        let signatureEnd = 0;
        let braceDepth = 0;
        let angleDepth = 0;

        for (let i = 0; i < rawCode.length; i++) {
            const char = rawCode[i];

            // Skip string literals to avoid counting brackets inside them
            if (char === '"' || char === "'" || char === "`") {
                const quote = char;
                i++;
                while (i < rawCode.length) {
                    if (rawCode[i] === "\\" ) { i++; }
                    else if (rawCode[i] === quote) break;
                    i++;
                }
                continue;
            }

            if (char === "(") braceDepth++;
            if (char === ")") braceDepth--;
            if (char === "<") angleDepth++;
            // PATCH-3: Guard against `=>` arrow operator decrementing angleDepth below 0.
            // Without this, arrow functions never hit the `angleDepth === 0` exit condition,
            // causing the entire function body to be extracted as the "signature".
            if (char === ">" && !(i > 0 && rawCode[i - 1] === "=") && angleDepth > 0) angleDepth--;

            // Signature ends at the first `{` at depth 0 (JS/TS/Go)
            // or first `:` at depth 0 for Python (A-02: skip colons inside parens)
            if (char === "{" && braceDepth === 0 && angleDepth === 0) {
                signatureEnd = i;
                break;
            }
            if (char === ":" && braceDepth === 0 && angleDepth === 0) {
                // Python def/class colon - only match if this looks like Python
                if (/(?:^|\n)\s*(?:async\s+)?def\s|(?:^|\n)\s*class\s/.test(rawCode)) {
                    const signature = rawCode.slice(0, i + 1).trim();
                    return `[${nodeType}] ${signature} # TG:L${startLine}-L${endLine}`;
                }
            }
        }

        if (signatureEnd === 0) {
            // Fallback: keep first line
            return `[${nodeType}] ${lines[0].trim()} /* TG:L${startLine}-L${endLine} */`;
        }

        const signature = rawCode.slice(0, signatureEnd).trim();
        return `[${nodeType}] ${signature} { /* TG:L${startLine}-L${endLine} */ }`;
    }

    /** Normalize Tree-sitter capture names to clean node types. */
    private normalizeNodeType(captureName: string): string {
        const typeMap: Record<string, string> = {
            class: "class",
            func: "func",
            method: "method",
            interface: "interface",
            type_alias: "type",
            type_decl: "type",
            export_func: "func",
            export_class: "class",
            arrow_func: "func",
            export_arrow_func: "func",
            var_decl: "var",
            export_var_decl: "var",
        };

        return typeMap[captureName] ?? captureName;
    }
}

/**
 * Normalize a web symbol (CSS selector, HTML attribute value, JSON key)
 * to match the canonical form stored in ParsedChunk.symbolName.
 *
 * CSS: strips ".", "#", "," prefixes; collapses whitespace.
 *   ".foo, #bar" → "foo bar"
 * HTML/JSON: strips surrounding quotes.
 *   '"key"' → "key"
 * Other extensions: no-op (returns input unchanged).
 *
 * Used at the API boundary of semantic-edit + compressor-foveal to
 * accept LLM-supplied symbols with web prefixes that the parser stripped
 * during chunk creation. Without this normalization, ".foo" sent by an
 * LLM caller fails to match a parser-stored chunk named "foo".
 */
export function normalizeWebSymbol(symbolName: string, ext: string): string {
    if (!symbolName) return symbolName;
    if (ext === ".css") {
        return symbolName.replace(/[.#,]/g, " ").replace(/\s+/g, " ").trim();
    }
    if (ext === ".json" || ext === ".html") {
        return symbolName.replace(/^["']|["']$/g, "").trim();
    }
    return symbolName;
}
