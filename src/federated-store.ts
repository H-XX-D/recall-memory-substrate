// R5 federated read store: a read-only union across home/project locals.
//
// Each member keeps its local trust graph intact. The union only prefixes stable
// keys and edge endpoints with a graph slug so callers can traverse without
// accidentally mixing domains.
import { existsSync } from "node:fs";
import { SqliteStore } from "./store.js";
import type { Cell, Edge, Hyperedge, HyperedgeMember, Kind, NeighborLink, SearchHit, SemanticVector, Store, StoreStats } from "./types.js";

export const FEDERATED_READ_ONLY_MESSAGE =
  "federated read store is read-only; route writes to a home or project local";

export type FederatedMember =
  | { graph: string; store: Store; ownsStore?: boolean }
  | { graph: string; path: string };

interface OpenMember {
  graph: string;
  store: Store;
  ownsStore: boolean;
}

export function encodeFederatedKey(graph: string, key: string): string {
  return `${graph}:${key}`;
}

export function decodeFederatedKey(value: string): { graph?: string; key: string } {
  const idx = value.indexOf(":");
  if (idx < 0) return { key: value };
  return { graph: value.slice(0, idx), key: value.slice(idx + 1) };
}

export class FederatedReadStore implements Store {
  private readonly members: OpenMember[] = [];
  private readonly byGraph = new Map<string, OpenMember>();

  constructor(members: FederatedMember[]) {
    for (const member of members) {
      const graph = cleanGraph(member.graph);
      if ("store" in member) {
        this.addMember({ graph, store: member.store, ownsStore: member.ownsStore ?? false });
      } else if (member.path === ":memory:" || existsSync(member.path)) {
        this.addMember({ graph, store: new SqliteStore(member.path), ownsStore: true });
      }
    }
  }

  put(_cell: Cell): void {
    throw new Error(FEDERATED_READ_ONLY_MESSAGE);
  }

  get(key: string): Cell | undefined {
    return this.lookupByKey(key, (store, bare) => store.get(bare));
  }

  getByHandle(handle: string): Cell | undefined {
    return this.lookupByKey(handle, (store, bare) => store.getByHandle(bare));
  }

  all(): Cell[] {
    return this.members.flatMap((member) => member.store.all().map((cell) => prefixCell(member.graph, cell)));
  }

  active(): Cell[] {
    return this.members.flatMap((member) => member.store.active().map((cell) => prefixCell(member.graph, cell)));
  }

  neighbors(key: string): NeighborLink[] {
    const { graph, key: bareKey } = decodeFederatedKey(key);
    if (graph !== undefined) {
      const member = this.byGraph.get(graph);
      return member ? prefixLinks(graph, member.store.neighbors(bareKey)) : [];
    }

    for (const member of this.members) {
      if (member.store.get(key)) {
        return prefixLinks(member.graph, member.store.neighbors(key));
      }
    }
    return [];
  }

  findByContentKey(kind: Kind, contentKey: string): Cell | undefined {
    for (const member of this.members) {
      const cell = member.store.findByContentKey(kind, contentKey);
      if (cell) return prefixCell(member.graph, cell);
    }
    return undefined;
  }

