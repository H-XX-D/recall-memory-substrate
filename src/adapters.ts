// R6 adapters/import-export. External memories normalize to thin v5
// WriteProposals and enter through admission; portable archives preserve exact
// Cell JSON for backup/restore without inventing a second database format.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { admit } from "./admission.js";
import type { AdmissionResult, Cell, Kind, Store, WriteProposal } from "./types.js";

export const EXPORT_SCHEMA_VERSION = "recall.cells.export.v1";
export const MAX_IMPORT_BYTES = 134_217_728;
export const MAX_BODY_CHARS = 32_768;

export interface ImportItem {
  ref: string;
  sourceTag: string;
  fingerprint: string;
  proposal: (priorKeys: string[]) => WriteProposal;
  supersedesTags?: string[];
}

export interface ImportResultItem {
  ref: string;
  action: "create" | "supersede" | "skip";
  cellKey?: string;
  supersedes?: string[];
  reason?: string;
}

export interface ImportSummary {
  source: string;
  dryRun: boolean;
  created: number;
  superseded: number;
  skipped: number;
  items: ImportResultItem[];
}

export interface ImportedMemoryRecord {
  ref: string;
  source: string;
  title: string;
  body: string;
  kind?: Kind;
  summary?: string;
  confidence?: number;
  topics?: string[];
  entities?: string[];
  sourceRefs?: string[];
  createdAt?: string;
  project?: string;
  tenant?: string;
  owner?: string;
  sourceTag?: string;
  supersedesTags?: string[];
  props?: Record<string, unknown>;
}

export interface Mem0Memory {
  id?: string;
  content: string;
  categories: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ParsedAutoMemory {
  name?: string;
  description?: string;
  type?: string;
  body: string;
}

export interface DiscoveredAutoMemoryFile {
  slug: string;
  project: string;
  filePath: string;
}

export interface ZepFact {
  uuid?: string;
  fact: string;
  relation: string;
  source: string;
  target: string;
  validAt?: string;
  invalidAt?: string;
  createdAt?: string;
}

export interface RecallCellArchive {
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  exportedAt: string;
  stats: ReturnType<Store["stats"]>;
  cells: Cell[];
}

export interface ArchiveImportSummary {
  dryRun: boolean;
  imported: number;
  skipped: number;
  items: { key: string; action: "import" | "skip"; reason?: string }[];
}

export function readJsonFile(file: string, label = "json", maxBytes = MAX_IMPORT_BYTES): unknown {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    throw new Error(`${label}: cannot read file: ${file}`);
  }
  if (size > maxBytes) {
    throw new Error(`${label}: file too large (${size} bytes > ${maxBytes})`);
  }
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new Error(`${label}: file is not valid JSON: ${file}`);
  }
}

export function clampBody(text: string): string {
  return text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text;
}

export function importItems(
  store: Store,
  source: string,
  items: ImportItem[],
  opts: { apply?: boolean; now?: string } = {},
): ImportSummary {
  const apply = opts.apply ?? false;
  const now = opts.now ?? new Date().toISOString();
  const result: ImportResultItem[] = [];
  const admittedThisBatch = new Map<string, string>();
  let created = 0;
  let superseded = 0;
  let skipped = 0;

  for (const item of items) {
    if (findByFingerprint(store, item.fingerprint)) {
      skipped += 1;
      result.push({ ref: item.ref, action: "skip", reason: "unchanged" });
      continue;
    }

    const priorKeys = unique([
      ...findBySourceTags(store, [item.sourceTag, ...(item.supersedesTags ?? [])]).map((cell) => cell.key),
      ...(item.supersedesTags ?? []).flatMap((tag) => admittedThisBatch.get(tag) ?? []),
    ]);
    const proposal = item.proposal(priorKeys);
    const predicted = admit(proposal, { now });
    if (!predicted.accepted) {
      skipped += 1;
      result.push({
        ref: item.ref,
        action: "skip",
        reason: `rejected: ${predicted.issues[0]?.message ?? "admission"}`,
      });
      continue;
    }

    if (!apply) {
      if (priorKeys.length > 0) {
        superseded += 1;
        result.push({ ref: item.ref, action: "supersede", supersedes: priorKeys });
      } else {
        created += 1;
        result.push({ ref: item.ref, action: "create" });
      }
      admittedThisBatch.set(item.sourceTag, `dry-run:${item.ref}`);
      continue;
    }

    const admission = admit(proposal, { store, now });
    if (!admission.accepted || !admission.cell) {
      skipped += 1;
      result.push({
        ref: item.ref,
        action: "skip",
        reason: `rejected: ${admission.issues[0]?.message ?? "admission"}`,
      });
      continue;
    }
    admittedThisBatch.set(item.sourceTag, admission.cell.key);
    if (priorKeys.length > 0) {
      superseded += 1;
      result.push({ ref: item.ref, action: "supersede", cellKey: admission.cell.key, supersedes: priorKeys });
    } else {
      created += 1;
      result.push({ ref: item.ref, action: "create", cellKey: admission.cell.key });
    }
  }

  return { source, dryRun: !apply, created, superseded, skipped, items: result };
}

