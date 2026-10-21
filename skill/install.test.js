import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));

test("install.sh copies every local module the CLI imports", () => {
  const install = readFileSync(join(here, "install.sh"), "utf8");
  const copied = new Set(install.match(/for file in ([^;]+); do\n\s+cp "\$SCRIPT_DIR\/\$file"/)[1].split(/\s+/));
  const pending = ["index.js"];
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, local] of readFileSync(join(here, file), "utf8").matchAll(/^import [^;]*? from "\.\/([^"]+)";/gm)) {
      pending.push(local);
    }
  }
  for (const file of seen) assert.ok(copied.has(file), `install.sh does not copy ${file}`);
  assert.ok(copied.has("package.json") && copied.has("package-lock.json"));
});


test("runtime-only update installs SMS and skills without touching credential configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "grog-install-test-"));
  try {
    mkdirSync(join(root, ".grog"));
    const sentinel = "credential configuration must remain byte-for-byte untouched";
    writeFileSync(join(root, ".grog/config.json"), sentinel);
    const runtimes = [".claude", ".codex"].map(harness => join(root, harness, "tools/grog"));
    for (const runtime of runtimes) {
      mkdirSync(join(runtime, "node_modules"), {recursive: true});
      writeFileSync(join(runtime, "index.js"), "previous runtime");
      writeFileSync(join(runtime, "package-lock.json"), readFileSync(join(here, "package-lock.json")));
      writeFileSync(join(runtime, ".env"), sentinel);
    }
    const result = spawnSync("bash", [join(here, "install.sh"), "--runtime-only"], {
      encoding: "utf8", env: {PATH: process.env.PATH, HOME: root, CODEX_HOME: join(root, ".codex"), CLAUDE_HOME: join(root, ".claude")},
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updated 2 grog runtime/);
    for (const runtime of runtimes) {
      assert.equal(readFileSync(join(runtime, "sms.js"), "utf8"), readFileSync(join(here, "sms.js"), "utf8"));
      assert.equal(readFileSync(join(runtime, ".env"), "utf8"), sentinel);
    }
    assert.equal(readFileSync(join(root, ".grog/config.json"), "utf8"), sentinel);
    assert.match(readFileSync(join(root, ".agents/skills/grog-talk/SKILL.md"), "utf8"), /--otp-env LOGIN_OTP/);
    writeFileSync(join(runtimes[0], "index.js"), "do not replace");
    writeFileSync(join(runtimes[1], "package-lock.json"), "different dependencies");
    const refused = spawnSync("bash", [join(here, "install.sh"), "--runtime-only"], {encoding: "utf8", env: {PATH: process.env.PATH, HOME: root}});
    assert.equal(refused.status, 1);
    assert.equal(readFileSync(join(runtimes[0], "index.js"), "utf8"), "do not replace");
  } finally {rmSync(root, {recursive: true, force: true});}
});
