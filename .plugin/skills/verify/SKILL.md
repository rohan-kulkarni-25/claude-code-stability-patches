---
description: Run independent verification on recent changes. Spawns a verifier agent that adversarially checks your work.
allowed-tools: Agent,Read,Grep,Glob,Bash
---

# /verify — Independent Work Verification

Run an independent verification pass on the changes made in this session.

## What to do

1. Spawn the `verifier` agent with a summary of what was changed and what the expected outcome is
2. The verifier will:
   - Read back modified files to confirm changes
   - Grep for remaining instances of old patterns
   - Run tests/linters if available
   - Check imports and references
3. Report the verifier's verdict (PASS / PARTIAL / FAIL) with evidence

## Prompt for verifier

Use this as the base prompt, filling in the specifics from the current session:

```
Verify the following changes:
[Describe what was changed]

Expected outcome:
[Describe what should be true after the changes]

Check:
1. All files were actually modified as described
2. No remaining instances of old patterns exist
3. Tests pass (run: [test command])
4. No broken imports or references
```

## After verification

- If PASS: Report success with evidence
- If PARTIAL: List remaining work items and offer to fix them
- If FAIL: List critical issues and fix them before reporting to the user
