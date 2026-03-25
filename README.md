# NREKI - 3 Tools. 696 Tests. Pre-write validation for AI agents.

<p align="center">
  <img src="https://img.shields.io/badge/MCP-Plugin-blue?style=for-the-badge" alt="MCP Plugin">
  <img src="https://img.shields.io/badge/Tools-3-blueviolet?style=for-the-badge" alt="3 Tools">
  <img src="https://img.shields.io/badge/Tests-696-brightgreen?style=for-the-badge" alt="696 Tests">
  <img src="https://img.shields.io/badge/Cloud-Zero-orange?style=for-the-badge" alt="Zero Cloud">
  <img src="https://img.shields.io/badge/License-Apache_2.0-yellow?style=for-the-badge" alt="Apache 2.0 License">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge" alt="TypeScript 5.9">
  <img src="https://img.shields.io/badge/Node-%3E%3D20-339933?style=for-the-badge" alt="Node >=20">
</p>

<p align="center">
  <b>MCP server that validates AI agent edits in RAM before they reach disk. Cross-file semantic checks, auto-fixes for structural errors, and type regression detection.</b>
</p>

---

## What's New in v7.0: Software Physics Engine

NREKI v7.0 turns the spectral topology gate into a full physics engine. Every proposed edit now produces eigenvector coordinates — Fiedler vectors (v2) map bridge fragility, third eigenvectors (v3) map topological stress, and gauge fixing ensures deterministic sign across commits (critical for ML pipelines).

Key additions:
- **Fiedler Vector (v2)**: Full eigenvector extraction — per-node bridge fragility map
- **Third eigenvalue (λ₃) + eigenvector (v3)**: Spectral gap ∇(λ₃ - λ₂) enables predictive analysis
- **Gauge Fixing**: Deterministic phase canonicalization prevents sign ambiguity across commits
- **Monorepo workspace resolution**: `buildFastLookup` resolves `@org/package` imports via O(1) string math
- **Adaptive Shotgun Surgery**: Threshold scales with repo size — no more false positives on large codebases
- **Modern module extensions**: Full `.mts`, `.cts`, `.mjs`, `.cjs` support across all subsystems
- **32+ audit fixes**: VFS zombie state, WASM race conditions, extractName regex purge, and more (see CHANGELOG)

---

## What's New in v6.0: JIT Holography

When an LLM forgets an import, drops an `async` keyword, or leaves an interface incomplete, NREKI now **auto-corrects the error in RAM** using TypeScript's CodeFix API - the same engine behind VS Code's "Quick Fix" lightbulb. The LLM never sees the error. Zero tokens wasted on fix-retry loops.

```
LLM proposes edit
  |
  v
NREKI intercepts in RAM
  |
  v
Triple Shield (Global -> Syntactic -> Semantic)
  |
  +-- No errors? --> Two-Phase Atomic Commit to disk
  |
  +-- Errors found?
        |
        v
      Auto-Heal: getCodeFixesAtPosition()
        |
        +-- Apply 1 fix --> Recompile (~20ms) --> Errors decreased?
        |     +-- Yes --> Accept fix, loop for next error
        |     +-- No  --> Micro-rollback this fix, blacklist it
        |
        +-- All errors resolved? --> Commit to disk (safe: true)
        +-- Some remain?         --> Full rollback, return errors to LLM (safe: false)
```

**8 structural fixes** in the whitelist: `import`, `fixMissingImport`, `fixAwaitInSyncFunction`, `fixPromiseResolve`, `fixMissingProperties`, `fixClassDoesntImplementInheritedAbstractMember`, `fixAddMissingMember`, `fixAddOverrideModifier`. Business logic is never mutated.

See [CHANGELOG.md](CHANGELOG.md) for full details.

### Performance Modes (v6.0)

NREKI auto-selects validation depth based on project size. No configuration needed.

| Mode | Files | What it checks | Boot | RAM |
|------|-------|---------------|------|-----|
| Syntax | < 50 | Syntax only (Tree-sitter) | < 100ms | ~30MB |
| Project | 50-1000 | Full cross-file semantic validation | 1-10s | 200MB-1GB |
| Hologram | > 1000 | Full cross-file via .d.ts shadows | ~1-2s | ~350MB |

