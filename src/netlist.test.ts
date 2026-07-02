import { test } from "node:test";
import assert from "node:assert/strict";
import { admit } from "./admission.js";
import { SqliteStore } from "./store.js";
import { renderCell, renderMiniIndexLine } from "./render.js";
import { tokenize, parseLine, parseNetlist, renderNode, renderNetlist, loadNetlist, serializeCell, parseBracket } from "./netlist.js";
import { runStandingPrograms } from "./programs.js";

const NOW = "2026-06-23T00:00:00Z";

// (2) tokenizer: a quoted run is one token; whitespace otherwise
test("tokenize keeps a quoted string as one token", () => {
  assert.deepEqual(tokenize('dec_a3ee "the title here" conf(0.6!)'), ['dec_a3ee', '"the title here"', "conf(0.6!)"]);
});

test("tokenize handles plain space-separated tokens", () => {
  assert.deepEqual(tokenize("net eff dec_a3ee < conf"), ["net", "eff", "dec_a3ee", "<", "conf"]);
});

// (7) HEADLINE VERIFIER: render -> parse -> render is byte-identical for the read form
test("round-trip: renderCell -> parse -> renderNetlist is byte-identical", () => {
  const r = admit(
    { kind: "dec", title: "primary db", body: "b", confidence: 0.6, edges: [{ relation: "supports", target: "obs_a1b2c3d4", weight: 0.6 }] },
    { key: "k1", now: NOW },
  );
  assert.equal(r.accepted, true);
  const text = renderCell(r.cell!);
  const { nodes, errors } = parseNetlist(text);
  assert.deepEqual(errors, []);
  assert.equal(renderNetlist(nodes), text);
});

test("round-trip: a bare mini-index line parses and re-renders identically", () => {
  const r = admit({ kind: "obs", title: "svc up", body: "b", confidence: 0.8 }, { key: "k2", now: NOW });
  const line = renderMiniIndexLine(r.cell!);
  const node = parseLine(line, 1);
  assert.equal(node.form, "cell");
  assert.equal(renderNode(node), line);
});

// (3/5) each write form parses and re-renders stably (parse <-> render inverse)
test("write forms round-trip", () => {
  const cases = [
    "net eff dec_a3ee < conf calib supports.* contradicts.*",
    "setp watch.thresh 0.6",
    "addf contradiction-load tick",
    "dec_a3ee supports> dec_signals_a2b7(0.6)",
    "dec_a3ee-flags-annexed = true",
  ];
  for (const c of cases) {
    assert.equal(renderNode(parseLine(c, 1)), c, `round-trip failed: ${c}`);
  }
});

// (3) classifier maps each line to exactly one form
test("line classifier picks the right form", () => {
  assert.equal(parseLine("net eff dec_a3ee", 1).form, "wire");
  assert.equal(parseLine("setp a.b 0.5", 1).form, "set");
  assert.equal(parseLine("addf x tick", 1).form, "schedule");
  assert.equal(parseLine("dec_aaaa-flags-annexed = true", 1).form, "set");
  assert.equal(parseLine("dec_aaaa supports> obs_b1c2d3e4(0.5)", 1).form, "edge");
  assert.equal(parseLine("supports> obs_b1c2d3e4(0.5)", 1).form, "edge");
  assert.equal(parseLine("# just a comment", 1).form, "comment");
  assert.equal(parseLine("", 1).form, "blank");
});

// (8) errors carry line numbers
test("parseNetlist reports errors with line numbers", () => {
  const text = "setp watch.thresh 0.6\n@@@ not a form\naddf x tick";
  const { nodes, errors } = parseNetlist(text);
  assert.equal(nodes.length, 2); // the two valid lines parse; the bad one goes to errors, not nodes
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.line, 2);
  assert.match(errors[0]!.message, /no MAL form/);
});

// trailing comment is preserved through round-trip
test("trailing comment round-trips on a write form", () => {
  const line = "setp watch.thresh 0.6 # the gate threshold";
  assert.equal(renderNode(parseLine(line, 1)), line);
});

