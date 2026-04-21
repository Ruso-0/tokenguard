/**
 * Patch 5 (v10.5.9) — LSP auto-healer atomic multi-TextEdit.
 *
 * Pre-fix: attemptLspAutoHealing picked `safeFixes[0]` (flat shape) and
 * applied ONE TextEdit. If the CodeAction required coupled edits (e.g.,
 * "add import at line 1 + fix usage at line 50"), only one landed.
 * Validation then saw the other error still live, rolled back, marked
 * the fix failed, and the agent retried in a doom-loop.
 *
 * Post-fix: requestCodeActions returns LspCodeAction[] where each action
 * carries an edits[] array. attemptLspAutoHealing groups edits by file,
 * creates savepoints for ALL files first, and applies bottom-up
 * (descending startLine) so offset math stays correct. Atomic rollback
 * on any single failure.
 */
import { describe, it, expect } from "vitest";
import { attemptLspAutoHealing } from "../src/kernel/healer.js";
import type {
    LspHealingContext, LspCodeAction, LspDiagnostic,
    NrekiStructuredError, MicroUndoState,
} from "../src/kernel/types.js";

interface StubFileState {
    content: string;
    savepointCount: number;
}

function makeStubContext(opts: {
    files: Map<string, StubFileState>;
    codeActions: LspCodeAction[];
    validate: (files: Set<string>) => NrekiStructuredError[];
}): { ctx: LspHealingContext; rollbacks: number; applyCalls: string[] } {
    const rollbacksRef = { count: 0 };
    const applyCalls: string[] = [];

    const ctx: LspHealingContext = {
        languageId: "test",
        isDead: () => false,
        resolvePath: (p) => p,
        readContent: (p) => {
            const f = opts.files.get(p);
            if (!f) throw new Error(`stub: no file ${p}`);
            return f.content;
        },
        createSavepoint: (p): MicroUndoState => {
            const f = opts.files.get(p);
            if (f) f.savepointCount++;
            return { content: f?.content ?? null, time: undefined };
        },
        applyMicroPatch: (p, content) => {
            const f = opts.files.get(p);
            if (f) f.content = content;
            applyCalls.push(p);
        },
        getLspOffset: (content, line, character) => {
            // Convert (line, char) to byte offset.
            const lines = content.split("\n");
            let offset = 0;
            for (let i = 0; i < line; i++) offset += (lines[i]?.length ?? 0) + 1;
            return offset + character;
        },
        requestCodeActions: async (_file: string, _diag: LspDiagnostic) => opts.codeActions,
        validateLspEdits: async (files) => opts.validate(files),
        executeRollback: async (undoLog, _isMacro) => {
            rollbacksRef.count++;
            for (const [p, state] of undoLog) {
                if (state.content !== undefined && state.content !== null) {
                    const f = opts.files.get(p);
                    if (f) f.content = state.content;
                }
            }
        },
        recordStat: () => { /* noop */ },
    };

    return {
        ctx,
        get rollbacks() { return rollbacksRef.count; },
        applyCalls,
    };
}

