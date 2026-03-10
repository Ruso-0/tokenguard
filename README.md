# How I got tired of Claude Pro limits burning out in 2 hours, so I built a defensive context manager that cuts token costs by 91%

<p align="center">
  <img src="https://img.shields.io/badge/MCP-Plugin-blue?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0wIDE4Yy00LjQyIDAtOC0zLjU4LTgtOHMzLjU4LTggOC04IDggMy41OCA4IDgtMy41OCA4LTggOHoiLz48L3N2Zz4=" alt="MCP Plugin">
  <img src="https://img.shields.io/badge/Tools-12-blue?style=for-the-badge" alt="12 Tools">
  <img src="https://img.shields.io/badge/Token%20Savings-91%25-green?style=for-the-badge" alt="91% Savings">
  <img src="https://img.shields.io/badge/Tests-194%20passed-brightgreen?style=for-the-badge" alt="194 Tests">
  <img src="https://img.shields.io/badge/Cloud-Zero-red?style=for-the-badge" alt="Zero Cloud">
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="MIT License">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=for-the-badge&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-≥20-339933?style=for-the-badge&logo=node.js" alt="Node.js">
</p>

<p align="center">
  <b>12 MCP tools. 194 tests. Code-aware search. Cache-friendly architecture. AST sandbox. All running locally.</b>
</p>

<p align="center">
  <img src="https://placehold.co/800x400/1a1a2e/16e0bd?text=TokenGuard+v2.0+Demo&font=montserrat" alt="TokenGuard Demo" width="800">
</p>

---

## The Problem

You're 90 minutes into a Claude Pro session. You've been exploring a codebase, reading files, running grep searches. Suddenly: **context limit reached**. Your session is over. Your work is lost.

**Why?** Because every `grep` reads entire files. Every `Read` dumps thousands of tokens into context. Every broken code write triggers a fix-retry loop. You're burning tokens like it's 2023.

## The Solution

TokenGuard is a **defensive context manager** with 12 MCP tools that sit between you and token waste:

| What You Do Now | What TokenGuard Does | Savings |
|---|---|---|
| `grep "auth" ./src` reads 50 files | `tg_search("authentication")` returns 5 relevant chunks | **97%** |
| `Read src/engine.ts` dumps 5,502 tokens | `tg_compress --level medium` sends 1,753 tokens | **68%** |
| Read file + skim for function | `tg_def "TokenGuardEngine"` jumps straight to definition | **300x faster** |
| Copy-paste 500 lines of npm errors | `tg_terminal` extracts the 3 actual errors | **89%** |
| Write broken code, see error, retry, burn tokens | `tg_validate` catches syntax errors before disk write | **Prevents loop** |
| No idea how many tokens left | `tg_status` shows burn rate + exhaustion prediction | **Proactive** |

## Two-Layer Architecture

TokenGuard uses a cache-friendly two-layer design that exploits Anthropic's prompt caching ($0.30/M vs $3.00/M):

```
Layer 1: Static Repo Map (tg_map)
├── Deterministic text — identical output for same repo state
├── Contains all file signatures, exports, imports
├── Place early in context → Anthropic caches it at $0.30/M
└── Acts as a mental map of the entire codebase

Layer 2: Dynamic Context (all other tools)
├── Only fetches what's needed per query
├── tg_search → semantic + keyword hybrid search
├── tg_def / tg_refs / tg_outline → AST-precise navigation
├── tg_compress / tg_read → compressed file content
├── tg_validate → syntax check before write
└── tg_terminal → filtered error output
```

## All 12 Tools

### Search & Navigation

| Tool | Description |
|---|---|
| **`tg_search`** | Hybrid semantic + BM25 keyword search. Uses jina-v2-small embeddings with RRF fusion. Returns compressed AST chunks, not raw text. |
| **`tg_def`** | Go-to-definition by symbol name. 100% precise AST lookup. Returns full source with signature. |
| **`tg_refs`** | Find all references to a symbol across the project. Like "Find All References" in VS Code. |
| **`tg_outline`** | List all symbols in a file with signatures and line ranges. Like the Outline view in VS Code. |
| **`tg_map`** | Static repo map with all file signatures. Deterministic and cache-friendly. Use first before reading any files. |

### Compression & Reading

| Tool | Description |
|---|---|
| **`tg_read`** | Drop-in replacement for Read. Auto-compresses files > 1KB. Three levels: light/medium/aggressive. |
| **`tg_compress`** | Full-control compression. LLMLingua-2-inspired 3-stage pipeline or classic tiers. Focus mode ranks by query. |

### Validation & Filtering

| Tool | Description |
|---|---|
| **`tg_validate`** | AST sandbox validator. Parses code with tree-sitter before disk write. Catches missing commas, unclosed braces, invalid syntax with exact line/column and fix suggestions. |
| **`tg_terminal`** | Terminal entropy filter. Strips ANSI codes, deduplicates stack traces, extracts unique errors. |

### Monitoring & Reporting