export function importedRecordToItem(record: ImportedMemoryRecord, now = new Date().toISOString()): ImportItem {
  const sourceTag = record.sourceTag ?? `${record.source}-src:${sha12(record.ref)}`;
  const fingerprint = `${record.source}:${sha12(record.ref)}:${sha12(record.body)}`;
  return {
    ref: record.ref,
    sourceTag,
    fingerprint,
    supersedesTags: record.supersedesTags,
    proposal: (priorKeys) => importedRecordToProposal(record, { sourceTag, fingerprint, priorKeys, now }),
  };
}

export function importedRecordToProposal(
  record: ImportedMemoryRecord,
  opts: { sourceTag: string; fingerprint: string; priorKeys: string[]; now: string },
): WriteProposal {
  const kind = record.kind ?? "obs";
  const title = record.title.trim() || titleFrom(record.body);
  const confidence = probability(record.confidence ?? 0.6, 0.6);
  return {
    kind,
    title,
    body: clampBody(record.body),
    summary: record.summary ?? title,
    confidence,
    owner: record.owner ?? `${record.source}-adapter`,
    topics: unique([record.source, "imported", ...(record.topics ?? [])]),
    entities: unique([opts.sourceTag, ...(record.entities ?? [])]),
    sourceRefs: unique([`${record.source}:${record.ref}`, ...(record.sourceRefs ?? [])]),
    edges: opts.priorKeys.map((target) => ({ relation: "supersedes", target })),
    project: record.project ?? "Recall",
    tenant: record.tenant ?? "local",
    origin: "connector",
    verification: "checked",
    sensitivity: "private",
    stability: "stable",
    props: {
      ...record.props,
      import: {
        source: record.source,
        ref: record.ref,
        sourceTag: opts.sourceTag,
        fingerprint: opts.fingerprint,
        importedAt: opts.now,
        createdAt: record.createdAt ?? null,
      },
    },
  };
}

export function parseMem0Export(json: unknown): Mem0Memory[] {
  return extractRows(json, ["memories", "results", "data"]).map((row) => {
    const rec = toRecord(row);
    const meta = toRecord(rec.metadata);
    const categories = stringArray(rec.categories);
    return {
      id: stringValue(rec.id),
      content: firstString(rec.memory, rec.content, rec.text) ?? "",
      categories: categories.length > 0 ? categories : stringArray(meta.categories),
      createdAt: stringValue(rec.created_at, rec.createdAt),
      updatedAt: stringValue(rec.updated_at, rec.updatedAt),
    };
  });
}

export function mem0ImportItems(json: unknown, opts: { project?: string; now?: string } = {}): {
  items: ImportItem[];
  preSkips: ImportResultItem[];
} {
  const project = opts.project ?? "Recall";
  const items: ImportItem[] = [];
  const preSkips: ImportResultItem[] = [];
  for (const mem of parseMem0Export(json)) {
    if (!mem.id) {
      preSkips.push({ ref: "(no id)", action: "skip", reason: "malformed: missing id" });
      continue;
    }
    if (mem.content.trim() === "") {
      preSkips.push({ ref: mem.id, action: "skip", reason: "empty" });
      continue;
    }
    items.push(
      importedRecordToItem(
        {
          ref: mem.id,
          source: "mem0",
          title: titleFrom(mem.content),
          body: mem.content,
          topics: mem.categories,
          entities: mem.id ? [`mem0-id:${mem.id}`] : [],
          createdAt: mem.createdAt,
          project,
        },
        opts.now,
      ),
    );
  }
  return { items, preSkips };
}

export function importMem0(
  store: Store,
  json: unknown,
  opts: { project?: string; apply?: boolean; now?: string } = {},
): ImportSummary {
  const { items, preSkips } = mem0ImportItems(json, opts);
  const summary = importItems(store, "mem0", items, opts);
  return {
    ...summary,
    skipped: summary.skipped + preSkips.length,
    items: [...preSkips, ...summary.items],
  };
}

export function parseAutoMemoryFile(content: string): ParsedAutoMemory {
  const text = content.replace(/\r\n/g, "\n");
  const fence = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!fence) return { body: text.trim() };
  const front: Record<string, string> = {};
  for (const line of fence[1]!.split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match && ["name", "description", "type"].includes(match[1]!)) {
      front[match[1]!] = match[2]!.trim().slice(0, 2000);
    }
  }
  return {
    name: front.name,
    description: front.description,
    type: front.type,
    body: text.slice(fence[0].length).trim(),
  };
}

