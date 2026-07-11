#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

let tarballPath;
let tempRoot;

try {
  const packed = npmPack();
  tarballPath = join(repoRoot, packed.filename);
  assert.equal(packed.name, packageJson.name);
  assert.equal(packed.version, packageJson.version);
  assert.ok(existsSync(tarballPath), `missing packed tarball: ${tarballPath}`);

  tempRoot = mkdtempSync(join(tmpdir(), "recall-mal-acceptance-"));
  const consumer = join(tempRoot, "consumer");
  const projectRoot = join(tempRoot, "project");
  const recallHome = join(tempRoot, "recall-home");
  mkdirSync(consumer, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });

  run("npm", ["init", "-y"], { cwd: consumer });
  run("npm", ["install", "--no-audit", "--no-fund", tarballPath], { cwd: consumer });

  const packageRoot = join(consumer, "node_modules", packageJson.name);
  const bin = join(consumer, "node_modules", ".bin", process.platform === "win32" ? "recall.cmd" : "recall");
  assert.ok(existsSync(bin), "installed recall bin is missing");
  assert.ok(existsSync(join(packageRoot, "python", "recall_helper.py")), "python helper missing from package");
  assert.ok(existsSync(join(packageRoot, "python", "recall_peek.py")), "python peek helper missing from package");
  assert.ok(existsSync(join(packageRoot, "README.md")), "README missing from package");
  assert.ok(existsSync(join(packageRoot, "CHANGELOG.md")), "CHANGELOG missing from package");
  assert.ok(existsSync(join(packageRoot, "LICENSE")), "LICENSE missing from package");
  assert.equal(existsSync(join(packageRoot, "src")), false, "source tree should not be published");

  const env = { RECALL_HOME: recallHome };
  const version = runJson(bin, ["version"], { cwd: consumer, env });
  assert.deepEqual(version, { name: packageJson.name, version: packageJson.version });

  runLibrarySmoke(consumer);
  runCliFlow(bin, tempRoot, projectRoot, env);
  runLatticeFlow(bin, tempRoot, env);
  runPythonHelperFlow(packageRoot, tempRoot);
  runAssistantSyncFlow(bin, tempRoot);

  console.log(`installed package acceptance passed for ${packageJson.name}@${packageJson.version}`);
} finally {
  if (tarballPath && existsSync(tarballPath)) unlinkSync(tarballPath);
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
}

function npmPack() {
  const result = run("npm", ["pack", "--json"], { cwd: repoRoot });
  const entries = parseJsonArrayFromNpm(result.stdout);
  assert.equal(entries.length, 1);
  return entries[0];
}

function runLibrarySmoke(consumer) {
  const smokePath = join(consumer, "library-smoke.mjs");
  writeFileSync(
    smokePath,
    `
import assert from "node:assert/strict";
import { SqliteStore, admit, compileContext } from "recall-memory-substrate";

const store = new SqliteStore(":memory:");
try {
  const body = "The installed package exports support admission and compile.";
  const result = admit({
    kind: "obs",
    title: "library acceptance signal",
    body,
    confidence: 0.84,
    topics: ["acceptance", "library"],
    entities: ["recall-mal"],
    verification: "tested",
    sensitivity: "private"
  }, { store, now: "2026-06-26T12:00:00.000Z" });
  assert.equal(result.accepted, true);
  assert.equal(result.cell.body, body);
  assert.equal(store.stats().activeCells, 1);
  const packet = compileContext(store, "library acceptance signal", { budgetWords: 200 });
  assert.equal(packet.objective, "library acceptance signal");
  assert.ok(packet.relevantMemory.some((line) => line.includes("library acceptance signal")));
  const duplicate = admit({
    kind: "obs",
    title: "library acceptance signal",
    body,
    confidence: 0.84,
    topics: ["acceptance", "library"],
    entities: ["recall-mal"],
    verification: "tested",
    sensitivity: "private"
  }, { store, now: "2026-06-26T12:01:00.000Z" });
  assert.equal(duplicate.accepted, true);
  assert.equal(duplicate.cell.key, result.cell.key);
  assert.equal(store.stats().activeCells, 1);
} finally {
  store.close();
}
`,
  );
  run("node", ["--disable-warning=ExperimentalWarning", smokePath], { cwd: consumer });
}

