import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { buildDependencyGraph, computePageRank, type RepoMapEntry } from '../src/repo-map.js';
import { SpectralMath, type SparseEdge } from '../src/kernel/spectral-topology.js';

/**
 * NREKI Chronos Miner v9.5 — Titanium Oracle
 * 
 * v9.5: Dynamic Scale-Invariant Physics (over v9.4):
 *   - MAD floor is now dynamic: 0.45 + 0.19 * log10(N/500)
 *     Zod (N≤500) → floor 0.45 (unchanged). VSCode (N=5584) → floor 0.65 (36 files for Z>3)
 *   - P99.5 percentile replaces P98.5 (0.5% vs 1.5% shotgun rate)
 *     With LOOKAHEAD=10: 1-(1-0.005)^10 = 4.88% → ~3.5% after overlap filter
 *   - MAD_WINDOW expanded to 2000 (P99.5 needs ≥10 real disasters in window)
 *   - Entropy scaled by 1.2× gravity factor: max(2.0, 1.5 + 1.2*log10(N/500))
 *     VSCode: 2^2.76 ≈ 7 directories required. Zod: 2.0 (unchanged)
 * 
 * Retained from v9.3:
 *   - N_TOTAL hoisted from git ls-tree (costs <5ms in RAM)
 *   - Zero commit message labels. Pure topology.
 *   - LOOKAHEAD_WINDOW = 10
 * 
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 */

const BATCH_LIMIT = 500;
const LOOKAHEAD_WINDOW = 10;

const safeFloat = (val: number | undefined | null) => {
    if (val === undefined || val === null || !Number.isFinite(val) || Number.isNaN(val)) return 0.0;
    return parseFloat(val.toFixed(6));
};

const isCodeFile = (f: string) =>
    /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(f) &&
    !f.endsWith('.d.ts') &&
    !f.includes('.test.') &&
    !f.includes('.spec.') &&
    !/(^|\/)node_modules\//.test(f) &&
    !/(^|\/)dist\//.test(f);

const stableCompare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function extractImportsFast(content: string): string[] {
    const imports = new Set<string>();

    // ESModules: import X from "path"
    const fromRe = /from\s+["']([^"']+)["']/g;
    let m; while ((m = fromRe.exec(content)) !== null) imports.add(m[1]);

    // CommonJS: require("path")
    const reqRe = /require\(["']([^"']+)["']\)/g;
    while ((m = reqRe.exec(content)) !== null) imports.add(m[1]);

    // Dynamic imports: import("path") — lazy loading en TS/JS
    const dynRe = /import\(["']([^"']+)["']\)/g;
    while ((m = dynRe.exec(content)) !== null) imports.add(m[1]);

    return [...imports].sort(stableCompare);
}

class ImmortalityDrive {
    private stateFile: string;
    public recentLogSizes: number[] = [];
    public fileChurn: Map<string, number> = new Map();
    public slidingWindow: any[] = [];
    private readonly MAD_WINDOW = 2000;

    constructor(repoName: string) {
        this.stateFile = path.resolve(process.cwd(), `${repoName}_immortality_drive.json`);
    }

