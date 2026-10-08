import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";

// Image and document uploads against a stand-in Telegram API on localhost.
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "index.js");
const TOKEN = "123456:never-print-this-token";
const CAPTION = `He said "ship it" and 'go' $(touch /tmp/x) \`id\``;
const scratch = mkdtempSync(join(tmpdir(), "grog-telegram-"));
const image = join(scratch, "shot.png");
const document = join(scratch, "notes.csv");

let server;
let api;
let requests;
let reply;

before(async () => {
  mkdirSync(join(scratch, ".grog"));
  writeFileSync(join(scratch, ".grog", "config.json"), JSON.stringify({ telegramBotToken: TOKEN }));
  writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  writeFileSync(document, "a,b\n1,2\n");
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const form = await new Response(Buffer.concat(chunks), {
        headers: { "content-type": req.headers["content-type"] },
      }).formData();
      requests.push({ url: req.url, form });
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  requests = [];
  reply = { status: 200, body: { ok: true, result: {} } };
});

after(() => {
  server?.close();
  rmSync(scratch, { recursive: true, force: true });
});

function grog(args, apiUrl = api) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: scratch,
      env: { PATH: process.env.PATH, HOME: scratch, GROG_TELEGRAM_API: apiUrl },
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

test("an image goes up with its caption exactly as written", async () => {
  const result = await grog(["telegram-send-image", "--to", "42", image, CAPTION]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /image sent to Telegram/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `/bot${TOKEN}/sendPhoto`);
  assert.equal(requests[0].form.get("chat_id"), "42");
  assert.equal(requests[0].form.get("caption"), CAPTION);
  assert.deepEqual(await bytes(requests[0].form.get("photo")), readFileSync(image));
});

test("a caption that starts with @ or < is text, not a file to attach", async () => {
  for (const caption of [`@${document}`, `<${document}`]) {
    requests = [];
    const result = await grog(["telegram-send-document", "--to", "42", image, caption]);
    assert.equal(result.code, 0, result.err);
    assert.equal(requests[0].url, `/bot${TOKEN}/sendDocument`);
    assert.equal(requests[0].form.get("caption"), caption);
    assert.deepEqual(await bytes(requests[0].form.get("document")), readFileSync(image));
  }
});

test("a document goes up with its name, and no caption field when there is none", async () => {
  const result = await grog(["telegram-send-document", "--to", "42", document]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /document sent to Telegram/);
  const file = requests[0].form.get("document");
  assert.equal(file.name, "notes.csv");
  assert.equal(await file.text(), "a,b\n1,2\n");
  assert.equal(requests[0].form.get("caption"), null);
});

test("a refused upload reports Telegram's reason and never the token", async () => {
  reply = { status: 400, body: { ok: false, description: "Bad Request: chat not found" } };
  for (const [command, file] of [["telegram-send-image", image], ["telegram-send-document", document]]) {
    const result = await grog([command, "--to", "42", file, CAPTION]);
    assert.equal(result.code, 1);
    assert.match(result.err, /chat not found/);
    assert.doesNotMatch(result.err + result.out, /never-print-this-token/);
  }
});

test("an unreachable API fails without printing the token", async () => {
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const deadApi = `http://127.0.0.1:${closed.address().port}`;
  await new Promise((resolve) => closed.close(resolve));
  for (const [command, file] of [["telegram-send-image", image], ["telegram-send-document", document]]) {
    const result = await grog([command, "--to", "42", file, CAPTION], deadApi);
    assert.equal(result.code, 1);
    assert.match(result.err, /failed to send/);
    assert.doesNotMatch(result.err + result.out, /never-print-this-token/);
  }
});
