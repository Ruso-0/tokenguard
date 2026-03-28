# NREKI — Architecture Guide

> **Version:** 7.1.2
> **Author:** Jherson Eddie Tintaya Holguin (Ruso-0)  
> **Purpose:** MCP server that validates AI agent code edits in RAM before they touch disk.

---

## Overview

Nreki is a **semantic verification kernel** for AI coding agents. It sits between the agent and the filesystem, intercepting every code edit, validating it against the full project's type system in RAM, and only committing to disk if the edit is provably safe.

**Core guarantee:** If an edit introduces a type error, compilation failure, or breaks a cross-file contract, the file is **never modified**. The agent gets structured error feedback instead.

```
┌─────────────────────────────────────────────────────────────┐
│                      MCP Client (LLM)                       │
└─────────────────────┬───────────────────────────────────────┘
                      │ JSON-RPC (stdio)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                     index.ts (Entry)                        │
│              Tool registration + boot logic                 │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    router.ts (Facade)                       │
│          Dispatch + Context Heartbeat middleware             │
└────┬──────────┬────────────┬────────────────────────────────┘
     │          │            │
     ▼          ▼            ▼
┌─────────┐ ┌─────────┐ ┌──────────┐
│ code.ts │ │guard.ts │ │navigate.ts│   ← handlers/ (pure)
└────┬────┘ └─────────┘ └──────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│                 NrekiKernel (kernel/)                        │
│        VFS · ACID Transactions · Auto-Healing               │
│        TypeScript Compiler · LSP Sidecars                   │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│               NrekiEngine (engine.ts)                       │
│      Indexing · Embeddings · T-RAG Search · Repo Map        │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│                NrekiDB (database.ts)                         │
│        SQLite (WASM) · VectorIndex · KeywordIndex           │
└─────────────────────────────────────────────────────────────┘
```

---

## Module DAG

The codebase follows a strict **Directed Acyclic Graph** — no circular imports.

### Layer 0: Entry
| Module | Purpose |
|--------|---------|
| `index.ts` | MCP server bootstrap, tool registration, kernel/engine initialization |

### Layer 1: Routing
| Module | Purpose |
|--------|---------|
| `router.ts` | Tool dispatch facade, context heartbeat injection for prompt cache survival |

### Layer 2: Handlers (Pure Functions)
| Module | Purpose |
|--------|---------|
| `handlers/code.ts` | `read`, `compress`, `edit`, `batch_edit` — the core code operations |
| `handlers/guard.ts` | `pin`, `unpin`, `status`, `audit`, `clear_pins` — safety and observability |
| `handlers/navigate.ts` | `go_to_definition`, `find_references`, `search` — code navigation |

### Layer 3: Core Modules
| Module | Purpose | Lines |
|--------|---------|-------|
| `engine.ts` | File indexing, Merkle diffing, T-RAG hybrid search, dependency graph | ~844 |
| `semantic-edit.ts` | AST-targeted byte-index splicing, ACID batch edits | ~728 |
| `compressor.ts` | 3-stage code compression (preprocess → token filter → AST strip) | ~800 |
| `repo-map.ts` | Deterministic repo map with PageRank tiering for prompt caching | ~709 |
| `circuit-breaker.ts` | Loop detection: error hash, file modification, write-test-fail patterns | ~448 |
| `chronos-memory.ts` | Technical debt tracking, file fragility (CFI scores), regression ledger | ~331 |
| `monitor.ts` | Token budget tracking, burn rate prediction, budget alerts | ~360 |
| `terminal-filter.ts` | ANSI stripping, output deduplication, noise reduction | ~312 |
| `parser.ts` | Universal Tree-sitter parser, code → compressed chunk conversion | ~425 |
| `ast-navigator.ts` | Deterministic go-to-definition and find-references via AST | ~338 |
| `ast-sandbox.ts` | Pre-write syntax validation — rejects broken code before it reaches disk | ~334 |
| `pin-memory.ts` | Persistent pinned rules that survive context compaction | ~203 |
| `embedder.ts` | Local embedding engine (Xenova/transformers) with model fallback | ~237 |
| `undo.ts` | One-shot backup/restore for rollback support | ~86 |

### Layer 4: Kernel
| Module | Purpose | Lines |
|--------|---------|-------|
| `kernel/nreki-kernel.ts` | **The core.** VFS, ACID transactions, TypeScript integration, auto-healing | ~1521 |
| `kernel/spectral-topology.ts` | Spectral graph analysis for architectural health auditing | ~497 |
| `kernel/backends/ts-compiler-wrapper.ts` | TypeScript compiler via Strada pattern (Builder → LS → CompilerHost) | ~695 |
| `kernel/backends/lsp-sidecar-base.ts` | JSON-RPC 2.0 LSP client for Go/Python sidecars | ~464 |
| `kernel/backends/go-sidecar.ts` | gopls integration | ~30 |
| `kernel/backends/python-sidecar.ts` | pyright integration | ~30 |

