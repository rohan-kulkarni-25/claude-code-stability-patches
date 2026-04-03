---
description: Efficiently scan the codebase structure using a Haiku scout agent. Returns a structured map without burning context.
allowed-tools: Agent
---

# /scan — Efficient Codebase Scan

Spawn a scout agent (Haiku, read-only, no CLAUDE.md overhead) to quickly map the codebase structure.

## What to do

1. Spawn the `scout` agent (subagent_type: "Explore") with the user's query
2. If no specific query, use: "Map the codebase structure. Report: directory layout, key entry points, configuration files, test locations, and build system."
3. The scout runs on Haiku with omitClaudeMd — minimal token cost
4. Report the scout's findings as a structured codebase map

## Default scan prompt (when no args given)

```
Map this codebase:
1. Directory structure (2 levels deep)
2. Entry points (main files, index files)
3. Config files (package.json, tsconfig, etc.)
4. Test locations and framework
5. Key source directories and their purpose
Report as a structured list, under 300 words.
```
