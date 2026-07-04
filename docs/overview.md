# How Recall works

Recall is a local memory system for AI agents and the people who work with them. It keeps everything in one SQLite file per graph, runs entirely on your machine, and exposes the same engine through a CLI, an MCP server, and a TypeScript library. This page walks the system end to end: you build a small graph by hand with the same commands an agent uses, watch the admission gate and the operator respond, and finish by wiring the loop into an assistant. Four reference pages specify each surface in detail: [cli.md](cli.md) for every verb and flag, [mcp.md](mcp.md) for the MCP tool contracts, [integrations.md](integrations.md) for hook behavior and setup, and [import-export.md](import-export.md) for archives and adapters.

## The first write

The unit of memory is a cell: a typed record with a stable key, a short human handle, a title, a body, and structured metadata. There are ten kinds:

| Kind | Meaning |
|------|---------|
| `dec` | a decision that was made |
| `obs` | an observation or event |
| `bel` | a belief that can later be supported or contradicted |
| `tsk` | an open task |
| `obj` | an objective |
| `rsk` | a risk worth tracking |
| `ref` | a reference to source material |
| `ver` | a verification result |
| `hyp` | a hypothesis awaiting evidence |
| `prg` | a standing program (see Programs below) |

Each cell carries scores, provenance, tags, and policy:

- **Scores.** `conf` is the confidence the write entered with (after any attenuation by the gate) and never changes afterward. `effective` is recomputed from the graph: support raises it, contradiction and concern lower it, weighted by how trustworthy each neighbor is. `currency` decays with age at a rate set by the cell's stability class (`stable`, `volatile`, or `ephemeral`), so old volatile facts fade while pinned or stable ones persist.
- **Provenance.** Who produced the cell (`human`, `llm`, `daemon`, `connector`, `program`, `external`), the producing actor's identity, and a verification level from `unverified` to `external`.
- **Tags.** Topics and entities are the retrieval surface; optional lifecycle, quality, and subject facets refine filtering.
- **Policy.** Sensitivity (`public`, `private`, `secret`), an optional expiry, and an optional reverify-after clock that resurfaces the cell for review.

A write is a proposal: a small JSON object you can check before it touches the store.

```sh
cat > decision.json <<'EOF'
{ "kind": "dec", "title": "Use SQLite WAL mode for the event store",
  "body": "Single writer, concurrent readers.", "confidence": 0.9, "topics": ["storage"] }
EOF
recall validate --json decision.json   # { "ok": true, "issues": [] }, writes nothing
recall admit --json decision.json
```

The accepted result is the full cell; the complete proposal field list is in [cli.md](cli.md) under Writing. Trimmed to the fields that matter right now:

```json
{ "accepted": true,
  "cell": { "handle": "dec_4b23", "scores": { "conf": 0.7, "effective": 0.7 }, "status": "active" },
  "attenuations": ["confidence 0.90 -> 0.70"] }
```

## The gate argues back

Every write enters through this one gate. It validates the schema, screens all text fields for credential patterns, deduplicates identical content, rejects edges pointing at cells that do not exist, applies confidence attenuation when a claim is stated more strongly than its evidence supports, and processes supersede chains. There is no path around it except restoring a portable archive.

The write above claimed 0.9 with no evidence, so the gate capped it at 0.7 and answered with an `evidenceHint` naming what keeps higher confidence: a `verification` level, `sourceRefs`, or a weighted `supports` edge. Satisfy it:

```sh
cat > observation.json <<'EOF'
{ "kind": "obs", "title": "WAL mode kept readers unblocked during bulk import",
  "body": "Measured during a 10k-row import; no reader stalls.",
  "confidence": 0.9, "verification": "tested", "topics": ["storage"],
  "edges": [ { "relation": "supports", "target": "dec_4b23", "weight": 0.8 } ] }
EOF
recall admit --json observation.json
```

This time `attenuations` is empty and `conf` stays 0.9. The `edges` array previews the Structure section below: this observation now supports the decision, which raises the decision's effective confidence.