**Hologram mode (v6.0):** For large projects (>1000 files), NREKI replaces full `.ts` source files with lightweight `.d.ts` shadow stubs in the TypeScript compiler's VFS. Only the currently-edited file and its import subgraph are loaded. A symbiotic harvester replaces heuristic shadows with compiler-grade `.d.ts` during idle cycles.

Override in package.json: `{ "nreki": { "mode": "project" } }`

### VSCode Benchmark (5,584 files)

| Metric | Project mode | File mode | Hologram (JIT) |
|--------|-------------|-----------|----------------|
| Boot | 111s | 91.6s | 1.94s |
| First edit | 644ms | 55ms | 1384ms |
| Total (boot + edit) | ~112s | ~92s | 3.32s |
| RAM | OOM (16GB) | 4.5GB | ~350MB |
| Files loaded | 5,584 | 5,584 | 642 on-demand |
| Cross-file checking | Full cascade | Edited only | Via shadows |
| VSCode files modified | 0 | 0 | 0 |

Hologram mode uses domain separation: the holographic kernel validates edits via shadows,
while Layer 1 AST navigator handles reference queries and refactoring.

**vs Project Corsa:** Microsoft's [TypeScript 7 native port](https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/) (Go, multi-threaded) reports 8.74s for VSCode type-checking. NREKI JIT Holography achieves 3.32s total (boot + first edit) in single-threaded JavaScript by skipping 88% of files via on-demand shadow classification.

### Type Regression Detection (v5.3)

Detects when an agent weakens types silently. TypeScript approves `RetryConfig` changed
to `any` because `any` accepts everything. NREKI catches it.

Compares pre-edit and post-edit type signatures using toxicity scoring.
Detects structural collapse (`Promise<any>` to `any`) and wrapper primitives
(`string` to `String`).

---

## The Problem

AI coding agents (Claude Code, Cursor, Copilot Workspace) edit files autonomously. When they change a function signature in one file, they break every file that depends on it. You find out when tests fail - or worse, in production. The agent then burns thousands of tokens reading error output, guessing fixes, and retrying - a doom loop that wastes your context window.

---

## The Solution

| What you do now | What NREKI does | Savings |
|-----------------|-----------------|---------|
| `cat file.ts` (full file read) | `nreki_code action:"read"` (smart compression) | ~60-80% fewer tokens |
| Native `edit_file` (blind write) | `nreki_code action:"edit"` (symbol-targeted + ACID validation) | Zero broken writes |
| Read error → fix → retry → repeat | Auto-Healing L3.3 fixes structural errors in RAM | Zero doom loop tokens |
| Manual `find_references` per file | `nreki_navigate action:"prepare_refactor"` (blast radius) | Prevents cascade breaks |
| Agent manages 16 tool definitions | 3 tools, 19 actions | 81% less tool definition overhead |

---

## The 3 Tools

### `nreki_navigate` - Find and understand code

| Action | What It Does |
|--------|-------------|
| `search` | Hybrid BM25 + semantic search (Pro) or keyword search (Lite) |
| `definition` | Go-to-definition by symbol name |
| `references` | Find all references cross-project |
| `outline` | List symbols in a file with signatures |
| `map` | Static repo map with PageRank scoring and pinned rules |
| `prepare_refactor` | Shows which files depend on a symbol before you edit it |

### `nreki_code` - Read, write, and validate code

| Action | What It Does |
|--------|-------------|
| `read` | Smart file reading with auto-compression |
| `compress` | 3 levels (light/medium/aggressive) or 6 granular tiers |
| `edit` | Surgical edit by symbol name. Validated by Tree-sitter AST + NREKI Kernel |
| `batch_edit` | Multi-file atomic edit with two-phase file locking. All-or-nothing |
| `undo` | Restore last edit from backup |
| `filter_output` | Filter and compress terminal output |

### `nreki_guard` - Safety controls and session management

