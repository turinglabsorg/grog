# Grog

Grog is a local CLI and Claude/Codex skill for GitHub issues, Linear issues, pull requests, Jam.dev reports, and Telegram, WhatsApp, and Discord messaging.

It runs on your machine. Credentials stay in `~/.grog/config.json`. The CLI talks to GitHub, Linear, and the messaging APIs directly.

## Layout

```
grog/
  skill/    CLI (`grog`), skill installer, and tests
```

## Install

```bash
cd skill
./install.sh
```

The installer copies the CLI to `~/.claude/tools/grog/`, installs its npm dependencies, and writes the skill definitions under `~/.claude/skills/`.

## Commands

```text
grog solve <issue-url>            Fetch a GitHub or Linear issue
grog explore <url>                List issues for batch work
grog review <pr-url>              Fetch a GitHub pull request
grog answer <url> <file>          Post a summary comment
grog create github --repo OWNER/REPO --title "Title" [--body "text" | --body-file file]
grog create linear --team TEAM --title "Title" [--description "text" | --description-file file]
grog update <issue-url|id>        Edit a Linear issue (title, body, priority, parent)
grog jam <jam-url>                Inspect a Jam.dev report
grog start <issue-url|id>         Move a Linear issue to In Progress
grog done <issue-url|id>          Move a Linear issue to Done
grog cancel <issue-url|id>        Move a Linear issue to Canceled
grog contacts ...                 Manage the messaging address book
```

GitHub and Linear are chosen from the URL. Linear writes require a project `.grog` file:

```text
workspace=KAIROS
```

grog walks upward from the working directory until it finds that file, then uses `config.linear[KAIROS]`. `GROG_WORKSPACE` overrides the file. If neither is set, Linear calls are refused.

`grog update` edits an issue that already exists. Pass the body with `--description-file` so the shell does not flatten newlines. `--parent none` detaches a sub-issue. Argument errors are refused before the request.

```bash
grog update PROJ-123 --title "Corrected title"
grog update PROJ-123 --description-file /tmp/body.md
grog update PROJ-123 --priority high
grog update PROJ-123 --parent none
grog answer https://linear.app/workspace/issue/PROJ-123 /tmp/summary.md --image /tmp/screenshot.png
```

The same entry points exist as skills: `/grog-solve`, `/grog-explore`, `/grog-review`, `/grog-answer`, `/grog-create`, `/grog-talk`.

## Messaging

```text
grog talk [--telegram|--whatsapp|--discord]
grog recv [--telegram|--whatsapp|--discord]
grog send [--telegram|--whatsapp|--discord] [--to contact] <message-or-file>
grog notify [--telegram|--whatsapp|--discord] [--to contact] <message>
grog telegram-send, grog telegram-recv, grog telegram-send-image, grog telegram-send-document
grog whatsapp-talk, grog whatsapp-recv, grog whatsapp-send, grog whatsapp-send-image, grog whatsapp-notify
grog discord-talk, grog discord-channels, grog discord-read, grog discord-recv, grog discord-send
```

Channel selection is the CLI flag, then `GROG_CHANNEL`, then `channel` in `~/.grog/config.json`, then Telegram.

Inline text is for single-line messages. Multiline messages go in a UTF-8 file, and the command receives the file path. Discord `talk`, `read`, and `recv` accept `--all` for every server the bot can see. Receive uses the Discord Gateway and remembers the source channel for the next reply. `discordChannelId` is an optional default.

Telegram attachments land in `/tmp/grog-telegram-files`. Discord attachments land in `/tmp/grog-discord-files`.

## Configuration

```json
{
  "ghToken": "ghp_...",
  "linear": {
    "MTROPRO": "lin_api_...",
    "KAIROS": "lin_api_..."
  },
  "telegramBotToken": "123456:ABC...",
  "telegramChatId": "12345678",
  "discordBotToken": "discord-bot-token",
  "discordChannelId": "123456789012345678",
  "zernio": {
    "apiKey": "...",
    "whatsappAccountId": "...",
    "whatsappParticipantId": "...",
    "whatsappTemplate": { "name": "robin_message_it", "language": "it" }
  },
  "addressBook": {},
  "channel": "telegram"
}
```

`~/.claude/tools/grog/.env` is still read as a legacy fallback. A repo can override the voice with `.grog/config.json`:

```json
{
  "personality": {
    "tone": "formal and professional, no jokes",
    "style": "concise RFC-like technical writing"
  }
}
```

## Development

```bash
node --check skill/index.js
npm test --prefix skill
```

## License

MIT
