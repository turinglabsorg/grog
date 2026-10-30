import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = "vault-value-7f3a9c";

// A stand-in docker: it logs every call and answers like a running cora-box would.
const FAKE_DOCKER = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
let input = "";
if (args[0] === "exec" && args.includes("-i")) { try { input = readFileSync(0, "utf8"); } catch {} }
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: "docker", args, input, secret: process.env.GROG_DESK_SECRET || null }) + "\\n");
const line = args.join(" ");
if (args[0] === "inspect") {
  if (!process.env.FAKE_STATE) { process.stderr.write("No such object\\n"); process.exit(1); }
  console.log(process.env.FAKE_STATE);
} else if (line.includes("tailscale") && line.includes("status")) {
  console.log(JSON.stringify({ BackendState: "Running", Self: { DNSName: "grog-desk.example.ts.net.", TailscaleIPs: ["100.64.0.9"] } }));
} else if (line.includes("node -e")) console.log("password");
`;

// A stand-in hush: it puts the stored value in the named variable of the child only.
const FAKE_HUSH = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: "hush", args }) + "\\n");
const variable = args[args.indexOf("--env") + 1];
const command = args.slice(args.indexOf("--") + 1);
const child = spawnSync(command[0], command.slice(1), { stdio: "inherit", env: { ...process.env, [variable]: ${JSON.stringify(SECRET)} } });
process.exit(child.status ?? 1);
`;

let root;
let docker;
let hush;

before(() => {
  root = mkdtempSync(join(tmpdir(), "grog-desktop-test-"));
  docker = join(root, "docker");
  hush = join(root, "hush");
  writeFileSync(docker, FAKE_DOCKER);
  writeFileSync(hush, FAKE_HUSH);
  chmodSync(docker, 0o755);
  chmodSync(hush, 0o755);
});

after(() => rmSync(root, { recursive: true, force: true }));

function grog(args, { state = "true" } = {}) {
  const log = join(mkdtempSync(join(root, "run-")), "calls.jsonl");
  writeFileSync(log, "");
  const result = spawnSync(process.execPath, [join(here, "index.js"), "desktop", ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: root, GROG_DOCKER: docker, GROG_HUSH: hush, FAKE_LOG: log, FAKE_STATE: state },
  });
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { ...result, calls, dockerCalls: calls.filter((call) => call.tool === "docker").map((call) => call.args) };
}

describe("grog desktop", () => {
  test("up adopts the desktop that is already running instead of recreating it", () => {
    const { status, stdout, dockerCalls } = grog(["up"]);
    assert.equal(status, 0);
    assert.match(stdout, /already up: grog-desk \(kept as it is\)/);
    assert.match(stdout, /screen: vnc:\/\/100\.64\.0\.9/);
    assert.match(stdout, /browserScreen: http:\/\/100\.64\.0\.9:6080\//);
    assert.match(stdout, /password: required/);
    assert.ok(!dockerCalls.some((args) => args[0] === "run" || args[0] === "volume"), "a running desktop is never recreated");
  });

  test("a secret is typed through hush, never on a command line or in the output", () => {
    const { status, stdout, stderr, calls } = grog(["type", "--secret", "SITE_PASSWORD"]);
    assert.equal(status, 0, stderr);
    assert.match(stdout, /typed SITE_PASSWORD \(never shown\)/);
    const vault = calls.find((call) => call.tool === "hush");
    assert.deepEqual(vault.args.slice(0, 6), ["run", "--name", "SITE_PASSWORD", "--env", "GROG_DESK_SECRET", "--redact"]);
    const typing = calls.find((call) => call.tool === "docker" && call.args.includes("xdotool type --delay 25 -- \"$GROG_DESK_SECRET\""));
    assert.equal(typing.secret, SECRET, "the value reaches the desktop through the environment");
    assert.ok(calls.every((call) => !JSON.stringify(call.args).includes(SECRET)), "the value is on no command line");
    assert.ok(!stdout.includes(SECRET) && !stderr.includes(SECRET));
  });

  test("a named desktop has its own container, and rm keeps its sessions unless asked", () => {
    const kept = grog(["rm", "--name", "acme"]);
    assert.deepEqual(kept.dockerCalls, [["rm", "-f", "grog-desk-acme"]]);
    assert.match(kept.stdout, /sessions kept in grog-desk-acme-home/);
    const gone = grog(["rm", "--name", "acme", "--volumes"]);
    assert.deepEqual(gone.dockerCalls, [["rm", "-f", "grog-desk-acme"], ["volume", "rm", "-f", "grog-desk-acme-home", "grog-desk-acme-sys"]]);
  });

  test("open takes only an http(s) url, and only on a desktop that is up", () => {
    const local = grog(["open", "file:///etc/passwd"]);
    assert.equal(local.status, 1);
    assert.match(local.stderr, /open needs an http\(s\) url/);
    assert.ok(!local.dockerCalls.some((args) => args[0] === "exec"));
    const down = grog(["open", "https://example.com"], { state: "" });
    assert.equal(down.status, 1);
    assert.match(down.stderr, /grog-desk is not up: grog desktop up --name default/);
    const opened = grog(["open", "https://example.com/login"]);
    assert.equal(opened.status, 0);
    assert.ok(opened.dockerCalls.some((args) => args[0] === "exec" && args.at(-1).includes("chromium \"https://example.com/login\"")));
  });
});
