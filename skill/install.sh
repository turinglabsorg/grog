#!/bin/bash

# GROG Installer
# Installs grog to ~/.claude/tools/grog and creates the agent skills (install-skills.sh)
# Config stored at ~/.grog/config.json

set -e

# Terminal style - no colors, monospace aesthetic
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

echo ""
echo "┌──────────────────────────────────────────┐"
echo "│                                          │"
echo "│   ██████  ██████   ██████   ██████       │"
echo "│  ██       ██   ██ ██    ██ ██            │"
echo "│  ██   ███ ██████  ██    ██ ██   ███      │"
echo "│  ██    ██ ██   ██ ██    ██ ██    ██      │"
echo "│   ██████  ██   ██  ██████   ██████       │"
echo "│                                          │"
echo "│  github + linear for claude code          │"
echo "│                                          │"
echo "└──────────────────────────────────────────┘"
echo ""

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Target directories
TOOLS_DIR="$HOME/.claude/tools/grog"
SKILLS_DIR="$HOME/.agents/skills"
GROG_CONFIG_DIR="$HOME/.grog"
GROG_CONFIG="$GROG_CONFIG_DIR/config.json"

# Helper: set a key in ~/.grog/config.json using jq
set_config_val() {
  local key="$1" val="$2"
  if [ ! -f "$GROG_CONFIG" ]; then
    echo '{}' > "$GROG_CONFIG"
  fi
  local tmp
  tmp=$(jq --arg k "$key" --arg v "$val" '.[$k] = $v' "$GROG_CONFIG")
  echo "$tmp" > "$GROG_CONFIG"
  chmod 600 "$GROG_CONFIG"
}

get_config_val() {
  local key="$1"
  jq -r --arg k "$key" '.[$k] // empty' "$GROG_CONFIG" 2>/dev/null
}

# Legacy .env helper (kept for backward compat during migration)
set_env_var() {
  local key="$1" val="$2" file="$TOOLS_DIR/.env"
  touch "$file"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    local tmp
    tmp=$(grep -v "^${key}=" "$file")
    printf '%s\n' "$tmp" > "$file"
    echo "${key}=${val}" >> "$file"
  else
    echo "${key}=${val}" >> "$file"
  fi
  chmod 600 "$file"
}

echo -e "${BOLD}[1/8]${NC} creating directories..."
mkdir -p "$TOOLS_DIR"
mkdir -p "$GROG_CONFIG_DIR"
echo "  > $TOOLS_DIR"
echo "  > $GROG_CONFIG_DIR"

echo ""
echo -e "${BOLD}[2/8]${NC} copying files..."
for file in index.js board.js discord-client.js github-issues.js package.json package-lock.json; do
  cp "$SCRIPT_DIR/$file" "$TOOLS_DIR/"
done
echo "  > index.js, its modules, package.json and package-lock.json"

echo ""
echo -e "${BOLD}[3/8]${NC} installing dependencies..."
cd "$TOOLS_DIR"
npm ci --silent
echo "  > dependencies installed"

# Migrate existing .env values to config.json if they exist
if [ -f "$TOOLS_DIR/.env" ]; then
  EXISTING_GH=$(grep "^GH_TOKEN=" "$TOOLS_DIR/.env" 2>/dev/null | cut -d'=' -f2-)
  EXISTING_TG_TOKEN=$(grep "^TELEGRAM_BOT_TOKEN=" "$TOOLS_DIR/.env" 2>/dev/null | cut -d'=' -f2-)
  EXISTING_TG_CHAT=$(grep "^TELEGRAM_CHAT_ID=" "$TOOLS_DIR/.env" 2>/dev/null | cut -d'=' -f2-)
  EXISTING_DISCORD_TOKEN=$(grep "^DISCORD_BOT_TOKEN=" "$TOOLS_DIR/.env" 2>/dev/null | cut -d'=' -f2-)
  EXISTING_DISCORD_CHANNEL=$(grep "^DISCORD_CHANNEL_ID=" "$TOOLS_DIR/.env" 2>/dev/null | cut -d'=' -f2-)

  if [ -n "$EXISTING_GH" ] && [ -z "$(get_config_val ghToken)" ]; then
    set_config_val "ghToken" "$EXISTING_GH"
  fi
  if [ -n "$EXISTING_TG_TOKEN" ] && [ -z "$(get_config_val telegramBotToken)" ]; then
    set_config_val "telegramBotToken" "$EXISTING_TG_TOKEN"
  fi
  if [ -n "$EXISTING_TG_CHAT" ] && [ -z "$(get_config_val telegramChatId)" ]; then
    set_config_val "telegramChatId" "$EXISTING_TG_CHAT"
  fi
  if [ -n "$EXISTING_DISCORD_TOKEN" ] && [ -z "$(get_config_val discordBotToken)" ]; then
    set_config_val "discordBotToken" "$EXISTING_DISCORD_TOKEN"
  fi
  if [ -n "$EXISTING_DISCORD_CHANNEL" ] && [ -z "$(get_config_val discordChannelId)" ]; then
    set_config_val "discordChannelId" "$EXISTING_DISCORD_CHANNEL"
  fi