function runCliFlow(bin, tempRoot, projectRoot, env) {
  const dbPath = join(tempRoot, "accept.sqlite3");
  const project = runJson(
    bin,
    ["project", "init", "--slug", "accept", "--root", projectRoot, "--db", dbPath, "--description", "Acceptance"],
    { cwd: projectRoot, env },
  );
  assert.equal(project.status, "initialized");
  assert.equal(project.project.slug, "accept");
  assert.equal(project.stats.activeCells, 0);

  const nested = join(projectRoot, "src");
  mkdirSync(nested, { recursive: true });
  const where = runJson(bin, ["where"], { cwd: nested, env });
  assert.equal(where.scope, "project");
  assert.equal(where.slug, "accept");

  const proposalPath = join(tempRoot, "proposal.json");
  writeJson(proposalPath, {
    kind: "obs",
    title: "installed acceptance signal",
    body: "The installed CLI wrote and retrieved this cell.",
    confidence: 0.86,
    topics: ["acceptance", "npm"],
    entities: ["recall-mal"],
    verification: "tested",
    sensitivity: "private",
  });

  const valid = runJson(bin, ["validate", "--json", proposalPath], { cwd: projectRoot, env });
  assert.equal(valid.ok, true);

  const admitted = runJson(bin, ["admit", "--json", proposalPath, "--project", "accept"], { cwd: projectRoot, env });
  assert.equal(admitted.accepted, true);
  const key = admitted.cell.key;
  assert.ok(key);
  assert.equal(admitted.cell.title, "installed acceptance signal");
  assert.equal(admitted.cell.body, "The installed CLI wrote and retrieved this cell.");
  assert.equal(admitted.cell.scores.effective, admitted.cell.scores.conf);
  const originalEffective = admitted.cell.scores.effective;

  const statusAfterAdmit = runJson(bin, ["status", "--project", "accept"], { cwd: projectRoot, env });
  assert.equal(statusAfterAdmit.stats.cells, 1);
  assert.equal(statusAfterAdmit.stats.activeCells, 1);

  const duplicate = runJson(bin, ["admit", "--json", proposalPath, "--project", "accept"], { cwd: projectRoot, env });
  assert.equal(duplicate.accepted, true);
  assert.equal(duplicate.cell.key, key);
  assert.ok(duplicate.warnings.includes("deduplicated: identical active cell exists"));
  const statusAfterDuplicate = runJson(bin, ["status", "--project", "accept"], { cwd: projectRoot, env });
  assert.equal(statusAfterDuplicate.stats.cells, 1);
  assert.equal(statusAfterDuplicate.stats.activeCells, 1);

  const search = runJson(bin, ["search", "installed acceptance", "--project", "accept"], { cwd: projectRoot, env });
  assert.equal(search.hits[0].cell.key, key);

  const compiled = runText(bin, ["compile", "installed acceptance", "--project", "accept", "--words", "200"], {
    cwd: projectRoot,
    env,
  });
  assert.match(compiled.stdout, /installed acceptance signal/);
  assert.match(compiled.stdout, new RegExp(key));

  const cell = runJson(bin, ["cell", "show", key, "--project", "accept"], { cwd: projectRoot, env });
  assert.equal(cell.cell.key, key);
  assert.equal(cell.cell.body, "The installed CLI wrote and retrieved this cell.");

  const challengePath = join(tempRoot, "challenge.json");
  writeJson(challengePath, {
    kind: "obs",
    title: "installed acceptance challenge",
    body: "This challenge should lower the target effective confidence.",
    confidence: 0.78,
    topics: ["acceptance", "graph"],
    entities: ["recall-mal"],
    verification: "tested",
    sensitivity: "private",
    edges: [{ relation: "contradicts", target: key }],
  });
  const challenge = runJson(bin, ["admit", "--json", challengePath, "--project", "accept"], { cwd: projectRoot, env });
  assert.equal(challenge.accepted, true);
  const challengedCell = runJson(bin, ["cell", "show", key, "--project", "accept"], { cwd: projectRoot, env });
  assert.ok(challengedCell.cell.scores.effective < originalEffective);

  const programPath = join(tempRoot, "program.json");
  writeJson(programPath, {
    kind: "prg",
    title: "installed operator witness",
    body: "Emit a witness from the installed package operator.",
    confidence: 0.82,
    topics: ["acceptance", "operator"],
    props: {
      program: {
        schemaVersion: "recall.program.v1",
        operation: "emit_witness",
        target: { keys: [key] },
      },
    },
  });
  const program = runJson(bin, ["admit", "--json", programPath, "--project", "accept"], { cwd: projectRoot, env });
  assert.equal(program.accepted, true);

  const operated = runJson(bin, ["operate", "once", "--derive", "--project", "accept"], { cwd: projectRoot, env });
  assert.equal(operated.status, "ran");
  assert.equal(operated.programs.derived[0].accepted, true);
  assert.equal(operated.programs.derived[0].cell.kind, "obs");

  const mem0Path = join(tempRoot, "mem0.json");
  writeJson(mem0Path, { memories: [{ id: "m1", memory: "Installed package imported this Mem0 record." }] });
  const statusBeforeDryRun = runJson(bin, ["status", "--project", "accept"], { cwd: projectRoot, env });
  const dryRun = runJson(bin, ["import", "mem0", "--json", mem0Path, "--project", "accept"], { cwd: projectRoot, env });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.created, 1);
  const statusAfterDryRun = runJson(bin, ["status", "--project", "accept"], { cwd: projectRoot, env });
  assert.equal(statusAfterDryRun.stats.cells, statusBeforeDryRun.stats.cells);
  assert.equal(statusAfterDryRun.stats.activeCells, statusBeforeDryRun.stats.activeCells);

  const applied = runJson(bin, ["import", "mem0", "--json", mem0Path, "--apply", "--project", "accept"], {
    cwd: projectRoot,
    env,
  });
  assert.equal(applied.created, 1);
  assert.equal(applied.items[0].action, "create");

  const reapplied = runJson(bin, ["import", "mem0", "--json", mem0Path, "--apply", "--project", "accept"], {
    cwd: projectRoot,
    env,
  });
  assert.equal(reapplied.created, 0);
  assert.equal(reapplied.skipped, 1);
  assert.equal(reapplied.items[0].reason, "unchanged");

  const archive = runJson(bin, ["export", "--project", "accept"], { cwd: projectRoot, env });
  assert.equal(archive.schemaVersion, "recall.cells.export.v2");
  assert.ok(archive.cells.length >= 5);
  assert.ok(archive.cells.some((cell) => cell.key === key && cell.body === "The installed CLI wrote and retrieved this cell."));

  const archivePath = join(tempRoot, "archive.json");
  writeJson(archivePath, archive);
  const copyRoot = join(tempRoot, "copy-project");
  mkdirSync(copyRoot, { recursive: true });
  runJson(bin, ["project", "init", "--slug", "accept-copy", "--root", copyRoot, "--db", join(tempRoot, "copy.sqlite3")], {
    cwd: copyRoot,
    env,
  });
  const archiveImport = runJson(bin, ["import", "archive", "--json", archivePath, "--apply", "--project", "accept-copy"], {
    cwd: copyRoot,
    env,
  });
  assert.equal(archiveImport.imported, archive.cells.length);
  const copiedCell = runJson(bin, ["cell", "show", key, "--project", "accept-copy"], { cwd: copyRoot, env });
  assert.equal(copiedCell.cell.key, key);
  assert.equal(copiedCell.cell.body, "The installed CLI wrote and retrieved this cell.");
  const copiedSearch = runJson(bin, ["search", "installed acceptance", "--project", "accept-copy"], { cwd: copyRoot, env });
  assert.equal(copiedSearch.hits[0].cell.key, key);
  const archiveReimport = runJson(bin, ["import", "archive", "--json", archivePath, "--apply", "--project", "accept-copy"], {
    cwd: copyRoot,
    env,
  });
  assert.equal(archiveReimport.imported, 0);
  assert.equal(archiveReimport.skipped, archive.cells.length);
}

