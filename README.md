# NREKI — Bulletproof Shield for AI Coding Agents

<p align="center">
  <img src="https://img.shields.io/npm/v/@ruso-0/nreki?style=for-the-badge&color=blue" alt="npm version">
  <img src="https://img.shields.io/badge/Tests-729-brightgreen?style=for-the-badge" alt="729 Tests">
  <img src="https://img.shields.io/badge/AHI-9.7%2F10-brightgreen?style=for-the-badge" alt="AHI 9.7/10">
  <img src="https://img.shields.io/badge/Languages-TS%20%7C%20JS%20%7C%20Go%20%7C%20Python-blue?style=for-the-badge" alt="Multi-language">
  <img src="https://img.shields.io/badge/Cloud-Zero-orange?style=for-the-badge" alt="Zero Cloud">
  <img src="https://img.shields.io/badge/License-Apache_2.0-yellow?style=for-the-badge" alt="Apache 2.0">
</p>

**MCP plugin that validates AI agent edits in RAM before they touch disk.** When Claude Code, Cursor, or Copilot changes a function signature in one file and breaks 30 others, NREKI catches it in milliseconds — the file is never written. If the error is structural (missing import, forgotten `await`), NREKI auto-fixes it in RAM. Zero tokens wasted on fix-retry doom loops.

**v10: Exocortex** — NREKI now remembers. Save long-term insights about any symbol (`engram`). They auto-surface in every future outline and auto-delete the moment the code changes — zero hallucinations. Add Oracle type introspection (`type_shape`) and a full Cognitive Heatmap in outline (risk triage per symbol). On top of v9's Phantom Scalpel (pressure-aware engine, CognitiveEnforcer, CLI Hook installer), Spectral Architecture, and TFC-Ultra compression.

```
AI proposes edit -> NREKI intercepts in RAM -> Compiler/LSP validates
  |                                              |
  |   +-------- No errors ----------------------> Two-Phase Atomic Commit to disk
  |   |
  |   +-------- Errors found --> Auto-Heal (CodeFix API + LSP codeAction)
  |                                  |
  |              Fixed all? --------> Commit to disk
  |              Some remain? ------> Full rollback. Disk untouched. Errors returned to agent.
```

3 tools. 23 actions. 729 tests. 4 languages. Works with any MCP-compatible agent. Apache 2.0.

---

## Install (30 seconds)

```bash
# Claude Code
claude mcp add nreki npx @ruso-0/nreki

# Cursor / any MCP client
npx @ruso-0/nreki
```

That's it. NREKI auto-detects your project size and languages. No config needed.

```bash
# Optional: create optimized CLAUDE.md instructions
npx @ruso-0/nreki init
```

---

## ⚡ The "Zero-Config" Promise (80% of the value instantly)

NREKI is designed to be plug-and-play. You don't need a PhD in graph theory to use it.

Out of the box, NREKI automatically provides:

1. **Tree-sitter AST Shield (Layer 1):** Instantly catches missing commas, unclosed brackets, and hallucinated syntax in TS, JS, Python, and Go *before* they hit your disk. Zero native dependencies.
2. **TypeScript VFS (Layer 2):** Full cross-file type checking and CodeFix Auto-Healing in RAM using your existing `tsconfig.json`.
3. **TFC-Ultra Compression:** Bounding parafoveal overhead to O(1), saving 85-98% of tokens on file reads while keeping the LLM laser-focused on the exact method it needs to edit.

**What about Go and Python LSPs? (Graceful Degradation)**

If you happen to have `gopls` or `pyright` in your PATH, NREKI will silently detect them and upgrade Go/Python to Layer 2 (Cross-file semantics & LSP Auto-Healing). **If you don't have them, NREKI gracefully degrades to Layer 1.** Your agent never breaks. You get the core value with zero installation friction.

---

## What It Actually Does

