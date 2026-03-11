# TokenGuard v3.0 — 3 Tools. 423 Tests. Zero Cloud. Instant Startup.

<p align="center">
  <img src="https://img.shields.io/badge/MCP-Plugin-blue?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0wIDE4Yy00LjQyIDAtOC0zLjU4LTgtOHMzLjU4LTggOC04IDggMy41OCA4IDgtMy41OCA0LTggOHoiLz48L3N2Zz4=" alt="MCP Plugin">
  <img src="https://img.shields.io/badge/Tools-3-blue?style=for-the-badge" alt="3 Tools">
  <img src="https://img.shields.io/badge/Token%20Savings-91%25-green?style=for-the-badge" alt="91% Savings">
  <img src="https://img.shields.io/badge/Tests-423%20passed-brightgreen?style=for-the-badge" alt="423 Tests">
  <img src="https://img.shields.io/badge/Cloud-Zero-red?style=for-the-badge" alt="Zero Cloud">
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="MIT License">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=for-the-badge&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-≥20-339933?style=for-the-badge&logo=node.js" alt="Node.js">
</p>

<p align="center">
  <b>3 router tools. Invisible middleware. Lite mode (instant) or Pro mode (semantic). All local.</b>
</p>

---

### What Changed in v3.0

TokenGuard v2 had 16 tools. That meant **~3,520 tokens of fixed overhead** just for tool definitions, plus wasted output tokens as the LLM reasoned about which of 16 tools to call. For small/medium projects, TokenGuard was **net-negative**.

v3.0 fixes this by collapsing 16 tools into 3 routers and moving validation/safety into invisible middleware:

| v2 (16 tools) | v3 (3 tools) | What Changed |
|---|---|---|
| `tg_search`, `tg_def`, `tg_refs`, `tg_outline`, `tg_map` | **`tg_navigate`** | One router, `action` parameter selects behavior |
| `tg_read`, `tg_compress`, `tg_semantic_edit`, `tg_undo`, `tg_terminal` | **`tg_code`** | Edits auto-validated via AST before disk write |
| `tg_pin`, `tg_status`, `tg_session_report` | **`tg_guard`** | Safety + monitoring unified |
| `tg_validate` | *invisible middleware* | Runs automatically inside `tg_code edit` |
| `tg_circuit_breaker` | *invisible middleware* | Monitors all calls, auto-resets on diversity |
| `tg_audit` | *CLI only* | Removed from MCP, available via `npx @ruso-0/tokenguard --audit` |

**Result:** ~660 tokens of tool definitions instead of ~3,520. **81% reduction in fixed overhead.**

### Lite Mode vs Pro Mode

| | Lite (Default) | Pro (Opt-in) |
|---|---|---|
| **Startup** | Instant (~100ms) | ~5-10s (ONNX model load) |
| **Search** | BM25 keyword search | Hybrid semantic + BM25 with RRF |
| **Dependencies** | Tree-sitter only | Tree-sitter + ONNX Runtime |
| **Enable** | Default | `--enable-embeddings` flag |

Lite mode is perfect for most projects. Pro mode adds semantic understanding for large codebases.

---

## The Problem

You're 90 minutes into a Claude Pro session. You've been exploring a codebase, reading files, running grep searches. Suddenly: **context limit reached**. Your session is over.

**Why?** Because every `grep` reads entire files. Every `Read` dumps thousands of tokens. Every broken code write causes a fix-retry loop that burns your remaining context.

## The Solution

TokenGuard sits between you and token waste with 3 smart tools:

| What You Do Now | What TokenGuard Does | Savings |
|---|---|---|
| `grep "auth" ./src` reads 50 files | `tg_navigate action:"search" query:"authentication"` returns 5 relevant chunks | **97%** |
| `Read src/engine.ts` dumps 5,502 tokens | `tg_code action:"compress" path:"src/engine.ts"` sends 1,753 tokens | **68%** |
| Read file + skim for function | `tg_navigate action:"definition" symbol:"AuthService"` jumps straight there | **300x faster** |
| Copy-paste 500 lines of npm errors | `tg_code action:"filter_output"` extracts the 3 actual errors | **89%** |
| Rewrite entire file to change one function | `tg_code action:"edit"` patches only the AST node | **98% output saved** |
| Write broken code → see error → retry loop | Automatic AST validation blocks bad writes before disk | **Prevents loop** |
| Claude gets stuck in write-test-fail loops | Circuit breaker auto-detects and stops doom loops | **Saves session** |
| Claude forgets "always use fetch, not axios" | `tg_guard action:"pin"` keeps rules in every response | **Never forgotten** |

