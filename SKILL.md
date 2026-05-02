---
name: nreki-optimizer
description: AST-aware context firewall for AI coding agents. Compresses code, validates edits before disk writes, detects blast radius, and enables atomic multi-file refactoring via NREKI MCP tools.
---

# NREKI ACTIVE (IMMUNE SYSTEM)

If nreki_* tools fail: fall back to native Read/Write ONLY for new files or <100L. Native tools are BLOCKED by filesystem hooks for >100L files.

## 0. ZERO-CHATTER
- Call tools immediately. No "I will now..." or "Let me...".
- State changes in one line. No ASCII tables, no summaries.
- Output tokens cost 5x input. Optimize every syllable.

## 1. NAVIGATION & READING
- NEVER use Explore, Bash grep/rg/cat, or native Read File.
- EXACT SEARCH: ALWAYS use nreki_navigate action:"fast_grep". Returns 3D AST topological coordinates (File + Symbol + Line) via SQLite index. Benchmarked 5-33x faster than bash grep on indexed codebases.
- SEMANTIC SEARCH: Use nreki_navigate action:"search" for concept-based queries.
- BATCH READING: NEVER read functions one by one. Use ONE call with comma-separated targets: nreki_code action:"compress" focus:"func1, func2, func3".
- LARGE FILES: nreki_navigate action:"outline" auto-expands HIGH-risk methods up to 6,000 token budget.
  - CRITICAL: If outline says [BUDGET LIMIT REACHED], you MUST use compress focus:"<omitted_symbols>" to read the hidden logic before editing. Do not guess.
  - Pay attention to [Defect] flags and [orphan / 0 ext refs] markers.
- Small files: nreki_code action:"read".

## 2. SURGICAL EDITING & ACID BATCHES
- NEVER use native Write/Replace on existing files (bypasses AST validation).
- NEVER edit sequentially. Read ALL targets first, then batch ALL fixes in ONE nreki_code action:"batch_edit" call.
- 80L GUILLOTINE: NREKI mathematically rejects any single payload (new_code or replace_text) >80 lines. You MUST decompose large rewrites.
- PATCH MODE (MANDATORY): If the original symbol is >40 lines, mode:"replace" is BLOCKED. You MUST use mode:"patch" with search_text and replace_text.
  - Tolerant Match: search_text indentation is fuzzy. Focus on unique logical content.
  - Multi-Patching: To bypass the 80L limit, send MULTIPLE patch edits to the SAME symbol sequentially in one batch_edit.
  - ACID Rule: When multi-patching a symbol, EVERY search_text must match the ORIGINAL unaltered source code. Do not target code injected by previous patches.
- ANTI-SWEEP SHIELD: NEVER use // eslint-disable, @ts-ignore, or # noqa. NREKI will block your edit. Fix the structural flaw.
- RENAMING: Run nreki_navigate action:"prepare_refactor" first.

## 3. BLAST RADIUS & TTRD (TYPE DISCIPLINE)
- CASCADES: Fix all downstream dependents in the SAME batch_edit when changing signatures.
- TTRD SHIELD: NEVER downgrade strict types to any or unknown to appease the compiler. NREKI catches type degradation in RAM and penalizes the file's Cognitive Friction Index (CFI).
- BOUNTIES: If you see [UNPAID TYPE DEBT] warnings, restore the original strict types to earn a CFI reduction reward.
- AUTO-HEALER: NREKI may auto-inject missing imports in RAM. Do not revert them.

## 4. CONTEXT SURVIVAL & MEMORY
- Anchor plans: nreki_guard action:"set_plan" text:"PLAN.md".
- Scratchpad: nreki_guard action:"memorize" text:"<notes>".
- Engrams: Use nreki_guard action:"engram" path:"..." symbol:"..." text:"ASSERT: <rule>" to pin architectural invariants to an AST node. The ASSERT prefix makes it immortal across code mutations.

## 5. ALERTS & VERIFICATION
- NEVER run tsc, eslint, or npm install to verify edits. NREKI mathematically validates every edit via TypeScript Compiler and LSP sidecars (Go/Python) in RAM BEFORE disk write.
- If nreki_code returns [OK], the edit is guaranteed valid. Trust it. Move on.
- If NREKI returns an error, read the structured output and fix it using NREKI tools. Do not drop to the bash terminal.
- Terminal output: nreki_code action:"filter_output".
- Circuit breaker: If you see BREAK & BUILD or DECOMPOSE, STOP. Read the strategy and rethink.
