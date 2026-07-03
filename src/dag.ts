import type { DagOverlay, DagOverlayEdge } from "./types.js";

// Witness that a node pair is reachable via structurally different paths
// (different edge-label signatures). This is a signal, not a defect: it
// flags places where the overlay's story about how A leads to B is not
// singular, so a reader should look closer before trusting one path.
export interface DagHolonomyWitness {
  from: string;
  to: string;
  pathCount: number;
  signatures: string[];
  concern: number;
}

export interface DagAnalysis {
  overlayId: string;
  isDag: boolean;
  topologicalOrder: string[];
  cycles: string[][];
  witnesses: DagHolonomyWitness[];
}

export function analyzeDagOverlay(overlay: DagOverlay): DagAnalysis {
  const nodes = new Set(overlay.nodeIds);
  for (const edge of overlay.edges) {
    nodes.add(edge.source);
    nodes.add(edge.target);
  }

  const outgoing = new Map<string, DagOverlayEdge[]>();
  const incomingCount = new Map<string, number>();
  for (const node of nodes) {
    outgoing.set(node, []);
    incomingCount.set(node, 0);
  }
  for (const edge of overlay.edges) {
    outgoing.get(edge.source)!.push(edge);
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
  }

  // Kahn's algorithm with a sorted ready queue: the order in which zero
  // in-degree nodes become ready is not otherwise deterministic, so the
  // queue is re-sorted on every push to keep topologicalOrder stable.
  const queue = [...nodes].filter((node) => (incomingCount.get(node) ?? 0) === 0).sort();
  const topologicalOrder: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    topologicalOrder.push(node);
    for (const edge of outgoing.get(node) ?? []) {
      const next = (incomingCount.get(edge.target) ?? 0) - 1;
      incomingCount.set(edge.target, next);
      if (next === 0) {
        queue.push(edge.target);
        queue.sort();
      }
    }
  }

  const isDag = topologicalOrder.length === nodes.size;
  return {
    overlayId: overlay.id,
    isDag,
    topologicalOrder: isDag ? topologicalOrder : [],
    cycles: isDag ? [] : findCycles([...nodes], outgoing),
    witnesses: isDag ? holonomyWitnesses([...nodes], outgoing) : [],
  };
}

function holonomyWitnesses(nodes: string[], outgoing: Map<string, DagOverlayEdge[]>): DagHolonomyWitness[] {
  const witnesses: DagHolonomyWitness[] = [];
  for (const from of nodes) {
    const paths = collectPaths(from, outgoing, 6);
    const grouped = new Map<string, string[]>();
    for (const path of paths) {
      if (path.nodes.length < 2) {
        continue;
      }
      const to = path.nodes[path.nodes.length - 1]!;
      const key = `${from}->${to}`;
      const values = grouped.get(key) ?? [];
      values.push(path.labels.join("/"));
      grouped.set(key, values);
    }
    for (const [key, signatures] of grouped) {
      const unique = [...new Set(signatures)];
      if (signatures.length > 1 && unique.length > 1) {
        const [, to] = key.split("->");
        witnesses.push({
          from,
          to: to!,
          pathCount: signatures.length,
          signatures: unique.sort(),
          concern: Math.min(1, unique.length / Math.max(2, signatures.length)),
        });
      }
    }
  }
  return witnesses.sort((a, b) => b.concern - a.concern);
}

function collectPaths(
  start: string,
  outgoing: Map<string, DagOverlayEdge[]>,
  maxDepth: number,
): { nodes: string[]; labels: string[] }[] {
  const results: { nodes: string[]; labels: string[] }[] = [];
  const visit = (node: string, nodes: string[], labels: string[]): void => {
    results.push({ nodes, labels });
    if (labels.length >= maxDepth) {
      return;
    }
    for (const edge of outgoing.get(node) ?? []) {
      if (nodes.includes(edge.target)) {
        continue;
      }
      visit(edge.target, [...nodes, edge.target], [...labels, edge.label ?? "edge"]);
    }
  };
  visit(start, [start], []);
  return results;
}

function findCycles(nodes: string[], outgoing: Map<string, DagOverlayEdge[]>): string[][] {
  const cycles: string[][] = [];
  const stack: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (node: string): void => {
    if (visiting.has(node)) {
      const index = stack.indexOf(node);
      cycles.push(stack.slice(index).concat(node));
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visiting.add(node);
    stack.push(node);
    for (const edge of outgoing.get(node) ?? []) {
      visit(edge.target);
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of nodes) {
    visit(node);
  }
  return cycles;
}
