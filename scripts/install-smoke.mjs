import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

for (const script of ["scripts/install.sh", "scripts/install-local.sh"]) {
  execFileSync("bash", ["-n", script], { stdio: "inherit" });
  const text = readFileSync(script, "utf8");
  for (const expected of ["node_major", "npm run build", "npm link", "recall claude sync"]) {
    if (!text.includes(expected)) {
      throw new Error(`${script} is missing expected installer step: ${expected}`);
    }
  }
}

console.log("Installer smoke passed.");