fi

echo ""
echo -e "${BOLD}[4/8]${NC} configuring GitHub token..."
echo ""
echo "To fetch GitHub issues, grog needs a Personal Access Token."
echo "You can create one at: https://github.com/settings/tokens"
echo "Required scope: repo (for private repos) or public_repo (for public only)"
echo ""

# Check if token already exists
CURRENT_GH_TOKEN=$(get_config_val "ghToken")
if [ -n "$CURRENT_GH_TOKEN" ]; then
    echo "  a token already exists in $GROG_CONFIG"
    read -p "  replace it? (y/N): " REPLACE_TOKEN
    if [[ ! "$REPLACE_TOKEN" =~ ^[Yy]$ ]]; then
        echo "  > keeping existing token"
        SKIP_TOKEN=true
    fi
fi

if [ "$SKIP_TOKEN" != "true" ]; then
    read -p "Enter your GitHub token (ghp_...): " GH_TOKEN_INPUT

    if [ -z "$GH_TOKEN_INPUT" ]; then
        echo "  ! no token provided. add it manually to $GROG_CONFIG"
    else
        set_config_val "ghToken" "$GH_TOKEN_INPUT"
        # Also write to .env for backward compat
        set_env_var "GH_TOKEN" "$GH_TOKEN_INPUT"
        echo "  > token saved to $GROG_CONFIG"
    fi
fi

echo ""
echo -e "${BOLD}[5/8]${NC} configuring Linear workspaces (optional, multi-workspace)..."
echo ""
echo "  grog supports multiple Linear workspaces. Each project declares which one"
echo "  to use via a '.grog' file in its root (workspace=NAME)."
echo "  Create API keys at: https://linear.app/settings/api"
echo ""

EXISTING_LINEAR_OBJ=$(jq -r '.linear // empty | keys[]?' "$GROG_CONFIG" 2>/dev/null)
if [ -n "$EXISTING_LINEAR_OBJ" ]; then
    echo "  configured workspaces:"
    echo "$EXISTING_LINEAR_OBJ" | sed 's/^/    - /'
    echo ""
fi

while true; do
    read -p "  add a Linear workspace? (y/N): " ADD_WS
    if [[ ! "$ADD_WS" =~ ^[Yy]$ ]]; then break; fi
    read -p "    workspace name (e.g. MTROPRO, KAIROS): " WS_NAME
    read -p "    Linear API key for $WS_NAME: " WS_KEY
    if [ -n "$WS_NAME" ] && [ -n "$WS_KEY" ]; then
        if [ ! -f "$GROG_CONFIG" ]; then echo '{}' > "$GROG_CONFIG"; fi
        tmp=$(jq --arg n "$WS_NAME" --arg k "$WS_KEY" '.linear[$n] = $k' "$GROG_CONFIG")
        echo "$tmp" > "$GROG_CONFIG"
        chmod 600 "$GROG_CONFIG"
        echo "    > saved workspace '$WS_NAME' in $GROG_CONFIG"
    fi
done

# Migrate legacy top-level linearApiKey into .linear.DEFAULT if present and no workspaces defined
LEGACY_KEY=$(get_config_val "linearApiKey")
if [ -n "$LEGACY_KEY" ] && [ -z "$(jq -r '.linear // empty | keys[]?' "$GROG_CONFIG" 2>/dev/null)" ]; then
    echo "  migrating legacy 'linearApiKey' to linear.DEFAULT"
    tmp=$(jq --arg k "$LEGACY_KEY" '.linear.DEFAULT = $k | del(.linearApiKey)' "$GROG_CONFIG")
    echo "$tmp" > "$GROG_CONFIG"
    chmod 600 "$GROG_CONFIG"
fi

echo ""
echo -e "${BOLD}[6/8]${NC} configuring Telegram (optional)..."
echo ""
echo "  grog talk lets you interact with Claude Code remotely via Telegram."
echo "  /grog-talk lets you interact with Claude Code remotely via Telegram."
echo "  to set it up, create a bot at https://t.me/BotFather"
echo ""

SKIP_TG=false

CURRENT_TG_TOKEN=$(get_config_val "telegramBotToken")
if [ -n "$CURRENT_TG_TOKEN" ]; then
    echo "  a Telegram bot token already exists"
    read -p "  replace it? (y/N): " REPLACE_TG
    if [[ ! "$REPLACE_TG" =~ ^[Yy]$ ]]; then
        echo "  > keeping existing Telegram config"
        SKIP_TG=true
    fi
