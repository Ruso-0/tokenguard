# Changelog

All notable changes to TokenGuard will be documented in this file.

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
