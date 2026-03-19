#!/bin/bash

# Grog Hook: on-approve (notification only)
# Sends a Telegram notification when Claude wants to use a tool that
# would normally require terminal approval. Does NOT block — the
# terminal yes/no prompt still works normally.
#
# Hook type: PreToolUse (no matcher = catches all tools)

GROG_TOOL="$HOME/.claude/tools/grog/index.js"
GROG_CONFIG="$HOME/.grog/config.json"

# Read the tool input from stdin
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')

# Skip tools that are always safe / read-only / handled elsewhere
case "$TOOL_NAME" in
  Read|Glob|Grep|LSP|WebSearch|WebFetch|Agent|TodoRead|TaskGet|TaskList|TaskOutput|AskUserQuestion)
    exit 0
    ;;
esac

# Check if Telegram is configured
if [ ! -f "$GROG_CONFIG" ]; then
  exit 0
fi

HAS_TOKEN=$(jq -r '.telegramBotToken // empty' "$GROG_CONFIG" 2>/dev/null)
HAS_CHAT=$(jq -r '.telegramChatId // empty' "$GROG_CONFIG" 2>/dev/null)

if [ -z "$HAS_TOKEN" ] || [ -z "$HAS_CHAT" ]; then
  exit 0
fi

# Build a concise summary
case "$TOOL_NAME" in
  Bash)
    DETAIL=$(echo "$INPUT" | jq -r '.tool_input.command // "(no command)"' | head -c 300)
    SUMMARY="$DETAIL"
    ;;
  Edit)
    FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // "?"')
    SUMMARY="Edit $FILE"
    ;;
  Write)
    FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // "?"')
    SUMMARY="Write $FILE"
    ;;
  *)
    SUMMARY=$(echo "$INPUT" | jq -r '.tool_input | keys | join(", ")' 2>/dev/null || echo "$TOOL_NAME")
    ;;
esac

CWD=$(pwd)
FOLDER=$(basename "$CWD")

# Send notification in background (fire-and-forget)
node "$GROG_TOOL" notify "🔧 [$FOLDER] $TOOL_NAME
$SUMMARY" >/dev/null 2>&1 &

# Exit 0 = pass through, terminal prompt still works
exit 0