| Without NREKI | With NREKI | Result |
|---------------|-----------|--------|
| `cat huge_file.ts` (burns 20k tokens) | `compress focus:"<method>"` (TFC-Ultra) | **82% to 98.2% Token Savings** |
| Agent writes broken code to disk | Edit validated in RAM before write | Zero broken files on disk |
| Error -> read output -> guess fix -> retry -> repeat | Auto-Healing fixes structural errors in RAM | Zero doom loop tokens |
| Agent manages 16+ tool calls | 3 tools, 20 actions | 85% less tool overhead |
| No idea what breaks when you rename | `prepare_refactor` shows blast radius first | Zero cascade surprises |
| Types silently degrade to `any` | TTRD catches type regressions in real-time | Zero silent debt |
| Flat file list, no structure | Spectral clustering shows domains + bridges | Architecture-aware edits |
| Dead code accumulates silently | `orphan_oracle` finds unreachable modules | Clean architecture |

---

## 🔬 Pro Features: Architecture Intelligence
*(For Staff Engineers, Tech Leads, and complex refactors)*

Under the hood, NREKI doesn't just read text; it builds a mathematical graph of your repository. It computes the combinatorial Laplacian of the file-level dependency graph to unlock advanced architectural insights that act as a passive radar for your team. **You don't need to understand any of this to get the Zero-Config benefits above** — these features kick in when you opt-in to them for complex refactors.

---

## What's New in v10 (Exocortex)

### Engrams — Persistent Symbol Memory

Save a long-term insight about any symbol and it will auto-surface in every future `outline` call:

```
nreki_guard action:"engram"
  path:"src/router.ts"
  symbol:"applyContextHeartbeat"
  text:"Re-injects session state every 50K tokens. Do not remove the heartbeat call."
```

The next time you outline `src/router.ts`, that function will show:

```
- **function** `applyContextHeartbeat` [MED — biz logic] - L104-L178
  `export function applyContextHeartbeat(...)`
  [Engram]: Re-injects session state every 50K tokens. Do not remove the heartbeat call.
```

**Auto-invalidation:** NREKI hashes the symbol's raw source at save time. If the code mutates between sessions, the engram is silently deleted and the outline shows `[Engram invalidated: code mutated since memory was saved]` — zero hallucinations from stale memory.

### Cognitive Heatmap in Outline (v9.2)

Every symbol in `outline` is now tagged with a risk score computed from its raw body:

```
- **function** `batchSemanticEdit` [HIGH — >50L, 12 branches, biz logic] - L347-L579
- **function** `detectMode` [LOW] - L50-L80
- **function** `getClaudeMdContent` [LOW] - L163-L168
```

Risk is derived from: lines of code, branch count (if/else/switch/ternary), external call count, mutation count, and business-logic naming patterns. Thresholds are fixed — no configuration.

### Oracle: Type Shape (v10)

Resolve the exact TypeScript type of any symbol without reading the file:

```
nreki_navigate action:"type_shape"
  path:"src/router.ts"
  symbol:"RouterDependencies"
```

```typescript
type RouterDependencies = { engine: NrekiEngine; monitor: TokenMonitor; ... }
```

Uses `checker.typeToString` with `NoTruncation | InTypeAlias` flags — the same resolution VS Code uses. Requires a TypeScript project with `tsconfig.json`.

### CLI Hook Installer (v9.1)

`npx @ruso-0/nreki init` now installs the PreToolUse guard hook automatically:

- Creates `.claude/hooks/nreki-enforcer.mjs`
- Writes `.claude/settings.json` with 9 matchers (Read, Write, Edit, and variants)
- Blocks native file reads/writes on >100L files at the Claude Code hooks layer
- Idempotent — safe to run multiple times

### Phantom Scalpel — Pressure-Aware Engine (v9.0)

Context pressure is tracked in real time (0.0–1.0). When pressure is high, NREKI automatically tightens compression, blocks non-essential reads, and pre-empts context overflow. The `status` action now includes a pressure gauge.

---

## What's New in v8 (Antigravity)

### Spectral Clustering

The repo map is no longer a flat list. NREKI computes the Fiedler vector (v2) from the combinatorial Laplacian of your dependency graph and partitions files into natural architectural domains:

