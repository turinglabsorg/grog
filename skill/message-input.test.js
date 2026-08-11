import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
