import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "dist", "src", "cli.js");

// The hooks (and the tests that exercise them) invoke the `recall` binary by
// name, exactly as a real install puts it on PATH. In CI the package is built
// but never linked, so a bare `recall` is unresolvable and the suite dies with
// FileNotFoundError. Rather than depend on a global install, hand the suite a
// hermetic `recall` shim pointing at this repo's own built CLI, on PATH. This
// fixes CI and any local contributor who hasn't `npm link`ed recall.
if (!existsSync(cli)) {
  const build = spawnSync("npm", ["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (build.status !== 0) {
    console.error("Cannot run python tests: build failed, so there is no recall CLI to shim.");
    process.exit(build.status ?? 1);
  }
}

const isWin = process.platform === "win32";
const node = process.execPath;
const shimDir = mkdtempSync(join(tmpdir(), "recall-shim-"));
if (isWin) {
  // --disable-warning matches the bin shebang so the experimental-sqlite
  // warning never leaks into stderr that tests assert against.
  writeFileSync(join(shimDir, "recall.cmd"), `@echo off\r\n"${node}" --disable-warning=ExperimentalWarning "${cli}" %*\r\n`);
} else {
  const shim = join(shimDir, "recall");
  writeFileSync(shim, `#!/usr/bin/env sh\nexec "${node}" --disable-warning=ExperimentalWarning "${cli}" "$@"\n`);
  chmodSync(shim, 0o755);
}
const env = { ...process.env, PATH: `${shimDir}${isWin ? ";" : ":"}${process.env.PATH ?? ""}` };

const candidates = isWin ? ["python", "py"] : ["python3", "python"];
const python = candidates.find((candidate) => {
  const result = spawnSync(candidate, ["--version"], { stdio: "ignore", env });
  return result.status === 0;
});

if (!python) {
  console.log("SKIP python tests: no python executable found.");
  process.exit(0);
}

for (const script of [
  "python/tests/toolkit_unit_tests.py",
  "python/hooks/test_hooks.py",
  "integrations/claude/hooks/test_dig_backstop.py",
]) {
  const result = spawnSync(python, [script], { stdio: "inherit", env });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
