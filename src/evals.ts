// R8 model-free eval suite: cheap, deterministic checks over the store itself
// (search/semantic/compile behavior plus structural invariants) with no model
// call and no store mutation. runRecallEval is pure and read-only; persistence
// (the eval_runs ledger) and derivation into a ver cell are layered on top by
// runAndRecordEval / runEvalAndDerive, mirroring the program_run ledger split
// between programs.ts (pure-ish run) and store.ts (SqliteStore-only history).
import { randomUUID } from "node:crypto";
import { resolveCell } from "./cell-context.js";
import { compileContext, formatContextPacket } from "./compile.js";
import { derivationHash, deriveAdmit, stableJson } from "./derivation.js";
import { semanticSearch } from "./semantic.js";
import type { SqliteStore } from "./store.js";
import type { AdmissionResult, Cell, Store, WriteProposal } from "./types.js";

export type RecallEvalInvariant =
  | "key-handle-consistency"
  | "edge-targets-resolve"
  | "effective-confidence-bounds"
  | "depends-on-acyclic"
  | "prefix-resolution";

export type RecallEvalCase =
  | { name: string; kind: "search"; query: string; expectContains?: string; minResults?: number }
  | { name: string; kind: "semantic"; query: string; expectContains?: string; minResults?: number }
  | { name: string; kind: "compile"; task: string; expectContains?: string; maxWords?: number }
  | { name: string; kind: "invariant"; invariant: RecallEvalInvariant };

export interface RecallEvalSuite {
  name: string;
  cases: RecallEvalCase[];
}

export interface RecallEvalCaseResult {
  name: string;
  kind: RecallEvalCase["kind"];
  passed: boolean;
  score: number;
  details: Record<string, unknown>;
}

export interface RecallEvalResult {
  name: string;
  passed: boolean;
  score: number;
  cases: RecallEvalCaseResult[];
  createdAt: string;
}

const ACTIVE_CAP = 1000;

// minResults 0 on the search/semantic cases is deliberate: the default suite
// must pass on a fresh, empty store as well as a seeded healthy one, and a
// zero-hit result on an empty store is correct behavior, not a failure.
export function defaultEvalSuite(): RecallEvalSuite {
  return {
    name: "recall-default",
    cases: [
      { name: "search-smoke", kind: "search", query: "recall", minResults: 0 },
      { name: "semantic-smoke", kind: "semantic", query: "recall", minResults: 0 },
      { name: "compile-smoke", kind: "compile", task: "recall status", maxWords: 900 },
      { name: "key-handle-consistency", kind: "invariant", invariant: "key-handle-consistency" },
      { name: "edge-targets-resolve", kind: "invariant", invariant: "edge-targets-resolve" },
      { name: "effective-confidence-bounds", kind: "invariant", invariant: "effective-confidence-bounds" },
      { name: "depends-on-acyclic", kind: "invariant", invariant: "depends-on-acyclic" },
      { name: "prefix-resolution", kind: "invariant", invariant: "prefix-resolution" },
    ],
  };
}

// Pure and read-only: no store.put, no indexing, no side effects. Safe to run
// on every request or on a schedule without perturbing the graph it inspects.
export function runRecallEval(
  store: Store,
  suite: RecallEvalSuite = defaultEvalSuite(),
  now: Date = new Date(),
): RecallEvalResult {
  const cases = suite.cases.map((c) => runCase(store, c));
  const score = roundScore(cases.reduce((sum, c) => sum + c.score, 0) / (cases.length || 1));
  return {
    name: suite.name,
    passed: cases.every((c) => c.passed),
    score,
    cases,
    createdAt: now.toISOString(),
  };
}

function runCase(store: Store, c: RecallEvalCase): RecallEvalCaseResult {
  switch (c.kind) {
    case "search":
      return runSearchCase(store, c);
    case "semantic":
      return runSemanticCase(store, c);
    case "compile":
      return runCompileCase(store, c);
    case "invariant":
      return runInvariantCase(store, c);
    default:
      // Exhaustiveness guard: a custom suite (e.g. from the CLI's --json) can
      // carry a case with an unrecognized kind (a typo like "serach"). Fail
      // loudly here rather than falling through to undefined, which would
      // surface as an opaque TypeError one line up in runRecallEval.
      throw new Error("unknown eval case kind: " + String((c as { kind?: unknown }).kind));
  }
}

function runSearchCase(
  store: Store,
  c: Extract<RecallEvalCase, { kind: "search" }>,
): RecallEvalCaseResult {
  const hits = store.search(c.query, { limit: 20 });
  const minResults = c.minResults ?? 0;
  const containsOk =
    !c.expectContains ||
    hits.some((h) => h.cell.title.includes(c.expectContains!) || h.cell.handle.includes(c.expectContains!));
  const passed = hits.length >= minResults && containsOk;
  return {
    name: c.name,
    kind: c.kind,
    passed,
    score: passed ? 1 : 0,
    details: { hitCount: hits.length, minResults, containsOk },
  };
}

