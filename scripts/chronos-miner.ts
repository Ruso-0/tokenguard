#!/usr/bin/env node
/**
 * chronos-miner.ts — NREKI Temporal Dataset Extractor
 * 
 * Mines spectral physics features from git history for STGT training.
 * Uses bare clone + git worktree (zero side effects on source repo).
 * 
 * Features per node: [PageRank, ChurnVelocity, v2_signed, |v2|, v3_signed, |v3|]
 * Ground Truth: Lookahead Window T+5 (Shotgun Surgery or Revert in future commits)
 * 
 * Usage: npx tsx scripts/chronos-miner.ts <repo-url>
 * Output: <repo-name>_dataset.jsonl
 * 
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 */

import { execSync } from 'child_process';
import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import { SpectralTopologist, SpectralMath, TopologicalEdge } from '../src/kernel/spectral-topology.js';

// ─── Fast PageRank (in-memory, no repo-map.ts dependency) ─────────
function computeFastPageRank(
    nodes: Set<string>,
    edges: TopologicalEdge[],
    iterations = 15
): Map<string, number> {
    const pr = new Map<string, number>();
    const outDegree = new Map<string, number>();
    const N = nodes.size;
    if (N === 0) return pr;

    for (const n of nodes) { pr.set(n, 1 / N); outDegree.set(n, 0); }
    for (const e of edges) outDegree.set(e.sourceId, (outDegree.get(e.sourceId) || 0) + 1);

    for (let iter = 0; iter < iterations; iter++) {
        const nextPr = new Map<string, number>();
        let sinkSum = 0;
        for (const n of nodes) {
            if (outDegree.get(n) === 0) sinkSum += pr.get(n)!;
            nextPr.set(n, 0.15 / N);
        }
        for (const e of edges) {
            nextPr.set(
                e.targetId,
                nextPr.get(e.targetId)! + 0.85 * (pr.get(e.sourceId)! / (outDegree.get(e.sourceId) || 1))
            );
        }
        for (const n of nodes) {
            nextPr.set(n, nextPr.get(n)! + 0.85 * (sinkSum / N));
            pr.set(n, nextPr.get(n)!);
        }
    }

    // Normalize to [0, 1]
    let maxPr = 0;
    for (const v of pr.values()) if (v > maxPr) maxPr = v;
    if (maxPr > 0) for (const [k, v] of pr.entries()) pr.set(k, v / maxPr);
    return pr;
}

