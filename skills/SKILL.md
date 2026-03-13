---
name: tokenguard-optimizer
description: AST-aware context firewall for AI coding agents. Compresses code, validates edits before disk writes, detects blast radius, and enables atomic multi-file refactoring.
---

# TokenGuard Optimizer — Skill Framework

## Task

Guard context budget and prevent code corruption. Minimize token consumption while maximizing code safety. Every edit is validated, every refactor is classified.

## Instructions

### Search Protocol
1. **NEVER** use `grep`, `glob`, `find`, or native `Read` for code exploration.
2. **ALWAYS** use `tg_navigate action:"search"` for semantic code discovery.
3. Use `tg_navigate action:"definition"` for go-to-definition by symbol name.
4. Use `tg_navigate action:"references"` to find all usages of a symbol.
5. Use `tg_navigate action:"outline"` to list all symbols in a file.
6. Use `tg_navigate action:"map"` for the full repo structure with architecture tiers (CORE/LOGIC/LEAF).

### Read Protocol
1. **ALWAYS** prefer `tg_code action:"read"` over native Read — it auto-compresses.
2. Use `tg_code action:"read" compress:false` only when you need to debug function internals.
3. Use `tg_code action:"compress"` for explicit compression control.

### Edit Protocol
1. For single edits, use `tg_code action:"edit"` — it validates AST before writing.
2. For multi-file refactors, use `tg_code action:"batch_edit"` — atomic, all-or-nothing.
3. If the edit changes a function signature, watch for the **BLAST RADIUS** warning and fix dependent files.
4. For renaming symbols, use `tg_navigate action:"prepare_refactor"` FIRST to get a confidence report, then `batch_edit` to apply.
5. **NEVER** use native Write to modify existing code — it bypasses AST validation.
6. Use native Write only for brand new files that don't exist yet.

### Safety Protocol
1. Pin persistent rules with `tg_guard action:"pin"`.
2. Anchor your plan with `tg_guard action:"set_plan"` for long tasks.
3. Check `tg_guard action:"status"` before heavy operations.
4. If the circuit breaker triggers, follow its instructions exactly.

## Dos
- Use `tg_navigate action:"search"` before any Read
- Use `tg_code action:"batch_edit"` for multi-file changes
- Use `tg_navigate action:"prepare_refactor"` before renaming
- Check blast radius warnings after signature changes
- Use `tg_guard action:"status"` before heavy operations

## Don'ts
- Don't use grep, glob, or native Read for exploration
- Don't use native Write to modify existing files
- Don't ignore blast radius warnings
- Don't rename symbols without prepare_refactor first
- Don't rewrite entire files for minor changes