### Layer 5: Hologram (Large Project Optimization)
| Module | Purpose |
|--------|---------|
| `hologram/shadow-generator.ts` | Generates `.d.ts` shadows for pruned files — O(M) instead of O(N) | 
| `hologram/shadow-cache.ts` | LRU cache for shadow declarations |
| `hologram/harvester.ts` | Extracts public API surface from full source files |

### Layer 6: Infrastructure
| Module | Purpose |
|--------|---------|
| `database.ts` | SQLite (sql.js WASM), custom VectorIndex with cosine similarity, BM25 KeywordIndex |
| `parser-pool.ts` | Thread-safe parser pool with backpressure for web-tree-sitter |
| `middleware/circuit-breaker.ts` | 3-level escalation middleware (Rewrite → Decompose → Hard Stop) |
| `middleware/file-lock.ts` | Synchronous file mutex with immediate rejection (no queuing) |
| `middleware/validator.ts` | Pre-write AST validation wrapper |
| `hooks/preToolUse.ts` | Large file interception, suggests compression to save tokens |
| `utils/*` | Path jail, logger, BOM stripping, POSIX normalization, Porter stemmer |

---

## ACID Transaction Lifecycle

Every code edit follows this exact flow:

```
Agent sends edit
       │
       ▼
┌──────────────────┐
│  1. PATH JAIL    │  ← Path traversal + symlink + sensitive file check
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│  2. FILE LOCK    │  ← Mutex: reject if another edit is in progress
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│  3. AST SANDBOX  │  ← Layer 1: Parse with Tree-sitter, reject if syntax errors
│     (Layer 1)    │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│  4. SEMANTIC     │  ← Byte-index AST splicing (no regex, no line numbers)
│     EDIT         │
└──────┬───────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│  5. KERNEL INTERCEPT (Layer 2)                   │
│                                                  │
│  a. Inject proposed content into VFS (RAM only)  │
│  b. Run TypeScript compiler against VFS          │
│  c. Compare error fingerprints vs baseline       │
│  d. If new errors:                               │
│     → Rollback VFS                               │
│     → Return structured errors                   │
│     → DISK UNTOUCHED                             │
│  e. If safe:                                     │
│     → Auto-heal cascading breaks if possible     │
│     → Commit to disk (two-phase atomic write)    │
└──────────────────────────────────────────────────┘
```

### Two-Phase Atomic Commit (`commitToDisk`)

```
PHASE 1: Backup
  For each mutated file:
    Copy original → .nreki/transactions/<random>.bak

PHASE 2: Write
  For each mutated file:
    Write new content → <file>.nreki-<random>.tmp
    Atomic rename tmp → file
    (If rename fails: tmp is cleaned as orphan)

PHASE 3: Cleanup
  Delete all .bak files
  Rebuild TypeScript program from disk
  Clear VFS (force fresh reads)

ON FAILURE:
  Restore all .bak → original paths
  Clear VFS + force cold rebuild
  Clean orphan .tmp files
```

---

## Security Model

Defense-in-depth with 5 independent layers:

### 1. Path Jail (`utils/path-jail.ts`)
- **Traversal protection:** Blocks `../` sequences that resolve outside workspace
- **NFC normalization:** Prevents Unicode bypass (macOS NFD vs Linux NFC)
- **Symlink resolution:** Detects symlinks that escape the workspace boundary
- **Parent chain walk:** For new files, validates the existing parent directory chain
- **Workspace root guard:** Cannot operate on the root directory itself

### 2. Sensitive File Blocklist
22 patterns blocking access to:
```
.env*  .ssh/  .gnupg/  .aws/  id_rsa  id_ed25519  .pem
.key  .npmrc  .pypirc  .git/credentials  .git/config
.docker/config.json  credentials.json  .netrc  .htpasswd
.git-credentials  .kube/config  .age  vault-token  .terraform/
```

### 3. AST Sandbox (`ast-sandbox.ts`)
- Parses code with Tree-sitter before any write
- Walks AST for ERROR and MISSING nodes
- Catches trailing EOF errors (edge case fix)
- Stack overflow guard (depth > 500)
- Reports exact line/column with fix suggestions

### 4. Circuit Breaker (`circuit-breaker.ts`)
Detects 4 failure patterns:
1. **Error Hash:** Same error repeated 3+ times
2. **File Modification:** Same file edited 5+ times without progress
3. **Write-Test-Fail:** Edit → test → fail → edit cycle
4. **Per-File Failure:** Single file accumulating failures

3-level escalation: Rewrite → Decompose → Hard Stop

Handler exceptions (ENOENT, timeouts, etc.) are caught by the wrapper and converted to error responses, ensuring the breaker always records failures.

### 5. File Lock (`middleware/file-lock.ts`)
- Per-file synchronous mutex
- Immediate rejection (not queued) to prevent deadlock
- Prevents concurrent edits to the same file
- Case-insensitive lock keys on Windows and macOS (NTFS and APFS default)

---

## Performance Modes

Nreki auto-selects based on project size:

| Mode | Files | Strategy |
|------|-------|----------|
| `syntax` | Any | AST-only validation (Layer 1). No TypeScript compiler. |
| `file` | < 100 | Single-file type checking. Fast, limited cross-file. |
| `project` | < 500 | Full project type checking. Complete cross-file semantics. |
| `hologram` | 500+ | Shadow `.d.ts` generation. Only edited files + API surfaces loaded. |

