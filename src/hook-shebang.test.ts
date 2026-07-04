import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const f of ["src/prompt-hook.ts", "src/stop-hook.ts", "src/cli.ts", "src/mcp-cli.ts"]) {
  test(`${f} shebang does not depend on npx or tsx at runtime`, () => {
    const first = readFileSync(f, "utf8").split("\n")[0]!;
    assert.doesNotMatch(first, /npx|tsx/);
    assert.match(first, /^#!\/usr\/bin\/env -S node/);
  });
}
