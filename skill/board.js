// The serve board: a password page for the sites grog serve is keeping online,
// plus a small view count. Page loads only (no css, js, or images). Visitors
// are a first-party cookie hashed before it is stored: no address is kept.
// A referral is the previous site's host, or direct. A campaign is the three
// utm fields, nothing else from the query. Country is a two-letter code the
// relay already looked up; this process deletes that header before a site
// app can see it. Scanner paths are answered 404 before the site and are not
// counted. A known bot is still served and is not counted. An empty
// user-agent is counted. The password itself never lands here; the auth file
// holds scrypt only.

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";

const ASSETS = new Set([
  ".css", ".js", ".mjs", ".map", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  ".ico", ".avif", ".woff", ".woff2", ".ttf", ".eot", ".json", ".xml", ".txt",
  ".pdf", ".mp4", ".webm", ".zip", ".gz", ".wasm",
]);
const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 30;
const MAX_PATHS = 100;
const MAX_VISITORS = 5000;
const MAX_CAMPAIGNS = 50;
const MAX_EVENTS = 500;
const SHOW_EVENTS = 100;
const UTM_VALUE = /^[A-Za-z0-9._~-]{1,40}$/;
const SESSION_MS = 12 * 60 * 60 * 1000;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 10;

export function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isPagePath(pathname) {
  let path = String(pathname || "/");
  try { path = decodeURIComponent(path); } catch { return false; }
  if (path.includes("\0") || path.length > 300 || !path.startsWith("/")) return false;
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return true;
  return !ASSETS.has(base.slice(dot).toLowerCase());
}

const SCAN_EXT = new Set([
  ".php", ".php3", ".php5", ".phtml", ".asp", ".aspx", ".jsp", ".cgi",
  ".bak", ".old", ".swp", ".sql", ".ini", ".orig",
]);
const SCAN_SEGMENT = /^(wp-admin|wp-login|wp-content|wp-includes|xmlrpc\.php|phpmyadmin|pma|cgi-bin|phpunit|vendor)$/i;
const SCAN_MARK = /xmlrpc\.php|phpmyadmin|wp-login|wp-admin/i;
const BOT_UA = /bot(?:[^a-z]|$)|spider|crawler|crawl|slurp|wget\/|curl\/|python-requests|aiohttp|go-http-client|scrapy|okhttp|libwww|sqlmap|nikto|nmap|masscan|zgrab|nuclei|dirbuster|gobuster|feroxbuster|semrush|ahrefs|mj12bot|dotbot|petalbot|bytespider|gptbot|claudebot|anthropic|ccbot|headlesschrome|phantomjs|selenium|puppeteer/i;

function pathOnly(value) {
  const text = String(value || "/");
  const query = text.indexOf("?");
  return query >= 0 ? text.slice(0, query) : text;
}

function decodedScan(path) {
  if (path.includes("\0") || path.includes("\\")) return true;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "." || segment === "..") return true;
    if (segment.startsWith(".") && segment.toLowerCase() !== ".well-known") return true;
    if (SCAN_SEGMENT.test(segment)) return true;
  }
  if (SCAN_MARK.test(path)) return true;
  const base = segments.length ? segments[segments.length - 1] : "";
  const dot = base.lastIndexOf(".");
  if (dot > 0 && SCAN_EXT.has(base.slice(dot).toLowerCase())) return true;
  return false;
}

/** Probe paths: hidden files, dot segments, script leftovers, known panels. */
export function isScanPath(pathname) {
  let path = pathOnly(pathname);
  for (let pass = 0; pass < 2; pass += 1) {
    if (decodedScan(path)) return true;
    let next;
    try { next = decodeURIComponent(path); } catch { return true; }
    if (next === path) return false;
    path = next;
  }
  return decodedScan(path);
}

/** Known crawlers and clients. A blank user-agent is a person, not a bot. */
export function isBot(userAgent) {
  const ua = Array.isArray(userAgent) ? userAgent.join(" ") : String(userAgent || "");
  if (!ua.trim()) return false;
  return BOT_UA.test(ua);
}

/** 404 a probe here, before a site app or a redirect can see it. */
export function rejectScan(req, res) {
  if (!isScanPath(req.url || "/")) return false;
  if (req.headers) delete req.headers["x-grog-country"];
  const body = Buffer.from("Not found");
  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": body.length,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") res.end();
  else res.end(body);
  if (typeof req.resume === "function") req.resume();
  return true;
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

function visitorId(req) {
  const existing = cookieValue(req.headers.cookie, "grog_seen");
  if (/^[A-Za-z0-9_-]{12,64}$/.test(existing)) return { id: existing, fresh: false };
  return { id: randomBytes(12).toString("base64url"), fresh: true };
}

