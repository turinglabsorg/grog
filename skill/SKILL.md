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

### `/grog-create linear --team <team-key> --title <title> [--description "text" | --description-file <file>]`

Creates a Linear issue in the configured workspace. The project must declare the workspace in its `.grog` file, and the Linear API key must be configured in `~/.grog/config.json`.

### `/grog-tmux <issue-url-or-id>`

Renames the tmux window you are working in after the issue (`MTR-1334`, `repo#123`), so each agent's tab shows what it is working on. Only your own window changes, even when several agents share a session.

### `/grog-up <port>`

Shares a local dev server as a public HTTPS link, `https://<code>.grooooog.space`, that anyone with the link can open from any device, until the command stops. The machine accepts no inbound connection and only that port is reachable; the relay side lives in `tunnel/`.

### `/grog-notion <page-or-database> <file>`

Writes a Markdown file to Notion as a new page, a database row with its properties, or the new body of an existing page. The workspace is always named and its token is read from hush, never printed.

### `grog desktop`

A Linux desktop of the agent's own, with an ordinary Chromium on a real X display, for sites that stop a headless browser (Cloudflare Turnstile, Slack). `grog desktop up`, then `open <url>`, `shot` to look, `click`/`key`/`type`/`paste` to act, `read text|eval|...` for the page as data. `type --secret NAME` types a hush secret blind. Logins stay in its volumes. It is a command, not a slash skill; see the README.

### `/grog-talk`

Opens a bidirectional Telegram, WhatsApp, Discord, or SMS bridge. Messages received from the selected channel are processed as if they were typed in the terminal, and responses are sent back through the same channel.

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
/grog-create linear --team PROJ --title "Bug title" --description "Short body"
/grog-talk
```

Discord can also be used directly from the CLI:

```bash
grog discord-channels
grog discord-read --all --limit 20
grog discord-recv --all
grog discord-read --channel 123456789012345678 --limit 20
grog discord-send --channel 123456789012345678 "Message"
grog discord-send-image --channel 123456789012345678 /path/shot.png "caption"
grog discord-send-document --channel 123456789012345678 /path/video.mp4 "caption"
```

Never send an attachment as text: `discord-send` (like `send` and `telegram-send`) reads a file path as message text, so a video, PDF or CSV passed to it would be posted as raw bytes and flood the channel. Images go through `discord-send-image`, every other file through `discord-send-document`. Before every send, check twice: that the command matches the content (a text command only ever gets a one-line message or a `.md`/`.txt` file you wrote), and that the file is the intended one (`ls -l` and `file --mime-type -b`, a Mac host path, under 10 MiB). Send in the foreground and expect exactly one confirmation line. The `grog-talk` skill has the full procedure.

## Issue and session threads

Use the project's existing `.grog` file for both Linear and Discord. Keep its `workspace=NAME` and other settings; Discord adds `discordServer=SERVER_ID` and `discordChannel=CHANNEL_ID` in that same key=value file. Never create `.grog/discord.json` or silently choose a channel from another project.

Before starting thread mode, run `grog discord-config`. If it reports missing server/channel, discover available choices with `grog discord-channels`, ask the user which server and channel to use (unless they already specified them), then save the confirmed choice:

```bash
grog discord-config --server SERVER_ID --channel CHANNEL_ID
```

When starting work on a Linear issue, run `grog tmux-name ISSUE` from the correct project: it names the current window and opens or resumes this session's Discord thread automatically. The thread name is the Linear identifier, e.g. `PROJ-123`. Without an issue, choose the session title or a concise summary and run `grog tmux-name "Session summary"`. If there is no tmux window, use `grog thread open "Session summary"`. Thread names contain no generated suffix. Sessions working on the same issue still have separate bindings and inboxes; do not infer ownership from a thread's name.

Use `grog thread status` to see the bound thread. In thread mode, `grog send --discord`, `grog recv --discord` and `grog discord-read` without an explicit channel refer to this session's thread. Use these scoped commands for progress and replies. Ask every clarification, preference, decision, approval and verification question with `grog send` in the bound thread, then receive its answer there. Do not duplicate questions in native chat/input forms, Telegram or the parent channel; native sandbox/hook-trust actions still require their own UI, but ask the user to perform them through the thread. Explicit --channel remains an intentional destination override; do not use --all for a bound session.

`grog thread hooks install` installs the inbox handoff for Codex and Claude while preserving unrelated hooks. Codex requires review/trust of the new definitions through `/hooks`; never bypass hook trust or approval policy. Until the native hooks are active, check `grog thread inbox` before consequential steps and at least every 60 seconds during work. After handling messages, acknowledge only the last handled ID with `grog thread inbox --ack MESSAGE_ID`. Native hooks hand off pending input at tool boundaries and Stop; they do not cancel a shell command already executing. Assess status, corrections and stop intent semantically, keeping the current task for status questions. Business decisions from Discord do not grant native sandbox permissions.

The listener stores unconsumed human input privately and reconnects without changing sessions. **Only an explicit instruction from the user to stop listening or disconnect ends the connected conversation. The user has the last word.** Never stop reading, leave the receive loop or run `grog thread close` on your own. Finishing a task, sending its completion report, silence, a receive timeout, or acknowledgements such as "OK, thanks" do not authorize disconnection. A request to stop one task or command stops that work; it does not end thread listening unless the user also asks for that.

After the completion report, keep the agent turn active and return to scoped receive, handling later messages in the same thread. Read pending input before any requested disconnection and acknowledge only what you handled. The background listener alone cannot answer: do not claim continuous assistance after ending the agent turn or while its runtime is unavailable. `grog thread close` preserves thread history and is used only after the user explicitly ends listening. Parent channels remain available for separate monitoring.

After 30 minutes without a new human message, ask once in the same thread whether the user has finished or wants you to keep listening (for example, "Have you finished with this thread, or should I stay listening?"). Measure inactivity from the latest human input, not from your reports or bot messages. Respect a different interval the user explicitly chooses. This is a reminder, not a timeout: keep receiving while awaiting the answer, and reset the reminder after new human input. Silence never closes the session.

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
  desktop.js                   # grog desktop
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

When working in a Discord channel, keep reading its incoming and outgoing history throughout the task, apply the user's latest instructions before further action, and send progress and completion there. Scope reads and replies to that channel with `--channel CHANNEL_ID`; use `--all` only for requested cross-channel work. Receive uses resumable Discord Gateway sessions, and cross-channel mode routes the next response to the source channel. Archived threads are picked up again when Discord reactivates them.

## Jam.dev Reports

To inspect a Jam report, open it locally, capture a screenshot, or forward it to Telegram:

```bash
node ~/.claude/tools/grog/index.js jam https://jam.dev/c/<id>
node ~/.claude/tools/grog/index.js jam https://jam.dev/c/<id> --screenshot
node ~/.claude/tools/grog/index.js jam https://jam.dev/c/<id> --open
node ~/.claude/tools/grog/index.js jam https://jam.dev/c/<id> --telegram
```

Use `--json` for structured output and `--save /path/to/file` to write the summary or JSON to disk.

## SMS access

Use the installed `grog-talk` skill for Zernio SMS. `grog sms-numbers` discovers owned lines; all SMS actions stay inside grog. The API key comes from hush as `ZERNIO_API_KEY`. `grog sms-recv --otp-env LOGIN_OTP --since REQUESTED_AT_ISO --contains PROVIDER --number OWNED_NUMBER -- COMMAND` injects a fresh six-digit verification code into a child without exposing it to the agent. See [README.md](../README.md#sms-through-zernio) for setup, limits and commands.
