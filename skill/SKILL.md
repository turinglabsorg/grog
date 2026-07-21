# Grog — Claude Code Skills

Grog adds slash commands to Claude Code for working with GitHub issues, Linear issues, pull requests, and remote interaction directly from your terminal.

## Skills

### `/grog-solve <issue-url>`

Fetches a GitHub issue, analyzes it, and starts implementing the fix immediately. Downloads image attachments, reads the codebase, writes the code, and commits. Can post a summary back to the issue when done.

### `/grog-review <pr-url>`

Fetches a pull request with the full diff, inline comments, and review history. Performs a thorough code review and can post the review directly on the PR.

### `/grog-explore <repo-or-project-url>`

Lists all open issues from a repository or GitHub Project, grouped by labels or status columns. Lets you pick issues and batch-process them one by one.

### `/grog-answer <issue-or-pr-url>`

Posts a summary comment to a GitHub issue, GitHub pull request, or Linear issue. For Linear issues, image paths can be uploaded and appended to the posted comment with `--image`.

### `/grog-create linear --team <team-key> --title <title> [--description-file <file>]`

Creates a Linear issue in the configured workspace. The project must declare the workspace in its `.grog` file, and the Linear API key must be configured in `~/.grog/config.json`.

### `/grog-talk`

Opens a bidirectional Telegram, WhatsApp, or Discord bridge. Messages received from the selected channel are processed as if they were typed in the terminal, and responses are sent back through the same channel.

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
- Optionally configure a Discord bot; a default channel is not required for all-server mode
- Create the Grog skill files in `~/.claude/skills/`

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
/grog-answer https://linear.app/workspace/issue/PROJ-123 --image /tmp/screenshot.png
/grog-create linear --team PROJ --title "Bug title" --description-file /tmp/body.md
/grog-talk
```

Discord can also be used directly from the CLI:

```bash
grog discord-channels
grog discord-read --all --limit 20
grog discord-recv --all
grog discord-read --channel 123456789012345678 --limit 20
grog discord-send --channel 123456789012345678 "Message"
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
~/.claude/skills/grog-create/
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

### Sending images via Telegram

To send screenshots or images directly to Telegram (useful for sharing browser screenshots):

```bash
node ~/.claude/tools/grog/index.js telegram-send-image /path/to/image.png "Optional caption"
```

This command sends images using the Telegram Bot API `sendPhoto` method, supporting any image format.

## Discord Setup (optional)

Create a bot in the Discord Developer Portal, enable `Message Content Intent`, and grant it `View Channels`, `Read Message History`, and `Send Messages` wherever Grog should operate. Store the bot token in `~/.grog/config.json`; the default channel is optional:

```json
{
  "discordBotToken": "discord-bot-token",
  "discordChannelId": "123456789012345678"
}
```

Discord reads save attachments to `/tmp/grog-discord-files`. Text-like attachments are printed inline; binary attachments expose their local path.

Use `--all` with `talk`, `recv`, or `discord-read` to cover every server, visible text/announcement channel, and active thread. Receive uses resumable Discord Gateway sessions instead of polling every channel and routes the next response to the source channel. Archived threads are picked up again when Discord reactivates them.

## Jam.dev Reports

To inspect a Jam report, open it locally, capture a screenshot, or forward it to Telegram:

```bash
node ~/.claude/tools/grog/index.js jam https://jam.dev/c/<id>
node ~/.claude/tools/grog/index.js jam https://jam.dev/c/<id> --screenshot
node ~/.claude/tools/grog/index.js jam https://jam.dev/c/<id> --open
node ~/.claude/tools/grog/index.js jam https://jam.dev/c/<id> --telegram
```

Use `--json` for structured output and `--save /path/to/file` to write the summary or JSON to disk.
