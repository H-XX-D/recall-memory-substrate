import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface LaunchAgentOptions {
  label?: string;
  dbPath: string;
  intervalMs: number;
  nodeBin: string;
  cliPath: string;
  cwd: string;
  launchAgentsDir?: string;
}

export interface LaunchAgentResult {
  label: string;
  path: string;
  exists: boolean;
  plist?: string;
}

const DEFAULT_LABEL = "io.recall.memory.daemon";

export function renderLaunchAgentPlist(options: LaunchAgentOptions): string {
  const label = options.label ?? DEFAULT_LABEL;
  const stdout = join(options.cwd, ".recall", "daemon.out.log");
  const stderr = join(options.cwd, ".recall", "daemon.err.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(resolve(options.cwd))}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(resolve(options.nodeBin))}</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>${escapeXml(resolve(options.cliPath))}</string>
    <string>daemon</string>
    <string>run</string>
    <string>--db</string>
    <string>${escapeXml(options.dbPath)}</string>
    <string>--interval-ms</string>
    <string>${options.intervalMs}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderr)}</string>
</dict>
</plist>
`;
}

export function installLaunchAgent(options: LaunchAgentOptions): LaunchAgentResult {
  const label = options.label ?? DEFAULT_LABEL;
  const path = launchAgentPath(label, options.launchAgentsDir);
  const plist = renderLaunchAgentPlist(options);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(join(options.cwd, ".recall"), { recursive: true });
  writeFileSync(path, plist, "utf8");
  return { label, path, exists: true, plist };
}

export function uninstallLaunchAgent(label = DEFAULT_LABEL, launchAgentsDir?: string): LaunchAgentResult {
  const path = launchAgentPath(label, launchAgentsDir);
  if (existsSync(path)) {
    rmSync(path);
  }
  return { label, path, exists: existsSync(path) };
}

export function launchAgentStatus(label = DEFAULT_LABEL, launchAgentsDir?: string): LaunchAgentResult {
  const path = launchAgentPath(label, launchAgentsDir);
  return { label, path, exists: existsSync(path) };
}

export function launchAgentPath(label = DEFAULT_LABEL, launchAgentsDir?: string): string {
  return join(launchAgentsDir ?? join(homedir(), "Library", "LaunchAgents"), `${label}.plist`);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
