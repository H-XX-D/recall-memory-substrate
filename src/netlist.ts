// MAL netlist reader: the parse/load inverse of render.ts.
//
// Grammar is frozen in docs/design/mal-language.md; this implements exactly that,
// reusing the operand parsers in address.ts (the hard part is done there).
//
//   text --tokenize--> tokens --classify--> typed AST --load--> Store (via admit)
//
// Forms (one per line):
//   cell      `<handle> "<title>" <field(value)>... [out:N programs:M]`   (render read form)
//   edge      `[<source>] <relation>> <target>(<weight>)`  (`>` fwd, `<` rev)
//   set       `<addr> = <value>`   or   `setp <addr> <value>`
//   wire      `net <signal> <target> [<|>] <input>...`
//   schedule  `addf <op> tick`
//   comment   `# ...`   (also trailing on any line)
//
// The verifier (mal-language.md / design point 7) is a round-trip property:
// parseNetlist(text).nodes.map(renderNode).join("\n") === text, byte-identical,
// for any text produced by render.ts. See netlist.test.ts.

import { parseHandle, parseValue, renderValue, quoteString, unquoteString, parsePath } from "./address.js";
import { admit } from "./admission.js";
import { renderMiniIndexLine } from "./render.js";
import { PROGRAM_OPERATIONS, PROGRAM_SCHEMA_VERSION } from "./programs.js";
import { RELATIONS } from "./types.js";
import type { Cell, Store, WriteProposal } from "./types.js";

// ---------- AST ----------

export interface FieldTok {
  field: string;
  value: number;
  immutable: boolean;
}

export type MalNode =
  | { form: "blank"; line: number }
  | { form: "comment"; line: number; text: string }
  | {
      form: "cell";
      line: number;
      expand: boolean;
      handle: string;
      title: string;
      fields: FieldTok[];
      out: number;
      programs: number;
      comment?: string;
    }
  | {
      form: "edge";
      line: number;
      source?: string;
      relation: string;
      direction: "fwd" | "rev";
      target: string;
      weight: number;
      comment?: string;
    }
  | { form: "body"; line: number; text: string; comment?: string }
  | { form: "set"; line: number; style: "eq" | "setp"; addr: string; value: string; comment?: string }
  | { form: "wire"; line: number; signal: string; target: string; direction?: "fwd" | "rev"; inputs: string[]; comment?: string }
  | { form: "schedule"; line: number; op: string; config: BracketPrim[]; comment?: string };

// `[key: v1 v2 ...]` bracket primitive: a key prefixing one or more values.
export interface BracketPrim {
  key: string;
  values: string[];
}

export interface MalError {
  line: number;
  message: string;
  text: string;
}

// ---------- tokenizer ----------

// Split `code` on whitespace, but keep a "..." run as one token (quotes included).
// `code` must already have any trailing comment removed.
export function tokenize(code: string): string[] {
  const toks: string[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < code.length && code[j] !== '"') {
        if (code[j] === "\\") j++; // skip the escaped char so \" does not close the string
        j++;
      }
      if (j >= code.length) throw new Error("unterminated quoted string");
      toks.push(code.slice(i, j + 1));
      i = j + 1;
    } else if (c === "[") {
      // a `[key: v1 v2 ...]` bracket primitive (or the [out:N programs:M] trailer) is one token
      let j = i + 1;
      while (j < code.length && code[j] !== "]") j++;
      if (j >= code.length) throw new Error("unterminated bracket primitive");
      toks.push(code.slice(i, j + 1));
      i = j + 1;
    } else {
      let j = i;
      while (j < code.length && code[j] !== " " && code[j] !== "\t") j++;
      toks.push(code.slice(i, j));
      i = j;
    }
  }
  return toks;
}

// Index of the first `#` that is not inside a quoted run; -1 if none.
function unquotedHash(line: string): number {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === "#" && !inQuote) return i;
  }
  return -1;
}

const isQuoted = (t: string): boolean => t.length >= 2 && t.startsWith('"') && t.endsWith('"');
const unquote = (t: string): string => unquoteString(t);

