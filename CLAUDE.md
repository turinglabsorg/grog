# Grog — Claude Code Skill System

Autonomous GitHub + Linear workflow tool and multi-channel messaging bridge for Claude Code.

## Architecture

```
~/.grog/config.json          Central config (GitHub, Linear, Telegram, WhatsApp, Discord)
~/.claude/tools/grog/        Runtime (index.js, node_modules)
~/.claude/skills/grog-*/     Skill definitions (SKILL.md files)
<project>/.grog              Per-project file: workspace=<NAME> (REQUIRED for Linear)
```

## Config

All credentials live in `~/.grog/config.json`:

```json
{
  "ghToken": "ghp_...",
  "linear": {
    "MTROPRO": "lin_api_...",
    "KAIROS":  "lin_api_..."
  },
  "telegramBotToken": "123456:ABC...",
  "telegramChatId": "12345678",
  "discordBotToken": "discord-bot-token",
  "discordChannelId": "123456789012345678"
}
```

### Linear workspace resolution (multi-workspace)

Linear calls are scoped per project. grog walks up from the current working
directory looking for a `.grog` file with `workspace=NAME`, then resolves
the key from `config.linear[NAME]`. **There is NO default** — if the `.grog`
file is missing or the workspace name is not in config, grog refuses to
touch Linear and exits with a clear error listing the configured workspaces.

Override order (first hit wins):
1. `GROG_WORKSPACE` env var
2. `.grog` file found by walking upward from `cwd`
3. (no fallback — explicit by design)

Example `.grog` in a project root:
```
workspace=KAIROS
```

Fallback: `~/.claude/tools/grog/.env` (legacy, kept for backward compat).

## Skills

| Skill | Purpose |
|-------|---------|
| `/grog-solve <issue-url>` | Fetch a GitHub or Linear issue and solve it |
| `/grog-explore <url>` | List issues for batch processing (GitHub repo/project or Linear team/workspace) |
| `/grog-review <pr-url>` | Review a pull request (GitHub only) |
| `/grog-answer <url>` | Post a summary comment to GitHub issue/PR or Linear issue |
| `/grog-talk` | Bidirectional Telegram, WhatsApp, or Discord bridge |

## CLI Commands (index.js)

```
grog solve <issue-url>            Fetch issue details (GitHub or Linear, auto-detected)
grog explore <url>                List issues for batch work (GitHub or Linear)
grog review <pr-url>              Fetch PR for code review (GitHub only)
grog answer <url> <file>          Post comment to issue/PR (GitHub or Linear)
grog talk [--telegram|--whatsapp|--discord] Connect a messaging bridge session
grog recv [--telegram|--whatsapp|--discord] Wait for a message (~90s)
grog send [--telegram|--whatsapp|--discord] Send a message or file
grog notify [--telegram|--whatsapp|--discord] Send a notification
grog discord-channels             List discovered Discord servers, channels, and active threads
grog discord-read [--all|--channel ID] Read recent messages and download attachments
grog discord-recv [--all|--channel ID] Wait for messages in one or every visible channel
grog contacts list                List saved messaging contacts
grog contacts save team --discord 123456789012345678
```

Telegram receive downloads document and photo attachments to `/tmp/grog-telegram-files`.
Markdown and other text documents are printed to stdout with their saved path so the active agent can read them immediately.

Discord receive/read downloads attachments to `/tmp/grog-discord-files`. Text-like files are printed inline; binary files expose their local path. `--all` covers every server, visible text/announcement channel, and active thread. Receive uses the Discord Gateway for real-time events and resumable sessions; REST API v10 handles discovery, history, send, and downloads. The source channel is remembered so the next send replies there. `discordChannelId` is only an optional default.

## Supported URL Formats

**GitHub:**
- `https://github.com/owner/repo/issues/123` — single issue
- `https://github.com/owner/repo/pull/123` — pull request
- `https://github.com/owner/repo` — repo exploration
- `https://github.com/orgs/org/projects/123` — project exploration

**Linear:**
- `https://linear.app/workspace/issue/PROJ-123` — single issue
- `https://linear.app/workspace/team/PROJ` — team exploration
- `https://linear.app/workspace/project/slug` — project exploration
- `https://linear.app/workspace` — workspace exploration (all teams)

## Development

```bash
# Build and test
cd skill/
node index.js solve https://github.com/owner/repo/issues/1
node index.js solve https://linear.app/workspace/issue/PROJ-123

# Install/reinstall skills
bash skill/install.sh

# Project structure
skill/
  index.js          All CLI commands and messaging orchestration
  discord-client.js Discord REST client and attachment downloader
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
