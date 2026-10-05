import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  checkPassword,
  createBoard,
  createSites,
  createStats,
  hashPassword,
  isBot,
  isPagePath,
  isScanPath,
  listenCountingProxy,
  track,
} from "./board.js";

const scratch = mkdtempSync(join(tmpdir(), "grog-board-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const haveSqlite = spawnSync("sqlite3", ["-version"], { stdio: "ignore" }).status === 0;

function req(method, url, headers = {}) {
  return { method, url, headers };
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function call(port, options, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, ...options }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

test("a view is a document, not an asset", () => {
  assert.equal(isPagePath("/"), true);
  assert.equal(isPagePath("/pricing"), true);
  assert.equal(isPagePath("/index.html"), true);
  assert.equal(isPagePath("/css/a.css"), false);
  assert.equal(isPagePath("/app.js"), false);
  assert.equal(isPagePath("/photo.PNG"), false);
  assert.equal(isPagePath("/favicon.ico"), false);
});

test("scanner paths are probes and known clients are bots", () => {
  assert.equal(isScanPath("/"), false);
  assert.equal(isScanPath("/pricing"), false);
  assert.equal(isScanPath("/feed/v1/briefings"), false);
  assert.equal(isScanPath("/admin"), false);
  assert.equal(isScanPath("/.well-known/security.txt"), false);
  assert.equal(isScanPath("/.well-known/acme-challenge/token"), false);
  assert.equal(isScanPath("/.env"), true);
  assert.equal(isScanPath("/.env?x=1"), true);
  assert.equal(isScanPath("/a/.env"), true);
  assert.equal(isScanPath("/.git/config"), true);
  assert.equal(isScanPath("/%2eenv"), true);
  assert.equal(isScanPath("/%252eenv"), true);
  assert.equal(isScanPath("/../secret"), true);
  assert.equal(isScanPath("/css/../.env"), true);
  assert.equal(isScanPath("/wp-admin/install.php"), true);
  assert.equal(isScanPath("/wp-login.php"), true);
  assert.equal(isScanPath("/xmlrpc.php"), true);
  assert.equal(isScanPath("/file.php"), true);
  assert.equal(isScanPath("/backup.bak"), true);
  assert.equal(isScanPath("/vendor/pkg"), true);
  assert.equal(isScanPath("/page\\..\\win.ini"), true);
  assert.equal(isBot(""), false);
  assert.equal(isBot(undefined), false);
  assert.equal(isBot("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"), false);
  assert.equal(isBot("bottom of the page"), false);
  assert.equal(isBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), true);
  assert.equal(isBot("curl/8.7.1"), true);
  assert.equal(isBot("python-requests/2.32.0"), true);
});

test("probes and bots are not planned, and the country header is still removed", { skip: haveSqlite ? false : "needs sqlite3" }, async () => {
  const stats = createStats({ dbPath: join(scratch, "bots.sqlite"), now: () => new Date("2026-10-05T12:00:00") });
  await stats.ready;
  const probeHeaders = { "user-agent": "Mozilla/5.0", "x-grog-country": "US" };
  const botHeaders = { "user-agent": "curl/8.7.1", "x-grog-country": "CN" };
  assert.equal(stats.plan("alien.test", req("GET", "/.env", probeHeaders)), null);
  assert.equal(stats.plan("alien.test", req("GET", "/", botHeaders)), null);
  assert.equal(probeHeaders["x-grog-country"], undefined);
  assert.equal(botHeaders["x-grog-country"], undefined);
  const person = stats.plan("alien.test", req("GET", "/", { "user-agent": "Mozilla/5.0" }));
  const bare = stats.plan("alien.test", req("GET", "/pricing"));
  assert.equal(person.path, "/");
  assert.equal(bare.path, "/pricing");
  await stats.close();
});

test("password check accepts only the password that was hashed", () => {
  const stored = hashPassword("correct horse");
  assert.equal(checkPassword("correct horse", stored), true);
  assert.equal(checkPassword("wrong", stored), false);
  assert.equal(checkPassword("correct horse", { salt: "zz", hash: "zz" }), false);
});

test("counts documents, ignores assets, and keeps a quote in a path", { skip: haveSqlite ? false : "needs sqlite3" }, async () => {
  const dbPath = join(scratch, "one.sqlite");
  const fixed = new Date("2026-10-05T12:00:00");
  const stats = createStats({ dbPath, now: () => fixed });
  await stats.ready;
  const page = stats.plan("alien.test", req("GET", "/"));
  const again = stats.plan("alien.test", req("GET", "/", { cookie: `grog_seen=${page.cookie.match(/grog_seen=([^;]+)/)[1]}` }));
  const style = stats.plan("alien.test", req("GET", "/a.css"));
  const odd = stats.plan("alien.test", req("GET", "/it's"));
  assert.equal(style, null);
  stats.commit(page);
  stats.commit(again);
  stats.commit(odd);
  await stats.idle();
  const shot = stats.snapshot([{ host: "alien.test", state: "online", kind: "dir" }]);
  const host = shot.hosts.find((row) => row.host === "alien.test");
  assert.equal(host.views, 3);
  assert.equal(host.visitors, 2);
  assert.equal(host.state, "online");
  await stats.close();

  const reopened = createStats({ dbPath, now: () => fixed });
  await reopened.ready;
  const saved = reopened.snapshot([]).hosts.find((row) => row.host === "alien.test");
  assert.equal(saved.views, 3);
  assert.deepEqual(saved.paths.map((item) => item.path).sort(), ["/", "/it's"]);
  await reopened.close();
});

test("the board page stays locked until the password, then shows the live sites", async () => {
  const stats = createStats({ dbPath: join(scratch, "board.sqlite"), now: () => new Date("2026-10-05T12:00:00") });
  await stats.ready;
  const sites = createSites();
  sites.note("alien.test", { kind: "port", state: "online" });
  const board = createBoard({ stats, sites, auth: hashPassword("board-secret") });
  const server = await listen(board.handler);
  const port = server.address().port;
  try {
    const locked = await call(port, { path: "/", method: "GET" });
    assert.equal(locked.status, 200);
    assert.match(locked.body, /password/);
    assert.doesNotMatch(locked.body, /alien\.test/);
    const wordmark = locked.body.match(/<pre>([\s\S]*?)<\/pre>/)[1].split("\n");
    assert.equal(wordmark.length, 5);
    assert.ok(wordmark.every((line) => line.length === wordmark[0].length));
    assert.match(wordmark[0], /^ {2}____/);
    const denied = await call(port, { path: "/api/snapshot", method: "GET" });
    assert.equal(denied.status, 401);
    const bad = await call(port, { path: "/login", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } }, "password=nope");
    assert.equal(bad.status, 401);
    const good = await call(port, { path: "/login", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } }, "password=board-secret");
    assert.equal(good.status, 303);
    const cookie = good.headers["set-cookie"][0].split(";")[0];
    const open = await call(port, { path: "/", method: "GET", headers: { cookie } });
    assert.match(open.body, /alien\.test/);
    assert.match(open.body, /online/);
    assert.match(open.body, /referrals today/);
    assert.match(open.body, /campaigns today/);
    assert.match(open.body, /countries today/);
    assert.match(open.body, />log</);
    assert.match(open.body, /max-width: 720px/);
    assert.match(locked.body, /max-width: 720px/);
    const snap = await call(port, { path: "/api/snapshot", method: "GET", headers: { cookie } });
    assert.equal(JSON.parse(snap.body).hosts[0].host, "alien.test");
  } finally {
    server.close();
    await stats.close();
  }
});