- **Cluster A / Cluster B** — Two natural halves of your architecture (positive/negative polarity of v2)
- **Bridges** — Files where v2 ~ 0. These are structural bottlenecks connecting both domains. Sorted by stress (load / distance to center)
- **Orphans** — Zero-degree nodes with no static connections

```
=== Repo Map (47 files, 12,450 lines, lambda_2=1.4523) ===

=== STRUCTURAL BRIDGES (v2 ~ 0) ===
[CORE] src/router.ts (319 lines) [v2=0.003, In:12]
[LOGIC] src/engine.ts (780 lines) [v2=-0.008, In:8]

=== DOMAIN CLUSTER A (Positive Polarity) ===
[CORE] src/kernel/nreki-kernel.ts (1200 lines) (In:6)
...

=== DOMAIN CLUSTER B (Negative Polarity) ===
[LOGIC] src/handlers/navigate.ts (650 lines) (In:3)
...
```

### Architecture Diff

Every `batch_edit` now shows how your edit changed the architecture:

```
[NREKI ARCHITECTURE DIFF] (symbol-level topology)
lambda_2 (Algebraic Connectivity): 1.4523 -> 1.3891 (-4.4%) APPROVED
Circuit Rank beta_1: 12 -> 14 (+2) (Tangled)
Verdict: APPROVED
```

- **lambda_2 drop** = your edit weakened connectivity (potential fracture)
- **beta_1 increase** = you added dependency cycles (tangling)
- **beta_1 decrease** = you decoupled modules (healthy)

### Bridge Guard

When you edit a file that is a structural bridge, NREKI warns in real-time:

```
NREKI STRUCTURAL GUARD
Target `src/router.ts` (v2=0.0031) is a CRITICAL STRUCTURAL BRIDGE
between architectural domains.
It is a load-bearing wall with 12 dependent file(s).

DO NOT bypass it by creating parallel paths.
If you modified its signature, use `nreki_code action:"batch_edit"`
to migrate all dependents safely.
```

### Orphan Oracle

```
nreki_navigate action:"orphan_oracle"
```

Mark-and-Sweep reachability analysis starting from framework roots (index, main, config, tests, routes, stories, migrations). Reports files that export logic but are completely unreachable via static imports.

```
Orphan Candidates Oracle (Zero Static Reachability)

Found 3 files that export logic but are completely unreachable
via static imports (including transitive barrel sweeps).

Potential savings: ~450 lines.

Candidates:
- `src/legacy/old-auth.ts` (180 lines)
  Exports: OldAuthProvider, validateLegacyToken
- `src/utils/deprecated-helpers.ts` (150 lines)
  Exports: formatDate, parseConfig
```

### Cyclomatic Complexity (beta_1)

True topological circuit rank via Union-Find on the type constraint graph. `beta_1 = E - V + C` (first Betti number). Measures how many independent cycles exist in your dependency graph — not McCabe complexity, but *architectural* complexity.

---

## What's New in v8.6 (TFC-Ultra)

**Topological Foveal Compression (TFC-Ultra)** — Hyper-causal context sculpting for frontier LLMs (Opus 4.6 / Gemini 3.1 Pro). Point TFC-Ultra at a specific method or function inside a monolith, and it extracts the target symbol at 100% resolution plus its causal dependencies (upstream callers, downstream deps, resolved external imports, blast radius), while annihilating orthogonal "dark matter" code.

```bash
nreki_code action:"compress" path:"src/huge-file.ts" focus:"criticalMethod"
```

### The Physics of TFC-Ultra (Empirically Benchmarked)

We benchmarked TFC against NREKI's own `src/` directory (15 focus probes on operational methods, plus 15 boundary probes on minimal getters). No marketing fluff. Just math.

**The Asymptotic Boundary (Theoretical Ceiling):**

- **Max Compression Observed: 98.2% (55x)**
- **Context:** Focus on a 3-line getter (`isBooted`) inside an 82 KB, 1,640-line monolith (`nreki-kernel.ts`). 1,605 orthogonal lines annihilated.
- **The Amdahl Law of Context:** The compression ratio scales inversely with the focus-to-file size ratio. The larger the monolith and the smaller the target, the more devastating the compression.

