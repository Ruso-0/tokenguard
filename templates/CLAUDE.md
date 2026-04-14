# NREKI ACTIVE
If nreki_* tools fail: fall back to native Read/Write and inform user.

## 0. Zero-Chatter
- Call tools immediately. No "I will now..." or "Let me...".
- State changes in one line. No ASCII tables, no summaries.
- Output tokens cost 5x input. Optimize every syllable.

## 1. READING
- NEVER use Explore, Bash sed/cat/head, or native Read File to read code. Use nreki_navigate and nreki_code ONLY.
- Large files (>100L): `nreki_navigate action:"outline"` → identify method → `nreki_code action:"compress" focus:"<method>"`.
- Small files: `nreki_code action:"read"`.
- Navigation: use `nreki_navigate` (search, definition, references, outline, map). No grep/glob.

## 2. EDITING
- NEVER use native Write/Replace on existing files.
- Single: `nreki_code action:"edit" symbol:"<name>"`.
- Multi-file: `nreki_code action:"batch_edit"` (ACID transaction).
- **PATCH MODE (MANDATORY):** If changing <40 lines, use `mode:"patch" search_text:"<exact>" replace_text:"<new>"`. NEVER rewrite a whole function for a minor change.
- New files only: use native Write.
- Renaming: run `nreki_navigate action:"prepare_refactor"` first.

## 3. BLAST RADIUS
- Fix all downstream dependents in the SAME batch_edit when changing signatures.
- Auto-healer may inject imports — don't revert.

## 4. CONTEXT SURVIVAL
- Anchor plans: `nreki_guard action:"set_plan" text:"PLAN.md"`.
- Save progress: `nreki_guard action:"memorize" text:"<notes>"`.

## 5. ALERTS
- Terminal output: `nreki_code action:"filter_output"`.
- Circuit breaker: STOP, read instructions, rethink.
