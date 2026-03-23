import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ASTParser } from '../src/parser.js';
import { generateRepoMap, computePageRank } from '../src/repo-map.js';
import { SpectralMath, SparseEdge } from '../src/kernel/spectral-topology.js';

/**
 * Chronos Miner v2 — Indestructible Temporal Dataset Extractor
 *
 * Uses Tree-sitter (Layer 1) instead of TypeScript Compiler (Layer 2).
 * Zero node_modules. Zero tsconfig. Mines ANY TypeScript/JavaScript repo.
 *
 * Features per node: [PageRank, ChurnVelocity, v2_signed, |v2|, v3_signed, |v3|]
 * Ground Truth: Lookahead Window T+5 with causal overlap + architectural dispersion
 *
 * Usage: npx tsx scripts/chronos-miner.ts <repo-url>
 * Output: <repo-name>_stgt_dataset.jsonl
 *
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 */

export async function mineIndestructibleHistory(repoUrl: string, worktreeName: string = 'nreki-miner-wt') {
    const repoName = repoUrl.split('/').pop()!.replace('.git', '');
    const cloneDir = path.resolve(`/tmp/nreki-bare-${repoName}`);
    const wtPath = path.resolve(`/tmp/${worktreeName}`);
    const outputFile = path.resolve(process.cwd(), `${repoName}_stgt_dataset.jsonl`);

    console.log(`[MINER] Repository: ${repoName}`);
    console.log(`[MINER] Bare clone: ${cloneDir}`);
    console.log(`[MINER] Output: ${outputFile}`);

    if (!fs.existsSync(cloneDir)) {
        console.log('[MINER] Cloning bare...');
        execSync(`git clone --bare ${repoUrl} ${cloneDir}`, { stdio: 'inherit' });
    }

    // RESUMABLE MINING: skip already-processed commits
    const processedCommits = new Set<string>();
    if (fs.existsSync(outputFile)) {
        const lines = fs.readFileSync(outputFile, 'utf-8').split('\n').filter(Boolean);
        lines.forEach(l => { try { processedCommits.add(JSON.parse(l).commit); } catch {} });
        console.log(`[MINER] Resuming... Skipping ${processedCommits.size} commits.`);
    }

    const logRaw = execSync('git log --format="%H|%s" --reverse -n 5000', { cwd: cloneDir, maxBuffer: 100 * 1024 * 1024 })
        .toString().trim().split('\n').filter(Boolean);

    const rawSnapshots: any[] = [];
    const fileChurn = new Map<string, number>();

    // Initialize Layer 1 (Tree-sitter — zero node_modules, multi-language)
    const parser = new ASTParser();
    await parser.initialize();

    console.log(`[MINER] Mining ${logRaw.length} commits using Layer 1 AST Topology...`);

    // ─── PHASE 1: INDESTRUCTIBLE TOPOLOGICAL EXTRACTION ───
    for (let i = 1; i < logRaw.length; i++) {
        if (!logRaw[i]) continue;
        const [hash, ...msgParts] = logRaw[i].split('|');
        const msg = msgParts.join('|').toLowerCase();

        // Anti-Mechanical-Noise filter
        const isRefactor = /refactor|rename|format|lint|prettier|chore/i.test(msg);

        // Extract code-only diff
        let codeFilesChanged: string[] = [];
        try {
            const diffRaw = execSync(`git diff --name-only ${logRaw[i - 1].split('|')[0]} ${hash}`, { cwd: cloneDir, maxBuffer: 50 * 1024 * 1024 })
                .toString().trim().split('\n');
            codeFilesChanged = diffRaw.filter(f => /\.(ts|tsx|js|jsx)$/i.test(f) && !f.includes('.test.') && !f.includes('.spec.'));
        } catch { continue; }

        // Kinetic Churn decay ALWAYS computed to maintain inertia
        for (const f of codeFilesChanged) fileChurn.set(f, (fileChurn.get(f) || 0) + 1);
        for (const key of fileChurn.keys()) fileChurn.set(key, fileChurn.get(key)! * 0.95);

        if (processedCommits.has(hash)) continue;

        if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true });
        try {
            execSync(`git worktree add --detach ${wtPath} ${hash}`, { cwd: cloneDir, stdio: 'ignore' });
        } catch { continue; }

        try {
            // THE FERRARI: Extract graph in O(files) WITHOUT the TS Compiler
            const repoMap = await generateRepoMap(wtPath, parser);
            if (!repoMap.graph || repoMap.entries.length < 2) continue;

            const nodeIndex = new Map<string, number>();
            repoMap.entries.forEach((entry, idx) => nodeIndex.set(entry.filePath, idx));
            const N = nodeIndex.size;

            const sparseEdges: SparseEdge[] = [];
            for (const [targetFile, consumers] of repoMap.graph.importedBy.entries()) {
                const targetIdx = nodeIndex.get(targetFile);
                if (targetIdx === undefined) continue;
                for (const consumer of consumers) {
                    const consumerIdx = nodeIndex.get(consumer);
                    if (consumerIdx !== undefined && consumerIdx !== targetIdx) {
                        sparseEdges.push({ u: consumerIdx, v: targetIdx, weight: 1.0 });
                    }
                }
            }

            if (N > 1 && sparseEdges.length > 0) {
                const state = SpectralMath.analyzeTopology(N, sparseEdges);
                const density = sparseEdges.length / (N * (N - 1));

                // MASS: Reuse the PageRank engine from repo-map
                const prScores = computePageRank(
                    repoMap.entries.map(e => e.filePath),
                    repoMap.graph.importedBy
                );

                // ARCHITECTURAL DISPERSION: real bleeding, not volume
                const dirsTouched = new Set(codeFilesChanged.map(f => path.dirname(f)));

                rawSnapshots.push({
                    commit: hash,
                    features: {
                        N,
                        density,
                        normalized_gap: density > 0 ? ((state.lambda3 ?? 0) - state.fiedler) / density : 0,
                        nodes: Array.from(nodeIndex.entries()).map(([filePath, idx]) => ({
                            id: filePath,
                            v2_signed: state.v2 ? state.v2[idx] : 0,
                            v2_abs: state.v2 ? Math.abs(state.v2[idx]) : 0,
                            v3_signed: state.v3 ? state.v3[idx] : 0,
                            v3_abs: state.v3 ? Math.abs(state.v3[idx]) : 0,
                            pr: prScores.get(filePath) || 0,
                            churn: fileChurn.get(filePath) || 0,
                        })),
                    },
                    _isRevert: msg.startsWith('revert ') || msg.includes('this reverts commit') || msg.includes('hotfix'),
                    _isShotgun: codeFilesChanged.length >= 8 && dirsTouched.size >= 4,
                    _isRefactor: isRefactor,
                    _filesTouched: new Set(codeFilesChanged),
                });

                if (rawSnapshots.length % 25 === 0) {
                    console.log(`[MINER] Progress: ${i}/${logRaw.length} (${rawSnapshots.length} extracted)`);
                }
            }
        } catch {
            // Silent skip — commit may have broken tree-sitter parseable files
        } finally {
            try { execSync(`git worktree remove --force ${wtPath}`, { cwd: cloneDir, stdio: 'ignore' }); } catch {}
        }
    }

    console.log(`[MINER] Phase 1 complete: ${rawSnapshots.length} snapshots`);

    // ─── PHASE 2: TEMPORAL ORACLE (Lookahead Ground Truth — Zero Leakage) ───
    const LOOKAHEAD_WINDOW = 5;

    let labeled = 0;
    let positives = 0;

    for (let t = 0; t < rawSnapshots.length - LOOKAHEAD_WINDOW; t++) {
        const current = rawSnapshots[t];
        let futureCollapse = 0;

        for (let k = 1; k <= LOOKAHEAD_WINDOW; k++) {
            const future = rawSnapshots[t + k];
            if ((future._isRevert || future._isShotgun) && !future._isRefactor) {
                const overlap = [...current._filesTouched].some((f: string) => future._filesTouched.has(f));
                if (overlap) {
                    futureCollapse = 1;
                    break;
                }
            }
        }

        const finalData = {
            commit: current.commit,
            features: current.features,
            target_future_collapse: futureCollapse,
        };

        fs.appendFileSync(outputFile, JSON.stringify(finalData) + '\n');
        labeled++;
        if (futureCollapse) positives++;
    }

    const pct = labeled > 0 ? (positives / labeled * 100).toFixed(1) : '0';
    console.log(`[MINER] Phase 2 complete: ${labeled} labeled samples`);
    console.log(`[MINER] Class balance: ${positives} positive (${pct}%), ${labeled - positives} negative`);
    console.log(`[MINER] Dataset saved to ${outputFile}`);
}

// ─── CLI ──────────────────────────────────────────────────────────
const repoUrl = process.argv[2];
if (!repoUrl) {
    console.error('Usage: npx tsx scripts/chronos-miner.ts <repo-url>');
    process.exit(1);
}
mineIndestructibleHistory(repoUrl).catch(err => {
    console.error(`[MINER] Fatal: ${err.message}`);
    process.exit(1);
});
