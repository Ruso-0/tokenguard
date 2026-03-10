# How I got tired of Claude Pro limits burning out in 2 hours, so I built a defensive context manager that cuts token costs by 91%

<p align="center">
  <img src="https://img.shields.io/badge/MCP-Plugin-blue?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0wIDE4Yy00LjQyIDAtOC0zLjU4LTgtOHMzLjU4LTggOC04IDggMy41OCA4IDgtMy41OCA0LTggOHoiLz48L3N2Zz4=" alt="MCP Plugin">
  <img src="https://img.shields.io/badge/Tools-16-blue?style=for-the-badge" alt="16 Tools">
  <img src="https://img.shields.io/badge/Token%20Savings-91%25-green?style=for-the-badge" alt="91% Savings">
  <img src="https://img.shields.io/badge/Tests-335%20passed-brightgreen?style=for-the-badge" alt="335 Tests">
  <img src="https://img.shields.io/badge/Cloud-Zero-red?style=for-the-badge" alt="Zero Cloud">
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="MIT License">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=for-the-badge&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-≥20-339933?style=for-the-badge&logo=node.js" alt="Node.js">
</p>

<p align="center">
  <b>16 MCP tools. 335 tests. AST sandbox. Circuit breaker. Surgical edit. Pin memory. Undo. All running locally.</b>
</p>

<p align="center">
  <img src="https://placehold.co/800x400/1a1a2e/16e0bd?text=TokenGuard+v2.1+Demo&font=montserrat" alt="TokenGuard Demo" width="800">
</p>

---

### Real-World Validation
Tested against a 57-file production Next.js + Supabase app (SICAEP):
- **94.1% token reduction** (tier 1 compression)
- **10,532 tokens saved** on a single search query
- **335/335 tests passed** (305 unit + 30 integration)
- Surgically fixed a real `.single()` → `.maybeSingle()` bug via `tg_semantic_edit`
- Circuit breaker correctly detected repeated error patterns
- Path traversal attack (`../../../../etc/passwd`) → **BLOCKED**

---

## The Problem

You're 90 minutes into a Claude Pro session. You've been exploring a codebase, reading files, running grep searches. Suddenly: **context limit reached**. Your session is over. Your work is lost.

**Why?** Because every `grep` reads entire files. Every `Read` dumps thousands of tokens into context. Every broken code write triggers a fix-retry loop. After 20+ messages, Claude forgets the rules you set at the start. You're burning tokens like it's 2023.

## The Solution

TokenGuard is a **defensive context manager** with 16 MCP tools that sit between you and token waste:

| What You Do Now | What TokenGuard Does | Savings |
|---|---|---|
| `grep "auth" ./src` reads 50 files | `tg_search("authentication")` returns 5 relevant chunks | **97%** |
| `Read src/engine.ts` dumps 5,502 tokens | `tg_compress --level medium` sends 1,753 tokens | **68%** |
| Read file + skim for function | `tg_def "TokenGuardEngine"` jumps straight to definition | **300x faster** |
| Copy-paste 500 lines of npm errors | `tg_terminal` extracts the 3 actual errors | **89%** |
| Write broken code, see error, retry, burn tokens | `tg_validate` catches syntax errors before disk write | **Prevents loop** |
| Rewrite entire file to change one function | `tg_semantic_edit` patches only the AST node | **98% output saved** |
| Claude gets stuck in write-test-fail loops | `tg_circuit_breaker` detects and stops doom loops | **Saves session** |
| Claude forgets "always use fetch, not axios" | `tg_pin` keeps rules in every response | **Never forgotten** |
| Surgical edit went wrong, need to revert | `tg_undo` restores the pre-edit backup | **One command** |

## 3 Features Nobody Else Has

### 1. AST Sandbox (`tg_validate`)
Parses your code with tree-sitter *before* writing to disk. Catches missing commas, unclosed braces, and invalid syntax with exact line/column locations and fix suggestions. Prevents the expensive "write broken code -> see error -> retry" loop that burns thousands of tokens.

### 2. Circuit Breaker (`tg_circuit_breaker`)
Detects infinite failure loops: same error 3+ times, same file 5+ times, write-test-fail cycles. When tripped, it forces Claude to STOP and ask the human for guidance instead of burning through your remaining context with futile retries.

### 3. Surgical Edit (`tg_semantic_edit`)
Edits a single function/class/interface by name without reading or rewriting the entire file. Finds the exact AST node, replaces only those bytes, validates syntax before saving. Saves 98% of output tokens compared to full file rewrites.

## Session Receipt

Every `tg_session_report` generates an ASCII receipt showing exactly what TokenGuard saved:

