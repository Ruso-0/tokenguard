import { beforeAll, describe, expect, it } from "vitest";
import { ASTParser } from "../src/parser.js";
import { AstSandbox } from "../src/ast-sandbox.js";

describe("TSX grammar", () => {
    let parser: ASTParser;
    let sandbox: AstSandbox;

    beforeAll(async () => {
        parser = new ASTParser();
        sandbox = new AstSandbox();
        await parser.initialize();
        await sandbox.initialize();
    });

    async function expectValidTsx(code: string): Promise<void> {
        const language = sandbox.detectLanguage("component.tsx");
        expect(language).toBe("tsx");
        const validation = await sandbox.validateCode(code, language!);
        expect(validation.valid).toBe(true);
    }

    it("indexes function components with JSX", async () => {
        const code = "export function App() { return <div>Hi</div>; }";

        await expectValidTsx(code);
        const result = await parser.parse("component.tsx", code);

        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0].symbolName).toBe("App");
        expect(result.chunks[0].rawCode).toContain("<div>Hi</div>");
    });

    it("indexes arrow components with JSX", async () => {
        const code = "export const Comp = () => <div/>;";

        await expectValidTsx(code);
        const result = await parser.parse("component.tsx", code);

        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0].symbolName).toBe("Comp");
    });

    it("parses JSX tags with arrow callbacks inside expressions", async () => {
        const code = "const x = <Button onClick={() => y}>click</Button>;";

        await expectValidTsx(code);
        const result = await parser.parse("component.tsx", code);

        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0].symbolName).toBe("x");
    });

    it("parses generic arrow functions without colliding with JSX", async () => {
        const code = "const x = <T,>(v: T) => v;";

        await expectValidTsx(code);
        const result = await parser.parse("component.tsx", code);

        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0].symbolName).toBe("x");
    });

    it("parses generic function components with JSX", async () => {
        const code = "export function Comp<T>(p: T) { return <div>{p}</div>; }";

        await expectValidTsx(code);
        const result = await parser.parse("component.tsx", code);

        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0].symbolName).toBe("Comp");
        expect(result.chunks[0].rawCode).toContain("<div>{p}</div>");
    });
});
