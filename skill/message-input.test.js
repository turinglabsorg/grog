import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const currentDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(currentDir, "index.js");

test("telegram-send rejects literal newline escapes before making a request", () => {
  const result = spawnSync(
    process.execPath,
    [cliPath, "telegram-send", "--to", "123456", "First line\\nSecond line"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /inline message contains literal/);
  assert.match(result.stderr, /pass its path instead/);
  assert.doesNotMatch(result.stderr, /fetch failed/);
});

test("text sends refuse an attachment instead of posting its bytes as text", () => {
  const dir = mkdtempSync(join(tmpdir(), "grog-message-file-"));
  const video = join(dir, "walkthrough.mp4");
  writeFileSync(video, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0xff, 0xfe]));
  const csv = join(dir, "export.csv");
  writeFileSync(csv, "a,b\n1,2\n");
  const binaryText = join(dir, "notes.txt");
  writeFileSync(binaryText, Buffer.from([0x68, 0x00, 0x69]));
  const huge = join(dir, "long.md");
  writeFileSync(huge, "x".repeat(8001));

  for (const file of [video, csv, binaryText]) {
    const result = spawnSync(process.execPath, [cliPath, "telegram-send", "--to", "123456", file], { encoding: "utf8" });
    assert.equal(result.status, 1, file);
    assert.match(result.stderr, /is a file, not message text/);
    assert.match(result.stderr, /discord-send-document/);
    assert.doesNotMatch(result.stderr, /fetch failed/);
  }
  const long = spawnSync(process.execPath, [cliPath, "telegram-send", "--to", "123456", huge], { encoding: "utf8" });
  assert.equal(long.status, 1);
  assert.match(long.stderr, /at most 8000/);

  // a message the agent wrote still goes through as text
  const note = join(dir, "reply.md");
  writeFileSync(note, "Ciao,\nè online.\n");
  const ok = spawnSync(process.execPath, [cliPath, "telegram-send", "--to", "123456", note], { encoding: "utf8", env: { ...process.env, TELEGRAM_BOT_TOKEN: "" } });
  assert.doesNotMatch(ok.stderr, /is a file, not message text|at most 8000/);
});
