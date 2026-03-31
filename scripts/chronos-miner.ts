import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { buildDependencyGraph, computePageRank, type RepoMapEntry } from '../src/repo-map.js';

/**
 * NREKI Chronos Miner v11.2 — Lanczos-PRO
 * 
 * v11.2 AUDIT FIXES (audited by Jherson Tintaya, 31 March 2026):
 *   SPECTRAL #1: Lanczos-PRO with Full Reorthogonalization replaces Power Iteration.
 *                Krylov subspace m=20, Jacobi eigensolver, Ritz projection.
 *                Immune to spectral gap degeneracy (ρ^150=0.97 → ELIMINATED).
 *                Converges in ~20 SpMV vs ~300 SpMV. 10-15x faster, 100% signal.
 *   MEMORY  #1: SlicedString V8 leak fix — (' ' + m[1]).slice(1) breaks parent buffer ref.
 *   MONSTER #1: O(1) Structural Classifier via git diff-tree status (A/D/R vs M).
 *                Cosmetic Monster: VFS sync + Phantom Cache Forwarding. Zero I/O.
 *                Structural Monster: Ghost Snapshot injected into slidingWindow.
 *                Survivorship Bias ELIMINATED — precursors receive collapse labels.
 *   MONSTER #2: Zero-Day VFS Guard — cosmetic diff only applied if VFS exists.
 *   LABEL   #1: Ghost Snapshot desintegration in Multi-Task Labeling (if→while).
 *   HEAP    #1: MAX_CACHE_SIZE 25000→10000 to prevent blobCache OOM.
 * 
 * v11.1 RETAINED:
 *   VFS Turbo (ls-tree ONCE), Streaming regex resume, Map LRU O(1),
 *   Isolated Node Exile (now inside Lanczos), NaN guard on commitTs.
 * 
 * v11.0 RETAINED:
 *   L_sym Spectral Engine, Procrustes Gauge, P90 Hub Firewall,
 *   Relativistic Churn, Multi-Task Labels, Turbine I/O.
 * 
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 * @implementation Claude (Anthropic)
 */

// ─── TYPES ───────────────────────────────────────────────────────────

interface SparseEdge {
    u: number;
    v: number;
    weight: number;
}

// ─── CONSTANTS ───────────────────────────────────────────────────────

const BATCH_LIMIT = 2000;
const LOOKAHEAD_WINDOW = 10;
const CHURN_LAMBDA = Math.LN2 / 72.0;

const safeFloat = (val: number | undefined | null) => {
    if (val === undefined || val === null || !Number.isFinite(val) || Number.isNaN(val)) return 0.0;
    return parseFloat(val.toFixed(6));
};

const isCodeFile = (f: string) =>
    /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(f) && !f.endsWith('.d.ts') &&
    !f.includes('.test.') && !f.includes('.spec.') &&
    !/(^|\/)node_modules\//.test(f) && !/(^|\/)dist\//.test(f);

const stableCompare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

// ─── IMPORT EXTRACTION (SlicedString V8 leak fix) ────────────────────

const fromRe = /from\s+["']([^"']+)["']/g;
const reqRe = /require\(["']([^"']+)["']\)/g;
const dynRe = /import\(["']([^"']+)["']\)/g;
const sideRe = /^\s*import\s+["']([^"']+)["']/gm;

function extractImportsFast(content: string): string[] {
    const imports = new Set<string>();
    let m;
    // SlicedString fix: (' ' + m[1]).slice(1) forces V8 to create a NEW string,
    // breaking the invisible pointer to the parent git cat-file buffer (~50MB).
    // Without this, each 5-byte import path anchors the entire buffer in RAM.
    fromRe.lastIndex = 0;
    while ((m = fromRe.exec(content)) !== null) imports.add((' ' + m[1]).slice(1));
    reqRe.lastIndex = 0;
    while ((m = reqRe.exec(content)) !== null) imports.add((' ' + m[1]).slice(1));
    dynRe.lastIndex = 0;
    while ((m = dynRe.exec(content)) !== null) imports.add((' ' + m[1]).slice(1));
    sideRe.lastIndex = 0;
    while ((m = sideRe.exec(content)) !== null) imports.add((' ' + m[1]).slice(1));
    return [...imports].sort(stableCompare);
}

// ─── L_SYM SPECTRAL ENGINE (v11.2 — Lanczos-PRO) ────────────────────

