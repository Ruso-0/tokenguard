import * as ts from "typescript";

export interface TopologicalEdge {
    sourceId: string;
    targetId: string;
    sourceFile: string;
    targetFile: string;
    weight: number;
}

export interface SparseEdge {
    u: number;
    v: number;
    weight: number;
}

export interface SpectralResult {
    fiedlerValue: number;
    volume: number;
    nodeCount: number;
    edgeCount: number;
    activeNodes?: number;
    v2?: Float64Array;
    lambda3?: number;
    v3?: Float64Array;
    nodeIndex?: Map<string, number>;
}

export interface SpectralDelta {
    fiedlerPre: number;
    fiedlerPost: number;
    volumePre: number;
    volumePost: number;
    normalizedFiedlerDrop: number;
    volumeDrop: number;
    verdict: "APPROVED" | "REJECTED_ENTROPY" | "APPROVED_DECOUPLING";
}

export class SpectralTopologist {

    public static extractConstraintGraph(
        program: ts.Program,
        targetFiles: Set<string>
    ): { nodes: Set<string>; edges: TopologicalEdge[] } {

        const checker = program.getTypeChecker();
        const nodes = new Set<string>();
        const edges: TopologicalEdge[] = [];

        for (const posixPath of targetFiles) {
            const sf = program.getSourceFile(posixPath);
            if (!sf) continue;

            const fileSymbol = checker.getSymbolAtLocation(sf);
            if (!fileSymbol || !fileSymbol.exports) continue;

            for (const exp of checker.getExportsOfModule(fileSymbol)) {
                const decl = exp.valueDeclaration || exp.declarations?.[0];
                if (!decl || decl.getSourceFile().fileName !== posixPath) continue;

                const sourceId = `${posixPath}::${exp.getName()}`;
                nodes.add(sourceId);

                const findDependencies = (node: ts.Node) => {
                    // ── RADICAL O(1) PRUNING (CORRECTED v7.3.3) ────────────────
                    // DO NOT prune ObjectLiterals, ArrayLiterals, or CallExpressions —
                    // they contain method signatures, type assertions, and generics
                    // (Express handlers, Vue defineComponent, tRPC routers, Pinia stores).
                    // DO prune blocks (function bodies) and primitive literals
                    // to maintain O(1) performance without sacrificing topology.
                    if (
                        ts.isBlock(node) ||
                        ts.isBinaryExpression(node) ||
                        ts.isTemplateExpression(node) ||
                        ts.isStringLiteral(node) ||
                        ts.isNumericLiteral(node) ||
                        ts.isNoSubstitutionTemplateLiteral(node)
                    ) {
                        return;
                    }

                    if (node.kind === ts.SyntaxKind.AnyKeyword || node.kind === ts.SyntaxKind.UnknownKeyword) {
                        return;
                    }

                    if (ts.isTypeReferenceNode(node)) {
                        let targetSymbol = checker.getSymbolAtLocation(node.typeName);

                        if (targetSymbol) {
                            if (targetSymbol.flags & ts.SymbolFlags.Alias) {
                                targetSymbol = checker.getAliasedSymbol(targetSymbol);
                            }

                            const targetDecl = targetSymbol.valueDeclaration || targetSymbol.declarations?.[0];
                            if (targetDecl) {
                                const targetPath = targetDecl.getSourceFile().fileName.replace(/\\/g, "/");

                                if (!targetPath.includes("/node_modules/")) {
                                    const targetId = `${targetPath}::${targetSymbol.getName()}`;
                                    nodes.add(targetId);
                                    edges.push({ sourceId, targetId, sourceFile: posixPath, targetFile: targetPath, weight: 1.0 });
                                } else {
                                    const extId = `EXTERNAL::${targetSymbol.getName()}`;
                                    nodes.add(extId);
                                    edges.push({ sourceId, targetId: extId, sourceFile: posixPath, targetFile: "EXTERNAL", weight: 1.0 });
                                }
                            }
                        }

                        // Generics DO matter: Promise<User> → User is an edge
                        if (node.typeArguments) node.typeArguments.forEach(findDependencies);
                        return; // End of branch. Do not descend further.
                    }

                    // ── STRUCTURAL FIX: Intercept ALL function signatures ────────
                    // Extract type references from signatures but NEVER enter function bodies.
                    // Added: isMethodDeclaration (Vue/Express/class methods)
                    // Added: isFunctionDeclaration (nested named functions)
                    if (
                        ts.isArrowFunction(node) ||
                        ts.isFunctionExpression(node) ||
                        ts.isMethodDeclaration(node) ||
                        ts.isFunctionDeclaration(node)
                    ) {
                        if (node.typeParameters) node.typeParameters.forEach(findDependencies);
                        node.parameters.forEach(findDependencies);
                        if (node.type) findDependencies(node.type);
                        return; // Do NOT enter the body
                    }

                    ts.forEachChild(node, findDependencies);
                };

                findDependencies(decl);
            }
        }

        return { nodes, edges };
    }