export function discoverAutoMemoryFiles(root: string): DiscoveredAutoMemoryFile[] {
  if (!existsSync(root)) return [];
  const out: DiscoveredAutoMemoryFile[] = [];
  for (const slug of readdirSync(root)) {
    const slugDir = join(root, slug);
    if (!safeIsDir(slugDir)) continue;
    const memoryDir = join(slugDir, "memory");
    if (!safeIsDir(memoryDir)) continue;
    for (const entry of readdirSync(memoryDir)) {
      if (!entry.endsWith(".md") || entry === "MEMORY.md") continue;
      const filePath = join(memoryDir, entry);
      if (safeIsFile(filePath)) out.push({ slug, project: slug, filePath });
    }
  }
  return out.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

export function autoMemoryImportItems(root: string, opts: { project?: string; now?: string } = {}): {
  items: ImportItem[];
  preSkips: ImportResultItem[];
} {
  const items: ImportItem[] = [];
  const preSkips: ImportResultItem[] = [];
  for (const file of discoverAutoMemoryFiles(root)) {
    let size = 0;
    try {
      size = statSync(file.filePath).size;
    } catch {
      preSkips.push({ ref: file.filePath, action: "skip", reason: "unreadable" });
      continue;
    }
    if (size > 1_000_000) {
      preSkips.push({ ref: file.filePath, action: "skip", reason: `too-large (${size} bytes)` });
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(file.filePath, "utf8");
    } catch {
      preSkips.push({ ref: file.filePath, action: "skip", reason: "unreadable" });
      continue;
    }
    const parsed = parseAutoMemoryFile(raw);
    if (!parsed.name?.trim() && parsed.body.trim() === "") {
      preSkips.push({ ref: file.filePath, action: "skip", reason: "empty" });
      continue;
    }
    const title = parsed.name?.trim() || basename(file.filePath);
    items.push(
      importedRecordToItem(
        {
          ref: file.filePath,
          source: "auto-memory",
          title,
          body: parsed.body || parsed.description || title,
          summary: parsed.description ?? title,
          kind: autoMemoryKind(parsed.type),
          topics: ["auto-memory", parsed.type ?? "note"],
          entities: [opts.project ?? file.project],
          sourceRefs: [file.filePath],
          project: opts.project ?? file.project,
        },
        opts.now,
      ),
    );
  }
  return { items, preSkips };
}

export function importAutoMemory(
  store: Store,
  root: string,
  opts: { project?: string; apply?: boolean; now?: string } = {},
): ImportSummary {
  const { items, preSkips } = autoMemoryImportItems(root, opts);
  const summary = importItems(store, "auto-memory", items, opts);
  return {
    ...summary,
    skipped: summary.skipped + preSkips.length,
    items: [...preSkips, ...summary.items],
  };
}

export function parseZepExport(json: unknown): ZepFact[] {
  return extractRows(json, ["edges", "facts", "data"]).map((row) => {
    const rec = toRecord(row);
    return {
      uuid: stringValue(rec.uuid, rec.id),
      fact: firstString(rec.fact, rec.content) ?? "",
      relation: firstString(rec.name, rec.relation, rec.predicate) ?? "",
      source: firstString(rec.source_node, rec.source, rec.source_node_name) ?? "",
      target: firstString(rec.target_node, rec.target, rec.target_node_name) ?? "",
      validAt: stringValue(rec.valid_at, rec.validAt),
      invalidAt: stringValue(rec.invalid_at, rec.expired_at, rec.invalidAt),
      createdAt: stringValue(rec.created_at, rec.createdAt),
    };
  });
}

export function zepImportItems(json: unknown, opts: { project?: string; now?: string } = {}): {
  items: ImportItem[];
  preSkips: ImportResultItem[];
} {
  const project = opts.project ?? "Recall";
  const preSkips: ImportResultItem[] = [];
  const groups = new Map<string, ZepFact[]>();
  for (const fact of parseZepExport(json)) {
    if (!fact.uuid) {
      preSkips.push({ ref: "(no uuid)", action: "skip", reason: "malformed: missing uuid" });
      continue;
    }
    if (fact.fact.trim() === "") {
      preSkips.push({ ref: fact.uuid, action: "skip", reason: "empty" });
      continue;
    }
    const key = JSON.stringify([fact.source, fact.relation]);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(fact);
  }

  const items: ImportItem[] = [];
  for (const group of groups.values()) {
    group.sort(byZepTime);
    group.forEach((fact, index) => {
      const previous = group[index - 1];
      const sourceTag = `zep-src:${sha12(fact.uuid!)}`;
      const supersedesTags = previous?.invalidAt ? [`zep-src:${sha12(previous.uuid!)}`] : undefined;
      items.push(
        importedRecordToItem(
          {
            ref: fact.uuid!,
            source: "zep",
            sourceTag,
            title: titleFrom(fact.fact),
            body: fact.fact,
            topics: ["zep", fact.relation].filter(Boolean),
            entities: [fact.source, fact.target, `zep-uuid:${fact.uuid}`].filter(Boolean),
            createdAt: fact.validAt ?? fact.createdAt,
            project,
            supersedesTags,
            props: { zep: { relation: fact.relation, source: fact.source, target: fact.target, invalidAt: fact.invalidAt ?? null } },
          },
          opts.now,
        ),
      );
    });
  }
  return { items, preSkips };
}

export function importZep(
  store: Store,
  json: unknown,
  opts: { project?: string; apply?: boolean; now?: string } = {},
): ImportSummary {
  const { items, preSkips } = zepImportItems(json, opts);
  const summary = importItems(store, "zep", items, opts);
  return {
    ...summary,
    skipped: summary.skipped + preSkips.length,
    items: [...preSkips, ...summary.items],
  };
}

export function exportCellArchive(store: Store, now = new Date().toISOString()): RecallCellArchive {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: now,
    stats: store.stats(),
    cells: store.all(),
  };
}

