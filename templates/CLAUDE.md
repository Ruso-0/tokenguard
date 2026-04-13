# 🛡️ NREKI SYSTEM ACTIVE: AI DIRECTIVES

This workspace is protected by NREKI, an AST-aware context firewall.

## 0. 🚨 EMERGENCY FALLBACK (MCP FAILURE)
If the `nreki_*` tools fail to load, timeout, or return connection errors:
1. **DO NOT PANIC or freeze.**
2. **TEMPORARILY SUSPEND** the "NEVER use Native Read/Write" rules below.
3. Fall back to your native `Read File`, `Write`, and `Replace` tools to complete the task.
4. Inform the user: *"NREKI connection lost. Proceeding with native tools (AST safety disabled)."*

*(Assuming NREKI is online, strictly obey the following laws):*

## 1. 📖 READING & DISCOVERY (The TFC-Ultra Protocol)
* **NEVER use Native `Read File` for existing files** (unless in Emergency Fallback). It dumps raw text, triggers "Attention Sinks", and burns context.
* **MANDATORY TFC-ULTRA FOR EDITS:** To understand or edit a specific logic block in a large file (>3000 tokens):
  1. Run `nreki_navigate action:"outline" path:"<file>"` to map the structure.
  2. Identify the exact **METHOD or FUNCTION** you need (DO NOT target entire classes).
  3. Run `nreki_code action:"compress" path:"<file>" focus:"<method_name>"`.
  *NREKI will isolate your target at 100% resolution, resolve causal dependencies, and annihilate up to 98% of orthogonal noise.*
* **GENERAL EXPLORATION:** If skimming a smaller file, use `nreki_code action:"read"`.
* **NAVIGATION:** Do not use grep/glob. Use `nreki_navigate` (`search`, `definition`, `references`, `outline`, `map`) for zero-noise discovery.

## 2. ✍️ SURGICAL EDITING & REFACTORING
* **NEVER use Native `Write` or `Replace` to modify existing files.** It bypasses the RAM safety shield.
* **SINGLE EDITS:** ALWAYS use `nreki_code action:"edit" symbol:"<Name>"`.
* **MULTI-FILE EDITS:** ALWAYS use `nreki_code action:"batch_edit"`. It is a strict ACID transaction.
* **PATCH MODE (Minimum Output Tokens):** For ANY edit that changes less than 30% of a symbol's body,
  you **MUST** use `mode:"patch"` with `search_text` and `replace_text`.
  **NEVER** rewrite an entire function to change a single line. Output tokens are 5x more expensive than input.
* **CRITICAL FOR PATCH:** Your `search_text` must be an EXACT substring of the existing AST node,
  including exact whitespace and indentation. If patch fails, NREKI returns a preview of the actual AST content.
* **SCAFFOLDING EXCEPTION:** When creating BRAND NEW files from scratch, use Native `Write`.
  New files have nothing pre-existing to break. NREKI `edit`/`batch_edit` is for modifying existing code only.
* **NEW FILES:** Use Native `Write` ONLY for creating brand-new files.
* **RENAMING:** Run `nreki_navigate action:"prepare_refactor"` before renaming.

## 3. 🏗️ BLAST RADIUS & ARCHITECTURE
* **RESPECT THE BLAST RADIUS:** When changing a signature, NREKI warns you of downstream dependent files. You **MUST** fix them in the SAME `batch_edit` transaction.
* **AUTO-HEALER:** If NREKI injects an import or fixes syntax, it will notify you: `[Auto-Heal applied]`. **DO NOT PANIC.** Do not manually revert it.

## 4. 🧠 CONTEXT SURVIVAL
* **ANCHOR PLANS:** Start complex tasks with `nreki_guard action:"set_plan" text:"PLAN.md"`. NREKI silently re-injects this plan every ~15,000 tokens so you never forget it.
* **BREADCRUMBS:** Use `nreki_guard action:"memorize" text:"<notes>"` to save your progress state.

## 5. 🚨 TERMINAL & SYSTEM ALERTS
* Run `npm test`, builds, and `git` normally via Bash. If logs are massive, use `nreki_code action:"filter_output"`.
* **CIRCUIT BREAKER:** If NREKI triggers the Circuit Breaker, you are in a token-burning doom loop. **STOP IMMEDIATELY.** Read the instructions.

## 6. 🔍 ARCHITECTURAL HEALTH (Passive Radar)
* **THE RULE:** NREKI monitors the codebase for "God Files" (Bus Factor) and "Spaghetti Code" (Coupling). If your refactor triggers a CRITICAL alert in an audit, treat it as a strong architectural hint to decouple, but **prioritize fixing syntax/logic first**.

## 7. 🐍🐹 MULTI-LANGUAGE & LSP SIDECARS
* **NATIVE SHIELD:** NREKI natively shields TS/JS. For Go/Python, it attempts to spawn `gopls`/`pyright` for Layer 2 Semantic validation.
* **MISSING BINARY?** If an LSP is not installed, NREKI gracefully degrades to Layer 1 (Syntax-Only AST Validation). **DO NOT PANIC.** Do NOT ask the user to install them. Acknowledge the downgrade silently and proceed with syntax-level confidence.
