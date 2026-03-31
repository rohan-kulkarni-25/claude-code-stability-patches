#!/bin/bash
# Snapshot all exports from a file before splitting.
# Usage: ./scripts/snapshot-exports.sh <file>

FILE="$1"

{
  # "export function X", "export async function X", "export async function* X", "export class X", etc.
  grep -E '^export (function\*?|async function\*?|class|const|let|type|interface|enum) ' "$FILE" 2>/dev/null | \
    sed -E 's/^export (async )?(function\*?) ([a-zA-Z_][a-zA-Z0-9_]*).*/\3/' | \
    sed -E 's/^export (class|const|let|type|interface|enum) ([a-zA-Z_][a-zA-Z0-9_]*).*/\2/' || true

  # "export { X, Y, Z }" and "export { X, Y } from '...'" style
  # Handles multi-line export blocks by collapsing file first
  tr '\n' ' ' < "$FILE" 2>/dev/null | \
    grep -oE 'export \{[^}]*\}' | \
    sed -E 's/export \{([^}]*)\}/\1/' | \
    tr ',' '\n' | \
    sed -E 's/^[[:space:]]*//;s/[[:space:]]*$//' | \
    sed -E 's/[[:space:]]+as[[:space:]]+[a-zA-Z_][a-zA-Z0-9_]*//' | \
    sed -E 's/^type[[:space:]]+//' | \
    grep -E '^[a-zA-Z_][a-zA-Z0-9_]*$' || true

  # "export default"
  grep -q 'export default' "$FILE" 2>/dev/null && echo "__default__" || true
} | sort -u