| Action | What It Does |
|--------|-------------|
| `pin` | Add persistent rules injected into every map response |
| `unpin` | Remove a pinned rule |
| `status` | Token burn rate and depletion prediction |
| `report` | Session receipt with USD cost estimates |
| `reset` | Reset session counters |
| `set_plan` | Store a plan file for context heartbeat |
| `memorize` | Store scratchpad notes for context survival |

**3 tools, 19 actions.** ~660 tokens of tool definitions instead of ~3,520. 81% reduction in fixed overhead.

---

## Invisible Middleware

These layers run automatically on every edit. You never call them directly.

| Layer | What It Does |
|-------|-------------|
| **AST Validation** | Tree-sitter parses the proposed code before any write. Catches syntax errors in sub-millisecond time. Works for TS, JS, Python, Go. |
| **Circuit Breaker** | Detects doom loops (repeated failures on the same file). 3-level escalation: Rewrite strategy → Decompose → Hard Stop. |
| **NREKI Kernel (L2)** | Cross-file semantic validation in RAM via TypeScript Compiler API. Triple Shield: Global → Syntactic → Semantic. ACID rollback on failure. |
| **Auto-Healing** | When the kernel detects structural errors, attempts repair using `ts.LanguageService.getCodeFixesAtPosition()`. Each fix must reduce error count or it is reverted. |

---

## Architecture

```
+---------------------------------------------------------+
|                    Claude Code Agent                     |
|          (nreki_navigate, nreki_code, nreki_guard)       |
+----------------------------+----------------------------+
                             |
                             v
+---------------------------------------------------------+
|               NREKI Router (src/router.ts)               |
|   Context Heartbeat | Circuit Breaker | File Lock        |
+----------------------------+----------------------------+
                             |
                   +---------+-----------+
                   v                     v
+------------------+     +-------------------------------+
|    Layer 1       |     |    Layer 2                     |
|    Tree-sitter   |     |    NREKI Kernel                |
|    (syntax)      |     |    (cross-file semantics)      |
|                  |     |                                |
|    Sub-ms AST    |     |    TypeScript Compiler API     |
|    validation    |     |    hijacked with VFS in RAM    |
|                  |     |                                |
|    All languages |     |    TS/JS only (tsconfig.json)  |
+------------------+     |                                |
                         |    * Global + syntax + semantic  |
                         |      diagnostics                 |
                         |    * Auto-fix via CodeFix API    |
                         |      (8 structural fix types)    |
                         |    * ACID transactions           |
                         |    * Two-phase atomic commit     |
                         |    * Reference analysis          |
                         |    * Import graph scoring        |
                         |    * ~50ms rollback              |
                         |    * Performance modes           |
                         |      (syntax/file/project)       |
                         +-------------------------------+
```

---

## Installation

```bash
# Quick start
npx @ruso-0/nreki

# Or install globally
npm install -g @ruso-0/nreki
```

### Claude Code CLI

```bash
# Lite mode (default - instant startup, BM25 search)
claude mcp add nreki -- npx @ruso-0/nreki

# Pro mode (hybrid semantic + BM25 search, ~5-10s startup)
claude mcp add nreki -- npx @ruso-0/nreki --enable-embeddings
```

### Manual Configuration

Add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "nreki": {
      "command": "npx",
      "args": ["@ruso-0/nreki"]
    }
  }
}
```

### Modes

| | Lite (Default) | Pro (Opt-in) |
|---|---|---|
| **Startup** | Instant (~100ms) | ~5-10s (ONNX model load) |
| **Search** | BM25 keyword search | Hybrid semantic + BM25 with RRF |
| **Layer 2** | Active if tsconfig.json present | Active if tsconfig.json present |
| **Enable** | Default | `--enable-embeddings` flag |

Layer 2 (NREKI Kernel) activates automatically in any TypeScript/JavaScript project with a `tsconfig.json`. Non-TypeScript projects operate with Layer 1 (Tree-sitter syntax validation) only.

---

## Quick Start

```bash
# Search for a function
nreki_navigate action:"search" query:"getUserId"

# Read a file with compression
nreki_code action:"read" file:"src/auth.ts"

# Surgically edit a function (NREKI validates before writing)
nreki_code action:"edit" file:"src/auth.ts" symbol:"getUserId" new_code:"..."