test("a port site is counted through the local proxy and the bytes still pass", async () => {
  const seen = [];
  const origin = await listen((req, res) => {
    seen.push(req.headers["x-grog-country"] || "");
    res.writeHead(req.url === "/missing" ? 404 : 200, { "Content-Type": "text/plain" });
    res.end(`from-app ${req.url}`);
  });
  const stats = createStats({ dbPath: join(scratch, "proxy.sqlite"), now: () => new Date("2026-10-05T12:00:00") });
  await stats.ready;
  const proxy = await listenCountingProxy(origin.address().port, stats, "app.test");
  try {
    const page = await call(proxy.address().port, {
      path: "/?utm_source=news&utm_medium=social&utm_campaign=oct&token=secret",
      method: "GET",
      headers: { "x-grog-country": "it", referer: "https://news.example/a?token=1" },
    });
    const asset = await call(proxy.address().port, { path: "/app.js", method: "GET", headers: { "x-grog-country": "IT" } });
    const missing = await call(proxy.address().port, { path: "/missing", method: "GET", headers: { "x-grog-country": "US" } });
    await stats.idle();
    assert.equal(page.body, "from-app /?utm_source=news&utm_medium=social&utm_campaign=oct&token=secret");
    assert.match(page.headers["set-cookie"][0], /grog_seen=/);
    assert.equal(asset.body, "from-app /app.js");
    assert.equal(asset.headers["set-cookie"], undefined);
    assert.equal(missing.status, 404);
    assert.deepEqual(seen, ["", "", ""]);
    const shot = stats.snapshot([{ host: "app.test" }]);
    assert.equal(shot.hosts[0].views, 1);
    assert.deepEqual(shot.hosts[0].paths, [{ path: "/", views: 1 }]);
    assert.equal(shot.hosts[0].refs[0].ref, "news.example");
    assert.equal(shot.hosts[0].countries[0].cc, "IT");
    assert.equal(shot.hosts[0].campaigns[0].name, "news / social / oct");
    assert.equal(JSON.stringify(shot).includes("secret"), false);
    const probe = await call(proxy.address().port, {
      path: "/.env",
      method: "GET",
      headers: { "user-agent": "Mozilla/5.0", "x-grog-country": "CN" },
    });
    const encoded = await call(proxy.address().port, { path: "/%2eenv", method: "GET" });
    const bot = await call(proxy.address().port, { path: "/", method: "GET", headers: { "user-agent": "curl/8.7.1" } });
    const wellKnown = await call(proxy.address().port, { path: "/.well-known/security.txt", method: "GET" });
    await stats.idle();
    assert.equal(probe.status, 404);
    assert.equal(probe.body, "Not found");
    assert.equal(probe.headers["x-content-type-options"], "nosniff");
    assert.equal(probe.headers["cache-control"], "no-store");
    assert.equal(encoded.status, 404);
    assert.equal(encoded.body, "Not found");
    assert.equal(bot.status, 200);
    assert.equal(bot.body, "from-app /");
    assert.equal(wellKnown.status, 200);
    assert.equal(wellKnown.body, "from-app /.well-known/security.txt");
    assert.deepEqual(seen, ["", "", "", "", ""]);
    const after = stats.snapshot([{ host: "app.test" }]);
    assert.equal(after.hosts[0].views, 1);
    assert.equal(after.events.length, 1);
    assert.equal(after.events[0].path, "/");
  } finally {
    proxy.close();
    origin.close();
    await stats.close();
  }
});