```
+--------------------------------------------------+
|          TOKENGUARD SESSION RECEIPT               |
+--------------------------------------------------+
|  Input Tokens Saved:              12,847    |
|  Output Tokens Avoided:           34,291    |
|  Search Queries:                      23    |
|  Surgical Edits:                       7    |
|  Syntax Errors Blocked:               3    |
|  Doom Loops Prevented:                1    |
|  Pinned Rules Active:                 4    |
+--------------------------------------------------+
|  ESTIMATED SAVINGS:                $1.42    |
|  MODEL:                            Opus    |
|  TOOLS USED:                    23 calls    |
+--------------------------------------------------+
```

## Two-Layer Architecture

TokenGuard uses a cache-friendly two-layer design that exploits Anthropic's prompt caching ($0.30/M vs $3.00/M):

```
Layer 1: Static Context (cached at $0.30/M input tokens)
├── tg_map — deterministic repo map (identical output for same repo state)
├── tg_pin — pinned rules appended to every map response
├── File signatures, exports, imports
└── Place early in context -> Anthropic caches it automatically

Layer 2: Dynamic Context ($3.00/M but tiny per query)
├── tg_search -> semantic + keyword hybrid search
├── tg_def / tg_refs / tg_outline -> AST-precise navigation
├── tg_compress / tg_read -> compressed file content
├── tg_semantic_edit -> surgical AST patching
├── tg_undo -> revert last semantic edit
├── tg_validate -> syntax check before write
├── tg_circuit_breaker -> doom loop detection
└── tg_terminal -> filtered error output
```

## All 16 Tools

### Search & Navigation

| Tool | Description |
|---|---|
| **`tg_search`** | Hybrid semantic + BM25 keyword search. Uses jina-v2-small embeddings with RRF fusion. Returns compressed AST chunks, not raw text. |
| **`tg_def`** | Go-to-definition by symbol name. 100% precise AST lookup. Returns full source with signature. |
| **`tg_refs`** | Find all references to a symbol across the project. Like "Find All References" in VS Code. |
| **`tg_outline`** | List all symbols in a file with signatures and line ranges. Like the Outline view in VS Code. |
| **`tg_map`** | Static repo map with all file signatures. Deterministic and cache-friendly. Includes pinned rules. |

### Compression & Reading

| Tool | Description |
|---|---|
| **`tg_read`** | Drop-in replacement for Read. Auto-compresses files > 1KB. Three levels: light/medium/aggressive. |
| **`tg_compress`** | Full-control compression. LLMLingua-2-inspired 3-stage pipeline or classic tiers. Focus mode ranks by query. |
| **`tg_semantic_edit`** | Surgically edit a function/class by name. Replaces only the AST node bytes. Validates syntax before saving. 98% output token savings. |
| **`tg_undo`** | Undo the last `tg_semantic_edit` on a file. Restores from auto-backup. One-shot: backup is consumed after restore. |

### Validation & Safety

| Tool | Description |
|---|---|
| **`tg_validate`** | AST sandbox validator. Parses code with tree-sitter before disk write. Catches syntax errors with exact line/column and fix suggestions. |
| **`tg_terminal`** | Terminal entropy filter. Strips ANSI codes, deduplicates stack traces, extracts unique errors. |
| **`tg_circuit_breaker`** | Detects and stops infinite failure loops. Monitors for write-test-fail cycles. Forces human intervention when tripped. |

### Memory & Context

| Tool | Description |
|---|---|
| **`tg_pin`** | Pin important rules Claude should never forget. Injected into every `tg_map` response. Max 10 pins, 200 chars each. Persisted to disk. |

### Monitoring & Reporting

| Tool | Description |
|---|---|
| **`tg_status`** | Burn rate, exhaustion prediction, and alert levels (info/warning/critical). |
| **`tg_audit`** | Token consumption audit with per-tool breakdown and cost estimation. |
| **`tg_session_report`** | Comprehensive savings report with ASCII receipt: tokens saved, USD saved, per-file-type breakdown, model recommendations. |

## Comparison

| Feature | TokenGuard | GrepAI | Claude Context | Aider |
|---|:---:|:---:|:---:|:---:|
| MCP tools | 16 | ~3 | 4 | N/A |
| Tests | 305 | ~20 | ~50 | ~200 |
| AST sandbox | Yes | No | No | No |
| Circuit breaker | Yes | No | No | No |
| Surgical edit | Yes | No | No | No |
| Terminal filter | Yes | No | No | No |
| Pin memory | Yes | No | No | No |
| Zero cloud | Yes | No | No | Yes |
| Semantic search | RRF hybrid | Vector only | N/A | Vector only |
| AST compression | 3 levels + 3 tiers | N/A | N/A | N/A |
| Static repo map | Cache-friendly ($0.30/M) | N/A | N/A | Repo map |
| Local embeddings | jina-v2-small (ONNX) | Cloud | N/A | Ollama |
| Tree-sitter AST | TS, JS, Python, Go | N/A | N/A | Limited |

## Installation

```bash
# One command — runs directly from GitHub:
npx github:Ruso-0/TokenGuard
```

Or install globally:

```bash
npm install -g @ruso-0/tokenguard
npx @ruso-0/tokenguard
```

