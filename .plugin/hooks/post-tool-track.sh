#!/bin/bash
# PostToolUse Hook: Track File Changes
# Fires after FileEditTool, FileWriteTool, NotebookEditTool
# Records which files were modified so the stop hook knows what to verify.

set -euo pipefail

CHANGES_LOG="${CLAUDE_PLUGIN_ROOT}/.changes-log"

# The tool input is available via stdin in JSON format
# Extract file_path from the tool input
INPUT=$(cat)

# Try to extract file path from common tool input patterns
FILE_PATH=$(echo "$INPUT" | grep -oP '"file_path"\s*:\s*"([^"]+)"' | head -1 | sed 's/"file_path"\s*:\s*"//;s/"$//' 2>/dev/null || true)

if [ -n "$FILE_PATH" ]; then
    echo "$FILE_PATH" >> "$CHANGES_LOG"
fi

exit 0
