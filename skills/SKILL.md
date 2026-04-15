---
name: nreki-optimizer
description: AST-aware context firewall for AI coding agents. Compresses code, validates edits before disk writes, detects blast radius, and enables atomic multi-file refactoring.
---

# NREKI Optimizer — Skill Framework

## Task

Guard context budget and prevent code corruption. Minimize token consumption while maximizing code safety. Every edit is validated, every refactor is classified.

**🚨 EMERGENCY FALLBACK:** Only apply the strict NREKI rules if the `nreki_*` tools are successfully responding. If the MCP server is offline, times out, or returns connection errors, you are AUTHORIZED to fall back to native `Read File` and `Write` tools to ensure the user's task is completed. Do not get stuck in a loop trying to call a dead server.

## Instructions

### Search Protocol
1. **NEVER** use `grep`, `glob`, `find`, or native `Read` for code exploration.
2. **ALWAYS** use `nreki_navigate action:"search"` for semantic code discovery.
3. Use `nreki_navigate action:"definition"` for go-to-definition by symbol name.
4. Use `nreki_navigate action:"references"` to find all usages of a symbol.
5. Use `nreki_navigate action:"outline"` to list all symbols in a file.
6. Use `nreki_navigate action:"map"` for the full repo structure with architecture tiers (CORE/LOGIC/LEAF).

### Read Protocol
1. **ALWAYS** prefer `nreki_code action:"read"` over native Read — it auto-compresses.
2. Use `nreki_code action:"read" compress:false` only when you need to debug function internals.
3. Use `nreki_code action:"compress"` for explicit compression control.
4. The outline auto-expands HIGH-risk functions up to a 6,000 token budget. Read them directly from the outline.
5. **CRITICAL FOR AUDITS:** If the outline says [BUDGET LIMIT REACHED], you MUST use `nreki_code action:"compress" focus:"<omitted_symbols>"` to read the remaining high-risk functions before concluding your audit. Do not guess their logic.

### Edit Protocol
1. For single edits, use `nreki_code action:"edit"` — it validates AST before writing.
2. For multi-file refactors, use `nreki_code action:"batch_edit"` — atomic, all-or-nothing.
3. If the edit changes a function signature, watch for the **BLAST RADIUS** warning and fix dependent files.
4. For renaming symbols, use `nreki_navigate action:"prepare_refactor"` FIRST to get a confidence report, then `batch_edit` to apply.
5. **NEVER** use native Write to modify existing code — it bypasses AST validation.
6. Use native Write only for brand new files that don't exist yet.
7. For minor changes (<30% of a function), use `mode:"patch"` with `search_text` and `replace_text` instead of rewriting the entire symbol.
8. For brand new files, use native Write. NREKI edits are for existing code only.

### Safety Protocol
1. Pin persistent rules with `nreki_guard action:"pin"`.
2. Anchor your plan with `nreki_guard action:"set_plan"` for long tasks.
3. Check `nreki_guard action:"status"` before heavy operations.
4. If the circuit breaker triggers, follow its instructions exactly.

## Dos
- Use `nreki_navigate action:"search"` before any Read
- Use `nreki_code action:"batch_edit"` for multi-file changes
- Use `nreki_navigate action:"prepare_refactor"` before renaming
- Check blast radius warnings after signature changes
- Use `nreki_guard action:"status"` before heavy operations

## Don'ts
- Don't use grep, glob, or native Read for exploration
- Don't use native Write to modify existing files
- Don't ignore blast radius warnings
- Don't rename symbols without prepare_refactor first
- Don't rewrite entire files for minor changes
