import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageInfo {
  name: string;
  version: string;
}

export const PACKAGE_INFO = readPackageInfo();
export const RECALL_PACKAGE_NAME = PACKAGE_INFO.name;
export const RECALL_VERSION = PACKAGE_INFO.version;

function readPackageInfo(): PackageInfo {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Partial<PackageInfo>;
      if (typeof parsed.name === "string" && typeof parsed.version === "string") {
        return { name: parsed.name, version: parsed.version };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return { name: "recall-memory-substrate", version: "0.0.0-dev" };
}
