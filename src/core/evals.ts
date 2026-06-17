import { compileContext } from "./context-compiler.js";
import { calibrationFactors, effectiveConfidence } from "./evidence.js";
import { cellReferenceTarget } from "./references.js";
import type { RecallStore, SubgraphFilter } from "./store.js";
import { TRUST_RELATION_KINDS } from "./types.js";

// Model-free structural self-audits of the substrate's own guarantees. Each is
// deterministic and read-only, so `recall eval run` audits the floor with no
// LLM in the loop. First-class + extensible: add a checker here and a case to
// defaultEvalSuite, and the regression becomes self-catching.
export type RecallEvalInvariant =
  | "prefix-resolution"
  | "relation-targets-resolve"
  | "address-id-consistency"
  | "effective-confidence-bounds"
  | "depends-on-acyclic";

export interface RecallEvalSuite {
  name: string;
  cases: RecallEvalCase[];
}

export type RecallEvalCase =
  | {
      name: string;
      kind: "search" | "semantic";
      query: string;
      expectContains?: string;
      minResults?: number;
    }
  | {
      name: string;
      kind: "compile";
      task: string;
      expectContains?: string;
      maxWords?: number;
    }
  | {
      name: string;
      kind: "subgraph";
      filter: SubgraphFilter;
      minResults?: number;
    }
  | {
      // Deterministic structural self-check (no model, no query): asserts a
      // model-independent invariant of the store holds on the live graph.
      name: string;
      kind: "invariant";
      invariant: RecallEvalInvariant;
    };

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

export function defaultEvalSuite(): RecallEvalSuite {
  return {
    name: "recall-default",
    cases: [
      {
        name: "lexical self recall",
        kind: "search",
        query: "Recall memory schema",
        minResults: 0
      },
      {
        name: "semantic self recall",
        kind: "semantic",
        query: "active memory graph",
        minResults: 0
      },
      {
        name: "context compiler returns packet",
        kind: "compile",
        task: "Use Recall memory for a coding task",
        maxWords: 900
      },
      { name: "invariant: id-prefix resolution", kind: "invariant", invariant: "prefix-resolution" },
      { name: "invariant: relation targets resolve", kind: "invariant", invariant: "relation-targets-resolve" },
      { name: "invariant: address/id consistency", kind: "invariant", invariant: "address-id-consistency" },
      { name: "invariant: effective-confidence bounds", kind: "invariant", invariant: "effective-confidence-bounds" },
      { name: "invariant: depends_on acyclic", kind: "invariant", invariant: "depends-on-acyclic" }
    ]
  };
}

export function runRecallEval(store: RecallStore, suite: RecallEvalSuite = defaultEvalSuite(), now = new Date()): RecallEvalResult {
  const cases = suite.cases.map((testCase) => runCase(store, testCase));
  const score = cases.length === 0 ? 1 : cases.reduce((sum, item) => sum + item.score, 0) / cases.length;
  return {
    name: suite.name,
    passed: cases.every((item) => item.passed),
    score: round(score),
    cases,
    createdAt: now.toISOString()
  };
}

function runCase(store: RecallStore, testCase: RecallEvalCase): RecallEvalCaseResult {
  switch (testCase.kind) {
    case "search": {
      const results = store.search(testCase.query, 20);
      const text = JSON.stringify(results);
      return result(testCase, matches(text, results.length, testCase.expectContains, testCase.minResults), {
        query: testCase.query,
        resultCount: results.length
      });
    }
    case "semantic": {
      const results = store.semanticSearch(testCase.query, 20);
      const text = JSON.stringify(results);
      return result(testCase, matches(text, results.length, testCase.expectContains, testCase.minResults), {
        query: testCase.query,
        resultCount: results.length,
        topScore: results[0]?.score ?? 0
      });
    }
    case "subgraph": {
      const results = store.subgraph(testCase.filter);
      const passed = results.length >= (testCase.minResults ?? 0);
      return result(testCase, passed, {
        filter: testCase.filter,
        resultCount: results.length
      });
    }
    case "invariant": {
      const check = INVARIANTS[testCase.invariant];
      if (!check) {
        return result(testCase, false, { error: `unknown invariant: ${testCase.invariant}` });
      }
      const { passed, details } = check(store);
      return result(testCase, passed, details);
    }
    case "compile": {
      const packet = compileContext(store, { task: testCase.task, budgetWords: testCase.maxWords ?? 900 });
      const text = JSON.stringify(packet);
      const passed =
        (testCase.expectContains ? text.includes(testCase.expectContains) : true) &&
        packet.wordCount <= (testCase.maxWords ?? 900);
      return result(testCase, passed, {
        task: testCase.task,
        wordCount: packet.wordCount,
        memoryItems:
          packet.relevantMemory.length +
          packet.activeBeliefs.length +
          packet.conflicts.length +
          packet.risks.length +
          packet.tasks.length
      });
    }
  }
}

type InvariantResult = { passed: boolean; details: Record<string, unknown> };

