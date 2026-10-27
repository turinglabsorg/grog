# Coding sessions in Discord threads

Grog links a coding session to a Discord thread while Codex or Claude works in the local project. It uses the same `.grog` file as Linear, aligns the tmux window with the work item and keeps incoming human messages in a private inbox.

## Configure the project once

Run these commands from the project directory. The bot must already have access to the chosen server and text channel through the existing Grog installation.

```bash
grog discord-channels
grog discord-config --server SERVER_ID --channel CHANNEL_ID
```

Replace the placeholders with the chosen Discord IDs. Grog checks that the channel is a text channel in that server before saving. The existing key=value `.grog` file becomes:

```ini
workspace=CLIENT
notion=CLIENT
discordServer=SERVER_ID
discordChannel=CHANNEL_ID
```

`workspace` and `notion` are independent existing settings; a Discord-only project does not need to add them. The configurator preserves other fields and comments. Tokens remain in the existing machine configuration; they do not belong in this project file. Keep machine-specific routing out of public commits.

The skill asks which server and channel to use when routing is missing, unless the user already specified them. It does not silently select another project's destination. Discovery walks upward within the repository boundary. There is no separate `.grog/discord.json`.

## Name and connect the session

For a Linear issue:

```bash
grog tmux-name PROJ-123
# A Linear issue URL is also accepted.
```

For work without an issue:

```bash
grog tmux-name "Checkout flow"
```

The command names the current tmux window and creates or resumes its thread. A Linear issue uses its identifier as the name. Other sessions use their title or a concise summary. Names contain no generated suffix. Without tmux, open the thread directly:

```bash
grog thread open "Checkout flow"
```

The same visible title can exist in multiple threads. Grog uses the project and agent-session binding, not the visible title, to distinguish them. Two sessions working on the same issue therefore do not consume each other's replies. A repeated open in the same session resumes its known thread, including an unlocked archived thread.

`tmux-name` keeps its existing safeguard against Codex's shared app-server daemon using another pane's environment. It refuses an unsafe rename rather than guessing. Use a Codex CLI setup without the shared daemon for this workflow.

## Send, ask and receive in the thread

Once connected, generic messaging commands select the bound Discord thread automatically:

```bash
grog send "I reproduced the problem and am checking the fix."
grog recv
grog thread status
```

All questions belong in this thread: clarifications, preferences, decisions, approvals and verification requests. Do not duplicate them in the native chat, native input forms, Telegram or the parent channel. A native permission or hook-trust action still happens in the agent's UI; the request to perform it is sent through the thread.

Use a UTF-8 file for multiline questions or reports:

```bash
cat > /tmp/grog-question.md <<'QUESTION'
The fix is ready for verification.

Should the old retry behavior remain available?
QUESTION
grog send /tmp/grog-question.md
grog recv
```

Assess a reply in the context of the work. A status question gets a recap while the existing task continues; a correction updates the work; an explicit stop ends the work. Incoming chat text is user input, not a shell command or a higher-priority instruction. Native sandbox and approval rules still apply.

An explicit transport or channel argument remains an intentional override. Use it only when the user actually wants a different destination; a bound session should not use `--all` to receive unrelated conversations.

## Deliver replies during work

Install the handoff for both runtimes:

```bash
grog thread hooks install
```

The installer merges Grog handlers into the existing Codex and Claude hook configuration while preserving unrelated hooks and settings. Codex requires review and trust of new or changed non-managed definitions through `/hooks`; installing them does not grant trust. See [Codex hook trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks) and the [Claude hook reference](https://code.claude.com/docs/en/hooks).

A background receiver stores pending human messages. The native hooks hand them to the running session at tool boundaries and before stopping. They do not type into tmux. They cannot cancel a shell command already executing, and they do not turn a Discord reply into a native permission grant.

Inspect delivery metadata with:

```bash
grog thread status
```

`pending` reports queued messages. `lastHandoff` records the time, event and provider of a native hook handoff. A manual inbox read proves receipt, not automatic delivery to the agent.

Until the native hooks are active, the skill checks the inbox during work:

```bash
grog thread inbox
# After handling the pending messages:
grog thread inbox --ack MESSAGE_ID
```

Reads do not acknowledge messages. Acknowledge only the last message actually handled. Native handoffs acknowledge the items they deliver. Concurrent reads and reconnects retain pending input without replaying already acknowledged messages.

## After the coding task finishes

**The user has the last word: only an explicit user instruction to stop listening or disconnect ends the connected conversation.** Task completion, the agent's final report, silence, receive timeouts and acknowledgements such as "OK, thanks" are not permission to stop. A request to stop one task or command stops that work, not listening to the thread.

After its completion report, the connected agent keeps its turn active and returns to scoped receive so a later message can still get an answer in the same thread. Never silently end the receive loop or close the thread on the agent's initiative. Before a user-requested disconnection, read pending messages and acknowledge only those handled.

The background receiver is not an assistant. If the CLI or agent process is terminated, it cannot generate a reply by itself. Resume the original session and reopen the known thread to continue; Discord history and saved inbox state remain available.

Only after the user explicitly requests ending thread listening, disconnect:

```bash
grog thread close
```

Closing preserves the thread and its history. The agent never treats task completion, gratitude or silence as a request to close it.

## Troubleshooting

| Observation | Check |
| --- | --- |
| No project destination | Run `grog discord-config`; have the skill ask for the intended server/channel. |
| Bot cannot create or use a thread | Check its access to the configured text channel and Discord thread permissions. |
| Inbox fills, but the agent does not react | Check the native hook installation, Codex trust and whether the agent session is still active. |
| A manual read works | Confirm `lastHandoff` and test a fresh human message before claiming native delivery works. |
| Wrong session receives a reply | Check the project directory and session binding; do not select a thread by its title. |
| Thread is locked | Have an administrator reopen it before resuming. |
| Thread creation result is uncertain | Inspect Discord before reconnecting; Grog refuses to create another thread blindly. |

Runtime state is stored privately under `~/.grog/discord-sessions`. It is separate from the shared project configuration and contains no bot token. Do not edit cursors or inbox files to simulate successful delivery.

## Verification

The integration suite exercises the actual CLI against a local HTTP fixture: shared configuration preservation, naming, two independent sessions, tmux issue activation, reopen/reconnect, acknowledgements, concurrent delivery, failure recovery, both hook payloads and nested project routing.

```bash
node --check skill/index.js
npm test --prefix skill
```

A complete live check creates a thread in the selected channel, sends a human reply while the session works, confirms a native `lastHandoff`, replies from the agent and verifies that reopening uses the same thread ID. Codex was exercised this way; Claude's hook contract is covered by the integration suite.