function runSemanticCase(
  store: Store,
  c: Extract<RecallEvalCase, { kind: "semantic" }>,
): RecallEvalCaseResult {
  const hits = semanticSearch(c.query, store, { limit: 20 });
  const minResults = c.minResults ?? 0;
  const containsOk =
    !c.expectContains ||
    hits.some((h) => h.cell.title.includes(c.expectContains!) || h.cell.handle.includes(c.expectContains!));
  const passed = hits.length >= minResults && containsOk;
  return {
    name: c.name,
    kind: c.kind,
    passed,
    score: passed ? 1 : 0,
    details: { hitCount: hits.length, minResults, containsOk },
  };
}

function runCompileCase(
  store: Store,
  c: Extract<RecallEvalCase, { kind: "compile" }>,
): RecallEvalCaseResult {
  const maxWords = c.maxWords ?? 900;
  const packet = compileContext(store, c.task, { budgetWords: maxWords });
  const withinBudget = packet.wordCount <= maxWords;
  const containsOk = !c.expectContains || formatContextPacket(packet).includes(c.expectContains);
  const passed = withinBudget && containsOk;
  return {
    name: c.name,
    kind: c.kind,
    passed,
    score: passed ? 1 : 0,
    details: { wordCount: packet.wordCount, maxWords, withinBudget, containsOk },
  };
}

function runInvariantCase(
  store: Store,
  c: Extract<RecallEvalCase, { kind: "invariant" }>,
): RecallEvalCaseResult {
  const active = store.active().slice(0, ACTIVE_CAP);
  switch (c.invariant) {
    case "key-handle-consistency":
      return keyHandleConsistency(c.name, store, active);
    case "edge-targets-resolve":
      return edgeTargetsResolve(c.name, store, active);
    case "effective-confidence-bounds":
      return effectiveConfidenceBounds(c.name, active);
    case "depends-on-acyclic":
      return dependsOnAcyclic(c.name, active);
    case "prefix-resolution":
      return prefixResolution(c.name, store, active);
  }
}

// Every cell's own handle must resolve via getByHandle to SOME cell. 4-hex
// handles can collide across cells (that's a known, accepted property of the
// handle space, not a bug), so collisions are counted and reported in details
// rather than failing the case.
function keyHandleConsistency(name: string, store: Store, active: Cell[]): RecallEvalCaseResult {
  let collisions = 0;
  let unresolved = 0;
  for (const cell of active) {
    const resolved = store.getByHandle(cell.handle);
    if (!resolved) {
      unresolved += 1;
      continue;
    }
    if (resolved.key !== cell.key) collisions += 1;
  }
  const passed = unresolved === 0;
  return {
    name,
    kind: "invariant",
    passed,
    score: passed ? 1 : 0,
    details: { checked: active.length, unresolved, collisions },
  };
}

// Every edgesOut target must resolve via get or getByHandle. Lists up to 10
// dangling "source relation target" triples for triage without flooding
// details on a badly corrupted graph.
function edgeTargetsResolve(name: string, store: Store, active: Cell[]): RecallEvalCaseResult {
  const dangling: string[] = [];
  for (const cell of active) {
    for (const edge of cell.edgesOut) {
      const target = store.get(edge.target) ?? store.getByHandle(edge.target);
      if (!target) {
        if (dangling.length < 10) {
          dangling.push(`${edge.source} ${edge.relation} ${edge.target}`);
        }
      }
    }
  }
  const passed = dangling.length === 0;
  return {
    name,
    kind: "invariant",
    passed,
    score: passed ? 1 : 0,
    details: { checked: active.length, dangling },
  };
}

const SCORE_FIELDS = [
  "conf",
  "uncertainty",
  "concern",
  "sourceQuality",
  "actorCalibration",
  "effective",
  "currencyC0",
  "currency",
  "salienceSeed",
  "salience",
] as const;

// Every Scores field must sit within [0, 1]. Offenders list the cell key,
// field, and out-of-bounds value for triage.
function effectiveConfidenceBounds(name: string, active: Cell[]): RecallEvalCaseResult {
  const offenders: { key: string; field: string; value: number }[] = [];
  for (const cell of active) {
    for (const field of SCORE_FIELDS) {
      const value = cell.scores[field];
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        offenders.push({ key: cell.key, field, value });
      }
    }
  }
  const passed = offenders.length === 0;
  return {
    name,
    kind: "invariant",
    passed,
    score: passed ? 1 : 0,
    details: { checked: active.length, offenders },
  };
}

