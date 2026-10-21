import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";

const cli = join(dirname(fileURLToPath(import.meta.url)), "index.js");
const scratch = mkdtempSync(join(tmpdir(), "grog-sms-test-"));
const token = "sms-test-credential-never-print";
const number = "+31612345678";
let server, api, requests, respond;

before(async () => {
  mkdirSync(join(scratch, ".grog"));
  writeFileSync(join(scratch, ".grog/config.json"), "{}\n");
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = {method: req.method, url: new URL(req.url, api), headers: req.headers, body: Buffer.concat(chunks).toString()};
    requests.push(request);
    const reply = respond(request);
    res.writeHead(reply.status || 200, {"content-type": "application/json"});
    res.end(JSON.stringify(reply.body));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${server.address().port}/v1`;
});
beforeEach(() => {
  requests = [];
  writeFileSync(join(scratch, ".grog/config.json"), "{}\n");
  rmSync(join(scratch, ".grog/sms-state"), {recursive: true, force: true});
  respond = () => ({body: {numbers: [{_id: "number-1", phoneNumber: number, country: "NL", status: "active", smsCapable: true, smsRequested: true}], connected: [{phoneNumber: "+31699999999"}]}});
});

function inbox(messages, overrides = {}) {
  respond = request => {
    const path = request.url.pathname;
    if (path === "/v1/phone-numbers") return {body: {numbers: [{_id: "number-1", phoneNumber: number, country: "NL", status: "active", smsCapable: true, ...overrides}]}};
    if (path === "/v1/accounts") return {body: {accounts: [
      {_id: "sms-account", platform: "sms", username: number, isActive: true},
      {_id: "other-account", platform: "sms", username: "+31699999999", isActive: true},
      {_id: "wa-account", platform: "whatsapp", username: number, isActive: true},
    ]}};
    if (path === "/v1/inbox/conversations") return {body: {data: [
      {id: "opaque/thread", platform: "sms", accountId: "sms-account", participantId: "Apple", updatedTime: new Date().toISOString()},
      {id: "wrong-number", platform: "sms", accountId: "other-account", participantId: "Apple"},
      {id: "wrong-platform", platform: "whatsapp", accountId: "sms-account", participantId: "Apple"},
    ]}};
    if (path === "/v1/inbox/conversations/opaque%2Fthread/messages") return {body: {messages}};
    if (path === "/v1/sms/messages") return {body: {id: "sent-message", conversationId: "thread", status: "sent"}};
    if (path === "/v1/phone-numbers/number-1/sms") return {body: {enabled: true, smsCapable: true}};
    return {status: 404, body: {error: "Unexpected request"}};
  };
}

function message(id, text, overrides = {}) {
  return {id, message: text, createdAt: new Date().toISOString(), direction: "incoming", platform: "sms", accountId: "sms-account", conversationId: "opaque/thread", ...overrides};
}

test("SMS inbox remains scoped to the owned number/account and treats opaque conversation ids verbatim", async () => {
  inbox([message("right", "hello"), message("wrong", "private other account", {accountId: "other-account"}), message("deleted", "deleted text", {isDeleted: true})]);
  const result = await grog(["sms-read", "--number", number, "--json"]);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(JSON.parse(result.out).messages.map(item => item.id), ["right"]);
  assert.equal(requests.find(req => req.url.pathname === "/v1/accounts").url.searchParams.get("platform"), "sms");
  const conversations = requests.find(req => req.url.pathname === "/v1/inbox/conversations");
  assert.equal(conversations.url.searchParams.get("accountId"), "sms-account");
  assert.equal(conversations.url.searchParams.get("platform"), "sms");
  assert.equal(requests.filter(req => req.url.pathname.includes("/messages")).length, 1);
});

test("non-owned, inactive, and incapable numbers stop before reading any inbox", async () => {
  for (const [selected, overrides] of [["+31600000000", {}], [number, {status: "suspended"}], [number, {smsCapable: false}]]) {
    requests = []; inbox([], overrides);
    const result = await grog(["sms-read", "--number", selected]);
    assert.equal(result.code, 1);
    assert.equal(requests.length, 1);
  }
});

test("argument errors stop before the API or hush", async () => {
  for (const args of [
    ["sms-send", "--number", number, "--to", "+31687654321", "bad\\ntext"],
    ["sms-send", "--number", number, "--to", "+31687654321"],
    ["sms-read", "--number", "unconfigured-alias"],
    ["sms-read", "--number", number, "--unknown", "x"],
    ["sms-read", "--number", number, "--limit", "0"],
    ["sms-recv", "--number", number, "--timeout", "NaN"],
    ["sms-recv", "--number", number, "--since", "yesterday"],
    ["sms-recv", "--number", number, "--otp-env", "HOME", "--", "true"],
    ["sms-recv", "--number", number, "--otp-env", "LOGIN_OTP", "--", "true"],
    ["sms-recv", "--number", number, "--since", new Date(Date.now() - 600000).toISOString(), "--contains", "Apple", "--otp-env", "LOGIN_OTP", "--", "true"],
  ]) {
    const result = await grog(args, {ZERNIO_API_KEY: ""});
    assert.equal(result.code, 1, args.join(" "));
    assert.equal(requests.length, 0);
    assert.ok(!result.err.includes("Store the SMS credential"), result.err);
  }
});

test("SMS send supports contacts, exact UTF-8 files, generic routing and an explicit idempotency key", async () => {
  inbox([]);
  writeFileSync(join(scratch, ".grog/config.json"), JSON.stringify({addressBook: {line: {sms: number}, recipient: {sms: "+31687654321"}}}));
  const text = "A literal $(touch /tmp/grog-sms-injection), quotes ' and \".\nSecond line.";
  const file = join(scratch, "message.md"); writeFileSync(file, text);
  const result = await grog(["send", "--sms", "--number", "line", "--to", "recipient", "--idempotency-key", "send-once", file]);
  assert.equal(result.code, 0, result.err);
  const post = requests.find(request => request.method === "POST");
  assert.deepEqual(JSON.parse(post.body), {from: number, to: "+31687654321", text});
  assert.equal(post.headers["idempotency-key"], "send-once");
  assert.equal(JSON.parse(result.out).status, "sent");
});

test("SMS API refusals never echo credentials or retry an ambiguous send", async () => {
  inbox([]); const previous = respond;
  respond = request => request.method === "POST" ? {status: 502, body: {error: `failed ${token} 813579`}} : previous(request);
  const result = await grog(["sms-send", "--number", number, "--to", "+31687654321", "hello"]);
  assert.equal(result.code, 1);
  assert.match(result.err, /HTTP 502/);
  assert.ok(!result.err.includes(token));
  assert.ok(!result.err.includes("813579"));
  assert.equal(requests.filter(request => request.method === "POST").length, 1);
});

test("SMS enabling uses only the verified owned record and talk sends no welcome message", async () => {
  inbox([]);
  const enabled = await grog(["sms-enable", "--number", number]);
  assert.equal(enabled.code, 0, enabled.err);
  assert.equal(requests.find(request => request.method === "POST").url.pathname, "/v1/phone-numbers/number-1/sms");
  requests = [];
  const talk = await grog(["talk", "--sms", "--number", number]);
  assert.equal(talk.code, 0, talk.err);
  assert.equal(JSON.parse(talk.out).ready, true);
  assert.ok(requests.every(request => request.method === "GET"));
});

test("fresh SMS OTP reaches only the child environment, is redacted across chunks and is never replayed or stored", async () => {
  const fresh = message("fresh", "Your Apple Account code is 813579.");
  inbox([fresh, message("old", "Apple code 222333", {createdAt: new Date(Date.now() - 600000).toISOString()}), message("outbound", "Apple code 111222", {direction: "outgoing"})]);
  const since = new Date(Date.now() - 10000).toISOString();
  const consumer = "if(process.env.LOGIN_OTP!=='813579'||process.env.ZERNIO_API_KEY||process.env.BW_SESSION)process.exit(7);process.stdout.write(process.env.LOGIN_OTP.slice(0,2));setTimeout(()=>process.stdout.write(process.env.LOGIN_OTP.slice(2)),10);";
  const args = ["recv", "--sms", "--number", number, "--since", since, "--contains", "Apple", "--timeout", "0", "--otp-env", "LOGIN_OTP", "--", process.execPath, "-e", consumer, "--", "--discord"];
  const result = await grog(args, {BW_SESSION: "never-pass-this-session"});
  assert.equal(result.code, 0, result.err);
  assert.ok(!result.out.includes("813579"));
  assert.match(result.out, /redacted SMS code/);
  assert.match(result.out, /sms-code-consumed/);
  const directory = join(scratch, ".grog/sms-state");
  const files = readdirSync(directory);
  assert.equal(files.length, 1);
  const state = readFileSync(join(directory, files[0]), "utf8");
  assert.ok(!state.includes("813579") && !state.includes("Apple"));
  assert.equal(statSync(join(directory, files[0])).mode & 0o777, 0o600);
  const again = await grog(args);
  assert.equal(again.code, 2, again.err);
  assert.equal(JSON.parse(again.out).message, null);
});

test("ambiguous OTP messages and old/outgoing messages never start the consumer", async () => {
  inbox([
    message("ambiguous", "Apple code 123456, previous code 654321"),
    message("outgoing", "Apple 813579", {direction: "outgoing"}),
    message("old", "Apple 813579", {createdAt: new Date(Date.now() - 600000).toISOString()}),
    message("future", "Apple 813579", {createdAt: new Date(Date.now() + 600000).toISOString()}),
  ]);
  const result = await grog(["sms-recv", "--number", number, "--since", new Date(Date.now() - 10000).toISOString(), "--contains", "Apple", "--timeout", "0", "--otp-env", "LOGIN_OTP", "--", process.execPath, "-e", "process.exit(9)"]);
  assert.equal(result.code, 2, result.err);
  assert.equal(JSON.parse(result.out).message, null);
});

test("same-time messages are received once each across calls", async () => {
  const first = message("a", "one");
  inbox([first, message("b", "two", {createdAt: first.createdAt})]);
  const args = ["sms-recv", "--number", number, "--since", new Date(Date.now() - 10000).toISOString(), "--timeout", "0"];
  const one = await grog(args), two = await grog(args), three = await grog(args);
  assert.equal(JSON.parse(one.out).message.id, "a");
  assert.equal(JSON.parse(two.out).message.id, "b");
  assert.equal(three.code, 2);
});

test("partial API failure and incomplete pagination cannot report a successful empty inbox", async () => {
  for (const metadata of [{meta: {accountsFailed: 1}, data: []}, {pagination: {hasMore: true}, data: []}]) {
    requests = []; inbox([]); const previous = respond;
    respond = request => request.url.pathname === "/v1/inbox/conversations" ? {body: metadata} : previous(request);
    const result = await grog(["sms-recv", "--number", number, "--timeout", "0"]);
    assert.equal(result.code, 1, result.err);
  }
});

test("a missing credential is injected by named hush re-execution", async () => {
  const bin = join(scratch, "bin"); mkdirSync(bin, {recursive: true});
  const script = `#!${process.execPath}\nimport{spawnSync}from'node:child_process';const a=process.argv.slice(2);if(a.slice(0,8).join('|')!=='run|--name|ZERNIO_API_KEY|--env|ZERNIO_API_KEY|--redact|--|'+${JSON.stringify(process.execPath)})process.exit(8);const r=spawnSync(a[7],a.slice(8),{env:{...process.env,ZERNIO_API_KEY:${JSON.stringify(token)}},stdio:'inherit'});process.exit(r.status??1);\n`;
  writeFileSync(join(bin, "hush"), script, {mode: 0o700});
  const result = await grog(["sms-numbers"], {ZERNIO_API_KEY: "", PATH: `${bin}:${process.env.PATH}`});
  assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out).numbers[0].phoneNumber, number);
});