Guidance is computed against the store at admit time and never persisted. Now that related cells exist, admitting a similar cell without edges (say a belief, "WAL checkpoints stall under heavy write load", which lands as `bel_7711`) comes back with `candidateEdges`, each naming a target, a suggested relation, and a reason:

```json
"candidateEdges": [
  { "handle": "obs_faec", "title": "WAL mode kept readers unblocked during bulk import",
    "relation": "supports", "reason": "related active cell; a supports edge records why they belong together" } ]
```

Guidance can also carry a `kindHint` when an observation or decision reads like an open task, an unconfirmed claim, or a risk. Program suggestions run by default and flag what deserves ongoing monitoring; each suggestion is a ready-to-admit `prg` proposal, and nothing is ever created automatically (`--no-suggest-programs`, `suggestPrograms: false` on the MCP tool, or `RECALL_SUGGEST_PROGRAMS=0` opts out). `--no-guidance` omits the block entirely. The suggestion thresholds and the full guidance contract are in [cli.md](cli.md) (Writing) and [mcp.md](mcp.md) (recall_write).

## Reading it back

Reading is navigation, not a blob. Three engines combine: lexical search (SQLite FTS5 with BM25 ranking), semantic search (cosine similarity over embeddings computed automatically on admission), and subgraph filters (kind, project, topics, entities, time, with AND semantics).

Compile is the primary read surface: it takes a task description and a word budget and produces a context packet, ranked by BM25 fused with graph degree, effective confidence, and recency. The packet groups results into sections (relevant memory, active beliefs, conflicts, dependencies, risks, tasks, cell state, standing programs, translated references, stale or low-trust items, suggested next actions) and closes with an ids-first expansion index, so nothing has to be expanded blind. `--limit` caps the cell count and `--no-health` drops the health summary. Expand a handle from the packet with `cell show`, or address one field of it with a `handle#field` reference. `recall diff` reports what changed in a window (new cells, updates, supersede events, new hyperedges); its `--summary` rendering is exactly what the assistant session hook injects at session start (see [integrations.md](integrations.md)).

```sh
recall search "WAL"
recall compile "how should the event store handle concurrent reads?" --words 500
recall cell show dec_4b23
recall cell show 'dec_4b23#scores.effective'
recall diff --since 7d --summary
```

```
relevant_memory:
- dec_4b23 "Use SQLite WAL mode for the event store" conf(0.7!) eff(0.7) ... [dec:home:4b2330e2-...]
expansion_handles:
- decisions: dec_4b23 "Use SQLite WAL mode for the event store" [home:4b2330e2-...]
- beliefs: bel_7711 "WAL checkpoints stall under heavy write load" [home:77117e3a-...]
```

One more read surface needs one more write field. A proposal may carry `value`, a finite number the cell measures: admit an observation titled "p95 import latency reading" with `"value": 412` and topic `latency`, and it lands as `obs_867a`. `recall deltas obs_867a` prints the numeric series for the cell's supersede lineage (one row so far; the next section extends it), `--topic` collects every reading tagged with a topic, and `--csv` emits spreadsheet rows.

Semantic search has no CLI verb; it surfaces through the MCP tool `recall_semantic`. A deterministic hash backend works with no configuration, and `RECALL_EMBEDDING_URL` (with optional `RECALL_EMBEDDING_MODEL` and `RECALL_EMBEDDING_API_KEY`) switches to a real embedding endpoint. See [mcp.md](mcp.md).

## Structure

Cells connect through directed, signed edges with six relations: `supports`, `contradicts`, `concerns`, `depends_on`, `supersedes`, and `derived_from`. Weight conventions are enforced: `supports` weight is positive, `contradicts` and `concerns` are negative, the rest are zero. Edges are the single source of truth for how memories relate; scores are derived by walking them, never stored redundantly.

Supersession preserves history. A new reading replaces the old one without destroying it:

