# Changelog

All notable changes to NREKI will be documented in this file.

## 8.0.2 (2026-04-09) — Firewall Verification Test

### Fixed (Test Coverage Gap)
- **Numerical Sanity Firewall regression test:** v8.0.1 introduced an 8-layer
  defense in depth against IEEE 754 NaN/Infinity propagation in the spectral
  solver, but the firewall itself had no dedicated regression test — none of
  the 712 existing tests constructed a graph that triggered real overflow in
  the power iteration. This release adds a single test that builds a star
  graph with extreme weights (1e150 × 1000 nodes), demonstrably overflows the
  `norm` accumulator (`val² ≈ 1e306` × 1000 = `1e309 > Number.MAX_VALUE`),
  and verifies that the Hot-Loop Thermal Guard catches `Infinity` in `norm`,
  the λ₂ short-circuit catches the resulting `NaN`, and the function falls
  back to the degenerate variant of the discriminated union (no `v2`,
  `lambda3`, or `v3`). Defense without verification was half a defense; this
  closes that gap.

### Notes
- **Tests:** 712 → 713 (the new firewall regression test).
- **Behavioral change:** none. This is purely a coverage addition.
- **No breaking changes.** No API surface modified.
- The 3 deferred items from v8.0.1 remain deferred:
  - **Kahan summation:** rejected (precision obliterated by `toFixed(4)`)
  - **PageRank FP audit:** rejected (mathematically immune via L1 simplex)
  - **God Object kernel refactor:** deferred to v8.1 (SRE rule: never mix
    architectural refactors with critical patches)

---

## 8.0.1 (2026-04-08) — IEEE 754 Hardening: NaN Sink Eradication

### Fixed (Critical — Mathematical Soundness)
- **Spectral Bridge Threshold:** Latent NaN sink in `repo-map.ts` `gamma` calculation. Power iteration on hub-heavy graphs could overflow (`c·v − L·v → Inf − Inf → NaN`), and IEEE 754 makes both `NaN > 1e-9` and `NaN <= 1e-9` evaluate to `false`. The previous fallback silently substituted `γ = 1.0` (a fictitious `λ₃ = λ₂`), producing **phantom architectural bridges** with zero spectral guarantee. Fixed via 8-layer defense in depth.
- **`SpectralMath.analyzeTopology` return type:** Replaced "bag of optionals" (`v2?`, `lambda3?`, `v3?`) with a strict **discriminated union** that encodes the runtime invariant `v2 ⟺ lambda3 ⟺ v3`. Consumers narrowing on `if (result.v2)` now get `lambda3: number` and `v3: Float64Array` for free — no more paranoid `lambda3 !== undefined` checks downstream, and the type system actively prevents the original ternary from being written again.
- **Numerical Sanity Firewall (Producer):** Added an `O(N)` perimeter check before the final return of `analyzeTopology`. If `res2.val`, `res3.val`, or any element of `res2.vec` / `res3.vec` is non-finite, the function falls back to the degenerate variant `{ fiedler: 0, volume }`. Restores the invariant "spectral vectors are finite, or they don't exist at all".
- **HPC Hot-Loop Thermal Guard:** Added explicit `return { val: NaN, vec }` inside the SpMV power iteration. If `mu` or `norm` corrupt to NaN/Infinity mid-iteration, the loop aborts immediately, **skipping the gauge fixing pass over a poisoned `vec` array**. Saves up to 150 wasted iterations of NaN propagation and hands off cleanly to the perimeter firewall.
- **λ₃ Short-Circuit:** If `λ₂` extraction yields NaN, skip the second power iteration entirely (would otherwise receive a poisoned `res2.vec` as deflation basis and contaminate from `iter=0`). Saves one full SpMV cycle on degenerate inputs.
- **Denormal Float Guard:** Replaced `if (degree[i] > 0)` with `if (degree[i] > 1e-12)` in the normalized Laplacian path. Subnormal floats (~2.2e-308 and below) force the CPU FPU into microcode emulation causing **~100x pipeline stalls**, and `1.0 / Math.sqrt(1e-320) ≈ 1e+160` overflows in subsequent SpMV products. Threshold safely above the denormal range.
- **Consumer NaN Trap:** Simplified the `gamma` ternary in `repo-map.ts` now that `lambda3` narrows to `number`. Explicit `Number.isNaN(spectral.fiedler)` check, fail-closed: NaN or near-zero `fiedler → γ=∞ → bridgeThreshold=0`. Second line of defense after the producer firewall.
- **Timsort Determinism Guard:** V8's `Array.prototype.sort()` (TimSort) silently breaks transitivity if the comparator returns NaN, producing implementation-defined order that **would silently poison prompt cache byte-identity across runs**. The Bridge stress ranking comparator in `repoMapToText` now returns `0` (tie) on NaN to keep sort stable and reproducible.