  search(query: string, opts: { limit?: number } = {}): SearchHit[] {
    const limit = opts.limit ?? 10;
    if (limit <= 0) return [];

    const hits: SearchHit[] = [];
    for (const member of this.members) {
      for (const hit of member.store.search(query, { limit })) {
        hits.push({ ...hit, cell: prefixCell(member.graph, hit.cell) });
      }
    }
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        b.cell.updatedAt.localeCompare(a.cell.updatedAt) ||
        a.cell.key.localeCompare(b.cell.key),
    );
    return hits.slice(0, limit);
  }

  putSemanticVector(_v: SemanticVector): void {
    throw new Error(FEDERATED_READ_ONLY_MESSAGE);
  }

  getSemanticVector(nodeId: string): SemanticVector | undefined {
    const { graph, key } = decodeFederatedKey(nodeId);
    if (graph !== undefined) {
      const member = this.byGraph.get(graph);
      return member ? member.store.getSemanticVector(key) : undefined;
    }
    for (const member of this.members) {
      const v = member.store.getSemanticVector(nodeId);
      if (v) return v;
    }
    return undefined;
  }

  listSemanticVectorIds(): string[] {
    return this.members.flatMap((member) =>
      member.store.listSemanticVectorIds().map((id) => encodeFederatedKey(member.graph, id)),
    );
  }

  putHyperedge(_h: Hyperedge): void {
    throw new Error(FEDERATED_READ_ONLY_MESSAGE);
  }

  getHyperedge(id: string): Hyperedge | undefined {
    const { graph, key } = decodeFederatedKey(id);
    if (graph !== undefined) {
      const member = this.byGraph.get(graph);
      const hyperedge = member ? member.store.getHyperedge(key) : undefined;
      return hyperedge && member ? prefixHyperedge(member.graph, hyperedge) : undefined;
    }

    for (const member of this.members) {
      const hyperedge = member.store.getHyperedge(id);
      if (hyperedge) return prefixHyperedge(member.graph, hyperedge);
    }
    return undefined;
  }

  listHyperedges(limit = 100): Hyperedge[] {
    const all = this.members.flatMap((member) =>
      member.store.listHyperedges(limit).map((h) => prefixHyperedge(member.graph, h)),
    );
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return all.slice(0, limit);
  }

  hyperedgesForCell(key: string, limit = 50): Hyperedge[] {
    const { graph, key: bareKey } = decodeFederatedKey(key);
    if (graph !== undefined) {
      const member = this.byGraph.get(graph);
      const hyperedges = member ? member.store.hyperedgesForCell(bareKey, limit) : [];
      return member ? hyperedges.map((h) => prefixHyperedge(member.graph, h)) : [];
    }

    const all = this.members.flatMap((member) =>
      member.store.hyperedgesForCell(key, limit).map((h) => prefixHyperedge(member.graph, h)),
    );
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return all.slice(0, limit);
  }

  lexicalBackend(): "federated" {
    return "federated";
  }

  stats(): StoreStats {
    return this.members.reduce<StoreStats>(
      (sum, member) => {
        const stats = member.store.stats();
        return {
          cells: sum.cells + stats.cells,
          activeCells: sum.activeCells + stats.activeCells,
          edges: sum.edges + stats.edges,
          indexedCells: sum.indexedCells + stats.indexedCells,
          lexicalBackend: "federated",
        };
      },
      { cells: 0, activeCells: 0, edges: 0, indexedCells: 0, lexicalBackend: "federated" },
    );
  }

  close(): void {
    for (const member of this.members) {
      if (member.ownsStore) member.store.close();
    }
  }

  private addMember(member: OpenMember): void {
    if (this.byGraph.has(member.graph)) {
      throw new Error(`duplicate federated graph: ${member.graph}`);
    }
    this.members.push(member);
    this.byGraph.set(member.graph, member);
  }

  private lookupByKey(value: string, lookup: (store: Store, bare: string) => Cell | undefined): Cell | undefined {
    const { graph, key } = decodeFederatedKey(value);
    if (graph !== undefined) {
      const member = this.byGraph.get(graph);
      const cell = member ? lookup(member.store, key) : undefined;
      return cell && member ? prefixCell(member.graph, cell) : undefined;
    }

    for (const member of this.members) {
      const cell = lookup(member.store, value);
      if (cell) return prefixCell(member.graph, cell);
    }
    return undefined;
  }
}

function cleanGraph(graph: string): string {
  const trimmed = graph.trim();
  if (trimmed === "" || trimmed.includes(":")) {
    throw new Error(`invalid federated graph: ${graph}`);
  }
  return trimmed;
}

function prefixLinks(graph: string, links: NeighborLink[]): NeighborLink[] {
  return links.map((link) => ({
    edge: prefixEdge(graph, link.edge),
    cell: prefixCell(graph, link.cell),
    direction: link.direction,
  }));
}

function prefixCell(graph: string, cell: Cell): Cell {
  return {
    ...cell,
    key: prefixBare(graph, cell.key),
    edgesOut: cell.edgesOut.map((edge) => prefixEdge(graph, edge)),
    lineage: cell.lineage.map((key) => prefixBare(graph, key)),
    programs: cell.programs.map((key) => prefixBare(graph, key)),
  };
}

function prefixEdge(graph: string, edge: Edge): Edge {
  return {
    ...edge,
    source: prefixBare(graph, edge.source),
    target: prefixBare(graph, edge.target),
  };
}

function prefixBare(graph: string, key: string): string {
  return key.includes(":") ? key : encodeFederatedKey(graph, key);
}

function prefixHyperedge(graph: string, hyperedge: Hyperedge): Hyperedge {
  return {
    ...hyperedge,
    members: hyperedge.members.map((m) => prefixHyperedgeMember(graph, m)),
  };
}

function prefixHyperedgeMember(graph: string, member: HyperedgeMember): HyperedgeMember {
  return { ...member, key: prefixBare(graph, member.key) };
}