// A token like `supports>` / `contradicts<`: a known relation plus a direction char.
function asEdgeHead(tok: string): { relation: string; direction: "fwd" | "rev" } | null {
  const last = tok[tok.length - 1];
  if (last !== ">" && last !== "<") return null;
  const relation = tok.slice(0, -1);
  if (!(RELATIONS as readonly string[]).includes(relation)) return null;
  return { relation, direction: last === ">" ? "fwd" : "rev" };
}

// `[key: v1 v2 ...]` -> { key, values }. One token (the tokenizer keeps `[...]` whole).
export function parseBracket(tok: string): BracketPrim {
  if (!tok.startsWith("[") || !tok.endsWith("]")) throw new Error(`not a bracket primitive: ${tok}`);
  const inner = tok.slice(1, -1);
  const colon = inner.indexOf(":");
  if (colon < 0) throw new Error(`bracket primitive needs '[key: values]': ${tok}`);
  const key = inner.slice(0, colon).trim();
  const values = inner.slice(colon + 1).trim().split(/\s+/).filter(Boolean);
  if (!key) throw new Error(`empty bracket key: ${tok}`);
  return { key, values };
}

function renderBracket(b: BracketPrim): string {
  return `[${b.key}: ${b.values.join(" ")}]`;
}

// `target(weight)` → reuse parseValue: field is the target handle, value the weight.
function parseEdgeTail(tok: string): { target: string; weight: number } {
  const v = parseValue(tok);
  return { target: v.field, weight: v.value };
}

// ---------- line classifier / parser ----------

export function parseLine(line: string, lineNo: number): MalNode {
  const hashIdx = unquotedHash(line);
  const code = hashIdx >= 0 ? line.slice(0, hashIdx) : line;
  const comment = hashIdx >= 0 ? line.slice(hashIdx) : undefined;

  if (code.trim() === "") {
    return comment !== undefined ? { form: "comment", line: lineNo, text: comment } : { form: "blank", line: lineNo };
  }

  const toks = tokenize(code.trim());
  const t0 = toks[0]!;

  // keyworded write forms first (point 3: leading keyword wins)
  if (t0 === "net") {
    if (toks.length < 3) throw new Error("net needs a signal and a target");
    let i = 3;
    let direction: "fwd" | "rev" | undefined;
    if (toks[3] === "<" || toks[3] === ">") {
      direction = toks[3] === ">" ? "fwd" : "rev";
      i = 4;
    }
    return { form: "wire", line: lineNo, signal: toks[1]!, target: toks[2]!, direction, inputs: toks.slice(i), comment };
  }
  if (t0 === "setp") {
    if (toks.length !== 3) throw new Error("setp needs exactly an address and a value");
    return { form: "set", line: lineNo, style: "setp", addr: toks[1]!, value: toks[2]!, comment };
  }
  if (t0 === "addf") {
    if (toks.length < 3 || toks[2] !== "tick") throw new Error("addf form is `addf <op> tick [key: values]...`");
    const config = toks.slice(3).map(parseBracket);
    return { form: "schedule", line: lineNo, op: toks[1]!, config, comment };
  }
  // body line (cell-attached free text): `body "<text>"`
  if (t0 === "body") {
    if (toks.length !== 2 || !isQuoted(toks[1]!)) throw new Error('body form is `body "<text>"`');
    return { form: "body", line: lineNo, text: unquote(toks[1]!), comment };
  }

  // top-level `=` is a set
  const eq = toks.indexOf("=");
  if (eq === 1 && toks.length === 3) {
    return { form: "set", line: lineNo, style: "eq", addr: toks[0]!, value: toks[2]!, comment };
  }

  // edge with explicit source: `<source> <relation>> <target>(<weight>)`
  if (toks.length >= 3) {
    const head = asEdgeHead(toks[1]!);
    if (head) {
      const tail = parseEdgeTail(toks[2]!);
      parseHandle(t0); // validate the source handle
      return { form: "edge", line: lineNo, source: t0, relation: head.relation, direction: head.direction, target: tail.target, weight: tail.weight, comment };
    }
  }

  // cell-attached edge (under a decl): `<relation>> <target>(<weight>)`
  const headOnly = asEdgeHead(t0);
  if (headOnly && toks.length === 2) {
    const tail = parseEdgeTail(toks[1]!);
    return { form: "edge", line: lineNo, relation: headOnly.relation, direction: headOnly.direction, target: tail.target, weight: tail.weight, comment };
  }

  // cell declaration: `<handle> "<title>" <field(value)>... [out:N programs:M]`
  if (toks.length >= 2 && isQuoted(toks[1]!)) {
    let handle = t0;
    let expand = false;
    if (handle.startsWith("^")) {
      expand = true;
      handle = handle.slice(1);
    }
    parseHandle(handle);
    const title = unquote(toks[1]!);
    const fields: FieldTok[] = [];
    let out = 0;
    let programs = 0;
    let i = 2;
    while (i < toks.length) {
      const tok = toks[i]!;
      if (tok.startsWith("[")) {
        const m = /^\[out:(\d+) programs:(\d+)\]$/.exec(tok);
        if (!m) throw new Error("malformed [out:N programs:M] trailer");
        out = Number(m[1]);
        programs = Number(m[2]);
        i += 1;
        break;
      }
      fields.push(parseValue(tok));
      i++;
    }
    return { form: "cell", line: lineNo, expand, handle, title, fields, out, programs, comment };
  }

  throw new Error(`line matches no MAL form: ${code.trim()}`);
}

