import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const currentDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(currentDir, "index.js");

// `update` is the only Linear command that edits a field a human wrote. Every
// refusal below must happen BEFORE the network: a command that reaches the API
// with half its arguments understood has already changed a client's tracker.
const scratch = mkdtempSync(join(tmpdir(), "grog-update-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function run(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, "update", ...args], {
    encoding: "utf8",
    cwd: scratch,
    env: { ...process.env, GROG_WORKSPACE: "", ...env },
  });
}

test("refuses an update with no field to change", () => {
  const result = run(["PROJ-123"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Nothing to update/);
  assert.doesNotMatch(result.stderr, /fetch failed/, "it must refuse before the network");
});

test("refuses a description file it cannot read, naming the file", () => {
  const result = run(["PROJ-123", "--description-file", join(scratch, "missing.md")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not read description file/);
  assert.doesNotMatch(result.stderr, /fetch failed/);
});

test("refuses an invalid priority instead of sending a wrong number", () => {
  const result = run(["PROJ-123", "--priority", "quiteurgent"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid Linear priority/);
  assert.doesNotMatch(result.stderr, /fetch failed/);
});

test("refuses a GitHub issue URL", () => {
  const result = run(["https://github.com/owner/repo/issues/1", "--title", "x"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only supports Linear/);
});

test("refuses a reference that is not an issue identifier", () => {
  const result = run(["not-an-issue", "--title", "x"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid Linear issue reference/);
});

test("requires an issue reference", () => {
  const result = run(["--title", "x"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing Linear issue reference/);
});

test("reads the body from a file rather than the command line", () => {
  // A body typed inline loses its newlines to the shell; the file path is the
  // supported route, so a readable file must get past argument handling and
  // fail only on the missing workspace.
  const bodyFile = join(scratch, "body.md");
  writeFileSync(bodyFile, "Prima riga\n\nSeconda riga\n");
  const result = run(["PROJ-123", "--description-file", bodyFile]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no \.grog file found|workspace/i);
  assert.doesNotMatch(result.stderr, /could not read description file/);
  assert.doesNotMatch(result.stderr, /Nothing to update/);
});

test("help lists update among the commands", () => {
  const result = spawnSync(process.execPath, [cliPath, "help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /grog update/);
});