# Atomic multi-file edit
nreki_code action:"batch_edit" edits:[{path:"src/auth.ts", symbol:"getUserId", new_code:"..."}, ...]

# Check blast radius before refactoring
nreki_navigate action:"prepare_refactor" file:"src/auth.ts" symbol:"getUserId"

# Pin a persistent rule
nreki_guard action:"pin" text:"Never use 'any' type in this project"

# Check token budget
nreki_guard action:"status"
```

---

## Tests

**696 tests across 43 suites. Zero failures.**

| Suite | Tests | What It Covers |
|-------|-------|---------------|
| nreki-kernel | 28 | Boot, semantic validation, syntactic shield, baseline tolerance, file operations, ACID, concurrency, edge cases, precision |
| auto-healing | 6 | Missing import heal, await/async heal, cascade micro-rollback, business logic rejection, healingStats, clean code passthrough |
| nreki-integration | 8 | Zero-disk-touch path, type-breaking block, batch dryRun, atomic commit, path traversal rejection |
| router | 32 | All 19 actions across 3 tools, error handling, parameter validation |
| security | 48 | Path traversal, symlink escape, injection, sensitive file blocking, circuit breaker, pin sanitization |
| circuit-breaker | 45 | 3-level escalation, reset behavior, threshold detection |
| stress | 37 | Concurrent operations, large file handling, memory pressure |
| semantic-edit | 24 | Symbol targeting, mode switching, edge cases |
| audit-fixes | 54 | All 30 audit findings verified resolved |
| repo-map | 22 | PageRank scoring, import graph, classification |
| Other suites | 261 | Engine, middleware, terminal filter, pin memory, compressor, AST, batch edit, backward compat, heartbeat, file lock, auto-context, v4 bugfixes, e2e breaker, parser-pool, mutex, document-registry, tsbuildinfo-cache |
| mode-detection | 20 | Mode auto-detection, syntax/file/project behavior, elastic threshold, early exit recovery |
| ttrd-silent-crime | 1 | Silent type degradation caught by TTRD |
| ttrd | 19 | Type regression detection, toxicity scoring, barrel guards |
| chronos-memory | 16 | Cross-session friction tracking, health score |
| hologram | 45 | Shadow generation, VFS integration, lazy subgraph, domain separation, harvester, full cycle |
| jit-holography | 15 | JIT on-demand classification, cache, rollback, interceptAtomicBatch |

---

## Real-World Benchmark: OpenDota (148 files, 1,600+ stars)

| Test | Result | Latency | Details |
|------|--------|---------|---------|
| Boot | SUCCESS | 7.39s | 148 files tracked, 0 baseline errors |
| Valid edit | PASS | 2,062ms | Appending a comment - no false positive |
| Type break | **CAUGHT** | 7,230ms | Changed `getPGroup()` return type - cross-file error caught |
| Syntax break | **CAUGHT** | 3,774ms | `return const let;` - blocked |
| File delete | PASS | 1,596ms | Leaf file deletion - correctly allowed |
| Non-TS file | PASS | 2,907ms | README.md - correctly ignored |

**6/6 correct verdicts** against a real TypeScript project. Zero false positives. Zero false negatives.

---

## Security

- **Zero cloud, zero telemetry, zero network calls** - everything runs locally
- **Embeddings computed locally** via ONNX Runtime (optional `@xenova/transformers`)
- **Path traversal protection** - `safePath()` in middleware + kernel-level path jail in `interceptAtomicBatch()`
- **Sensitive file blocking** - `.env`, `.pem`, `.key`, `id_rsa`, `id_ed25519` rejected by VFS hijack
- **SQLite storage** - all data in local `.nreki.db`, no external services
- **WASM memory safety** - `safeParse()` with cleanup for Tree-sitter parsers
- **30/30 audit findings resolved** in v5.0.0 (see `tests/audit-fixes.test.ts`)

---

## Numbers

| Metric | Value |
|--------|-------|
| Tests | 696 (43 suites) |
| Failure modes sealed | 32 (P1-P32) |
| Audit findings resolved | 30/30 |
| OpenDota benchmark | 6/6 correct verdicts |
| Auto-Healing safe fixes | 8 CodeFix types |
| Boot time (148 files) | 7.39s |
| Warm-path rollback | ~50ms |
| Blast radius query | ~20ms |
| PageRank convergence (1,000 files) | < 50ms |
| Tool definition overhead | ~660 tokens (81% reduction from v2) |
| VSCode benchmark (5,584 files) | JIT boot 1.94s, total 3.32s, 642 files on-demand |
| Mode detection | 85ms for 5,584 files |

---

## Honest Limitations

### Small Projects Don't Need the Kernel

NREKI auto-detects project size. Projects under 50 files run in syntax mode (Tree-sitter only, no compiler). The kernel only boots for projects with 50+ files where cross-file validation matters.

### TypeScript Compiler API Dependency

The NREKI Kernel depends on `ts.createEmitAndSemanticDiagnosticsBuilderProgram` and `ts.LanguageService`. These are public APIs but Microsoft modifies them between major TypeScript versions. NREKI pins `typescript@^5.9.3` and tests against each release. If TypeScript 6.0 introduces breaking changes, NREKI will require updates.

### Auto-Healing Is Conservative

The healer only applies 8 structural fix types from a strict whitelist. It will not fix business logic errors, type mismatches, or architectural mistakes. If the healer cannot resolve ALL errors, it rolls back completely and returns the original errors to the LLM. This is by design - partial healing could mask bugs.

### Token Savings Are Estimates

Token savings reported in tool responses use a `characters / 3.5` heuristic, not actual BPE tokenization. Real savings may differ by 20-40% depending on code density. The savings are real - the exact numbers are approximate.

### Language Coverage

| Language | Layer 1 (Syntax) | Layer 2 (Semantics) | Auto-Healing (L3.3) |
|----------|:-:|:-:|:-:|
| TypeScript | Yes | Yes | Yes |
| JavaScript | Yes | Yes | Yes |
| Python | Yes | No | No |
| Go | Yes | No | No |

Layer 2 and Auto-Healing require `tsconfig.json`. Python and Go projects operate with Layer 1 syntax validation only.

---

## Technical Deep Dive

### The Intercept Cycle

1. **Inject** - All edits enter VFS staging simultaneously (atomic batch)
2. **Compile** - Incremental builder evaluates proposed future state
3. **Shield 1** - Global diagnostics (TS6053, TS2307)
4. **Shield 2** - Syntactic diagnostics on edited files only
5. **Shield 3** - Semantic diagnostics on all affected files (cross-file blast radius)
6. **Auto-Heal** - If errors found, attempt structural repair via CodeFix API (L3.3)
7. **Verdict** - Errors resolved by healer → SAFE. Errors remain → BLOCK + full rollback
8. **Commit** - Two-phase atomic write (backup → temp+rename → cleanup)

### Known Failure Modes (P1-P32)

| Category | Problems |
|----------|----------|
| Compiler Cache | P8 (monotonic clock), P11 (periodic GC), P17 (zombie AST) |
| Error Tracking | P9 (topological cardinality), P15 (path sanitization), P28 (syntactic blindness) |
| Concurrency | P10 (FIFO mutex), P21 (multi-file deadlock), P25 (idempotent undo-log) |
| File Operations | P4 (dynamic rootNames), P5 (tombstone deletion), P27 (recursive mkdir), P29 (TS6053 ghost), P30 (non-TS filter) |
| Path Handling | P26 (POSIX normalization), P31 (virtual directories) |
| Physical I/O | P2 (atomic commit), P18 (destruction & resurrection), P32 (physical rollback) |
| Security | A1 (path jail), A5 (node_modules regex), A10 (sensitive file filter) |

### How Auto-Healing Decides

Each fix must reduce the total error count. If applying a fix leaves the same number of errors or more, the fix is reverted and blacklisted. If all errors are resolved, the edit is committed. If some remain, everything is rolled back and the original errors are returned to the agent.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0 - see [LICENSE](LICENSE).

## Author

**Jherson Eddie Tintaya Holguin** ([@Ruso-0](https://github.com/Ruso-0))

Cusco, Peru.