// ---------- whole-document parse ----------

export function parseNetlist(text: string): { nodes: MalNode[]; errors: MalError[] } {
  const nodes: MalNode[] = [];
  const errors: MalError[] = [];
  const lines = text.split("\n");
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    try {
      nodes.push(parseLine(line, lineNo));
    } catch (e) {
      errors.push({ line: lineNo, message: e instanceof Error ? e.message : String(e), text: line });
    }
  });
  return { nodes, errors };
}

// ---------- renderer (the inverse, for the round-trip verifier) ----------

const dirChar = (d: "fwd" | "rev"): string => (d === "fwd" ? ">" : "<");

export function renderNode(node: MalNode): string {
  switch (node.form) {
    case "blank":
      return "";
    case "comment":
      return node.text;
    case "cell": {
      const lead = node.expand ? "^" : "";
      const fields = node.fields.map((f) => renderValue(f.field, f.value, f.immutable)).join(" ");
      const body = `${lead}${node.handle} ${quoteString(node.title)} ${fields} [out:${node.out} programs:${node.programs}]`;
      return node.comment ? `${body} ${node.comment}` : body;
    }
    case "edge": {
      const head = node.source ? `${node.source} ` : "";
      const body = `${head}${node.relation}${dirChar(node.direction)} ${node.target}(${node.weight})`;
      return node.comment ? `${body} ${node.comment}` : body;
    }
    case "body": {
      const body = `body ${quoteString(node.text)}`;
      return node.comment ? `${body} ${node.comment}` : body;
    }
    case "set": {
      const body = node.style === "eq" ? `${node.addr} = ${node.value}` : `setp ${node.addr} ${node.value}`;
      return node.comment ? `${body} ${node.comment}` : body;
    }
    case "wire": {
      const dir = node.direction ? ` ${dirChar(node.direction)}` : "";
      const inputs = node.inputs.length ? ` ${node.inputs.join(" ")}` : "";
      const body = `net ${node.signal} ${node.target}${dir}${inputs}`;
      return node.comment ? `${body} ${node.comment}` : body;
    }
    case "schedule": {
      const cfg = node.config.length ? ` ${node.config.map(renderBracket).join(" ")}` : "";
      const body = `addf ${node.op} tick${cfg}`;
      return node.comment ? `${body} ${node.comment}` : body;
    }
  }
}

export function renderNetlist(nodes: MalNode[]): string {
  return nodes.map(renderNode).join("\n");
}

// ---------- complete (lossless) serialization ----------

// A cell's COMPLETE write form: the mini-index line, a `body "..."` line, then
// one edge line per outgoing edge. Unlike the render mini-index (a lossy read
// projection), this carries the body, so load reconstructs the admit INPUTS
// (kind/title/body/confidence/edges) without loss. Derived scores and the
// internal key are admit's job and are intentionally not restored. Body free text
// (quotes, newlines, backslashes) is escaped via quoteString and survives the
// round-trip.
export function serializeCell(cell: Cell): string {
  const lines = [renderMiniIndexLine(cell), `body ${quoteString(cell.body)}`];
  for (const edge of cell.edgesOut) {
    lines.push(`${edge.relation}> ${edge.target}(${edge.weight})`);
  }
  return lines.join("\n");
}