    public static buildSparseGraph(
        nodes: Set<string>,
        edges: TopologicalEdge[]
    ): { sparseEdges: SparseEdge[]; nodeIndex: Map<string, number>; N: number } {

        const sortedNodes = Array.from(nodes).sort();
        const nodeIndex = new Map<string, number>();
        sortedNodes.forEach((n, i) => nodeIndex.set(n, i));

        const N = sortedNodes.length;
        const sparseEdges: SparseEdge[] = [];

        for (const edge of edges) {
            const u = nodeIndex.get(edge.sourceId);
            const v = nodeIndex.get(edge.targetId);
            if (u !== undefined && v !== undefined && u !== v) {
                sparseEdges.push({ u, v, weight: edge.weight });
            }
        }

        return { sparseEdges, nodeIndex, N };
    }

    public static computeDelta(
        pre: SpectralResult,
        post: SpectralResult
    ): SpectralDelta {

        // Φ: Topological Entropy Index
        // When N stays constant (ghost/expansion): Φ = λ₂ * density, density = 2V/(N*(N-1))
        // When N decreases (decoupling): Φ = λ₂ / N_AST (original formula)
        let phiPre: number, phiPost: number;

        if (pre.nodeCount <= post.nodeCount) {
            // Ghost / Expansion case: nodes stay or grow but lose edges.
            // Density formula Φ = λ₂ * (2V / (N*(N-1))) detects dilution.
            const denPre = pre.nodeCount > 1 ? pre.nodeCount * (pre.nodeCount - 1) : 1;
            phiPre = pre.nodeCount > 0 ? (pre.fiedlerValue * 2 * pre.volume) / denPre : 0;
            const denPost = post.nodeCount > 1 ? post.nodeCount * (post.nodeCount - 1) : 1;
            phiPost = post.nodeCount > 0 ? (post.fiedlerValue * 2 * post.volume) / denPost : 0;
        } else {
            // Decoupling case: nodes were deleted from AST.
            // Original formula respects N_AST reduction.
            phiPre = pre.nodeCount > 0 ? pre.fiedlerValue / pre.nodeCount : 0;
            phiPost = post.nodeCount > 0 ? post.fiedlerValue / post.nodeCount : 0;
        }
        const normalizedFiedlerDrop = phiPre - phiPost;
        const dropRatio = phiPre > 0 ? normalizedFiedlerDrop / phiPre : 0;
        const volumeDrop = pre.volume - post.volume;

        // Adaptive epsilon with hard bounds [0.10, 0.30]
        // N_AST=3 → ε≈0.30 (ghost in K3 = 33% drop, always caught)
        // N_AST=50 → ε≈0.15 (standard)
        // N_AST=500 → ε≈0.10 (floor, never less sensitive than 10%)
        const baseEpsilon = 0.15;
        const scaleFactor = Math.sqrt(50 / Math.max(1, pre.nodeCount));
        const epsilonDynamic = Math.max(0.10, Math.min(0.30, baseEpsilon * scaleFactor));

        let verdict: SpectralDelta["verdict"];

        if (volumeDrop > 0 && dropRatio > epsilonDynamic) {
            verdict = "REJECTED_ENTROPY";
        } else if (volumeDrop <= 0 && normalizedFiedlerDrop > 0) {
            verdict = "APPROVED_DECOUPLING";
        } else {
            verdict = "APPROVED";
        }

        return {
            fiedlerPre: pre.fiedlerValue,
            fiedlerPost: post.fiedlerValue,
            volumePre: pre.volume,
            volumePost: post.volume,
            normalizedFiedlerDrop,
            volumeDrop,
            verdict,
        };
    }

    public static getMarkovBlanket(
        targetFile: string,
        edges: TopologicalEdge[]
    ): Set<string> {
        const blanket = new Set<string>();
        blanket.add(targetFile);

        for (const edge of edges) {
            const sourceFile = edge.sourceFile;
            const targetFileFromEdge = edge.targetFile;

            if (sourceFile === targetFile && !targetFileFromEdge.startsWith("EXTERNAL")) {
                blanket.add(targetFileFromEdge);
            }
            if (targetFileFromEdge === targetFile && !sourceFile.startsWith("EXTERNAL")) {
                blanket.add(sourceFile);
            }
        }

        return blanket;
    }

