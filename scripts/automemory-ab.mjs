#!/usr/bin/env node
// ============================================================================
// automemory-ab: END-TO-END agent A/B — does a real Claude Code agent, in a
// FRESH session, surface the CURRENT value after a cross-session correction?
//
// Complements scripts/automemory-bench.mjs (which is store-level/deterministic).
// This drives real headless `claude -p` agents through a 3-session correction
// protocol and scores whether session 3 (a cold process) answers the corrected
// value — the behavior that decides whether structured supersession actually
// pays off for an agent, not just for the store.
//
//   PROTOCOL (per arm):
//     S1  "...prod DB runs on db-east-1. Persist it for future sessions."
//     S2  "...we migrated; it's now db-west-2. Update your durable memory."
//     S3  (cold process) "What host is the prod DB on right now?"  -> must say db-west-2
//
//   ARMS:
//     recall      real-HOME auth; isolated graph via an injected recall MCP
//                 (RECALL_DB); Claude auto-memory off; tools constrained to the
//                 recall MCP. Runnable wherever `claude` is logged in.
//     automemory  native auto-memory ON, no Recall — needs an ISOLATED Claude
//                 config, which only authenticates with ANTHROPIC_API_KEY set.
//                 Skipped (with a clear message) when that is unavailable.
//
//   Usage:  node scripts/automemory-ab.mjs [--arm recall|automemory|both] [--trials N]
//   Requires the `claude` CLI on PATH and a built repo (dist/).
// ============================================================================
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "src", "cli.js");
const MCP = join(ROOT, "dist", "src", "mcp", "cli.js");

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ARM = arg("--arm", "recall");
const TRIALS = parseInt(arg("--trials", "1"), 10);
const TIMEOUT = parseInt(arg("--timeout", "150"), 10) * 1000;

function have(cmd) { try { execSync(`command -v ${cmd}`, { stdio: "ignore" }); return true; } catch { return false; } }
if (!have("claude")) { console.log("SKIP automemory-ab: `claude` CLI not found on PATH."); process.exit(0); }
if (!existsSync(CLI) || !existsSync(MCP)) { console.log("SKIP automemory-ab: repo not built. Run `npm run build`."); process.exit(0); }

const PROTOCOL = [
  "Remember this for future sessions: the production database runs on host db-east-1. Persist it to your durable memory now.",
  "Correction: we migrated. The production database now runs on host db-west-2 and is no longer on db-east-1. Update your durable memory to reflect the current host.",
  "Consult your durable memory. What host does the production database run on RIGHT NOW? Reply with only the hostname.",
];

function claudeSession(prompt, { home, cwd, extraArgs = [], env = {} }) {
  try {
    return execFileSync("claude", ["-p", prompt, "--output-format", "text", ...extraArgs], {
      encoding: "utf8", timeout: TIMEOUT, stdio: ["pipe", "pipe", "pipe"], cwd,
      env: { ...process.env, ...(home ? { HOME: home } : {}), ...env },
    });
  } catch (e) { return `__ERROR__ ${(e.stderr || e.stdout || e.message || "").toString().slice(0, 300)}`; }
}

// ----- recall arm: real auth, isolated graph via injected MCP, tools constrained -----
function runRecallArm(i) {
  const dir = mkdtempSync(join(tmpdir(), `ab-recall-${i}-`));
  const db = join(dir, "recall.sqlite3");
  execFileSync("node", [CLI, "init", "--db", db], { stdio: "ignore" });
  const mcpConfig = join(dir, "mcp.json");
  writeFileSync(mcpConfig, JSON.stringify({
    mcpServers: { recall: { type: "stdio", command: "node", args: [MCP], env: { RECALL_DB: db } } },
  }));
  const tools = ["mcp__recall__recall_write", "mcp__recall__recall_compile", "mcp__recall__recall_search", "mcp__recall__recall_cell"];
  const extra = ["--mcp-config", mcpConfig, "--strict-mcp-config", "--allowedTools", ...tools];
  let s3 = "";
  for (let s = 0; s < PROTOCOL.length; s++) s3 = claudeSession(PROTOCOL[s], { extraArgs: extra });
  // deterministic store check independent of the agent's S3 phrasing:
  let storeCurrent = "";
  try { storeCurrent = execFileSync("node", [CLI, "compile", "current production database host", "--db", db], { encoding: "utf8" }); } catch {}
  rmSync(dir, { recursive: true, force: true });
  const agentSaysWest = /db-west-2/i.test(s3) && !/__ERROR__/.test(s3);
  const storeSaysWest = /db-west-2/i.test(storeCurrent) && /(challenged|superseded|eff:0\.[0-3])/i.test(storeCurrent);
  return { arm: "recall", trial: i, agentSaysWest, storeSaysWest, s3: s3.trim().slice(0, 200), pass: agentSaysWest };
}

