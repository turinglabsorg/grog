#!/bin/bash

# Grog Hook: on-stuck (notification only)
# Sends a Telegram notification when Claude calls AskUserQuestion.
# Does NOT block — the terminal prompt still works normally.
#
# Hook type: PreToolUse (matcher: AskUserQuestion)

GROG_TOOL="$HOME/.claude/tools/grog/index.js"
GROG_CONFIG="$HOME/.grog/config.json"

# Read the tool input from stdin
INPUT=$(cat)

# Extract the question
QUESTION=$(echo "$INPUT" | jq -r '.tool_input.question // .tool_input.message // .tool_input.text // "Claude needs help but no details were provided"')

# Check if Telegram is configured
if [ ! -f "$GROG_CONFIG" ]; then
  exit 0
fi

HAS_TOKEN=$(jq -r '.telegramBotToken // empty' "$GROG_CONFIG" 2>/dev/null)
HAS_CHAT=$(jq -r '.telegramChatId // empty' "$GROG_CONFIG" 2>/dev/null)

if [ -z "$HAS_TOKEN" ] || [ -z "$HAS_CHAT" ]; then
  exit 0
fi

CWD=$(pwd)
FOLDER=$(basename "$CWD")

# Send notification in background (fire-and-forget) so we don't block the terminal
node "$GROG_TOOL" notify "🔔 Claude is stuck in [$FOLDER]
📁 $CWD

$QUESTION" >/dev/null 2>&1 &

# Exit 0 = pass through, terminal prompt still works
exit 0