test("a static response records the view when it is served", async () => {
  const stats = createStats({ dbPath: join(scratch, "static.sqlite"), now: () => new Date("2026-10-05T12:00:00") });
  await stats.ready;
  const server = await listen((req, res) => {
    track(stats, "files.test", req, res);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("page");
  });
  try {
    const result = await call(server.address().port, { path: "/hello", method: "GET", headers: { referer: "https://news.example/a?token=1" } });
    await stats.idle();
    assert.equal(result.body, "page");
    const host = stats.snapshot([]).hosts[0];
    assert.equal(host.views, 1);
    assert.equal(host.refs[0].ref, "news.example");
  } finally {
    server.close();
    await stats.close();
  }
});

test("referrals, campaigns and country are kept, and the query is not", { skip: haveSqlite ? false : "needs sqlite3" }, async () => {
  const dbPath = join(scratch, "detail.sqlite");
  const fixed = new Date("2026-10-05T12:00:00");
  const stats = createStats({ dbPath, now: () => fixed });
  await stats.ready;
  const directHeaders = { "x-grog-country": "IT" };
  const direct = stats.plan("alien.test", req("GET", "/", directHeaders));
  const campaignHeaders = { referer: "https://news.example/a?token=1", "x-grog-country": "de" };
  const campaign = stats.plan("alien.test", req("GET", "/pricing?utm_source=news&utm_medium=social&utm_campaign=oct&token=secret", campaignHeaders));
  const junkHeaders = { "x-grog-country": "Italy" };
  const junk = stats.plan("alien.test", req("GET", `/x?utm_source=${encodeURIComponent("bad value")}&utm_campaign=${"a".repeat(80)}`, junkHeaders));
  assert.equal(directHeaders["x-grog-country"], undefined);
  assert.equal(campaignHeaders["x-grog-country"], undefined);
  assert.equal(junkHeaders["x-grog-country"], undefined);
  assert.equal(direct.ref, "(direct)");
  assert.equal(direct.cc, "IT");
  assert.equal(direct.campaign, "");
  assert.equal(campaign.ref, "news.example");
  assert.equal(campaign.cc, "DE");
  assert.equal(campaign.campaign, "news / social / oct");
  assert.equal(junk.ref, "(direct)");
  assert.equal(junk.cc, "");
  assert.equal(junk.campaign, "");
  stats.commit(direct);
  stats.commit(campaign);
  stats.commit(junk);
  await stats.idle();
  await stats.close();

  const reopened = createStats({ dbPath, now: () => fixed });
  await reopened.ready;
  const shot = reopened.snapshot([]);
  const host = shot.hosts.find((row) => row.host === "alien.test");
  const blob = JSON.stringify(shot);
  assert.equal(blob.includes("token"), false);
  assert.equal(blob.includes("secret"), false);
  assert.deepEqual(host.refs.map((item) => item.ref).sort(), ["(direct)", "news.example"]);
  assert.equal(host.refs.find((item) => item.ref === "(direct)").views, 2);
  assert.deepEqual(host.countries.map((item) => item.cc).sort(), ["DE", "IT"]);
  assert.deepEqual(host.campaigns, [{ name: "news / social / oct", views: 1 }]);
  assert.deepEqual(shot.events.map((item) => item.path), ["/x", "/pricing", "/"]);
  assert.equal(shot.events[1].ref, "news.example");
  assert.equal(shot.events[1].cc, "DE");
  assert.equal(shot.events[1].campaign, "news / social / oct");
  assert.equal(shot.events[0].cc, "");
  assert.equal(shot.events[2].cc, "IT");
  assert.match(shot.events[0].at, /^\d{4}-\d{2}-\d{2}T/);
  await reopened.close();
});