    public load() {
        if (fs.existsSync(this.stateFile)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
                this.recentLogSizes = data.recentLogSizes || [];
                this.fileChurn = new Map(Object.entries(data.fileChurn || {}));
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
        const safeWindow = this.slidingWindow.map(snap => ({
            ...snap,
            _filesTouched: Array.from(snap._filesTouched)
        }));
        const data = { recentLogSizes: this.recentLogSizes, fileChurn: Object.fromEntries(this.fileChurn), slidingWindow: safeWindow };
        const tmp = `${this.stateFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, this.stateFile);
    }

    public cleanup() {
        if (fs.existsSync(this.stateFile)) fs.unlinkSync(this.stateFile);
    }

    public updateChurn(files: string[]) {
        for (const key of this.fileChurn.keys()) {
            const decayed = this.fileChurn.get(key)! * 0.95;
            if (decayed < 0.01) this.fileChurn.delete(key);
            else this.fileChurn.set(key, decayed);
        }
        for (const f of files) {
            this.fileChurn.set(f, (this.fileChurn.get(f) || 0) + 1.0);
        }
    }

    public evaluateTectonicShift(files: string[], N_TOTAL: number): { isShotgun: boolean; entropy: number; robustZ: number } {
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

        // GRAVITY FACTOR: log10(N/500). Zod → 0. VSCode → ~1.05.
        const scale_factor = Math.max(0, Math.log10(N_TOTAL / 500));

        // 1. DYNAMIC MAD FLOOR (Option 1, scale-invariant)
        // Zod (N≤500)   → 0.45 + 0 = 0.45 (requires ~15 files for Z>3)
        // VSCode (N=5584) → 0.45 + 0.19*1.05 = 0.65 (requires ~36 files for Z>3)
        const dynamic_mad_floor = 0.45 + (0.19 * scale_factor);
        const safeMad = Math.max(mad, dynamic_mad_floor);
        const robustZ = (0.6745 * (logF - median)) / safeMad;

        // 2. P99.5 PERCENTILE (Option 2, needs MAD_WINDOW=2000 for ≥10 real disasters)
        // With LOOKAHEAD=10: 1-(1-0.005)^10 = 4.88% → ~3.5% after overlap filter
        const p995_idx = Math.floor(sorted.length * 0.995);
        const p995_logF = sorted[Math.min(p995_idx, sorted.length - 1)];
        const dynamic_F_threshold = Math.max(8, Math.floor(Math.exp(p995_logF)));

        // 3. SCALED ENTROPY (spatial dispersion, gravity-adjusted)
        // VSCode: max(2.0, 1.5 + 1.2*1.05) = 2.76 → 2^2.76 ≈ 7 directories
        // Zod:    max(2.0, 1.5 + 0) = 2.0 (unchanged)
        const dynamic_E_threshold = Math.max(2.0, 1.5 + (1.2 * scale_factor));

        const isShotgun = robustZ > 3.0 && entropy > dynamic_E_threshold && F >= dynamic_F_threshold;

        return { isShotgun, entropy, robustZ };
    }
}

export async function mineIndestructibleHistory(repoUrl: string) {
    const repoName = repoUrl.split('/').pop()!.replace('.git', '');
    const cloneDir = path.resolve(`/tmp/nreki-bare-${repoName}`);
    const outputFile = path.resolve(process.cwd(), `${repoName}_stgt_dataset.jsonl`);

    const activeCommitFile = path.resolve(process.cwd(), `${repoName}_active.tmp`);
    const poisonFile = path.resolve(process.cwd(), `${repoName}_poison.log`);
    const poisonCommits = new Set<string>();

    if (fs.existsSync(poisonFile)) {
        fs.readFileSync(poisonFile, 'utf-8').split('\n').filter(Boolean).forEach(c => poisonCommits.add(c));
    }

    if (fs.existsSync(activeCommitFile)) {
        const poison = fs.readFileSync(activeCommitFile, 'utf-8').trim();
        if (poison) {
            console.log(`\n[CRASH RECOVERY] Detected poison commit: ${poison}. Blacklisting.`);
            fs.appendFileSync(poisonFile, `${poison}\n`);
            poisonCommits.add(poison);
        }
        fs.unlinkSync(activeCommitFile);
    }

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

    for (const snap of drive.slidingWindow) {
        processedCommits.add(snap.commit);
    }

    console.log('[MINER] Fetching chronological timeline...');
    const logRaw = execSync('git log --first-parent --reverse --format="%H|%s"', { cwd: cloneDir, maxBuffer: 1024 * 1024 * 1024 })
        .toString().trim().split('\n').filter(Boolean);

    console.log(`[MINER] Executing ZERO-DISK Tectonic Mining on ${logRaw.length} commits...`);

    let extractedThisRun = 0;
    let newPositives = 0;
    const jsonlBuffer: string[] = [];

    const blobCache = new Map<string, RepoMapEntry>();
    const lruKeys: string[] = [];
    const MAX_CACHE_SIZE = 25000;

    const tStart = performance.now();

    for (let i = 0; i < logRaw.length; i++) {
        const [hash, ...msgParts] = logRaw[i].split('|');
        if (processedCommits.has(hash) || poisonCommits.has(hash)) continue;

        const msg = msgParts.join('|').toLowerCase();

        // THE ONLY HUMAN TEXT FILTER: anti-robot formatters.
        // NOT used for labeling. Only to skip cosmetic noise in the sliding window.
        const isCosmetic = /\b(format|lint|prettier|style|docs|typo|cleanup|chore)\b/i.test(msg);

        // NO isRevert. NO isReactive. MATHEMATICS IS THE ONLY JUDGE.

        let diffRaw: string[] = [];
        try {
            diffRaw = execSync(`git diff-tree -z --no-commit-id --name-only -r -m ${hash}`, { cwd: cloneDir, maxBuffer: 50 * 1024 * 1024 })
                .toString().split('\0').filter(Boolean);
        } catch { continue; }

        const codeFilesChanged = diffRaw.filter(isCodeFile);
        if (codeFilesChanged.length === 0) continue;

        // HOISTING: Calculate the mass of the universe at this instant (N_TOTAL)
        // This takes <5ms in RAM thanks to ls-tree.
        let lsTreeRaw: string[] = [];
        try {
            lsTreeRaw = execSync(`git ls-tree -r ${hash}`, { cwd: cloneDir, maxBuffer: 100 * 1024 * 1024 }).toString().trim().split('\n');
        } catch { continue; }

        let N_TOTAL = 0;
        for (const line of lsTreeRaw) {
            if (line) {
                const tabIdx = line.indexOf('\t');
                if (tabIdx !== -1 && isCodeFile(line.substring(tabIdx + 1))) N_TOTAL++;
            }
        }
        if (N_TOTAL < 2) continue;

        // RELATIVISTIC PHYSICS: thresholds scale with repo mass
        drive.updateChurn(codeFilesChanged);
        const analysis = drive.evaluateTectonicShift(codeFilesChanged, N_TOTAL);

        try {
            fs.writeFileSync(activeCommitFile, hash);

            const currentFiles: string[] = [];
            const currentEntries: RepoMapEntry[] = [];

            for (const line of lsTreeRaw) {
                if (!line) continue;
                const match = line.match(/^\d+\s+blob\s+([0-9a-f]+)\t(.+)$/);
                if (!match) continue;

                const blobHash = match[1];
                const file = match[2];

                if (!isCodeFile(file)) continue;

                currentFiles.push(file);

                let entry = blobCache.get(blobHash);
                if (!entry) {
                    let content = "";
                    try {
                        content = execSync(`git cat-file blob ${blobHash}`, { cwd: cloneDir, maxBuffer: 50 * 1024 * 1024 }).toString('utf-8');
                    } catch { continue; }

                    const imports = extractImportsFast(content);

                    entry = {
                        filePath: file,
                        imports,
                        exports: [],
                        signatures: [],
                        lineCount: 0
                    };

                    if (blobCache.size >= MAX_CACHE_SIZE) {
                        const oldest = lruKeys.shift();
                        if (oldest) blobCache.delete(oldest);
                    }
                    blobCache.set(blobHash, entry);
                    lruKeys.push(blobHash);
                }

                currentEntries.push({ ...entry, filePath: file });
            }

            const graph = buildDependencyGraph(currentEntries, currentFiles);
            if (currentFiles.length < 2) {
                if (fs.existsSync(activeCommitFile)) fs.unlinkSync(activeCommitFile);
                continue;
            }

            const nodeIndex = new Map<string, number>();
            currentFiles.forEach((f, idx) => nodeIndex.set(f, idx));
            const N = nodeIndex.size;

            const sparseEdges: SparseEdge[] = [];
            for (const [targetFile, consumers] of graph.importedBy.entries()) {
                const targetIdx = nodeIndex.get(targetFile);
                if (targetIdx === undefined) continue;
                for (const consumer of consumers) {
                    const consumerIdx = nodeIndex.get(consumer);
                    if (consumerIdx !== undefined && consumerIdx !== targetIdx) {
                        sparseEdges.push({ u: consumerIdx, v: targetIdx, weight: 1.0 });
                    }
                }
            }

            if (N <= 1 || sparseEdges.length === 0) {
                if (fs.existsSync(activeCommitFile)) fs.unlinkSync(activeCommitFile);
                continue;
            }

            const state = SpectralMath.analyzeTopology(N, sparseEdges);
            const maxEdges = N > 1 ? (N * (N - 1)) : 1;
            const density = sparseEdges.length / maxEdges;
            const prScores = computePageRank(currentFiles, graph.importedBy);

            const gap = (state.lambda3 ?? 0) - state.fiedler;
            const safe_density = Math.max(density, 1e-9);
            const normalizedGap = Math.sign(gap) * Math.log1p(Math.abs(gap / safe_density));

            drive.slidingWindow.push({
                commit: hash,
                features: {
                    N,
                    density: safeFloat(density),
                    spatial_entropy: safeFloat(analysis.entropy),
                    robust_z: safeFloat(analysis.robustZ),
                    normalized_gap: safeFloat(normalizedGap),
                    nodes: currentFiles.map((filePath, idx) => ({
                        id: filePath,
                        v2_signed: safeFloat(state.v2 ? state.v2[idx] : 0),
                        v2_abs: safeFloat(state.v2 ? Math.abs(state.v2[idx]) : 0),
                        v3_signed: safeFloat(state.v3 ? state.v3[idx] : 0),
                        v3_abs: safeFloat(state.v3 ? Math.abs(state.v3[idx]) : 0),
                        pr: safeFloat(prScores.get(filePath) || 0),
                        churn: safeFloat(drive.fileChurn.get(filePath) || 0),
                    })),
                    edges: sparseEdges.map((e: SparseEdge) => [e.u, e.v]),
                },
                _isShotgun: analysis.isShotgun,
                _isCosmetic: isCosmetic,
                _filesTouched: new Set(codeFilesChanged),
            });

            if (drive.slidingWindow.length > LOOKAHEAD_WINDOW) {
                const target = drive.slidingWindow.shift()!;
                let futureCollapse = 0;

                for (const future of drive.slidingWindow) {
                    // Skip formatter noise
                    if (future._isCosmetic) continue;

                    // THE ABSOLUTE TRUTH: MATHEMATICS ONLY.
                    // Is the future commit a topologically proven Shotgun Surgery?
                    // (Scale-invariant: threshold adapts to repo mass)
                    if (future._isShotgun) {
                        // Did the shockwave collide with ground zero?
                        const overlap = [...target._filesTouched].some((f: string) => future._filesTouched.has(f));
                        if (overlap) {
                            futureCollapse = 1;
                            break;
                        }
                    }
                }

                jsonlBuffer.push(JSON.stringify({
                    commit: target.commit,
                    features: target.features,
                    target_future_collapse: futureCollapse,
                }));

                extractedThisRun++;
                if (futureCollapse) newPositives++;

                if (extractedThisRun % 50 === 0) {
                    const elapsedSec = (performance.now() - tStart) / 1000;
                    const speed = (extractedThisRun / elapsedSec).toFixed(1);
                    const posRate = extractedThisRun > 0 ? ((newPositives / extractedThisRun) * 100).toFixed(1) : '0';
                    console.log(`[MINER] Buffered ${extractedThisRun} samples (${posRate}% pos). Speed: ${speed} commits/sec. Cache: ${blobCache.size} blobs.`);
                }

                if (extractedThisRun >= BATCH_LIMIT) {
                    const posRate = ((newPositives / extractedThisRun) * 100).toFixed(1);
                    console.log(`\n[NREKI] 💀 BATCH LIMIT (${BATCH_LIMIT}). ${posRate}% positive. Committing ACID Transaction to Disk.`);
                    fs.appendFileSync(outputFile, jsonlBuffer.join('\n') + '\n');
                    drive.save();
                    if (fs.existsSync(activeCommitFile)) fs.unlinkSync(activeCommitFile);
                    process.exit(0);
                }
            }

            if (fs.existsSync(activeCommitFile)) fs.unlinkSync(activeCommitFile);

        } catch (err: any) {
            console.log(`[MINER] Minor topological bypass on ${hash}: ${err.message}. Skipping.`);
            if (fs.existsSync(activeCommitFile)) fs.unlinkSync(activeCommitFile);
        }
    }

    if (jsonlBuffer.length > 0) fs.appendFileSync(outputFile, jsonlBuffer.join('\n') + '\n');
    drive.save();
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
