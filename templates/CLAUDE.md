# NREKI ACTIVE
If nreki_* tools fail: fall back to native Read/Write and inform user.

## 0. Zero-Chatter
- Call tools immediately. No "I will now..." or "Let me...".
- State changes in one line. No ASCII tables, no summaries.
- Output tokens cost 5x input. Optimize every syllable.

## 1. READING
- NEVER use Explore, Bash sed/cat/head, or native Read File to read code.
- NEVER read functions one by one. If you need 5 functions, use ONE call with comma-separated targets:
  nreki_code action:"compress" focus:"func1, func2, func3, func4, func5"
- Large files (>100L): nreki_navigate action:"outline" → identify HIGH-risk methods → compress ALL in one call.
- The outline auto-expands HIGH-risk functions up to a 6,000 token budget. Read them directly from the outline.
- **CRITICAL FOR AUDITS:** If the outline says [BUDGET LIMIT REACHED], you MUST use `nreki_code action:"compress" focus:"<omitted_symbols>"` to read the remaining high-risk functions before concluding your audit. Do not guess their logic.
- Small files: nreki_code action:"read".
- Navigation: use nreki_navigate (search, definition, references, outline, map). No grep/glob.

## 2. EDITING
- NEVER use native Write/Replace on existing files.
- NEVER edit sequentially. Do not read-edit-read-edit. Read ALL targets first, then batch ALL fixes.
- Use nreki_code action:"batch_edit" with array of ALL patches in one call.
- PATCH MODE (MANDATORY): If changing <40 lines, use mode:"patch" search_text:"<exact>" replace_text:"<new>".
- New files only: use native Write.
- Renaming: run nreki_navigate action:"prepare_refactor" first.

## 3. BLAST RADIUS
- Fix all downstream dependents in the SAME batch_edit when changing signatures.
- Auto-healer may inject imports — don't revert.

## 4. CONTEXT SURVIVAL
- Anchor plans: `nreki_guard action:"set_plan" text:"PLAN.md"`.
- Save progress: `nreki_guard action:"memorize" text:"<notes>"`.

## 5. ALERTS
- Terminal output: `nreki_code action:"filter_output"`.
- Circuit breaker: STOP, read instructions, rethink.

## 6. VERIFICATION
- NEVER run tsc, eslint, npm install, or any bash command to verify edits.
- NREKI validates every edit via TypeScript compiler in RAM.
- If nreki_code returns [OK], the edit is guaranteed valid. Trust it.
- If NREKI returns an error, fix it using NREKI tools. Do not drop to terminal.