// ─── Main Miner ───────────────────────────────────────────────────
async function mineSpectralHistory(repoUrl: string, maxCommits?: number) {
    const repoName = repoUrl.split('/').pop()!.replace('.git', '');
    const cloneDir = path.resolve(`/tmp/nreki-bare-${repoName}`);
    const wtName = `nreki-miner-wt-${repoName}`;
    const wtPath = path.resolve(`/tmp/${wtName}`);
    const outputFile = `${repoName}_dataset.jsonl`;

    console.log(`[MINER] Repository: ${repoUrl}`);
    console.log(`[MINER] Bare clone: ${cloneDir}`);
    console.log(`[MINER] Output: ${outputFile}`);

    // Bare clone (ultra fast, no working directory)
    if (!fs.existsSync(cloneDir)) {
        console.log('[MINER] Cloning bare...');
        execSync(`git clone --bare ${repoUrl} ${cloneDir}`, { stdio: 'inherit' });
    }

    // Get commit history: Hash|Message (oldest first)
    const logRaw = execSync('git log --format="%H|%s" --reverse', { cwd: cloneDir })
        .toString().trim().split('\n').filter(Boolean);

    const totalCommits = maxCommits ? Math.min(logRaw.length, maxCommits) : logRaw.length;
    console.log(`[MINER] Total commits: ${logRaw.length}, processing: ${totalCommits}`);

    const rawSnapshots: any[] = [];
    const fileChurn = new Map<string, number>();
    let processed = 0;
    let skipped = 0;

    // ─── PHASE 1: PURE PHYSICS EXTRACTION ───
    for (let i = 1; i < totalCommits; i++) {
        if (!logRaw[i]) continue;
        const [hash, ...msgParts] = logRaw[i].split('|');
        const msg = msgParts.join('|').toLowerCase();

        // Clean up previous worktree
        if (fs.existsSync(wtPath)) {
            try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch {}
        }

        try {
            execSync(`git worktree add --detach ${wtPath} ${hash}`, { cwd: cloneDir, stdio: 'ignore' });
        } catch {
            skipped++;
            continue;
        }

        try {
            // Compute kinetic churn with exponential decay
            const prevHash = logRaw[i - 1].split('|')[0];
            let diff: string[] = [];
            try {
                diff = execSync(`git diff --name-only ${prevHash} ${hash}`, { cwd: cloneDir })
                    .toString().trim().split('\n').filter(l => l.trim());
            } catch { /* merge commits may fail diff */ }

            for (const f of diff) fileChurn.set(f, (fileChurn.get(f) || 0) + 1);
            for (const key of fileChurn.keys()) fileChurn.set(key, fileChurn.get(key)! * 0.95);

            // BARE-METAL: No NREKI VFS, just TypeScript Compiler API
            const tsConfigPath = ts.findConfigFile(wtPath, ts.sys.fileExists, 'tsconfig.json');
            if (!tsConfigPath) { skipped++; continue; }

            const parsedConfig = ts.parseJsonConfigFileContent(
                ts.readConfigFile(tsConfigPath, ts.sys.readFile).config, ts.sys, wtPath
            );

            const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
            const targetFiles = new Set(
                program.getSourceFiles()
                    .map(sf => sf.fileName.replace(/\\/g, '/'))
                    .filter(f => !f.includes('node_modules'))
            );

            const { nodes, edges } = SpectralTopologist.extractConstraintGraph(program, targetFiles);
            const { sparseEdges, nodeIndex, N } = SpectralTopologist.buildSparseGraph(nodes, edges);

            if (N > 1) {
                const state = SpectralMath.analyzeTopology(N, sparseEdges);
                const density = sparseEdges.length / (N * (N - 1));
                const pagerank = computeFastPageRank(nodes, edges);

                rawSnapshots.push({
                    commit: hash,
                    features: {
                        N,
                        normalized_gap: density > 0 ? ((state.lambda3 ?? 0) - state.fiedler) / density : 0,
                        nodes: Array.from(nodeIndex.entries()).map(([nodeId, idx]) => ({
                            id: nodeId,
                            v2_signed: state.v2 ? state.v2[idx] : 0,
                            v2_abs: state.v2 ? Math.abs(state.v2[idx]) : 0,
                            v3_signed: state.v3 ? state.v3[idx] : 0,
                            v3_abs: state.v3 ? Math.abs(state.v3[idx]) : 0,
                            pr: pagerank.get(nodeId) || 0,
                            churn: fileChurn.get(nodeId.split('::')[0]) || 0,
                        })),
                    },
                    // Temporal metadata (discarded before training)
                    _isRevert: msg.startsWith('revert ') || msg.includes('this reverts commit'),
                    _isShotgun: diff.length > 20,
                    _filesTouched: new Set(diff),
                });

                processed++;
            } else {
                skipped++;
            }
        } catch (e) {
            skipped++;
            if (processed % 50 === 0) {
                console.error(`[MINER] Skip commit ${hash.slice(0, 7)}: ${(e as Error).message.slice(0, 80)}`);
            }
        } finally {
            try {
                execSync(`git worktree remove --force ${wtPath}`, { cwd: cloneDir, stdio: 'ignore' });
            } catch {}
        }

        // Progress
        if (i % 25 === 0) {
            console.log(`[MINER] Progress: ${i}/${totalCommits} (${processed} extracted, ${skipped} skipped)`);
        }
    }

    console.log(`[MINER] Phase 1 complete: ${processed} snapshots from ${totalCommits} commits`);

    // ─── PHASE 2: TEMPORAL ORACLE (Lookahead Ground Truth) ───
    const dataset: any[] = [];
    const LOOKAHEAD_WINDOW = 5;

    for (let t = 0; t < rawSnapshots.length - LOOKAHEAD_WINDOW; t++) {
        const current = rawSnapshots[t];
        let futureCollapse = 0;

        // Look into the future (T+1 to T+5)
        for (let k = 1; k <= LOOKAHEAD_WINDOW; k++) {
            const future = rawSnapshots[t + k];
            if (future._isRevert || future._isShotgun) {
                // CAUSAL INTEGRITY: Does the future disaster touch the same files we modified today?
                const overlap = [...current._filesTouched].some((f: string) => future._filesTouched.has(f));
                if (overlap) {
                    futureCollapse = 1;
                    break;
                }
            }
        }

        // Strip temporal metadata before saving
        dataset.push({
            commit: current.commit,
            features: current.features,
            target_future_collapse: futureCollapse,
        });
    }

    const positives = dataset.filter(d => d.target_future_collapse === 1).length;
    console.log(`[MINER] Phase 2 complete: ${dataset.length} labeled samples`);
    console.log(`[MINER] Class balance: ${positives} positive (${(positives / dataset.length * 100).toFixed(1)}%), ${dataset.length - positives} negative`);

    fs.writeFileSync(outputFile, dataset.map(d => JSON.stringify(d)).join('\n'));
    console.log(`[MINER] Dataset saved to ${outputFile}`);
}

// ─── CLI ──────────────────────────────────────────────────────────
const repoUrl = process.argv[2];
const maxCommits = process.argv[3] ? parseInt(process.argv[3]) : undefined;

if (!repoUrl) {
    console.error('Usage: npx tsx scripts/chronos-miner.ts <repo-url> [max-commits]');
    console.error('Example: npx tsx scripts/chronos-miner.ts https://github.com/prisma/prisma.git 500');
    process.exit(1);
}

mineSpectralHistory(repoUrl, maxCommits).catch(err => {
    console.error(`[MINER] Fatal: ${err.message}`);
    process.exit(1);
});
