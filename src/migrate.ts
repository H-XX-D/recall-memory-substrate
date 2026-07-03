import { buildCell } from "./build.js";
import type { Cell, Kind } from "./types.js";

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
  const confidence = typeof conf.value === "number" && conf.value > 0 && conf.value <= 1 ? conf.value : 0.5;

  // Start from a proposal so buildCell fills scores/handle/defaults, then
  // overwrite the identity/time/status/props fields that migration must preserve.
  const cell = buildCell(
    {
      kind: mapKind(row.kind),
      title: row.title || "(untitled)",
      body: row.body ?? "",
      confidence,
      summary: row.summary ?? undefined,
      topics: (tags.topics as string[]) ?? [],
      entities: (tags.entities as string[]) ?? [],
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
