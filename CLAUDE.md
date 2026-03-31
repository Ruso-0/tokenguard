# 🛡️ NREKI SYSTEM ACTIVE: MANDATORY AI DIRECTIVES

This workspace is protected by NREKI, an AST-aware, RAM-based ACID validation engine. Every edit you attempt is intercepted, validated in RAM (Syntax + LSP Semantics), and auto-healed BEFORE touching the disk.

To prevent context exhaustion and syntax corruption, you **MUST** strictly obey the following operational laws. Failure to do so will break the environment.

## 1. 📖 READING & DISCOVERY (Strict Token Economy)
* **NEVER use Native `Read File` for existing files.** It dumps raw text and permanently damages your context window.
* **ALWAYS use `nreki_code action:"read"`**. NREKI auto-compresses AST structures (saving ~75% tokens) while preserving signatures.
* **DEBUGGING EXCEPTION:** Use `nreki_code action:"read" compress:false` ONLY when you explicitly need to read the internal imperative logic of a function body.
* **NAVIGATION:** Do not use grep/glob. Use `nreki_navigate` (`search`, `definition`, `references`, `outline`, `map`) for zero-noise, AST-precise discovery.

## 2. ✍️ SURGICAL EDITING & REFACTORING
* **NEVER use Native `Write` or `Replace` to modify existing files.** It bypasses the RAM safety shield and will be rejected.
* **SINGLE EDITS:** ALWAYS use `nreki_code action:"edit" symbol:"<Name>"`. NREKI will surgically splice the AST node. If your syntax is invalid, the disk stays untouched.
* **MULTI-FILE EDITS:** ALWAYS use `nreki_code action:"batch_edit"`. It is a strict ACID transaction (all succeed or nothing writes). No half-written refactors.
* **NEW FILES:** Use Native `Write` ONLY for creating brand-new files.
* **RENAMING:** ALWAYS run `nreki_navigate action:"prepare_refactor" symbol:"<OldName>"` before renaming to classify safe/review occurrences. Apply via `batch_edit`.

## 3. 🏗️ BLAST RADIUS & ARCHITECTURE
* **RESPECT THE BLAST RADIUS:** When changing a signature, NREKI warns you of downstream dependent files. **You MUST fix those importing files in the SAME `batch_edit` transaction** before running tests. Do not ignore them.
* **TOPOLOGY TIERS:** Use `nreki_navigate action:"map"` to classify files by gravity:
  * `[CORE]`: High in-degree. Breaking this breaks the system. Proceed with extreme caution.
  * `[LOGIC]`: Business domain. Normal caution.
  * `[LEAF] / [ORPHAN]`: Safe to experiment / Dead code candidates.
* **AUTO-HEALER AWARENESS:** NREKI runs an invisible Auto-Healer in RAM (CodeFix/LSP). If you forget an import, NREKI will inject it and notify you: `[Auto-Heal applied]`. **DO NOT PANIC.** Do not attempt to manually revert or fight the auto-applied fixes.

## 4. 🧠 CONTEXT SURVIVAL (`nreki_guard`)
Your context window WILL compact and you will forget things. Use NREKI to anchor your memory:
* **ANCHOR PLANS:** Start complex tasks with `nreki_guard action:"set_plan" text:"PLAN.md"`. NREKI runs a Context Heartbeat, forcefully re-injecting this plan every ~15 tool calls so you never forget the overarching goal.
* **BREADCRUMBS:** Use `nreki_guard action:"memorize" text:"<notes>"` to save your progress state ("Steps 1-3 done, doing 4").
* **HARD RULES:** Use `nreki_guard action:"pin" text:"<rule>"` to persist invariant rules ("Always use fetch, not axios").

## 5. 🚨 TERMINAL & SYSTEM ALERTS
* **TERMINAL:** Run `npm test`, builds, and `git` normally via Bash. NREKI does not block the terminal. If logs are massive, use `nreki_code action:"filter_output"` to strip noise.
* **CIRCUIT BREAKER:** If NREKI triggers the Circuit Breaker, you are in a token-burning doom loop. **STOP IMMEDIATELY.** Read the breaker's instructions, run `nreki_navigate action:"outline"`, and completely rethink your logic.

## 6. 🔍 ARCHITECTURAL HEALTH (AHI)
* **MANDATORY AUDITS:** You **MUST** run `nreki_guard action:"audit"` BEFORE and AFTER any major structural refactor.
* **THE 5 SIGNALS:** NREKI strictly monitors Coupling Ratio, Bus Factor Entropy, Fiedler Connectivity, Volume Integrity, and Spectral Gap. If your refactor degrades these metrics (e.g., drops Fiedler connectivity causing structural bottlenecks), your code is rotting. **REVERT AND RETHINK.**

## 7. 🐍🐹 MULTI-LANGUAGE & LSP SIDECARS
* **NATIVE & SIDECARS:** NREKI natively shields TS/JS. For Go and Python, it spawns `gopls` and `pyright` child processes for Layer 2 Semantic validation.
* **MISSING BINARY PROTOCOL:** If an LSP is not installed, NREKI will warn you and gracefully degrade to Layer 1 (Syntax-Only AST Validation). **DO NOT PANIC.** Do **NOT** open the terminal to install `gopls` or `pyright`. Acknowledge the downgrade and proceed with syntax-level confidence.

**NREKI handles the safety, rollbacks, and context heavy-lifting. Your objective is to write mathematically correct code on the first attempt.**
