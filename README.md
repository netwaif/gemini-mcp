# gemini-mcp

Claude Code plugin that bridges to Google Gemini CLI for multimodal tasks.

Claude Code is powerful at coding and reasoning, but weaker at image/vision tasks. This MCP server lets Claude automatically delegate multimodal work to Gemini — the best of both worlds.

## Tools

| Tool | Description |
|------|-------------|
| `gemini_prompt` | Send a text prompt to Gemini |
| `gemini_vision` | Analyze images using Gemini's multimodal capabilities |
| `gemini_code` | Delegate code review or analysis to Gemini |
| `gemini_summarize` | Summarize long text or files |

All tools support optional parameters:
- **`timeout`** — Timeout in seconds (default: 120)
- **`language`** — Response language: `"ko"`, `"en"`, `"ja"`, `"zh"`, or any language name. Use `"none"` to skip

> **Note:** Uses `gemini-3-flash-preview` model (the only model currently available in Gemini CLI).

## Supported Platforms

| OS | Status | Notes |
|----|--------|-------|
| macOS | Fully supported | Primary development platform |
| Linux | Fully supported | |
| Windows | Fully supported | Requires Bun and Gemini CLI on PATH |

## Prerequisites

- [Bun](https://bun.sh) runtime (macOS, Linux, Windows)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and authenticated

```bash
# Install Gemini CLI
npm install -g @google/gemini-cli

# Authenticate (run once)
gemini
```

## Installation

### As a Claude Code Plugin (Recommended)

Clone this repo into your Claude Code plugins directory:

**macOS / Linux:**
```bash
mkdir -p ~/.claude/plugins/local
cd ~/.claude/plugins/local
git clone https://github.com/netwaif/gemini-mcp.git
```

**Windows (PowerShell):**
```powershell
mkdir -Force "$env:USERPROFILE\.claude\plugins\local"
cd "$env:USERPROFILE\.claude\plugins\local"
git clone https://github.com/netwaif/gemini-mcp.git
```

Restart Claude Code — the plugin will be auto-discovered.

### As a standalone MCP server

Add to your MCP config (`~/.mcp.json` on macOS/Linux, `%USERPROFILE%\.mcp.json` on Windows):

```json
{
  "mcpServers": {
    "gemini": {
      "command": "bun",
      "args": ["run", "--cwd", "/path/to/gemini-mcp", "--shell=bun", "--silent", "start"]
    }
  }
}
```

### With Claude Desktop App

Claude Desktop uses its own config file. Edit the following file (create it if it doesn't exist):

**macOS:**
```
~/Library/Application Support/Claude/claude_desktop_config.json
```

**Windows:**
```
%APPDATA%\Claude\claude_desktop_config.json
```

Add the Gemini MCP server config — note that you must use an **absolute path** (not `${CLAUDE_PLUGIN_ROOT}`):

**macOS / Linux:**
```json
{
  "mcpServers": {
    "gemini": {
      "command": "bun",
      "args": ["run", "--cwd", "/absolute/path/to/gemini-mcp", "--shell=bun", "--silent", "start"]
    }
  }
}
```

**Windows:**
```json
{
  "mcpServers": {
    "gemini": {
      "command": "bun",
      "args": ["run", "--cwd", "C:\\Users\\YourName\\.claude\\plugins\\local\\gemini-mcp", "--shell=bun", "--silent", "start"]
    }
  }
}
```

> **Tip:** If `bun` is not found, use the full path (e.g., `/opt/homebrew/bin/bun` on macOS or `C:\Users\YourName\.bun\bin\bun.exe` on Windows).

Restart the Claude Desktop app to load the new MCP server.

## How it works

```
Claude Code  →  MCP Server (this)  →  Gemini CLI  →  Gemini API
                (stdio transport)      (subprocess)
```

1. Claude decides it needs Gemini (e.g., for image analysis)
2. Calls the appropriate MCP tool (`gemini_vision`, etc.)
3. This server spawns `gemini --approval-mode yolo -p "..." --model=...`
4. Returns Gemini's response back to Claude

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_PATH` | `gemini` | Path to the Gemini CLI binary |

## License

MIT
