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
- `grog contacts ...` manages Telegram and WhatsApp address book entries.

## Messaging Bridge

The messaging bridge supports channel-specific and generic commands:

- `grog talk [--telegram|--whatsapp]`
- `grog recv [--telegram|--whatsapp]`
- `grog send [--telegram|--whatsapp] [--to contact] <message-or-file>`
- `grog notify [--telegram|--whatsapp] [--to contact] <message>`
- `grog telegram-send`, `grog telegram-recv`, `grog telegram-send-image`
- `grog whatsapp-talk`, `grog whatsapp-recv`, `grog whatsapp-send`, `grog whatsapp-send-image`, `grog whatsapp-notify`

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
- `zernio.apiKey`
- `zernio.whatsappAccountId`
- `zernio.whatsappParticipantId`
- `zernio.whatsappTemplate`
- `addressBook`
- `channel`

## Development Rules

- Keep `skill/index.js` aligned with the installed runtime when local fixes have been made in `~/.codex/tools/grog/index.js`.
- After CLI changes, run `node --check skill/index.js`.
- Runtime-test messaging changes against the real bridge when credentials are available.
- Do not print or commit tokens, chat IDs, or contact phone numbers except placeholder examples.