function runLatticeFlow(bin, tempRoot, env) {
  const dbPath = join(tempRoot, "lattice.sqlite3");
  const basePath = join(tempRoot, "lattice-base.json");
  writeJson(basePath, {
    kind: "obs",
    title: "lattice base claim",
    body: "The graph lattice should preserve support, challenge, and supersession structure.",
    confidence: 0.6,
    topics: ["lattice", "structure"],
    entities: ["recall-mal"],
    verification: "checked",
    sensitivity: "private",
  });
  const base = runJson(bin, ["admit", "--json", basePath, "--db", dbPath], { env });
  assert.equal(base.accepted, true);
  const baseKey = base.cell.key;
  const baseEffective = base.cell.scores.effective;

  const supportPath = join(tempRoot, "lattice-support.json");
  writeJson(supportPath, {
    kind: "obs",
    title: "lattice support witness",
    body: "A support edge should raise the base effective confidence.",
    confidence: 0.8,
    topics: ["lattice", "structure"],
    entities: ["recall-mal"],
    verification: "tested",
    sensitivity: "private",
    edges: [{ relation: "supports", target: baseKey }],
  });
  const support = runJson(bin, ["admit", "--json", supportPath, "--db", dbPath], { env });
  assert.equal(support.accepted, true);
  const supportKey = support.cell.key;
  const supportedBase = runJson(bin, ["cell", "show", baseKey, "--db", dbPath], { env });
  assert.ok(supportedBase.cell.scores.effective > baseEffective);

  const challengePath = join(tempRoot, "lattice-challenge.json");
  writeJson(challengePath, {
    kind: "obs",
    title: "lattice contradiction witness",
    body: "A contradiction edge should lower the base effective confidence.",
    confidence: 0.82,
    topics: ["lattice", "structure"],
    entities: ["recall-mal"],
    verification: "tested",
    sensitivity: "private",
    edges: [{ relation: "contradicts", target: baseKey }],
  });
  const challenge = runJson(bin, ["admit", "--json", challengePath, "--db", dbPath], { env });
  assert.equal(challenge.accepted, true);
  const challengeKey = challenge.cell.key;
  const challengedBase = runJson(bin, ["cell", "show", baseKey, "--db", dbPath], { env });
  assert.ok(challengedBase.cell.scores.effective < supportedBase.cell.scores.effective);

  const replacementPath = join(tempRoot, "lattice-replacement.json");
  writeJson(replacementPath, {
    kind: "obs",
    title: "lattice replacement head",
    body: "A superseding head should demote the old base and preserve lineage.",
    confidence: 0.88,
    topics: ["lattice", "structure"],
    entities: ["recall-mal"],
    verification: "tested",
    sensitivity: "private",
    edges: [{ relation: "supersedes", target: baseKey }],
  });
  const replacement = runJson(bin, ["admit", "--json", replacementPath, "--db", dbPath], { env });
  assert.equal(replacement.accepted, true);
  const replacementKey = replacement.cell.key;

  const oldHead = runJson(bin, ["cell", "show", baseKey, "--db", dbPath], { env });
  assert.equal(oldHead.cell.status, "superseded");
  assert.equal(oldHead.footprint.incomingEdges, 3);
  assert.deepEqual(
    oldHead.incoming.map((link) => link.edge.relation).sort(),
    ["contradicts", "supersedes", "supports"],
  );
  assert.deepEqual(
    oldHead.expansionHandles.slice().sort(),
    [challengeKey, replacementKey, supportKey].sort(),
  );

  const newHead = runJson(bin, ["cell", "show", replacementKey, "--db", dbPath], { env });
  assert.equal(newHead.cell.status, "active");
  assert.deepEqual(newHead.cell.lineage, [baseKey]);
  assert.equal(newHead.outgoing[0].edge.relation, "supersedes");
  assert.equal(newHead.outgoing[0].edge.target, baseKey);

  const oldSearch = runJson(bin, ["search", "lattice base claim", "--db", dbPath], { env });
  assert.ok(oldSearch.hits.every((hit) => hit.cell.key !== baseKey));
  const newSearch = runJson(bin, ["search", "lattice replacement head", "--db", dbPath], { env });
  assert.equal(newSearch.hits[0].cell.key, replacementKey);

  const compiled = runText(bin, ["compile", "lattice replacement head", "--db", dbPath, "--words", "240"], { env });
  assert.match(compiled.stdout, /lattice replacement head/);
  assert.match(compiled.stdout, new RegExp(replacementKey));

  const archive = runJson(bin, ["export", "--db", dbPath], { env });
  assert.equal(archive.cells.length, 4);
  assert.ok(archive.cells.some((cell) => cell.key === baseKey && cell.status === "superseded"));
  assert.ok(archive.cells.some((cell) => cell.key === replacementKey && cell.lineage[0] === baseKey));

  const archivePath = join(tempRoot, "lattice-archive.json");
  const copyDb = join(tempRoot, "lattice-copy.sqlite3");
  writeJson(archivePath, archive);
  const restored = runJson(bin, ["import", "archive", "--json", archivePath, "--apply", "--db", copyDb], { env });
  assert.equal(restored.imported, archive.cells.length);

  const restoredOldHead = runJson(bin, ["cell", "show", baseKey, "--db", copyDb], { env });
  assert.equal(restoredOldHead.cell.status, "superseded");
  assert.equal(restoredOldHead.footprint.incomingEdges, 3);
  const restoredNewHead = runJson(bin, ["cell", "show", replacementKey, "--db", copyDb], { env });
  assert.deepEqual(restoredNewHead.cell.lineage, [baseKey]);
}