fi

if [ "$SKIP_TG" != "true" ]; then
    read -p "  enter your Telegram bot token (or press Enter to skip): " TG_BOT_TOKEN

    if [ -n "$TG_BOT_TOKEN" ]; then
        set_config_val "telegramBotToken" "$TG_BOT_TOKEN"
        set_env_var "TELEGRAM_BOT_TOKEN" "$TG_BOT_TOKEN"
        echo ""
        echo "  chat ID is optional — grog talk can auto-detect it when you first connect."
        read -p "  enter your Telegram chat ID (or press Enter to auto-detect later): " TG_CHAT_ID
        if [ -n "$TG_CHAT_ID" ]; then
            set_config_val "telegramChatId" "$TG_CHAT_ID"
            set_env_var "TELEGRAM_CHAT_ID" "$TG_CHAT_ID"
        fi
        echo "  > Telegram config saved to $GROG_CONFIG"
    else
        echo "  > skipped. add telegramBotToken to $GROG_CONFIG later to enable."
    fi
fi

echo ""
echo -e "${BOLD}[7/8]${NC} configuring Discord (optional)..."
echo ""
echo "  Create a Discord application and bot at https://discord.com/developers/applications"
echo "  Enable Message Content Intent in Bot settings, then grant View Channels,"
echo "  Read Message History, and Send Messages in every channel Grog should access."
echo ""

SKIP_DISCORD=false
CURRENT_DISCORD_TOKEN=$(get_config_val "discordBotToken")
if [ -n "$CURRENT_DISCORD_TOKEN" ]; then
    echo "  a Discord bot token already exists"
    read -p "  replace it? (y/N): " REPLACE_DISCORD
    if [[ ! "$REPLACE_DISCORD" =~ ^[Yy]$ ]]; then
        echo "  > keeping existing Discord config"
        SKIP_DISCORD=true
    fi
fi

if [ "$SKIP_DISCORD" != "true" ]; then
    read -p "  enter your Discord bot token (or press Enter to skip): " DISCORD_TOKEN
    if [ -n "$DISCORD_TOKEN" ]; then
        set_config_val "discordBotToken" "$DISCORD_TOKEN"
        set_env_var "DISCORD_BOT_TOKEN" "$DISCORD_TOKEN"
        read -p "  enter an optional default Discord channel ID (Enter = all-server mode): " DISCORD_CHANNEL
        if [ -n "$DISCORD_CHANNEL" ]; then
            set_config_val "discordChannelId" "$DISCORD_CHANNEL"
            set_env_var "DISCORD_CHANNEL_ID" "$DISCORD_CHANNEL"
        fi
        echo "  > Discord config saved to $GROG_CONFIG"
    else
        echo "  > skipped. add discordBotToken to $GROG_CONFIG later."
    fi
fi

echo ""
echo -e "${BOLD}[8/8]${NC} creating the agent skills..."
bash "$SCRIPT_DIR/install-skills.sh"

echo ""
echo "┌──────────────────────────────────────────────────────────┐"
echo "│  installation complete.                                  │"
echo "└──────────────────────────────────────────────────────────┘"
echo ""
echo "  commands available in any Claude Code session:"
echo ""
echo "    /grog-solve <issue-url>     fetch and solve an issue (GitHub or Linear)"
echo "    /grog-explore <url>         list all issues for batch processing"
echo "    /grog-review <pr-url>       review a pull request (GitHub only)"
echo "    /grog-answer <url>          post a summary comment to an issue or PR"
echo "    /grog-create linear ...     create a Linear issue"
echo "    /grog-talk                  connect Telegram, WhatsApp, or Discord"
echo ""
echo "  github examples:"
echo "    /grog-solve https://github.com/owner/repo/issues/123"
echo "    /grog-explore https://github.com/orgs/myorg/projects/1"
echo "    /grog-explore https://github.com/owner/repo"
echo "    /grog-review https://github.com/owner/repo/pull/123"
echo "    /grog-answer https://github.com/owner/repo/issues/123"
echo ""
echo "  linear examples:"
echo "    /grog-solve https://linear.app/workspace/issue/PROJ-123"
echo "    /grog-explore https://linear.app/workspace/team/PROJ"
echo "    /grog-explore https://linear.app/workspace"
echo "    /grog-create linear --team PROJ --title \"Bug title\" --description-file /tmp/body.md"
echo "    /grog-answer https://linear.app/workspace/issue/PROJ-123"
echo ""
echo "    /grog-talk"
echo "    /grog-talk --discord"
echo ""
echo "  files:"
echo "    config: $GROG_CONFIG"
echo "    tool:   $TOOLS_DIR"
echo "    skills: $SKILLS_DIR/grog-* (linked from ~/.claude/skills)"
echo ""