export function importCellArchive(
  store: Store,
  archive: unknown,
  opts: { apply?: boolean } = {},
): ArchiveImportSummary {
  const parsed = parseCellArchive(archive);
  const apply = opts.apply ?? false;
  const items: ArchiveImportSummary["items"] = [];
  let imported = 0;
  let skipped = 0;
  for (const cell of parsed.cells) {
    const existing = store.get(cell.key);
    if (existing && JSON.stringify(existing) === JSON.stringify(cell)) {
      skipped += 1;
      items.push({ key: cell.key, action: "skip", reason: "unchanged" });
      continue;
    }
    imported += 1;
    items.push({ key: cell.key, action: "import" });
    if (apply) store.put(cell);
  }
  return { dryRun: !apply, imported, skipped, items };
}

export function parseCellArchive(input: unknown): RecallCellArchive {
  if (!isRecord(input) || input.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    throw new Error(`archive schemaVersion must be ${EXPORT_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(input.cells)) throw new Error("archive cells must be an array");
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: typeof input.exportedAt === "string" ? input.exportedAt : new Date(0).toISOString(),
    stats: isRecord(input.stats)
      ? (input.stats as unknown as ReturnType<Store["stats"]>)
      : { cells: 0, activeCells: 0, edges: 0, indexedCells: 0, lexicalBackend: "like" },
    cells: input.cells.map(assertCell),
  };
}

function findByFingerprint(store: Store, fingerprint: string): Cell | undefined {
  return store.all().find((cell) => toRecord(cell.props.import).fingerprint === fingerprint);
}

function findBySourceTags(store: Store, tags: string[]): Cell[] {
  const set = new Set(tags);
  return store
    .all()
    .filter((cell) => set.has(stringValue(toRecord(cell.props.import).sourceTag) ?? "") || cell.tags.entities.some((entity) => set.has(entity)));
}

function assertCell(value: unknown): Cell {
  if (!isRecord(value) || typeof value.key !== "string" || typeof value.handle !== "string" || typeof value.kind !== "string") {
    throw new Error("archive cell is malformed");
  }
  return value as unknown as Cell;
}

function extractRows(json: unknown, keys: string[]): unknown[] {
  if (Array.isArray(json)) return json;
  if (isRecord(json)) {
    for (const key of keys) {
      if (Array.isArray(json[key])) return json[key] as unknown[];
    }
  }
  return [];
}

function titleFrom(content: string): string {
  const trimmed = content.trim() || "imported memory";
  const words = trimmed.split(/\s+/);
  return words.length <= 20 ? trimmed : words.slice(0, 20).join(" ");
}

function autoMemoryKind(type: string | undefined): Kind {
  switch ((type ?? "").toLowerCase()) {
    case "project":
    case "decision":
    case "architecture":
      return "dec";
    default:
      return "obs";
  }
}

function safeIsDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeIsFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function byZepTime(a: ZepFact, b: ZepFact): number {
  const av = a.validAt ?? a.createdAt ?? "";
  const bv = b.validAt ?? b.createdAt ?? "";
  if (av !== bv) return av < bv ? -1 : 1;
  return (a.uuid ?? "").localeCompare(b.uuid ?? "");
}

function sha12(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  return firstString(...values);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

function probability(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
