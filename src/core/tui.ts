import type { RecallStore } from "./store.js";

export function renderTui(store: RecallStore): string {
  const stats = store.stats();
  const recent = store.listNodes(8);
  const rollback = store.listRollback(5);
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
    "",
    "Recent Cells",
    ...recent.map((node) => `  ${node.kind.padEnd(14)} ${truncate(node.title, 52)} ${node.cellAddress}`),
    ...(recent.length === 0 ? ["  none"] : []),
    "",
    "Rollback Journal",
    ...rollback.map((entry) => `  ${entry.action.padEnd(15)} ${entry.targetId} ${entry.createdAt}`),
    ...(rollback.length === 0 ? ["  none"] : []),
    "",
    "Controls",
    "  This TUI is read-only. Use CLI commands for rollback, daemon, evals, and explicit secret saves."
  ];
  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}