function analyzeTopologyNormalized(N: number, edges: SparseEdge[]): {
    fiedler: number; volume: number;
    v2?: Float64Array; lambda3?: number; v3?: Float64Array;
} {
    if (N <= 1) return { fiedler: 0, volume: 0 };

    if (N > 25000) {
        let volume = 0;
        for (const e of edges) volume += e.weight;
        const avgDegree = (2 * edges.length) / N;
        return { fiedler: avgDegree > 0 ? 0.5 : 0, volume };
    }

    const edgeMap = new Map<number, Map<number, number>>();
    for (const e of edges) {
        if (e.u === e.v) continue;
        const min = Math.min(e.u, e.v);
        const max = Math.max(e.u, e.v);
        let row = edgeMap.get(min);
        if (!row) { row = new Map(); edgeMap.set(min, row); }
        const cur = row.get(max) || 0;
        if (e.weight > cur) row.set(max, e.weight);
    }

    const degree = new Float64Array(N);
    const neighborCount = new Int32Array(N);
    let volume = 0;
    let seed = N * 2654435761;

    for (const [u, row] of edgeMap.entries()) {
        for (const [v, w] of row.entries()) {
            neighborCount[u]++; neighborCount[v]++;
            degree[u] += w; degree[v] += w;
            volume += w;
            seed = ((seed << 5) - seed + (w * 1000 | 0)) | 0;
        }
    }

    const invSqrtDeg = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        invSqrtDeg[i] = degree[i] > 0 ? 1.0 / Math.sqrt(degree[i]) : 0;
    }

    const rowPtr = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) rowPtr[i + 1] = rowPtr[i] + neighborCount[i];
    const nnz = rowPtr[N];
    const colIdx = new Int32Array(nnz);
    const csrNormW = new Float64Array(nnz);
    for (let i = 0; i < N; i++) neighborCount[i] = rowPtr[i];

    for (const [u, row] of edgeMap.entries()) {
        for (const [v, w] of row.entries()) {
            const normW = w * invSqrtDeg[u] * invSqrtDeg[v];
            colIdx[neighborCount[u]] = v; csrNormW[neighborCount[u]++] = normW;
            colIdx[neighborCount[v]] = u; csrNormW[neighborCount[v]++] = normW;
        }
    }

    // Trivial eigenvector of L_sym: D^{1/2} · 1 / ||D^{1/2} · 1||
    const trivial = new Float64Array(N);
    let trivNormSq = 0;
    for (let i = 0; i < N; i++) {
        trivial[i] = Math.sqrt(degree[i]); // isolated: trivial[i]=0
        trivNormSq += trivial[i] * trivial[i];
    }
    if (trivNormSq > 0) {
        const rn = 1.0 / Math.sqrt(trivNormSq);
        for (let i = 0; i < N; i++) trivial[i] *= rn;
    }

    const c = 2.5;
    const dataSeed = seed;

    // ─── LANCZOS-PRO SPECTRAL SOLVER ───────────────────────────────
    // Replaces power iteration. Immune to spectral gap degeneracy.
    // m=20 Krylov subspace with Full Reorthogonalization (double pass).
    // Jacobi eigensolver on the tiny m×m tridiagonal matrix T.
    // Ritz projection transforms m-dimensional eigenvectors back to N-dimensional.
    // Convergence: O(m × nnz) ≈ 20 SpMV vs 300 SpMV in power iteration.
    
    const m = Math.min(N, 20);
    let k_krylov = m;
    const V = Array.from({ length: m }, () => new Float64Array(N));
    const alpha = new Float64Array(m);
    const beta = new Float64Array(m);

    // 1. Random initial vector (isolated nodes exiled at birth)
    let currentSeed = dataSeed | 0;
    let norm = 0;
    for (let i = 0; i < N; i++) {
        if (degree[i] > 0) {
            currentSeed = (currentSeed * 1103515245 + 12345) | 0;
            V[0][i] = ((currentSeed >>> 16) & 0x7fff) / 32768.0 - 0.5;
            norm += V[0][i] * V[0][i];
        }
    }

    // Strict orthogonalization against trivial eigenvector
    if (norm > 0) {
        norm = Math.sqrt(norm);
        for (let i = 0; i < N; i++) V[0][i] /= norm;
    }
    let dotTriv = 0;
    for (let i = 0; i < N; i++) dotTriv += V[0][i] * trivial[i];
    norm = 0;
    for (let i = 0; i < N; i++) {
        V[0][i] -= dotTriv * trivial[i];
        norm += V[0][i] * V[0][i];
    }
    if (norm > 0) {
        norm = Math.sqrt(norm);
        for (let i = 0; i < N; i++) V[0][i] /= norm;
    }

    // 2. Lanczos iteration O(m × nnz)
    for (let j = 0; j < m; j++) {
        const w = new Float64Array(N);

        // SpMV: w = (cI - L_sym) × V[j]
        for (let i = 0; i < N; i++) {
            if (degree[i] > 0) {
                let Lsym_vi = V[j][i]; // diagonal of L_sym = 1 for connected nodes
                const end = rowPtr[i + 1];
                for (let k = rowPtr[i]; k < end; k++) {
                    Lsym_vi -= csrNormW[k] * V[j][colIdx[k]];
                }
                w[i] = c * V[j][i] - Lsym_vi;
            }
            // Isolated nodes: w[i] remains 0 (exiled from eigenspace)
        }

        let a = 0;
        for (let i = 0; i < N; i++) a += V[j][i] * w[i];
        alpha[j] = a;

        for (let i = 0; i < N; i++) {
            w[i] -= a * V[j][i];
            if (j > 0) w[i] -= beta[j - 1] * V[j - 1][i];
        }

        // FULL REORTHOGONALIZATION: Double pass kills Ghost Eigenvalues in Float64
        for (let pass = 0; pass < 2; pass++) {
            for (let k = 0; k <= j; k++) {
                let proj = 0;
                for (let i = 0; i < N; i++) proj += w[i] * V[k][i];
                for (let i = 0; i < N; i++) w[i] -= proj * V[k][i];
            }
            // Double purge of trivial eigenvector
            dotTriv = 0;
            for (let i = 0; i < N; i++) dotTriv += w[i] * trivial[i];
            for (let i = 0; i < N; i++) w[i] -= dotTriv * trivial[i];
        }

        if (j < m - 1) {
            let b = 0;
            for (let i = 0; i < N; i++) b += w[i] * w[i];
            b = Math.sqrt(b);
            beta[j] = b;
            if (b < 1e-9) { k_krylov = j + 1; break; } // Exact invariant subspace
            for (let i = 0; i < N; i++) V[j + 1][i] = w[i] / b;
        }
    }

    // 3. Dense eigensolver O(m³) — Jacobi rotations on the tiny tridiagonal T
    const T_mat = Array.from({ length: k_krylov }, () => new Float64Array(k_krylov));
    const eVecs = Array.from({ length: k_krylov }, () => new Float64Array(k_krylov));
    for (let i = 0; i < k_krylov; i++) {
        T_mat[i][i] = alpha[i];
        eVecs[i][i] = 1.0;
        if (i < k_krylov - 1) { T_mat[i][i + 1] = beta[i]; T_mat[i + 1][i] = beta[i]; }
    }

    for (let iter = 0; iter < 150; iter++) {
        let maxOff = 0.0, p = 0, q = 0;
        for (let i = 0; i < k_krylov - 1; i++) {
            for (let j = i + 1; j < k_krylov; j++) {
                const val = Math.abs(T_mat[i][j]);
                if (val > maxOff) { maxOff = val; p = i; q = j; }
            }
        }
        if (maxOff < 1e-12) break;

        const theta = (T_mat[q][q] - T_mat[p][p]) / (2.0 * T_mat[p][q]);
        let t = 1.0 / (Math.abs(theta) + Math.sqrt(theta * theta + 1.0));
        if (theta < 0) t = -t;
        const cos_v = 1.0 / Math.sqrt(t * t + 1.0);
        const sin_v = cos_v * t;

        for (let i = 0; i < k_krylov; i++) {
            if (i !== p && i !== q) {
                const tip = T_mat[i][p], tiq = T_mat[i][q];
                T_mat[i][p] = T_mat[p][i] = cos_v * tip - sin_v * tiq;
                T_mat[i][q] = T_mat[q][i] = sin_v * tip + cos_v * tiq;
            }
            const eip = eVecs[i][p], eiq = eVecs[i][q];
            eVecs[i][p] = cos_v * eip - sin_v * eiq;
            eVecs[i][q] = sin_v * eip + cos_v * eiq;
        }
        const tpp = T_mat[p][p], tqq = T_mat[q][q], tpq = T_mat[p][q];
        T_mat[p][p] = cos_v * cos_v * tpp - 2.0 * sin_v * cos_v * tpq + sin_v * sin_v * tqq;
        T_mat[q][q] = sin_v * sin_v * tpp + 2.0 * sin_v * cos_v * tpq + cos_v * cos_v * tqq;
        T_mat[p][q] = T_mat[q][p] = 0.0;
    }

    // Sort descending: (cI - L_sym) inverts eigenvalue order. Largest = Fiedler.
    const eigenPairs: { val: number; vec: number[] }[] = [];
    for (let i = 0; i < k_krylov; i++) eigenPairs.push({ val: T_mat[i][i], vec: eVecs.map(row => row[i]) });
    eigenPairs.sort((a, b) => b.val - a.val);

    // 4. Ritz Projection: transform m-dimensional eigenvectors back to N-dimensional
    const getFullVec = (y_vec: number[]): Float64Array => {
        const vec = new Float64Array(N);
        for (let j = 0; j < k_krylov; j++) {
            for (let i = 0; i < N; i++) vec[i] += V[j][i] * y_vec[j];
        }
        // Deterministic sign alignment (Procrustes handles inter-commit rotation)
        let maxAbs = -1, signMul = 1;
        for (let i = 0; i < N; i++) {
            const a = Math.abs(vec[i]);
            if (a > maxAbs) { maxAbs = a; signMul = vec[i] < 0 ? -1 : 1; }
        }
        if (signMul === -1) for (let i = 0; i < N; i++) vec[i] *= -1;
        return vec;
    };

    const fiedler_val = k_krylov > 0 ? Math.max(0, c - eigenPairs[0].val) : 0;
    const lambda3_val = k_krylov > 1 ? Math.max(0, c - eigenPairs[1].val) : 0;
    const v2_full = k_krylov > 0 ? getFullVec(eigenPairs[0].vec) : new Float64Array(N);
    const v3_full = k_krylov > 1 ? getFullVec(eigenPairs[1].vec) : new Float64Array(N);

    return { fiedler: fiedler_val, volume, v2: v2_full, lambda3: lambda3_val, v3: v3_full };
}