    public static filterFirstCrown(
        targetFile: string,
        nodes: Set<string>,
        edges: TopologicalEdge[]
    ): { crownNodes: Set<string>; crownEdges: TopologicalEdge[] } {

        const targetPrefix = `${targetFile}::`;

        const coreNodes = new Set<string>();
        for (const n of nodes) {
            if (n.startsWith(targetPrefix)) coreNodes.add(n);
        }

        const validNodes = new Set<string>(coreNodes);
        for (const e of edges) {
            if (coreNodes.has(e.sourceId)) validNodes.add(e.targetId);
            if (coreNodes.has(e.targetId)) validNodes.add(e.sourceId);
        }

        const crownEdges = edges.filter(e =>
            validNodes.has(e.sourceId) && validNodes.has(e.targetId)
        );

        return { crownNodes: validNodes, crownEdges };
    }

    public static analyze(
        program: ts.Program,
        targetFiles: Set<string>,
        targetFile?: string
    ): SpectralResult {

        const { nodes, edges } = this.extractConstraintGraph(program, targetFiles);

        let analysisNodes = nodes;
        let analysisEdges = edges;

        if (targetFile) {
            const blanket = this.getMarkovBlanket(targetFile, edges);
            analysisNodes = new Set<string>();
            analysisEdges = [];
            for (const edge of edges) {
                const sourceFile = edge.sourceFile;
                const targetFileFromEdge = edge.targetFile;
                if (blanket.has(sourceFile) && (blanket.has(targetFileFromEdge) || targetFileFromEdge.startsWith("EXTERNAL"))) {
                    analysisNodes.add(edge.sourceId);
                    analysisNodes.add(edge.targetId);
                    analysisEdges.push(edge);
                }
            }
        }

        if (analysisNodes.size <= 1) {
            return {
                fiedlerValue: 0, volume: 0,
                nodeCount: analysisNodes.size, edgeCount: analysisEdges.length,
            };
        }

        const { sparseEdges, nodeIndex, N } = this.buildSparseGraph(analysisNodes, analysisEdges);
        const state = SpectralMath.analyzeTopology(N, sparseEdges);

        return {
            fiedlerValue: state.fiedler,
            volume: state.volume,
            nodeCount: analysisNodes.size,
            edgeCount: analysisEdges.length,
            v2: state.v2,
            lambda3: state.lambda3,
            v3: state.v3,
            nodeIndex: N > 1 ? nodeIndex : undefined,
        };
    }
}

