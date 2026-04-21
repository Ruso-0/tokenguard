/**
 * eslint-sidecar.ts — React/JSX Semantic Shield (Layer 1.5)
 *
 * Ejecuta validación intra-archivo en RAM para reglas críticas de React.
 * Cero I/O: Flat Config estricta, no lee configuración del usuario ni VFS.
 * Lazy-loaded: Instanciado solo en la primera mutación JSX/TSX.
 *
 * Empirically validated against ESLint 9.39.4 + @typescript-eslint/parser 8.59.0
 * on 2026-04-21. 10 cross-audited fixes applied.
 */

import path from "path";
import { logger } from "./utils/logger.js";
import type { NrekiStructuredError } from "./kernel/types.js";

// Soporta comentarios de línea (//) y de bloque (/*) para JSX {/* */}.
// Tolerante a comas e intermedios entre "eslint-disable" y la regla:
// "// eslint-disable no-console, react-hooks/exhaustive-deps"
const ANTI_SWEEP_REGEX = /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\s+[^\r\n]*\b(?:react-hooks\/rules-of-hooks|react-hooks\/exhaustive-deps|react\/jsx-key|jsx-a11y\/alt-text)\b[^\r\n]*/i;

// Detecta tags <Component>, </tag>, fragments <> y </>, namespace <Context.Provider>,
// y web components <my-button>
const JSX_QUICK_DETECT = /<(?:[A-Za-z][A-Za-z0-9_.-]*[\s/>]|\/?\s*>)/;

