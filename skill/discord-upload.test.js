import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";

// Image and document uploads against a stand-in Discord API on localhost.
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "index.js");
const TOKEN = "never-print-this-discord-token";
const CHANNEL = "123456789012345678";
const CAPTION = `He said "ship it" and 'go' $(touch /tmp/x) \`id\` @everyone`;
const scratch = mkdtempSync(join(tmpdir(), "grog-discord-"));
const image = join(scratch, "shot.png");
const document = join(scratch, "notes.csv");
const big = join(scratch, "big.png");

let server;
let api;
let requests;
let reply;

before(async () => {
  mkdirSync(join(scratch, ".grog"));
  writeFileSync(join(scratch, ".grog", "config.json"), JSON.stringify({ discordBotToken: TOKEN }));
  writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  writeFileSync(document, "a,b\n1,2\n");
  writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1));
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const form = String(req.headers["content-type"]).startsWith("multipart/")
        ? await new Response(Buffer.concat(chunks), { headers: { "content-type": req.headers["content-type"] } }).formData()
        : null;
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, form });
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  requests = [];
  reply = { status: 200, body: { id: "1", channel_id: CHANNEL } };
});

after(() => {
  server?.close();
  rmSync(scratch, { recursive: true, force: true });
});

function grog(args, apiUrl = api) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: scratch,
      env: { PATH: process.env.PATH, HOME: scratch, GROG_DISCORD_API: apiUrl },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

async function bytes(file) {
  return Buffer.from(await file.arrayBuffer());
}

test("an image goes up as an attachment with its caption exactly as written and no pings", async () => {
  const result = await grog(["discord-send-image", "--channel", CHANNEL, image, CAPTION]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /image sent to Discord/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, `/channels/${CHANNEL}/messages`);
  assert.equal(requests[0].auth, `Bot ${TOKEN}`);
  const payload = JSON.parse(requests[0].form.get("payload_json"));
  assert.equal(payload.content, CAPTION);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.deepEqual(payload.attachments, [{ id: 0, filename: "shot.png" }]);
  const file = requests[0].form.get("files[0]");
  assert.equal(file.name, "shot.png");
  assert.equal(file.type, "image/png");
  assert.deepEqual(await bytes(file), readFileSync(image));
});

test("a document goes up with its name and no content when there is no caption", async () => {
  const result = await grog(["discord-send-document", "--channel", CHANNEL, document]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /document sent to Discord/);
  const payload = JSON.parse(requests[0].form.get("payload_json"));
  assert.equal(payload.content, undefined);
  const file = requests[0].form.get("files[0]");
  assert.equal(file.name, "notes.csv");
  assert.equal(await file.text(), "a,b\n1,2\n");
});

test("discord-send-image refuses files that are not images, missing files and oversized ones before any request", async () => {
  for (const [args, pattern] of [
    [["discord-send-image", "--channel", CHANNEL, document], /not an image/],
    [["discord-send-image", "--channel", CHANNEL, join(scratch, "missing.png")], /file not found/],
    [["discord-send-image", "--channel", CHANNEL, big], /larger than 10 MiB/],
  ]) {
    const result = await grog(args);
    assert.equal(result.code, 1);
    assert.match(result.err, pattern);
  }
  assert.equal(requests.length, 0);
});

test("a refused upload reports Discord's reason and never the token", async () => {
  reply = { status: 403, body: { message: "Missing Permissions", code: 50013 } };
  for (const [command, file] of [["discord-send-image", image], ["discord-send-document", document]]) {
    const result = await grog([command, "--channel", CHANNEL, file, CAPTION]);
    assert.equal(result.code, 1);
    assert.match(result.err, /Missing Permissions/);
    assert.doesNotMatch(result.err + result.out, /never-print-this-discord-token/);
  }
});

test("GROG_DISCORD_API only accepts a loopback test server", async () => {
  const result = await grog(["discord-send-image", "--channel", CHANNEL, image], "https://evil.example");
  assert.equal(result.code, 1);
  assert.match(result.err, /only permits a loopback test server/);
  assert.equal(requests.length, 0);
});