**The Operational Case (Medium-to-large methods):**

- **Avg Compression: 82.2%** (~5.6x smaller)
- **p95 Compression: 89.9%** (~10x smaller)
- **Fovea Fidelity: 100%** — Target symbol preserved verbatim for zero-loss reasoning.
- **LRU Cache Speedup: 33x faster on average** (1,819ms → 11.7ms) via True LRU AST Cache. **142x in extreme cases.**

### Zero-Regression Density Shield

What happens if the LLM gets lazy and aims TFC at a 1,500-line "God Class"? The parafoveal overhead (callers, deps, metadata) would make the output larger than reading the file raw.

TFC-Ultra prevents this. If it cannot mathematically guarantee at least **15% real compression** (ratio < 0.85), it aborts silently in RAM and gracefully degrades to the Legacy Aggressive compressor. **The user never receives an output worse than the baseline.**

### Prompt Cache Inversion

TFC-Ultra forces a topological inversion of the output:

```
[Static Preamble] -> [Dark Matter Tombstones] -> [External Contracts] -> [Upstream/Downstream] -> [VOLATILE FOVEA]
```

By placing the volatile target code at the absolute bottom of the payload, the top 90% of the prompt remains static across subsequent iterative edits. This guarantees **Anthropic Prefix Cache hits**, saving users up to **90% in API costs**.

### TFC-Pro Enforcer (Cognitive Bouncer)

When a file exceeds 3,000 tokens and the agent tries to read it raw, NREKI's `PreToolUseHook` intercepts the call, blocking context-window suicide. It forces the agent to use outline + focus-driven compression instead.

**This is not marketing. This is physics.** See [BENCH-TFC.md](BENCH-TFC.md) for the raw dogfooding benchmark with per-file breakdowns.

---

## What's New in v8.5 (Engine Decomposition)

The 878-line `engine.ts` God Object was decomposed into a clean facade pattern:

- `engine-types.ts` — shared type definitions (SearchResult, EngineConfig, SessionReport, IndexStats)
- `engine/indexer.ts` — `IndexPipeline` class (write side: AST parsing, embedding, batch storage)
- `engine/searcher.ts` — `SearchEngine` class (read side: T-RAG Tectonic Relevance Scoring)
- `engine.ts` — thin orchestrator facade (~520 lines)

Zero API changes. All 28 public methods on `NrekiEngine` preserved. `sql.js` intentionally kept (migration to `node:sqlite` postponed to v9.0 to avoid breaking users on Node 20 LTS or forcing the `--experimental-sqlite` flag).

---

## What's New in v8.3

### Kernel Decomposition (v8.1)

The 2,080-line God Object `nreki-kernel.ts` was decomposed into 4 focused modules:

- `mutex.ts` — AsyncMutex FIFO with timeout protection
- `types.ts` — All interfaces + IoC contracts (`TsHealingContext`, `LspHealingContext`)
- `ttrd.ts` — Pure functions: `extractRawSignatures`, `detectSignatureRegression`, `isToxicType`
- `healer.ts` — Both healers rewritten with Inversion of Control — healers no longer touch VFS, vfsClock, or tsBackend directly. Testable in isolation.

### Production Hardening (v8.2)

- **Token Drift Heartbeat** — Replaced call-count heuristic (15 calls) with token-physics (15,000 tokens default). ENV override: `NREKI_DRIFT_THRESHOLD`. Telemetry injected into header: `(Drift: X tokens | Limit: Y)`.
- **Search Engine Segregation** — `VectorIndex` and `KeywordIndex` extracted to `src/search/`. Pure JavaScript, zero SQLite coupling. Ready for `node:sqlite` migration in v9.0.
- **Handler Barrel Pattern** — 1,119-line `handlers/code.ts` split into `code/kernel-bridge.ts`, `code/read.ts`, `code/edit.ts`, `code/utils.ts`. Rate limiter stays in router (correct layer separation).
- **WASM Deps Frozen** — `sql.js` and `tree-sitter-wasms` pinned to exact versions. No silent breakage from upstream updates.

