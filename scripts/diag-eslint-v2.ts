import { ESLint } from "eslint";
import { performance } from "perf_hooks";

// Test 1: Espree (parser default) contra TSX con types reales
const TSX_WITH_TYPES = `
import React, { useState, useMemo, useEffect } from 'react';

interface User {
    id: string;
    name: string;
}

interface Props {
    userId: string;
    items: Array<{ id: string; name: string }>;
    avatarUrl: string;
}

export function UserProfile({ userId, items, avatarUrl }: Props) {
    const [count, setCount] = useState<number>(0);
    const data = useMemo<User | null>(() => null, []);

    useEffect(() => {
        console.log(userId);
    }, []);

    return (
        <div>
            {items.map(item => (
                <span>{item.name}</span>
            ))}
            <img src={avatarUrl} />
        </div>
    );
}
`;

// Test 2: Código simple JSX sin TypeScript (baseline para comparar)
const JSX_PLAIN = `
import React, { useState } from 'react';
export function PlainComponent({ items }) {
    const [count, setCount] = useState(0);
    return <div>{items.map(i => <span>{i.name}</span>)}</div>;
}
`;

async function runEslint(
    label: string,
    useTypescriptParser: boolean,
    useEslintrcFlag: "include" | "omit",
    code: string,
    filePath: string
): Promise<void> {
    console.log(`\n─── ${label} ───`);
    console.log(`  parser: ${useTypescriptParser ? "@typescript-eslint/parser" : "espree (default)"}`);
    console.log(`  useEslintrc flag: ${useEslintrcFlag}`);

    try {
        // Lazy import plugins
        const reqReact = await import("eslint-plugin-react");
        const pluginReact = (reqReact as any).default || reqReact;
        const reqHooks = await import("eslint-plugin-react-hooks");
        const pluginReactHooks = (reqHooks as any).default || reqHooks;
        const reqA11y = await import("eslint-plugin-jsx-a11y");
        const pluginJsxA11y = (reqA11y as any).default || reqA11y;

        let parserConfig: any = undefined;
        if (useTypescriptParser) {
            const tsParserModule = await import("@typescript-eslint/parser");
            parserConfig = (tsParserModule as any).default ?? tsParserModule;
        }

        const configOptions: any = {
            overrideConfigFile: true,
            overrideConfig: [{
                files: ["**/*.js", "**/*.jsx", "**/*.ts", "**/*.tsx"],
                languageOptions: {
                    ...(parserConfig ? { parser: parserConfig } : {}),
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
                rules: {
                    "react-hooks/rules-of-hooks": "error",
                    "react-hooks/exhaustive-deps": "error",
                    "react/jsx-key": "error",
                    "jsx-a11y/alt-text": "error"
                }
            }],
            fix: false
        };

        // Test flag useEslintrc: false (si "include")
        if (useEslintrcFlag === "include") {
            configOptions.useEslintrc = false;
        }

        const t0 = performance.now();
        const eslint = new ESLint(configOptions);
        const tInit = performance.now() - t0;

        const t1 = performance.now();
        const results = await eslint.lintText(code, { filePath });
        const tLint = performance.now() - t1;

        console.log(`  ✅ Init: ${tInit.toFixed(2)}ms | Lint: ${tLint.toFixed(2)}ms`);

        const res = results[0];
        const fatalCount = res.messages.filter(m => m.fatal).length;
        const ruleCount = res.messages.filter(m => !m.fatal && m.ruleId).length;

        console.log(`  Total messages: ${res.messages.length} (fatal: ${fatalCount}, rule violations: ${ruleCount})`);

        if (fatalCount > 0) {
            const fatal = res.messages.filter(m => m.fatal)[0];
            console.log(`  🔴 FATAL PARSE ERROR: L${fatal.line}:${fatal.column} → ${fatal.message}`);
        }

        for (const msg of res.messages.filter(m => !m.fatal && m.ruleId)) {
            console.log(`  🟡 [${msg.ruleId}] L${msg.line}:${msg.column} → ${msg.message.substring(0, 80)}`);
        }

    } catch (err) {
        const e = err as Error;
        console.log(`  ❌ EXCEPTION: ${e.message}`);
        if (e.message.includes("useEslintrc") || e.message.includes("Unexpected")) {
            console.log(`  ⚠️  SIGNAL: this error likely confirms a crime hypothesis`);
        }
    }
}

async function main() {
    console.log("=== NREKI v10.12.0 DIAGNOSTIC v2 — CRIME VERIFICATION ===");
    console.log("Verifying Pipipi's code hypotheses empirically before platform injection.\n");

    // ══════════════════════════════════════════════════════════════
    // CRIMEN 1: ¿useEslintrc: false truena en ESLint 9.39.4?
    // ══════════════════════════════════════════════════════════════
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("CRIMEN 1: useEslintrc flag in ESLint 9.39.4");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    await runEslint(
        "1A — WITH useEslintrc:false (Pipipi's code)",
        true, "include", JSX_PLAIN, "crime1a.tsx"
    );
    await runEslint(
        "1B — WITHOUT useEslintrc (Claude's fix)",
        true, "omit", JSX_PLAIN, "crime1b.tsx"
    );

    // ══════════════════════════════════════════════════════════════
    // CRIMEN 2: Espree vs @typescript-eslint/parser con TSX real
    // ══════════════════════════════════════════════════════════════
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("CRIMEN 2/BLINDSPOT: TSX with types — parser matters?");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    await runEslint(
        "2A — Espree parser + TSX with interfaces/generics",
        false, "omit", TSX_WITH_TYPES, "crime2a.tsx"
    );
    await runEslint(
        "2B — @typescript-eslint/parser + TSX with interfaces/generics",
        true, "omit", TSX_WITH_TYPES, "crime2b.tsx"
    );

    // ══════════════════════════════════════════════════════════════
    // CRIMEN 3: Patrón de carga de tsParser (default vs module namespace)
    // ══════════════════════════════════════════════════════════════
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("CRIMEN 3: tsParser loading pattern inspection");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    try {
        const mod: any = await import("@typescript-eslint/parser");
        console.log(`  Module keys: ${Object.keys(mod).join(", ")}`);
        console.log(`  Has .default: ${!!mod.default}`);
        console.log(`  Has .parse: ${typeof mod.parse}`);
        console.log(`  Has .parseForESLint: ${typeof mod.parseForESLint}`);
        if (mod.default) {
            console.log(`  .default has .parseForESLint: ${typeof mod.default.parseForESLint}`);
        }
        console.log(`  → Correct usage: ${mod.default ? "tsParserModule.default" : "tsParserModule directly"}`);
    } catch (err) {
        console.log(`  ❌ Cannot import: ${(err as Error).message}`);
    }

    console.log("\n=== DIAGNOSTIC v2 COMPLETE ===");
}

main().catch(err => {
    console.error("FATAL:", err);
    process.exit(1);
});
