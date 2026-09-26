# Grog Agent Notes

Grog is a Claude/Codex skill and CLI for GitHub, Linear, Jam.dev, and messaging bridge workflows.

## Current CLI Surface

- `grog solve <issue-url>` fetches and solves GitHub or Linear issues.
- `grog explore <url>` lists GitHub or Linear issues for batch work.
- `grog review <pr-url>` fetches GitHub pull request context for review.
- `grog answer <issue-or-pr-url> <file>` posts a summary comment to GitHub or Linear.
- `grog create linear --team TEAM --title "Title" [--description "text" | --description-file file]` creates Linear issues.
- `grog update <issue-url|id> [--title "Title"] [--description "text" | --description-file file] [--priority urgent|high|medium|low|none] [--parent ID|none]` edits an existing Linear issue. `--parent none` detaches a sub-issue. The state commands below each send their own `stateId`; this is the only command that edits what a human wrote, so every argument error is refused before the request rather than after a partial edit reaches the tracker.
- `grog jam <jam-url>` inspects Jam.dev reports.
- `grog start <issue-url|id>` marks Linear issues In Progress.
- `grog done <issue-url|id>` marks Linear issues Done.
- `grog cancel <issue-url|id>` marks Linear issues Canceled.
- `grog up <port>` shares `localhost:<port>` as a public HTTPS link through the relay in `tunnel/` (see `tunnel/README.md`): it dials out, connects only to that port on loopback, validates every relay message, reads its token from hush (`GROG_TUNNEL_TOKEN`) and never prints it. Keep those properties: nothing the relay sends may make the client reach another port, run anything or print unchecked text. `skill/tunnel.test.js` covers the whole path, including a hostile relay.
- `grog tmux-name <issue-url|id|name>` renames the tmux window the agent works in (the one holding `TMUX_PANE`): a Linear identifier as is, a GitHub issue or PR as `repo#123`, other text trimmed to 40 printable characters. It runs `tmux` without a shell and fails with a message outside tmux. Use it when the agent starts working on an issue, right after creating the issue it is about to work on, and when the user asks to name the tmux window, tab or session after the issue. Under Codex's shared app-server daemon TMUX_PANE belongs to whichever window started the daemon, so the command refuses there rather than rename another agent's tab; Codex needs `--no-daemon` or `features.daemon_auto_start = false`.
- `grog contacts ...` manages Telegram, WhatsApp, and Discord address book entries.

## Messaging Bridge

The messaging bridge supports channel-specific and generic commands:

- `grog talk [--telegram|--whatsapp|--discord]`
- `grog recv [--telegram|--whatsapp|--discord]`
- `grog send [--telegram|--whatsapp|--discord] [--to contact] <message-or-file>`
- `grog notify [--telegram|--whatsapp|--discord] [--to contact] <message>`
- `grog telegram-send`, `grog telegram-recv`, `grog telegram-send-image`
- `grog whatsapp-talk`, `grog whatsapp-recv`, `grog whatsapp-send`, `grog whatsapp-send-image`, `grog whatsapp-notify`
- `grog discord-talk`, `grog discord-channels`, `grog discord-read`, `grog discord-recv`, `grog discord-send`

Discord `talk`, `read`, and `recv` accept `--all` to cover every server the bot belongs to and every visible text/announcement channel plus active thread. Receive uses the Discord Gateway with resumable sessions instead of polling every channel; REST handles discovery and history. Newly invited servers do not need local configuration. Multi-channel receive records the source channel for the next reply. `discordChannelId` is an optional default, not an access boundary.

The Gateway client requests only `GUILDS`, `GUILD_MESSAGES`, and `MESSAGE_CONTENT`. It persists the session ID, resume URL, and sequence in `/tmp/grog-discord-state.json` with mode `0600`, terminates the socket after each CLI receive, and resumes on the next call to avoid consuming a new Identify session for every message. Never persist the bot token in the state file.

Channel selection precedence is CLI flag, then `GROG_CHANNEL`, then `~/.grog/config.json` `channel`, then Telegram.

## Outgoing Payload Safety

Inline text is reserved for single-line messages. Multiline messages must be written as UTF-8 text files and sent by passing the file path to `grog send`, `grog telegram-send`, `grog whatsapp-send`, or `grog discord-send`.

The shared message reader rejects inline payloads containing literal `\n` or `\r\n` escapes before any network request. Do not use `JSON.stringify` or shell interpolation to transport multiline messages. Send images through the channel-specific image command rather than as text or a generic file path.

`skill/message-input.test.js` verifies that malformed inline Telegram payloads are rejected before the bridge attempts a request.

## Telegram Attachments

`grog recv --telegram` and `grog telegram-recv` download Telegram document and photo attachments to:

```text
/tmp/grog-telegram-files
```

For Markdown and other text-like documents, the CLI prints:

- original file name;
- saved local path;
- file content.

For non-text documents and photos, the CLI prints the saved local path so the active agent can inspect the artifact with local tools.

## Discord Attachments

`grog discord-read`, `grog discord-recv`, and the generic Discord receive command download attachments to:

```text
/tmp/grog-discord-files
```

Downloads are restricted to Discord CDN hosts and 100 MB per file. Text-like attachments are printed with their saved path and content; binary attachments print the saved local path. Discord sends disable automatic mentions by default.

Discord bots must have `Message Content Intent` enabled or Discord returns empty message content and attachment fields. Discord permissions remain the access boundary: grant `View Channels`, `Read Message History`, and `Send Messages` wherever Grog should operate.

## Configuration

Primary config lives in:

```text
~/.grog/config.json
```

Important keys:

- `ghToken`
- `linear`
- `telegramBotToken`
- `telegramChatId`
- `discordBotToken`
- `discordChannelId` (optional default; omit it for automatic all-server mode)
- `zernio.apiKey`
- `zernio.whatsappAccountId`
- `zernio.whatsappParticipantId`
- `zernio.whatsappTemplate`
- `addressBook`
- `channel`

## Development Rules

- Keep `skill/index.js` aligned with the installed runtime when local fixes have been made in `~/.codex/tools/grog/index.js`.
- After CLI changes, run `node --check skill/index.js`.
- Run `npm test --prefix skill` after Discord client changes.
- `skill/linear-update.test.js` covers `grog update`: every case asserts the refusal happens before the network, because a malformed edit that reaches Linear has already changed a client's tracker.
- Runtime-test messaging changes against the real bridge when credentials are available.
- Do not print or commit tokens, chat IDs, or contact phone numbers except placeholder examples.