function seenCookie(id) {
  return `grog_seen=${id}; Path=/; Max-Age=31536000; SameSite=Lax; Secure; HttpOnly`;
}

function referrerHost(header) {
  if (!header) return "";
  try { return new URL(header).host.slice(0, 200); } catch { return ""; }
}

function referralOf(header) {
  return referrerHost(header) || "(direct)";
}

function takeCountry(req) {
  const raw = req.headers["x-grog-country"];
  delete req.headers["x-grog-country"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const cc = String(value || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(cc) ? cc : "";
}

function campaignOf(url) {
  let params;
  try { params = new URL(url || "/", "http://site").searchParams; } catch { return ""; }
  const pick = (name) => {
    const value = params.get(name) || "";
    return UTM_VALUE.test(value) ? value : "";
  };
  const source = pick("utm_source");
  const medium = pick("utm_medium");
  const campaign = pick("utm_campaign");
  if (!source && !medium && !campaign) return "";
  return [source || "-", medium || "-", campaign || "-"].join(" / ");
}

function hashId(id) {
  return createHash("sha256").update(String(id)).digest("hex").slice(0, 16);
}

export function hashPassword(password, salt = randomBytes(16)) {
  const hash = scryptSync(String(password), salt, 32);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

export function checkPassword(password, stored) {
  if (!stored || !/^[0-9a-f]{32}$/.test(stored.salt) || !/^[0-9a-f]{64}$/.test(stored.hash)) return false;
  const got = scryptSync(String(password), Buffer.from(stored.salt, "hex"), 32);
  return timingSafeEqual(got, Buffer.from(stored.hash, "hex"));
}

function runSqlite(file, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("sqlite3", ["-cmd", ".timeout 5000", file], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `sqlite3 ${code}`))));
    child.stdin.end(sql);
  });
}

/**
 * View counts. Memory is what the page reads; sqlite3 is the file that
 * survives a restart. Writes are serialized. A missing sqlite3 keeps the
 * counts for this process only.
 */
