import { describe, it, expect, beforeAll } from "vitest";
import { ReactEslintSidecar } from "../src/eslint-sidecar.js";

describe("React ESLint Sidecar — v10.12.0", () => {
    let sidecar: ReactEslintSidecar;

    beforeAll(async () => {
        sidecar = new ReactEslintSidecar();
        await sidecar.initialize();
    });

    it("detects rules-of-hooks violation (useState inside if)", async () => {
        const code = `
import { useState } from 'react';
export function Bad({ userId }) {
    if (userId) {
        const [x] = useState(null);
    }
    return <div />;
}`;
        const errors = await sidecar.validate(code, "bad.tsx");
        expect(errors.some(e => e.code === "REACT-rules-of-hooks")).toBe(true);
    });

    it("detects exhaustive-deps on TSX with interfaces and generics", async () => {
        const code = `
import { useEffect, useState } from 'react';
interface Props { userId: string; items: string[]; }
export function Good({ userId }: Props) {
    const [x, setX] = useState<number>(0);
    useEffect(() => { console.log(userId); }, []);
    return <div />;
}`;
        const errors = await sidecar.validate(code, "deps.tsx");
        expect(errors.some(e => e.code === "REACT-exhaustive-deps")).toBe(true);
    });

    it("detects jsx-key violation in iterator", async () => {
        const code = `
export function List({ items }) {
    return <div>{items.map(i => <span>{i.name}</span>)}</div>;
}`;
        const errors = await sidecar.validate(code, "list.tsx");
        expect(errors.some(e => e.code === "REACT-jsx-key")).toBe(true);
    });

    it("detects alt-text violation on img", async () => {
        const code = `
export function Avatar({ url }) {
    return <img src={url} />;
}`;
        const errors = await sidecar.validate(code, "img.tsx");
        expect(errors.some(e => e.code === "REACT-alt-text")).toBe(true);
    });

    it("Anti-Sweep: detects line-comment eslint-disable on payload", async () => {
        const payload = `// eslint-disable-next-line react-hooks/rules-of-hooks
const [x] = useState(null);`;
        expect(sidecar.checkAntiSweep(payload)).toBe(true);
    });

    it("Anti-Sweep: detects JSX block-comment eslint-disable on payload", async () => {
        const payload = `{/* eslint-disable-next-line react/jsx-key */}
{items.map(i => <span>{i}</span>)}`;
        expect(sidecar.checkAntiSweep(payload)).toBe(true);
    });

    it("Anti-Sweep: detects comma-separated rule list bypass", async () => {
        const payload = `// eslint-disable no-console, react-hooks/exhaustive-deps
useEffect(() => {}, []);`;
        expect(sidecar.checkAntiSweep(payload)).toBe(true);
    });

    it("Anti-Sweep: does NOT flag non-target rules", async () => {
        const payload = `// eslint-disable-next-line no-console
console.log("ok");`;
        expect(sidecar.checkAntiSweep(payload)).toBe(false);
    });

    it("skips files without JSX or hook calls (quick-detect filter)", async () => {
        const code = `
export function utility(a: number, b: number): number {
    return a + b;
}`;
        const errors = await sidecar.validate(code, "util.ts");
        expect(errors.length).toBe(0);
    });

    it("accepts clean TSX with types, hooks, fragments, and namespaced components", async () => {
        const code = `
import { useState, useMemo, createContext } from 'react';
interface Item { id: string; name: string; }
interface Props { items: Item[]; }
const MyContext = createContext(null);
export function Good({ items }: Props) {
    const [count, setCount] = useState<number>(0);
    const total = useMemo(() => items.length, [items]);
    return (
        <MyContext.Provider value={null}>
            <>
                {items.map(item => (
                    <span key={item.id}>{item.name}</span>
                ))}
            </>
        </MyContext.Provider>
    );
}`;
        const errors = await sidecar.validate(code, "clean.tsx");
        expect(errors.length).toBe(0);
    });

    it("bypasses files larger than 150KB (event loop starvation guard)", async () => {
        const big = "const x = 1;\n".repeat(13000);  // ~150KB+
        const errors = await sidecar.validate(big, "big.tsx");
        expect(errors.length).toBe(0);
    });

    it("handles modern module extensions according to TS spec (.mjs, .cjs, .mts, .cts)", async () => {
        // 1. Dominio UI (JSX): válido en .mjs/.cjs.
        const jsxCode = `import React from 'react'; export const List = ({items}) => <div>{items.map(i => <span>{i}</span>)}</div>;`;
        const errorsMjs = await sidecar.validate(jsxCode, "test.mjs");
        const errorsCjs = await sidecar.validate(jsxCode, "test.cjs");

        expect(errorsMjs.some(e => e.code === "REACT-jsx-key")).toBe(true);
        expect(errorsCjs.some(e => e.code === "REACT-jsx-key")).toBe(true);

        // 2. Dominio Lógica (Hooks): JSX no válido en .mts/.cts (TS spec),
        //    pero Custom Hooks sí aplican.
        const hookCode = `import { useState } from 'react'; export function useBadHook(cond: boolean) { if (cond) { useState(0); } }`;
        const errorsMts = await sidecar.validate(hookCode, "test.mts");
        const errorsCts = await sidecar.validate(hookCode, "test.cts");

        expect(errorsMts.some(e => e.code === "REACT-rules-of-hooks")).toBe(true);
        expect(errorsCts.some(e => e.code === "REACT-rules-of-hooks")).toBe(true);
    });

    it("skips non-JS/TS file extensions", async () => {
        const errors = await sidecar.validate("<div />", "something.md");
        expect(errors.length).toBe(0);
    });
});