// ----- automemory arm: needs isolated config (auth via API key) -----
function authOk(home) {
  const out = claudeSession("Reply with exactly: OK", { home });
  return /\bOK\b/.test(out) && !/Not logged in|__ERROR__/.test(out);
}
// A headless agent told to "persist to durable memory" may use EITHER the native
// auto-memory store (~/.claude/projects/<slug>/memory/*.md) OR CLAUDE.md / notes in
// the cwd. Capture both so we report which mechanism actually fired (native
// auto-memory was observed NOT to fire in `claude -p` — the agent falls back to
// CLAUDE.md, which is itself a flat overwrite-on-correction note file).
function listPersistedNotes(home, work) {
  const out = [];
  try { out.push(...execSync(`find ${JSON.stringify(join(home, ".claude", "projects"))} -path '*/memory/*.md' 2>/dev/null`, { encoding: "utf8" }).trim().split("\n").filter(Boolean).map((f) => ["auto-memory", f])); } catch {}
  try { out.push(...execSync(`find ${JSON.stringify(work)} -maxdepth 2 -iname 'CLAUDE.md' -o -iname 'NOTES.md' 2>/dev/null`, { encoding: "utf8" }).trim().split("\n").filter(Boolean).map((f) => ["claude-md", f])); } catch {}
  return out;
}
function runAutoMemoryArm(i) {
  const home = mkdtempSync(join(tmpdir(), `ab-am-${i}-`));
  const work = mkdtempSync(join(tmpdir(), `ab-am-work-${i}-`)); // isolated cwd so edits/memory stay contained
  mkdirSync(join(home, ".claude"), { recursive: true });
  // auto-memory ON (do NOT set CLAUDE_CODE_DISABLE_AUTO_MEMORY); no recall arming present.
  if (!authOk(home)) {
    rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true });
    return { arm: "automemory", trial: i, skipped: true, reason: "isolated config not authenticated (set ANTHROPIC_API_KEY to run this arm)" };
  }
  const extra = ["--permission-mode", "acceptEdits"]; // allow the agent to write its note file; bash stays gated
  let s3 = "";
  for (let s = 0; s < PROTOCOL.length; s++) s3 = claudeSession(PROTOCOL[s], { home, cwd: work, extraArgs: extra });
  const notes = listPersistedNotes(home, work);
  let blob = "";
  for (const [, f] of notes) { try { blob += execSync(`cat ${JSON.stringify(f)}`, { encoding: "utf8" }); } catch {} }
  const mechanism = notes.some((n) => n[0] === "auto-memory") ? "auto-memory"
    : notes.some((n) => n[0] === "claude-md") ? "CLAUDE.md" : "none";
  rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true });
  const agentSaysWest = /db-west-2/i.test(s3) && !/__ERROR__/.test(s3);
  // overwrite vs retain: did the persisted note keep the OLD value alongside the new?
  const noteHasWest = /db-west-2/i.test(blob), noteHasEast = /db-east-1/i.test(blob);
  return { arm: "automemory", trial: i, agentSaysWest, persistMechanism: mechanism, noteFiles: notes.length,
           noteRetainsOld: noteHasEast, noteHasCurrent: noteHasWest, s3: s3.trim().slice(0, 200), pass: agentSaysWest };
}

const out = [];
for (let i = 1; i <= TRIALS; i++) {
  if (ARM === "recall" || ARM === "both") out.push(runRecallArm(i));
  if (ARM === "automemory" || ARM === "both") out.push(runAutoMemoryArm(i));
}
const tally = (a) => { const r = out.filter((o) => o.arm === a && !o.skipped); return r.length ? `${r.filter((o) => o.pass).length}/${r.length} cold-session-correct` : "skipped"; };
console.log("# automemory-ab: end-to-end agent A/B (fresh-session correctness after correction)\n");
for (const o of out) console.log(JSON.stringify(o));
console.log(`\nrecall arm:     ${tally("recall")}`);
console.log(`automemory arm: ${tally("automemory")}`);