// Detecta hooks con convención use + mayúscula + (
const HOOK_CALL_DETECT = /\buse[A-Z]\w*\s*\(/;

const TARGET_RULES = new Set([
    "react-hooks/rules-of-hooks",
    "react-hooks/exhaustive-deps",
    "react/jsx-key",
    "jsx-a11y/alt-text"
]);

const SUPPORTED_EXTS = new Set([
    ".js", ".jsx", ".ts", ".tsx",
    ".mjs", ".cjs", ".mts", ".cts"
]);

// Event loop starvation guard: ESLint es CPU-bound síncrono
const MAX_FILE_SIZE = 150_000;

export class ReactEslintSidecar {
    private eslint: any = null;
    private initPromise: Promise<void> | null = null;
    private initialized = false;

    private async _init(): Promise<void> {
        const t0 = performance.now();
        try {
            const { ESLint } = await import("eslint");

            // @typescript-eslint/parser expone named exports (parse, parseForESLint),
            // NO tiene .default. Usar namespace directo (verificado empíricamente v2).
            const tsParserModule = await import("@typescript-eslint/parser");

            // CommonJS interop: estos plugins sí exponen .default
            const reqReact = await import("eslint-plugin-react");
            const pluginReact = (reqReact as any).default || reqReact;
            const reqHooks = await import("eslint-plugin-react-hooks");
            const pluginReactHooks = (reqHooks as any).default || reqHooks;
            // eslint-plugin-jsx-a11y ships no type declarations; dynamic any is intentional
            // @ts-ignore
            const reqA11y = await import("eslint-plugin-jsx-a11y");
            const pluginJsxA11y = (reqA11y as any).default || reqA11y;

            this.eslint = new ESLint({
                // useEslintrc fue removido en ESLint 9. NO incluir.
                overrideConfigFile: true,
                overrideConfig: [{
                    files: [
                        "**/*.js", "**/*.jsx", "**/*.ts", "**/*.tsx",
                        "**/*.mjs", "**/*.cjs", "**/*.mts", "**/*.cts"
                    ],
                    languageOptions: {
                        // Sin tsParser, TSX con interface/genéricos tira fatal parse error
                        parser: tsParserModule as any,
                        parserOptions: {
                            ecmaFeatures: { jsx: true },
                            sourceType: "module",
                            ecmaVersion: "latest"
                        }
                    },
                    plugins: {
                        "react": pluginReact,
                        "react-hooks": pluginReactHooks,
                        "jsx-a11y": pluginJsxA11y
                    },
                    // CRÍTICO: silencia warning a stdout que rompería JSON-RPC
                    settings: {
                        react: { version: "18.3.1" }
                    },
                    rules: {
                        "react-hooks/rules-of-hooks": "error",
                        "react-hooks/exhaustive-deps": "error",
                        "react/jsx-key": "error",
                        "jsx-a11y/alt-text": "error"
                    }
                }],
                fix: false
            });
            this.initialized = true;
            const setupMs = performance.now() - t0;
            logger.info(`React ESLint Shield setup: ${setupMs.toFixed(2)}ms (first lint will warm up plugins)`);
        } catch (err) {
            // Reset para permitir retry si fue I/O transitorio
            this.initPromise = null;
            logger.error(`ESLint shield failed to initialize: ${(err as Error).message}`);
            throw err;
        }
    }

    public async initialize(): Promise<void> {
        if (this.initialized) return;
        if (!this.initPromise) {
            this.initPromise = this._init();
        }
        await this.initPromise;
    }

    // Evaluar Anti-Sweep sobre el PAYLOAD (new_code/replace_text), no sobre archivo entero.
    // Esto evita bloquear edición de archivos legacy que ya contienen suppressions.
    public checkAntiSweep(payload: string): boolean {
        return ANTI_SWEEP_REGEX.test(payload);
    }

    public async validate(content: string, filePath: string): Promise<NrekiStructuredError[]> {
        const ext = path.extname(filePath).toLowerCase();
        if (!SUPPORTED_EXTS.has(ext)) return [];

        // Event loop starvation guard
        if (Buffer.byteLength(content, 'utf8') > MAX_FILE_SIZE) {
            logger.warn(`React ESLint bypassed on ${path.basename(filePath)}: file too large (${Buffer.byteLength(content, 'utf8')} bytes)`);
            return [];
        }

        // Fast-path: skip si no hay JSX ni hooks
        if (!JSX_QUICK_DETECT.test(content) && !HOOK_CALL_DETECT.test(content)) return [];

        try {
            await this.initialize();
            if (!this.eslint) return [];

            // Windows fix: ESLint 9 Flat Config usa picomatch con POSIX separators.
            // Backslashes de Windows no matchean "**/*.tsx" y el sidecar devuelve [] silencioso.
            const posixFilePath = filePath.replace(/\\/g, "/");

            let timeoutId: NodeJS.Timeout;
            const lintTask = this.eslint.lintText(content, { filePath: posixFilePath });

            // Previene UnhandledPromiseRejection si lintTask falla después del timeout
            lintTask.catch(() => {});

            const timeoutTask = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error("ESLint timeout (>3s)")), 3000);
            });

            let results: any;
            try {
                results = await Promise.race([lintTask, timeoutTask]);
            } finally {
                // Cleanup del timer para no contaminar event loop en batch de 50+ edits
                clearTimeout(timeoutId!);
            }

            if (!results || results.length === 0) return [];

            const errors: NrekiStructuredError[] = [];
            for (const msg of results[0].messages) {
                // Fatal parse errors ya capturados por tree-sitter en capa previa
                if (msg.fatal || !msg.ruleId) continue;

                if (msg.severity === 2 && TARGET_RULES.has(msg.ruleId)) {
                    const shortCode = msg.ruleId
                        .replace("react-hooks/", "")
                        .replace("react/", "")
                        .replace("jsx-a11y/", "");
                    errors.push({
                        file: filePath,  // path original para el agente
                        line: msg.line,
                        column: msg.column,
                        code: `REACT-${shortCode}`,
                        message: msg.message
                    });
                }
            }
            return errors;

        } catch (err) {
            logger.warn(`ESLint validation bypassed on ${path.basename(filePath)}: ${(err as Error).message}`);
            return [];  // Fail-open: no bloqueamos si el linter colapsa
        }
    }
}

export const reactEslintSidecar = new ReactEslintSidecar();
