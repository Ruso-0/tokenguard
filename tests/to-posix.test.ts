import { describe, it, expect } from "vitest";
import { toPosix } from "../src/utils/to-posix.js";

// Characterization tests para toPosix() en v10.18.1.
//
// Estos tests documentan el COMPORTAMIENTO ACTUAL de toPosix, que es:
// - Convertir backslashes a forward slashes (cross-platform)
// - PRESERVAR el casing del drive letter en Windows (C: stays C:, c: stays c:)
// - PRESERVAR el casing del resto del path en cualquier plataforma
//
// Por qué preservación del casing es CARACTERIZACIÓN (no contrato deseado):
// El sistema actualmente confía en igualdad estricta de strings de paths
// como llaves en VFS (currentEditTargets, prunedTsLookup, jitClassifiedCache).
// Forzar canonicalización del casing en toPosix sin refactorizar los ~30
// sitios consumidores en nreki-kernel.ts produce desfase de Sets y
// regresión de tests del JIT (verificado empíricamente en sprint v10.18.1).
//
// Cuando el sprint dedicado post-v10.19.0 implemente "VFS Path Canonicalization"
// (registrado en TECH_DEBT.md), estos tests fallarán a propósito, marcando
// exactamente el cambio del contrato arquitectónico.

describe("toPosix - cross-platform path normalization", () => {
    // ─── POSIX-safe tests (run on all platforms) ─────────────────

    it("converts backslashes to forward slashes", () => {
        const result = toPosix("foo\\bar\\baz");
        expect(result).toBe("foo/bar/baz");
    });

    it("preserves forward slashes already present", () => {
        const result = toPosix("foo/bar/baz");
        expect(result).toBe("foo/bar/baz");
    });

    it("normalizes redundant separators", () => {
        // path.normalize collapses multiple slashes to single
        const result = toPosix("foo//bar///baz");
        expect(result).toBe("foo/bar/baz");
    });

    it("preserves mixed case in path segments", () => {
        const result = toPosix("MyProject/SubDir/File.ts");
        expect(result).toBe("MyProject/SubDir/File.ts");
    });

    // ─── Windows-only characterization tests ─────────────────────
    // Estos tests documentan el comportamiento ACTUAL en Windows.
    // Cuando se implemente VFS Path Canonicalization en sprint
    // post-v10.19.0, fallarán a propósito.

    it.skipIf(process.platform !== "win32")(
        "Windows: uppercase drive letter is PRESERVED (current behavior)",
        () => {
            const result = toPosix("C:\\foo\\bar");
            // Característica actual: casing intacto. Cambiará en VFS refactor.
            expect(result).toBe("C:/foo/bar");
        }
    );

    it.skipIf(process.platform !== "win32")(
        "Windows: lowercase drive letter is PRESERVED (current behavior)",
        () => {
            const result = toPosix("c:\\foo\\bar");
            expect(result).toBe("c:/foo/bar");
        }
    );

    it.skipIf(process.platform !== "win32")(
        "Windows: mixed case in path body is preserved alongside drive letter",
        () => {
            const result = toPosix("E:\\MyProject\\SubDir");
            expect(result).toBe("E:/MyProject/SubDir");
        }
    );
});