export function serializeGraph(cells: Cell[]): string {
  return cells.map(serializeCell).join("\n\n");
}

// ---------- loader ----------

export type LoadMode = "replay" | "verify" | "merge";

export interface LoadResult {
  mode: LoadMode;
  cellsAdmitted: number;
  edgesAttached: number;
  fieldsSet: { handle: string; field: string; value: boolean }[]; // applied `set`/`setp` flag actuators
  programsCreated: { operation: string; key: string; updated: boolean }[]; // `addf <op> tick` standing programs scheduled on the tick (updated=true if it reconfigured an existing one)
  paramsSet: { program: string; param: string; value: number | string }[]; // `setp <op>.<param> <value>` op-param config
  acknowledged: { form: string; line: number; detail: string }[]; // net/addf: connect compiled-in ops (inert on the fixed engine, per mal-language.md §5)
  rejected: { handle: string; issues: unknown[] }[];
  mismatches: { handle: string; expected: string; actual: string }[];
  unresolvedEdges: { source: string; relation: string; target: string }[]; // standalone edge whose source is not in the netlist
  unsupported: { form: string; line: number; reason: string }[]; // a directive that names something unknown / a path with no write route
}

// MAL field names (as rendered) -> Flags keys. These are the mutable boolean
// "actuators" the spec sets with `<handle>-flags-<name> = true`.
const FLAG_FIELD_TO_KEY: Record<string, keyof Cell["flags"]> = {
  annexed: "annexed",
  locked: "locked",
  pinned: "pinned",
  review: "requiresReview",
  bg: "allowBackgroundUse",
};

// Known signal fields a `net` may wire, and tick ops an `addf` may schedule.
// Per mal-language.md §5 the math/scheduling is compiled-in; the netlist only
// connects these pre-built ops, so loading validates the name and acknowledges.
const KNOWN_SIGNALS = new Set(["eff", "conf", "curr", "sal", "unc", "concern", "calib"]);
// Compiled-in tick ops that are NOT standing programs: addf acknowledges these.
// The PROGRAM_OPERATIONS (watch/drift/quorum/trend/score/...) are scheduled as
// real prg cells instead (see pass 3).
const KNOWN_TICK_OPS = new Set(["contradiction-load", "currency-decay", "salience", "derive"]);

// Find the standing-program cell for an operation (prg cell whose spec.operation matches).
function findProgram(store: Store, operation: string): Cell | undefined {
  return store.active().find((c) => c.kind === "prg" && (c.props.program as { operation?: string } | undefined)?.operation === operation);
}

// Set-valued target fields vs scalar; everything else is a program param.
const TARGET_SET_KEYS = new Set(["keys", "topics", "entities", "kinds"]);
const coerce = (v: string): number | string => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);

// Build a ProgramSpec from bracket primitives. These map straight onto the EXISTING
// ProgramSpec.target (keys/topics/entities/kinds/query/limit) and params — no schema
// change; a new op is just new vocabulary.
function buildProgramSpec(operation: string, config: BracketPrim[]): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  const params: Record<string, unknown> = {};
  for (const { key, values } of config) {
    if (TARGET_SET_KEYS.has(key)) target[key] = values;
    else if (key === "query") target.query = values.join(" ");
    else if (key === "limit") target.limit = Number(values[0]);
    else params[key] = values.length === 1 ? coerce(values[0]!) : values.map(coerce);
  }
  const program: Record<string, unknown> = { schemaVersion: PROGRAM_SCHEMA_VERSION, operation };
  if (Object.keys(target).length) program.target = target;
  if (Object.keys(params).length) program.params = params;
  return program;
}

