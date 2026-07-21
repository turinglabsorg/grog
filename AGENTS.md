# Grog Agent Notes

Grog is a Claude/Codex skill and CLI for GitHub, Linear, Jam.dev, and messaging bridge workflows.

## Current CLI Surface

- `grog solve <issue-url>` fetches and solves GitHub or Linear issues.
- `grog explore <url>` lists GitHub or Linear issues for batch work.
- `grog review <pr-url>` fetches GitHub pull request context for review.
- `grog answer <issue-or-pr-url> <file>` posts a summary comment to GitHub or Linear.
- `grog create linear --team TEAM --title "Title" [--description-file file]` creates Linear issues.
- `grog jam <jam-url>` inspects Jam.dev reports.
- `grog start <issue-url|id>` marks Linear issues In Progress.
- `grog done <issue-url|id>` marks Linear issues Done.
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

Channel selection precedence is CLI flag, then `GROG_CHANNEL`, then `~/.grog/config.json` `channel`, then Telegram.

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
- Runtime-test messaging changes against the real bridge when credentials are available.
- Do not print or commit tokens, chat IDs, or contact phone numbers except placeholder examples.
