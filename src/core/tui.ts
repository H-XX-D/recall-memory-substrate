import { analyzeMemory } from "./analysis.js";
import type { RecallStore } from "./store.js";

export function renderTui(store: RecallStore): string {
  const stats = store.stats();
  const recent = store.listNodes(8);
  const rollback = store.listRollback(5);
  const operatorRuns = store.listOperatorRuns(5);
  const acpRequests = store.listAcpRequests(5);
  const health = analyzeMemory(store);
  const lines = [
    "Recall TUI",
    "==========",
    "",
    "Overview",
    `  nodes:          ${stats.nodes}`,
    `  relations:      ${stats.relations}`,
    `  rollback:       ${stats.rollbackEntries}`,
    `  hyperedges:     ${stats.hyperedges ?? 0}`,
    `  programs:       ${stats.programs ?? 0}`,
    `  dag overlays:   ${stats.dagOverlays ?? 0}`,
    `  eval runs:      ${stats.evalRuns ?? 0}`,
    `  operator runs:  ${stats.operatorRuns ?? 0}`,
    `  acp requests:   ${stats.acpRequests ?? 0}`,
    "",
    "Memory Health",
    `  belief pressure: ${health.beliefs.filter((belief) => belief.recommendation !== "trust").length}`,
    `  stale/low trust: ${health.stale.length}`,
    `  contradictions: ${health.contradictions.length}`,
    `  next action:     ${truncate(health.nextActions[0] ?? "none", 72)}`,
    "",
    "Recent Cells",
    ...recent.map((node) => `  ${node.kind.padEnd(14)} ${truncate(node.title, 52)} ${node.cellAddress}`),
    ...(recent.length === 0 ? ["  none"] : []),
    "",
    "Rollback Journal",
    ...rollback.map((entry) => `  ${entry.action.padEnd(15)} ${entry.targetId} ${entry.createdAt}`),
    ...(rollback.length === 0 ? ["  none"] : []),
    "",
    "Operator Runs",
    ...operatorRuns.map((run) => `  ${run.status.padEnd(8)} ${run.id} ${truncate(run.summary, 68)}`),
    ...(operatorRuns.length === 0 ? ["  none"] : []),
    "",
    "ACP Queue",
    ...acpRequests.map((request) => `  ${request.status.padEnd(10)} ${request.action.padEnd(16)} ${truncate(request.fromAgent, 18)} -> ${truncate(request.toAgent, 18)}`),
    ...(acpRequests.length === 0 ? ["  none"] : []),
    "",
    "Controls",
    "  This TUI is read-only. Use CLI commands for rollback, daemon, evals, ACP, and explicit secret saves."
  ];
  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}
