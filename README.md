# Grog

Grog is a local CLI and Claude/Codex skill for GitHub issues, Linear issues, pull requests, Jam.dev reports, and Telegram, WhatsApp, Discord, and SMS messaging. It also gives the agent a desktop of its own, with a real browser.

It runs on your machine. Existing integrations use `~/.grog/config.json`; SMS and Notion credentials are injected by name from hush. The CLI talks to GitHub, Linear, and the messaging APIs directly.

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

The installer copies the CLI to `~/.claude/tools/grog/`, installs its npm dependencies, and writes the skills once under `~/.agents/skills/` (read by Codex and Hermes), linked from `~/.claude/skills/` for Claude Code and Grok. `skill/install-skills.sh` redoes just that step.

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
grog desktop up|open|shot|read|type ... A Linux desktop with a real browser, sessions kept
grog notion search [query]        List the Notion pages and databases shared with the integration
grog notion create ...            Write a Markdown file as a new Notion page or database row
grog notion append|replace <page> Add to, or rewrite, a Notion page from a Markdown file
grog contacts ...                 Manage the messaging address book
grog discord-config ...           Set server/channel in the project's existing .grog
grog thread open <title>          Open or resume a coding-session thread
grog thread status               Show the binding, pending input and last hook handoff
grog thread inbox [--ack ID]      Read or acknowledge pending thread input
grog thread hooks install        Install Codex/Claude inbox hooks
grog thread close                Disconnect this session, preserving history
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

## Notion

`grog notion` writes Markdown files to Notion through an internal integration. Every command names its workspace: `--workspace ACME`, or a `notion=ACME` line in the project's `.grog` file. There is no default, so a document cannot land in another workspace by accident. The token is read from hush as `ACME_NOTION_TOKEN` (or the hush name in `config.notion.ACME.tokenName`) and is never printed.

```bash
grog notion search --workspace ACME
grog notion create --parent https://app.notion.com/p/<page-or-database> --title "Launch plan" \
  --file plan.md --prop Status="In progress" --prop Type=Spec --icon 🚀 --workspace ACME
grog notion replace https://app.notion.com/p/<page> --file plan.md --workspace ACME
grog notion append https://app.notion.com/p/<page> --file notes.md --workspace ACME
```

Share the target page or database with the integration in Notion first (`•••` → Connections). Headings, paragraphs, bulleted, numbered and task lists (one nested level), tables, fenced code, quotes, GitHub alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) as callouts, dividers, external images, bold, italic, strikethrough, inline code and http(s) links are converted. `--prop Name=value` sets database properties (title, text, select, multi-select, status, number, checkbox, date, url, email, phone, relation) after checking them against the database schema. `replace` updates the title and properties before it deletes the old body, so a refused value leaves the page untouched. Argument errors stop before hush or the network.

## Public links

```bash
grog up 4000
# > https://k7f2q9xw3m.grooooog.space -> localhost:4000 on my-mac (this machine)
```

Anyone with the link can open the app on port 4000, from any device, until the command stops. It says where it runs and warns at once when nothing listens on the port. The link goes through our relay (`tunnel/`): the machine only dials out and accepts no inbound connection, only that one port is reachable, and only holders of the tunnel token (kept in hush as `GROG_TUNNEL_TOKEN`, never printed) can open links. Share links only for apps that are fine to show.

Our own domains (like `alienwatch.buzz`) are served persistently, never by a one-off `grog up`: list their hosts in `~/.grog/sites.json` with what answers there (`dir` for static files, `port`, `run` to start an app, `redirect`, or `board` for the live page) and `grog serve` keeps them online, as a launchd agent on the Mac Pro. Details, security model, adding a domain and deployment: [tunnel/README.md](tunnel/README.md).

## A desktop for the agent

