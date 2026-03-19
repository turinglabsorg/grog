# Grog — Claude Code Skill System

Autonomous GitHub workflow tool and Telegram bridge for Claude Code.

## Architecture

```
~/.grog/config.json          Central config (ghToken, telegramBotToken, telegramChatId)
~/.claude/tools/grog/        Runtime (index.js, node_modules)
~/.claude/skills/grog-*/     Skill definitions (SKILL.md files)
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

## Development

```bash
# Build and test
cd skill/
node index.js solve https://github.com/owner/repo/issues/1

# Install/reinstall skills
bash skill/install.sh

# Project structure
skill/
  index.js          All CLI commands (solve, explore, review, answer, talk, notify, telegram-*)
  install.sh        Installer (copies files, sets up config)
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
