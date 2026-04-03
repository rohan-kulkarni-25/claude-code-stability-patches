#!/bin/bash
# PreCompact Hook: Preserve Critical Context
# Based on Claude Code internals — CLAUDE.md corrections fade after compaction
# because the compact prompt preserves conversation, not system context.
# This hook injects critical corrections INTO the conversation right before
# compaction, ensuring they survive in the summary.

set -euo pipefail

CORRECTIONS_FILE="${CLAUDE_PLUGIN_ROOT}/.corrections"
EXPERIENCE_FILE="${CLAUDE_PLUGIN_ROOT}/.experience"

# If we have accumulated corrections, inject them before compaction
if [ -f "$CORRECTIONS_FILE" ] && [ -s "$CORRECTIONS_FILE" ]; then
    echo "IMPORTANT CONTEXT TO PRESERVE IN SUMMARY:"
    echo "The following corrections and lessons were learned during this session."
    echo "These MUST be preserved in the compacted summary:"
    echo "---"
    # Only inject last 2000 chars to avoid bloating the compact input
    tail -c 2000 "$CORRECTIONS_FILE"
    echo "---"
fi

# If experience file exists, inject key rules
if [ -f "$EXPERIENCE_FILE" ] && [ -s "$EXPERIENCE_FILE" ]; then
    echo ""
    echo "LEARNED RULES (from experience file):"
    # Inject last 1000 chars of experience
    tail -c 1000 "$EXPERIENCE_FILE"
fi

exit 0
