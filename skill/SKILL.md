# Grog — Claude Code Skills

Grog adds five slash commands to Claude Code for working with GitHub issues, pull requests, and remote interaction directly from your terminal.

## Skills

### `/grog-solve <issue-url>`

Fetches a GitHub issue, analyzes it, and starts implementing the fix immediately. Downloads image attachments, reads the codebase, writes the code, and commits. Can post a summary back to the issue when done.

### `/grog-review <pr-url>`

Fetches a pull request with the full diff, inline comments, and review history. Performs a thorough code review and can post the review directly on the PR.

### `/grog-explore <repo-or-project-url>`

Lists all open issues from a repository or GitHub Project, grouped by labels or status columns. Lets you pick issues and batch-process them one by one.

### `/grog-answer <issue-or-pr-url>`

Posts a summary comment to a GitHub issue or pull request. Gathers context from your recent work, writes a markdown summary, and posts it directly on the issue or PR. Use after solving or reviewing to share what was done.

### `/grog-talk`

Opens a bidirectional Telegram bridge. Connect a Telegram bot to your Claude Code session, then walk away from the terminal and keep interacting from your phone. Messages you send on Telegram are processed as if you typed them in the terminal. Responses are sent back to Telegram as concise summaries.

## Installation

### 1. Clone the repo

```bash
git clone https://github.com/turinglabsorg/grog.git
```

### 2. Run the installer

```bash
cd grog/skill
./install.sh
```

The installer will:
- Copy the grog tool to `~/.claude/tools/grog/`
- Install npm dependencies
- Ask for your GitHub Personal Access Token
- Optionally configure a Telegram bot for remote interaction
- Create the five skill files in `~/.claude/skills/`

### 3. Create a GitHub token

You need a GitHub Personal Access Token (classic) to fetch issues and post comments.

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Click **Generate new token (classic)**
3. Select scopes:
   - `repo` — for private repositories
   - `public_repo` — if you only need public repos
4. Copy the token and paste it when the installer asks

The token is stored locally in `~/.claude/tools/grog/.env` and never leaves your machine. All GitHub actions (comments, reviews, pushes) appear under your account.

### 4. Use it

Open any Claude Code session and type:

```
/grog-solve https://github.com/owner/repo/issues/123
/grog-review https://github.com/owner/repo/pull/456
/grog-explore https://github.com/owner/repo
/grog-answer https://github.com/owner/repo/issues/123   # or /pull/456
/grog-talk
```

## Personality & Voice

Grog has a default personality: sarcastic, opinionated, dry wit — a developer tool with soul. It gets the job done but isn't going to pretend every bug is a delightful puzzle.

### Customizing per project

Create a `.grog/config.json` in your project root to override the default personality:

```json
{
  "personality": {
    "tone": "formal and professional, no jokes",
    "style": "concise RFC-like technical writing",
    "catchphrase": "As per specification..."
  }
}
```

All fields under `personality` are free-form strings. Grog reads this file at the start of every task and adopts whatever voice you define. If the file doesn't exist, you get the sarcastic default.

The personality affects commentary, summaries, and GitHub comments — never the quality of code or analysis.

## How it works

The skills call a local Node.js script (`~/.claude/tools/grog/index.js`) that talks to the GitHub API using your token. The script fetches the issue/PR data, downloads image attachments, and prints everything to stdout. Claude Code reads the output and acts on it — analyzing the code, implementing fixes, or writing reviews.

Since it runs inside Claude Code, it has full access to your local filesystem, git, and any tools you've configured. The skills are just the entry point — Claude does the actual work.

## Files

```
~/.claude/tools/grog/          # The grog CLI tool
  index.js                     # Main script
  package.json                 # Dependencies
  .env                         # Your tokens (GH_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)

~/.claude/skills/grog-solve/   # Skill definitions (created by installer)
~/.claude/skills/grog-explore/
~/.claude/skills/grog-review/
~/.claude/skills/grog-answer/
~/.claude/skills/grog-talk/
```

## Updating

To update, pull the latest and re-run the installer:

```bash
cd grog/skill
git pull
./install.sh
```

Your tokens will be preserved — the installer asks before overwriting them.

## Telegram Setup (optional)

To use `/grog-talk`, you need a Telegram bot:

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts to create a bot
3. Copy the bot token
4. Run the installer — it will ask for the token during setup
5. The chat ID is auto-detected when you first run `/grog-talk` and message the bot

Alternatively, add these to `~/.claude/tools/grog/.env` manually:

```
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=your-chat-id
```