export function createStats({ dbPath, now = () => new Date(), sqlite = "sqlite3" }) {
  const hits = new Map();
  const visitors = new Map();
  const refs = new Map();
  const countries = new Map();
  const campaigns = new Map();
  const events = [];
  let tail = Promise.resolve();
  let durable = true;
  let warned = false;

  const key = (...parts) => parts.join("\n");
  const bump = (map, id, by = 1) => map.set(id, (map.get(id) || 0) + by);

  const enqueue = (sql) => {
    const run = tail.then(() => (durable ? runSqlite(dbPath, sql) : ""));
    tail = run.then(() => undefined, (error) => {
      durable = false;
      if (!warned) {
        warned = true;
        console.error(`! board stats are not being saved (${error.message.split("\n")[0]})`);
      }
    });
    return run;
  };

  const load = async () => {
    mkdirSync(dirname(dbPath), { recursive: true });
    try {
      const schema = `
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS hits (day TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, views INTEGER NOT NULL, PRIMARY KEY (day, host, path));
        CREATE TABLE IF NOT EXISTS visitors (day TEXT NOT NULL, host TEXT NOT NULL, visitor TEXT NOT NULL, PRIMARY KEY (day, host, visitor));
        CREATE TABLE IF NOT EXISTS refs (day TEXT NOT NULL, host TEXT NOT NULL, ref TEXT NOT NULL, views INTEGER NOT NULL, PRIMARY KEY (day, host, ref));
        CREATE TABLE IF NOT EXISTS countries (day TEXT NOT NULL, host TEXT NOT NULL, cc TEXT NOT NULL, views INTEGER NOT NULL, PRIMARY KEY (day, host, cc));
        CREATE TABLE IF NOT EXISTS campaigns (day TEXT NOT NULL, host TEXT NOT NULL, name TEXT NOT NULL, views INTEGER NOT NULL, PRIMARY KEY (day, host, name));
        CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, day TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, ref TEXT NOT NULL, cc TEXT NOT NULL, campaign TEXT NOT NULL);
      `;
      await enqueue(schema);
      try { chmodSync(dbPath, 0o600); } catch { /* the directory may be the only thing we can lock down */ }
      const cutoff = dayKey(new Date(now().getTime() - KEEP_DAYS * DAY_MS));
      await enqueue(`DELETE FROM hits WHERE day < ${quote(cutoff)}; DELETE FROM visitors WHERE day < ${quote(cutoff)}; DELETE FROM refs WHERE day < ${quote(cutoff)}; DELETE FROM countries WHERE day < ${quote(cutoff)}; DELETE FROM campaigns WHERE day < ${quote(cutoff)}; DELETE FROM events WHERE day < ${quote(cutoff)}; DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ${MAX_EVENTS});`);
      const hitRows = await enqueue(`SELECT json_group_array(json_object('day', day, 'host', host, 'path', path, 'views', views)) FROM hits;`);
      const visitorRows = await enqueue(`SELECT json_group_array(json_object('day', day, 'host', host, 'visitor', visitor)) FROM visitors;`);
      const refRows = await enqueue(`SELECT json_group_array(json_object('day', day, 'host', host, 'ref', ref, 'views', views)) FROM refs;`);
      const countryRows = await enqueue(`SELECT json_group_array(json_object('day', day, 'host', host, 'cc', cc, 'views', views)) FROM countries;`);
      const campaignRows = await enqueue(`SELECT json_group_array(json_object('day', day, 'host', host, 'name', name, 'views', views)) FROM campaigns;`);
      const eventRows = await enqueue(`SELECT json_group_array(json_object('id', id, 'at', at, 'host', host, 'path', path, 'ref', ref, 'cc', cc, 'campaign', campaign)) FROM (SELECT id, at, host, path, ref, cc, campaign FROM events ORDER BY id DESC LIMIT ${MAX_EVENTS});`);
      for (const row of JSON.parse(hitRows || "[]")) if (row) hits.set(key(row.day, row.host, row.path), Number(row.views) || 0);
      for (const row of JSON.parse(visitorRows || "[]")) if (row) visitors.set(key(row.day, row.host, row.visitor), 1);
      for (const row of JSON.parse(refRows || "[]")) if (row) refs.set(key(row.day, row.host, row.ref), Number(row.views) || 0);
      for (const row of JSON.parse(countryRows || "[]")) if (row && /^[A-Z]{2}$/.test(row.cc)) countries.set(key(row.day, row.host, row.cc), Number(row.views) || 0);
      for (const row of JSON.parse(campaignRows || "[]")) if (row) campaigns.set(key(row.day, row.host, row.name), Number(row.views) || 0);
      const parsedEvents = JSON.parse(eventRows || "[]");
      const loadedEvents = Array.isArray(parsedEvents) ? parsedEvents.filter(Boolean) : [];
      loadedEvents.sort((a, b) => a.id - b.id);
      const during = events.splice(0);
      for (const row of loadedEvents) events.push({ at: row.at, host: row.host, path: row.path, ref: row.ref || "", cc: row.cc || "", campaign: row.campaign || "" });
      for (const row of during) events.push(row);
      while (events.length > MAX_EVENTS) events.shift();
    } catch {
      durable = false;
    }
  };

  const ready = load();

  function plan(host, req) {
    const cc = takeCountry(req);
    if (req.method !== "GET") return null;
    let pathname = "/";
    let campaign = "";
    try {
      const url = new URL(req.url || "/", "http://site");
      pathname = url.pathname;
      campaign = campaignOf(req.url);
    } catch { return null; }
    if (isScanPath(req.url || pathname) || isScanPath(pathname) || !isPagePath(pathname) || isBot(req.headers["user-agent"])) return null;
    const { id, fresh } = visitorId(req);
    return {
      day: dayKey(now()),
      host: String(host).slice(0, 253),
      path: pathname.replace(/[\n\r]/g, ""),
      visitor: hashId(id),
      ref: referralOf(req.headers.referer || req.headers.referrer),
      cc,
      campaign: campaign.replace(/[\n\r]/g, ""),
      at: now().toISOString(),
      cookie: fresh ? seenCookie(id) : "",
    };
  }

  function storeCapped(map, day, host, name, max) {
    const id = key(day, host, name);
    if (map.has(id)) {
      bump(map, id);
      return name;
    }
    const known = [...map.keys()].filter((item) => item.startsWith(`${day}\n${host}\n`)).length;
    const stored = known < max ? name : "(other)";
    bump(map, key(day, host, stored));
    return stored;
  }

  function commit(planHit) {
    if (!planHit) return;
    const { day, host, path, visitor, ref, cc, campaign } = planHit;
    const at = planHit.at || now().toISOString();
    events.push({ at, host, path, ref: ref || "", cc: cc || "", campaign: campaign || "" });
    while (events.length > MAX_EVENTS) events.shift();
    const pathKey = key(day, host, path);
    const knownPaths = [...hits.keys()].filter((id) => id.startsWith(`${day}\n${host}\n`)).length;
    const storedPath = hits.has(pathKey) || knownPaths < MAX_PATHS ? path : "(other)";
    bump(hits, key(day, host, storedPath));
    const visitorKey = key(day, host, visitor);
    const hostVisitors = [...visitors.keys()].filter((id) => id.startsWith(`${day}\n${host}\n`)).length;
    const rememberVisitor = visitors.has(visitorKey) || hostVisitors < MAX_VISITORS;
    if (rememberVisitor && !visitors.has(visitorKey)) visitors.set(visitorKey, 1);
    if (ref) bump(refs, key(day, host, ref));
    if (cc) bump(countries, key(day, host, cc));
    const storedCampaign = campaign ? storeCapped(campaigns, day, host, campaign, MAX_CAMPAIGNS) : "";
    if (!durable) return;
    const statements = [
      `INSERT INTO hits(day, host, path, views) VALUES (${quote(day)}, ${quote(host)}, ${quote(storedPath)}, ${(hits.get(key(day, host, storedPath)) || 0)}) ON CONFLICT(day, host, path) DO UPDATE SET views = excluded.views;`,
    ];
    if (rememberVisitor) {
      statements.push(`INSERT INTO visitors(day, host, visitor) VALUES (${quote(day)}, ${quote(host)}, ${quote(visitor)}) ON CONFLICT DO NOTHING;`);
    }
    if (ref) {
      statements.push(`INSERT INTO refs(day, host, ref, views) VALUES (${quote(day)}, ${quote(host)}, ${quote(ref)}, ${refs.get(key(day, host, ref))}) ON CONFLICT(day, host, ref) DO UPDATE SET views = excluded.views;`);
    }
    if (cc) {
      statements.push(`INSERT INTO countries(day, host, cc, views) VALUES (${quote(day)}, ${quote(host)}, ${quote(cc)}, ${countries.get(key(day, host, cc))}) ON CONFLICT(day, host, cc) DO UPDATE SET views = excluded.views;`);
    }
    if (storedCampaign) {
      statements.push(`INSERT INTO campaigns(day, host, name, views) VALUES (${quote(day)}, ${quote(host)}, ${quote(storedCampaign)}, ${campaigns.get(key(day, host, storedCampaign))}) ON CONFLICT(day, host, name) DO UPDATE SET views = excluded.views;`);
    }
    statements.push(`INSERT INTO events(at, day, host, path, ref, cc, campaign) VALUES (${quote(at)}, ${quote(day)}, ${quote(host)}, ${quote(path)}, ${quote(ref || "")}, ${quote(cc || "")}, ${quote(campaign || "")});`);
    statements.push(`DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ${MAX_EVENTS});`);
    enqueue(statements.join("\n")).catch(() => {});
  }

  function snapshot(siteList) {
    const today = dayKey(now());
    const days = [];
    for (let i = 6; i >= 0; i -= 1) days.push(dayKey(new Date(now().getTime() - i * DAY_MS)));
    const hosts = new Map();
    const ensure = (host) => {
      if (!hosts.has(host)) hosts.set(host, { host, kind: "", state: "", views: 0, visitors: 0, paths: [], refs: [], countries: [], campaigns: [], series: days.map(() => 0) });
      return hosts.get(host);
    };
    for (const site of siteList) {
      const row = ensure(site.host);
      if (site.kind) row.kind = site.kind;
      if (site.state) row.state = site.state;
    }
    for (const [id, views] of hits) {
      const [day, host, path] = id.split("\n");
      if (!days.includes(day)) continue;
      const row = ensure(host);
      row.series[days.indexOf(day)] += views;
      if (day === today) {
        row.views += views;
        row.paths.push({ path, views });
      }
    }
    for (const id of visitors.keys()) {
      const [day, host] = id.split("\n");
      if (day === today) ensure(host).visitors += 1;
    }
    for (const [id, views] of refs) {
      const [day, host, ref] = id.split("\n");
      if (day === today) ensure(host).refs.push({ ref, views });
    }
    for (const [id, views] of countries) {
      const [day, host, cc] = id.split("\n");
      if (day === today) ensure(host).countries.push({ cc, views });
    }
    for (const [id, views] of campaigns) {
      const [day, host, name] = id.split("\n");
      if (day === today) ensure(host).campaigns.push({ name, views });
    }
    const byViews = (left, right, field) => right.views - left.views || left[field].localeCompare(right[field]);
    const list = [...hosts.values()].map((row) => ({
      ...row,
      paths: row.paths.sort((a, b) => byViews(a, b, "path")).slice(0, 8),
      refs: row.refs.sort((a, b) => byViews(a, b, "ref")).slice(0, 8),
      countries: row.countries.sort((a, b) => byViews(a, b, "cc")),
      campaigns: row.campaigns.sort((a, b) => byViews(a, b, "name")).slice(0, 8),
    })).sort((a, b) => a.host.localeCompare(b.host));
    const viewsToday = list.reduce((sum, row) => sum + row.views, 0);
    const visitorsToday = list.reduce((sum, row) => sum + row.visitors, 0);
    return {
      now: now().toISOString(),
      today,
      days,
      viewsToday,
      visitorsToday,
      hosts: list,
      events: events.slice(-SHOW_EVENTS).reverse(),
    };
  }

  return {
    ready,
    plan,
    commit,
    snapshot,
    idle: () => tail,
    close: () => tail,
  };
}