### Claude Code Configuration

**Option A — CLI (recommended):**

```bash
claude mcp add tokenguard -- npx @ruso-0/tokenguard
```

**Option B — Manual config** in `.claude.json` or `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tokenguard": {
      "command": "npx",
      "args": ["-y", "@ruso-0/tokenguard"]
    }
  }
}
```

## Quick Start

```bash
# TokenGuard runs as an MCP server — just use the tools:

# 1. Pin your project rules (they'll never be forgotten)
tg_pin --action add --text "Always use fetch, not axios"
tg_pin --action add --text "API base URL is /api/v2"

# 2. Get the repo map (cached by Anthropic prompt cache, includes pinned rules)
tg_map

# 3. Search semantically (replaces grep)
tg_search "authentication middleware"

# 4. Jump to a definition (replaces Read + Ctrl+F)
tg_def "AuthService"

# 5. Surgically edit a function (no file rewrite needed)
tg_semantic_edit --file src/auth.ts --symbol "validateToken" --new_code "..."

# 6. Validate code before writing
tg_validate --code "const x = { a: 1 b: 2 }" --language typescript

# 7. Filter noisy terminal output
tg_terminal <paste error output>

# 8. Check if you're stuck in a loop
tg_circuit_breaker --last_error "..." --action check

# 9. Full session report with receipt
tg_session_report
```

## Stress Tested

**305 tests. 0 failures. 11 test suites.**

| Scenario | What We Tested | Result |
|---|---|---|
| Empty files | 0-byte input through every pipeline stage | Pass |
| 500KB TypeScript | ~3,500 generated functions | Pass |
| Binary data | Random bytes, null bytes, non-UTF-8 | Pass |
| Unicode / CJK / Emoji | Japanese identifiers, emoji in strings | Pass |
| Minified 50KB JS | Single-line, no whitespace, 2000 functions | Pass |
| 100% comments | Files with zero actual code | Pass |
| 20-level nesting | Deeply nested function chains | Pass |
| 50-file concurrent batch | Batch insert + hybrid search | Pass |
| Malformed syntax | Missing names, unclosed braces, invalid tokens | Pass |
| 100x re-indexing | Idempotent clear-insert-upsert cycles | Pass |
| AST validation | Valid/invalid code across 4 languages | Pass |
| 1000-line files | Single error detection in <200ms | Pass |
| Surgical edits | Symbol replacement with syntax validation | Pass |
| Circuit breaker | Loop detection across error patterns | Pass |
| Pin memory | Add/remove/persist/limits/deterministic output | Pass |

> **Note:** TokenGuard is most effective on projects with 50+ files. For very small projects (<20 files), the overhead may not justify the savings.

## Security

- **Zero cloud**: All processing is local. No API keys, no telemetry, no network calls.
- **No data leaves your machine**: Embeddings computed locally via ONNX Runtime.
- **Path traversal protection**: All file paths validated with `safePath()`.
- **SQLite storage**: Your code index stays in `.tokenguard.db` in your project root.
- **WASM memory safety**: All tree-sitter parsing wrapped in `safeParse()` with guaranteed cleanup.
- **MIT licensed**: Fully open source, audit the code yourself.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Claude Code (MCP Client)                    │
└────────────────────────┬────────────────────────────────────┘
                         │ stdio
┌────────────────────────▼────────────────────────────────────┐
│                TokenGuard MCP Server (16 tools)              │
│                                                              │
│  Layer 1: Static Context (prompt-cacheable)                  │
│  ┌───────────────────────────────────────────────────────┐   │
│  │  tg_map — deterministic repo map                      │   │
│  │  tg_pin — pinned rules (prepended to every map)       │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  Layer 2: Dynamic Context                                    │
│  ┌──────────┬──────────┬──────────┬───────────┬──────────┐  │
│  │tg_search │tg_def    │tg_read   │tg_validate│tg_status │  │
│  │tg_compress│tg_refs  │tg_terminal│tg_audit  │tg_report │  │
│  │tg_sem_ed │tg_outline│tg_circuit│tg_pin    │tg_undo   │  │
│  └────┬─────┴────┬─────┴────┬─────┴─────┬─────┴────┬─────┘  │
│       │          │          │           │          │         │
│  ┌────▼──────────▼──────────▼───────────▼──────────▼─────┐  │
│  │                    Core Layer                          │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │  │
│  │  │ Embedder │ │  Parser  │ │ Database │ │ Sandbox  │ │  │
│  │  │(jina v2) │ │(TreeSit.)│ │ (SQLite) │ │(Validate)│ │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Contributing

PRs welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting.

```bash
# Development
git clone https://github.com/Ruso-0/TokenGuard.git
cd tokenguard
npm install
npm run build
npm test
```

## License

MIT

---

<p align="center">
  <b>Stop burning tokens. Start guarding them.</b><br>
  <sub>Built with frustration, shipped with hope.</sub>
</p>