// First-class registry of model-free structural self-audits. Each samples the
// live graph (bounded reads) and asserts a guarantee the substrate is supposed
// to hold by construction.
const INVARIANTS: Record<RecallEvalInvariant, (store: RecallStore) => InvariantResult> = {
  // Every id-keyed lookup resolves a unique truncated id-prefix to its full row.
  // Samples the most-recent row of each entity with data; empty entities skip.
  "prefix-resolution": (store) => {
    const checked: string[] = [];
    const failed: string[] = [];
    const probe = (label: string, id: string | undefined, get: (prefix: string) => { id: string } | null): void => {
      if (typeof id !== "string" || id.length < 9) return;
      checked.push(label);
      const resolved = get(id.slice(0, 8));
      if (!resolved || resolved.id !== id) failed.push(label);
    };
    probe("node", store.listNodes(1)[0]?.id, (p) => store.getNodeByPrefix(p));
    probe("hyperedge", store.listHyperedges(1)[0]?.id, (p) => store.getHyperedge(p));
    probe("program", store.listPrograms(1)[0]?.id, (p) => store.getProgram(p));
    probe("program_run", store.listProgramRuns(1)[0]?.id, (p) => store.getProgramRun(p));
    probe("eval_run", store.listEvalRuns(1)[0]?.id, (p) => store.getEvalRun(p));
    probe("operator_run", store.listOperatorRuns(1)[0]?.id, (p) => store.getOperatorRun(p));
    return { passed: failed.length === 0, details: { checked, failed } };
  },

  // Trust-bearing edges (supports/contradicts/concerns) feed effective
  // confidence, so a dangling one is a phantom that skews the math — the system
  // drops dangling trust edges, so they must always resolve to a real node.
  // depends_on is lineage/provenance and may legitimately reference a cell that
  // was rolled back or never re-derived, so it is deliberately excluded.
  "relation-targets-resolve": (store) => {
    const TRUST = new Set<string>(TRUST_RELATION_KINDS);
    const relations = store.listRelations(undefined, "both", 2000).filter((r) => TRUST.has(r.kind));
    let dangling = 0;
    const danglingTargets: string[] = [];
    for (const relation of relations) {
      const target = cellReferenceTarget(relation.targetId);
      if (!store.getNode(relation.sourceId) || !store.getNode(target)) {
        dangling += 1;
        if (danglingTargets.length < 5) danglingTargets.push(`${relation.kind}:${relation.targetId}`);
      }
    }
    return { passed: dangling === 0, details: { trustRelations: relations.length, dangling, danglingTargets } };
  },

  // Every node's cellAddress ends in its own id — the addressable-cell guarantee
  // that lets address handles and id lookups agree.
  "address-id-consistency": (store) => {
    const nodes = store.listNodes(1000);
    const mismatched = nodes.filter((node) => !node.cellAddress || !node.cellAddress.endsWith(node.id)).length;
    return { passed: mismatched === 0, details: { nodes: nodes.length, mismatched } };
  },

  // Effective confidence stays in [0,1] for every active node (no NaN/overflow
  // from the support/challenge arithmetic).
  "effective-confidence-bounds": (store) => {
    const nodes = store.listNodes(1000).filter((node) => node.status === "active");
    const factors = calibrationFactors(store);
    const outOfBounds = nodes.filter((node) => {
      const eff = effectiveConfidence(store, node, factors).effective;
      return !(Number.isFinite(eff) && eff >= 0 && eff <= 1);
    }).length;
    return { passed: outOfBounds === 0, details: { nodes: nodes.length, outOfBounds } };
  },

  // depends_on must be a DAG: a cell transitively depending on itself is graph
  // corruption. Cycle-detect via DFS over depends_on edges.
  "depends-on-acyclic": (store) => {
    const adjacency = new Map<string, string[]>();
    for (const relation of store.listRelations(undefined, "both", 4000)) {
      if (relation.kind !== "depends_on") continue;
      const target = cellReferenceTarget(relation.targetId);
      (adjacency.get(relation.sourceId) ?? adjacency.set(relation.sourceId, []).get(relation.sourceId)!).push(target);
    }
    const WHITE = 0, GREY = 1, BLACK = 2;
    const color = new Map<string, number>();
    let cycle = false;
    const visit = (node: string): void => {
      color.set(node, GREY);
      for (const next of adjacency.get(node) ?? []) {
        const c = color.get(next) ?? WHITE;
        if (c === GREY) { cycle = true; return; }
        if (c === WHITE) { visit(next); if (cycle) return; }
      }
      color.set(node, BLACK);
    };
    for (const node of adjacency.keys()) {
      if ((color.get(node) ?? WHITE) === WHITE) visit(node);
      if (cycle) break;
    }
    return { passed: !cycle, details: { dependsOnNodes: adjacency.size, cycle } };
  }
};

function matches(text: string, count: number, expectContains: string | undefined, minResults: number | undefined): boolean {
  return count >= (minResults ?? 0) && (expectContains === undefined || text.includes(expectContains));
}

function result(testCase: RecallEvalCase, passed: boolean, details: Record<string, unknown>): RecallEvalCaseResult {
  return {
    name: testCase.name,
    kind: testCase.kind,
    passed,
    score: passed ? 1 : 0,
    details
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
