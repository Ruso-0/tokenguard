/**
 * verify-basedpyright-spawn.ts
 *
 * Directly boots PythonLspSidecar and reports whether the langserver
 * process spawns on the current platform. Bypasses MCP — we want
 * empirical Windows behavior, not a registration log.
 *
 * Usage: npx tsx scripts/verify-basedpyright-spawn.ts <projectRoot>
 * Exits 0 on successful spawn, 1 on failure.
 */

import { PythonLspSidecar } from "../src/kernel/backends/python-sidecar.js";

const projectRoot = process.argv[2] || process.cwd();

async function main() {
    console.log(`[verify] platform=${process.platform} node=${process.version}`);
    console.log(`[verify] projectRoot=${projectRoot}`);

    const sidecar = new PythonLspSidecar(projectRoot);
    console.log(`[verify] command=${JSON.stringify(sidecar.command)}`);

    const start = Date.now();
    try {
        await sidecar.boot();
        const ms = Date.now() - start;
        console.log(`[verify] OUTCOME=SPAWN_OK elapsed=${ms}ms`);
        await sidecar.shutdown();
        process.exit(0);
    } catch (err) {
        const ms = Date.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[verify] OUTCOME=SPAWN_FAIL elapsed=${ms}ms error=${msg}`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.log(`[verify] OUTCOME=UNCAUGHT error=${err?.message ?? err}`);
    process.exit(2);
});