`grog desktop` gives the agent a Linux desktop with an ordinary Chromium on a real X display. It is the `cora-box:latest` image that [Cora](https://github.com/turinglabsorg/cora) gives its own agents: build it from Cora's `box/` folder (`docker build -t cora-box:latest box`), or pass `--image`. A site sees a person there, not a script. The agent's own headless Chrome reports `navigator.webdriver`, and Cloudflare's Turnstile or a Slack login stop it; this browser gets the real login page. Sessions live in the desktop's volumes, so a login done once survives restarts.

```bash
grog desktop up                            # start it, or adopt the one already running
grog desktop open https://example.com/login
grog desktop shot --out screen.jpg         # look at the screen
grog desktop click 640 410                 # act on what you saw
grog desktop type --secret SITE_PASSWORD   # typed blind, through hush
grog desktop read text                     # the page as data
```

- Two channels on the same window. Pixels: `shot`, `click`, `key`, `type`, `paste`. Data: `read text|query|html|eval|cookies|storage|network|targets|goto`, through `cora-cdp` on Chromium's debugging port. No driver starts the browser and it never runs with `--enable-automation`.
- `type --secret NAME` sends the value from hush to `xdotool` inside the desktop through the environment. It is never on a command line and never printed.
- `paste --file|--text` fills both X selections. The desktop keeps PRIMARY and CLIPBOARD in step, so selecting text in the page replaces what you put there: paste right after.
- One desktop, several agents, so a login is done once. `who` shows who used it in the last ten minutes, and an action warns when someone else did. A customer's work gets a desktop of its own: `--name acme` is `grog-desk-acme`, with its own volumes.
- `up` joins the desktop to your tailnet and prints the authorization link the first time. `status` shows how to watch it, `vnc://` on port 5900 and noVNC on port 6080, and whether VNC asks for a password.
- `run -- <command>` runs a command inside it. `down` stops it and keeps the sessions, `rm` removes the container and keeps them, `rm --volumes` removes them too.

`GROG_DOCKER`, `GROG_HUSH` and `GROG_DESK_IMAGE` point at another docker, hush or image.

## Discord threads for coding sessions

Keep the coding session in tmux and its conversation in a Discord thread. Starting a Linear issue names the thread with its identifier; other work uses the session title or a short summary.

Use the existing project `.grog` file for routing:

```ini
workspace=CLIENT
discordServer=SERVER_ID
discordChannel=CHANNEL_ID
```

The skill asks for missing server/channel settings before enabling thread mode. Configure them without replacing Linear or Notion settings:

```bash
grog discord-config --server SERVER_ID --channel CHANNEL_ID
grog thread hooks install
# Codex: open /hooks and review/trust the new Grog handlers.
grog tmux-name PROJ-123
# Without an issue: grog tmux-name "Checkout flow"
grog send "I am checking the failing test."
```

Grog creates or resumes the session's thread and receives replies while the agent works. All questions, including verification and approval requests, stay in that thread. Each session has its own inbox even when thread titles match.

Finishing a coding task does not have to close the conversation: the connected agent stays in its receive loop and can answer later. A closed CLI cannot answer by the background receiver alone; resume the session to continue. `grog thread close` explicitly disconnects while preserving history.

See the [Discord thread guide](docs/DISCORD_THREADS.md) for setup, command reference, Codex/Claude hooks, acknowledgements, reconnection and troubleshooting.

## Messaging

```text
grog talk [--telegram|--whatsapp|--discord|--sms]
grog recv [--telegram|--whatsapp|--discord|--sms]
grog send [--telegram|--whatsapp|--discord|--sms] [--to contact] <message-or-file>
grog notify [--telegram|--whatsapp|--discord|--sms] [--to contact] <message>
grog telegram-send, grog telegram-recv, grog telegram-send-image, grog telegram-send-document
grog whatsapp-talk, grog whatsapp-recv, grog whatsapp-send, grog whatsapp-send-image, grog whatsapp-notify
grog discord-talk, grog discord-channels, grog discord-read, grog discord-recv, grog discord-send
```

An explicit transport flag always selects the transport. A bound coding session defaults to its Discord thread; outside thread mode, the defaults are `GROG_CHANNEL`, then `channel` in `~/.grog/config.json`, then Telegram.

Inline text is for single-line messages. Multiline messages go in a UTF-8 file, and the command receives the file path. Discord `talk`, `read`, and `recv` accept `--all` for every server the bot can see. Receive uses the Discord Gateway and remembers the source channel for the next reply. `discordChannelId` is an optional default.

Telegram attachments land in `/tmp/grog-telegram-files`. Discord attachments land in `/tmp/grog-discord-files`.

## SMS through Zernio

Store the Zernio API key in hush as `ZERNIO_API_KEY`. SMS commands obtain it through `hush run --redact`; no key belongs in command arguments or the address book. Optional configuration contains only `zernio.smsTokenName` (an alternate hush name) and `zernio.smsNumber` (a default owned number).

```bash
grog sms-numbers --json
grog sms-enable --number +31612345678
grog sms-talk --number +31612345678
grog sms-read --number +31612345678 --sender Example --limit 20
grog sms-recv --number +31612345678 --timeout 60
grog contacts save example --sms +31687654321
grog send --sms --number +31612345678 --to example "Message"
```

The numbers above are placeholders. Select an existing owned number explicitly with `--number` or the configured default. `sms-enable` enables SMS on that exact owned number; Grog never purchases a number, enrolls it in registration, or enables it implicitly. Capability, country restrictions and registration requirements come from Zernio. Receiving a particular provider's verification SMS must be tested on the actual number; `smsCapable` alone does not prove it works.

`talk`, `recv`, `send` and `notify` accept `--sms` with `--number`; explicit `sms-*` commands do not change the default channel. `sms-talk` anchors future receives without sending a welcome message. `sms-read` is non-consuming history; `sms-recv` returns one unseen incoming message and exits with status 2 on timeout (1 on error). Reads support `--sender`, case-insensitive `--contains` and `--since ISO`; receive defaults to 60 seconds and accepts 0–300. JSON is the default output. Text messages are supported; attachments/MMS are not.

### Verification codes without exposing them

Use the protected consumer for verification SMS. Never run ordinary history/receive into agent output when it may contain a password or code. Record a fresh ISO timestamp immediately before requesting the code in the provider UI, then pass it below:

```bash
grog sms-recv --number +31612345678 --since REQUESTED_AT_ISO \
  --contains Example --timeout 60 --otp-env LOGIN_OTP -- \
  node /absolute/path/to/provider-code-consumer.mjs
```

The timestamp must be within the last five minutes. A sender or text filter is mandatory. Grog accepts exactly one distinct six-digit code from a fresh incoming message, marks the message consumed, and injects the code only into the child environment. The child receives neither the Zernio key nor `BW_SESSION`. No shell interprets its arguments. Output is buffered and the code is redacted even across output chunks; keep the consumer silent about input values and never write them to files, screenshots or logs. Consumer execution is limited to 120 seconds and 2 MiB of output. A consumer failure consumes the message: inspect the provider state and request a new code rather than replaying it.

Receive state under `~/.grog/sms-state/` contains only a checkpoint and up to 2,000 consumed message IDs per number/account, with private file permissions and one active receiver per scope. It contains no message bodies, credentials or codes. `sms-talk` starts a new checkpoint; use explicit `--since` for history or verification. Filtering a message does not consume it.

SMS send accepts single-line inline text or a UTF-8 file, never attachments. Supply `--idempotency-key KEY` when coordinating a send across retries; Grog otherwise generates and returns a key. It sends once and reports the provider's submission status, which is not a delivery receipt. Do not blindly retry an ambiguous network failure. Carrier text/Unicode limits and destination restrictions still apply.

For an existing installation with unchanged dependencies, `bash skill/install.sh --runtime-only` updates installed runtime modules and regenerates the agent skills without prompting for credentials or installing packages.

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