| Tool | Description |
|---|---|
| **`tg_status`** | Burn rate, exhaustion prediction, and alert levels (info/warning/critical). |
| **`tg_audit`** | Token consumption audit with per-tool breakdown and cost estimation. |
| **`tg_session_report`** | Comprehensive savings report: tokens saved, USD saved, per-file-type breakdown, model recommendations. |

## Self-Benchmark

TokenGuard benchmarked against its own source code (22 files, 25+ symbols per file):

| Tool | Metric | Result |
|---|---|---|
| **tg_map** | Repo map generation | 22 files, 4,677 tokens, 169ms |
| **tg_search** | "compression" query | 10 results in 16ms, top hits are compress methods |
| **tg_def** | "TokenGuardEngine" lookup | Found in src/engine.ts:L115-L566, 128ms |
| **tg_refs** | "safePath" references | 20 references across 5 files, 11ms |
| **tg_outline** | src/engine.ts symbols | 25 symbols listed in 7ms |
| **tg_compress** | src/engine.ts (5,502 tok) | Light: 4,028 (27%), Medium: 1,753 (68%), Aggressive: 2,018 (63%) |
| **tg_terminal** | 500-line error output | 11,967 → 1,276 tokens (89% reduction) |
| **tg_validate** | Valid TS / Invalid TS | valid=true / Detects error at line 1, col 23 |

### Compression Levels

| Level | Technique | Reduction | Best For |
|---|---|---|---|
| **Light** | Preprocessing (strip comments, console.log, debugger, whitespace) | **~27-50%** | Quick reads, preserving all logic |
| **Medium** | + Self-information token filtering + key body lines | **~68-75%** | Balanced (default for `tg_read`) |
| **Aggressive** | + AST structural compression (signatures only) | **~63-91%** | Maximum savings, exploration mode |

## Comparison

| Feature | TokenGuard | GrepAI | Claude Context | Aider |
|---|:---:|:---:|:---:|:---:|
| MCP tools | 12 | ~3 | N/A | N/A |
| Semantic search | RRF hybrid (BM25 + jina vectors) | Vector only | N/A | Vector only |
| AST compression | 3 levels + 3 tiers | N/A | N/A | N/A |
| Go-to-definition | AST-precise | N/A | N/A | N/A |
| Find references | Cross-project | N/A | N/A | N/A |
| File outline | VS Code-style | N/A | N/A | N/A |
| AST sandbox | Pre-write syntax validation | N/A | N/A | N/A |
| Terminal filter | 89% noise reduction | N/A | N/A | N/A |
| Token monitoring | Real-time burn rate + prediction | N/A | Basic | N/A |
| Static repo map | Cache-friendly ($0.30/M) | N/A | N/A | Repo map |
| Local embeddings | jina-v2-small (ONNX, 512-dim) | Cloud | N/A | Ollama |
| Tree-sitter AST | TS, JS, Python, Go | N/A | N/A | Limited |
| Zero cloud deps | Yes | No | N/A | No |
| Test suite | 194 tests | Unknown | N/A | Unknown |

## Installation

```bash
# One command. That's it.
npx tokenguard
```

Or install globally:

```bash
npm install -g tokenguard
```

### Claude Code Configuration

Add to your `claude_desktop_config.json` or `.claude/settings.json`:

```json
{
  "mcpServers": {
    "tokenguard": {
      "command": "npx",
      "args": ["-y", "tokenguard"]
    }
  }
}
```

## Quick Start

```bash
# TokenGuard runs as an MCP server — just use the tools:

# 1. Get the repo map first (cached by Anthropic prompt cache)
tg_map

# 2. Search semantically (replaces grep)
tg_search "authentication middleware"

# 3. Jump to a definition (replaces Read + Ctrl+F)
tg_def "AuthService"

# 4. Find all references
tg_refs "handleRequest"

# 5. Read files efficiently (auto-compresses)
tg_read src/engine.ts --level medium

# 6. Validate code before writing
tg_validate --code "const x = { a: 1 b: 2 }" --language typescript

# 7. Filter noisy terminal output
tg_terminal <paste error output>

# 8. Monitor your budget
tg_status

# 9. Full session report
tg_session_report
```

## Stress Tested

**194 tests. 0 failures. 8 test suites.**

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
│                TokenGuard MCP Server (12 tools)              │
│                                                              │
│  Layer 1: Static Context                                     │
│  ┌───────────────────────────────────────────────────────┐   │
│  │  tg_map — deterministic repo map (prompt-cacheable)   │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  Layer 2: Dynamic Context                                    │
│  ┌──────────┬──────────┬──────────┬───────────┬──────────┐  │
│  │tg_search │tg_def    │tg_read   │tg_validate│tg_status │  │
│  │tg_compress│tg_refs  │tg_terminal│tg_audit  │tg_report │  │
│  │          │tg_outline│          │           │          │  │
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
git clone https://github.com/YOUR_USERNAME/tokenguard.git
cd tokenguard
npm install
npm run build
npm test
```

## License

MIT © TokenGuard Contributors

---

<p align="center">
  <b>Stop burning tokens. Start guarding them.</b><br>
  <sub>Built with frustration, shipped with hope.</sub>
</p>
