#!/bin/bash

# Grog Hook: on-stuck (bidirectional)
# Sends question to Telegram and waits for reply so Claude can continue
# even when the user is away from the terminal.
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

# Send question to Telegram
node "$GROG_TOOL" notify "🔔 Claude is stuck in [$FOLDER]
📁 $CWD

$QUESTION

Reply here to answer." >/dev/null 2>&1

# Wait for response (~90s)
RESPONSE=$(node "$GROG_TOOL" telegram-recv 2>/dev/null)

if [ "$RESPONSE" = "[no message]" ] || [ -z "$RESPONSE" ]; then
  ESCAPED=$(echo "No response from Telegram after ~90s. State the blocker clearly in the terminal output, then make your best judgment call and continue working. Do NOT call AskUserQuestion again for the same question." | jq -Rs .)
  echo "{\"decision\":\"block\",\"reason\":$ESCAPED}"
else
  ESCAPED=$(echo "Telegram response from the user: $RESPONSE" | jq -Rs .)
  echo "{\"decision\":\"block\",\"reason\":$ESCAPED}"
fi