function runPythonHelperFlow(packageRoot, tempRoot) {
  const helper = join(packageRoot, "python", "recall_helper.py");
  const peek = join(packageRoot, "python", "recall_peek.py");
  const dbPath = join(tempRoot, "python-helper.sqlite3");
  const admitted = runJson(
    "python3",
    [
      helper,
      "--kind",
      "obs",
      "--title",
      "python installed helper",
      "--body",
      "The installed Python helper admitted this cell through recall-mal.",
      "--confidence",
      "0.83",
      "--topics",
      "acceptance,python",
      "--entities",
      "recall-mal",
      "--admit",
      "--db",
      dbPath,
    ],
    { cwd: packageRoot },
  );
  assert.equal(admitted.accepted, true);
  assert.equal(admitted.cell.body, "The installed Python helper admitted this cell through recall-mal.");

  const key = admitted.cell.key;
  const peeked = runJson("python3", [peek, key, "--db", dbPath, "--format", "json"], { cwd: packageRoot });
  assert.equal(peeked.key, key);
  assert.equal(peeked.title, "python installed helper");
  // v5 peek envelope: the excerpt lives under body, not top-level bodyPreview.
  assert.equal(peeked.body.excerpt, "The installed Python helper admitted this cell through recall-mal.");
  assert.equal(peeked.body.truncated, false);
}