// `addf <op> tick [key: values]...`: schedule a standing program. DECLARATIVE:
//  - no program for this op yet  -> create it
//  - one exists and config given -> reconfigure it (update/expand its spec)
//  - one exists and no config     -> idempotent no-op (keeps the existing spec)
function scheduleProgram(store: Store, operation: string, config: BracketPrim[] = []): { key: string; updated: boolean } {
  const existing = findProgram(store, operation);
  if (existing) {
    if (config.length === 0) return { key: existing.key, updated: false };
    store.put({ ...existing, props: { ...existing.props, program: buildProgramSpec(operation, config) } });
    return { key: existing.key, updated: true };
  }
  const r = admit(
    {
      kind: "prg",
      title: `${operation} program`,
      body: `standing ${operation} program, scheduled on the tick`,
      confidence: 0.6,
      props: { program: buildProgramSpec(operation, config) },
    },
    { store },
  );
  if (!r.accepted || !r.cell) throw new Error(`could not schedule ${operation} program: ${JSON.stringify(r.issues ?? [])}`);
  store.put(r.cell);
  return { key: r.cell.key, updated: false };
}

// `setp <op>.<param> <value>`: set a parameter on the standing program for <op>.
function applyProgramParam(store: Store, operation: string, param: string, raw: string): { program: string; param: string; value: number | string } {
  const prog = findProgram(store, operation);
  if (!prog) throw new Error(`no '${operation}' program to configure (schedule it first: addf ${operation} tick)`);
  const value: number | string = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  const spec = prog.props.program as { params?: Record<string, unknown> } & Record<string, unknown>;
  store.put({ ...prog, props: { ...prog.props, program: { ...spec, params: { ...(spec.params ?? {}), [param]: value } } } });
  return { program: operation, param, value };
}

// Apply a `set`/`setp` flag actuator: `<handle>-flags-<flag> = <true|false>`.
// Returns the applied change, or throws with a clear reason the caller records.
function applyFieldSet(store: Store, addr: string, value: string): { handle: string; field: string; value: boolean } {
  let segs;
  try {
    segs = parsePath(addr);
  } catch {
    throw new Error(`only <handle>-flags-<flag> sets have a write route: ${addr}`);
  }
  if (segs.length !== 3 || segs[0]!.kind !== "cell" || segs[1]!.name !== "flags") {
    throw new Error(`only <handle>-flags-<flag> sets have a write route: ${addr}`);
  }
  const flagKey = FLAG_FIELD_TO_KEY[segs[2]!.name];
  if (!flagKey) throw new Error(`unknown flag '${segs[2]!.name}' (one of ${Object.keys(FLAG_FIELD_TO_KEY).join(", ")})`);
  const handle = segs[0]!.name;
  const cell = store.getByHandle?.(handle);
  if (!cell) throw new Error(`set target not in store: ${handle}`);
  if (value !== "true" && value !== "false") throw new Error(`flag value must be true or false: ${value}`);
  const bool = value === "true";
  store.put({ ...cell, flags: { ...cell.flags, [flagKey]: bool } });
  return { handle, field: `flags.${flagKey}`, value: bool };
}

interface PendingCell {
  node: Extract<MalNode, { form: "cell" }>;
  body?: string;
  edges: { relation: string; target: string; weight: number }[];
}

function pendingToProposal(p: PendingCell): WriteProposal {
  const conf = p.node.fields.find((f) => f.field === "conf")?.value ?? 0.5;
  return {
    kind: parseHandle(p.node.handle).kind,
    title: p.node.title,
    body: p.body ?? p.node.title,
    confidence: conf > 0 && conf <= 1 ? conf : 0.5,
    edges: p.edges.length ? p.edges : undefined,
  };
}