## The 3 Tools

### `tg_navigate` — Search & Navigate

| Action | Description |
|---|---|
| `search` | Hybrid semantic + BM25 search (Pro) or keyword search (Lite). Returns compressed AST chunks. |
| `definition` | Go-to-definition by symbol name. 100% precise AST lookup. |
| `references` | Find all references to a symbol across the project. |
| `outline` | List all symbols in a file with signatures and line ranges. |
| `map` | Static repo map with pinned rules. Deterministic and prompt-cache-friendly. |

### `tg_code` — Read, Compress & Edit

| Action | Description |
|---|---|
| `read` | Smart file reader with optional auto-compression for large files. |
| `compress` | Full-control compression. 3 levels (light/medium/aggressive) or 6 tiers. |
| `edit` | Surgically edit a function/class by name. **Auto-validated via AST before write.** |
| `undo` | Revert the last edit. One-shot backup restore. |
| `filter_output` | Filter noisy terminal output. Strips ANSI, deduplicates, extracts errors. |

### `tg_guard` — Safety & Memory

| Action | Description |
|---|---|
| `pin` | Pin a rule Claude should never forget. Injected into every map response. |
| `unpin` | Remove a pinned rule. |
| `status` | Token burn rate, exhaustion prediction, and alert levels. |
| `report` | Full session savings receipt with USD estimates. |

## Invisible Middleware

These run automatically — you never call them directly:

- **AST Validation**: Every `tg_code action:"edit"` validates syntax via tree-sitter before writing to disk. Invalid code is blocked with exact line/column error details and fix suggestions.
- **Circuit Breaker**: Monitors all tool calls for destructive patterns (same error 3x, same file 5x, write-test-fail cycles). Auto-resets when you switch actions or after 60s idle.

## Installation

```bash
# One command — runs directly from npm:
npx @ruso-0/tokenguard
```

Or install globally:

```bash
npm install -g @ruso-0/tokenguard
```

### Claude Code Configuration

**Option A — CLI (recommended):**

```bash
# Lite mode (instant startup, keyword search):
claude mcp add tokenguard -- npx @ruso-0/tokenguard

# Pro mode (semantic search, requires ONNX model download on first run):
claude mcp add tokenguard -- npx @ruso-0/tokenguard --enable-embeddings
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

For Pro mode, add `"--enable-embeddings"` to the args array.

## Quick Start

```bash
# TokenGuard runs as an MCP server — just use the tools:

# 1. Pin your project rules (they'll never be forgotten)
tg_guard action:"pin" text:"Always use fetch, not axios"
tg_guard action:"pin" text:"API base URL is /api/v2"

# 2. Get the repo map (cached by Anthropic prompt cache, includes pinned rules)
tg_navigate action:"map"

# 3. Search semantically (replaces grep)
tg_navigate action:"search" query:"authentication middleware"

# 4. Jump to a definition (replaces Read + Ctrl+F)
tg_navigate action:"definition" symbol:"AuthService"

# 5. Surgically edit a function (auto-validated, no file rewrite needed)
tg_code action:"edit" path:"src/auth.ts" symbol:"validateToken" new_code:"..."

# 6. Filter noisy terminal output
tg_code action:"filter_output" output:"<paste error output>"

# 7. Full session report with receipt
tg_guard action:"report"
```

## Architecture

```
+-------------------------------------------------------------+
|                  Claude Code (MCP Client)                    |
+----------------------------+--------------------------------+
                             | stdio (JSON-RPC)