export class SpectralMath {
    public static analyzeTopology(N: number, edges: SparseEdge[]): {
        fiedler: number; volume: number;
        v2?: Float64Array; lambda3?: number; v3?: Float64Array;
    } {
        if (N <= 1) return { fiedler: 0, volume: 0 };

        // Size guard: power iteration is O(N² × 150 iterations).
        // For N>5000 this could block the event loop for hundreds of ms.
        // Return a structural estimate instead.
        if (N > 25000) {
            let volume = 0;
            for (const e of edges) volume += e.weight;
            const avgDegree = (2 * edges.length) / N;
            return { fiedler: avgDegree * 0.5, volume };
        }

        // --- Edge deduplication (IDÉNTICO AL ORIGINAL - NO TOCAR) ---
        const edgeMap = new Map<number, Map<number, number>>();

        for (let i = 0; i < edges.length; i++) {
            const e = edges[i];
            if (e.u === e.v) continue;

            const min = Math.min(e.u, e.v);
            const max = Math.max(e.u, e.v);

            let row = edgeMap.get(min);
            if (!row) {
                row = new Map<number, number>();
                edgeMap.set(min, row);
            }

            const currentW = row.get(max) || 0;
            if (e.weight > currentW) row.set(max, e.weight);
        }

        // --- CSR construction pass 1 (IDÉNTICO AL ORIGINAL - NO TOCAR) ---
        const degree = new Float64Array(N);
        const neighborCount = new Int32Array(N);
        let maxDegree = 0;
        let volume = 0;
        let seed = N * 2654435761;

        for (const [u, row] of edgeMap.entries()) {
            for (const [v, w] of row.entries()) {
                neighborCount[u]++; neighborCount[v]++;
                degree[u] += w; degree[v] += w;
                volume += w;
                if (degree[u] > maxDegree) maxDegree = degree[u];
                if (degree[v] > maxDegree) maxDegree = degree[v];
                seed = ((seed << 5) - seed + (w * 1000 | 0)) | 0;
            }
        }

        // Prefix sum → rowPtr (IDÉNTICO AL ORIGINAL - NO TOCAR)
        const rowPtr = new Int32Array(N + 1);
        for (let i = 0; i < N; i++) rowPtr[i + 1] = rowPtr[i] + neighborCount[i];
        const nnz = rowPtr[N];

        // --- CSR construction pass 2 (IDÉNTICO AL ORIGINAL - NO TOCAR) ---
        const colIdx = new Int32Array(nnz);
        const csrValues = new Float64Array(nnz);
        for (let i = 0; i < N; i++) neighborCount[i] = rowPtr[i];

        for (const [u, row] of edgeMap.entries()) {
            for (const [v, w] of row.entries()) {
                colIdx[neighborCount[u]] = v; csrValues[neighborCount[u]++] = w;
                colIdx[neighborCount[v]] = u; csrValues[neighborCount[v]++] = w;
            }
        }

        // ─── NUEVO: Capturar seed post-mutación + Power Iteration con Deflación ───

        const dataSeed = seed; // Semilla POST-mutación exacta del original
        const c = maxDegree * 2.0 + 1.0;

        const powerIteration = (
            deflateVectors: Float64Array[],
            seedModifier: number
        ): { val: number; vec: Float64Array } => {
            const vec = new Float64Array(N);
            let currentSeed = (dataSeed + seedModifier) | 0;
            for (let i = 0; i < N; i++) {
                currentSeed = (currentSeed * 1103515245 + 12345) | 0;
                vec[i] = ((currentSeed >>> 16) & 0x7fff) / 32768.0 - 0.5;
            }

            const v_next = new Float64Array(N);
            let mu = 0;
            let prev_mu = -1;
            let prevDelta = Infinity;

            for (let iter = 0; iter < 150; iter++) {
                // 1. Deflate trivial eigenvector (constant)
                let sum = 0;
                for (let i = 0; i < N; i++) sum += vec[i];
                const mean = sum / N;
                for (let i = 0; i < N; i++) vec[i] -= mean;

                // 2. Gram-Schmidt orthogonalization against previous vectors
                for (const dv of deflateVectors) {
                    let dot = 0;
                    for (let i = 0; i < N; i++) dot += vec[i] * dv[i];
                    for (let i = 0; i < N; i++) vec[i] -= dot * dv[i];
                }

                // 3. L2 normalization
                let normSq = 0;
                for (let i = 0; i < N; i++) normSq += vec[i] * vec[i];
                if (normSq < 1e-18) break;
                const rNorm = 1.0 / Math.sqrt(normSq);
                for (let i = 0; i < N; i++) vec[i] *= rNorm;

                // 4. Fused SpMV: (cI - L)v + Rayleigh Quotient
                let norm = 0;
                mu = 0;
                for (let i = 0; i < N; i++) {
                    let Lv_i = degree[i] * vec[i];
                    const end = rowPtr[i + 1];
                    for (let k = rowPtr[i]; k < end; k++) {
                        Lv_i -= csrValues[k] * vec[colIdx[k]];
                    }
                    const val = c * vec[i] - Lv_i;
                    v_next[i] = val;
                    norm += val * val;
                    mu += vec[i] * val;
                }

                norm = Math.sqrt(norm);
                if (norm < 1e-9) break;
                // FIX: Dual convergence criterion.
                // Check BOTH eigenvalue (mu) AND eigenvector stability.
                // The eigenvalue converges quadratically faster than the
                // eigenvector. Checking only mu can exit while the vector
                // is still rotating, producing noisy v2/v3 components.
                let maxVecDiff = 0;
                for (let j = 0; j < N; j++) {
                    const diff = Math.abs(vec[j] - v_next[j] / norm);
                    if (diff > maxVecDiff) maxVecDiff = diff;
                }
                for (let i = 0; i < N; i++) vec[i] = v_next[i] / norm;

                const delta = Math.abs(mu - prev_mu);
                if (delta < 1e-7 && maxVecDiff < 1e-6) break;
                // Divergence guard: if eigenvalue delta is growing instead of shrinking, bail out
                if (iter > 20 && delta > prevDelta * 2) break;
                prevDelta = delta;
                prev_mu = mu;
            }

            // GAUGE FIXING (Phase Canonicalization)
            // Lv = λv → if v is an eigenvector, -v is too.
            // Power iteration converges to v or -v arbitrarily due to floating-point noise.
            // To prevent a temporal neural network from seeing fictitious phase jumps between commits,
            // we force deterministic orientation: the largest-magnitude component is always positive.
            let maxAbs = -1;
            let signMultiplier = 1;
            for (let i = 0; i < N; i++) {
                const absVal = Math.abs(vec[i]);
                if (absVal > maxAbs) {
                    maxAbs = absVal;
                    signMultiplier = vec[i] < 0 ? -1 : 1;
                }
            }
            if (signMultiplier === -1) {
                for (let i = 0; i < N; i++) vec[i] *= -1;
            }

            return { val: Math.max(0, c - mu), vec };
        };

        // Extract λ₂ (Fiedler) — seedModifier=0 preserves original behavior
        const res2 = powerIteration([], 0);

        // Extract λ₃ — seedModifier=99991 ensures different subspace, deflating v₂
        const res3 = powerIteration([res2.vec], 99991);

        return {
            fiedler: res2.val,
            volume,
            v2: res2.vec,
            lambda3: res3.val,
            v3: res3.vec,
        };
    }
}