// Route every netlist write through admit() — "the loader is just another author."
// replay: reconstruct into a (fresh) store. merge: admit into an existing graph
// (admit's dedup/supersede applies). verify: read-only; re-render each declared
// cell from the live store and diff against the netlist, collecting mismatches.
//
// Three passes:
//  1. group cell blocks (cell + body + attached edges); collect standalone edges
//     and the actuator forms (set/wire/schedule) in document order.
//  2. admit each cell (with its edges, incl. folded standalone ones) through admit().
//  3. apply actuators against the now-populated store: `set` mutates a flag;
//     `net`/`addf` connect compiled-in ops, so they are validated and acknowledged
//     (inert on the fixed v0 engine, per mal-language.md §5). verify mode skips
//     writes and only diffs declared cells against the live store.
export function loadNetlist(nodes: MalNode[], store: Store, mode: LoadMode = "replay"): LoadResult {
  const result: LoadResult = {
    mode,
    cellsAdmitted: 0,
    edgesAttached: 0,
    fieldsSet: [],
    programsCreated: [],
    paramsSet: [],
    acknowledged: [],
    rejected: [],
    mismatches: [],
    unresolvedEdges: [],
    unsupported: [],
  };

  const blocks: PendingCell[] = [];
  const byHandle = new Map<string, PendingCell>();
  const standalone: { source: string; relation: string; target: string; weight: number }[] = [];
  const actuators: MalNode[] = [];
  let current: PendingCell | null = null;

  // pass 1
  for (const node of nodes) {
    switch (node.form) {
      case "cell":
        current = { node, edges: [] };
        blocks.push(current);
        byHandle.set(node.handle, current);
        break;
      case "body":
        if (current) current.body = node.text;
        break;
      case "edge":
        if (node.source) standalone.push({ source: node.source, relation: node.relation, target: node.target, weight: node.weight });
        else if (current) current.edges.push({ relation: node.relation, target: node.target, weight: node.weight });
        break;
      case "set":
      case "wire":
      case "schedule":
        actuators.push(node);
        break;
      // comment / blank: nothing to load
    }
  }

  for (const e of standalone) {
    const block = byHandle.get(e.source);
    if (block) block.edges.push({ relation: e.relation, target: e.target, weight: e.weight });
    else result.unresolvedEdges.push({ source: e.source, relation: e.relation, target: e.target });
  }

  // pass 2: cells
  for (const p of blocks) {
    if (mode === "verify") {
      const live = store.getByHandle?.(p.node.handle);
      const expected = renderNode(p.node);
      const actual = live ? renderMiniIndexLine(live) : "(absent)";
      if (expected !== actual) result.mismatches.push({ handle: p.node.handle, expected, actual });
      continue;
    }
    const r = admit(pendingToProposal(p), { store });
    if (r.accepted && r.cell) {
      store.put(r.cell);
      result.cellsAdmitted++;
      result.edgesAttached += p.edges.length;
    } else {
      result.rejected.push({ handle: p.node.handle, issues: r.issues ?? [] });
    }
  }

  // pass 3: actuators (verify is read-only, so it skips them)
  const isProgramOp = (op: string): boolean => (PROGRAM_OPERATIONS as readonly string[]).includes(op);
  const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  if (mode !== "verify") {
    for (const node of actuators) {
      if (node.form === "set") {
        // op-param form `<op>.<param>` (dotted, op is a program operation) vs cell-field form
        const opParam = /^([a-z_]+)\.([a-z_][a-z0-9_]*)$/.exec(node.addr);
        if (opParam && isProgramOp(opParam[1]!)) {
          try {
            result.paramsSet.push(applyProgramParam(store, opParam[1]!, opParam[2]!, node.value));
          } catch (e) {
            result.unsupported.push({ form: "set", line: node.line, reason: reason(e) });
          }
        } else {
          try {
            result.fieldsSet.push(applyFieldSet(store, node.addr, node.value));
          } catch (e) {
            result.unsupported.push({ form: "set", line: node.line, reason: reason(e) });
          }
        }
      } else if (node.form === "schedule") {
        if (isProgramOp(node.op)) {
          try {
            const sched = scheduleProgram(store, node.op, node.config);
            result.programsCreated.push({ operation: node.op, key: sched.key, updated: sched.updated });
          } catch (e) {
            result.unsupported.push({ form: "schedule", line: node.line, reason: reason(e) });
          }
        } else if (KNOWN_TICK_OPS.has(node.op)) {
          result.acknowledged.push({ form: "schedule", line: node.line, detail: `op ${node.op} on tick (compiled-in)` });
        } else {
          result.unsupported.push({ form: "schedule", line: node.line, reason: `unknown tick op '${node.op}'` });
        }
      } else if (node.form === "wire") {
        if (KNOWN_SIGNALS.has(node.signal)) {
          result.acknowledged.push({ form: "wire", line: node.line, detail: `signal ${node.signal} -> ${node.target} (compiled-in)` });
        } else {
          result.unsupported.push({ form: "wire", line: node.line, reason: `unknown signal '${node.signal}'` });
        }
      }
    }
  }

  return result;
}
