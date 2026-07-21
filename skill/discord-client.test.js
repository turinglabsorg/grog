import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordClient, isDiscordTextAttachment } from "./discord-client.js";

test("DiscordClient reads messages, sends messages, and downloads attachments", async (t) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });

    if (req.url === "/api/v10/channels/123/messages?limit=2") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify([{ id: "200", content: "hello", attachments: [] }]));
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

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
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
