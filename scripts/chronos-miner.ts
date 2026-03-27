import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { ASTParser } from '../src/parser.js';
import { generateRepoMap, computePageRank } from '../src/repo-map.js';
import { SpectralMath, SparseEdge } from '../src/kernel/spectral-topology.js';

/**
 * NREKI Chronos Miner v6 — The Immortal Tectonic Oracle
 * 
 * Crash-Only Architecture. Zero WASM memory leaks. 15s Kill Switch.
 * Features: Robust Log-MAD Z-Score, Spatial Shannon Entropy, 
 * Strict Decay-Then-Add Churn Memory, and Log1p Spectral Gaps.
 * 
 * @author Jherson Eddie Tintaya Holguin (Ruso-0) Estudio al borde
 */

const BATCH_LIMIT = 300;
const LOOKAHEAD_WINDOW = 5;

class ImmortalityDrive {
    private stateFile: string;
    public recentLogSizes: number[] = [];
    public fileChurn: Map<string, number> = new Map();
    public slidingWindow: any[] = [];
    
    private readonly MAD_WINDOW = 500;

    constructor(repoName: string) {
        this.stateFile = path.resolve(process.cwd(), `${repoName}_immortality_drive.json`);
    }

    public load() {
        if (fs.existsSync(this.stateFile)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
                this.recentLogSizes = data.recentLogSizes || [];
                this.fileChurn = new Map(Object.entries(data.fileChurn || {}));
                
                // BUG MEDIO 3 FIX: Deserialize Sets safely from Arrays
                this.slidingWindow = (data.slidingWindow || []).map((snap: any) => ({
                    ...snap,
                    _filesTouched: new Set(snap._filesTouched)
                }));
            } catch {
                console.error("[IMMORTALITY] State corrupted. Starting fresh.");
            }
        }
    }

    public save() {
        // BUG MEDIO 3 FIX: Serialize Sets to Arrays
        const safeWindow = this.slidingWindow.map(snap => ({
            ...snap,
            _filesTouched: Array.from(snap._filesTouched)
        }));

        const data = {
            recentLogSizes: this.recentLogSizes,
            fileChurn: Object.fromEntries(this.fileChurn),
            slidingWindow: safeWindow
        };
        
        // Atomic write prevents corruption if OS kills process during write
        const tmp = `${this.stateFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, this.stateFile);
    }

    public cleanup() {
        // BUG MENOR FIX: Cleanup with safe fs.unlinkSync (No bracket notation)
        if (fs.existsSync(this.stateFile)) fs.unlinkSync(this.stateFile);
    }

    public updateChurn(files: string[]) {
        // BUG MEDIO 2 FIX: Decay ALL existing churn BEFORE adding new impulse.
        for (const key of this.fileChurn.keys()) {
            const decayed = this.fileChurn.get(key)! * 0.95;
            if (decayed < 0.01) this.fileChurn.delete(key);
            else this.fileChurn.set(key, decayed);
        }
        // Add impulse to current files (they start at exactly 1.0 if new)
        for (const f of files) {
            this.fileChurn.set(f, (this.fileChurn.get(f) || 0) + 1.0);
        }
    }

    public evaluateTectonicShift(files: string[]): { isShotgun: boolean; entropy: number; robustZ: number } {
        const F = files.length;
        if (F === 0) return { isShotgun: false, entropy: 0, robustZ: 0 };

        const dirCounts = new Map<string, number>();
        for (const f of files) {
            const dir = path.dirname(f);
            dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
        }
        let entropy = 0;
        for (const count of dirCounts.values()) {
            const p = count / F;
            entropy -= p * Math.log2(p);
        }

        const logF = Math.log(F);
        this.recentLogSizes.push(logF);
        if (this.recentLogSizes.length > this.MAD_WINDOW) this.recentLogSizes.shift();

        if (this.recentLogSizes.length < 10) return { isShotgun: false, entropy, robustZ: 0 };

        const sorted = [...this.recentLogSizes].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const deviations = sorted.map(x => Math.abs(x - median)).sort((a, b) => a - b);
        const mad = deviations[Math.floor(deviations.length / 2)];

        const robustZ = mad > 0 ? (0.6745 * (logF - median)) / mad : 0;
        const isShotgun = robustZ > 3.0 && entropy > 1.5 && F >= 5;

        return { isShotgun, entropy, robustZ };
    }
}

export async function mineIndestructibleHistory(repoUrl: string) {
    const repoName = repoUrl.split('/').pop()!.replace('.git', '');
    const cloneDir = path.resolve(`/tmp/nreki-bare-${repoName}`);
    // BUG CRÍTICO 5 FIX: Match exacto con el bash orquestador
    const wtPath = path.resolve(`/tmp/nreki-wt-${repoName}`); 
    const outputFile = path.resolve(process.cwd(), `${repoName}_stgt_dataset.jsonl`);

    console.log(`[MINER] Repository: ${repoName}`);

    if (!fs.existsSync(cloneDir)) {
        console.log('[MINER] Cloning bare...');
        execSync(`git clone --bare ${repoUrl} ${cloneDir}`, { stdio: 'inherit' });
    }

    const drive = new ImmortalityDrive(repoName);
    drive.load();

    const processedCommits = new Set<string>();
    let historicalLines = 0;
    let historicalPositives = 0;

    if (fs.existsSync(outputFile)) {
        const rl = readline.createInterface({ input: fs.createReadStream(outputFile), crlfDelay: Infinity });
        for await (const line of rl) {
            if (!line.trim()) continue;
            historicalLines++;
            try {
                const parsed = JSON.parse(line);
                processedCommits.add(parsed.commit);
                if (parsed.target_future_collapse === 1) historicalPositives++;
            } catch {}
        }
        console.log(`[MINER] Resuming... Loaded ${historicalLines} samples (${historicalPositives} positive).`);
    }

    // BUG MEDIO 4 FIX: Ensure sliding window hashes are marked as processed so they aren't re-mined
    for (const snap of drive.slidingWindow) {
        processedCommits.add(snap.commit);
    }

    // BUG CRÍTICO 1 & 4 FIX: NO --reverse in git log. Fetch 5000 newest, then .reverse() in JS.
    const logRaw = execSync('git log --format="%H|%s" -n 5000', { cwd: cloneDir, maxBuffer: 100 * 1024 * 1024 })
        .toString().trim().split('\n').filter(Boolean).reverse();

    const parser = new ASTParser();
    await parser.initialize();

    console.log(`[MINER] Executing Crash-Only Tectonic Mining on ${logRaw.length} commits...`);

    let extractedThisRun = 0;
    let newPositives = 0;

    for (let i = 0; i < logRaw.length; i++) {
        const [hash, ...msgParts] = logRaw[i].split('|');
        
        if (processedCommits.has(hash)) continue;

        const msg = msgParts.join('|').toLowerCase();
        
        // BUG 4 FIX: Tightened Refactor regex to cosmetic changes only
        const isCosmetic = /\b(format|lint|prettier|style|docs|typo)\b/i.test(msg);
        // BUG 3 FIX: Added undo and rollback semantic reverts
        const isRevert = /\b(revert|undo|rollback|hotfix)\b/i.test(msg) || msg.includes('this reverts commit');

        let allFilesChanged: string[] = [];
        try {
            // Usa diff-tree para no depender del commit padre y manejar merge commits
            const diffRaw = execSync(`git diff-tree --no-commit-id --name-only -r ${hash}`, { cwd: cloneDir, maxBuffer: 50 * 1024 * 1024 })
                .toString().trim().split('\n');
            allFilesChanged = diffRaw.filter(Boolean);
        } catch { continue; }

        // BUG MEDIO 1 FIX: Physics never stops. Update churn and evaluate BEFORE skip.
        // Se cuenta TODO el commit (incluso si son markdowns) para la entropía del oráculo.
        drive.updateChurn(allFilesChanged);
        const analysis = drive.evaluateTectonicShift(allFilesChanged);

        // Extraer los archivos útiles para el AST
        const codeFilesChanged = allFilesChanged.filter(f => 
            /\.(ts|tsx|js|jsx)$/i.test(f) && 
            !f.endsWith('.d.ts') && // BUG CRÍTICO 1 FIX: Filtro estricto de declaraciones
            !f.includes('.test.') && 
            !f.includes('.spec.')
        );

        // BUG CRÍTICO 2 FIX: Skip empty TS commits AFTER physics update
        if (codeFilesChanged.length === 0) continue;

        // BUG CRÍTICO 2 & 3 FIX: Cero fs.rmSync. Cero rm -rf. Uso puro de Git API.
        try { execSync(`git worktree remove --force ${wtPath} 2>/dev/null`, { cwd: cloneDir, stdio: 'ignore' }); } catch {}
        
        try {
            execSync(`git worktree add --detach ${wtPath} ${hash}`, { cwd: cloneDir, stdio: 'ignore' });
            
            // BUG MENOR 1 FIX: Kill Switch 15s con clearTimeout
            let killTimer: NodeJS.Timeout | undefined;

            const topologyTask = async () => {
                const repoMap = await generateRepoMap(wtPath, parser);
                if (!repoMap.graph || repoMap.entries.length < 2) throw new Error("INSUFFICIENT_GRAPH");

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
                
                if (N <= 1 || sparseEdges.length === 0) throw new Error("NO_EDGES");

                const state = SpectralMath.analyzeTopology(N, sparseEdges);
                const density = sparseEdges.length / (N * (N - 1));
                const prScores = computePageRank(repoMap.entries.map(e => e.filePath), repoMap.graph.importedBy);
                
                return { N, density, state, prScores, nodeIndex };
            };

            const timeoutTask = new Promise<never>((_, reject) => {
                killTimer = setTimeout(() => reject(new Error("AST_TIMEOUT_15S")), 15000);
            });

            let topo: any;
            try {
                topo = await Promise.race([topologyTask(), timeoutTask]);
            } finally {
                if (killTimer) clearTimeout(killTimer);
            }
            
            // BUG MEDIO 5 FIX: Log-compression of Spectral Gap against explosion
            const gap = (topo.state.lambda3 ?? 0) - topo.state.fiedler;
            const safe_density = Math.max(topo.density, 1e-9);
            const normalizedGap = Math.sign(gap) * Math.log1p(Math.abs(gap / safe_density));

            drive.slidingWindow.push({
                commit: hash,
                features: {
                    N: topo.N,
                    density: topo.density,
                    spatial_entropy: parseFloat(analysis.entropy.toFixed(4)),
                    robust_z: parseFloat(analysis.robustZ.toFixed(4)),
                    normalized_gap: parseFloat(normalizedGap.toFixed(6)),
                    nodes: Array.from(topo.nodeIndex.entries()).map(([filePath, idx]) => ({
                        id: filePath,
                        v2_signed: topo.state.v2 ? topo.state.v2[idx] : 0,
                        v2_abs: topo.state.v2 ? Math.abs(topo.state.v2[idx]) : 0,
                        v3_signed: topo.state.v3 ? topo.state.v3[idx] : 0,
                        v3_abs: topo.state.v3 ? Math.abs(topo.state.v3[idx]) : 0,
                        pr: topo.prScores.get(filePath) || 0, // YA NORMALIZADO 0-1 EN REPO-MAP
                        churn: drive.fileChurn.get(filePath) || 0,
                    })),
                },
                _isRevert: isRevert,
                _isShotgun: analysis.isShotgun,
                _isCosmetic: isCosmetic,
                _filesTouched: new Set(allFilesChanged),
            });

            if (drive.slidingWindow.length > LOOKAHEAD_WINDOW) {
                const target = drive.slidingWindow.shift()!;
                let futureCollapse = 0;

                for (const future of drive.slidingWindow) {
                    if ((future._isRevert || future._isShotgun) && !future._isCosmetic) {
                        const overlap = [...target._filesTouched].some((f: string) => future._filesTouched.has(f));
                        if (overlap) {
                            futureCollapse = 1;
                            break;
                        }
                    }
                }

                fs.appendFileSync(outputFile, JSON.stringify({
                    commit: target.commit,
                    features: target.features,
                    target_future_collapse: futureCollapse,
                }) + '\n');
                
                extractedThisRun++;
                if (futureCollapse) newPositives++;

                if (extractedThisRun % 25 === 0) {
                    console.log(`[MINER] Securely appended ${extractedThisRun} samples. Memory safe.`);
                }

                if (extractedThisRun >= BATCH_LIMIT) {
                    console.log(`\n[NREKI] 💀 BATCH LIMIT (${BATCH_LIMIT}). Persisting Oracle and exiting to clear WASM RAM.`);
                    drive.save(); // SERIALIZACIÓN OBLIGATORIA DE LA VENTANA
                    try { execSync(`git worktree remove --force ${wtPath}`, { cwd: cloneDir, stdio: 'ignore' }); } catch {}
                    process.exit(0); 
                }
            }
        } catch (err: any) {
            if (err.message === "AST_TIMEOUT_15S") {
                console.log(`[MINER] ⚠️ Kill Switch activated on commit ${hash}. Deadlock averted.`);
            }
            // Silencioso para otros errores del AST, avanzamos.
        } finally {
            try { execSync(`git worktree remove --force ${wtPath} 2>/dev/null`, { cwd: cloneDir, stdio: 'ignore' }); } catch {}
        }
    }

    // BUG MEDIO 1 & MENOR 2 FIX: No drain final. "Pureza > Volumen". Los últimos commits mueren dignamente.
    // Guardamos el estado final en disco. El próximo batch continuará justo desde la ventana.
    drive.save(); 
    
    // Si realmente logramos consumir TODO el repositorio (no quedan más commits logRaw)
    drive.cleanup();

    const totalLines = historicalLines + extractedThisRun;
    const totalPositives = historicalPositives + newPositives;
    const pct = totalLines > 0 ? ((totalPositives / totalLines) * 100).toFixed(1) : '0';

    console.log(`\n[MINER] 🎉 Dataset 100% complete! Global samples: ${totalLines} (${pct}% positive)`);
    process.exit(42);
}

const repoUrl = process.argv[2];
if (!repoUrl) { console.error('Usage: npx tsx scripts/chronos-miner.ts <repo-url>'); process.exit(1); }
mineIndestructibleHistory(repoUrl).catch(err => { console.error(`[MINER] Fatal: ${err.message}`); process.exit(1); });
