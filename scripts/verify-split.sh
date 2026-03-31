#!/bin/bash
# Verify a file split didn't break imports or lose exports.
# Usage: ./scripts/verify-split.sh <barrel-file> <snapshot-file>
#
# Safety checks:
# 1. All symbols from the pre-split snapshot are still exported
# 2. Every file importing from the barrel can find its symbols

FILE="$1"
SNAPSHOT="$2"
ROOT="/Users/rohankulkarni/Desktop/cc"

echo "=== Verifying: $FILE ==="

# Step 1: Get current exports
CURRENT=$(bash scripts/snapshot-exports.sh "$FILE")
CURRENT_COUNT=$(echo "$CURRENT" | wc -l | tr -d ' ')

# Step 2: Compare with snapshot
SNAPSHOT_CONTENT=$(cat "$SNAPSHOT")
SNAPSHOT_COUNT=$(echo "$SNAPSHOT_CONTENT" | wc -l | tr -d ' ')

echo "Snapshot exports: $SNAPSHOT_COUNT"
echo "Current exports:  $CURRENT_COUNT"

MISSING=$(comm -23 <(echo "$SNAPSHOT_CONTENT" | sort) <(echo "$CURRENT" | sort))

ERRORS=0

if [[ -n "$MISSING" ]]; then
    echo ""
    echo "MISSING exports (were in snapshot, now gone):"
    echo "$MISSING" | sed 's/^/  - /'
    ERRORS=1
fi

# Step 3: For each file that imports from the barrel, verify symbols exist
# Build all possible import path suffixes for this file
# e.g., utils/errors.ts -> could be imported as '../errors.js', '../../utils/errors.js', etc.
FILE_NO_EXT=$(echo "$FILE" | sed -E 's/\.(ts|tsx)$//')
FILE_JS="${FILE_NO_EXT}.js"
# The import path always ends with the .js version of the filename
IMPORT_SUFFIX=$(basename "$FILE_JS")
IMPORT_DIR=$(basename "$(dirname "$FILE")")

echo ""
echo "Checking importers (looking for imports ending in ${IMPORT_DIR}/${IMPORT_SUFFIX})..."

IMPORT_ERRORS=0

# Find files importing this exact module (match dir/file pattern to avoid false positives)
grep -rl "from '.*${IMPORT_DIR}/${IMPORT_SUFFIX}'" "$ROOT" --include="*.ts" --include="*.tsx" 2>/dev/null | \
    grep -v "$FILE" | \
    while read -r f; do
        # Extract symbols from import lines that match our barrel
        SYMS=$(grep "from '.*${IMPORT_DIR}/${IMPORT_SUFFIX}'" "$f" 2>/dev/null | \
            grep -oE '\{[^}]+\}' | \
            tr -d '{}' | \
            tr ',' '\n' | \
            sed -E 's/^\s*//;s/\s*$//' | \
            sed -E 's/\s+as\s+\w+$//' | \
            sed -E 's/^type\s+//' | \
            grep -E '^\w+$' | sort -u || true)

        for sym in $SYMS; do
            if ! echo "$CURRENT" | grep -qx "$sym"; then
                echo "  BROKEN: '$sym' imported in $(echo "$f" | sed "s|$ROOT/||") but not exported"
                IMPORT_ERRORS=$((IMPORT_ERRORS + 1))
            fi
        done
    done

# Capture the result from the subshell
PIPE_EXIT=${PIPESTATUS[0]:-0}

if [[ $IMPORT_ERRORS -eq 0 ]]; then
    echo "  All importer references OK"
else
    ERRORS=1
fi

echo ""
if [[ $ERRORS -eq 0 ]]; then
    echo "=== PASS ==="
else
    echo "=== FAIL ==="
    exit 1
fi
