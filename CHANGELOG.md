# Changelog

All notable changes to TokenGuard will be documented in this file.

## [2.1.1] - 2026-03-10

### Headline
TokenGuard v2.1.1 — Final audit fixes, tg_undo, 16 tools, 305 tests.

### Added — New Tool
- **`tg_undo`** — Undo the last `tg_semantic_edit` on a file. Auto-restores from backup with one-shot semantics (backup is consumed after restore).

### Added — New Module
- `src/undo.ts` — Backup/restore engine using base64url-encoded file paths. Stores pre-edit snapshots in `.tokenguard/backups/`.
- `src/utils/read-source.ts` — Shared BOM-safe file reader. Strips U+FEFF byte order marks from Windows-created source files.

### Security
- **FIX 2 — XML injection prevention**: Pin content is now escaped (`&`, `<`, `>`, `"`, `'`) before storage to prevent prompt injection via pinned rules.

### Fixed
- **FIX 1 — BOM stripping**: All source file readers now use `readSource()` to strip U+FEFF BOM, fixing parse failures on Windows-created files.
- **FIX 3 — Code tokenizer**: Rewritten to correctly handle `$scope`, `__proto__`, `_privateVar`, and other edge-case identifiers with `$`/`_` prefixes.
- **FIX 4 — Fast dot product**: Replaced cosine similarity with direct dot product for L2-normalized vectors. Removes sqrt/division overhead; mathematically equivalent for unit vectors.
- **FIX 6 — Pin order**: Pinned rules now appear AFTER repo map text (was before). Preserves Anthropic prompt cache hits since the static map stays at the start of context.
- **FIX 7 — Circuit breaker normalization**: `hashError()` now normalizes ISO timestamps and improved memory address normalization. Added 5-minute TTL eviction to prevent stale errors from tripping the breaker.
- **FIX 8 — ASCII receipt**: Replaced all Unicode box-drawing characters and emojis in session receipt and reports with ASCII equivalents for terminal compatibility.

### Changed
- **Tool count**: 15 -> 16 MCP tools.
- **Test count**: 282 -> 305 tests across 11 test suites.
- **tg_map**: Pinned rules now appended after repo map (was prepended before).
- **package.json**: Version bumped to 2.1.1.

---

## [2.1.0] - 2026-03-10

### Headline
TokenGuard v2.1 — 15 MCP tools, 282 tests, circuit breaker, surgical edit, pin memory, session receipt.

### Added — New Tools
- **`tg_semantic_edit`** — Surgically edit a function/class/interface by name without reading or rewriting the entire file. Finds the exact AST node, replaces only those bytes, validates syntax before saving. Saves 98% of output tokens vs full file rewrites.
- **`tg_circuit_breaker`** — Detects infinite failure loops (same error 3+ times, same file 5+ times, write-test-fail cycles). When tripped, forces Claude to stop and ask the human for guidance. Prevents doom loops that burn through remaining context.
- **`tg_pin`** — Pin important rules Claude should never forget. Pinned items are injected into every `tg_map` response, keeping project conventions permanently in Claude's attention window. Max 10 pins, 200 chars each, persisted to disk.

### Added — New Modules
- `src/semantic-edit.ts` — Zero-read surgical AST patching. Symbol name lookup, byte-level splice, syntax validation before write.
- `src/circuit-breaker.ts` — Loop detection engine with sliding window analysis, consecutive failure tracking, and automatic trip/reset.
- `src/pin-memory.ts` — Persistent pinned rules with deterministic output (sorted by id) for prompt cache compatibility.

### Added — Session Receipt
- `tg_session_report` now generates an ASCII receipt showing input tokens saved, output tokens avoided, search queries, surgical edits, syntax errors blocked, doom loops prevented, pinned rules active, estimated USD savings, and model info.

