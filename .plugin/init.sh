#!/bin/bash
# Power User Toolkit — Installer
# Installs the plugin into any repo's .claude/ directory
#
# Usage:
#   curl -s <url>/init.sh | bash
#   OR
#   bash /path/to/.plugin/init.sh [target-dir]
#
# What it does:
# 1. Copies plugin files to .claude/ in the target repo
# 2. Sets up hooks, agents, skills, output styles
# 3. Configures the thorough output style as default
# 4. Adds plugin state files to .gitignore

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()   { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; exit 1; }
info()  { echo -e "${BLUE}[i]${NC} $1"; }

# Determine source directory (where this script lives)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-$(pwd)}"

# Validate target
if [ ! -d "$TARGET_DIR" ]; then
    error "Target directory does not exist: $TARGET_DIR"
fi

# Check if it's a git repo (preferred but not required)
if [ -d "$TARGET_DIR/.git" ]; then
    info "Installing into git repository: $TARGET_DIR"
else
    warn "Not a git repository. Installing anyway."
fi

CLAUDE_DIR="$TARGET_DIR/.claude"

log "Creating .claude directory structure..."
mkdir -p "$CLAUDE_DIR"/{agents,commands,hooks,output-styles}
mkdir -p "$CLAUDE_DIR"/skills/{verify,check-coverage}

# Copy agents
log "Installing agents..."
cp "$SCRIPT_DIR/agents/scout.md" "$CLAUDE_DIR/agents/"
cp "$SCRIPT_DIR/agents/verifier.md" "$CLAUDE_DIR/agents/"
cp "$SCRIPT_DIR/agents/thorough-worker.md" "$CLAUDE_DIR/agents/"

# Copy skills
log "Installing skills..."
cp "$SCRIPT_DIR/skills/verify/SKILL.md" "$CLAUDE_DIR/skills/verify/"
cp "$SCRIPT_DIR/skills/check-coverage/SKILL.md" "$CLAUDE_DIR/skills/check-coverage/"

# Copy commands
log "Installing commands..."
cp "$SCRIPT_DIR/commands/scan.md" "$CLAUDE_DIR/commands/"

# Copy output styles
log "Installing output styles..."
cp "$SCRIPT_DIR/output-styles/thorough.md" "$CLAUDE_DIR/output-styles/"

# Copy hooks
log "Installing hooks..."
cp "$SCRIPT_DIR/hooks/stop-verify.sh" "$CLAUDE_DIR/hooks/"
cp "$SCRIPT_DIR/hooks/pre-compact.sh" "$CLAUDE_DIR/hooks/"
cp "$SCRIPT_DIR/hooks/post-tool-track.sh" "$CLAUDE_DIR/hooks/"
chmod +x "$CLAUDE_DIR/hooks/"*.sh

# Create hook state directories
mkdir -p "$CLAUDE_DIR/hooks"

# Install CLAUDE.md (append if exists, create if not)
CLAUDE_MD="$TARGET_DIR/CLAUDE.md"
if [ -f "$CLAUDE_MD" ]; then
    warn "CLAUDE.md already exists. Appending power-user rules..."
    echo "" >> "$CLAUDE_MD"
    echo "# --- Power User Toolkit (auto-appended) ---" >> "$CLAUDE_MD"
    cat "$SCRIPT_DIR/CLAUDE.md" >> "$CLAUDE_MD"
else
    log "Creating CLAUDE.md with power-user rules..."
    cp "$SCRIPT_DIR/CLAUDE.md" "$CLAUDE_MD"
fi

# Create corrections and experience files
touch "$CLAUDE_DIR/hooks/.corrections"
touch "$CLAUDE_DIR/hooks/.experience"

# Configure settings.json for hooks
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
    info "settings.json already exists — hooks must be configured manually."
    info "Add the following to your settings.json hooks section:"
    cat <<'HOOKEOF'

  "hooks": {
    "Stop": [
      { "type": "command", "command": "bash .claude/hooks/stop-verify.sh", "timeout": 30000 }
    ],
    "PreCompact": [
      { "type": "command", "command": "bash .claude/hooks/pre-compact.sh", "timeout": 10000 }
    ],
    "PostToolUse": [
      {
        "type": "command",
        "command": "bash .claude/hooks/post-tool-track.sh",
        "timeout": 5000,
        "matcher": { "tool_name": "FileEditTool|FileWriteTool|NotebookEditTool" }
      }
    ]
  }

HOOKEOF
else
    log "Creating settings.json with hook configuration..."
    cat > "$SETTINGS_FILE" <<'EOF'
{
  "hooks": {
    "Stop": [
      {
        "type": "command",
        "command": "bash .claude/hooks/stop-verify.sh",
        "timeout": 30000
      }
    ],
    "PreCompact": [
      {
        "type": "command",
        "command": "bash .claude/hooks/pre-compact.sh",
        "timeout": 10000
      }
    ],
    "PostToolUse": [
      {
        "type": "command",
        "command": "bash .claude/hooks/post-tool-track.sh",
        "timeout": 5000,
        "matcher": {
          "tool_name": "FileEditTool|FileWriteTool|NotebookEditTool"
        }
      }
    ]
  }
}
EOF
fi

# Update .gitignore
GITIGNORE="$TARGET_DIR/.gitignore"
IGNORE_ENTRIES=(
    ".claude/hooks/.corrections"
    ".claude/hooks/.experience"
    ".claude/hooks/.changes-log"
    ".claude/hooks/.verify-active"
    ".claude/hooks/.skip-verify"
)

if [ -f "$GITIGNORE" ]; then
    for entry in "${IGNORE_ENTRIES[@]}"; do
        if ! grep -qF "$entry" "$GITIGNORE" 2>/dev/null; then
            echo "$entry" >> "$GITIGNORE"
        fi
    done
    log "Updated .gitignore with plugin state files"
else
    printf '%s\n' "${IGNORE_ENTRIES[@]}" > "$GITIGNORE"
    log "Created .gitignore with plugin state files"
fi

echo ""
log "================================================================"
log "  Power User Toolkit installed successfully!"
log "================================================================"
echo ""
info "What was installed:"
echo "  Agents:       scout (Haiku), verifier (Sonnet), thorough-worker (Sonnet)"
echo "  Skills:       /verify, /check-coverage"
echo "  Commands:     /scan"
echo "  Output Style: thorough (removes lazy instructions)"
echo "  Hooks:        stop-verify, pre-compact, post-tool-track"
echo "  CLAUDE.md:    ANT-grade verification instructions"
echo ""
info "Quick start:"
echo "  1. Set output style:  /config → Output style → thorough"
echo "  2. Explore codebase:  /scan"
echo "  3. Verify work:       /verify"
echo "  4. Check coverage:    /check-coverage"
echo ""
info "Environment variables (optional):"
echo "  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=60   # Compact earlier for better summaries"
echo "  CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE=195000  # Higher context limit"
echo ""
info "To add corrections that survive compaction:"
echo "  echo 'Always check imports after rename' >> .claude/hooks/.corrections"
echo ""
info "To add experience rules:"
echo "  echo 'Use TypeScript strict mode in this project' >> .claude/hooks/.experience"
echo ""
