import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NrekiEngine } from "../src/engine.js";
import fs from "fs";
import path from "path";
import os from "os";

// Tests del comportamiento de DEFAULT_IGNORE para artifacts NREKI.
// Diseño Black-Box: solo API pública de NrekiEngine. Cero acceso a
// internals, cero escape de tipos, compatible con tsconfig strict:true.
//
// Verificación empírica:
// - Setup: tmpDir con mix de archivos legítimos y artifacts NREKI
// - Trigger: indexDirectory recorre el árbol completo
// - Assert: getStats().filesIndexed solo cuenta archivos legítimos

describe("DEFAULT_IGNORE for NREKI artifacts", () => {
    let tmpDir: string;
    let dbPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(
            path.join(os.tmpdir(), `nreki-ignore-test-${Date.now()}-`)
        );
        // dbPath fuera de tmpDir para que no intervenga en el indexing
        dbPath = path.join(
            os.tmpdir(),
            `nreki-ignore-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
        );
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
        try { fs.unlinkSync(dbPath.replace(/\.db$/, ".vec")); } catch { /* ignore */ }
    });

    it("Test 1: indexDirectory ignores files inside .nreki/ directory", async () => {
        // Crear archivo legítimo en root
        fs.writeFileSync(
            path.join(tmpDir, "legit.ts"),
            "export function legit() { return 1; }"
        );

        // Crear .nreki/ con archivo dentro que parezca código legítimo
        const nrekiDir = path.join(tmpDir, ".nreki");
        fs.mkdirSync(nrekiDir);
        fs.writeFileSync(
            path.join(nrekiDir, "inner.ts"),
            "export function shouldNotBeIndexed() { return 99; }"
        );
        fs.writeFileSync(
            path.join(nrekiDir, "repo-map.json"),
            '{"file":"data","key":"value"}'
        );

        const engine = new NrekiEngine({
            dbPath: dbPath,
            watchPaths: [tmpDir],
        });
        await engine.initialize();
        await engine.indexDirectory(tmpDir);

        const stats = engine.getStats();
        // Solo legit.ts debería estar indexado. inner.ts y repo-map.json NO.
        expect(stats.filesIndexed).toBe(1);
        engine.shutdown();
    });

    it("Test 2: indexDirectory ignores .nreki.db and its .tmp variants", async () => {
        // Crear archivo legítimo
        fs.writeFileSync(
            path.join(tmpDir, "legit.ts"),
            "export function legit() { return 1; }"
        );

        // Crear archivos de base de datos NREKI que el walker NO debe ver
        // (son binarios, pero los creamos como dummies de texto para test)
        fs.writeFileSync(
            path.join(tmpDir, ".nreki.db"),
            "SQLITE_DUMMY"
        );
        fs.writeFileSync(
            path.join(tmpDir, ".nreki.db.tmp"),
            "SQLITE_DUMMY_TMP"
        );
        fs.writeFileSync(
            path.join(tmpDir, ".nreki.db.5b74eb8b.tmp"),
            "SQLITE_DUMMY_HEX_TMP"
        );

        const engine = new NrekiEngine({
            dbPath: dbPath,
            watchPaths: [tmpDir],
        });
        await engine.initialize();
        await engine.indexDirectory(tmpDir);

        const stats = engine.getStats();
        // Solo legit.ts debería estar indexado. Los .db* NO.
        expect(stats.filesIndexed).toBe(1);
        engine.shutdown();
    });
});