### Changed
- **Tool count**: 12 -> 15 MCP tools.
- **Test count**: 194 -> 282 tests across 11 test suites.
- **tg_map**: Now prepends pinned rules at the top of the repo map output.
- **README**: Complete rewrite for v2.1 with comparison table, 3 unique features highlight, receipt preview, and updated architecture diagram.
- **package.json**: Version bumped to 2.1.0.

### Architecture
- **Pin memory layer**: Pinned rules are stored in `.tokenguard/pins.json` and prepended to every `tg_map` response. Deterministic output (sorted by id) preserves prompt cache compatibility.
- **Circuit breaker integration**: `tg_terminal` automatically feeds errors to the circuit breaker for proactive loop detection.

## [2.0.0] - 2026-03-10

### Headline
TokenGuard v2.0 — 12 MCP tools, 194 tests, cache-aware two-layer architecture.

### Added — New Tools
- **`tg_def`** — Go-to-definition by symbol name. AST-based, 100% precise, returns full source body with signature.
- **`tg_refs`** — Find all references to a symbol across the project. Cross-file word-boundary matching with context.
- **`tg_outline`** — List all symbols in a file with kind, signature, export status, and line ranges. Like VS Code Outline.
- **`tg_validate`** — AST sandbox validator. Parses code with tree-sitter before disk write. Catches missing commas, unclosed braces, invalid syntax with exact line/column and fix suggestions. Prevents the "write broken code → see error → retry" token burn loop.

### Added — New Modules
- `src/ast-navigator.ts` — AST navigation engine for tg_def, tg_refs, tg_outline. Walks project files, extracts symbols, signatures, export status.
- `src/ast-sandbox.ts` — AST sandbox validator with `validateCode()` and `validateDiff()`. Recursive tree walk with `hasError` subtree pruning for large-file performance.
- `src/terminal-filter.ts` — Terminal entropy filter. Strips ANSI codes, deduplicates stack traces, extracts unique errors and affected files. 89% token reduction on error output.
- `src/repo-map.ts` — Static deterministic repo map for Anthropic prompt cache optimization. Identical output for same repo state enables $0.30/M caching vs $3.00/M input.

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
- **Cache-friendly**: tg_map output is deterministic — same repo state produces identical text, enabling Anthropic prompt caching.

### Performance (Self-Benchmark)
- tg_search: 10 results in 16ms (hybrid RRF fusion)
- tg_def: Definition lookup in 128ms across 22 files
- tg_refs: 20 references found in 11ms
- tg_outline: 25 symbols extracted in 7ms
- tg_compress: 5,502 → 1,753 tokens (68% reduction, medium level)
- tg_terminal: 11,967 → 1,276 tokens (89% reduction)
- tg_validate: Syntax error detection with line/column in <1ms
- tg_map: 22 files mapped, 4,677 tokens, 169ms

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
- `src/utils/path-jail.ts` — Path traversal protection
- `src/utils/safe-parse.ts` — WASM memory-safe parsing
- `src/utils/file-filter.ts` — File size and extension filtering
- `src/utils/code-tokenizer.ts` — Code-aware identifier tokenization
- `src/schemas.ts` — Zod validation schemas for all tools
- `.github/workflows/ci.yml` — CI/CD with matrix testing (3 OSes × 3 Node versions)
- `CONTRIBUTING.md` — Contributor guide
- `CHANGELOG.md` — This file
- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- Comprehensive test suite for all new utilities

### Performance
- Pre-computed vector norms at index time (avoids recalculation during search)
- Proper cosine similarity with normalized vectors

## [1.1.1] - 2026-03-09

### Initial Release
- MCP server with 6 tools: tg_search, tg_audit, tg_compress, tg_status, tg_session_report, tg_read
- Hybrid RRF search (BM25 + vector similarity)
- Three-tier classic compression + LLMLingua-2-inspired advanced compression
- Real-time file watching with chokidar
- Token consumption monitoring and burn rate prediction
- Pre-tool-use interception hook
