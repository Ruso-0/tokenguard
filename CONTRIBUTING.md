# Contributing to TokenGuard

Thank you for your interest in contributing to TokenGuard! This guide will help you get started.

## Development Setup

### Prerequisites
- Node.js >= 20.0.0
- npm >= 9.0.0

### Setup
```bash
git clone https://github.com/YOUR_USERNAME/tokenguard.git
cd tokenguard
npm ci
```

### Building
```bash
npm run build
```

### Running Tests
```bash
npm test                # Run all tests once
npm run test:watch      # Run tests in watch mode
```

### Running Locally
```bash
npm run dev             # Run with tsx (development)
npm start               # Run compiled version
```

## Code Style

- **Language**: TypeScript (strict mode enabled)
- **Module System**: ES Modules (Node16)
- **Target**: ES2022
- **Formatting**: Use consistent 4-space indentation
- **Comments**: JSDoc for all public APIs

### Lint Check
```bash
npm run lint
```

## Project Structure

```
src/
├── index.ts                 # MCP server entry point
├── engine.ts                # Core search engine orchestrator
├── database.ts              # SQLite + in-memory vector/keyword indexes
├── parser.ts                # Tree-sitter AST parsing
├── embedder.ts              # Local embedding generation
├── compressor.ts            # Classic tier-based compression
├── compressor-advanced.ts   # LLMLingua-2-inspired compression
├── monitor.ts               # Token consumption monitoring
├── schemas.ts               # Zod input validation schemas
├── hooks/
│   └── preToolUse.ts        # Pre-tool-use interception hook
└── utils/
    ├── path-jail.ts         # Path traversal protection
    ├── safe-parse.ts        # WASM memory-safe parsing
    ├── file-filter.ts       # File size/extension filtering
    └── code-tokenizer.ts    # Code-aware identifier tokenizer
```

## Pull Request Guidelines

1. **Fork** the repository and create a feature branch from `main`
2. **Write tests** for any new functionality
3. **Run the full test suite** before submitting: `npm test`
4. **Keep commits focused**: one fix/feature per commit
5. **Write clear commit messages** following conventional commits
6. **Update documentation** if you change any public APIs
7. **Do not include** build artifacts (`dist/`) in your PR

## Reporting Issues

Please use the GitHub Issues templates:
- **Bug Report**: for bugs and unexpected behavior
- **Feature Request**: for new features and enhancements

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
