import { ESLint } from "eslint";
import { performance } from "perf_hooks";
// Importaciones directas para forzar carga en RAM sin depender de resolución de strings
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginJsxA11y from "eslint-plugin-jsx-a11y";

const TARGET_CODE = `
import React, { useState, useEffect } from 'react';
export function UserProfile({ userId, items, avatarUrl }) {
    // BUG 1: Hook inside if (rules-of-hooks)
    if (userId) {
        const [data, setData] = useState(null);
    }
    const [count, setCount] = useState(0);
    // BUG 2: Missing dependency (exhaustive-deps)
    useEffect(() => {
        console.log(userId);
    }, []);
    return (
        <div>
            {/* BUG 3: Missing key in iterator (react/jsx-key) */}
            {items.map(item => (
                <span>{item.name}</span>
            ))}

            {/* BUG 4: Missing alt text (jsx-a11y/alt-text) */}
            <img src={avatarUrl} />
        </div>
    );
}
`;

const CLEAN_CODE = `
import React, { useState } from 'react';
export function CleanComponent({ items }) {
    const [count, setCount] = useState(0);
    return (
        <div>
            {items.map(item => (
                <span key={item.id}>{item.name}</span>
            ))}
        </div>
    );
}
`;

async function main() {
    console.log("=== NREKI v10.12.0 DIAGNOSTIC: ESLINT 9 IN-MEMORY ===\n");

    const t0 = performance.now();
    try {
        const eslint = new ESLint({
            overrideConfigFile: true,
            overrideConfig: [{
                files: ["**/*.js", "**/*.jsx", "**/*.ts", "**/*.tsx"],
                languageOptions: {
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
        });
        const tInit = performance.now() - t0;
        console.log(`[+] Engine Boot: ${tInit.toFixed(2)}ms`);

        // --- RUN 1: Código con los 4 bugs target ---
        const t1 = performance.now();
        const results = await eslint.lintText(TARGET_CODE, { filePath: "virtual.tsx" });
        const tLint = performance.now() - t1;
        console.log(`[+] AST Linting (buggy TARGET): ${tLint.toFixed(2)}ms\n`);

        const res = results[0];
        console.log(`Violations found: ${res.messages.length}\n`);

        for (const msg of res.messages) {
            console.log(`🔴 [${msg.ruleId}] L${msg.line}:${msg.column} -> ${msg.message}`);
            if (msg.fix) {
                console.log(`   🛠️  Auto-fix available: range [${msg.fix.range[0]}, ${msg.fix.range[1]}]`);
                console.log(`       Text: "${msg.fix.text.replace(/\n/g, "\\n")}"`);
            } else {
                console.log(`   ❌ No auto-fix available`);
            }
            console.log("--------------------------------------------------");
        }

        // --- RUN 2: Baseline sobre código limpio ---
        const t2 = performance.now();
        const cleanResults = await eslint.lintText(CLEAN_CODE, { filePath: "clean.tsx" });
        const tClean = performance.now() - t2;
        console.log(`\n[+] Clean file (baseline, no bugs): ${tClean.toFixed(2)}ms`);
        console.log(`    Violations in clean file: ${cleanResults[0].messages.length} (expected: 0)`);

        // --- RUN 3: Stress test sobre archivo grande ---
        const BIG_CODE = CLEAN_CODE.repeat(20);
        const t3 = performance.now();
        const bigResults = await eslint.lintText(BIG_CODE, { filePath: "big.tsx" });
        const tBig = performance.now() - t3;
        console.log(`[+] Big file (20x clean, ${BIG_CODE.length} chars): ${tBig.toFixed(2)}ms`);
        console.log(`    Violations in big file: ${bigResults[0].messages.length} (expected: 0)`);
        console.log(`[+] Linear scaling factor: ${(tBig / tClean).toFixed(2)}x (perfect linear = 20x)`);

        // --- RUN 4: Warm cache re-run del buggy code (mide cache efectiveness) ---
        const t4 = performance.now();
        await eslint.lintText(TARGET_CODE, { filePath: "virtual.tsx" });
        const tWarm = performance.now() - t4;
        console.log(`\n[+] Warm re-run of TARGET_CODE: ${tWarm.toFixed(2)}ms`);
        console.log(`    Cache speedup vs cold: ${(tLint / tWarm).toFixed(2)}x`);

        console.log("\n=== DIAGNOSTIC COMPLETE ===");

    } catch (err) {
        console.error("FATAL ERROR:", err);
        if (err instanceof Error) {
            console.error("Stack:", err.stack);
        }
        process.exit(1);
    }
}

main();
