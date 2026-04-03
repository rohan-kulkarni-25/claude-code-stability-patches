#!/bin/bash
# Stop Hook: Verification Gate
# Based on Claude Code internals — ANT users get verification instructions,
# external users don't. This hook replicates the ANT verification loop.
#
# The stop hook fires when the model tries to finish a turn with no tool calls.
# Returning a "BLOCKING:" prefixed message forces the loop to continue.
# The model must address the blocking error before it can stop.

set -euo pipefail

# Configuration
VERIFY_FLAG="${CLAUDE_PLUGIN_ROOT}/.verify-active"
CHANGES_LOG="${CLAUDE_PLUGIN_ROOT}/.changes-log"
SKIP_FLAG="${CLAUDE_PLUGIN_ROOT}/.skip-verify"

# If verification is disabled for this turn, allow stop
if [ -f "$SKIP_FLAG" ]; then
    rm -f "$SKIP_FLAG"
    exit 0
fi

# If no changes were tracked this turn, allow stop (nothing to verify)
if [ ! -f "$CHANGES_LOG" ] || [ ! -s "$CHANGES_LOG" ]; then
    exit 0
fi

CHANGED_FILES=$(cat "$CHANGES_LOG" 2>/dev/null | sort -u)
CHANGE_COUNT=$(echo "$CHANGED_FILES" | wc -l | tr -d ' ')

# Only trigger verification for non-trivial changes (3+ files)
if [ "$CHANGE_COUNT" -lt 3 ]; then
    # Clean up for next turn
    rm -f "$CHANGES_LOG"
    exit 0
fi

# Check if verification was already run this turn
if [ -f "$VERIFY_FLAG" ]; then
    rm -f "$VERIFY_FLAG"
    rm -f "$CHANGES_LOG"
    exit 0
fi

# First stop attempt with 3+ changed files — block and require verification
echo "BLOCKING: ${CHANGE_COUNT} files were modified this turn. Before completing:"
echo "1. Grep for any remaining instances of old patterns"
echo "2. Run tests/linter if available (npm test, pytest, cargo test, etc.)"
echo "3. Read back at least 2 modified files to confirm changes applied correctly"
echo ""
echo "Modified files:"
echo "$CHANGED_FILES" | head -20
if [ "$CHANGE_COUNT" -gt 20 ]; then
    echo "... and $((CHANGE_COUNT - 20)) more"
fi
echo ""
echo "After verifying, the next stop will succeed."

# Set flag so next stop attempt passes
touch "$VERIFY_FLAG"

exit 0
