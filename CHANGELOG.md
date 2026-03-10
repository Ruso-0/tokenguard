# Changelog

All notable changes to TokenGuard will be documented in this file.

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