test("contact SMS entries preserve the other channels", async () => {
  writeFileSync(join(scratch, ".grog/config.json"), JSON.stringify({addressBook: {friend: {whatsapp: "31699999999", discord: "123456789012345678"}}}));
  const result = await grog(["contacts", "save", "friend", "--sms", number]);
  assert.equal(result.code, 0, result.err);
  const entry = JSON.parse(readFileSync(join(scratch, ".grog/config.json"), "utf8")).addressBook.friend;
  assert.equal(entry.sms, number);
  assert.equal(entry.whatsapp, "31699999999");
  assert.equal(entry.discord, "123456789012345678");
});
after(() => {server?.close(); rmSync(scratch, {recursive: true, force: true});});

function grog(args, extra = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], {cwd: scratch, env: {PATH: process.env.PATH, HOME: scratch, ZERNIO_API_KEY: token, GROG_ZERNIO_API: api, ...extra}});
    let out = "", err = "";
    child.stdout.on("data", data => out += data);
    child.stderr.on("data", data => err += data);
    child.on("close", code => resolve({code, out, err}));
  });
}

test("sms-numbers reads owned-number capabilities without exposing credentials or unrelated data", async () => {
  const result = await grog(["sms-numbers", "--json"]);
  assert.equal(result.code, 0, result.err);
  const data = JSON.parse(result.out);
  assert.equal(data.numbers.length, 1);
  assert.equal(data.numbers[0].phoneNumber, number);
  assert.equal(data.numbers[0].smsCapable, true);
  assert.equal(requests[0].url.pathname, "/v1/phone-numbers");
  assert.equal(requests[0].headers.authorization, `Bearer ${token}`);
  assert.ok(!result.out.includes(token));
  assert.ok(!result.out.includes("31699999999"));
});


