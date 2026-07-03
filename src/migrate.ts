import { DatabaseSync } from "node:sqlite";
import { buildCell } from "./build.js";
import type { Cell, Edge, Kind, Relation } from "./types.js";
import { RELATIONS } from "./types.js";
import { SqliteStore } from "./store.js";
import { normalizeHyperedgeMembers } from "./hyperedges.js";

const KIND_MAP: Record<string, Kind> = {
  observation: "obs", verification_result: "ver", decision: "dec",
  reflection: "ref", lemma: "bel", risk: "rsk", task: "tsk",
  hypothesis: "hyp", preference: "bel", benchmark_run: "ver",
  checkpoint: "obs", objective: "obj", contradiction: "obs",
  meta: "obs", source: "ref", witness: "ver",
};

export function mapKind(old: string): Kind {
  return KIND_MAP[old] ?? "obs";
}

export interface OldNodeRow {
  id: string; cell_address: string | null; kind: string; title: string;
  body: string; summary: string | null; scope_json: string | null;
  tags_json: string | null; data_json: string | null; provenance_json: string | null;
  status: string; created_at: string; updated_at: string;
}

function parse(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try { return JSON.parse(json) as Record<string, unknown>; } catch { return {}; }
}

export function mapNodeToCell(row: OldNodeRow): Cell {
  const data = parse(row.data_json);
  const conf = (data.confidence ?? {}) as Record<string, unknown>;
  const pol = (data.policy ?? {}) as Record<string, unknown>;
  const tags = parse(row.tags_json);
  const scope = parse(row.scope_json);
  const prov = parse(row.provenance_json);
  const confidence = typeof conf.value === "number" && conf.value > 0 && conf.value <= 1
    ? conf.value
    : typeof conf.value === "number" && conf.value === 0
      ? 0.01
      : 0.5;

  // Start from a proposal so buildCell fills scores/handle/defaults, then
  // overwrite the identity/time/status/props fields that migration must preserve.
  const cell = buildCell(
    {
      kind: mapKind(row.kind),
      title: row.title || "(untitled)",
      body: row.body ?? "",
      confidence,
      summary: row.summary ?? undefined,
      topics: Array.isArray(tags.topics) ? (tags.topics as string[]) : [],
      entities: Array.isArray(tags.entities) ? (tags.entities as string[]) : [],
      sensitivity: (pol.sensitivity as "public" | "private" | "secret") ?? "private",
      project: (scope.project as string) ?? "default",
      tenant: (scope.tenant as string) ?? "default",
    },
    { key: row.id, now: row.created_at },
  );
  cell.updatedAt = row.updated_at || row.created_at;
  cell.status = row.status === "superseded" ? "superseded" : row.status === "annexed" ? "annexed" : "active";
  if (typeof conf.uncertainty === "number") cell.scores.uncertainty = conf.uncertainty;
  if (typeof conf.concern === "number") cell.scores.concern = conf.concern;
  cell.provenance.producedBy = (prov.produced_by as string) ?? cell.provenance.producedBy;
  cell.props = { ...cell.props, _migrated: { cell_address: row.cell_address, data_json: data, provenance_json: prov } };
  return cell;
}

const WEIGHT: Record<Relation, number> = {
  supports: 1, contradicts: -1, concerns: -0.5, depends_on: 0, supersedes: 0, derived_from: 0,
};

export interface OldRelationRow { source_id: string; target_id: string; kind: string }

export function mapRelationToEdge(row: OldRelationRow): Edge | null {
  if (!(RELATIONS as readonly string[]).includes(row.kind)) return null;
  const relation = row.kind as Relation;
  return { relation, source: row.source_id, target: row.target_id, weight: WEIGHT[relation] };
}

export interface MigrateResult {
  cells: number;
  edges: number;
  hyperedges: number;
  semanticVectors: number;
  dagOverlays: number;
  applied: boolean;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).all(name) as unknown as { name: string }[];
  return rows.length > 0;
}

export function migrate(
  oldDbPath: string,
  target: SqliteStore,
  opts: { apply?: boolean } = {},
): MigrateResult {
  const apply = opts.apply ?? false;
  const db = new DatabaseSync(oldDbPath, { readOnly: true });
  const res: MigrateResult = {
    cells: 0, edges: 0, hyperedges: 0, semanticVectors: 0, dagOverlays: 0, applied: apply,
  };

  // Build edge map from relations so they can be attached to each cell before put().
  const rels = tableExists(db, "graph_relations")
    ? db.prepare(`SELECT source_id, target_id, kind FROM graph_relations`).all() as unknown as OldRelationRow[]
    : [];
  const edgesBySource = new Map<string, Edge[]>();
  for (const r of rels) {
    const e = mapRelationToEdge(r);
    if (!e) continue;
    const list = edgesBySource.get(e.source) ?? [];
    list.push(e);
    edgesBySource.set(e.source, list);
    res.edges++;
  }

  const nodes = db.prepare(`SELECT * FROM graph_nodes`).all() as unknown as OldNodeRow[];
  for (const row of nodes) {
    res.cells++;
    if (!apply) continue;
    const cell = mapNodeToCell(row);
    cell.edgesOut = edgesBySource.get(cell.key) ?? [];
    target.put(cell);
  }

  type HyperedgeRow = { id: string; kind: string; title: string; members_json: string; metadata_json: string; created_at: string };
  const hes = tableExists(db, "hyperedges")
    ? db.prepare(`SELECT * FROM hyperedges`).all() as unknown as HyperedgeRow[]
    : [];
  for (const h of hes) {
    res.hyperedges++;
    if (apply) {
      target.putHyperedge({
        id: h.id, kind: h.kind, title: h.title,
        // legacy rows may hold plain keys or {nodeId, role, ordinal, ...}
        // objects; normalize both shapes through the same read-path mapper
        // instead of casting straight to string[].
        members: normalizeHyperedgeMembers(JSON.parse(h.members_json)),
        metadata: JSON.parse(h.metadata_json) as Record<string, unknown>,
        createdAt: h.created_at,
      });
    }
  }

  type SemanticRow = { node_id: string; backend: string; dims: number; vector_json: string; indexed_at: string };
  const vecs = tableExists(db, "semantic_index")
    ? db.prepare(`SELECT * FROM semantic_index`).all() as unknown as SemanticRow[]
    : [];
  for (const v of vecs) {
    res.semanticVectors++;
    if (apply) {
      target.putSemanticVector({
        nodeId: v.node_id, backend: v.backend, dims: v.dims,
        vector: JSON.parse(v.vector_json) as number[],
        indexedAt: v.indexed_at,
      });
    }
  }

  db.close();
  return res;
}