describe("attemptLspAutoHealing — atomic multi-TextEdit (Patch 5 / v10.5.9)", () => {
    it("applies ALL TextEdits of a multi-edit CodeAction atomically", async () => {
        const files = new Map<string, StubFileState>([
            ["test.ts", { content: "// line 0\nfoo.Bar()\n", savepointCount: 0 }],
        ]);
        const codeActions: LspCodeAction[] = [{
            title: "Add import 'foo'",
            edits: [
                {
                    filePath: "test.ts",
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    newText: "import foo from 'foo';\n",
                },
                {
                    filePath: "test.ts",
                    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } },
                    newText: "foo.Baz()",
                },
            ],
        }];

        const errors: NrekiStructuredError[] = [{
            file: "test.ts", line: 2, column: 1, code: "test", message: "missing import",
        }];

        let validateCalls = 0;
        const stub = makeStubContext({
            files, codeActions,
            validate: () => { validateCalls++; return []; }, // healing succeeds immediately
        });

        const result = await attemptLspAutoHealing(errors, new Set(), stub.ctx);

        expect(result.healed).toBe(true);
        expect(result.appliedFixes.length).toBe(1);
        expect(result.appliedFixes[0]).toContain("Add import");
        // Both edits landed: content has the import AND the Bar -> Baz substitution.
        const finalContent = files.get("test.ts")!.content;
        expect(finalContent).toContain("import foo from 'foo';");
        expect(finalContent).toContain("foo.Baz()");
        expect(finalContent).not.toContain("foo.Bar()");
        expect(stub.rollbacks).toBe(0);
        expect(validateCalls).toBe(1);
    });

    it("rolls back ALL edits when validation fails after multi-edit apply", async () => {
        const originalContent = "// line 0\nfoo.Bar()\n";
        const files = new Map<string, StubFileState>([
            ["test.ts", { content: originalContent, savepointCount: 0 }],
        ]);
        const codeActions: LspCodeAction[] = [{
            title: "Add import",
            edits: [
                {
                    filePath: "test.ts",
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    newText: "import foo from 'foo';\n",
                },
                {
                    filePath: "test.ts",
                    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } },
                    newText: "foo.Baz()",
                },
            ],
        }];
        const errors: NrekiStructuredError[] = [{
            file: "test.ts", line: 2, column: 1, code: "test", message: "missing import",
        }];

        // Validation claims the same number of errors (no improvement) → rollback.
        const stub = makeStubContext({
            files, codeActions,
            validate: () => errors,
        });

        const result = await attemptLspAutoHealing(errors, new Set(), stub.ctx);

        expect(result.healed).toBe(false);
        expect(stub.rollbacks).toBeGreaterThanOrEqual(1);
        // Content restored — both edits were reverted atomically.
        expect(files.get("test.ts")!.content).toBe(originalContent);
    });

    it("applies TextEdits on same file in descending-line order (no offset drift)", async () => {
        // Two edits on same file: one near top (line 1) and one further down (line 3).
        // Applied bottom-up so the top edit's offset remains valid.
        const initial = [
            "line0",
            "A",       // line 1 — will become "AAA"
            "filler",  // line 2
            "B",       // line 3 — will become "BBB"
            "",
        ].join("\n");
        const files = new Map<string, StubFileState>([
            ["f.ts", { content: initial, savepointCount: 0 }],
        ]);
        const codeActions: LspCodeAction[] = [{
            title: "Add import corrections",
            edits: [
                // Note the non-sorted order to prove the helper sorts internally.
                {
                    filePath: "f.ts",
                    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
                    newText: "AAA",
                },
                {
                    filePath: "f.ts",
                    range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } },
                    newText: "BBB",
                },
            ],
        }];
        const errors: NrekiStructuredError[] = [{
            file: "f.ts", line: 1, column: 1, code: "test", message: "x",
        }];
        const stub = makeStubContext({
            files, codeActions,
            validate: () => [],
        });

        await attemptLspAutoHealing(errors, new Set(), stub.ctx);

        const expected = [
            "line0",
            "AAA",
            "filler",
            "BBB",
            "",
        ].join("\n");
        expect(files.get("f.ts")!.content).toBe(expected);
    });

    it("handles a CodeAction spanning multiple files — savepoints for both", async () => {
        const files = new Map<string, StubFileState>([
            ["a.ts", { content: "A", savepointCount: 0 }],
            ["b.ts", { content: "B", savepointCount: 0 }],
        ]);
        const codeActions: LspCodeAction[] = [{
            title: "Add import across package",
            edits: [
                {
                    filePath: "a.ts",
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                    newText: "AA",
                },
                {
                    filePath: "b.ts",
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                    newText: "BB",
                },
            ],
        }];
        const errors: NrekiStructuredError[] = [{
            file: "a.ts", line: 1, column: 1, code: "test", message: "x",
        }];
        const stub = makeStubContext({
            files, codeActions,
            validate: () => [],
        });

        const result = await attemptLspAutoHealing(errors, new Set(), stub.ctx);

        expect(result.healed).toBe(true);
        expect(files.get("a.ts")!.content).toBe("AA");
        expect(files.get("b.ts")!.content).toBe("BB");
        expect(files.get("a.ts")!.savepointCount).toBe(1);
        expect(files.get("b.ts")!.savepointCount).toBe(1);
        expect(result.newlyTouchedFiles.has("a.ts")).toBe(true);
        expect(result.newlyTouchedFiles.has("b.ts")).toBe(true);
    });

    it("Ice Wall whitelist rejects destructive CodeActions (remove/delete)", async () => {
        const files = new Map<string, StubFileState>([
            ["x.ts", { content: "keep\n", savepointCount: 0 }],
        ]);
        const codeActions: LspCodeAction[] = [{
            title: "Remove unused function",
            edits: [{
                filePath: "x.ts",
                range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
                newText: "",
            }],
        }];
        const errors: NrekiStructuredError[] = [{
            file: "x.ts", line: 1, column: 1, code: "test", message: "unused",
        }];
        const stub = makeStubContext({
            files, codeActions,
            validate: () => [],
        });

        const result = await attemptLspAutoHealing(errors, new Set(), stub.ctx);

        expect(result.healed).toBe(false);
        expect(files.get("x.ts")!.content).toBe("keep\n"); // untouched
    });

    it("Anti-Sweep shield rejects suppression CodeActions (ignore/noqa)", async () => {
        const files = new Map<string, StubFileState>([
            ["x.py", { content: "import os\n", savepointCount: 0 }],
        ]);
        const codeActions: LspCodeAction[] = [{
            title: "Add `# pyright: ignore[reportMissingImports]`",
            edits: [{
                filePath: "x.py",
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: "# pyright: ignore[reportMissingImports]\n",
            }],
        }];
        const errors: NrekiStructuredError[] = [{
            file: "x.py", line: 1, column: 1, code: "test", message: "missing",
        }];
        const stub = makeStubContext({
            files, codeActions,
            validate: () => [],
        });

        const result = await attemptLspAutoHealing(errors, new Set(), stub.ctx);

        // The only action was a suppression — filter rejects it,
        // healer returns not healed, file untouched.
        expect(result.healed).toBe(false);
        expect(files.get("x.py")!.content).toBe("import os\n");
    });
});
