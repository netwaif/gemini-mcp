#!/bin/bash
# gemini-mcp installer
# Usage: bash install.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
fail()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

echo "=== gemini-mcp installer ==="
echo ""

# 1. Check Bun
if command -v bun &>/dev/null; then
  info "Bun found: $(bun --version)"
else
  warn "Bun not found. Installing..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  if command -v bun &>/dev/null; then
    info "Bun installed: $(bun --version)"
  else
    fail "Bun installation failed. Please install manually: https://bun.sh"
  fi
fi

# 2. Check Gemini CLI
if command -v gemini &>/dev/null; then
  info "Gemini CLI found"
else
  warn "Gemini CLI not found. Installing..."
  npm install -g @google/gemini-cli
  if command -v gemini &>/dev/null; then
    info "Gemini CLI installed"
  else
    fail "Gemini CLI installation failed. Please install manually: npm install -g @google/gemini-cli"
  fi
fi

# 3. Determine install path
PLUGIN_DIR="$HOME/.claude/plugins/local"
INSTALL_DIR="$PLUGIN_DIR/gemini-mcp"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$SCRIPT_DIR" = "$INSTALL_DIR" ]; then
  info "Already in plugin directory"
else
  mkdir -p "$PLUGIN_DIR"
  if [ -d "$INSTALL_DIR" ]; then
    warn "Existing installation found at $INSTALL_DIR — updating..."
    cd "$INSTALL_DIR" && git pull
  else
    git clone https://github.com/netwaif/gemini-mcp.git "$INSTALL_DIR"
  fi
  info "Installed to $INSTALL_DIR"
fi

# 4. Install dependencies
cd "$INSTALL_DIR"
bun install --frozen-lockfile 2>/dev/null || bun install
info "Dependencies installed"

# 5. Claude Desktop App config
DESKTOP_CONFIG=""
if [ "$(uname)" = "Darwin" ]; then
  DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
elif [ "$(uname)" = "Linux" ]; then
  DESKTOP_CONFIG="$HOME/.config/Claude/claude_desktop_config.json"
fi

if [ -n "$DESKTOP_CONFIG" ]; then
  BUN_PATH=$(command -v bun)
  if [ -f "$DESKTOP_CONFIG" ]; then
    if grep -q '"gemini"' "$DESKTOP_CONFIG" 2>/dev/null; then
      info "Claude Desktop config already has gemini entry"
    else
      warn "Claude Desktop config exists but no gemini entry."
      echo "  Add this to mcpServers in: $DESKTOP_CONFIG"
      echo ""
      echo "  \"gemini\": {"
      echo "    \"command\": \"$BUN_PATH\","
      echo "    \"args\": [\"run\", \"--cwd\", \"$INSTALL_DIR\", \"--shell=bun\", \"--silent\", \"start\"]"
      echo "  }"
    fi
  else
    mkdir -p "$(dirname "$DESKTOP_CONFIG")"
    cat > "$DESKTOP_CONFIG" <<CONF
{
  "mcpServers": {
    "gemini": {
      "command": "$BUN_PATH",
      "args": ["run", "--cwd", "$INSTALL_DIR", "--shell=bun", "--silent", "start"]
    }
  }
}
CONF
    info "Claude Desktop config created at $DESKTOP_CONFIG"
  fi
fi

echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Restart Claude Code or Claude Desktop App"
echo "  2. If using Gemini CLI for the first time, run 'gemini' to authenticate"
echo "  3. (Desktop App only) Import the skill file: gemini.skill"
echo "     - Open Settings > Skills > gemini > ... > Replace"
echo "     - Select the gemini.skill file from: $INSTALL_DIR/gemini.skill"
