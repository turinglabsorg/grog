import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
      const match = out.match(/https:\/\/([a-z0-9.-]+\.(?:grog|alien)\.test|alien\.test)\b/);
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
  mkdirSync(join(scratch, "domains", "alien.test"), { recursive: true });
  sh(["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=alien.test", "-keyout", "domains/alien.test/privkey.pem", "-out", "alien.csr"]);
  writeFileSync(join(scratch, "alien.cnf"), "subjectAltName=DNS:alien.test,DNS:*.alien.test\nextendedKeyUsage=serverAuth\n");
  sh(["x509", "-req", "-in", "alien.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "1", "-extfile", "alien.cnf", "-out", "domains/alien.test/fullchain.pem"]);

  app = http.createServer((req, res) => res.end(`hello ${req.url}`));
  app.on("upgrade", (req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (data) => socket.write(data.toString().toUpperCase()));
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  appPort = app.address().port;

  httpsPort = await freePort();
  httpPort = await freePort();
  await startRelay();
});

let httpPort;
let relay;
async function startRelay() {
  relay = spawn("python3", [relayPath], {
    env: {
      ...process.env,
      GROG_RELAY_DOMAIN: "grog.test",
      GROG_RELAY_CERT: join(scratch, "cert.pem"),
      GROG_RELAY_KEY: join(scratch, "key.pem"),
      GROG_RELAY_TOKEN_SHA256: join(scratch, "token.sha256"),
      GROG_RELAY_DOMAINS_DIR: join(scratch, "domains"),
      GROG_RELAY_HTTPS_PORT: String(httpsPort),
      GROG_RELAY_HTTP_PORT: String(httpPort),
      GROG_RELAY_STATE: join(scratch, "state.json"),
    },
  });
  children.push(relay);
  await new Promise((resolve) => relay.stderr.on("data", (chunk) => String(chunk).includes("grog relay") && resolve()));
}

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

test("says where it runs, and warns when nothing listens on the port", { skip }, async () => {
  const unused = await freePort();
  const { child, url, output } = up([String(unused)]);
  await url;
  await new Promise((resolve) => setTimeout(resolve, 500));
  child.kill();
  assert.match(output(), /-> localhost:\d+ on .+\((this machine|a container)\)/);
  assert.match(output(), /nothing is listening on localhost:\d+ here yet/);
  assert.match(output(), /run grog up there/);
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


test("a relay that falls silent is left, and the client reconnects", { skip }, async () => {
  // A relay that answers once and then says nothing, never closing: what the
  // client sees when the real relay or the network goes away without a reset.
  const sockets = [];
  let opens = 0;
  const silent = tls.createServer({ cert: readFileSync(join(scratch, "cert.pem")), key: readFileSync(join(scratch, "key.pem")) }, (socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.once("data", () => {
      opens += 1;
      socket.write('{"url":"https://abcdefghij.grog.test","code":"abcdefghij","secret":"s"}\n');
    });
  });
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const child = spawn(process.execPath, [cliPath, "up", String(appPort)], {
    env: { ...env(), GROG_TUNNEL_PORT: String(silent.address().port), GROG_TUNNEL_SILENCE_MS: "500" },
  });
  children.push(child);
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  for (let i = 0; i < 200 && !out.includes("reconnected"); i++) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  for (const socket of sockets) socket.destroy();
  silent.close();
  assert.match(out, /connection to the relay lost, reconnecting/);
  assert.match(out, /reconnected, same link/);
  assert.ok(opens >= 2);
});

test("a site domain gets its own certificate and a fixed address", { skip }, async () => {
  const { child, url } = up([String(appPort), "--domain", "alien.test"]);
  assert.equal(await url, "alien.test");
  assert.deepEqual(await get("alien.test", "/x"), { status: 200, body: "hello /x" });
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 800));
  const offline = await get("alien.test");
  assert.equal(offline.status, 404);
  assert.match(offline.body, /This site is offline/);
});

test("fixed names: under our domain yes, reserved or foreign no", { skip }, async () => {
  const demo = up([String(appPort), "--domain", "demo.grog.test"]);
  assert.equal(await demo.url, "demo.grog.test");
  assert.equal((await get("demo.grog.test")).status, 200);
  demo.child.kill();
  for (const name of ["up.grog.test", "a.b.grog.test", "example.com"]) {
    const { url } = up([String(appPort), "--domain", name]);
    assert.match(await url, /does not serve/, name);
  }
});

test("a second claim takes the host over and the first one stops", { skip }, async () => {
  const first = up([String(appPort), "--domain", "www.alien.test"]);
  assert.equal(await first.url, "www.alien.test");
  const exited = new Promise((resolve) => first.child.on("exit", resolve));
  const second = up([String(appPort), "--domain", "www.alien.test"]);
  assert.equal(await second.url, "www.alien.test");
  assert.equal(await exited, 1);
  assert.match(first.output(), /taken over/);
  assert.equal((await get("www.alien.test")).status, 200);
  second.child.kill();
});

test("grog serve keeps the sites of sites.json online, files only from their folder", { skip }, async () => {
  const site = join(scratch, "site");
  mkdirSync(join(site, "css"), { recursive: true });
  writeFileSync(join(site, "index.html"), "<h1>alien</h1>");
  writeFileSync(join(site, "css", "a.css"), "body{}");
  writeFileSync(join(site, "AGENTS.md"), "# Read me");
  writeFileSync(join(site, "install.sh"), "#!/bin/sh");
  writeFileSync(join(site, ".env"), "SECRET=1");
  writeFileSync(join(scratch, "outside.txt"), "outside");
  symlinkSync(join(scratch, "outside.txt"), join(site, "escape.txt"));
  writeFileSync(join(scratch, "sites.json"), JSON.stringify({
    "alien.test": { dir: site },
    "go.alien.test": { redirect: "https://alien.test" },
  }));
  const serve = spawn(process.execPath, [cliPath, "serve"], { env: { ...env(), GROG_SITES: join(scratch, "sites.json") } });
  children.push(serve);
  let out = "";
  serve.stdout.on("data", (chunk) => (out += chunk));
  serve.stderr.on("data", (chunk) => (out += chunk));
  for (let i = 0; i < 100 && (out.match(/-> localhost/g) || []).length < 2; i++) await new Promise((r) => setTimeout(r, 50));

  assert.deepEqual(await get("alien.test", "/"), { status: 200, body: "<h1>alien</h1>" });
  assert.equal((await get("alien.test", "/css/a.css")).body, "body{}");
  // Text a browser opens is served as text, not as a download.
  const type = (path) => new Promise((resolve) => https.get(
    { host: "127.0.0.1", port: httpsPort, path, servername: "alien.test", headers: { host: "alien.test" }, ca: readFileSync(join(scratch, "ca.pem")) },
    (res) => { res.resume(); resolve(res.headers["content-type"]); }));
  assert.equal(await type("/AGENTS.md"), "text/markdown; charset=utf-8");
  assert.equal(await type("/install.sh"), "text/plain; charset=utf-8");
  for (const path of ["/.env", "/%2e%2e/outside.txt", "/../outside.txt", "/escape.txt", "/css/../.env", "/nope.html"]) {
    const result = await get("alien.test", path);
    assert.equal(result.status, 404, path);
    assert.doesNotMatch(result.body, /SECRET|outside/, path);
  }
  const moved = await new Promise((resolve) => https.get(
    { host: "127.0.0.1", port: httpsPort, path: "/a?b=1", servername: "go.alien.test", headers: { host: "go.alien.test" }, ca: readFileSync(join(scratch, "ca.pem")) },
    (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location }); }));
  assert.deepEqual(moved, { status: 301, location: "https://alien.test/a?b=1" });

  // Removing a site from the file takes it offline.
  writeFileSync(join(scratch, "sites.json"), JSON.stringify({ "alien.test": { dir: site } }));
  for (let i = 0; i < 100 && !out.includes("[go.alien.test] stopped"); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.match((await get("go.alien.test")).body, /This site is offline/);
  serve.kill();
});


test("a restarted relay gives reconnecting clients the same link", { skip }, async () => {
  const { child, url, output } = up([String(appPort)]);
  const host = await url;
  assert.equal((await get(host)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 6000)); // the state file is written within 5 s
  const stopped = new Promise((resolve) => relay.on("exit", resolve));
  relay.kill("SIGTERM");
  await stopped;
  await startRelay();
  for (let i = 0; i < 150 && !output().includes("reconnected"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(output(), /reconnected, same link/);
  assert.deepEqual(await get(host, "/again"), { status: 200, body: "hello /again" });
  child.kill();
});
