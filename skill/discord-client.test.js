import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { DiscordClient, isDiscordTextAttachment } from "./discord-client.js";

test("DiscordClient reads messages, sends messages, and downloads attachments", async (t) => {
  const requests = [];
  let origin;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });

    if (req.url === "/api/v10/channels/123/messages?limit=2") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify([{ id: "200", content: "hello", attachments: [] }]));
      return;
    }
    if (req.url === "/api/v10/channels/forbidden/messages?limit=50") {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: 50001, message: "Missing Access" }));
      return;
    }
    if (req.url === "/api/v10/gateway/bot") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        url: origin.replace("http://", "ws://"),
        session_start_limit: { remaining: 1000 },
      }));
      return;
    }
    if (req.url === "/api/v10/users/@me/guilds?limit=200") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify([{ id: "guild-1", name: "Turing Labs" }]));
      return;
    }
    if (req.url === "/api/v10/guilds/guild-1/channels") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify([
        { id: "channel-1", name: "general", type: 0 },
        { id: "voice-1", name: "voice", type: 2 },
        { id: "forum-1", name: "support", type: 15 },
      ]));
      return;
    }
    if (req.url === "/api/v10/guilds/guild-1/threads/active") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        threads: [{ id: "thread-1", name: "incident", type: 11, parent_id: "forum-1" }],
        members: [],
      }));
      return;
    }
    if (req.url === "/api/v10/channels/123/messages" && req.method === "POST") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: "201", content: JSON.parse(body).content }));
      return;
    }
    if (req.url === "/files/notes.md") {
      res.setHeader("Content-Type", "text/markdown");
      res.end("# Discord attachment\n");
      return;
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: "not found" }));
  });
  const gatewayServer = new WebSocketServer({ server });
  let identifyPayload = null;
  let resumePayload = null;
  gatewayServer.on("connection", (socket) => {
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    socket.on("message", (raw) => {
      const payload = JSON.parse(raw.toString());
      if (payload.op === 2) {
        identifyPayload = payload;
        socket.send(JSON.stringify({
          op: 0,
          t: "READY",
          s: 1,
          d: {
            session_id: "session-1",
            resume_gateway_url: origin.replace("http://", "ws://"),
            user: { id: "bot-1", username: "grog" },
          },
        }));
        socket.send(JSON.stringify({
          op: 0,
          t: "MESSAGE_CREATE",
          s: 2,
          d: {
            id: "300",
            channel_id: "channel-1",
            guild_id: "guild-1",
            content: "gateway hello",
            author: { id: "user-1", username: "seb" },
            attachments: [],
          },
        }));
      }
      if (payload.op === 6) {
        resumePayload = payload;
        socket.send(JSON.stringify({ op: 0, t: "RESUMED", s: 3, d: {} }));
        socket.send(JSON.stringify({
          op: 0,
          t: "MESSAGE_CREATE",
          s: 4,
          d: {
            id: "301",
            channel_id: "channel-2",
            guild_id: "guild-1",
            content: "resumed hello",
            author: { id: "user-2", username: "ugo" },
            attachments: [],
          },
        }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => gatewayServer.close());
  t.after(() => server.close());
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  const downloadDir = mkdtempSync(join(tmpdir(), "grog-discord-test-"));
  t.after(() => rmSync(downloadDir, { recursive: true, force: true }));

  const client = new DiscordClient({
    token: "test-token",
    apiBase: `${origin}/api/v10`,
    downloadDir,
    allowedAttachmentHosts: ["127.0.0.1"],
  });

  const messages = await client.listMessages("123", { limit: 2 });
  assert.equal(messages[0].content, "hello");

  await assert.rejects(
    client.listMessages("forbidden"),
    (error) => error.status === 403 && error.code === 50001,
  );

  const discovery = await client.discoverMessageChannels();
  assert.deepEqual(discovery.guilds.map((guild) => guild.name), ["Turing Labs"]);
  assert.deepEqual(
    discovery.channels.map((channel) => ({ id: channel.id, guild: channel.guildName, isThread: channel.isThread })),
    [
      { id: "channel-1", guild: "Turing Labs", isThread: false },
      { id: "thread-1", guild: "Turing Labs", isThread: true },
    ],
  );

  const gatewayResult = await client.waitForMessage({ timeoutMs: 1000, ignoreUserId: "bot-1" });
  assert.equal(gatewayResult.message.content, "gateway hello");
  assert.equal(gatewayResult.session.sessionId, "session-1");
  assert.equal(gatewayResult.session.sequence, 2);
  assert.equal(identifyPayload.d.intents & (1 << 15), 1 << 15);

  const resumedResult = await client.waitForMessage({
    timeoutMs: 1000,
    session: gatewayResult.session,
    ignoreUserId: "bot-1",
  });
  assert.equal(resumedResult.message.content, "resumed hello");
  assert.equal(resumedResult.session.sequence, 4);
  assert.equal(resumePayload.d.session_id, "session-1");
  assert.equal(resumePayload.d.seq, 2);

  const sent = await client.sendMessage("123", "reply");
  assert.equal(sent.content, "reply");
  const sendRequest = requests.find((request) => request.method === "POST");
  assert.equal(sendRequest.authorization, "Bot test-token");
  assert.deepEqual(JSON.parse(sendRequest.body), {
    content: "reply",
    allowed_mentions: { parse: [] },
  });

  const attachment = {
    id: "attachment-1",
    filename: "notes.md",
    content_type: "text/markdown",
    size: 21,
    url: `${origin}/files/notes.md`,
  };
  const localPath = await client.downloadAttachment(attachment, "200");
  assert.equal(readFileSync(localPath, "utf8"), "# Discord attachment\n");
  assert.equal(isDiscordTextAttachment(attachment), true);
});

test("DiscordClient rejects attachment hosts outside the allowlist", async () => {
  const client = new DiscordClient({ token: "test-token" });
  await assert.rejects(
    client.downloadAttachment({ id: "1", filename: "x.txt", url: "https://example.com/x.txt" }, "1"),
    /host is not allowed/,
  );
});