### Hologram Mode (Large Projects)
For projects with 500+ TypeScript files, loading the full compiler is too expensive. Hologram mode:

1. **Prunes** non-edited files from the compiler program
2. **Generates** lightweight `.d.ts` shadow declarations for pruned files
3. **Preserves** the public API surface so cross-file type checking still works
4. **JIT baseline** — captures error state only for target files, not the whole project

This reduces compiler load from O(N) to O(M) where M = edited files + direct dependents.

---

## Search: T-RAG (Topology-Aware RAG)

Nreki's search combines three signals:

1. **Vector similarity** — cosine distance on local embeddings (Xenova/transformers)
2. **BM25 keyword** — code-aware tokenization with Porter stemming
3. **Topological re-ranking** — boosts results by dependency graph metrics:
   - `inDegree`: How many files import this symbol
   - `blastRadius`: How many files would break if this symbol changes
   - `pageRank`: Structural importance in the dependency DAG

Results are fused via **Reciprocal Rank Fusion (RRF)** with k=10.

---

## Persistence

### SQLite (sql.js WASM)
- **Zero native dependencies** — no `node-gyp`, no compilation, works everywhere
- Stores: file metadata, Merkle hashes, chunk text, search indexes
- Deep-copy isolation between WASM memory and Node.js to prevent SharedArrayBuffer corruption

### Custom Indexes (in-memory)
- **VectorIndex:** Float32 cosine similarity with binary `.vec` serialization
- **KeywordIndex:** BM25 with code-aware tokenization (camelCase/snake_case splitting, stopword filtering)
- Both serialize to SQLite BLOBs for persistence across sessions

---

## Key Design Decisions

### 1. Zero Native Dependencies
All heavy computation uses WASM:
- `sql.js` instead of `better-sqlite3` (no node-gyp)
- `web-tree-sitter` instead of native tree-sitter bindings
- `@xenova/transformers` for local embeddings (ONNX runtime)

**Why:** npm install with zero compilation. Works on Windows, macOS, Linux without toolchain setup.

### 2. Strangler Fig Pattern (TypeScript Backend)
The TypeScript compiler integration uses the "Strada" pattern:
- `SolutionBuilder` for incremental builds
- `LanguageService` for diagnostics and code fixes
- `CompilerHost` overrides for VFS integration

The kernel doesn't import TypeScript APIs directly — everything goes through `TsCompilerWrapper`, allowing future backend swaps (e.g., SWC, OXC) without kernel changes.

### 3. stderr-only Logging
MCP requires `stdout` to be exclusively JSON-RPC. All diagnostic output goes through `process.stderr.write()`. Timestamps in `HH:MM:SS.mmm` format for production debugging.

### 4. Prompt Cache Optimization
The Context Heartbeat (`router.ts`) injects session state into tool responses **after** the original static content for all actions. This preserves Anthropic's prefix cache since the dynamic heartbeat payload never invalidates the hash of the static prefix. The repo map (`repo-map.ts`) uses deterministic ordering so that repeated calls produce identical prefixes, maximizing cache hit rates.

---

## Architectural Health Audit

Nreki can audit its own host project via `nreki_guard action:"audit"`. The audit computes:

- **Architecture Health Index (AHI):** Composite score from 6 sub-signals
- **Spectral Integrity:** Fiedler value (algebraic connectivity) of the dependency graph
- **Bus Factor:** How many developers have touched critical files
- **Type Safety:** Percentage of symbols with strict (non-toxic) types
- **Stability:** Change frequency vs error frequency correlation
- **Topological Entropy:** Shannon entropy of the eigenvector components

The spectral analysis uses power iteration with:
- Gram-Schmidt orthogonalization for eigenvalue deflation
- Gauge fixing (phase canonicalization) for deterministic eigenvectors
- Dual convergence criterion (eigenvalue + eigenvector stability)
- Divergence guard to prevent runaway iteration

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `NREKI_DEBUG` | unset | Enable debug-level logging to stderr |
| `NREKI_MODE` | `auto` | Force performance mode: `syntax`, `file`, `project`, `hologram` |

---

## Testing

- **Framework:** Vitest with `pool: "forks"` (process isolation for WASM memory)
- **Coverage:** 704 tests across 43 test files (v7.1.2)
- **Timeout:** 30s per test (WASM initialization can be slow on cold start)
- **Strategy:** Functional tests that exercise the full pipeline, not mocks

```bash
npm test          # Run all tests
npm run test:watch # Watch mode
```

---

## Building

```bash
npm run build     # TypeScript compilation → dist/
npm start         # Run compiled MCP server
npm run dev       # Run with tsx (development)
```

The MCP server communicates via stdio (stdin/stdout JSON-RPC). Configure in your MCP client:

```json
{
  "mcpServers": {
    "nreki": {
      "command": "node",
      "args": ["path/to/nreki/dist/index.js"]
    }
  }
}
```