```sh
cat > reading2.json <<'EOF'
{ "kind": "obs", "title": "p95 import latency reading",
  "body": "Nightly benchmark, milliseconds, after the WAL change.",
  "confidence": 0.8, "verification": "checked", "topics": ["latency"], "value": 371,
  "operation": "supersede", "edges": [ { "relation": "supersedes", "target": "obs_867a", "weight": 0 } ] }
EOF
recall admit --json reading2.json
```

`recall cell show obs_867a` now reports `status: superseded`, the new cell lists the old key in its lineage, and the deltas series from the previous section has grown:

```
$ recall deltas latency --topic --csv
timestamp,value,delta,key,title
2026-07-04T19:56:49.569Z,412,,home:867abbd4-...,p95 import latency reading
2026-07-04T19:57:26.337Z,371,-41,home:bff7f93c-...,p95 import latency reading
```

Beyond pairwise edges, a hyperedge groups any number of cells into a typed, named structure with per-member roles:

```sh
cat > edge.json <<'EOF'
{ "kind": "decision-record", "title": "WAL adoption: decision, evidence, and open concern",
  "members": [ { "key": "dec_4b23", "role": "decision" }, { "key": "obs_faec", "role": "evidence" },
               { "key": "bel_7711", "role": "concern" } ] }
EOF
recall hyperedge add --json edge.json
recall hyperedge list
recall hyperedge show <id>
```

DAG overlays capture ordered dependency structure over a set of cells, independent of the cells' own edges, and can be analyzed for cycles and conflicting paths:

```sh
cat > overlay.json <<'EOF'
{ "title": "event store rollout order",
  "nodeIds": ["dec_4b23", "obs_faec", "bel_7711"],
  "edges": [ { "source": "dec_4b23", "target": "obs_faec", "label": "verified-by" }, { "source": "dec_4b23", "target": "bel_7711", "label": "watched-for" } ] }
EOF
recall dag add --json overlay.json
recall dag analyze <id> --derive
recall dag list
recall dag show <id>
```

Structure feeds directly back into reading: `contradicts` edges populate the compile packet's conflicts section, and `depends_on` edges populate its dependencies section. The full JSON shapes are in [cli.md](cli.md) under Graph structures.

## Programs and the operator

A standing program is an ordinary `prg` cell whose spec selects member cells and applies one of nine deterministic operations on every run: `score`, `emit_witness`, `tag_projection`, `watch` (trip on a moved average), `drift` (watch plus per-member attribution), `quorum` (k of m distinct actors above a threshold), `trend` (slope, acceleration, and streaks over a window), `reflex` (a boolean truth table over cell state), and `allocate` (rank open work by a pressure formula). No model is ever in the loop.

The spec lives at `props.program` and must carry `schemaVersion` `recall.program.v1`, an `operation`, and a `target` selector. The gate admits a `prg` cell without checking the spec, so a malformed spec surfaces at run time, not admit time. The minimal hand-authored shape:

```sh
cat > program.json <<'EOF'
{ "kind": "prg", "title": "Watch the storage topic",
  "body": "Trips when the average effective confidence of storage cells moves.",
  "confidence": 0.6, "topics": ["storage"],
  "props": { "program": { "schemaVersion": "recall.program.v1", "operation": "watch", "target": { "topics": ["storage"] } } } }
EOF
recall admit --json program.json
recall program run prg_855b --derive
recall program list
recall program runs prg_855b
recall program show-run <id>
```

The run output shows what the watch saw: `"current": 0.733, "previous": null, "tripped": false`. The `--suggest-programs` proposals from the gate section are exactly this shape and admit unchanged.

The operator is the deterministic between-turn tick: it decays currency, recomputes effective confidence from current neighbor state, runs all standing programs, and records the pass in a run ledger. Tripped programs emit witness cells through the admission gate with deterministic keys, so re-deriving an unchanged result is a no-op instead of a duplicate. Per-operation parameters and run ledgers are in [cli.md](cli.md) under Programs and evals.

