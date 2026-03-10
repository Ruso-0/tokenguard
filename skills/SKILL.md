---
name: tokenguard-optimizer
description: Forces semantic compression, dynamic AST shorthand outputs, and hybrid RRF search to minimize token consumption. Use whenever processing codebases or generating multi-file code.
---

# TokenGuard Optimizer — TIDD-EC Skill Framework

## Task

Optimize interaction efficiency and guard context budget. Minimize token
consumption while maximizing code understanding and output quality. Every
operation must justify its token cost.

## Instructions

### Search Protocol
1. **NEVER** use `grep`, `glob`, `find`, or `Read` for code exploration.
2. **ALWAYS** use `tg_search` for semantic code discovery — it returns
   compressed AST signatures instead of raw file content.
3. Start every code exploration with `tg_search("your intent")` — it
   understands natural language queries like "authentication middleware"
   or "database connection pooling".
4. Only use `tg_compress` when you need the full structure of a specific
   file, not `Read`.

### Code Modification Protocol
1. For code modifications, **DO NOT** rewrite entire files.
2. Use AST patch shorthand format exclusively:
   ```
   [PATCH] path/to/file.ts:L42-L67
   - old_code_line
   + new_code_line
   ```
3. If a change affects more than 30 lines, break it into multiple
   focused patches.
4. Always reference specific line numbers from `tg_search` results.

### Output Protocol
1. Purge **ALL** conversational scaffolding from output.
2. Emit strictly actionable data: patches, commands, or direct answers.
3. No preambles like "Sure, I can help with that..."
4. No summaries unless explicitly requested.
5. No repeating the question back.

### Budget Management
1. Check `tg_status` before any operation that will read > 3 files.
2. If burn rate is > 70% of budget, switch to Tier 1 compression.
3. If burn rate is > 90%, emit only patches — no explanations.

## Dos

- ✅ DO use `tg_search` before any Read operation
- ✅ DO check `tg_status` before heavy operations (multi-file edits)
- ✅ DO use `tg_compress` instead of reading large files directly
- ✅ DO emit shorthand AST patches for code changes
- ✅ DO reference line numbers from search results
- ✅ DO batch related changes into single responses
- ✅ DO use `tg_audit` periodically to track savings

## Don'ts

- ❌ DON'T use grep, glob, or find for code exploration
- ❌ DON'T read entire files when you only need a function
- ❌ DON'T create temporary files without self-deletion
- ❌ DON'T rewrite complete functions for minor changes
- ❌ DON'T add explanatory prose unless asked
- ❌ DON'T repeat context that's already in the conversation
- ❌ DON'T include import statements unless they changed

## Examples

### Bad: Reading an entire file to find one function
```
Read src/engine.ts → 350 lines → ~1,000 tokens wasted
```

### Good: Targeted semantic search
```
tg_search("hybrid search implementation") → 5 results → ~200 tokens
```

### Bad: Rewriting an entire function
```
Write src/engine.ts with entire 350-line content
```

### Good: AST patch shorthand
```
[PATCH] src/engine.ts:L142-L145
- const limit = 10;
+ const limit = Math.min(requestedLimit, 50);
```

## Constraints

- Over-engineering is prohibited — solve the stated problem, nothing more
- Maximum response length strictly capped — if you need more space, split
  into multiple focused responses
- Trust the framework — don't add defensive code around TokenGuard tools
- Never bypass the search protocol "just to be sure"
- Zero tolerance for placeholder content or TODO comments in shipped code
