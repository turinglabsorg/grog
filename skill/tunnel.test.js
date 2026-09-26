import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createHash } from "node:crypto";

// The whole path of a public link: the relay (tunnel/relay.py) on local ports
// with a throwaway CA, an app on localhost, and `grog up` between them.
const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "index.js");
const relayPath = join(here, "..", "tunnel", "relay.py");
const scratch = mkdtempSync(join(tmpdir(), "grog-tunnel-"));
const children = [];
let app;
after(() => {
  for (const child of children) child.kill();
  app?.close();
  rmSync(scratch, { recursive: true, force: true });
});

const have = (cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
const skip = !have("openssl") || !have("python3") ? "needs openssl and python3" : false;

function sh(args, input) {
  const result = spawnSync("openssl", args, { cwd: scratch, input, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

let httpsPort;
let appPort;
const env = () => ({
  ...process.env,
  HOME: scratch,
  PATH: "/usr/bin:/bin",
  GROG_TUNNEL_HOST: "up.grog.test",
  GROG_TUNNEL_ADDRESS: "127.0.0.1",
  GROG_TUNNEL_PORT: String(httpsPort),
  GROG_TUNNEL_CA: join(scratch, "ca.pem"),
  GROG_TUNNEL_TOKEN: "test-token",
});

function get(host, path = "/") {
  return new Promise((resolve) => {
    const request = https.get(
      { host: "127.0.0.1", port: httpsPort, path, servername: host, headers: { host }, ca: readFileSync(join(scratch, "ca.pem")) },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode, body }));
      },
    );
    request.on("error", (error) => resolve({ status: 0, body: String(error) }));
  });
}

function up(args, extraEnv = {}) {
  const child = spawn(process.execPath, [cliPath, "up", ...args], { env: { ...env(), ...extraEnv } });
  children.push(child);
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  const url = new Promise((resolve) => {
    const timer = setInterval(() => {
      const match = out.match(/https:\/\/([a-z0-9]+\.grog\.test)/);
      if (match || out.includes("error")) {
        clearInterval(timer);
        resolve(match ? match[1] : out);
      }
    }, 50);
  });
  return { child, url, output: () => out };
}

before(async () => {
  if (skip) return;
  sh(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=grog test CA", "-keyout", "ca.key", "-out", "ca.pem",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  sh(["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=*.grog.test", "-keyout", "key.pem", "-out", "req.csr"]);
  writeFileSync(join(scratch, "ext.cnf"), "subjectAltName=DNS:*.grog.test,DNS:grog.test\nextendedKeyUsage=serverAuth\n");
  sh(["x509", "-req", "-in", "req.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "1", "-extfile", "ext.cnf", "-out", "cert.pem"]);
  writeFileSync(join(scratch, "token.sha256"), createHash("sha256").update("test-token").digest("hex"));

  app = http.createServer((req, res) => res.end(`hello ${req.url}`));
  app.on("upgrade", (req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (data) => socket.write(data.toString().toUpperCase()));
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  appPort = app.address().port;

  httpsPort = await freePort();
  const relay = spawn("python3", [relayPath], {
    env: {
      ...process.env,
      GROG_RELAY_DOMAIN: "grog.test",
      GROG_RELAY_CERT: join(scratch, "cert.pem"),
      GROG_RELAY_KEY: join(scratch, "key.pem"),
      GROG_RELAY_TOKEN_SHA256: join(scratch, "token.sha256"),
      GROG_RELAY_HTTPS_PORT: String(httpsPort),
      GROG_RELAY_HTTP_PORT: String(await freePort()),
    },
  });
  children.push(relay);
  await new Promise((resolve) => relay.stderr.on("data", (chunk) => String(chunk).includes("grog relay") && resolve()));
});

test("refuses a port that is not one", { skip }, () => {
  const result = spawnSync(process.execPath, [cliPath, "up", "http"], { encoding: "utf8", env: env() });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid port/);
});

test("refuses without a token, before connecting", { skip }, () => {
  const result = spawnSync(process.execPath, [cliPath, "up", "4000"], { encoding: "utf8", env: { ...env(), GROG_TUNNEL_TOKEN: "" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no tunnel token/);
});

test("the relay turns away a wrong token", { skip }, async () => {
  const { url } = up([String(appPort)], { GROG_TUNNEL_TOKEN: "wrong" });
  assert.match(await url, /invalid tunnel token/);
});

test("a link serves the app, keeps WebSockets, and closes with the command", { skip }, async () => {
  const { child, url } = up([String(appPort)]);
  const host = await url;
  assert.match(host, /^[a-z0-9]{10}\.grog\.test$/);

  const page = await get(host, "/path?x=1");
  assert.deepEqual(page, { status: 200, body: "hello /path?x=1" });

  const pages = await Promise.all(Array.from({ length: 10 }, (_, i) => get(host, `/${i}`)));
  assert.deepEqual(pages.map((p) => p.body), Array.from({ length: 10 }, (_, i) => `hello /${i}`));

  const echoed = await new Promise((resolve) => {
    const socket = tls.connect({ host: "127.0.0.1", port: httpsPort, servername: host, ca: readFileSync(join(scratch, "ca.pem")) }, () => {
      socket.write(`GET /ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\r\n\r\n") && !data.includes("PING")) socket.write("ping");
      if (data.includes("PING")) { socket.destroy(); resolve(data); }
    });
  });
  assert.match(echoed, /101 Switching Protocols[\s\S]*PING/);

  assert.equal((await get("nosuchlink.grog.test")).status, 404);

  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 800));
  const closed = await get(host);
  assert.equal(closed.status, 404);
  assert.match(closed.body, /not open/);
});

test("a hostile relay gets nothing but streams to the one port", { skip }, async () => {
  // A relay that lies: a link outside the domain with terminal escapes in it.
  const evil = tls.createServer({ cert: readFileSync(join(scratch, "cert.pem")), key: readFileSync(join(scratch, "key.pem")) }, (socket) => {
    socket.once("data", () => socket.write('{"url":"https://evil.example/\\u001b[2J","code":"x","secret":"y"}\nN 1\n'));
  });
  await new Promise((resolve) => evil.listen(0, "127.0.0.1", resolve));
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, "up", String(appPort)], { env: { ...env(), GROG_TUNNEL_PORT: String(evil.address().port) } });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("exit", (code) => resolve({ code, out }));
  });
  evil.close();
  assert.equal(result.code, 1);
  assert.match(result.out, /unexpected reply/);
  assert.doesNotMatch(result.out, /evil\.example|\u001b/);
});
