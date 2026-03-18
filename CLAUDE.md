# Grog — Claude Code Skill System

Autonomous GitHub workflow tool and Telegram bridge for Claude Code.

## Architecture

```
~/.grog/config.json          Central config (ghToken, telegramBotToken, telegramChatId)
~/.claude/tools/grog/        Runtime (index.js, node_modules, hooks/)
~/.claude/skills/grog-*/     Skill definitions (SKILL.md files)
~/.claude/settings.json      Hook registration (PreToolUse → on-stuck)
~/.claude/CLAUDE.md          Global directives (Grog autonomous protocol)
```

## Config

All credentials live in `~/.grog/config.json`:

```json
{
  "ghToken": "ghp_...",
  "telegramBotToken": "123456:ABC...",
  "telegramChatId": "12345678"
}
```

Fallback: `~/.claude/tools/grog/.env` (legacy, kept for backward compat).

## Skills

| Skill | Purpose |
|-------|---------|
| `/grog-solve <issue-url>` | Fetch a GitHub issue and solve it |
| `/grog-explore <repo-url>` | List issues for batch processing |
| `/grog-review <pr-url>` | Review a pull request |
| `/grog-answer <url>` | Post a summary comment to issue/PR |
| `/grog-talk` | Bidirectional Telegram bridge |

## On-Stuck Hook

A `PreToolUse` hook intercepts `AskUserQuestion` calls:

1. Claude gets stuck and tries to ask a question
2. Hook (`~/.claude/tools/grog/hooks/on-stuck.sh`) intercepts it
3. Question is sent to Telegram via `grog notify` (includes folder name + full path)
4. Hook calls `telegram-recv` and waits ~90s for the user's reply
5. If reply arrives: hook returns it in the `reason` field → Claude continues with the answer
6. If no reply: hook tells Claude to make its best judgment and keep working

Fully bidirectional — Claude never stops, never needs to manually call `telegram-recv`.

**Requirement:** `telegramBotToken` and `telegramChatId` must be set in `~/.grog/config.json`. If not configured, the hook passes through and `AskUserQuestion` works normally.

## CLI Commands (index.js)

```
grog solve <issue-url>            Fetch issue details
grog explore <repo-or-project>    List issues for batch work
grog review <pr-url>              Fetch PR for code review
grog answer <url> <file>          Post comment to issue/PR
grog talk                         Start Telegram bridge session
grog notify <message>             Send TG notification (no talk session needed)
grog telegram-send <msg-or-file>  Send message to TG (needs talk or chat ID)
grog telegram-recv                Long-poll for TG message (~90s)
```

## Global CLAUDE.md Directives

The global `~/.claude/CLAUDE.md` includes a "Grog — Autonomous Assistance" section that instructs every Claude Code session to:
- Use Grog skills for all GitHub workflows
- Follow the Telegram response protocol when `AskUserQuestion` is blocked
- Retry `telegram-recv` up to 5 times before giving up

## Development

```bash
# Build and test
cd skill/
node index.js solve https://github.com/owner/repo/issues/1

# Install/reinstall skills + hooks
bash skill/install.sh

# Project structure
skill/
  index.js          All CLI commands (solve, explore, review, answer, talk, notify, telegram-*)
  install.sh        Installer (copies files, sets up config, registers hooks, updates CLAUDE.md)
  hooks/
    on-stuck.sh     PreToolUse hook for AskUserQuestion → Telegram notification
  package.json      Dependencies (dotenv)

agent/              Self-hosted agent server (webhook, runner, dashboard)
api/                SaaS API (OAuth, billing)
app/                SaaS frontend (React + Vite)
shared/             Shared types, state manager, GitHub API helpers
```

## Personality

Default: sarcastic, opinionated, concise. Override per-repo with `.grog/config.json`:

```json
{
  "personality": {
    "tone": "formal and professional",
    "style": "concise RFC-like technical writing"
  }
}
```