// (5) loader routes through admit()
test("loadNetlist replay admits cells through admit()", () => {
  const a = admit({ kind: "obs", title: "alpha", body: "b", confidence: 0.7 }, { key: "ka", now: NOW });
  const text = renderCell(a.cell!);
  const { nodes } = parseNetlist(text);
  const store = new SqliteStore();
  const res = loadNetlist(nodes, store, "replay");
  assert.equal(res.cellsAdmitted, 1);
  assert.ok(store.active().length >= 1);
});

// (1, gap closed) serializeCell is the COMPLETE form; round-trips at text level
test("serializeCell round-trips: serialize -> parse -> renderNetlist byte-identical", () => {
  const a = admit({ kind: "dec", title: "primary db", body: "the real body, not the title", confidence: 0.6 }, { key: "ks", now: NOW });
  const text = serializeCell(a.cell!);
  const { nodes, errors } = parseNetlist(text);
  assert.deepEqual(errors, []);
  assert.equal(renderNetlist(nodes), text);
});

// (1, gap closed) lossless LOAD: body survives (the placeholder-body loss is fixed)
test("loadNetlist preserves body, not just title", () => {
  const a = admit({ kind: "obs", title: "svc", body: "service has been up for 9 days", confidence: 0.8 }, { key: "kb", now: NOW });
  const text = serializeCell(a.cell!);
  const { nodes } = parseNetlist(text);
  const store = new SqliteStore();
  loadNetlist(nodes, store, "replay");
  const loaded = store.active()[0]!;
  assert.equal(loaded.body, "service has been up for 9 days");
  assert.equal(loaded.title, "svc");
  assert.equal(loaded.scores.conf, a.cell!.scores.conf); // round-trips the stated anchor
});

// (6) verify mode: read-only, flags a mismatch, writes nothing
test("loadNetlist verify flags mismatches and does not write", () => {
  const store = new SqliteStore();
  // a netlist describing a cell that is NOT in the store -> mismatch (absent)
  const a = admit({ kind: "obs", title: "ghost", body: "b", confidence: 0.5 }, { key: "kg", now: NOW });
  const { nodes } = parseNetlist(serializeCell(a.cell!));
  const res = loadNetlist(nodes, store, "verify");
  assert.equal(res.cellsAdmitted, 0); // verify writes nothing
  assert.equal(store.active().length, 0);
  assert.equal(res.mismatches.length, 1);
  assert.match(res.mismatches[0]!.actual, /absent/);
});

// (limit 1 fixed) body with quote, newline, backslash survives the round-trip
test("serializeCell round-trips a body with quotes, newlines, and backslashes", () => {
  const body = 'he said "hi"\npath C:\\tmp\nend';
  const a = admit({ kind: "obs", title: 'a "tricky" title', body, confidence: 0.5 }, { key: "kq", now: NOW });
  const text = serializeCell(a.cell!);
  const { nodes, errors } = parseNetlist(text);
  assert.deepEqual(errors, []);
  assert.equal(renderNetlist(nodes), text); // byte-identical
  const store = new SqliteStore();
  loadNetlist(nodes, store, "replay");
  const loaded = store.active()[0]!;
  assert.equal(loaded.body, body); // exact, including the quote/newline/backslash
  assert.equal(loaded.title, 'a "tricky" title');
});

// (limit 2 fixed) standalone-source edges route to their source; unknown source is flagged
test("loadNetlist routes standalone edges: matched source folds, unknown source is unresolved", () => {
  const text = [
    'obs_a1b2c3d4 "alpha" conf(0.6!) eff(0.6) curr(1) sal(0.5) annexed(0) locked(0) pinned(0) review(0) bg(1) [out:0 programs:0]',
    'body "alpha body"',
    "obs_a1b2c3d4 supports> obs_e5f6a7b8(0.5)", // source IS the cell above -> folded, not unresolved
    "obs_99999999 supports> obs_e5f6a7b8(0.5)", // source NOT in netlist -> unresolved
  ].join("\n");
  const { nodes, errors } = parseNetlist(text);
  assert.deepEqual(errors, []);
  const store = new SqliteStore();
  const res = loadNetlist(nodes, store, "verify"); // verify isolates routing from admit's target check
  assert.equal(res.unresolvedEdges.length, 1);
  assert.equal(res.unresolvedEdges[0]!.source, "obs_99999999");
});

