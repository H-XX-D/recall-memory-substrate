// R9 maintenance pass: a single composed sweep over the four existing
// engines (operator tick, eval, memory health, semantic reindex), run either
// against the routed store or, via maintainAll, against every local graph
// (home plus every registered project) in one call. This is composition
// only: no new engine logic lives here.
//
// Per-leg error capture: each of the four legs runs in its own try/catch. A
// failing leg records `{ error: string }` in that leg's result slot instead
// of the leg's normal shape, and the pass continues to the next leg. A
// maintenance pass must not die halfway: a broken eval suite should not
// prevent the operator tick, health witness, or reindex from running.
import { resolve } from "node:path";
import { analyzeMemory, memoryHealthToProposal } from "./analysis.js";
import { memoryHealthDerivationKey, deriveAdmit } from "./derivation.js";
import { defaultEvalSuite, runEvalAndDerive } from "./evals.js";
import { runOperatorCycle } from "./operator.js";
import { localGraphPaths } from "./routing.js";
import { reindexSemantic } from "./semantic.js";
import { SqliteStore } from "./store.js";
import type { AdmissionResult } from "./types.js";

export interface MaintainOperatorLeg {
  ticked: number;
  programRuns: number;
  derivedAccepted: number;
  ledgerId?: string;
}

export interface MaintainEvalLeg {
  passed: boolean;
  score: number;
  duplicateOf?: string;
}

export interface MaintainHealthLeg {
  accepted: boolean;
  duplicateOf?: string;
}

export interface MaintainResult {
  graph: string;
  dbPath: string;
  operator: MaintainOperatorLeg | { error: string };
  eval: MaintainEvalLeg | { error: string };
  health: MaintainHealthLeg | { error: string };
  reindexed: number;
}

// Runs the fixed engine order (operator -> eval -> health -> reindex) over a
// single store, each leg isolated so one engine's failure cannot prevent the
// others from running. reindexed defaults to 0 when its own leg throws,
// since MaintainResult declares it as a plain number, not an error union
// (the reindex leg has no other structured output to fall back to).
export function maintainStore(store: SqliteStore, graph: string, now: Date): MaintainResult {
  const nowIso = now.toISOString();

  let operator: MaintainResult["operator"];
  try {
    const cycle = runOperatorCycle(store, nowIso, { derive: true });
    const derivedAccepted = cycle.programs.derived.filter((d) => d.accepted && !d.duplicateOf).length;
    operator = {
      ticked: cycle.ticked,
      programRuns: cycle.programs.runs.length,
      derivedAccepted,
      ledgerId: cycle.ledger?.id,
    };
  } catch (error) {
    operator = { error: errorMessage(error) };
  }

  let evalLeg: MaintainResult["eval"];
  try {
    const { result, derived } = runEvalAndDerive(store, defaultEvalSuite(), now);
    evalLeg = {
      passed: result.passed,
      score: result.score,
      duplicateOf: derived.duplicateOf,
    };
  } catch (error) {
    evalLeg = { error: errorMessage(error) };
  }

  let health: MaintainResult["health"];
  try {
    const project = graph === "home" ? null : graph;
    const report = analyzeMemory(store, now);
    const proposal = memoryHealthToProposal(report, { project: project ?? undefined });
    const derived: AdmissionResult = deriveAdmit(store, proposal, memoryHealthDerivationKey(now, project), nowIso);
    health = { accepted: derived.accepted, duplicateOf: derived.duplicateOf };
  } catch (error) {
    health = { error: errorMessage(error) };
  }

  let reindexed = 0;
  try {
    reindexed = reindexSemantic(store, { onlyMissing: true });
  } catch {
    reindexed = 0;
  }

  return {
    graph,
    dbPath: store.path,
    operator,
    eval: evalLeg,
    health,
    reindexed,
  };
}

// Iterates localGraphPaths (home plus every registered project), deduped by
// resolved path, opening and closing a SqliteStore per graph. A single
// graph's store failing to open aborts the whole call (there is nothing
// meaningful to report for that graph without a store): the per-leg error
// capture inside maintainStore only covers the four engines, not the open
// itself.
export function maintainAll(env: NodeJS.ProcessEnv, now: Date): MaintainResult[] {
  const graphs = localGraphPaths(env);
  const seen = new Set<string>();
  const results: MaintainResult[] = [];
  for (const { graph, path } of graphs) {
    const resolved = resolve(path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const store = new SqliteStore(path);
    try {
      results.push(maintainStore(store, graph, now));
    } finally {
      store.close();
    }
  }
  return results;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
