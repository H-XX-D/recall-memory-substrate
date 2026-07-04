// Deltas: the numeric truth history. A cell's `value` is one measured reading;
// successive readings supersede their predecessor, so the supersede lineage IS
// the series. valueSeries walks it (or a topic's readings) oldest-first and
// pairs each reading with its delta; renderDeltasCsv emits the portable form.
import type { Cell, Store } from "./types.js";

export interface DeltaRow {
  at: string;          // createdAt of the reading
  value: number;
  delta: number | null; // value minus the previous reading; null on the first
  key: string;
  title: string;
}

export interface ValueSeriesOptions {
  topic?: boolean; // treat the target as a topic instead of a cell key/handle
  limit?: number;  // cap on rows, newest kept (default 1000)
}

const SERIES_LIMIT = 1000;

export function valueSeries(store: Store, target: string, opts: ValueSeriesOptions = {}): DeltaRow[] {
  const cells = opts.topic ? topicReadings(store, target) : lineageReadings(store, target);
  const ordered = cells
    .filter((c) => typeof c.value === "number" && Number.isFinite(c.value))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-(opts.limit ?? SERIES_LIMIT));
  return ordered.map((cell, i) => ({
    at: cell.createdAt,
    value: cell.value!,
    delta: i === 0 ? null : round6(cell.value! - ordered[i - 1]!.value!),
    key: cell.key,
    title: cell.title,
  }));
}

// The active head plus every ancestor reachable through lineage chains.
function lineageReadings(store: Store, target: string): Cell[] {
  const head = store.get(target) ?? store.getByHandle(target);
  if (!head) return [];
  const seen = new Map<string, Cell>();
  const queue = [head];
  while (queue.length > 0) {
    const cell = queue.pop()!;
    if (seen.has(cell.key)) continue;
    seen.set(cell.key, cell);
    for (const ancestor of cell.lineage) {
      const prior = store.get(ancestor);
      if (prior && !seen.has(prior.key)) queue.push(prior);
    }
  }
  return [...seen.values()];
}

// Every reading (any status: superseded readings are history, not noise)
// tagged with the topic.
function topicReadings(store: Store, topic: string): Cell[] {
  return store.all().filter((c) => (c.tags.topics ?? []).includes(topic));
}

export function renderDeltasCsv(rows: DeltaRow[]): string {
  const header = "timestamp,value,delta,key,title";
  const lines = rows.map((r) =>
    [r.at, String(r.value), r.delta === null ? "" : String(r.delta), r.key, csvEscape(r.title)].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