// (limit 2 fixed) a standalone edge with an EXISTING target is actually attached
test("loadNetlist attaches a standalone edge whose target exists", () => {
  const store = new SqliteStore();
  const b = admit({ kind: "obs", title: "beta", body: "b", confidence: 0.6 }, { key: "beta-key", store, now: NOW });
  store.put(b.cell!);
  const text = [
    'obs_a1b2c3d4 "alpha" conf(0.6!) eff(0.6) curr(1) sal(0.5) annexed(0) locked(0) pinned(0) review(0) bg(1) [out:0 programs:0]',
    'body "alpha body"',
    `obs_a1b2c3d4 supports> ${b.cell!.key}(0.5)`, // target is beta's real key -> admit accepts
  ].join("\n");
  const { nodes } = parseNetlist(text);
  const res = loadNetlist(nodes, store, "merge");
  assert.equal(res.cellsAdmitted, 1);
  assert.equal(res.edgesAttached, 1);
  assert.equal(res.unresolvedEdges.length, 0);
});

// (set actuator) a flag set actually mutates the cell
test("loadNetlist applies a `set` flag actuator and mutates the cell", () => {
  const store = new SqliteStore();
  const a = admit({ kind: "obs", title: "alpha", body: "b", confidence: 0.6 }, { key: "ka", store, now: NOW });
  store.put(a.cell!);
  const handle = a.cell!.handle;
  assert.equal(store.getByHandle!(handle)!.flags.pinned, false);
  const { nodes } = parseNetlist(`${handle}-flags-pinned = true`);
  const res = loadNetlist(nodes, store, "merge");
  assert.equal(res.fieldsSet.length, 1);
  assert.equal(res.fieldsSet[0]!.field, "flags.pinned");
  assert.equal(store.getByHandle!(handle)!.flags.pinned, true); // actually mutated
});

// (set actuator) a non-flag, non-program set path has no write route -> unsupported
test("loadNetlist reports a non-flag cell field set as unsupported (no write route)", () => {
  const { nodes } = parseNetlist("obs_a1b2c3d4-scores-eff = 0.9"); // scores are derived, not settable
  const res = loadNetlist(nodes, new SqliteStore(), "replay");
  assert.equal(res.fieldsSet.length, 0);
  assert.equal(res.unsupported.length, 1);
  assert.match(res.unsupported[0]!.reason, /write route|flag/);
});

// (deferral A fixed) addf schedules a standing program; setp configures its param
test("loadNetlist schedules a program with addf and sets a param with setp", () => {
  const store = new SqliteStore();
  const { nodes } = parseNetlist(["addf watch tick", "setp watch.thresh 0.6"].join("\n"));
  const res = loadNetlist(nodes, store, "replay");
  assert.equal(res.programsCreated.length, 1);
  assert.equal(res.programsCreated[0]!.operation, "watch");
  assert.equal(res.paramsSet.length, 1);
  assert.equal(res.paramsSet[0]!.param, "thresh");
  assert.equal(res.paramsSet[0]!.value, 0.6);
  const prog = store.active().find((c) => c.kind === "prg");
  assert.equal((prog!.props.program as { params: Record<string, unknown> }).params.thresh, 0.6); // really configured
});

test("loadNetlist addf is idempotent: same op twice -> one program cell", () => {
  const store = new SqliteStore();
  const { nodes } = parseNetlist(["addf trend tick", "addf trend tick"].join("\n"));
  loadNetlist(nodes, store, "replay");
  assert.equal(store.active().filter((c) => c.kind === "prg").length, 1);
});

