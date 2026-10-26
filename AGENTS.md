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
- `grog up <port>` shares `localhost:<port>` as a public HTTPS link through the relay in `tunnel/` (see `tunnel/README.md`): it dials out, connects only to that port on loopback, validates every relay message, reads its token from hush (`GROG_TUNNEL_TOKEN`) and never prints it. Keep those properties: nothing the relay sends may make the client reach another port, run anything or print unchecked text. The client drops a control connection that hears nothing from the relay for 75 s (the relay pings every 20 s) and reconnects, so a relay or network that vanished without a reset cannot leave a site offline. `skill/tunnel.test.js` covers the whole path, including a hostile relay and a silent one. `grog up --domain <host>` claims a fixed host (one label under the relay's domain, or a site domain whose certificate is on the relay); a claim takes the host over and the relay tells the old client (`T`), which stops. `grog serve` keeps `~/.grog/sites.json` online (`dir`, `port`, `run`+`port`, `redirect`, `board`) and must keep the static server's rules: nothing outside the folder (realpath check, symlinks included), no hidden path segments, GET/HEAD only, no listings. Site domains are always persistent (sites.json + `grog serve`), never a one-off `grog up`. They serve production builds, never dev servers. The relay saves open links to its state file and reloads them on start. A request for a site domain is stamped with `x-grog-country` (where that network is registered); the address is not logged or forwarded, `grog serve` strips the header before the app, and an ephemeral `grog up` link is not stamped. Scanner paths are answered 404 before the site (including a redirect) and are not counted. A known bot user-agent is served and not counted. An empty user-agent is still counted.
- `tunnel/renew.sh` gets the relay's certificates with a DNS-01 challenge from the machine that holds the DNS tokens in hush; the relay only receives certificates and keys. Each site line in `~/.config/grog-relay/sites` may name its DNS (`digitalocean`, the default, or `cloudflare`). A failing site is reported and must not stop the others. The installed copy at `~/.config/grog-relay/renew.sh` runs weekly from launchd (`space.grooooog.relay-renew`): keep it identical to the repository's.
- `grog tmux-name <issue-url|id|name>` renames the tmux window the agent works in (the one holding `TMUX_PANE`): a Linear identifier as is, a GitHub issue or PR as `repo#123`, other text trimmed to 40 printable characters. It runs `tmux` without a shell and fails with a message outside tmux. Use it when the agent starts working on an issue, right after creating the issue it is about to work on, and when the user asks to name the tmux window, tab or session after the issue. Under Codex's shared app-server daemon TMUX_PANE belongs to whichever window started the daemon, so the command refuses there rather than rename another agent's tab; Codex needs `--no-daemon` or `features.daemon_auto_start = false`.
- `grog notion search|create|append|replace` writes Markdown to Notion (`skill/notion.js`, REST API version `2022-06-28`). The workspace is always explicit (`--workspace NAME` or `notion=NAME` in the project's `.grog` file) and the token comes from hush as `NAME_NOTION_TOKEN` (or `config.notion.NAME.tokenName`), so one client's document cannot reach another client's workspace. Keep these properties: argument errors refused before hush or the network; the token appears only in the Authorization header and every API error is scrubbed of it; `replace` writes title and properties before deleting the old body; requests stay within Notion's limits (100 blocks, under 1000 elements, 2000 characters per text object, two nesting levels). `GROG_NOTION_API` points the client at a stand-in API; `skill/notion.test.js` uses it with a stand-in `hush`.
- `grog contacts ...` manages Telegram, WhatsApp, Discord, and SMS address book entries.
- Telegram uploads (`telegram-send-image`, `telegram-send-document`) go through `fetch` with `FormData`, never a shell or curl: a caption is text whatever it holds, and nothing printed may contain the bot token (`hideTelegramToken`). `GROG_TELEGRAM_API` points the client at a stand-in API; `skill/telegram-upload.test.js` uses it.

## Messaging Bridge

`skill/install-skills.sh` is the source for the generated `grog-talk` skill. Its "Keep the working channel live" section defines ongoing two-way history reads, message checkpoints, user steering, and channel-scoped progress. Keep the Discord guidance in `skill/SKILL.md` aligned and reinstall generated skills with `bash skill/install-skills.sh` after editing their source.

The messaging bridge supports channel-specific and generic commands:

- `grog talk [--telegram|--whatsapp|--discord|--sms]`
- `grog recv [--telegram|--whatsapp|--discord|--sms]`
- `grog send [--telegram|--whatsapp|--discord|--sms] [--to contact] <message-or-file>`
- `grog notify [--telegram|--whatsapp|--discord|--sms] [--to contact] <message>`
- `grog telegram-send`, `grog telegram-recv`, `grog telegram-send-image`
- `grog whatsapp-talk`, `grog whatsapp-recv`, `grog whatsapp-send`, `grog whatsapp-send-image`, `grog whatsapp-notify`
- `grog discord-talk`, `grog discord-channels`, `grog discord-read`, `grog discord-recv`, `grog discord-send`

Discord `talk`, `read`, and `recv` accept `--all` to cover every server the bot belongs to and every visible text/announcement channel plus active thread. Receive uses the Discord Gateway with resumable sessions instead of polling every channel; REST handles discovery and history. Newly invited servers do not need local configuration. Multi-channel receive records the source channel for the next reply. `discordChannelId` is an optional default, not an access boundary.

The Gateway client requests only `GUILDS`, `GUILD_MESSAGES`, and `MESSAGE_CONTENT`. It persists the session ID, resume URL, and sequence in `/tmp/grog-discord-state.json` with mode `0600`, terminates the socket after each CLI receive, and resumes on the next call to avoid consuming a new Identify session for every message. Never persist the bot token in the state file.

Channel selection precedence is CLI flag, then `GROG_CHANNEL`, then `~/.grog/config.json` `channel`, then Telegram.

## SMS

`skill/sms.js` owns Zernio SMS; all SMS use this CLI boundary. `sms-numbers`, `sms-enable`, `sms-talk`, `sms-read`, `sms-recv`, and `sms-send` have generic `--sms` routing. Contacts use `addressBook.ALIAS.sms`; optional non-secret defaults are `zernio.smsNumber` and `zernio.smsTokenName`. Credentials come from hush (`ZERNIO_API_KEY` by default), never a new plaintext config field. `GROG_ZERNIO_API` only permits a loopback HTTP test server. Requests use the exact owned phone and matching active `platform=sms` account; reject partial provider results and incomplete pagination. Do not fetch message attachments or arbitrary message URLs.

The provider base is `https://zernio.com/api/v1`: GET `/phone-numbers` returns `numbers[]` with owned record IDs and capability flags; POST `/phone-numbers/{id}/sms` enables the selected record; GET `/accounts?platform=sms` resolves its active SMS account by exact international `username`; GET `/inbox/conversations` and GET `/inbox/conversations/{opaqueId}/messages` page through that account only. Conversations must match `platform` and `accountId`; messages must also match `conversationId`. Cursors and IDs are opaque and must be encoded. POST `/sms/messages` sends `{from,to,text}` with `Idempotency-Key`. Only controlled HTTP status errors may reach output, never raw response bodies.

`--otp-env NAME -- COMMAND` requires a fresh `--since` and sender/text filter. Only fresh incoming messages with one distinct six-digit code may launch the child. No shell, API token or Bitwarden session is passed; buffer and redact output across chunks. State stores only a checkpoint and consumed IDs under `~/.grog/sms-state/` (0600), one locked receiver per number/account. Failed consumers still consume their message. Never log OTPs or message bodies in verification evidence.

Enable only explicitly requested existing numbers; never purchase or register a line implicitly. SMS submission is not delivery. Sends use idempotency keys and must not auto-retry ambiguous failures. `skill/sms.test.js` exercises the actual CLI against a local provider, including scope, pagination, hush injection, private consumption, replay and send refusal. `bash skill/install.sh --runtime-only` updates existing runtimes and generated skills without credential prompts or dependency installation.

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
- Run `npm test --prefix skill` after messaging changes.
- `skill/linear-update.test.js` covers `grog update`: every case asserts the refusal happens before the network, because a malformed edit that reaches Linear has already changed a client's tracker.
- Runtime-test messaging changes against the real bridge when credentials are available.
- Do not print or commit tokens, chat IDs, or contact phone numbers except placeholder examples.
