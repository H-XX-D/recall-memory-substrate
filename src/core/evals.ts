import { compileContext } from "./context-compiler.js";
import type { RecallStore, SubgraphFilter } from "./store.js";

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
      invariant: "prefix-resolution";
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
      {
        name: "id-prefix resolution invariant",
        kind: "invariant",
        invariant: "prefix-resolution"
      }
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
      if (testCase.invariant === "prefix-resolution") {
        const { passed, details } = checkPrefixResolution(store);
        return result(testCase, passed, details);
      }
      return result(testCase, false, { error: `unknown invariant: ${testCase.invariant}` });
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

// Invariant: every id-keyed lookup resolves a unique truncated id-prefix to its
// full row (cells via getNodeByPrefix; hyperedges/programs/program-runs/eval-runs/
// operator-runs via their getters). Samples the most-recent row of each entity
// that has data and checks its 8-char prefix expands back to the full id; entities
// with no rows are skipped (vacuously fine). Pure, deterministic, model-free — so a
// regression of this class is caught by `recall eval run` without an LLM noticing.
function checkPrefixResolution(store: RecallStore): { passed: boolean; details: Record<string, unknown> } {
  const checked: string[] = [];
  const failed: string[] = [];
  const probe = (label: string, id: string | undefined, get: (prefix: string) => { id: string } | null): void => {
    if (typeof id !== "string" || id.length < 9) return;
    checked.push(label);
    const resolved = get(id.slice(0, 8));
    if (!resolved || resolved.id !== id) {
      failed.push(label);
    }
  };
  probe("node", store.listNodes(1)[0]?.id, (p) => store.getNodeByPrefix(p));
  probe("hyperedge", store.listHyperedges(1)[0]?.id, (p) => store.getHyperedge(p));
  probe("program", store.listPrograms(1)[0]?.id, (p) => store.getProgram(p));
  probe("program_run", store.listProgramRuns(1)[0]?.id, (p) => store.getProgramRun(p));
  probe("eval_run", store.listEvalRuns(1)[0]?.id, (p) => store.getEvalRun(p));
  probe("operator_run", store.listOperatorRuns(1)[0]?.id, (p) => store.getOperatorRun(p));
  return { passed: failed.length === 0, details: { checked, failed } };
}

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
