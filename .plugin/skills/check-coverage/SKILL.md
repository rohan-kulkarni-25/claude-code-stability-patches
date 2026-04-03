---
description: Check if a refactor or rename covered all instances across the codebase. Reports coverage ratio.
allowed-tools: Grep,Glob,Bash,Read
---

# /check-coverage — Refactor Coverage Check

Verify that a rename, refactor, or pattern change was applied across the entire codebase.

## What to do

1. Ask the user (or infer from recent context) what pattern was changed
2. Grep the ENTIRE codebase for the OLD pattern
3. Grep for the NEW pattern to confirm replacements
4. Calculate coverage: `(new_count) / (new_count + old_remaining)`
5. Report results with file paths for any remaining instances

## Output format

```
COVERAGE: X/Y instances updated (Z%)

REMAINING (old pattern):
  - path/to/file.ts:42 — context line
  - path/to/other.ts:18 — context line

UPDATED (new pattern):
  - path/to/file.ts:42 — context line
  [... first 10]

VERDICT: COMPLETE | INCOMPLETE (N remaining)
```

## Rules

- Search ALL file types, not just the obvious ones
- Check: source files, tests, documentation, config files, comments
- Exclude: node_modules, .git, dist, build directories
- For renames: also check string literals, comments, and log messages
- Report exact file:line for every remaining instance