test("loadNetlist setp on an unscheduled program is unsupported with guidance", () => {
  const store = new SqliteStore();
  const { nodes } = parseNetlist("setp drift.delta 0.1"); // no `addf drift tick` first
  const res = loadNetlist(nodes, store, "replay");
  assert.equal(res.paramsSet.length, 0);
  assert.equal(res.unsupported.length, 1);
  assert.match(res.unsupported[0]!.reason, /schedule it first|no 'drift'/);
});

// (hyperedge programs) bracket primitives author a program's target + params
test("parseBracket parses a [key: values] primitive", () => {
  assert.deepEqual(parseBracket("[topics: db ops]"), { key: "topics", values: ["db", "ops"] });
});

test("bracket primitives round-trip on the addf form", () => {
  const line = "addf quorum tick [keys: dec_a3ee obs_9c1f] [k: 2] [minEff: 0.6]";
  assert.equal(renderNode(parseLine(line, 1)), line);
});

test("the [out:N programs:M] trailer still round-trips as one bracket token", () => {
  const r = admit({ kind: "obs", title: "t", body: "b", confidence: 0.6 }, { key: "kt", now: NOW });
  const line = renderNode(parseLine(renderNetlist(parseNetlist(serializeCell(r.cell!)).nodes).split("\n")[0]!, 1));
  assert.match(line, /\[out:0 programs:0\]$/);
});

test("addf with bracket primitives builds the ProgramSpec target + params (no schema change)", () => {
  const store = new SqliteStore();
  const res = loadNetlist(parseNetlist("addf watch tick [topics: db] [delta: 0.2]").nodes, store, "merge");
  assert.equal(res.programsCreated.length, 1);
  const spec = store.active().find((c) => c.kind === "prg")!.props.program as { target: { topics: string[] }; params: { delta: number } };
  assert.deepEqual(spec.target.topics, ["db"]);
  assert.equal(spec.params.delta, 0.2);
});

// (HAL thread ordering) functions run in position order on the tick; positive from
// the start, negative from the end (-1 last), default 0 in insertion order
test("tick runs programs in HAL position order (positive ascending, -1 last, default first)", () => {
  const store = new SqliteStore();
  loadNetlist(
    parseNetlist(
      [
        "addf score tick [position: 2]",
        "addf watch tick [position: -1]", // last
        "addf drift tick [position: 1]",
        "addf trend tick", // default 0 -> first
      ].join("\n"),
    ).nodes,
    store,
    "merge",
  );
  const order = runStandingPrograms(store, NOW).runs.map((r) => r.operation);
  assert.deepEqual(order, ["trend", "drift", "score", "watch"]);
});

// (addf is declarative) re-stating a program reconfigures it; bare re-addf is a no-op
test("addf updates an existing program's config (update/expand), staying one cell", () => {
  const store = new SqliteStore();
  const a = loadNetlist(parseNetlist("addf watch tick [delta: 0.1]").nodes, store, "merge");
  assert.equal(a.programsCreated[0]!.updated, false);
  const b = loadNetlist(parseNetlist("addf watch tick [delta: 0.9] [topics: db]").nodes, store, "merge");
  assert.equal(b.programsCreated[0]!.updated, true);
  assert.equal(store.active().filter((c) => c.kind === "prg").length, 1); // still one program cell
  const spec = store.active().find((c) => c.kind === "prg")!.props.program as { params: { delta: number }; target: { topics: string[] } };
  assert.equal(spec.params.delta, 0.9); // updated
  assert.deepEqual(spec.target.topics, ["db"]); // expanded with a target
});

test("bare re-addf is an idempotent no-op (no config = no change)", () => {
  const store = new SqliteStore();
  loadNetlist(parseNetlist("addf watch tick [delta: 0.3]").nodes, store, "merge");
  const b = loadNetlist(parseNetlist("addf watch tick").nodes, store, "merge");
  assert.equal(b.programsCreated[0]!.updated, false);
  const spec = store.active().find((c) => c.kind === "prg")!.props.program as { params: { delta: number } };
  assert.equal(spec.params.delta, 0.3); // unchanged
});