```sh
recall operate once --derive
recall operate list
```

## Maintenance and health

Two audits watch the store itself. The eval suite runs search and compile smoke checks plus structural invariants (every edge target resolves, scores stay in bounds, dependency edges stay acyclic, handles and key prefixes resolve). The health engine analyzes belief pressure, staleness, contradictions, dangling edges, and provenance concentration. Both record their runs in ledgers, and `--derive` admits the result as a witness cell (the health witness is bucketed to one per day).

`recall maintain` composes the full upkeep pass: operator tick, eval run, daily health witness, and semantic indexing of any unindexed cells. Every leg is idempotent, so the pass is safe at any frequency; `--all-graphs` covers the home graph and every registered project in one invocation. `service install` writes a launchd agent (or prints an equivalent crontab line on other platforms) that runs the pass on a timer; scheduling detail is in [integrations.md](integrations.md).

```sh
recall eval run --derive
recall eval list
recall health --derive
recall maintain
recall maintain --all-graphs
recall service install --interval-min 60
recall service status
recall service uninstall
```

## Projects and routing

Everything above ran against the home graph, the default when no project is registered. Memory lives in graphs: one home graph per machine plus one graph per registered project, with the registry kept in its own file so a damaged graph never hides your project list. Commands route by explicit `--db`, then `--project`, then the deepest registered project containing the current directory, then home; the `RECALL_DB` environment variable overrides all of that. Reads at home scope federate across every local graph; writes always target exactly one.

```sh
cd ~/code/my-project
recall project init --slug my-project
recall where            # alias for recall project where: scope, resolved db path, reason
recall project list
recall status --project my-project
recall storage --project my-project
```

`recall where` shows how any invocation would route before you trust it with a write; the same routing rules are stated flag by flag in [cli.md](cli.md). A new project store starts empty; the next section seeds it.

## Moving memory

Portable archives round-trip an entire graph (cells, edges, hyperedges, embeddings, overlays, and run ledgers) as one JSON file. Every import is a dry run until `--apply`, and every import path is exactly idempotent: each record carries a fingerprint (this exact version) and a source tag (the record across versions), so an unchanged record skips and a changed one supersedes its prior import.

Adapters bring memory in from other systems, and two commands handle local moves:

```sh
recall export --out archive.json
recall import archive --json archive.json --apply --reindex
recall import mem0 --json mem0-export.json --apply
recall import zep --json zep-facts.json --apply
recall import auto-memory --root ~/.claude/projects --apply
recall import local --topics storage --db ~/.recall/db/my-project.sqlite3 --apply
recall migrate --from old.sqlite3 --apply
recall reindex --missing-only
```

`import local` seeds a project store with a topic-scoped slice of the home graph, `migrate` converts a pre-0.6 legacy database, and `reindex --missing-only` backfills embeddings after either. The full identity model and adapter formats are in [import-export.md](import-export.md).

## Wiring an assistant

This is where the push loop lands. Once synced, a hook compiles the graph against every prompt and injects a mini-index primer with contradiction and staleness flags; the stop gate holds a turn that ignored a flagged cell or claimed success without running verification; the optional write gate (`--write-gate`, fail-closed) holds turns that produced no durable write; and a background maintenance tick, the same pass as `recall maintain`, fires after released turns.

```sh
recall claude sync             # dry run: reports what would change, writes nothing
recall claude sync --apply     # hooks, MCP registration, skills tree, auto-memory import
recall claude status
recall codex sync --apply      # MCP registration plus an AGENTS.md block
recall codex status
```

Any other MCP client points at the bundled `recall-mcp` server directly (with `RECALL_DB` naming the store); it exposes the same engine as nineteen tools over stdio.

From here, the reference pages: [cli.md](cli.md) for every verb and flag, [mcp.md](mcp.md) for the tool contracts, [integrations.md](integrations.md) for hook behavior, the write gate, and troubleshooting, and [import-export.md](import-export.md) for archive and adapter detail.