// DFS over depends_on edges among active cells, walking only edges whose
// target is itself an active cell (a depends_on pointing outside the active
// set cannot participate in a cycle within it).
function dependsOnAcyclic(name: string, active: Cell[]): RecallEvalCaseResult {
  const byKey = new Map(active.map((cell) => [cell.key, cell]));
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const cell of active) color.set(cell.key, WHITE);

  let cycle: string[] | undefined;

  const visit = (key: string, path: string[]): boolean => {
    color.set(key, GRAY);
    const cell = byKey.get(key);
    if (cell) {
      for (const edge of cell.edgesOut) {
        if (edge.relation !== "depends_on") continue;
        if (!byKey.has(edge.target)) continue; // outside the active set
        const state = color.get(edge.target);
        if (state === GRAY) {
          cycle = [...path, edge.target];
          return true;
        }
        if (state === WHITE && visit(edge.target, [...path, edge.target])) {
          return true;
        }
      }
    }
    color.set(key, BLACK);
    return false;
  };

  for (const cell of active) {
    if (color.get(cell.key) === WHITE) {
      if (visit(cell.key, [cell.key])) break;
    }
  }

  const passed = cycle === undefined;
  return {
    name,
    kind: "invariant",
    passed,
    score: passed ? 1 : 0,
    details: { checked: active.length, cycle: cycle ?? [] },
  };
}

// For the first active cell, an 8-char key prefix must resolve back to it
// through the same resolver recall_cell uses (resolveCell from cell-context).
// An ambiguous prefix is a pass (reported in details.ambiguous), since
// ambiguity is a property of the key space, not a broken resolver. An empty
// store trivially passes: there is nothing to resolve.
function prefixResolution(name: string, store: Store, active: Cell[]): RecallEvalCaseResult {
  if (active.length === 0) {
    return {
      name,
      kind: "invariant",
      passed: true,
      score: 1,
      details: { checked: 0, trivial: true },
    };
  }
  const target = active[0]!;
  const prefix = target.key.slice(0, 8);
  try {
    const resolved = resolveCell(store, prefix);
    const passed = resolved !== undefined && resolved.key === target.key;
    return {
      name,
      kind: "invariant",
      passed,
      score: passed ? 1 : 0,
      details: { checked: 1, prefix, resolvedKey: resolved?.key },
    };
  } catch {
    // resolveCell throws when the prefix is ambiguous: still a pass, the
    // resolver behaved correctly, it just found more than one match.
    return {
      name,
      kind: "invariant",
      passed: true,
      score: 1,
      details: { checked: 1, prefix, ambiguous: true },
    };
  }
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface StoredEvalRun {
  id: string;
  name: string;
  result: RecallEvalResult;
  createdAt: string;
}

// Runs the suite, then records it to the eval_runs ledger when the store
// supports it (SqliteStore-only, feature-detected the same way
// programs.ts checks "recordProgramRun" in store).
export function runAndRecordEval(
  store: Store,
  suite: RecallEvalSuite = defaultEvalSuite(),
  now: Date = new Date(),
): RecallEvalResult {
  const result = runRecallEval(store, suite, now);
  if ("recordEvalRun" in store) {
    (store as SqliteStore).recordEvalRun({
      id: randomUUID(),
      name: result.name,
      result,
      createdAt: result.createdAt,
    });
  }
  return result;
}

// id and createdAt are excluded so two runs with identical name/passed/score/
// cases collide on the same derivation key: an unchanged eval outcome is the
// same derivation, not a new one each time it happens to be run again.
export function evalResultDerivationKey(result: RecallEvalResult): string {
  return derivationHash("eval_run", {
    name: result.name,
    passed: result.passed,
    score: result.score,
    cases: result.cases,
  });
}

export function evalResultToProposal(
  result: RecallEvalResult,
  opts: { project?: string; tenant?: string } = {},
): WriteProposal {
  return {
    kind: "ver",
    title: `Eval ${result.name}: ${result.passed ? "passed" : "failed"} (score ${result.score})`,
    body: stableJson(result),
    // MAL confidence must sit in (0, 1]; a zero score maps to the floor 0.05
    // rather than to 0, which admission would reject outright.
    confidence: Math.max(0.05, result.score),
    owner: "eval:recall",
    origin: "program",
    verification: "tested",
    topics: ["eval", "verification"],
    stability: "volatile",
    project: opts.project,
    tenant: opts.tenant,
  };
}

export function runEvalAndDerive(
  store: Store,
  suite: RecallEvalSuite = defaultEvalSuite(),
  now: Date = new Date(),
): { result: RecallEvalResult; derived: AdmissionResult } {
  const result = runAndRecordEval(store, suite, now);
  const key = evalResultDerivationKey(result);
  const proposal = evalResultToProposal(result);
  const derived = deriveAdmit(store, proposal, key, now.toISOString());
  return { result, derived };
}
