# Grog

Grog is a local CLI and Claude/Codex skill for GitHub issues, Linear issues, pull requests, Jam.dev reports, and Telegram, WhatsApp, and Discord messaging.

It runs on your machine. Credentials stay in `~/.grog/config.json`. The CLI talks to GitHub, Linear, and the messaging APIs directly.

## Layout

```
grog/
  skill/    CLI (`grog`), skill installer, and tests
  tunnel/   the relay behind `grog up` (see tunnel/README.md)
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
grog tmux-name <issue-url|id|name> Name your tmux window after the issue (MTR-1334, repo#123)
grog up <port>                    Share localhost:<port> as a public https link until stopped
grog up <port> --domain <host>    The same on a fixed host (demo.grooooog.space, alienwatch.buzz)
grog serve                        Keep the sites in ~/.grog/sites.json online (site domains)
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

The same entry points exist as skills: `/grog-solve`, `/grog-explore`, `/grog-review`, `/grog-answer`, `/grog-create`, `/grog-talk`, `/grog-tmux`, `/grog-up`.

`grog tmux-name` renames only the window of the calling pane (`TMUX_PANE`), so several agents can share a session. Agents run it as soon as they start on an issue. Under Codex's shared app-server daemon the pane is not the caller's, and the command refuses; set `features.daemon_auto_start = false` or run Codex with `--no-daemon`.

## Public links

```bash
grog up 4000
# > https://k7f2q9xw3m.grooooog.space -> localhost:4000 on my-mac (this machine)
```

Anyone with the link can open the app on port 4000, from any device, until the command stops. It says where it runs and warns at once when nothing listens on the port. The link goes through our relay (`tunnel/`): the machine only dials out and accepts no inbound connection, only that one port is reachable, and only holders of the tunnel token (kept in hush as `GROG_TUNNEL_TOKEN`, never printed) can open links. Share links only for apps that are fine to show.

Our own domains (like `alienwatch.buzz`) are served persistently, never by a one-off `grog up`: list their hosts in `~/.grog/sites.json` with what answers there (`dir` for static files, `port`, `run` to start an app, `redirect`, or `board` for the live page) and `grog serve` keeps them online, as a launchd agent on the Mac Pro. Details, security model, adding a domain and deployment: [tunnel/README.md](tunnel/README.md).

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

The tests include the whole `grog up` path against a local relay (`skill/tunnel.test.js`), which needs `python3` and `openssl`.

## License

MIT
