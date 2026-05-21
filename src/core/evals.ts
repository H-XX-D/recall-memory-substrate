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
      }
    ]
  };
}

export function runRecallEval(store: RecallStore, suite: RecallEvalSuite = defaultEvalSuite()): RecallEvalResult {
  const cases = suite.cases.map((testCase) => runCase(store, testCase));
  const score = cases.length === 0 ? 1 : cases.reduce((sum, item) => sum + item.score, 0) / cases.length;
  return {
    name: suite.name,
    passed: cases.every((item) => item.passed),
    score: round(score),
    cases,
    createdAt: new Date().toISOString()
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
