import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
