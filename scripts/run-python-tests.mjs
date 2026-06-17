import { spawnSync } from "node:child_process";

const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
const python = candidates.find((candidate) => {
  const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
  return result.status === 0;
});

if (!python) {
  console.log("SKIP python tests: no python executable found.");
  process.exit(0);
}

for (const script of ["python/tests/toolkit_unit_tests.py", "python/hooks/test_hooks.py"]) {
  const result = spawnSync(python, [script], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