+----------------------------v--------------------------------+
|          TokenGuard MCP Server (3 router tools)              |
|                                                              |
|  +--------------------------------------------------------+  |
|  |  Middleware Layer (invisible)                            |  |
|  |  +------------------+ +---------------------+          |  |
|  |  | AST Validator    | | Circuit Breaker     |          |  |
|  |  | (pre-edit check) | | (loop detection)    |          |  |
|  |  +------------------+ +---------------------+          |  |
|  +--------------------------------------------------------+  |
|                                                              |
|  +------------------+------------------+------------------+  |
|  | tg_navigate      | tg_code          | tg_guard         |  |
|  | search           | read             | pin / unpin      |  |
|  | definition       | compress         | status           |  |
|  | references       | edit (validated) | report           |  |
|  | outline          | undo             |                  |  |
|  | map              | filter_output    |                  |  |
|  +--------+---------+--------+---------+--------+---------+  |
|           |                  |                  |            |
|  +--------v------------------v------------------v---------+  |
|  |                    Core Layer                           |  |
|  |  +----------+ +----------+ +----------+ +----------+  |  |
|  |  | Embedder | |  Parser  | | Database | | Sandbox  |  |  |
|  |  |(jina v2) | |(TreeSit.)| | (SQLite) | |(Validate)|  |  |
|  |  +----------+ +----------+ +----------+ +----------+  |  |
|  +---------------------------------------------------------+  |
+--------------------------------------------------------------+
```

## Stress Tested

**423 tests. 0 failures. 16 test suites.**

| Scenario | What We Tested | Result |
|---|---|---|
| Router dispatch | All 14 {tool, action} combinations | Pass |
| Middleware wrap | Circuit breaker auto-trip and auto-reset | Pass |
| AST validation | Valid/invalid code, error formatting | Pass |
| Backward compat | All 16 original tool behaviors preserved | Pass |
| Empty files | 0-byte input through every pipeline stage | Pass |
| 500KB TypeScript | ~3,500 generated functions | Pass |
| Binary data | Random bytes, null bytes, non-UTF-8 | Pass |
| Unicode / CJK / Emoji | Japanese identifiers, emoji in strings | Pass |
| Minified 50KB JS | Single-line, no whitespace, 2000 functions | Pass |
| 20-level nesting | Deeply nested function chains | Pass |
| 50-file concurrent batch | Batch insert + hybrid search | Pass |
| Surgical edits | Symbol replacement with syntax validation | Pass |
| Pin memory | Add/remove/persist/limits/deterministic output | Pass |

### Real-World Validation
Tested against a 57-file production Next.js + Supabase app (SICAEP):
- **94.1% token reduction** (tier 1 compression)
- **10,532 tokens saved** on a single search query
- **423/423 tests passed** (305 unit + 118 new for v3)
- Surgically fixed a real `.single()` → `.maybeSingle()` bug via `tg_code action:"edit"`
- Circuit breaker correctly detected repeated error patterns
- Path traversal attack (`../../../../etc/passwd`) → **BLOCKED**

> **Note:** TokenGuard is most effective on projects with 50+ files. For very small projects (<20 files), the overhead may not justify the savings.

## Security

- **Zero cloud**: All processing is local. No API keys, no telemetry, no network calls.
- **No data leaves your machine**: Embeddings computed locally via ONNX Runtime.
- **Path traversal protection**: All file paths validated with `safePath()`.
- **Symlink resolution**: All file paths resolved via `realpathSync()` to prevent symlink escapes.
- **Sensitive file blocklist**: `.env`, `.ssh`, `.git/credentials`, `.pem`, `.key` files are blocked automatically.
- **Pin sanitization**: Pinned rules are sanitized to block URLs, shell commands, and path traversal.
- **File-level mutex**: Concurrent edits to the same file are blocked to prevent corruption.
- **SQLite storage**: Your code index stays in `.tokenguard.db` in your project root.
- **WASM memory safety**: All tree-sitter parsing wrapped in `safeParse()` with guaranteed cleanup.
- **MIT licensed**: Fully open source, audit the code yourself.

## Contributing

PRs welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting.

```bash
# Development
git clone https://github.com/Ruso-0/TokenGuard.git
cd TokenGuard
npm install
npm run build
npm test
```

## License

MIT

---

<p align="center">
  <b>Stop burning tokens. Start guarding them.</b><br>
  <sub>Built with frustration, shipped with hope. Now 81% leaner.</sub>
</p>