### Rayleigh Residual Guard (v8.3)

Added a 4th defense layer to the spectral power iteration. Post-convergence, the solver computes `||Mv - μv||∞` and dies with `NaN` if the residual exceeds `1e-3`. This traps silent IEEE 754 drift that slips past the 3 existing guards (thermal, divergence, numerical sanity firewall).

### interceptAtomicBatch Phase Extraction (v8.3)

The 520-line ACID orchestrator was flattened into 3 private methods within `NrekiKernel`:

- `phase1_injectVfs` — Path jail + VFS injection
- `phase2_validateSidecars` — Go/Python LSP validation
- `phase4_healingCascade` — Dual healer cascade (TS CodeFix API + LSP codeAction)

Catch path untouched. ACID rollback semantics intact. The orchestrator now reads like a document.

### engine.ts Flattening (v8.3)

- **SessionTracker class** — Session state (`sessionSavings`) encapsulated. Saves one `Embedder.estimateTokens(content)` call per compression.
- **`indexFile` split** — 124-line method → 28-line orchestrator + `indexPlaintextFallback` + `indexAstChunks`.
- **`search` split** — 93-line method → 27-line orchestrator + `applyTectonicRelevanceScoring`.
- **DB Facade grouping** — Delegation wrappers visually grouped under explicit `Facade` section headers.

---

## The Architecture

NREKI has 3 validation layers with multi-language support:

**Layer 1 -- Syntax (Tree-sitter).** Every edit is parsed by Tree-sitter WASM before anything else. Catches syntax errors in TypeScript, JavaScript, Python, and Go. Always on.

**Layer 2 -- Semantics.** Language-specific validation in RAM:
- **TypeScript/JavaScript:** Full incremental TypeScript compiler with VFS. Cross-file type errors caught before disk writes. ACID rollback.
- **Go:** gopls spawned as LSP sidecar process. JSON-RPC 2.0 over stdio. Pull diagnostics (LSP 3.17+).
- **Python:** pyright spawned as LSP sidecar. Same architecture as Go.
- **Cross-language:** If a `batch_edit` touches `.ts` + `.go`, both backends must approve or the entire batch is rolled back.

