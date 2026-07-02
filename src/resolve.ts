// Address resolution within a single cell. Field walks (the `-` separator) resolve
// against the cell object here; edge hops (the `.` separator) cross to other cells
// and need the store, so they resolve in R2, not R0.

export function selectField(obj: unknown, names: string[]): unknown {
  let cur: unknown = obj;
  for (const name of names) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[name];
  }
  return cur;
}
