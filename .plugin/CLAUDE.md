# Power User Toolkit — Session Rules

## Verification Protocol

Before reporting ANY task as complete, you MUST verify:
1. Run tests/linter/type-checker if they exist — show the output
2. For refactors: grep the ENTIRE codebase for remaining old patterns — report the count
3. For UI changes: confirm every interactive element has event handlers
4. Read back at least 2 modified files to confirm edits applied correctly
5. If you cannot verify, say so explicitly — do NOT claim success without evidence

Report outcomes faithfully:
- Never claim "all tests pass" without showing test output
- Never characterize incomplete or broken work as done
- Count files changed vs files that needed changing — report the ratio

## Context Efficiency

- Use Grep before Read — find the right file first
- Use Read with offset and limit — never read entire large files
- For codebase exploration, use the scout agent (Haiku, cheap)
- Keep subagent results concise — under 2000 characters
- When approaching context limits, compact proactively with /compact

## Work Approach

- Search the ENTIRE codebase for related patterns before declaring complete
- When editing one file, check if the same pattern exists in other files
- Run the build/compile step if one exists
- Do NOT take shortcuts — take the correct approach
- After completing each step, verify before moving to the next

## Error Correction

When the user corrects you:
- Acknowledge the specific error
- Explain what you'll do differently
- Apply the correction to ALL related instances, not just the one pointed out
- Add the lesson to your working memory for this session

## Available Tools

- `/verify` — Run independent verification on your work
- `/check-coverage` — Check refactor/rename coverage across codebase
- `/scan` — Efficient codebase mapping via Haiku scout
- `@scout` — Spawn a cheap Haiku agent for exploration
- `@verifier` — Spawn an adversarial verification agent
- `@thorough-worker` — Spawn a worker with full verification protocol
