import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "index.js");
const scratch = mkdtempSync(join(tmpdir(), "grog-tmux-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// A stand-in tmux that records the argv it was given.
const argvLog = join(scratch, "tmux-argv");
writeFileSync(join(scratch, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${argvLog}\n`);
chmodSync(join(scratch, "tmux"), 0o755);

function run(args, env = {}) {
  rmSync(argvLog, { force: true });
  const result = spawnSync(process.execPath, [cliPath, "tmux-name", ...args], {
    encoding: "utf8",
    cwd: scratch,
    env: { ...process.env, PATH: `${scratch}:${process.env.PATH}`, TMUX: "/tmp/tmux-test,1,0", TMUX_PANE: "%63", ...env },
  });
  let argv = null;
  try { argv = readFileSync(argvLog, "utf8").trimEnd().split("\n"); } catch {}
  return { ...result, argv };
}

test("names the calling pane's window after a Linear identifier", () => {
  const result = run(["mtr-1334"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.argv, ["rename-window", "-t", "%63", "MTR-1334"]);
});

test("takes the identifier out of a Linear URL", () => {
  const result = run(["https://linear.app/mtropro/issue/MTR-1332/inbound-email-replies"]);
  assert.deepEqual(result.argv, ["rename-window", "-t", "%63", "MTR-1332"]);
});

test("names a GitHub issue or PR as repo#number", () => {
  assert.deepEqual(run(["https://github.com/acme/app/issues/153"]).argv.at(-1), "app#153");
  assert.deepEqual(run(["https://github.com/acme/app/pull/420"]).argv.at(-1), "app#420");
});

test("keeps other text short and printable", () => {
  const result = run(["checkout", "flow\u0007", "rewrite", "for", "the", "new", "payments", "provider", "and", "more"]);
  assert.equal(result.status, 0, result.stderr);
  const name = result.argv.at(-1);
  assert.ok(name.length <= 40, name);
  assert.doesNotMatch(name, /\u0007/);
});

test("refuses outside tmux without calling it", () => {
  const result = run(["MTR-1"], { TMUX: "", TMUX_PANE: "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not running inside tmux/);
  assert.equal(result.argv, null);
});

test("refuses an empty name", () => {
  const result = run([]);
  assert.equal(result.status, 1);
  assert.equal(result.argv, null);
});