test("the SMS consumer receives its help flag verbatim and failure never replays the code", async () => {
  inbox([message("consumer-fails", "Example code 813579")]);
  const args = ["sms-recv", "--number", number, "--since", new Date(Date.now() - 10000).toISOString(), "--contains", "Example", "--timeout", "0", "--otp-env", "LOGIN_OTP", "--", process.execPath, "-e", "process.exit(process.argv.includes('--help') ? 7 : 9)", "--", "--help"];
  const first = await grog(args);
  assert.equal(first.code, 7, first.err);
  assert.match(first.out, /sms-code-consumed/);
  assert.equal((await grog(args)).code, 2);
});

test("SMS conversation and message pagination follows opaque cursors without crossing accounts", async () => {
  inbox([]); const previous = respond;
  respond = request => {
    if (request.url.pathname === "/v1/inbox/conversations") {
      if (!request.url.searchParams.has("cursor")) return {body: {data: [], pagination: {hasMore: true, nextCursor: "thread/page 2"}}};
      assert.equal(request.url.searchParams.get("cursor"), "thread/page 2");
      return previous(request);
    }
    if (request.url.pathname.endsWith("/messages")) {
      if (!request.url.searchParams.has("cursor")) return {body: {messages: [message("new", "hello")], pagination: {hasMore: true, nextCursor: "message/page 2"}}};
      assert.equal(request.url.searchParams.get("cursor"), "message/page 2");
      return {body: {messages: [message("old", "hello", {createdAt: new Date(Date.now() - 1000).toISOString()})]}};
    }
    return previous(request);
  };
  const result = await grog(["sms-read", "--number", number]);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(JSON.parse(result.out).messages.map(m => m.id), ["old", "new"]);
});

test("an untrusted SMS API override is refused before injecting a credential", async () => {
  const result = await grog(["sms-numbers"], {GROG_ZERNIO_API: "https://untrusted.invalid", ZERNIO_API_KEY: ""});
  assert.equal(result.code, 1);
  assert.match(result.err, /loopback test server/);
  assert.equal(requests.length, 0);
});
