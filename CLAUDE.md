# Grog — Claude Code Skill System

Autonomous GitHub + Linear workflow tool and Telegram bridge for Claude Code.

## Architecture

```
~/.grog/config.json          Central config (ghToken, linear.<workspace>, telegramBotToken, telegramChatId)
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
  "telegramChatId": "12345678"
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
| `/grog-talk` | Bidirectional Telegram bridge |

## CLI Commands (index.js)

```
grog solve <issue-url>            Fetch issue details (GitHub or Linear, auto-detected)
grog explore <url>                List issues for batch work (GitHub or Linear)
grog review <pr-url>              Fetch PR for code review (GitHub only)
grog answer <url> <file>          Post comment to issue/PR (GitHub or Linear)
grog talk                         Start Telegram bridge session
grog notify <message>             Send TG notification (no talk session needed)
grog telegram-send <msg-or-file>  Send message to TG (needs talk or chat ID)
grog telegram-recv                Long-poll for TG message (~90s)
```

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