### Notes
- **Bridge threshold bounds:** v8.0.0 CHANGELOG documented the bounds as `[0.01, 0.15]`. The implementation enforces these exact bounds — no change in v8.0.1. The fix only affects the `γ` denominator under pathological inputs.
- **Kahan summation evaluated and rejected:** A rigorous HPC review considered Kahan-compensated summation for the SpMV accumulators (`norm`, `mu`) to mitigate catastrophic cancellation at large `N`. Explicitly discarded because it perturbs the last bits of the eigenvalue mantissa, which **would break byte-for-byte prompt cache consistency** (the project's "byte-identical sort" commitment, see commits `fc9c79d` and `824011f`). Trade-off: precision is bounded by naïve FP accumulation, but reproducibility is absolute. Documented decision, not technical debt.
- **712 tests pass unchanged.** No behavioral regression on the happy path. The fixes only activate under conditions the existing test suite does not synthesize (overflow on `maxDegree*2+1` shift, denormal weights). Future work: a hub-overflow regression test for v8.1.

### Internal
- `tests/spectral-topology.test.ts:101-113` formally validates the `v2 ⟺ lambda3 ⟺ v3` invariant via `expect(result.lambda3).toBeDefined()` for non-trivial graphs. The discriminated union now enforces this at compile time.

---

## 8.0.0 (2026-04-02) — Antigravity: Spectral Architecture Engine

### Breaking Changes
- **Cache format:** `CACHE_FORMAT_VERSION` bumped from 1 to 2. Old `.nreki/repo-map.json` caches are auto-regenerated on first run. No manual action needed.
- **`buildDependencyGraph`** is now `async` (returns `Promise<DependencyGraph>`). Only affects code that imports this function directly.
- **`interceptAtomicBatch`** signature extended with optional `computeDiff: boolean = false` parameter. Backward compatible (defaults to `false`).

### Features — Spectral Clustering & Architecture Intelligence
- **Cyclomatic Complexity (β₁):** True topological circuit rank via Union-Find with path compression on the type constraint graph. Excludes `EXTERNAL::` nodes. Formula: `β₁ = E_int - V_int + C_int` (first Betti number). Added to `SpectralResult.cyclomaticComplexity`.
- **Architecture Diff:** Real-time λ₂ and β₁ shift detection on `batch_edit`. Shows algebraic connectivity change, circuit rank delta, and verdict (`APPROVED` / `APPROVED_DECOUPLING` / `REJECTED_ENTROPY`). Opt-in via `computeDiff: true` on `interceptAtomicBatch`, auto-enabled for `batch_edit`.
- **Spectral Clustering:** File-level macro-topology using the Fiedler vector (v₂) from the combinatorial Laplacian. Partitions the repository into `cluster_a` (positive polarity), `cluster_b` (negative polarity), `bridge` (v₂ ≈ 0, structural bottleneck), and `orphan` (zero degree). Bridge threshold: `ε = σ/γ` where `γ = λ₃/λ₂` (spectral gap ratio), bounded `[0.01, 0.15]`.
- **Repo Map v2:** `repoMapToText` now renders files grouped by spectral cluster with topology metadata. Bridges sorted by stress ranking (`inDegree / |v₂|`). Header includes λ₂ value. Fallback rendering for pre-v8 caches.
- **Orphan Oracle:** `nreki_navigate action:"orphan_oracle"` — Mark-and-Sweep reachability analysis from framework roots (index, main, config, tests, routes, stories, migrations, service workers). Reports files with exports that are completely unreachable via static imports. Includes dynamic import warning.
- **Bridge Guard:** `handleEdit` now detects when the target file is a structural bridge (v₂ ≈ 0) and injects a real-time warning to the LLM with v₂ score, dependent count, and instructions to use `batch_edit` for signature changes.
- **DependencyGraph extended:** New optional fields `clusters`, `v2Score`, `fiedler` on `DependencyGraph` and `DependencyGraphData`. Fully serializable for cache persistence.
- **NrekiInterceptResult extended:** New optional field `architectureDiff` carries the formatted topology diff string.

### Internal
- `SpectralResult` interface extended with optional `cyclomaticComplexity` field.
- `serializeGraph` / `deserializeGraph` updated for cluster data round-tripping.
- `processKernelResult` concatenates `architectureDiff` to TTRD feedback.
- Router dispatch extended with `orphan_oracle` case.
- Zod schema for `nreki_navigate` extended with `orphan_oracle` action.
- Test assertions updated for new repo map header format (`λ₂=` suffix).
- All 712 tests pass.

---

## 7.4.1 (2026-03-31) — Normalized Laplacian + Isolated Node Exile

### Features
- **Spectral Topology:** `normalized: boolean = false` flag on `analyzeTopology()`. When true, uses symmetric normalized Laplacian (L_sym = I - D^{-1/2}AD^{-1/2}) confining λ₂ to [0, 2] instead of [0, ∞). Covers 4 critical traps: deflation against √D, div/0 guard for isolated nodes, shift constant c=2.0, and diagonal=1.0 for connected nodes.

### Fixed
- **Spectral Topology:** Isolated node exile in normalized path. Degree-0 nodes had eigenvalue c in the shifted matrix (cI - L_sym), dominating over the Fiedler. Power iteration converged to orphan files instead of real architectural bottlenecks. Fix: force `v_next[i] = 0` for isolated nodes.
- **npx Windows:** CJS bin wrapper (`bin/nreki.cjs`) bridges CJS→ESM so `.cmd` shim resolves correctly on all platforms. `npx @ruso-0/nreki` now works on Windows.

---

## 7.3.5 (2026-03-31) — Full Security Audit

### Security
- **Path Jail:** Symlink bypass on sensitive file check — now validates realpath target
- **Path Jail:** TTRD pre-scan reads files before path jail validation (arbitrary file read)
- **Path Jail:** LSP codeAction `bestFix.filePath` not validated against workspace
- **Path Jail:** `compressFile`/`compressFileAdvanced` now enforce path jail
- **Path Jail:** Context Heartbeat master plan path validated via safePath (LFI fix)
- **LSP Sidecar:** `Date.now()` overflows int32 in gopls — replaced with monotonic counter
- **LSP Sidecar:** Windows URI case mismatch breaks auto-healing on Windows
- **Auto-Healer:** `SAFE_FIXES` removed `fixClassDoesntImplementInheritedAbstractMember` and `fixAddMissingMember` — both inject `throw new Error("Method not implemented.")` stubs

### Critical Fixes
- **Kernel:** `mutatedFiles` not cleared in `commitToDisk()` catch + `rollbackAll()` — next commit deletes real user files
- **Kernel:** Auto-healed files never registered in `mutatedFiles` — healed code vanishes from disk
- **Database:** `save()` atomic via temp+rename (prevents truncation on crash)
- **Database:** `updateAvgDocLen()` O(N²) → O(1) via running total (prevents DoS on bulk indexing)

### Fixed
- **Kernel:** WAL recovery per-entry try-catch — one locked file no longer destroys all backups
- **Kernel:** VFS ghosting in hologram — pruned files with VFS edits now visible to compiler
- **Kernel:** `fs.readFileSync` unprotected in healer hot path — ENOENT no longer aborts transaction
- **Kernel:** Corruption guard moved inside mutex (prevents concurrent `purgeCache()`)
- **Kernel:** `createdTmps.push` before write (prevents orphaned .tmp on ENOSPC)
- **Kernel:** `rollbackSidecars` docstring updated to reflect async behavior
- **LSP Sidecar:** `didClose` tombstone replaced with empty `didChange` (prevents split-brain)
- **LSP Sidecar:** Buffer overflow triggers `forceKill()` instead of silent truncation
- **TS Compiler:** `getAutoFixes` matches by line+column (prevents infinite micro-rollback loop)
- **TS Compiler:** Pre-compiled regex in `getFingerprint` (3 RegExp per diagnostic → 0)
- **TS Compiler:** Cascade threshold includes sample of first 5 errors for LLM diagnosis
- **Spectral:** Removed ObjectLiteral/ArrayLiteral/CallExpression pruning (Vue/Express/tRPC visibility)
- **Spectral:** `isMethodDeclaration` + `isFunctionDeclaration` added to signature interceptor
- **Database:** `insertChunksBatch` rollback purges phantom entries from RAM indexes
- **Engine:** Thundering herd on `unlink` — `db.save()` replaced with 1s debounced `scheduleSave()`
- **Engine:** Ghost chunks cleaned on early return (filtered/empty files)
- **Engine:** T-RAG `cachedGraph` invalidated after watcher changes
- **Semantic Edit:** Batch edit ambiguity check — rejects duplicate symbol names
- **Semantic Edit:** Single edit atomic write via temp+rename
- **Router:** Heartbeat `<=` → `<` prevents infinite injection loop on tool failure

## 7.3.1 (2026-03-30)

### Security
- **Path Jail:** Block `.git/hooks/` (RCE vector), `.envrc` (direnv RCE), `.age/` directories
- **Path Jail:** Fail-closed on parent resolution errors (was fail-open on EACCES/ELOOP)
- **LSP Sidecars:** ENV whitelist — secrets no longer leak to gopls/pyright child processes

### Fixed
- **TTRD Python:** `^\s*def` captures indented class methods (was `^def` — missed all methods inside classes)
- **TTRD Python:** Triple-quoted docstrings no longer corrupt bracket balancer
- **TTRD Go:** Private functions now tracked (was exported-only)
- **Auto-Healer:** Global error comparison replaces per-file (prevents collateral damage approval)
- **Auto-Healer:** Micro/macro rollbacks are synchronous (cures LSP split-brain)
- **Pull Diagnostics:** Cross-file error collection from all open files
- **Pull Diagnostics:** Push notifications suppressed in pull mode (race condition fix)
- **WAL:** Atomic write via temp+rename (prevents truncation on crash)
- **Hologram:** `currentEditTargets` cleared on rollback (prevents ghost unpruning)
- **Process Kill:** `kill(-pid)` on POSIX kills entire process group (prevents zombie workers)
- **VectorIndex:** Always deep-copy on deserialize (prevents buffer sharing with WASM)

## v7.3.0 - Multi-Language Auto-Healing (2026-03-29)

### Added — Multi-Language (9 Surgeries)
- **LSP Auto-Healing Dual Cascade** (`nreki-kernel.ts`): Go (gopls) and Python (pyright) errors auto-fixed via `textDocument/codeAction`. Conservative whitelist: only import-related fixes. Ice Wall filter blocks "remove"/"delete" actions. TypeScript heals first (~20ms), then LSP (~300ms, max 2 iterations). Split-brain rollback re-syncs sidecar VFS on micro-rollback
- **TTRD Syntactic v2** (`nreki-kernel.ts`): Hybrid micro-scanner (regex anchor + bracket balancer) extracts signatures from Python/Go. Detects toxic `Any`/`interface{}` injection, lost return types (`->`), and stripped parameter annotations. Zero false positives on clean refactors (e.g. `Dict[str, Union[...]]` → `ConfigPayload`)
- **Pull Diagnostics LSP 3.17+** (`lsp-sidecar-base.ts`): `textDocument/diagnostic` replaces 150ms settle timer. Deterministic — NREKI waits for server response, not a timer. Falls back to push model for older LSP servers
- **Python import resolution** (`repo-map.ts`): Dot-notation (`app.core.auth`) converted to slashes (`app/core/auth`) with progressive strip fallback. Real edges in dependency graph
- **Go import resolution** (`repo-map.ts`): Suffix matching for `github.com/org/project/utils` → local `utils/`. Real edges in dependency graph
- **`requestCodeActions()` + title** (`lsp-sidecar-base.ts`): LSP `textDocument/codeAction` exposed with action title for whitelist filtering. Supports both `WorkspaceEdit.changes` and `documentChanges` formats
- **LSP coordinate translator** (`nreki-kernel.ts`): `getLspOffset()` converts LSP line/character (0-indexed) to byte offsets. Survives `\r\n` (Windows)
- **Mock LSP Server** (`tests/mock-lsp-server.ts`): Full JSON-RPC 2.0 test server. 8 scenarios: `missing_import`, `clean`, `unfixable`, `destructive`, `multi_error`, `slow_response`. Responds to `initialize`, `textDocument/didOpen`, `textDocument/diagnostic`, `textDocument/codeAction`
- **TypeScript Corsa Backend placeholder** (`ts-corsa-sidecar.ts`): Ready for Microsoft Project Corsa (TypeScript 7.0 in Go). Inherits `LspSidecarBase`. Strangler Fig hot-swap when Corsa ships

### Added — Lifecycle Hardening
- **SSOT `cleanupState()`** (`lsp-sidecar-base.ts`): Single idempotent embudo for all process death paths. `if (this.isDead) return` guard prevents double-cleanup when `forceKill()` and `exit` event collide
- **Explicit timer tracking** (`lsp-sidecar-base.ts`): `PendingRequest` now stores `timer: NodeJS.Timeout`. `cleanupState()` kills all timers directly — no closure indirection
- **`forceKill()` with stdin destroy** (`lsp-sidecar-base.ts`): Destroys stdin pipe before SIGKILL, forcing OS to propagate closure to entire process tree (kills tsx wrappers and grandchildren)
- **`spawnEnv` injection** (`lsp-sidecar-base.ts`): Optional 4th constructor parameter for isolated env vars. Tests no longer mutate `process.env` globally

### Added — Miner
- **Chronos Miner v10 Turbine Oracle** (`chronos-miner.ts`): `git cat-file --batch` streaming (single process per chunk). Dynamic `import()` extraction. Pure TS/JS scope (`.mjs`, `.cjs` included). `node_modules/` and `dist/` filtered by regex segment. 512MB maxBuffer

### Changed
- Tests: 704 → 712 (44 suites). +8 LSP sidecar tests, +1 kernel CRLF test
- `LspSidecarBase`: `request()`, `toPosix()`, `workspaceUri`, `realProjectRoot` changed from `private` to `protected`
- `LspPosition` and `LspRange` interfaces exported for kernel consumption
- `shutdown()` now delegates entirely to `forceKill()` → `cleanupState()`
- Boot error handler, exit handler, and initialize catch all route through `cleanupState()` — zero asymmetric cleanup
- Healing message now groups TypeScript fixes and LSP fixes separately in output
- `interceptAtomicBatch()` uses Dual Cascade: TS healing first, then LSP healing only if TS succeeded

## v7.1.2 - 9 Critical Patches

### Fixed
- **Ghost Deletion** (`nreki-kernel.ts`): `mutatedFiles` now cleaned on rollback — prevents `commitToDisk()` from deleting real files that belonged to failed transactions
- **searchRawCode exact match** (`database.ts`): Replaced `String.includes()` with `Set.has()` — eliminates false positives (e.g. "id" no longer matches "width") and changes complexity from O(N) to O(1)
- **Arrow function angleDepth** (`parser.ts`): `=>` operator no longer decrements `angleDepth` below 0 — prevents extracting entire arrow function bodies as "signatures" in the repo map
- **Circuit Breaker exception visibility** (`circuit-breaker.ts`): `wrapWithCircuitBreaker` now catches handler exceptions via try/catch and converts them to `McpToolResponse` with `isError: true` — breaker is no longer blind to ENOENT loops and timeout cascades
- **Prompt cache preservation** (`router.ts`): Context Heartbeat now injected AFTER original text for all actions (not just `map`) — preserves Anthropic prefix cache hit rate
- **clearChunks files table** (`database.ts`): `clearChunks()` now also deletes from `files` table — prevents permanent invisibility when a file is deleted and recreated with the same content
- **splitParams string-aware** (`shadow-generator.ts`): `splitParams()` now tracks string state (single, double, backtick quotes) — prevents splitting on commas inside string literals that produce broken `.d.ts` output
- **LSP sidecar listener cleanup** (`lsp-sidecar-base.ts`): `proc.on("error")` handler now removes exit/SIGINT/SIGTERM listeners — prevents `MaxListenersExceededWarning` and memory leak on repeated spawn failures
- **macOS case-insensitive file lock** (`file-lock.ts`): `normalizeLockKey` now treats `darwin` same as `win32` (lowercase) — prevents file corruption from parallel locks on `App.ts` vs `app.ts` on macOS APFS

### Changed
- Tests: 696 → 704 (8 new tests for patch coverage)
- CI: replaced hardcoded `grep "696 passed"` with JSON reporter validation (no more brittle test count checks)

## v7.0.0 - Software Physics Engine

### Added
- **Fiedler Vector extraction**: `analyzeTopology` now returns the full eigenvector `v2` (bridge fragility map)
- **Third eigenvalue (λ₃)**: Enables spectral gap computation ∇(λ₃ - λ₂) for predictive analysis
- **Third eigenvector (v3)**: Topological stress coordinates per node
- **Gauge Fixing**: Deterministic phase canonicalization prevents sign ambiguity across commits (critical for ML pipelines)
- **Gram-Schmidt deflation**: Reusable `powerIteration()` function extracts arbitrary eigenvectors
- **nodeIndex passthrough**: `SpectralTopologist.analyze()` now returns the symbol→index mapping
- **Monorepo workspace resolution**: `buildFastLookup` resolves `@org/package` imports via O(1) string math (supports packages/, workspaces/, libs/, apps/)
- **Adaptive Shotgun Surgery threshold**: Scales with repo size via `Math.max(8, floor(N × 0.015))` — no more false positives on large codebases
- **Modern module extensions**: Full `.mts`, `.cts`, `.mjs`, `.cjs` support across parser, kernel, repo-map, and JIT holography

### Fixed
- **VFS zombie state**: `commitToDisk()` now purges VFS on disk write failure, preventing ghost content desync
- **WASM race conditions**: Serialized language loading via `loadGate` in parser.ts, ast-sandbox.ts, parser-pool.ts
- **Power iteration seed**: Uses data-dependent post-mutation seed for deterministic convergence
- **extractName regex purge**: Replaced 20 fragile regex patterns across 2 files with AST-first keyword-stripping word splitter
- **32 audit fixes (v6.1.x)**: Shadow codegen, TTRD amnesty bypass, orphan .tmp leak, Python indentation, splice duplicate detection, WeakMap middleware, syncTechDebt phantom accumulation, undo key normalization, APFS locks, allocUnsafe, SharedArrayBuffer isolation, OOM streaming iterator, and more

### Changed
- License changed from MIT to Apache 2.0
- Tests: 696 tests (→ 704 in v7.1.2)
- Vitest upgraded from 3.0.7 to 4.1.1
- `detectMode` now returns "file" mode for 50-200 file projects (correct performance scaling)
- `isTypeScriptFile` respects `allowJs` config (prevents false errors in strict projects)
- Circuit breaker tool detection updated for v3.0+ action names
- File lock timeout extended to 5 minutes for large batch edits

### Internal
- `SpectralResult` interface extended with optional `v2`, `lambda3`, `v3`, `nodeIndex` fields (backward compatible)
- Power iteration limit raised from 100 to 150 (convergence guard unchanged at 1e-7)
- Chronos Miner v2: Tree-sitter based temporal dataset extractor (zero node_modules, resumable, architectural dispersion ground truth)
- Worktree isolation: each miner uses `/tmp/nreki-wt-{repo}` for parallel mining

## v6.1.0 - Spectral Gate + Surgical Architecture (2026-03-22)

### Performance
- CSR sparse matrix with fused Rayleigh quotient in SpMV power iteration (L1 cache friendly)
- Pre-computed sourceFile/targetFile on TopologicalEdge eliminates millions of split("::") allocations
- fd-based incremental log reading in TokenMonitor (no more full-file readFileSync)
- In-place ring buffer (shift) and TTL eviction (splice) in CircuitBreaker — zero array allocations per tool call
- Radical AST pruning in findDependencies: 8 node types short-circuited, arrow/fn bodies skipped
- Eliminated redundant extractConstraintGraph calls in benchmark — O(E) RAM filtering

### Spectral Gate
- Density-weighted Phi = lambda2 * (2V / (N*(N-1))) for star topology detection
- Conditional formula: density when N unchanged (ghost/expansion), original lambda2/N when N decreases (decoupling)
- 11/11 real-world projects ALL PASS: 55/55 detection, 0/55 false positives, max 95.8ms

### Security
- NFC Unicode normalization in safePath prevents macOS NFD bypass of .env blocklist
- Removed settings.py and wp-config.php from sensitive file blocklist (false positives for Django/WordPress)
- healingStats encapsulated behind private field + readonly getter
- CircuitBreaker accepts projectRoot in constructor instead of dynamic process.cwd()
- Middleware singletons encapsulated in CircuitBreakerMiddleware class

### Bug Fixes
- Hologram Shield 2 now evaluates semantic diagnostics on dependents, not just edited files
- TTRD: removed truncated typeStr bypass — TypeFlags toxicity is sole authority
- applySemanticSplice: closest-match indexOf picks nearest occurrence to AST offset
- stripCallStatements: regex lastIndex advanced to prevent overlapping matches on nested calls
- Surgical JIT cache invalidation in rollbackAll — only edit targets cleared, not entire cache
- DocumentRegistry + LanguageService recreated on corruption to prevent OOM
- Safe slice in applySemanticSplice caps indent stripping at actual whitespace
- jitClassifyFile size guard (150KB) prevents event loop blocking on auto-generated files
- perFileFailures GC synced with history TTL eviction
- Centralized backup files in .nreki/transactions/ directory
- Windows fingerprint POSIX normalization in getFingerprint
- BOM-safe readSource in jitClassifyFile

### Code Quality
- PorterStemmer extracted to src/utils/porter-stemmer.ts
- Deduplicated escapeRegex in database.ts (uses escapeRegExp from utils/imports)
- detectMode filters .d.mts/.d.cts files
- detectLanguage supports .mts/.cts/.mjs/.cjs extensions
- Deprecation warnings on TokenGuardEngine and TokenGuardDB aliases
- CLAUDE.md externalized to templates/CLAUDE.md
- noUnusedLocals and noUnusedParameters enabled — 14 dead code items removed
- Test parallelism enabled (fileParallelism: true)
- CI: npm audit, npm run lint, continue-on-error for Node 24
- inferSimpleType returns "unknown" instead of "any" in shadow generation
- Cache format versioning (CACHE_FORMAT_VERSION) in repo-map
- mtimeMs included in computeFileDigest for stale cache detection
- isEnvironmentFile uses exact basename matching instead of substring

### Benchmarks (11 projects, 55 test cases)

| Project | Files | Nodes | Edges | Max Latency | FN | FP | Result |
|---------|-------|-------|-------|-------------|----|----|--------|
| NREKI | 38 | 195 | 373 | 44.0ms | 0/5 | 0/5 | ALL PASS |
| Zod | 195 | 2,251 | 6,242 | 32.2ms | 0/5 | 0/5 | ALL PASS |
| tRPC | 89 | 828 | 1,790 | 41.3ms | 0/5 | 0/5 | ALL PASS |
| Prisma | 1,970 | 3,546 | 5,319 | 7.7ms | 0/5 | 0/5 | ALL PASS |
| ts-pattern | 18 | 360 | 1,425 | 10.0ms | 0/5 | 0/5 | ALL PASS |
| Next.js | 1,445 | 5,024 | 7,589 | 27.0ms | 0/5 | 0/5 | ALL PASS |
| Hono | 186 | 1,414 | 10,188 | 35.7ms | 0/5 | 0/5 | ALL PASS |
| Drizzle ORM | 447 | 3,521 | 17,021 | 70.3ms | 0/5 | 0/5 | ALL PASS |
| date-fns | 1,238 | 1,905 | 3,129 | 15.2ms | 0/5 | 0/5 | ALL PASS |
| VS Code | 4,697 | 24,204 | 111,994 | 29.1ms | 0/5 | 0/5 | ALL PASS |
| Effect | 362 | 10,935 | 72,723 | 95.8ms | 0/5 | 0/5 | ALL PASS |

## [6.0.1] - 2026-03-21

### Fixed
- `NrekiDB.save()` and `NrekiDB.close()` guard against double-close during graceful shutdown
- `file-lock.test.ts` platform guard for case-insensitive path test (macOS/Linux CI)
- CI matrix expanded to Node 20, 22, 24

## [6.0.0] - 2026-03-19

### Added
- **Holographic Pruning**: New performance mode for large projects (>1000 files).
  Replaces full `.ts` source files with lightweight `.d.ts` shadow stubs in the
  TypeScript compiler's VFS, dramatically reducing boot time and memory usage.
  - Shadow Generator (`src/hologram/shadow-generator.ts`): Tree-sitter based file
    classifier and `.d.ts` generator. Classifies exports as prunable (explicit types)
    or unprunable (inferred types). Uses AST walking, not regex.
  - Shadow Cache (`src/hologram/shadow-cache.ts`): Disk persistence for shadows
    with mtime/hash staleness detection and version guard invalidation.
  - Symbiotic Harvester (`src/hologram/harvester.ts`): Extracts real `.d.ts` from
    the TypeScript compiler during idle time, replacing heuristic shadows with
    compiler-grade ones. Cooperative scheduler with epoch-aware abort.
  - Lazy Subgraph Loading: Kernel boots with only ambient files in rootNames.
    Target files are added dynamically during `interceptAtomicBatch()`.
  - Pre-warming: Background shadow scan starts after MCP handshake, before first edit.
  - Domain Separation: `predictBlastRadius` disabled in hologram mode (use Layer 1
    AST navigator for reference queries).
- **JIT Holography**: Eliminates upfront `scanProject()`. Shadows generated
  on-demand when TypeScript's module resolver requests files. Cold boot
  drops from 22.96s to 1.94s on VSCode (5,584 files). Only 642 of 5,584
  files are ever classified — the rest are never touched.
- `NrekiKernel.setShadows()` - receive shadow scan results before boot
- `NrekiKernel.hasShadows()` - check if shadows are loaded
- `NrekiKernel.setJitParser()` - inject Tree-sitter parser for on-demand use
- `NrekiKernel.setJitClassifier()` - inject classification function
- `NrekiKernel.hasJitHologram()` - check if JIT mode is available
- `NrekiKernel.getJitCacheSize()` - report on-demand classification count
- `NrekiKernel.getLogicalTime()` - monotonic clock for harvester epoch detection
- `NrekiKernel.getProgram()` - access TypeScript Program for harvester .d.ts emission
- `NrekiMode` type extended with `"hologram"`
- `detectMode()` returns `"hologram"` for projects with >1000 source files

### Changed
- VFS hooks in `NrekiKernel.boot()` now include hologram intercepts (BEFORE existing
  VFS checks) for `fileExists`, `readFile`, and `getScriptSnapshot`
- `getFatalErrors()` semantic cascade evaluation now runs for both `project` and
  `hologram` modes
- `RouterDependencies.nrekiMode` type includes `"hologram"`
- Deferred boot in router handles hologram mode (scan before boot if pre-warm incomplete)

### Tests
- 60 new tests across 7 test files:
  - `tests/hologram-shadow-generator.test.ts` (19 tests)
  - `tests/hologram-vfs.test.ts` (8 tests)
  - `tests/hologram-lazy-subgraph.test.ts` (5 tests)
  - `tests/hologram-domain-separation.test.ts` (3 tests)
  - `tests/hologram-harvester.test.ts` (6 tests)
  - `tests/hologram-integration.test.ts` (4 tests)
  - `tests/jit-holography.test.ts` (15 tests)

## [5.3.0] - 2026-03-18

### Added
- **Temporal Type Regression Detection (TTRD)**: Detects when an AI agent weakens
  type contracts to bypass the TypeScript compiler.
  - Uses TypeChecker API to read compiler-resolved types, not AST text. Catches
    inferred type escape (`as any` in expressions) and alias weakening
    (`type X = any` where function signatures stay identical).
  - Pre/Post comparison within the same ACID transaction. No global baseline needed.
  - Barrel file guard: skips re-exported symbols, processes local declarations only.
  - Type string safety: default truncation (no NoTruncation flag), 500-char hard limit.
  - Submodular penalty: log2 scaling prevents cascading errors from blocking files.
  - Debt ledger: stores original strict types for future restoration guidance.
  - Debt payment: restoring strict types clears debt records and reduces friction.
  - Ghost debt cleanup: deleted symbols cancel their debt automatically.
  - Per-file regression tracking in batch edits (no friendly fire).
- `NrekiKernel.extractCanonicalTypes()` - TypeChecker-based export type extraction
- `NrekiKernel.computeTypeRegressions()` - Pre/Post contract comparison
- `NrekiKernel.resolvePosixPath()` - public path normalization
- `ChronosMemory.recordRegressions()` - submodular penalty with debt ledger
- `ChronosMemory.assessDebtPayments()` - debt forgiveness on type restoration or deletion
- `NrekiInterceptResult.regressions` - regression evidence per intercept
- `NrekiInterceptResult.postContracts` - post-edit type contracts for debt assessment
- `TypeRegression.filePath` - per-file attribution for batch edit accuracy

### Tests
- 19 new tests in `tests/ttrd.test.ts`
- extractCanonicalTypes, regression detection, false positive guards, barrel file guard,
  type string limits, submodular penalty, debt ledger persistence, debt payment,
  ghost debt, JIT warnings, happy path detection, pre/post baseline, healed path,
  batch edit attribution, batch debt payment, no-success-on-regression
- **Performance Modes**: Auto-detection of validation depth based on project size.
  - `syntax` mode (< 50 files): Kernel disabled. Tree-sitter only.
  - `project` mode (50-1000 files): Full cross-file semantic validation with early exit.
  - `file` mode (> 1000 files): Semantic checks on edited files only. No cascade.
  - Mode auto-detected via bounded DFS file counter in ~85ms.
  - Deferred boot: kernel boots on first edit, not at startup. MCP server starts in 0ms.
  - Early exit in project mode: stops evaluating after threshold errors (50 + 20 per edited file).
  - Corrupted builder recovery via warm rebuild (~2-5s) after early exit.
  - Global noise filter: ignores diagnostic noise from missing @types when editing source files.
  - Toxicity scoring for TTRD: detects parameter-level regressions (RetryConfig to any).
  - Structural collapse detection: catches Promise<any> to any.
- **VSCode Benchmark (file mode)**: 5,584 files, 91.6s boot, 4.5GB RAM, 0 OOM crashes.
  - Test A (safe edit): PASS, 23s
  - Test B (local type break): CAUGHT, 25 errors in event.ts, 55s
  - Test C (TTRD): CAUGHT via compilation, 1 error, 41s
  - Test D (IDisposable): CAUGHT, 29 local errors in lifecycle.ts, 98s
  - Previous project mode: 644s latency, 35,704 errors, OOM crashes

### Tests
- 20 new tests in `tests/mode-modes.test.ts` (mode detection, syntax/file/project behavior, early exit, recovery, elastic threshold, global noise, TTRD toxicity)
- 1 new test in `tests/ttrd-silent-crime.test.ts` (silent type degradation)
- Total: 590 tests across 29 suites, 0 failures

---

## [5.2.0] - 2026-03-18

### Added
- **Chronos Memory**: Cross-session file error tracking with Cognitive Friction Index (CFI)
  - Exponential decay (λ=0.85) - file friction reduces 15% per clean session
  - Success discount - successful edits on high-friction files halve their CFI score
  - JIT warnings - error history appears only when reading/editing affected files
  - Edit gating - high-friction files require uncompressed read before editing
  - Blast radius tracking - error penalties go to files where errors occur, not the edited file
  - Dead file cleanup - deleted files are removed from tracking on session start
  - Baseline cache reuse - O(1) error counting without compiler invocation
  - Crash-safe persistence with debounced atomic writes
- `NrekiKernel.getInitialErrorCount()` - immutable boot-time error snapshot
- `NrekiKernel.getCurrentErrorCount()` - O(1) via baseline cache
- Global Health Delta tracking (ΔH = current errors - boot errors)
- **Chronos Health Score** in `nreki_guard action:"report"` output
- Circuit breaker trips now feed Chronos CFI automatically

### Tests

- 16 new tests in `tests/chronos-memory.test.ts`
- Constructor, recordTrip/Error/Heal/Success, isHighFriction, passive decay, GC, dead file cleanup, persistence, health report, blast radius tracking

---

## v5.1.0 - Zero-Token Error Correction (2026-03-17)

### New: NREKI L3.3 Auto-Healing Engine

When the LLM's edit introduces structural errors (missing imports, forgotten `async` keyword, incomplete interface implementations), NREKI now **auto-corrects them in RAM** using TypeScript's CodeFix API - the same engine that powers VS Code's "Quick Fix" lightbulb. The LLM never sees the error. Zero tokens wasted.

- **`attemptAutoHealing()`**: Iterative fix-recompile loop inside `interceptAtomicBatch()`. Applies one CodeFix at a time, recompiles the universe (~20ms), checks if errors decreased, and either accepts or micro-rollbacks.
- **Error reduction rule**: Every fix must reduce total error count. If a fix leaves the same errors or more, it is reverted and blacklisted.
- **SAFE_FIXES whitelist**: Only deterministic structural fixes are applied - never type mutations or business logic changes:
  - `import` / `fixMissingImport` - adds forgotten imports
  - `fixAwaitInSyncFunction` - adds `async` when LLM wrote `await` without it
  - `fixPromiseResolve` - wraps returns in `Promise.resolve()`
  - `fixMissingProperties` - auto-implements required interface properties
  - `fixClassDoesntImplementInheritedAbstractMember` - implements abstract methods
  - `fixAddMissingMember` - declares missing class properties
  - `fixAddOverrideModifier` - adds `override` keyword
- **Micro-rollback per fix**: Each fix has its own undo-log. Failed fixes revert without affecting successful ones.
- **Macro-rollback on partial failure**: If not ALL errors are resolved, the entire healing attempt is undone and the original errors are returned to the LLM intact.
- **Patch protection**: On successful healing, the response tells the agent not to overwrite the auto-applied fixes in the next edit.
- **`healedFiles` in response**: Router creates `nreki_undo` backups for collateral files the healer touched.
- **`healingStats`**: Public counter tracking `applied` and `failed` healing attempts.

### New: `getFatalErrors()` - Centralized Triple Shield

Extracted the 3-shield evaluation logic (Global → Syntactic → Semantic) into a reusable private method. Both `interceptAtomicBatch()` and `attemptAutoHealing()` use it, eliminating code duplication.

### Bug Fixes

- **`ts.emptyOptions` doesn't exist in TS 5.9**: Replaced with `{} as ts.UserPreferences`.

### Tests

- **526 tests**, 25 suites, zero failures, zero regressions
- New: `tests/auto-healing.test.ts` -6 tests covering:
  - Missing import → auto-healed → `safe: true` → disk has import
  - `await` without `async`, callers healthy → auto-healed → `safe: true`
  - `await` without `async`, callers break → cascade detected → micro-rollback → `safe: false`
  - Business logic error (no CodeFix) → healing skipped → `safe: false`
  - `healingStats` counter verification
  - Clean code → healing not triggered → `safe: true` without heal text

---

## v5.0.0 - The NREKI Kernel (2026-03-16)

### New: NREKI Kernel (Layer 2 - Cross-File Semantic Verification)

- **VFS-LSP Kernel**: Hijacks TypeScript Compiler API with a Virtual File System in RAM. Edits are validated against the entire project's type system before reaching disk.
- **True ACID Transactions**: `interceptAtomicBatch()` validates in RAM; `commitToDisk()` writes via two-phase atomic commit (backup → temp+rename → cleanup) with physical rollback on OS failure.
- **Zero Disk Touch**: When the kernel is active, `semanticEdit()` operates in `dryRun` mode. The disk is immutable until semantic validation passes.
- **Triple Shield**: Global diagnostics → Syntactic diagnostics → Semantic diagnostics. Catches broken syntax AND cross-file type errors.
- **Predictive Blast Radius**: `predictBlastRadius()` uses `ts.LanguageService.findReferences()` to show what will break and WHY before the agent edits. ~20ms per query.
- **PageRank Architecture Scoring**: Files classified by recursive importance via Markov Chain Power Iteration (damping factor 0.85, 20 iterations, <8ms convergence for 1,000 files). Replaces naive inDegree classification.
- **Warm-Path Optimization**: Failed intercepts advance the monotonic clock instead of destroying the builder program. Rollback drops from ~10s to ~50ms.
- **Path Jail at Kernel Level**: `interceptAtomicBatch()` rejects paths that resolve outside the project root.
- **O(1) Virtual Directory Resolution**: `vfsDirectories` Set replaces O(n) VFS scan in `directoryExists`.
- **LanguageService Integration**: VS Code's reference engine connected to the VFS for JIT lazy evaluation.

### Renamed: TokenGuard → NREKI

- npm package: `@ruso-0/tokenguard` → `@ruso-0/nreki`
- Tool names: `tg_navigate` → `nreki_navigate`, `tg_code` → `nreki_code`, `tg_guard` → `nreki_guard`
- Database: `.tokenguard.db` → `.nreki.db`
- Pins: `.tokenguard-pins.json` → `.nreki-pins.json`
- Backups: `.tokenguard-backup/` → `.nreki-backup/`
- Server name: `TokenGuard` → `NREKI`

### Security Hardening (30/30 Audit Findings Resolved)

- **A1**: Kernel path jail blocks traversal attempts (`../../etc/passwd`)
- **A2**: Write-Then-Validate eliminated - now Validate-Then-Write via dryRun
- **A3**: Zombie mutex (`withTimeout`/`Promise.race`) deleted entirely
- **A4**: Sensitive file blocklist expanded (+8 patterns: docker, kube, netrc, htpasswd, etc.)
- **A5**: `node_modules` filter uses path segment regex, not substring match
- **A6**: Kernel returns relative paths in error messages, not absolute
- **A8**: Pin sanitization adds Unicode normalization (NFKC) + null byte rejection
- **A9**: Prototype pollution guard on pin JSON.parse
- **A10**: Kernel readFile blocks sensitive files (.env, .pem, .key) in disk fallback
- **B1**: `commitToDisk()` resurrected as the only write path when kernel is active
- **B2**: `isTypeScriptFile` regex expanded to `.mts`, `.cts`, `.mjs`, `.cjs`, `.d.mts`, `.d.cts`
- **B4**: Double-boot guard added to `boot()`
- **B5**: Pre-boot guard added to `interceptAtomicBatch()`
- **B6**: `logicalTime` saved and restored on rollback
- **B7**: Fingerprint hash upgraded from MD5 to SHA-256
- **B8**: GC threshold made configurable (`gcThreshold` property)
- **C4**: Heartbeat skipped during circuit breaker escalation ≥ 2
- **C5**: Version read from `package.json` at runtime (no hardcoded string)
- **D1**: Pin file writes use atomic temp+rename pattern
- **D2**: Orphaned `.nreki-bak-*` files cleaned on kernel boot
- **D4**: Token estimation margin documented (20-40% variance)
- **E1**: `directoryExists` uses O(1) Set lookup instead of O(n) VFS scan

### Tests

- **520 tests**, 24 suites, zero failures
- New: `tests/nreki-kernel.test.ts` -22 kernel unit tests (boot, semantic validation, syntactic shield, baseline tolerance, file operations, ACID, concurrency, edge cases)
- New: `tests/nreki-integration.test.ts` -8 integration tests (dryRun, full commit path, type-break blocked, batch VFS, path traversal rejection)
- New: PageRank tests (recursive importance, convergence <50ms for 1,000 files)
- New: Precision tests (VFS staging leak, node_modules filtering, restore failure handling)

### Benchmark: OpenDota (148 files, 1,600+ stars)

- 6/6 correct verdicts (valid edit, type break, syntax break, file delete, non-TS file)
- Zero false positives, zero false negatives
- Boot: 10.68s | Type break detection: 12.6s | Syntax detection: 11.4s

### 32 Sealed Failure Modes (P1-P32)

P2 (atomic commit), P4 (dynamic rootNames), P5 (tombstone), P8 (monotonic clock), P9 (topological cardinality), P10 (FIFO mutex), P11 (periodic GC), P15 (path sanitization), P17 (zombie AST), P18 (destruction & resurrection), P19 (counter reset), P21 (multi-file deadlock), P25 (idempotent undo-log), P26 (POSIX normalization), P27 (recursive mkdir), P28 (syntactic blindness), P29 (TS6053 ghost), P30 (non-TS filter), P31 (virtual directories), P32 (physical rollback).

## [4.0.2] - 2026-03-13

### Fixed (Logic)
- **Blind Sniper**: `prepare_refactor` only searched function signatures (BM25 shorthand index), missing symbols used inside function bodies. Now uses exhaustive `raw_code` SQL scan for 100% coverage. Also added `property_identifier` and `shorthand_property_identifier` to the AST node type filter.
- **Batch Edit Race Condition**: `batch_edit` had no file locks. Concurrent `edit` + `batch_edit` on the same file could corrupt it. Added two-phase locking (acquire all or rollback all, release in finally).
- **indexOf Wrong Function**: `applySemanticSplice` fallback searched from byte 0, could edit the wrong function when duplicates exist. Now searches in a ±500 byte local window around the AST-reported position first.
- **extractSignature String Confusion**: `{` inside string literals (e.g., `msg = "{"`) was mistaken for function body start, truncating signatures. Added string-state tracking to skip characters inside quotes.
- **Silent Plan Amnesia**: Plans exceeding 15,000 characters were silently dropped. Now injects a visible WARNING telling Claude to summarize the plan.

### Fixed (Documentation)
- Updated `index.ts` docstring from v3.3.0 to v4.0.2.
- Rewrote `skills/SKILL.md` with v4 tool names and features (batch_edit, prepare_refactor, blast radius, architecture tiers).
- Updated `getClaudeMdContent()` (CLAUDE.md init) with v4 features.
- Changed "vs full file rewrite" to "vs native read+edit" in response messages.
- Changed "Saves 98%" claim to "60-80%" in semantic-edit docstring.
- Eliminated double file read in handleEdit by returning oldRawCode from semanticEdit.
- Updated preToolUse.ts docstring to use v4 tool names.

## [4.0.1] - 2026-03-13

### Fixed
- **Inflated `tokensAvoided` metric**: `semanticEdit()` was computing savings as `fullFile × 2 - newCode`, which double-counted the file read. Corrected to `fullFile + oldSymbol - newCode` (read file + old symbol code that Claude would have sent).
- **Router docstring version**: Updated from v3.3.0 to v4.0.0 and added `batch_edit` and `prepare_refactor` to the tool action listings.
- **Batch edit blast radius missing dependents**: `handleBatchEdit()` now queries the dependency graph to list files that import edited modules, matching the behavior of single-file `handleEdit()`.

## [4.0.0] - 2026-03-12

### BREAKING CHANGES
- **`symbolName` extracted from AST**: Parser now uses tree-sitter `@_name` captures instead of ~10 fragile regexes. `ParsedChunk` interface adds `symbolName: string`. Database schema adds `symbol_name`, `start_index`, `end_index` columns (auto-migrated for existing DBs).

### Added
- **`nreki_code action:"batch_edit"`**: Atomically edit multiple symbols across multiple files. Uses Virtual File System in RAM with reverse splice ordering (descending startIndex) to avoid byte offset corruption. All-or-nothing: if ANY file fails AST validation, NOTHING is written to disk.
- **Architecture Map**: `nreki_navigate action:"map"` now includes dependency graph with import centrality classification. Files are tiered by in-degree percentile: P75+ = "core", P50-P75 = "logic", <P50 = "leaf". Uses O(1) FastLookup index for import resolution (relative paths, `@/` aliases, extensionless, index.ts implicit).
- **Blast Radius Detection**: When `nreki_code action:"edit"` changes a function's signature (parameters, return type), NREKI warns which files import that symbol. Suggests `batch_edit` to update dependents. Also applies to `batch_edit`.
- **`nreki_navigate action:"prepare_refactor"`**: AST-based confidence classification for safe renaming. Walks tree-sitter syntax nodes and classifies each occurrence as "high" confidence (safe to rename) or "review" (inside strings, comments, object keys, JSX text). Returns a formatted report with two sections.
- **`parseRaw<T>()`**: Public method on `ASTParser` for raw tree-sitter tree access via callback pattern with guaranteed WASM memory cleanup.
- **`DependencyGraph` interface**: `importedBy`, `inDegree`, and `tiers` maps exported from `repo-map.ts`.
- **`buildFastLookup()`**: O(1) import resolution mapping extensionless, src/-stripped, and index-collapsed variants to actual file paths.
- **`detectSignatureChange()`**: Pure function comparing old/new signatures to detect parameter and return type changes.
- **`findChunkBySymbol()`**: Extracted pure function preferring `chunk.symbolName` (AST) with `extractName()` regex fallback.
- **`applySemanticSplice()`**: Extracted pure splice function for reuse in both single and batch edits.

### Fixed
- **Bug A - Stale docstring**: `engine.ts` header incorrectly referenced "sqlite-vec + FTS5". Updated to reflect actual implementation (pure-JS VectorIndex + BM25 KeywordIndex).
- **Bug B - Multi-line console.log stripping**: Regex-based `console.log()` removal failed on multi-line calls. Replaced with `stripCallStatements()` using balanced parenthesis tracking. Same fix applied to Python `print()`.
- **Bug C - Python `#` in strings**: Comment stripping destroyed `#` inside string literals (e.g., `color = "#FF0000"`). Fixed by reordering (triple-quotes first) and protecting single/double-quoted strings with placeholders before stripping comments.
- **Bug D - Simplistic glob matching**: `walkDirectory` converted `**/node_modules/**` to `node_modules` via string replace, failing for patterns like `**/*.min.js`. Replaced with `picomatch` for proper glob matching.

### Changed
- `semantic-edit.ts` refactored: extracted `applySemanticSplice()`, `findChunkBySymbol()`, `detectSignatureChange()` as pure functions.
- `repo-map.ts` extended: `generateRepoMap()` now builds and caches dependency graph alongside repo map. `repoMapToText()` appends architecture tier summary.
- Database schema: `chunks` table now stores `start_index`, `end_index`, `symbol_name` with migration for existing DBs.
- Test count: 464 → 473 tests across 21 test suites.

### Dependencies
- Added `picomatch` (runtime) and `@types/picomatch` (dev) for proper glob matching.

## [3.3.0] - 2026-03-13

### Added
- **Context Heartbeat**: Silently re-injects critical session state
  every ~15 tool calls to survive Claude Code's context compaction. Uses 4-layer
  state re-injection:
  - Layer 1 (Plan File): Anchored plan document via `set_plan`
  - Layer 2 (Scratchpad): Claude's progress notes via `memorize` + pinned rules
  - Layer 3 (Recent Edits): Files modified in this session
  - Layer 4 (Circuit Breaker): Active escalation alerts if in Break & Build
- **`nreki_guard action:"set_plan"`**: Anchor a master plan file (PLAN.md, schemas).
  Includes Bankruptcy Shield rejecting plans >4000 tokens to prevent context bloat.
- **`nreki_guard action:"memorize"`**: Claude writes progress notes to persistent scratchpad.
  Notes survive context compaction and are re-injected during heartbeat.
- **Top-injection pattern**: Heartbeat injects state ABOVE the tool response, keeping the
  immediate result at the bottom to respect the LLM's U-shaped attention curve.
- **Read-only filter**: Heartbeat only fires during context-gathering actions
  (read, search, map, status, definition, references, outline). Never during
  edit, undo, or filter_output to avoid distracting Claude during critical operations.
- **Restart Detection**: Heartbeat detects MCP server restarts (currentCalls < lastInjectCalls)
  and resets the injection counter to prevent permanent heartbeat death.

## [3.2.0] - 2026-03-13

### Added
- **Auto-Context Inlining**: When Claude requests a definition or reads a file, NREKI
  automatically resolves signatures of imported dependencies and injects them in the response.
  Reduces follow-up tool calls by providing "X-ray vision" in a single turn.
  - Import extraction supports ESM (named + default), CommonJS require, Python from-import,
    and Go namespace inference.
  - "Gold Filter": only injects dependencies actually used in the function body, using the
    local alias name (not the original export name) for accurate matching.
  - Security filter: signatures containing passwords, API keys, auth tokens, or encryption
    keys are automatically excluded from injection.
  - Anti-prompt-injection: JSDoc comments and NREKI stubs are stripped from signatures
    before injection, preventing malicious content from entering Claude's context.
  - Homonym disambiguation: BM25 searches combine symbol name + import path hint to find
    the correct signature even when multiple files export the same name.
  - 150ms hard timeout prevents event loop blocking on large codebases.
  - `auto_context: false` parameter available on both `nreki_navigate` and `nreki_code` to disable.
  - Session report tracks `autoContextInjections` count.
- **Go import support**: Auto-Context infers exported symbols from Go namespace usage patterns
  (e.g., `utils.HashPassword()` resolves to `HashPassword` in the `utils` package).
- **Preloaded content in compressFileAdvanced**: Eliminates double file I/O when both
  auto-context and compression are active on the same read.

### Changed
- `CompressionLevel` type is now used explicitly instead of `as any` for level casting.
- `handleRead` reads the file exactly once and reuses the content for both auto-context
  extraction and compression.

## [3.1.3] - 2026-03-12

### Fixed
- **Path normalization in Circuit Breaker**: All file paths are now resolved to absolute + forward slashes before recording. Prevents split counters where `"src/app.ts"` and `"/abs/path/src/app.ts"` were tracked as different files, causing Pattern 4 to never trigger.
- **Ghost data after file deletion**: `db.save()` is now called after the watcher's `unlink` event, ensuring deleted files don't reappear from disk on next session.
- **Plaintext fallback for unsupported languages**: Files with unsupported extensions (.rs, .java, .cpp, etc.) are now indexed as single plaintext chunks. BM25 keyword search works on all file types as documented in the README. AST features (validation, structural compression, semantic edit) still require TS/JS/Python/Go.

## [3.1.2] - 2026-03-12

### Fixed
- **Duplicate JSDoc on softReset**: Removed stale v3.0 comment that contradicted actual behavior.
- **Inflated grepEstimate**: Replaced arbitrary `× 3` multiplier with per-unique-file estimation. Added "(estimated)" to savings output.
- **@xenova/transformers moved to optionalDependencies**: `npm install` no longer downloads ~200MB of ONNX runtime for Lite mode users. Pro mode users can install it separately with `npm install @xenova/transformers`.

## [3.1.1] - 2026-03-12

### Fixed
- **Circuit breaker `redirectsIssued`**: No longer counts Level 3 hard stops as redirects.
- **Circuit breaker `softReset` amnesia total**: Purges all history entries for the tripped file, giving Claude 3 clean attempts with the new strategy instead of 1.
- **Breaker payloads instruct `compress:false`**: Level 1 and Level 2 redirects now tell Claude to read uncompressed code so it can understand the logic before rewriting.
- **Smart rebase for Python/Go**: Auto-indentation now strips Claude's indent and rebases to the target context, fixing IndentationError in Python and tab corruption in Go.
- **CRLF support**: Line start detection skips `\r` on Windows files.
- **Cross-platform byte indices**: Verifies tree-sitter byte offsets against actual content, falls back to indexOf if they differ across platforms.

### Added
- **Behavioral Advisor (PreToolUseHook)**: Connected to `handleRead` - when Claude reads a file raw (compress:false), it gets a suggestion showing how many tokens it wasted and the exact command to compress next time.
- **Danger Zones in status**: `nreki_guard action:"status"` now shows the 5 heaviest unread files with estimated token counts. Files already read (raw or compressed) are filtered out dynamically.
- **CLI `--help` and `--version`**: Standard CLI hygiene. Version sourced from single `VERSION` constant.
- **Telemetry via social sharing**: Session report footer invites users to share their receipt on GitHub Discussions.
- **E2E breaker test**: Full integration test simulating 3 failures → Level 1 redirect → grace period → recovery with insert_after.
- **5 topological edit tests**: insert_after, insert_before, auto-indent nested, syntax rejection, last-symbol edge case.

### Removed
- `evaluateGrepOperation` and `countFiles` from PreToolUseHook (unreachable via MCP).
- `src/schemas.ts` (dead v2 code, zero imports).
- All "BOMBA" comments replaced with professional descriptions.

### Changed
- CLAUDE.md point 3 now includes quantitative advice (5,000 tokens vs 1,200 tokens).
- `RouterDependencies.hook` is optional for backward compatibility.
- `engine.markFileRead()` called in both compress and raw read branches.

## [3.1.0] - 2026-03-11

### Added
- **Creative Circuit Breaker ("Break & Build")**: 3-level escalation system that redirects Claude with increasingly specific strategies instead of just blocking. Level 1: rewrite from scratch. Level 2: decompose into helpers. Level 3: hard stop, ask the human.
- **`nreki_guard action:"reset"`**: Escape hatch for humans to clear the circuit breaker and let Claude retry with a new approach.
- **`npx nreki init`**: CLI subcommand that generates a `CLAUDE.md` file with collaborative-tone instructions for Claude Code to prefer NREKI tools.
- **Redirect statistics**: Session report now tracks `redirectsIssued` and `redirectsSuccessful` to measure creative breaker effectiveness.

### Performance
- **Batch SQL queries**: `searchHybrid`, `searchKeywordOnly`, and `searchVector` now use `WHERE id IN (...)` batch queries instead of N+1 individual queries per chunk ID.
- **BM25 TF precompute**: Term frequencies are precomputed at index time for O(1) lookup during search, replacing O(n) `filter()` scans.

### Changed
- Circuit breaker `ToolCallRecord` now includes `symbolName` for contextual redirect payloads.
- Circuit breaker `trip()` now escalates `escalationLevel` (0→3) instead of just setting a boolean.
- `softReset()` preserves escalation level across retries, enabling progressive escalation.
- All version strings aligned to 3.1.0.

### Tests
- 438 tests (was 423). Added 15 new tests for escalation levels, redirect payloads, symbolName tracking, and soft/hard reset behavior.

---

## [3.0.3] - 2026-03-11

### Fixed
- **CI macOS/Windows**: `safePath` now calls `realpathSync` on the workspace root as well as the resolved path, fixing false-positive "Symlink escape blocked" errors on macOS where `/tmp` is a symlink to `/private/tmp`. All 423 tests pass on all platforms.

---

## [3.0.2] - 2026-03-10

### Headline
docs: fix README Quick Start syntax, update test count to 423, update keywords, add security documentation.

### Fixed
- **README Quick Start**: Replaced v2 `options:{}` syntax with v3 flat params (`text:`, `symbol:`, `new_code:`, `output:`).
- **README Quick Start**: Replaced `target:` with correct param names (`query:`, `symbol:`).
- **README**: Renamed `terminal` → `filter_output` in nreki_code actions table, comparison table, architecture diagram, and Quick Start.
- **README**: Updated test count from 361 → 423 in title, badges, stress test section, and real-world validation.
- **README**: Updated test suites from 14 → 16.

### Added
- **README Security section**: Documented symlink resolution, sensitive file blocklist, pin sanitization, and file-level mutex.

### Changed
- **package.json**: Updated keywords to reflect v3 security focus (`code-safety`, `ast-validation`, `circuit-breaker`, `defensive-coding`, `ai-safety`, `surgical-edit`).
- **package.json**: Set author to `Ruso-0 (https://github.com/Ruso-0)`.
- **package.json**: Version bumped to 3.0.2.

---

## [3.0.0] - 2026-03-10

### Headline
NREKI v3.0 - Architecture overhaul. 16 tools collapsed to 3 routers. Invisible middleware. Lite/Pro mode. 81% reduction in tool definition overhead.

### BREAKING CHANGES
- **16 tools → 3 router tools**: All MCP tool names have changed. LLMs must use the new `nreki_navigate`, `nreki_code`, `nreki_guard` tool names with `action` parameters.
- **`nreki_validate` removed from MCP**: Now runs automatically as invisible middleware inside `nreki_code action:"edit"`. No manual calls needed.
- **`nreki_circuit_breaker` removed from MCP**: Now runs as passive middleware monitoring all tool calls. Auto-resets after 60s inactivity or when a different action is called.
- **`nreki_audit` removed from MCP**: Moved to CLI only. Use `npx @ruso-0/nreki --audit`.

### Added - Router Pattern
- **`nreki_navigate`** - Unified navigation tool replacing `nreki_search`, `nreki_def`, `nreki_refs`, `nreki_outline`, `nreki_map`. Actions: `search`, `definition`, `references`, `outline`, `map`.
- **`nreki_code`** - Unified code tool replacing `nreki_read`, `nreki_compress`, `nreki_semantic_edit`, `nreki_undo`, `nreki_terminal`. Actions: `read`, `compress`, `edit`, `undo`, `terminal` (renamed to `filter_output` in v3.0.2).
- **`nreki_guard`** - Unified safety tool replacing `nreki_pin`, `nreki_status`, `nreki_session_report`. Actions: `pin`, `unpin`, `status`, `report`.
- `src/router.ts` - Central dispatcher mapping `{tool, action}` to handler functions (~700 lines).

### Added - Invisible Middleware
- `src/middleware/validator.ts` - AST validation wrapper. Validates code via tree-sitter before disk writes inside `nreki_code action:"edit"`.
- `src/middleware/circuit-breaker.ts` - Passive circuit breaker. Wraps all handlers, records tool call results, trips on destructive patterns, auto-resets on action diversity or 60s inactivity.

### Added - Lite / Pro Mode
- **Lite mode (default)**: Instant startup (~100ms). BM25 keyword-only search. No ONNX model dependency.
- **Pro mode (`--enable-embeddings`)**: Hybrid semantic + BM25 search with RRF fusion. Requires ONNX Runtime for jina-v2-small embeddings.
- `searchKeywordOnly()` method added to `NREKIDB` for Lite mode BM25 search.
- Engine methods (`indexFile`, `indexDirectory`, `search`, `getRepoMap`) now branch based on `enableEmbeddings` config.

### Changed
- **`src/index.ts`**: Rewritten from ~1,479 lines (16 tool registrations) to ~180 lines (3 router registrations).
- **Tool definition overhead**: ~3,520 tokens → ~660 tokens (81% reduction).
- **Test count**: 305 → 361 tests across 14 test suites.
- **`package.json`**: Version bumped to 3.0.0. Description updated.
- **`README.md`**: Complete rewrite for v3.0 architecture.

### Added - Tests
- `tests/router.test.ts` - 30 tests for router dispatch correctness across all 14 `{tool, action}` pairs.
- `tests/middleware.test.ts` - 13 tests for validator and circuit breaker middleware behavior.
- `tests/backward-compat.test.ts` - 13 tests verifying all 16 original tool behaviors work through the new 3-tool API.

---

## [2.1.2] - 2026-03-10

### Headline
NREKI v2.1.2 - Lazy ONNX loading fixes MCP handshake timeout for real-world users.

### Fixed
- **CRITICAL - MCP handshake timeout**: `engine.initialize()` was eagerly loading the ONNX embedding model (~5-10s) during startup, blocking ALL tool calls until the model was ready. Real users connecting via Claude Code would experience timeouts or slow first responses. Split initialization into two phases:
  - **Fast path** (`initialize()`): SQLite + Tree-sitter only (~100ms). Used by 12/16 tools.
  - **Embedder path** (`initializeEmbedder()`): Adds ONNX model load. Used only by `nreki_search`, `nreki_map`, and indexing operations.
- **`nreki_def` first-call latency**: Was 465ms because it waited for the embedder to load (which it doesn't use). Now completes in ~50ms on first call.
- Removed background `engine.initialize()` from `main()` - tools now self-initialize at the correct level when first called.

### Changed
- **package.json**: Version bumped to 2.1.2.

---

## [2.1.1] - 2026-03-10

### Headline
NREKI v2.1.1 - Final audit fixes, nreki_undo, 16 tools, 305 tests.

### Added - New Tool
- **`nreki_undo`** - Undo the last `nreki_semantic_edit` on a file. Auto-restores from backup with one-shot semantics (backup is consumed after restore).

### Added - New Module
- `src/undo.ts` - Backup/restore engine using base64url-encoded file paths. Stores pre-edit snapshots in `.nreki/backups/`.
- `src/utils/read-source.ts` - Shared BOM-safe file reader. Strips U+FEFF byte order marks from Windows-created source files.

### Security
- **FIX 2 - XML injection prevention**: Pin content is now escaped (`&`, `<`, `>`, `"`, `'`) before storage to prevent prompt injection via pinned rules.

### Fixed
- **FIX 1 - BOM stripping**: All source file readers now use `readSource()` to strip U+FEFF BOM, fixing parse failures on Windows-created files.
- **FIX 3 - Code tokenizer**: Rewritten to correctly handle `$scope`, `__proto__`, `_privateVar`, and other edge-case identifiers with `$`/`_` prefixes.
- **FIX 4 - Fast dot product**: Replaced cosine similarity with direct dot product for L2-normalized vectors. Removes sqrt/division overhead; mathematically equivalent for unit vectors.
- **FIX 6 - Pin order**: Pinned rules now appear AFTER repo map text (was before). Preserves Anthropic prompt cache hits since the static map stays at the start of context.
- **FIX 7 - Circuit breaker normalization**: `hashError()` now normalizes ISO timestamps and improved memory address normalization. Added 5-minute TTL eviction to prevent stale errors from tripping the breaker.
- **FIX 8 - ASCII receipt**: Replaced all Unicode box-drawing characters and emojis in session receipt and reports with ASCII equivalents for terminal compatibility.

### Changed
- **Tool count**: 15 -> 16 MCP tools.
- **Test count**: 282 -> 305 tests across 11 test suites.
- **nreki_map**: Pinned rules now appended after repo map (was prepended before).
- **package.json**: Version bumped to 2.1.1.

---

## [2.1.0] - 2026-03-10

### Headline
NREKI v2.1 - 15 MCP tools, 282 tests, circuit breaker, surgical edit, pin memory, session receipt.

### Added - New Tools
- **`nreki_semantic_edit`** - Surgically edit a function/class/interface by name without reading or rewriting the entire file. Finds the exact AST node, replaces only those bytes, validates syntax before saving. Saves 98% of output tokens vs full file rewrites.
- **`nreki_circuit_breaker`** - Detects infinite failure loops (same error 3+ times, same file 5+ times, write-test-fail cycles). When tripped, forces Claude to stop and ask the human for guidance. Prevents doom loops that burn through remaining context.
- **`nreki_pin`** - Pin important rules Claude should never forget. Pinned items are injected into every `nreki_map` response, keeping project conventions permanently in Claude's attention window. Max 10 pins, 200 chars each, persisted to disk.

### Added - New Modules
- `src/semantic-edit.ts` - Zero-read surgical AST patching. Symbol name lookup, byte-level splice, syntax validation before write.
- `src/circuit-breaker.ts` - Loop detection engine with sliding window analysis, consecutive failure tracking, and automatic trip/reset.
- `src/pin-memory.ts` - Persistent pinned rules with deterministic output (sorted by id) for prompt cache compatibility.

### Added - Session Receipt
- `nreki_session_report` now generates an ASCII receipt showing input tokens saved, output tokens avoided, search queries, surgical edits, syntax errors blocked, doom loops prevented, pinned rules active, estimated USD savings, and model info.

### Changed
- **Tool count**: 12 -> 15 MCP tools.
- **Test count**: 194 -> 282 tests across 11 test suites.
- **nreki_map**: Now prepends pinned rules at the top of the repo map output.
- **README**: Complete rewrite for v2.1 with comparison table, 3 unique features highlight, receipt preview, and updated architecture diagram.
- **package.json**: Version bumped to 2.1.0.

### Architecture
- **Pin memory layer**: Pinned rules are stored in `.nreki/pins.json` and prepended to every `nreki_map` response. Deterministic output (sorted by id) preserves prompt cache compatibility.
- **Circuit breaker integration**: `nreki_terminal` automatically feeds errors to the circuit breaker for proactive loop detection.

## [2.0.0] - 2026-03-10

### Headline
NREKI v2.0 - 12 MCP tools, 194 tests, cache-aware two-layer architecture.

### Added - New Tools
- **`nreki_def`** - Go-to-definition by symbol name. AST-based, 100% precise, returns full source body with signature.
- **`nreki_refs`** - Find all references to a symbol across the project. Cross-file word-boundary matching with context.
- **`nreki_outline`** - List all symbols in a file with kind, signature, export status, and line ranges. Like VS Code Outline.
- **`nreki_validate`** - AST sandbox validator. Parses code with tree-sitter before disk write. Catches missing commas, unclosed braces, invalid syntax with exact line/column and fix suggestions. Prevents the "write broken code → see error → retry" token burn loop.

### Added - New Modules
- `src/ast-navigator.ts` - AST navigation engine for nreki_def, nreki_refs, nreki_outline. Walks project files, extracts symbols, signatures, export status.
- `src/ast-sandbox.ts` - AST sandbox validator with `validateCode()` and `validateDiff()`. Recursive tree walk with `hasError` subtree pruning for large-file performance.
- `src/terminal-filter.ts` - Terminal entropy filter. Strips ANSI codes, deduplicates stack traces, extracts unique errors and affected files. 89% token reduction on error output.
- `src/repo-map.ts` - Static deterministic repo map for Anthropic prompt cache optimization. Identical output for same repo state enables $0.30/M caching vs $3.00/M input.

### Changed
- **Embeddings**: Migrated from all-MiniLM-L6-v2 (384-dim) to jina-embeddings-v2-small-en (512-dim) for 3x better code search precision.
- **BM25 tuning**: Optimized k1=1.8, b=0.35 for code (vs default k1=1.2, b=0.75 for prose).
- **RRF tuning**: k=10 for sharper rank fusion (vs k=60 default).
- **Code tokenizer**: camelCase, snake_case, PascalCase identifiers split into sub-tokens for better BM25 matching.
- **Tool count**: 6 → 12 MCP tools.
- **Test count**: 90 → 194 tests across 8 test suites.
- **README**: Complete rewrite with self-benchmark results, two-layer architecture docs, and updated comparison table.

### Architecture
- **Two-layer design**: Layer 1 (static repo map, prompt-cacheable) + Layer 2 (dynamic context, per-query).
- **Cache-friendly**: nreki_map output is deterministic - same repo state produces identical text, enabling Anthropic prompt caching.

### Performance (Self-Benchmark)
- nreki_search: 10 results in 16ms (hybrid RRF fusion)
- nreki_def: Definition lookup in 128ms across 22 files
- nreki_refs: 20 references found in 11ms
- nreki_outline: 25 symbols extracted in 7ms
- nreki_compress: 5,502 → 1,753 tokens (68% reduction, medium level)
- nreki_terminal: 11,967 → 1,276 tokens (89% reduction)
- nreki_validate: Syntax error detection with line/column in <1ms
- nreki_map: 22 files mapped, 4,677 tokens, 169ms

## [1.2.0] - 2026-03-10

### Security
- **Path traversal protection**: All file operations now validate paths stay within workspace root (`safePath`)
- **Input validation**: All tool inputs validated with Zod schemas before processing
- **File size limits**: Files > 500KB and binary/minified files are automatically skipped

### Fixed
- **WASM memory leaks**: Tree-sitter parse trees now guaranteed cleanup via `safeParse` try/finally wrapper
- **Event loop blocking**: Large indexing operations now yield every 100 files via `setImmediate`
- **Aggressive compression stubs**: Functions now show line count, key references, and expand commands instead of empty bodies
- **Search tokenization**: Code identifiers (camelCase, snake_case, PascalCase) are now split into sub-tokens for better matching
- **Vector search accuracy**: Cosine similarity now uses proper norm computation instead of raw dot product
- **RRF scoring**: Verified correct rank-based fusion (was already using positions, not scores)

### Added
- `src/utils/path-jail.ts` - Path traversal protection
- `src/utils/safe-parse.ts` - WASM memory-safe parsing
- `src/utils/file-filter.ts` - File size and extension filtering
- `src/utils/code-tokenizer.ts` - Code-aware identifier tokenization
- `src/schemas.ts` - Zod validation schemas for all tools
- `.github/workflows/ci.yml` - CI/CD with matrix testing (3 OSes × 3 Node versions)
- `CONTRIBUTING.md` - Contributor guide
- `CHANGELOG.md` - This file
- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- Comprehensive test suite for all new utilities

### Performance
- Pre-computed vector norms at index time (avoids recalculation during search)
- Proper cosine similarity with normalized vectors

## [1.1.1] - 2026-03-09

### Initial Release
- MCP server with 6 tools: nreki_search, nreki_audit, nreki_compress, nreki_status, nreki_session_report, nreki_read
- Hybrid RRF search (BM25 + vector similarity)
- Three-tier classic compression + LLMLingua-2-inspired advanced compression
- Real-time file watching with chokidar
- Token consumption monitoring and burn rate prediction
- Pre-tool-use interception hook
