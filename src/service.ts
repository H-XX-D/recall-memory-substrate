// R9 launchd service assets: file-only management of a StartInterval launchd
// agent that runs `recall maintain --all-graphs` on a schedule.
//
// StartInterval, not KeepAlive: the agent is a periodic sweep, not a
// long-running daemon that should be relaunched the instant it exits.
// launchctl is never invoked from here; the CLI layer prints the
// `launchctl load`/`unload` command for the user to run themselves, so this
// module only ever touches the filesystem.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ServiceOptions {
  label?: string;
  intervalMinutes?: number;
  nodeBin?: string;
  cliPath?: string;
  launchAgentsDir?: string;
  logDir?: string;
}

type ResolvedServiceOptions = Required<ServiceOptions>;

const DEFAULT_LABEL = "io.recall.maintain";
const DEFAULT_INTERVAL_MINUTES = 60;

// The installed CLI entrypoint sits next to this module once built
// (dist/service.js next to dist/cli.js). During development this module
// runs from src/ via tsx, where there is no sibling cli.js, so the dist
// build is used as the fallback: dist/cli.js relative to the package root.
function defaultCliPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = join(here, "cli.js");
  if (existsSync(sibling)) return sibling;
  return join(here, "..", "dist", "cli.js");
}

export function resolveServiceOptions(opts: ServiceOptions = {}): ResolvedServiceOptions {
  return {
    label: opts.label ?? DEFAULT_LABEL,
    intervalMinutes: opts.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
    nodeBin: opts.nodeBin ?? process.execPath,
    cliPath: opts.cliPath ?? defaultCliPath(),
    launchAgentsDir: opts.launchAgentsDir ?? join(homedir(), "Library", "LaunchAgents"),
    logDir: opts.logDir ?? join(homedir(), ".recall", "logs"),
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function plistString(value: string): string {
  return `<string>${xmlEscape(value)}</string>`;
}

// launchd XML for a StartInterval (not KeepAlive) agent that runs
// `nodeBin cliPath maintain --all-graphs` every intervalMinutes minutes.
// RunAtLoad is false: install should not immediately fire a maintenance
// pass, only schedule the next one.
export function renderMaintainPlist(opts: Required<ServiceOptions>): string {
  const seconds = Math.max(1, Math.round(opts.intervalMinutes * 60));
  const stdout = join(opts.logDir, `${opts.label}.out.log`);
  const stderr = join(opts.logDir, `${opts.label}.err.log`);
  const args = [opts.nodeBin, opts.cliPath, "maintain", "--all-graphs"];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${plistString(opts.label)}
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    ${plistString(arg)}`).join("\n")}
  </array>
  <key>StartInterval</key>
  <integer>${seconds}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  ${plistString(stdout)}
  <key>StandardErrorPath</key>
  ${plistString(stderr)}
</dict>
</plist>
`;
}

function plistPath(opts: ResolvedServiceOptions): string {
  return join(opts.launchAgentsDir, `${opts.label}.plist`);
}

// Writes the plist to disk. Never invokes launchctl: the caller (the CLI
// verb) is responsible for telling the user how to load it.
export function installService(opts: ServiceOptions = {}): { label: string; path: string; plist: string } {
  const resolved = resolveServiceOptions(opts);
  mkdirSync(resolved.launchAgentsDir, { recursive: true });
  mkdirSync(resolved.logDir, { recursive: true });
  const plist = renderMaintainPlist(resolved);
  const path = plistPath(resolved);
  writeFileSync(path, plist);
  return { label: resolved.label, path, plist };
}

// Removes the plist file. Never invokes launchctl: if the agent is loaded,
// the caller must unload it themselves first (the CLI prints that command).
export function uninstallService(opts: ServiceOptions = {}): { label: string; path: string; removed: boolean } {
  const resolved = resolveServiceOptions(opts);
  const path = plistPath(resolved);
  const removed = existsSync(path);
  if (removed) rmSync(path);
  return { label: resolved.label, path, removed };
}

export function serviceStatus(opts: ServiceOptions = {}): { label: string; path: string; installed: boolean } {
  const resolved = resolveServiceOptions(opts);
  const path = plistPath(resolved);
  return { label: resolved.label, path, installed: existsSync(path) };
}

// The launchctl invocation the CLI prints for the user after install, and
// the equivalent for uninstall/status messaging.
export function launchctlLoadCommand(opts: ServiceOptions = {}): string {
  const resolved = resolveServiceOptions(opts);
  return `launchctl load ${plistPath(resolved)}`;
}

export function launchctlUnloadCommand(opts: ServiceOptions = {}): string {
  const resolved = resolveServiceOptions(opts);
  return `launchctl unload ${plistPath(resolved)}`;
}

// Non-macOS platforms have no launchd; the CLI still manages the plist file
// (harmless to write, and lets a user copy it to a mac later), but prints a
// crontab-equivalent note instead of a launchctl command.
export function crontabEquivalent(opts: ServiceOptions = {}): string {
  const resolved = resolveServiceOptions(opts);
  return `*/${resolved.intervalMinutes} * * * * ${resolved.nodeBin} ${resolved.cliPath} maintain --all-graphs >> ${join(resolved.logDir, `${resolved.label}.out.log`)} 2>> ${join(resolved.logDir, `${resolved.label}.err.log`)}`;
}