test("a netlist hyperedge program selects members by its target and runs over them", () => {
  const store = new SqliteStore();
  const m = admit({ kind: "obs", title: "db note", body: "b", confidence: 0.7, topics: ["db"] }, { key: "d1", store, now: NOW });
  store.put(m.cell!);
  loadNetlist(parseNetlist("addf score tick [topics: db]").nodes, store, "merge");
  const run = runStandingPrograms(store, NOW).runs.find((r) => r.operation === "score");
  assert.ok(run, "the score program ran");
  assert.ok((run!.output.memberCount as number) >= 1, "found its member via the [topics: db] target");
});

// (trend / numeric trend) trend is a general trajectory engine; [measure: <path>]
// makes it track an arbitrary numeric field, not just effective confidence
test("numeric trend: a netlist trend program tracks an arbitrary numeric field via [measure: path]", () => {
  const store = new SqliteStore();
  const m = admit({ kind: "obs", title: "x", body: "b", confidence: 0.7, topics: ["g"] }, { key: "x1", store, now: NOW });
  store.put(m.cell!);
  loadNetlist(parseNetlist("addf trend tick [topics: g] [measure: scores.salience] [window: 8]").nodes, store, "merge");
  const spec = store.active().find((c) => c.kind === "prg")!.props.program as { params: { measure: string; window: number } };
  assert.equal(spec.params.measure, "scores.salience");
  assert.equal(spec.params.window, 8);
  const run = runStandingPrograms(store, NOW).runs.find((r) => r.operation === "trend")!;
  assert.equal(run.output.measure, "scores.salience");
  // it tracked the salience field, not the cell's effective confidence (0.7)
  assert.equal(run.output.current, Math.round(m.cell!.scores.salience * 1e6) / 1e6);
});

test("default trend tracks effective_confidence when no measure is given", () => {
  const store = new SqliteStore();
  const m = admit({ kind: "obs", title: "y", body: "b", confidence: 0.7, topics: ["g"] }, { key: "y1", store, now: NOW });
  store.put(m.cell!);
  loadNetlist(parseNetlist("addf trend tick [topics: g]").nodes, store, "merge");
  const run = runStandingPrograms(store, NOW).runs.find((r) => r.operation === "trend")!;
  assert.equal(run.output.measure, "effective_confidence");
});

// (wire/schedule) connect compiled-in ops -> acknowledged; unknown names -> unsupported
test("loadNetlist acknowledges net/addf for known ops and flags unknown ones", () => {
  const text = [
    "net eff dec_a1b2c3d4 < conf", // known signal -> acknowledged
    "addf contradiction-load tick", // known tick op -> acknowledged
    "net bogus dec_a1b2c3d4 < conf", // unknown signal -> unsupported
    "addf nonsense-op tick", // unknown op -> unsupported
  ].join("\n");
  const { nodes } = parseNetlist(text);
  const res = loadNetlist(nodes, new SqliteStore(), "replay");
  assert.equal(res.acknowledged.length, 2);
  assert.equal(res.unsupported.length, 2);
});

// (6) merge mode: admits into an existing (non-empty) graph
test("loadNetlist merge admits into a populated store", () => {
  const store = new SqliteStore();
  const pre = admit({ kind: "dec", title: "pre-existing", body: "b", confidence: 0.6 }, { key: "kpre", store, now: NOW });
  store.put(pre.cell!);
  const before = store.active().length;
  const a = admit({ kind: "obs", title: "newcomer", body: "fresh", confidence: 0.7 }, { key: "kn", now: NOW });
  const { nodes } = parseNetlist(serializeCell(a.cell!));
  const res = loadNetlist(nodes, store, "merge");
  assert.equal(res.cellsAdmitted, 1);
  assert.ok(store.active().length >= before + 1);
});