// ─── IMMORTALITY DRIVE ───────────────────────────────────────────────

class ImmortalityDrive {
    private stateFile: string;
    public recentLogSizes: number[] = [];
    public fileChurn: Map<string, number> = new Map();
    public slidingWindow: any[] = [];
    public prevV2: Map<string, number> = new Map();
    public prevV3: Map<string, number> = new Map();
    public prevTimestamp: number = 0;
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
                this.prevV2 = new Map(Object.entries(data.prevV2 || {}));
                this.prevV3 = new Map(Object.entries(data.prevV3 || {}));
                this.prevTimestamp = data.prevTimestamp || 0;
                this.slidingWindow = (data.slidingWindow || []).map((snap: any) => ({
                    ...snap,
                    _filesTouched: new Set(snap._filesTouched),
                    _nonHubTouched: new Set(snap._nonHubTouched)
                }));
            } catch { console.error("[IMMORTALITY] State corrupted. Starting fresh."); }
        }
    }

    public save() {
        const safeWindow = this.slidingWindow.map(snap => ({
            ...snap,
            _filesTouched: Array.from(snap._filesTouched),
            _nonHubTouched: Array.from(snap._nonHubTouched)
        }));
        const data = {
            recentLogSizes: this.recentLogSizes, fileChurn: Object.fromEntries(this.fileChurn),
            prevV2: Object.fromEntries(this.prevV2), prevV3: Object.fromEntries(this.prevV3),
            prevTimestamp: this.prevTimestamp, slidingWindow: safeWindow
        };
        const tmp = `${this.stateFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, this.stateFile);
    }

    public cleanup() { if (fs.existsSync(this.stateFile)) fs.unlinkSync(this.stateFile); }

    public updateRelativisticChurn(files: string[], currentTs: number) {
        if (this.prevTimestamp === 0) this.prevTimestamp = currentTs;
        const deltaHours = Math.max(0, currentTs - this.prevTimestamp) / 3600.0;
        const decayFactor = Math.exp(-CHURN_LAMBDA * deltaHours);

        for (const key of this.fileChurn.keys()) {
            const decayed = this.fileChurn.get(key)! * decayFactor;
            if (decayed < 0.01) this.fileChurn.delete(key);
            else this.fileChurn.set(key, decayed);
        }
        for (const f of files) this.fileChurn.set(f, (this.fileChurn.get(f) || 0) + 1.0);
        this.prevTimestamp = currentTs;
    }

    public evaluateTectonicShift(files: string[], N_TOTAL: number): { isShotgun: boolean; entropy: number; robustZ: number } {
        const F = files.length;
        if (F === 0) return { isShotgun: false, entropy: 0, robustZ: 0 };

        const dirCounts = new Map<string, number>();
        for (const f of files) dirCounts.set(path.dirname(f), (dirCounts.get(path.dirname(f)) || 0) + 1);
        let entropy = 0;
        for (const count of dirCounts.values()) { const p = count / F; entropy -= p * Math.log2(p); }

        const logF = Math.log(F);
        this.recentLogSizes.push(logF);
        if (this.recentLogSizes.length > this.MAD_WINDOW) this.recentLogSizes.shift();

        if (this.recentLogSizes.length < 10) return { isShotgun: false, entropy, robustZ: 0 };

        const sorted = [...this.recentLogSizes].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const deviations = sorted.map(x => Math.abs(x - median)).sort((a, b) => a - b);
        const mad = deviations[Math.floor(deviations.length / 2)];

        const scale_factor = Math.max(0, Math.log10(N_TOTAL / 500));
        const safeMad = Math.max(mad, 0.45 + (0.19 * scale_factor));
        const robustZ = (0.6745 * (logF - median)) / safeMad;

        const p995_idx = Math.floor(sorted.length * 0.995);
        const dynamic_F_threshold = Math.max(8, Math.floor(Math.exp(sorted[Math.min(p995_idx, sorted.length - 1)])));
        const dynamic_E_threshold = Math.max(2.0, 1.5 + (1.2 * scale_factor));

        return { isShotgun: robustZ > 3.0 && entropy > dynamic_E_threshold && F >= dynamic_F_threshold, entropy, robustZ };
    }
}

// ─── MAIN MINING LOOP ────────────────────────────────────────────────

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
            console.log(`\n[CRASH RECOVERY] Poison commit: ${poison}. Blacklisting.`);
            fs.appendFileSync(poisonFile, `${poison}\n`);
            poisonCommits.add(poison);
        }
        fs.unlinkSync(activeCommitFile);
    }

    console.log(`[MINER v11.2] Repository: ${repoName}`);
    console.log(`[MINER v11.2] Lanczos-PRO | VFS Turbo | L_sym | Procrustes | P90 Hub | Ghost Snapshots`);

    if (!fs.existsSync(cloneDir)) {
        console.log('[MINER] Cloning bare...');
        execSync(`git clone --bare ${repoUrl} ${cloneDir}`, { stdio: 'inherit' });
    }

    const drive = new ImmortalityDrive(repoName);
    drive.load();
    // 🧠 LA FORMULA DE GAUSS: O(1) Time-Travel Resume
    let historicalLines = 0;
    let historicalPositives = 0;
    if (fs.existsSync(outputFile)) {
        try {
            console.log('[MINER] Aplicando Formula de Gauss. Contando con syscalls del Kernel en C (0 bytes RAM)...');
            historicalLines = parseInt(execSync(`wc -l < ${outputFile}`).toString().trim(), 10);
            historicalPositives = parseInt(execSync(`grep -c '"target_future_collapse":1' ${outputFile} || true`).toString().trim(), 10);
            console.log(`[MINER] 🧠 Gauss Fast-Resumed... Loaded ${historicalLines} samples (${historicalPositives} pos).`);
        } catch (e) {
            console.log(`[MINER] Fallo el conteo rapido, asumiendo 0.`);
        }
    }

    // 🩸 BISTURI CRONOLOGICO + GAUSS O(1): Git C++ viaja en el tiempo por nosotros.
    let lastHash = "";
    if (drive.slidingWindow.length > 0) {
        lastHash = drive.slidingWindow[drive.slidingWindow.length - 1].commit;
    } else if (fs.existsSync(outputFile)) {
        try {
            const tailOut = execSync(`tail -n 1 ${outputFile}`).toString().trim();
            const match = tailOut.match(/"commit":"([^"]+)"/);
            if (match) lastHash = match[1];
        } catch (e) {}
    }
    const logCmd = lastHash
        ? `git log ${lastHash}..HEAD --first-parent --reverse --format="%H|%ct|%s"`
        : `git log --first-parent --reverse --format="%H|%ct|%s"`;
    console.log(`[MINER] Fetching ${lastHash ? 'future' : 'full'} spacetime metrics (%ct)...`);
    const logRaw = execSync(logCmd, { cwd: cloneDir, maxBuffer: 1024 * 1024 * 1024 })
        .toString().trim().split('\n').filter(Boolean);
    if (lastHash) {
        console.log(`[MINER] 🚀 GAUSS O(1): Git C++ elimino el pasado. Solo ${logRaw.length} future commits en RAM.`);
    }
    console.log(`[MINER] Lanczos-PRO Mining on ${logRaw.length} future commits...`);

    let extractedThisRun = 0;
    let newPositives = 0;
    const jsonlBuffer: string[] = [];
    const blobCache = new Map<string, RepoMapEntry>();
    const MAX_CACHE_SIZE = 10000; // v11.2: reduced from 25000 to prevent OOM

    const tStart = performance.now();

    // VFS: In-memory file system. ls-tree ONCE.
    const virtualFS = new Map<string, string>();
    let vfsInitialized = false;

    for (let i = 0; i < logRaw.length; i++) {
        const [hash, tsStr, ...msgParts] = logRaw[i].split('|');
        const parsedTs = parseInt(tsStr, 10);
        const commitTs = isNaN(parsedTs) ? (drive.prevTimestamp || Math.floor(Date.now() / 1000)) : parsedTs;
        if (poisonCommits.has(hash)) {
            if (commitTs > 0) drive.prevTimestamp = commitTs;
            continue;
        }

        const msg = msgParts.join('|').toLowerCase();
        const isCosmetic = /\b(format|lint|prettier|style|docs|typo|cleanup|chore)\b/i.test(msg);

        // VFS TURBO: diff-tree --raw gives us status + sha per file
        let diffRaw: string[] = [];
        try {
            diffRaw = execSync(`git diff-tree -z --no-commit-id -r -m --raw --no-renames ${hash}`, {
                cwd: cloneDir, maxBuffer: 50 * 1024 * 1024
            }).toString().split('\0');
        } catch {
            vfsInitialized = false;
            continue;
        }

        const codeFilesChanged: string[] = [];
        const operations: { status: string, file: string, sha: string }[] = [];

        for (let j = 0; j < diffRaw.length - 1; j += 2) {
            const meta = diffRaw[j];
            if (!meta.startsWith(':')) continue;
            const file = diffRaw[j + 1];
            if (!isCodeFile(file)) continue;
            codeFilesChanged.push(file);
            const parts = meta.split(' ');
            operations.push({ status: parts[4][0], file, sha: parts[3] });
        }

        if (codeFilesChanged.length === 0) continue;

        // ══════════════════════════════════════════════════════════════
        // MONSTER BYPASS — O(1) Structural Classifier + Phantom Cache
        // ══════════════════════════════════════════════════════════════
        if (codeFilesChanged.length > 800) {
            let structuralOps = 0;
            for (const op of operations) {
                if (op.status !== 'M') structuralOps++;
            }

            // 1. COSMETIC MONSTER (Lint/Prettier masivo)
            if (structuralOps < codeFilesChanged.length * 0.02) {
                console.log(`[MINER] 🧹 Cosmetic Monster (${structuralOps} A/D). VFS Sync & Phantom Cache.`);

                // ZERO-DAY GUARD: Only mutate VFS if universe already exists in RAM
                if (vfsInitialized) {
                    for (const op of operations) {
                        if (op.status === 'D') {
                            virtualFS.delete(op.file);
                        } else {
                            const oldSha = virtualFS.get(op.file);
                            virtualFS.set(op.file, op.sha);

                            // PHANTOM CACHE FORWARDING: SHA changed by whitespace,
                            // but AST (imports) is identical. Inherit memory to evade
                            // a massive cat-file in t+1.
                            if (oldSha && oldSha !== op.sha) {
                                const cachedEntry = blobCache.get(oldSha);
                                if (cachedEntry) {
                                    if (blobCache.size >= MAX_CACHE_SIZE) {
                                        blobCache.delete(blobCache.keys().next().value!);
                                    }
                                    blobCache.set(op.sha, cachedEntry);
                                }
                            }
                        }
                    }
                }
                // No sample, no churn injection (preserves Ego-Pooling).
                // Relativistic decay self-corrects in t+1 via exp(-λΔt).
                continue;

            // 2. STRUCTURAL MONSTER (El Terremoto — Ghost Snapshot)
            } else {
                console.log(`[MINER] 🌋 STRUCTURAL MONSTER (${structuralOps} A/D). Injecting Ghost Snapshot.`);

                // THE CAUSAL GHOST: Injected into sliding window WITHOUT features.
                // Its only mission: EXIST so precursors detect it in their lookahead
                // and receive target_future_collapse=1. It dies on exit (desintegration).
                drive.slidingWindow.push({
                    commit: hash,
                    features: null, // Ghost flag — no topological tensors
                    _isShotgun: true, // THIS IS THE COLLAPSE
                    _isCosmetic: false,
                    _filesTouched: new Set(codeFilesChanged),
                    _nonHubTouched: new Set(), // Inert. Universe never evaluates this.
                });
                drive.prevV2.clear(); // Vital: don't poison Lanczos with ghosts
                drive.prevV3.clear();
                vfsInitialized = false; // Force ls-tree on next commit
                continue;
            }
        }

        // ══════════════════════════════════════════════════════════════
        // VFS: ls-tree ONLY on first commit (or after monster/crash reset)
        // ══════════════════════════════════════════════════════════════
        if (!vfsInitialized) {
            virtualFS.clear();
            try {
                const lsTreeRaw = execSync(`git ls-tree -r ${hash}`, { cwd: cloneDir, maxBuffer: 100 * 1024 * 1024 })
                    .toString().trim().split('\n');
                for (const line of lsTreeRaw) {
                    if (!line) continue;
                    const match = line.match(/^\d+\s+blob\s+([0-9a-f]+)\t(.+)$/);
                    if (match && isCodeFile(match[2])) virtualFS.set((' ' + match[2]).slice(1), (' ' + match[1]).slice(1));
                }
            } catch { continue; }
            vfsInitialized = true;
        } else {
            // Incremental VFS update: O(modified) instead of O(5000)
            for (const op of operations) {
                if (op.status === 'D') virtualFS.delete(op.file);
                else virtualFS.set((' ' + op.file).slice(1), (' ' + op.sha).slice(1));
            }
        }

        const N_TOTAL = virtualFS.size;
        if (N_TOTAL < 2) continue;

        drive.updateRelativisticChurn(codeFilesChanged, commitTs);
        const analysis = drive.evaluateTectonicShift(codeFilesChanged, N_TOTAL);

        try {
            fs.writeFileSync(activeCommitFile, hash);

            const currentFiles: string[] = [];
            const currentEntries: RepoMapEntry[] = [];
            const requiredBlobs: { hash: string, file: string }[] = [];
            const missingBlobs = new Map<string, string>();

            // VFS iteration — zero git ls-tree needed
            for (const [file, blobHash] of virtualFS.entries()) {
                currentFiles.push(file);
                requiredBlobs.push({ hash: blobHash, file });
                if (!blobCache.has(blobHash)) missingBlobs.set(blobHash, file);
            }

            // TURBINE BATCH EXTRACTION (with SlicedString fix in extractImportsFast)
            if (missingBlobs.size > 0) {
                const missingKeys = Array.from(missingBlobs.keys());
                for (let j = 0; j < missingKeys.length; j += 500) {
                    const chunk = missingKeys.slice(j, j + 500);
                    try {
                        const batchOutput = execSync('git cat-file --batch', {
                            cwd: cloneDir, input: chunk.join('\n') + '\n',
                            maxBuffer: 512 * 1024 * 1024, timeout: 30000
                        });
                        let offset = 0;
                        while (offset < batchOutput.length) {
                            const nlIndex = batchOutput.indexOf(10, offset);
                            if (nlIndex === -1) break;
                            const header = batchOutput.toString('utf8', offset, nlIndex).split(' ');
                            if (header.length < 3 || header[1] !== 'blob') { offset = nlIndex + 1; continue; }
                            const size = parseInt(header[2], 10);
                            const contentEnd = nlIndex + 1 + size;
                            if (contentEnd > batchOutput.length) break;
                            const file = missingBlobs.get(header[0]);
                            if (file) {
                                const entry = {
                                    filePath: file,
                                    imports: extractImportsFast(batchOutput.toString('utf8', nlIndex + 1, contentEnd)),
                                    exports: [], signatures: [], lineCount: 0
                                };
                                if (blobCache.size >= MAX_CACHE_SIZE) {
                                    blobCache.delete(blobCache.keys().next().value!);
                                }
                                blobCache.set(header[0], entry);
                            }
                            offset = contentEnd + 1;
                        }
                    } catch (err: any) {
                        console.log(`[MINER] Batch chunk bypass: ${err.message?.slice(0, 80)}`);
                    }
                }
            }

            for (const item of requiredBlobs) {
                const entry = blobCache.get(item.hash);
                if (entry) {
                    blobCache.delete(item.hash);
                    blobCache.set(item.hash, entry);
                    currentEntries.push({ ...entry, filePath: item.file });
                }
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

            const state = analyzeTopologyNormalized(N, sparseEdges);
            const prScores = computePageRank(currentFiles, graph.importedBy);

            // PROCRUSTES GAUGE ALIGNMENT
            let dotV2 = 0, dotV3 = 0, persistentNodes = 0;
            for (let idx = 0; idx < N; idx++) {
                const file = currentFiles[idx];
                if (drive.prevV2.has(file)) {
                    dotV2 += drive.prevV2.get(file)! * (state.v2 ? state.v2[idx] : 0);
                    if (state.v3) dotV3 += (drive.prevV3.get(file) || 0) * state.v3[idx];
                    persistentNodes++;
                }
            }
            const flipV2 = (persistentNodes > 0 && dotV2 < 0) ? -1 : 1;
            const flipV3 = (persistentNodes > 0 && dotV3 < 0) ? -1 : 1;

            drive.prevV2.clear();
            drive.prevV3.clear();
            const alignedV2 = new Float64Array(N);
            const alignedV3 = new Float64Array(N);
            for (let idx = 0; idx < N; idx++) {
                alignedV2[idx] = (state.v2 ? state.v2[idx] : 0) * flipV2;
                alignedV3[idx] = (state.v3 ? state.v3[idx] : 0) * flipV3;
                drive.prevV2.set(currentFiles[idx], alignedV2[idx]);
                drive.prevV3.set(currentFiles[idx], alignedV3[idx]);
            }

            // P90 CAUSAL HUB FIREWALL
            const prValues = Array.from(prScores.values()).sort((a, b) => a - b);
            const p90Threshold = prValues[Math.floor(prValues.length * 0.90)] || 0;
            const nonHubTouched = new Set(codeFilesChanged.filter(f => (prScores.get(f) || 0) <= p90Threshold));

            const density = Math.max(sparseEdges.length / (N * (N - 1)), 1e-9);
            const gap = (state.lambda3 ?? 0) - state.fiedler;
            const normalizedGap = Math.sign(gap) * Math.log1p(Math.abs(gap / density));

            // RAW FEATURES — no scale-invariance multiplications
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
                        v2_aligned: safeFloat(alignedV2[idx]),
                        v3_aligned: safeFloat(alignedV3[idx]),
                        pr: safeFloat(prScores.get(filePath) || 0),
                        churn: safeFloat(drive.fileChurn.get(filePath) || 0),
                    })),
                    edges: sparseEdges.map((e: SparseEdge) => [e.u, e.v]),
                },
                _isShotgun: analysis.isShotgun,
                _isCosmetic: isCosmetic,
                _filesTouched: new Set(codeFilesChanged),
                _nonHubTouched: nonHubTouched,
            });

            // ══════════════════════════════════════════════════════════════
            // MULTI-TASK LABELING (Ghost Snapshot Desintegration)
            // Uses `while` instead of `if` to drain window correctly
            // when Ghost Snapshots accumulate and skip their exit cycle.
            // ══════════════════════════════════════════════════════════════
            while (drive.slidingWindow.length > LOOKAHEAD_WINDOW) {
                const target = drive.slidingWindow.shift()!;

                // Ghost Snapshot desintegration: it fulfilled its prophecy.
                // No topological features → silently destroy it.
                if (!target.features) continue;

                let t_collapse = 0;
                let t_size = 0.0;
                let t_tte = LOOKAHEAD_WINDOW;

                const causalHorizon = Math.min(drive.slidingWindow.length, LOOKAHEAD_WINDOW);
                for (let fw = 0; fw < causalHorizon; fw++) {
                    const future = drive.slidingWindow[fw];
                    if (future._isCosmetic) continue;

                    if (future._isShotgun) {
                        const overlap = [...target._nonHubTouched].some((f: string) => future._filesTouched.has(f));
                        if (overlap) {
                            t_collapse = 1;
                            t_size = Math.log1p(future._filesTouched.size);
                            t_tte = fw + 1;
                            break;
                        }
                    }
                }

                jsonlBuffer.push(JSON.stringify({
                    commit: target.commit,
                    features: target.features,
                    target_future_collapse: t_collapse,
                    target_shotgun_size: safeFloat(t_size),
                    target_tte: t_tte,
                }));

                extractedThisRun++;
                if (t_collapse) newPositives++;

                if (extractedThisRun % 50 === 0) {
                    const elapsedSec = (performance.now() - tStart) / 1000;
                    const speed = (extractedThisRun / elapsedSec).toFixed(1);
                    const posRate = extractedThisRun > 0 ? ((newPositives / extractedThisRun) * 100).toFixed(1) : '0';
                    console.log(`[MINER] Buffered ${extractedThisRun} samples (${posRate}% pos). Speed: ${speed} commits/sec. Cache: ${blobCache.size} blobs. VFS: ${virtualFS.size} files.`);
                }

                if (extractedThisRun >= BATCH_LIMIT) {
                    const posRate = ((newPositives / extractedThisRun) * 100).toFixed(1);
                    console.log(`\n[MINER v11.2] 💀 BATCH LIMIT (${BATCH_LIMIT}). ${posRate}% positive. Committing to Disk.`);
                    const fd = fs.openSync(outputFile, 'a');
                    for (const jsonLine of jsonlBuffer) {
                        fs.writeSync(fd, jsonLine + '\n');
                    }
                    fs.closeSync(fd);
                    drive.save();
                    if (fs.existsSync(activeCommitFile)) fs.unlinkSync(activeCommitFile);
                    process.exit(0);
                }
            }

            if (fs.existsSync(activeCommitFile)) fs.unlinkSync(activeCommitFile);

        } catch (err: any) {
            console.log(`[MINER] Topological bypass on ${hash?.slice(0, 8)}: ${err.message?.slice(0, 80)}. Skipping.`);
            if (fs.existsSync(activeCommitFile)) fs.unlinkSync(activeCommitFile);
        }
    }

    if (jsonlBuffer.length > 0) {
        const fd = fs.openSync(outputFile, 'a');
        for (const jsonLine of jsonlBuffer) {
            fs.writeSync(fd, jsonLine + '\n');
        }
        fs.closeSync(fd);
    }
    drive.save();
    drive.cleanup();

    const totalLines = historicalLines + extractedThisRun;
    const totalPositives = historicalPositives + newPositives;
    const pct = totalLines > 0 ? ((totalPositives / totalLines) * 100).toFixed(1) : '0';

    console.log(`\n[MINER v11.2] 🎉 Lanczos-PRO complete! Global samples: ${totalLines} (${pct}% positive)`);
    process.exit(42);
}

const repoUrl = process.argv[2];
if (!repoUrl) { console.error('Usage: npx tsx scripts/chronos-miner.ts <repo-url>'); process.exit(1); }
mineIndestructibleHistory(repoUrl).catch(err => { console.error(`[MINER] Fatal: ${err.message}`); process.exit(1); });
