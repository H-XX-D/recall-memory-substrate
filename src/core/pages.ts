import { analyzeMemory } from "./analysis.js";
import type { RecallStore, SubgraphFilter } from "./store.js";
import type { RecallNode } from "./types.js";

export type RecallPageName =
  | "index"
  | "reflections"
  | "agent-profile"
  | "user-profile"
  | "team-metrics"
  | "witnesses"
  | "workbench"
  | "handoffs"
  | "objectives"
  | "acp-queue"
  | "acp-manager";

export interface RecallPageOptions {
  project?: string;
  topic?: string;
  identity?: string;
  since?: string;
  limit?: number;
}

export interface RecallPageIndex {
  createdAt: string;
  stats: ReturnType<RecallStore["stats"]>;
  pages: Array<{
    name: RecallPageName;
    count: number;
    summary: string;
  }>;
  activeProjects: Array<{ project: string; count: number }>;
  activeTopics: Array<{ topic: string; count: number }>;
  plannerHint: string;
}

export interface RecallPage {
  name: RecallPageName;
  createdAt: string;
  filter: RecallPageOptions;
  summary: string;
  metrics: Record<string, unknown>;
  nodes: RecallNode[];
}

const PAGE_NAMES: RecallPageName[] = [
  "reflections",
  "agent-profile",
  "user-profile",
  "team-metrics",
  "witnesses",
  "workbench",
  "handoffs",
  "objectives",
  "acp-queue",
  "acp-manager"
];

export function buildPageIndex(store: RecallStore, now = new Date()): RecallPageIndex {
  const nodes = store.listNodes(2000).filter((node) => node.status === "active");
  const acpRequests = store.listAcpRequests(2000);
  const health = analyzeMemory(store, now);
  return {
    createdAt: now.toISOString(),
    stats: store.stats(),
    pages: PAGE_NAMES.map((name) => {
      if (name === "acp-queue" || name === "acp-manager") {
        const pageRequests = name === "acp-manager"
          ? acpRequests.filter((request) => request.toAgent === "recall-acp-manager")
          : acpRequests;
        return {
          name,
          count: pageRequests.length,
          summary: acpIndexSummary(name, pageRequests.length, health)
        };
      }
      const pageNodes = filterPageNodes(name, nodes, {});
      return {
        name,
        count: pageNodes.length,
        summary: pageSummary(name, pageNodes, health)
      };
    }),
    activeProjects: topProjectCounts(nodes.flatMap((node) => node.tags.project ?? node.tags.entities ?? []), 10),
    activeTopics: topTopicCounts(nodes.flatMap((node) => node.tags.topics ?? []), 10),
    plannerHint: health.curiosityTargets[0]?.suggestedAction ?? "continue normal LLM-managed memory write-back"
  };
}

export function getRecallPage(
  store: RecallStore,
  name: RecallPageName,
  options: RecallPageOptions = {},
  now = new Date()
): RecallPage {
  if (name === "index") {
    const index = buildPageIndex(store, now);
    return {
      name,
      createdAt: index.createdAt,
      filter: options,
      summary: "Recall page index.",
      metrics: { index },
      nodes: []
    };
  }

  const health = analyzeMemory(store, now);
  if (name === "acp-queue" || name === "acp-manager") {
    const requests = store.listAcpRequests(options.limit ?? 25);
    const managerRequests = name === "acp-manager"
      ? requests.filter((request) => request.toAgent === "recall-acp-manager")
      : requests;
    return {
      name,
      createdAt: now.toISOString(),
      filter: options,
      summary: name === "acp-manager"
        ? `${managerRequests.length} ACP request(s) routed to the internal graph manager.`
        : `${managerRequests.length} ACP request(s) in the queue.`,
      metrics: acpPageMetrics(name, managerRequests, health),
      nodes: []
    };
  }

  const nodes = filterPageNodes(name, filteredNodes(store, options), options).slice(0, options.limit ?? 25);
  return {
    name,
    createdAt: now.toISOString(),
    filter: options,
    summary: pageSummary(name, nodes, health),
    metrics: pageMetrics(name, nodes, health),
    nodes
  };
}

export function pageFilter(options: RecallPageOptions): SubgraphFilter {
  return {
    project: options.project ? [options.project] : undefined,
    topics: options.topic ? [options.topic] : undefined,
    identities: options.identity ? [options.identity] : undefined,
    limit: options.limit ?? 100
  };
}

function filteredNodes(store: RecallStore, options: RecallPageOptions): RecallNode[] {
  const hasTagFilter = Boolean(options.project || options.topic || options.identity);
  const nodes = hasTagFilter ? store.subgraph(pageFilter(options)) : store.listNodes(2000);
  const sinceTime = options.since ? Date.parse(options.since) : Number.NaN;
  return nodes.filter((node) => {
    if (node.status !== "active") {
      return false;
    }
    return Number.isNaN(sinceTime) || Date.parse(node.updatedAt) >= sinceTime;
  });
}