**Layer 3 -- Auto-Healing (Dual Cascade).** When Layer 2 finds errors, NREKI attempts automatic repair:
- **TypeScript:** CodeFix API (same engine as VS Code's "Quick Fix"). 8 whitelisted fix types.
- **Go/Python:** LSP `codeAction/resolve` requests. Structural fixes only.
- **Ice Wall (Muro de Hielo):** Whitelist of safe fix kinds. Business logic is never touched.
- Each fix must reduce the total error count or it's micro-rolled-back.

---

## The 3 Tools

### `nreki_navigate` -- Find and understand code

| Action | What It Does |
|--------|-------------|
| `search` | T-RAG: Topology-Aware search that ranks results by blast radius, not just text similarity |
| `definition` | Go-to-definition by symbol name with auto-injected dependency signatures |
| `references` | Find all references cross-project |
| `outline` | List all symbols with risk triage tags (`[LOW]`/`[MED]`/`[HIGH]`) and inline Engram memories |
| `map` | Spectral repo map: files grouped by cluster (bridge/domain A/domain B/orphan) with lambda_2 |
| `prepare_refactor` | Predictive blast radius: shows every file that breaks if you rename a symbol |
| `orphan_oracle` | Mark-and-Sweep dead code detection via transitive reachability from framework roots |
| `type_shape` | Oracle: invoke TS compiler for exact resolved type shape (requires tsconfig.json) |

### `nreki_code` -- Read, write, and validate code

| Action | What It Does |
|--------|-------------|
| `read` | Smart file reading with 3-level compression + Chronos friction warnings |
| `compress` | Light/medium/aggressive compression with per-section breakdown |
| `edit` | Surgical edit by symbol name -- validated by Tree-sitter + Compiler/LSP + Auto-Healer + Bridge Guard |
| `batch_edit` | Atomic multi-file edit. All files pass or none are written. Includes Architecture Diff. |
| `undo` | Restore last edit from backup |
| `filter_output` | Strip ANSI, deduplicate errors, compress terminal output |

### `nreki_guard` -- Safety and session management

| Action | What It Does |
|--------|-------------|
| `pin` / `unpin` | Persistent rules injected into every `map` response |
| `status` | Token burn rate, depletion prediction, model recommendation |
| `report` | Full session receipt with USD savings estimate |
| `reset` | Clear circuit breaker after doom loop recovery |
| `set_plan` | Anchor a plan file -- survives context compaction via Context Heartbeat |
| `memorize` | Save progress notes to NREKI's active scratchpad |
| `audit` | Architecture Health Index: 5-signal deterministic score (1-10) with recovery plan |
| `engram` | Anchor a long-term insight to a symbol -- auto-surfaces in outline, auto-deletes if code mutates |

---

## Language Support

| Language | Layer 1 (Syntax) | Layer 2 (Semantics) | Layer 3 (Auto-Heal) | TTRD |
|----------|:---:|:---:|:---:|:---:|
| TypeScript | Yes | Compiler API | CodeFix API | TypeFlags |
| JavaScript | Yes | Compiler API | CodeFix API | TypeFlags |
| Go | Yes | gopls LSP | codeAction | Syntactic v2 |
| Python | Yes | pyright LSP | codeAction | Syntactic v2 |

Go/Python require gopls/pyright in PATH. If not found, NREKI degrades gracefully to Layer 1.

**TTRD Syntactic v2** (v7.3): For Go and Python, NREKI detects type regressions using structural signature analysis with toxicity scoring and bracket-balanced extraction -- no type checker required.

---

## Performance

NREKI auto-selects validation depth. No configuration needed.

| Mode | Project Size | What It Checks | Boot Time | RAM |
|------|-------------|----------------|-----------|-----|
| Syntax | < 50 files | Tree-sitter AST only | < 100ms | ~30MB |
| File | 50-200 files | Semantic checks on touched files | 1-3s | ~150MB |
| Project | 200-1000 files | Full cross-file cascade + spectral clustering | 3-10s | 200MB-1GB |
| Hologram | > 1000 files | Full cascade via .d.ts shadows (JIT) | ~2s | ~350MB |

### VSCode Benchmark (5,584 files)

| Metric | Hologram (JIT) | Project | File |
|--------|---------------|---------|------|
| Boot | **1.94s** | 111s | 91.6s |
| First edit | 1384ms | 644ms | 55ms |
| Total | **3.32s** | ~112s | ~92s |
| RAM | ~350MB | OOM (16GB) | 4.5GB |
| Files loaded | 642 on-demand | 5,584 | 5,584 |

### Spectral Topology Benchmark (11 projects, 55 test cases)

| Project | Files | Nodes | Edges | Max Latency | Result |
|---------|-------|-------|-------|-------------|--------|
| Zod | 195 | 2,251 | 6,242 | 32.2ms | 55/55 PASS |
| tRPC | 89 | 828 | 1,790 | 41.3ms | 55/55 PASS |
| Prisma | 1,970 | 3,546 | 5,319 | 7.7ms | 55/55 PASS |
| Next.js | 1,445 | 5,024 | 7,589 | 27.0ms | 55/55 PASS |
| VS Code | 4,697 | 24,204 | 111,994 | 29.1ms | 55/55 PASS |
| Effect | 362 | 10,935 | 72,723 | 95.8ms | 55/55 PASS |

0 false positives across 55 test cases and 11 real projects.

---

## Key Features

### Spectral Architecture Engine (v8.0)

NREKI computes the combinatorial Laplacian of the file-level dependency graph and extracts:

- **lambda_2 (Fiedler value):** Algebraic connectivity. How tightly coupled is your codebase.
- **v2 (Fiedler vector):** Each file gets a signed score. Sign determines cluster, magnitude determines distance from the architectural cut.
- **lambda_3 / v3:** Third eigenvalue and eigenvector for spectral gap ratio (bipartition confidence).
- **beta_1 (Circuit Rank):** `E - V + C` via Union-Find with path compression. True topological cyclomatic complexity.
- **Bridge threshold:** `epsilon = sigma / gamma` where `gamma = lambda_3 / lambda_2`, bounded `[0.01, 0.15]`.

### T-RAG -- Topology-Aware Retrieval (v7.1)

Standard RAG returns the most textually similar code. T-RAG re-ranks results using the project's dependency graph:

```
TRS = RRF x G(d) x B(d,q)

G(d) = Gravity: PageRank tier weight + log2(1 + inDegree)
B(d,q) = Blast Radius resonance: 1.5x if the file imports the search epicenter
```

### Architecture Health Index (v7.1)

`nreki_guard action:"audit"` computes a deterministic 1-10 score from 5 signals: Spectral Integrity (lambda_2/avgDegree), Bus Factor (Shannon Entropy), Type Safety, Core Coverage, and Stability (Chronos CFI). Includes recovery plan simulated in RAM.

### Auto-Healing Dual Cascade (v7.3)

When validation fails, NREKI attempts repair through two cascading systems:

1. **TypeScript:** CodeFix API -- 8 whitelisted structural fixes (imports, async/await, interface implementation)
2. **Go/Python:** LSP `codeAction` -- structural fixes from gopls/pyright filtered through the Ice Wall whitelist

Each fix must reduce total errors. If a fix fails, it's micro-rolled-back and blacklisted. If all errors are resolved, the edit commits. If some remain, full rollback -- disk untouched.

### TTRD -- Type Regression Detection

**TypeScript:** TypeFlags-based toxicity scoring (any=10, unknown=2, Function=5). Compares pre/post type contracts within the ACID transaction. Tracks type debt across sessions.

**Go/Python (v7.3):** Syntactic v2 -- structural signature analysis with bracket-balanced extraction and toxicity pattern matching. Detects regressions without a type checker.

### Chronos Memory

Cross-session file fragility tracking. CFI scoring (trip=10, error=3, heal=1). Session decay 0.85. Successful edits halve the friction score. High-CFI files require uncompressed read before editing.

### Context Heartbeat

Re-injects 4-layer session state every ~15 tool calls to survive context compaction. Respects prompt cache physics -- map output stays at token position 0.

---

## Security

- **Zero cloud, zero telemetry, zero network calls.** Everything runs locally.
- **Path traversal protection** at middleware + kernel level with POSIX normalization.
- **Sensitive file blocking** -- `.env`, `.pem`, `.key`, `id_rsa` are rejected by the VFS.
- **ACID transactions** -- partial writes are impossible. Backup -> temp -> rename -> cleanup.
- **48 security tests** covering traversal, symlink escape, injection, and circuit breaker abuse.
- **LSP Anti-Zombie Guard** -- stdin pipe suffocation + SIGKILL kills the entire process tree (tsx wrappers, grandchildren). SSOT `cleanupState()` cleans all timers, pending requests, and listeners in one idempotent call.

---

## Numbers

| Metric | Value |
|--------|-------|
| Tests | 729 (45 suites) |
| Architecture Health Index | 9.7/10 (self-scored) |
| **Max TFC-Ultra Compression** | **98.2% (55x)** |
| **TFC LRU Cache Speedup** | **34x avg (11.7ms latency)** |
| Languages | 4 (TypeScript, JavaScript, Go, Python) |
| Failure modes sealed | 32 (P1-P32) |
| Audit findings resolved | 30/30 + 22 additional |
| Auto-Healing fix types | 8 CodeFix (TS) + LSP codeAction (Go/Py) |
| Spectral benchmark | 11 projects, 55/55 correct, 0 false positives |
| OpenDota benchmark | 6/6 correct verdicts |
| VSCode (5,584 files) | JIT boot 1.94s, total 3.32s |
| Router | 3 facades, 23 actions |
| Tool overhead | ~660 tokens (3 tools replace 16) |

---

## How It Works Internally

### The Intercept Cycle

1. **Inject** -- All edits enter VFS simultaneously (atomic batch)
2. **Compile** -- Incremental TypeScript builder evaluates proposed future state
3. **Shield 1-3** -- Global -> Syntactic -> Semantic diagnostics
4. **LSP Sidecars** -- Go/Python files validated via gopls/pyright (Pull diagnostics LSP 3.17+)
5. **Auto-Heal** -- Dual Cascade: CodeFix API (TS) + LSP codeAction (Go/Py) through Ice Wall whitelist
6. **TTRD** -- Compare pre/post type contracts (TypeFlags for TS, Syntactic v2 for Go/Py)
7. **Architecture Diff** -- Pre/post spectral analysis: lambda_2 shift + beta_1 circuit rank delta
8. **Verdict** -- All clear -> Two-Phase Atomic Commit. Errors remain -> Full rollback.

### Architecture (v8.0)

```
NrekiKernel (Orchestrator)
  +-- VFS (Map<string, string|null>), ACID rollback, mutex, logical clock
  +-- TsCompilerWrapper (TypeScript backend)
  |     +-- CompilerHost + DocumentRegistry + LanguageService
  |     +-- Incremental builder with corruption recovery
  |     +-- TTRD: TypeFlags toxicity scoring
  |     +-- Auto-Healer: 8 whitelisted CodeFix types
  +-- LspSidecarBase (Go/Python backends)
  |     +-- JSON-RPC 2.0 over stdio, Pull diagnostics (LSP 3.17+)
  |     +-- requestCodeActions + Ice Wall whitelist
  |     +-- TTRD Syntactic v2 (toxicity + bracket balancer)
  |     +-- SSOT cleanupState() -- one idempotent funnel for all death paths
  |     +-- Anti-Zombie: stdin suffocation + SIGKILL (kills entire process tree)
  +-- GoLspSidecar -> gopls
  +-- PythonLspSidecar -> pyright
  +-- TypeScriptCorsaBackend -> tsgo (Project Corsa placeholder)
  +-- SpectralTopologist
        +-- Fiedler vector (v2) + spectral gap (lambda_3/lambda_2)
        +-- Union-Find beta_1 cyclomatic complexity
        +-- Architecture Diff (pre/post topology comparison)

Router (3 facades, 23 actions)
  +-- nreki_navigate -> handlers/navigate.ts (8 actions)
  +-- nreki_code -> handlers/code.ts (6 actions)
  +-- nreki_guard -> handlers/guard.ts (9 actions + Context Heartbeat)

RepoMap (Spectral Clustering)
  +-- PageRank tier classification (core/logic/leaf)
  +-- Fiedler bipartition (cluster_a/cluster_b/bridge/orphan)
  +-- Stress-ranked bridge detection (load / |v2|)
  +-- Deterministic text for Anthropic prompt caching
```

---

## Honest Limitations

**Small projects don't need the kernel.** Projects under 50 files run in syntax mode (Tree-sitter only). The kernel boots for 50+ file projects where cross-file validation matters.

**TypeScript Compiler API dependency.** Uses `ts.createEmitAndSemanticDiagnosticsBuilderProgram` and `ts.LanguageService`. Pinned to `typescript@^5.9.3`.

**Auto-Healing is conservative.** Structural fixes only. Business logic errors are returned to the agent, never auto-fixed. If the healer can't resolve ALL errors, everything rolls back.

**Go/Python TTRD is syntactic.** Without a type checker exposing resolved types, TTRD v2 uses structural pattern matching -- accurate for signature changes, blind to inferred type regressions.

**Token savings are estimates.** Uses `characters / 3.5` heuristic, not BPE tokenization. Real savings vary ~20-40%.

**Orphan Oracle is static.** Cannot detect dynamic imports (`await import()`), dependency injection, or reflection-based loading. Review candidates manually before deleting.

**Spectral clustering requires edges.** Projects with fewer than 3 files or zero import relationships fall back to flat rendering.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0 -- see [LICENSE](LICENSE).

## Author

**Jherson Eddie Tintaya Holguin** ([@Ruso-0](https://github.com/Ruso-0))

Arequipa, Peru.