function runAssistantSyncFlow(bin, tempRoot) {
  const home = join(tempRoot, "assistant-home");
  const codexHome = join(tempRoot, "codex-home");
  mkdirSync(home, { recursive: true });
  const env = { HOME: home, CODEX_HOME: codexHome };

  const claude = runJson(bin, ["claude", "sync", "--apply", "--keep-automemory"], { env });
  assert.equal(claude.dryRun, false);
  const claudeSettings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(Object.keys(claudeSettings.hooks).sort(), [
    "PostToolUse", "SessionStart", "Stop", "UserPromptExpansion", "UserPromptSubmit",
  ]);

  const codex = runJson(bin, ["codex", "sync", "--apply"], { env });
  assert.equal(codex.dryRun, false);
  assert.equal(codex.hookAssetInstalled, true);
  const hooksPath = join(codexHome, "hooks.json");
  const hookPath = join(codexHome, "hooks", "recall-session-start.py");
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
  assert.equal(existsSync(hookPath), true);
  assert.equal(statSync(hooksPath).mode & 0o777, 0o600);
  assert.equal(statSync(hookPath).mode & 0o777, 0o700);

  const status = runJson(bin, ["codex", "status"], { env });
  assert.equal(status.hooksInstalled, true);
}

function runJson(command, args, options = {}) {
  const result = run(command, args, options);
  return JSON.parse(result.stdout);
}

function runText(command, args, options = {}) {
  return run(command, args, options);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} failed with status ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseJsonArrayFromNpm(stdout) {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.lastIndexOf("[");
    const end = text.lastIndexOf("]");
    assert.ok(start >= 0 && end > start, `npm pack --json did not return parseable JSON:\n${stdout}`);
    return JSON.parse(text.slice(start, end + 1));
  }
}