function filterPageNodes(name: RecallPageName, nodes: RecallNode[], options: RecallPageOptions): RecallNode[] {
  const filtered = nodes.filter((node) => {
    if (options.project && !(node.tags.project ?? []).includes(options.project)) {
      return false;
    }
    if (options.topic && !node.tags.topics.includes(options.topic)) {
      return false;
    }
    if (options.identity && !(node.tags.identities ?? []).includes(options.identity)) {
      return false;
    }
    switch (name) {
      case "reflections":
        return node.kind === "reflection" || hasTag(node, "type", "reflection");
      case "agent-profile":
        return node.kind === "identity" && hasAny(node, ["agent", "llm", "model", "assistant"]);
      case "user-profile":
        return node.kind === "identity" && hasAny(node, ["user", "human", "operator"]);
      case "team-metrics":
        return ["eval_run", "benchmark_run", "trust", "verification_result", "allocation_plan"].includes(node.kind);
      case "witnesses":
        return node.kind === "witness";
      case "workbench":
        return ["lemma", "conflict", "hypothesis", "blind_lock", "miss"].includes(node.kind);
      case "handoffs":
        return node.kind === "handoff" || node.kind === "checkpoint" || node.kind === "session" || hasAny(node, ["handoff", "continuity", "session"]);
      case "objectives":
        return ["objective", "goal", "task", "decision", "risk", "constraint", "question"].includes(node.kind);
      case "index":
        return true;
    }
  });
  return filtered.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function pageSummary(name: RecallPageName, nodes: RecallNode[], health: ReturnType<typeof analyzeMemory>): string {
  switch (name) {
    case "team-metrics":
      return `${nodes.length} metric cells; ${health.criticalWarnings.length} critical/trust warning(s).`;
    case "witnesses":
      return `${nodes.length} witness cells; provenance unknown ratio=${health.provenance.unknownOriginRatio}.`;
    case "workbench":
      return `${nodes.length} epistemic workbench cells for lemmas, conflicts, hypotheses, blind locks, and misses.`;
    case "objectives":
      return `${nodes.length} operational continuity cells for objectives, goals, tasks, decisions, risks, constraints, and questions.`;
    case "acp-queue":
      return `${nodes.length} ACP request(s) waiting on the internal graph manager.`;
    case "acp-manager":
      return `${nodes.length} ACP manager profile cell(s); manager pressure is handled by the ACP queue metrics.`;
    default:
      return `${nodes.length} ${name} cell(s).`;
  }
}

function acpIndexSummary(name: "acp-queue" | "acp-manager", count: number, health: ReturnType<typeof analyzeMemory>): string {
  if (name === "acp-manager") {
    return `${count} ACP request(s) routed to the internal manager; ${health.criticalWarnings.length} critical/trust warning(s).`;
  }
  return `${count} ACP request(s) waiting in the internal queue.`;
}

function acpPageMetrics(name: "acp-queue" | "acp-manager", requests: Array<{ action: string; status: string; channel: string; fromAgent: string; toAgent: string; processedAt: string | null; createdAt: string; }>, health: ReturnType<typeof analyzeMemory>): Record<string, unknown> {
  const byStatus = counts(requests.map((request) => request.status));
  const byAction = counts(requests.map((request) => request.action));
  const recent = requests.slice(0, 5).map((request) => ({
    action: request.action,
    status: request.status,
    channel: request.channel,
    fromAgent: request.fromAgent,
    toAgent: request.toAgent,
    createdAt: request.createdAt,
    processedAt: request.processedAt
  }));
  if (name === "acp-manager") {
    return {
      identity: "agent:acp-manager",
      manager: "recall-acp-manager",
      queuePressure: requests.filter((request) => request.status === "queued").length,
      byStatus,
      byAction,
      recent,
      memoryHealth: {
        warnings: health.criticalWarnings.length,
        stale: health.stale.length,
        contradictions: health.contradictions.length
      }
    };
  }
  return {
    byStatus,
    byAction,
    recent
  };
}

function pageMetrics(name: RecallPageName, nodes: RecallNode[], health: ReturnType<typeof analyzeMemory>): Record<string, unknown> {
  if (name === "team-metrics") {
    return {
      memoryHealth: {
        beliefPressure: health.beliefs.filter((belief) => belief.recommendation !== "trust").length,
        stale: health.stale.length,
        contradictions: health.contradictions.length,
        provenance: health.provenance,
        warnings: health.criticalWarnings
      },
      byKind: counts(nodes.map((node) => node.kind))
    };
  }
  return {
    byKind: counts(nodes.map((node) => node.kind)),
    byLifecycle: counts(nodes.flatMap((node) => node.tags.lifecycle ?? [])),
    newest: nodes[0]?.updatedAt ?? null
  };
}

function hasTag(node: RecallNode, family: keyof RecallNode["tags"], value: string): boolean {
  const tags = node.tags[family];
  return Array.isArray(tags) && tags.includes(value);
}

function hasAny(node: RecallNode, values: string[]): boolean {
  const text = JSON.stringify([node.kind, node.title, node.tags, node.scope]).toLowerCase();
  return values.some((value) => text.includes(value));
}

function topProjectCounts(values: string[], limit: number): Array<{ project: string; count: number }> {
  return Object.entries(counts(values))
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([project, count]) => ({ project, count }));
}

function topTopicCounts(values: string[], limit: number): Array<{ topic: string; count: number }> {
  return Object.entries(counts(values))
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([topic, count]) => ({ topic, count }));
}

function counts(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) {
    result[value] = (result[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