export function createSites() {
  const sites = new Map();
  return {
    note(host, info) {
      sites.set(host, { kind: "site", state: "connecting", ...sites.get(host), ...info });
    },
    forget(host) { sites.delete(host); },
    list() {
      return [...sites.entries()]
        .map(([host, info]) => ({ host, ...info }))
        .sort((a, b) => a.host.localeCompare(b.host));
    },
  };
}

const ART = String.raw`
  ____ ____   ___   ____ 
 / ___|  _ \ / _ \ / ___|
| |  _| |_) | | | | |  _ 
| |_| |  _ <| |_| | |_| |
 \____|_| \_\___/ \____| `.replace(/^\n/, "").replace(/\n$/, "");

function page(body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>GROG</title>
<link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #000; color: #fff; }
  body { font: 14px/1.45 ui-monospace, "SF Mono", Menlo, Consolas, monospace; padding: 16px; }
  pre { margin: 0; font: 14px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace; white-space: pre; font-variant-ligatures: none; }
  .box { border: 1px solid #fff; padding: 12px; margin: 0 0 14px; }
  table { width: max-content; min-width: 100%; border-collapse: collapse; }
  th, td { border-bottom: 1px solid #fff; text-align: left; padding: 6px 8px; font-weight: 400; vertical-align: top; white-space: nowrap; }
  th { border-top: 1px solid #fff; }
  input, button { font: inherit; color: #fff; background: #000; border: 1px solid #fff; padding: 8px 10px; }
  input { font-size: 16px; min-height: 44px; width: min(100%, 420px); }
  button { min-height: 44px; }
  .blink { animation: blink 1.2s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .dim { opacity: 0.65; }
  .scroll { overflow-x: auto; }
  .phone { display: none; }
  form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .hit p { margin: 0; overflow-wrap: anywhere; }
  @media (max-width: 720px) {
    body { padding: 10px; }
    .box { padding: 10px; }
    pre { font-size: clamp(8px, 2.8vw, 13px); }
    .desk { display: none; }
    .phone { display: block; }
    form { flex-direction: column; align-items: stretch; }
    input, button { width: 100%; }
    .hit { padding: 10px 0; border-bottom: 1px solid #fff; }
    .hit:first-child { padding-top: 0; }
    .hit:last-child { border-bottom: 0; padding-bottom: 0; }
    .hit p + p { margin-top: 2px; }
  }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function loginHtml(message) {
  return page(`<div class="box"><pre>${ART}</pre><p class="dim">serve / live</p></div>
<div class="box">
<form method="post" action="/login">
<label for="password">password</label>
<input id="password" name="password" type="password" autocomplete="current-password" autofocus>
<button type="submit">enter</button>
</form>
${message ? `<p>${message}</p>` : ""}
</div>`);
}

function boardHtml(data) {
  const boot = JSON.stringify(data).replace(/</g, "\\u003c");
  return page(`<div class="box"><pre>${ART}</pre>
<p><span class="blink">*</span> live <span id="when" class="dim"></span></p>
<p id="totals"></p></div>
<div class="box">
<div class="desk scroll"><table><thead><tr><th>host</th><th>state</th><th>kind</th><th>today</th><th>visitors</th></tr></thead><tbody id="sites"></tbody></table></div>
<div class="phone" id="sites-phone"></div>
</div>
<div class="box">
<p>log</p>
<div class="desk scroll"><table><thead><tr><th>time</th><th>host</th><th>path</th><th>country</th><th>referral</th><th>campaign</th></tr></thead><tbody id="log"></tbody></table></div>
<div class="phone" id="log-phone"></div>
</div>
<div class="box">
<p>last 7 days</p>
<div class="desk scroll"><table><thead><tr id="days"></tr></thead><tbody id="series"></tbody></table></div>
<div class="phone" id="series-phone"></div>
</div>
<div class="box">
<p>top pages today</p>
<div class="desk scroll"><table><tbody id="pages"></tbody></table></div>
<div class="phone" id="pages-phone"></div>
</div>
<div class="box">
<p>referrals today</p>
<div class="desk scroll"><table><tbody id="refs"></tbody></table></div>
<div class="phone" id="refs-phone"></div>
</div>
<div class="box">
<p>campaigns today</p>
<div class="desk scroll"><table><tbody id="campaigns"></tbody></table></div>
<div class="phone" id="campaigns-phone"></div>
</div>
<div class="box">
<p>countries today</p>
<div class="desk scroll"><table><tbody id="countries"></tbody></table></div>
<div class="phone" id="countries-phone"></div>
</div>
<div class="box"><p class="dim">a view is a document grog serve answered. scanner paths are refused and not counted. a known bot is still served and not counted. the log is each one, newest first, in this device's time. a referral is the previous site, or direct. a campaign is the utm source, medium and name. the country is where the visitor's network is registered; the address is not stored.</p>
<form method="post" action="/logout"><button type="submit">lock</button></form></div>
<script type="application/json" id="boot">${boot}</script>
<script>
(function () {
  function cell(text) { const el = document.createElement("td"); el.textContent = text; return el; }
  function head(text) { const el = document.createElement("th"); el.textContent = text; return el; }
  function fill(id, blocks) {
    const root = document.getElementById(id);
    root.replaceChildren();
    if (!blocks.length) {
      const p = document.createElement("p");
      p.className = "dim";
      p.textContent = "none";
      root.appendChild(p);
      return;
    }
    blocks.forEach(function (lines) {
      const block = document.createElement("div");
      block.className = "hit";
      lines.forEach(function (line) {
        const p = document.createElement("p");
        if (line && line.dim) p.className = "dim";
        p.textContent = line && line.text ? line.text : line;
        block.appendChild(p);
      });
      root.appendChild(block);
    });
  }
  function stamp(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso || "");
    function p(n) { return String(n).padStart(2, "0"); }
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  function render(data) {
    document.getElementById("when").textContent = data.now.replace("T", " ").replace(/\\.\\d+Z$/, "Z");
    document.getElementById("totals").textContent = data.viewsToday + " views  " + data.visitorsToday + " visitors  today";
    const sites = document.getElementById("sites");
    sites.replaceChildren();
    data.hosts.forEach(function (row) {
      const tr = document.createElement("tr");
      [row.host, row.state || "", row.kind || "", String(row.views), String(row.visitors)].forEach(function (value) { tr.appendChild(cell(value)); });
      sites.appendChild(tr);
    });
    const days = document.getElementById("days");
    days.replaceChildren(head("host"));
    data.days.forEach(function (day) { days.appendChild(head(day.slice(5))); });
    const series = document.getElementById("series");
    series.replaceChildren();
    data.hosts.forEach(function (row) {
      const tr = document.createElement("tr");
      tr.appendChild(cell(row.host));
      row.series.forEach(function (n) { tr.appendChild(cell(n ? String(n) : ".")); });
      series.appendChild(tr);
    });
    const pages = document.getElementById("pages");
    pages.replaceChildren();
    const refs = document.getElementById("refs");
    refs.replaceChildren();
    const campaigns = document.getElementById("campaigns");
    campaigns.replaceChildren();
    const countries = document.getElementById("countries");
    countries.replaceChildren();
    data.hosts.forEach(function (row) {
      row.paths.forEach(function (item) {
        const tr = document.createElement("tr");
        tr.appendChild(cell(row.host + "  " + item.path));
        tr.appendChild(cell(String(item.views)));
        pages.appendChild(tr);
      });
      row.refs.forEach(function (item) {
        const tr = document.createElement("tr");
        tr.appendChild(cell(row.host + "  " + item.ref));
        tr.appendChild(cell(String(item.views)));
        refs.appendChild(tr);
      });
      (row.campaigns || []).forEach(function (item) {
        const tr = document.createElement("tr");
        tr.appendChild(cell(row.host + "  " + item.name));
        tr.appendChild(cell(String(item.views)));
        campaigns.appendChild(tr);
      });
      (row.countries || []).forEach(function (item) {
        const tr = document.createElement("tr");
        tr.appendChild(cell(row.host + "  " + item.cc));
        tr.appendChild(cell(String(item.views)));
        countries.appendChild(tr);
      });
    });
    const log = document.getElementById("log");
    log.replaceChildren();
    (data.events || []).forEach(function (item) {
      const tr = document.createElement("tr");
      [stamp(item.at), item.host, item.path, item.cc || "", item.ref || "", item.campaign || ""].forEach(function (value) { tr.appendChild(cell(value)); });
      log.appendChild(tr);
    });
    if (!log.childNodes.length) {
      const tr = document.createElement("tr");
      tr.appendChild(cell("none"));
      log.appendChild(tr);
    }
    fill("sites-phone", data.hosts.map(function (row) {
      return [row.host, (row.state || "-") + "  " + (row.kind || "-"), row.views + " views   " + row.visitors + " visitors"];
    }));
    fill("series-phone", data.hosts.map(function (row) {
      return [row.host, data.days.map(function (day, i) { return day.slice(5) + " " + (row.series[i] || "."); }).join("  ")];
    }));
    const pageBlocks = [];
    const refBlocks = [];
    const campaignBlocks = [];
    const countryBlocks = [];
    data.hosts.forEach(function (row) {
      row.paths.forEach(function (item) { pageBlocks.push([row.host, item.path + "  " + item.views]); });
      row.refs.forEach(function (item) { refBlocks.push([row.host, item.ref + "  " + item.views]); });
      (row.campaigns || []).forEach(function (item) { campaignBlocks.push([row.host, item.name + "  " + item.views]); });
      (row.countries || []).forEach(function (item) { countryBlocks.push([row.host, item.cc + "  " + item.views]); });
    });
    fill("pages-phone", pageBlocks);
    fill("refs-phone", refBlocks);
    fill("campaigns-phone", campaignBlocks);
    fill("countries-phone", countryBlocks);
    fill("log-phone", (data.events || []).map(function (item) {
      const lines = [{ text: stamp(item.at), dim: true }, item.host, item.path];
      const meta = [item.cc, item.ref].filter(Boolean).join("   ");
      if (meta) lines.push(meta);
      if (item.campaign) lines.push(item.campaign);
      return lines;
    }));
  }
  render(JSON.parse(document.getElementById("boot").textContent));
  setInterval(function () {
    fetch("/api/snapshot", { cache: "no-store" }).then(function (res) {
      if (res.status === 401) location.reload();
      else return res.json().then(render);
    }).catch(function () {});
  }, 2000);
})();
</script>`);
}

function readBody(req, limit = 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect width="16" height="16" fill="#000"/><g fill="#fff"><rect x="3" y="2" width="10" height="2"/><rect x="3" y="4" width="2" height="10"/><rect x="3" y="12" width="10" height="2"/><rect x="11" y="8" width="2" height="4"/><rect x="7" y="7" width="6" height="2"/></g></svg>`;

function faviconIco() {
  const rows = [
    "................",
    "................",
    "...XXXXXXXXXX...",
    "...XXXXXXXXXX...",
    "...XX...........",
    "...XX...........",
    "...XX...........",
    "...XX..XXXXXX...",
    "...XX..XXXXXX...",
    "...XX......XX...",
    "...XX......XX...",
    "...XX......XX...",
    "...XXXXXXXXXX...",
    "...XXXXXXXXXX...",
    "................",
    "................",
  ];
  const raw = Buffer.alloc(16 * (1 + 16 * 4));
  rows.forEach((row, y) => {
    const at = y * (1 + 64);
    raw[at] = 0;
    for (let x = 0; x < 16; x += 1) {
      const on = row[x] === "X" ? 255 : 0;
      const pixel = at + 1 + x * 4;
      raw[pixel] = on;
      raw[pixel + 1] = on;
      raw[pixel + 2] = on;
      raw[pixel + 3] = 255;
    }
  });
  const idat = deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16, 0);
  ihdr.writeUInt32BE(16, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  const dir = Buffer.alloc(22);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(1, 4);
  dir[6] = 16;
  dir[7] = 16;
  dir.writeUInt16LE(1, 10);
  dir.writeUInt16LE(32, 12);
  dir.writeUInt32LE(png.length, 14);
  dir.writeUInt32LE(22, 18);
  return Buffer.concat([dir, png]);
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc ^ 0xffffffff;
}

const FAVICON_ICO = faviconIco();

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  res.end(payload);
}

export function createBoard({ stats, sites, auth }) {
  const sessions = new Map();
  const failures = [];

  function sessionOk(req) {
    const token = cookieValue(req.headers.cookie, "grog_board");
    const until = sessions.get(token);
    if (!until || until < Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function limited() {
    const now = Date.now();
    while (failures.length && failures[0] < now - FAIL_WINDOW_MS) failures.shift();
    return failures.length >= FAIL_LIMIT;
  }

  async function handler(req, res) {
    let path = "/";
    try { path = new URL(req.url || "/", "http://board").pathname; } catch { path = "/"; }
    if (req.method === "GET" && (path === "/favicon.svg" || path === "/favicon.ico")) {
      if (path === "/favicon.svg") {
        return send(res, 200, FAVICON_SVG, {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=86400",
        });
      }
      return send(res, 200, FAVICON_ICO, {
        "Content-Type": "image/x-icon",
        "Cache-Control": "public, max-age=86400",
      });
    }
    if (req.method === "POST" && path === "/login") {
      if (limited()) return send(res, 429, loginHtml("slow down"));
      let body = "";
      try { body = await readBody(req); } catch { return send(res, 400, loginHtml("no")); }
      const password = new URLSearchParams(body).get("password") || "";
      if (!checkPassword(password, auth)) {
        failures.push(Date.now());
        return send(res, 401, loginHtml("wrong password"));
      }
      const token = randomBytes(32).toString("hex");
      sessions.set(token, Date.now() + SESSION_MS);
      return send(res, 303, "", {
        Location: "/",
        "Set-Cookie": `grog_board=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${SESSION_MS / 1000}`,
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": 0,
      });
    }
    if (req.method === "POST" && path === "/logout") {
      sessions.delete(cookieValue(req.headers.cookie, "grog_board"));
      return send(res, 303, "", {
        Location: "/",
        "Set-Cookie": "grog_board=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0",
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": 0,
      });
    }
    if (!sessionOk(req)) {
      if (path === "/api/snapshot") {
        res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end('{"error":"locked"}');
      }
      return send(res, 200, loginHtml(""));
    }
    if (path === "/api/snapshot") {
      const payload = Buffer.from(JSON.stringify(stats.snapshot(sites.list())));
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": payload.length, "Cache-Control": "no-store" });
      return res.end(payload);
    }
    if (path !== "/") return send(res, 404, page("<div class=\"box\"><p>not found</p></div>"));
    return send(res, 200, boardHtml(stats.snapshot(sites.list())));
  }

  return { handler };
}

function appendCookie(headers, cookie) {
  const name = Object.keys(headers).find((key) => key.toLowerCase() === "set-cookie");
  if (!name) headers["set-cookie"] = cookie;
  else if (Array.isArray(headers[name])) headers[name].push(cookie);
  else headers[name] = [headers[name], cookie];
}

function probe(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Local HTTP in front of a site's own port, so a view can be counted. */
export function listenCountingProxy(targetPort, stats, siteHost) {
  return new Promise((resolve, reject) => {
    let upstreamHost = null;
    const server = http.createServer(async (req, res) => {
      const planned = stats.plan(siteHost, req);
      if (rejectScan(req, res)) return;
      if (!upstreamHost) upstreamHost = (await probe(targetPort, "127.0.0.1")) ? "127.0.0.1" : "::1";
      const proxyReq = http.request({
        hostname: upstreamHost,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: req.headers,
      }, (proxyRes) => {
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 400) stats.commit(planned);
        const headers = { ...proxyRes.headers };
        if (planned?.cookie) appendCookie(headers, planned.cookie);
        res.writeHead(proxyRes.statusCode || 502, headers);
        proxyRes.pipe(res);
      });
      proxyReq.on("error", () => {
        upstreamHost = null;
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Bad gateway");
        } else res.destroy();
      });
      req.pipe(proxyReq);
    });
    server.on("upgrade", (req, socket, head) => {
      delete req.headers["x-grog-country"];
      if (isScanPath(req.url || "/")) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nContent-Length: 9\r\n\r\nNot found");
        return;
      }
      const host = upstreamHost || "127.0.0.1";
      const upstream = net.connect(targetPort, host, () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        delete req.headers["x-grog-country"];
        for (const [name, value] of Object.entries(req.headers)) {
          if (name.toLowerCase() === "x-grog-country") continue;
          if (Array.isArray(value)) value.forEach((item) => lines.push(`${name}: ${item}`));
          else if (value != null) lines.push(`${name}: ${value}`);
        }
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head?.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      const fail = () => { socket.destroy(); upstream.destroy(); };
      upstream.on("error", fail);
      socket.on("error", fail);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/** Count a document response. Call the returned commit from writeHead. */
export function track(stats, host, req, res) {
  const planned = stats.plan(host, req);
  if (!planned) return;
  if (planned.cookie) res.setHeader("Set-Cookie", planned.cookie);
  const writeHead = res.writeHead.bind(res);
  let done = false;
  res.writeHead = (status, ...args) => {
    if (!done && status >= 200 && status < 400) {
      done = true;
      stats.commit(planned);
    }
    return writeHead(status, ...args);
  };
}
