# Recall MCP server

`recall-mcp` is a Model Context Protocol server for the Recall memory
substrate. It speaks JSON-RPC 2.0 over newline-delimited stdio (no MCP SDK
dependency): each line of stdin is one JSON-RPC request, each response is
written to stdout as one JSON line. It exposes 18 tools that read and write a
Recall SQLite store: status and search, context compilation, single-cell and
reference lookups, curated pages, tag-composed subgraph queries, durable
writes, hyperedges, DAG overlay analysis, standing programs, the model-free
eval suite, and a memory health report.

## Starting the server

`recall-mcp` resolves its database from the `RECALL_DB` environment variable.
If `RECALL_DB` is unset, it falls back to the home local store at
`~/.recall/db/home.sqlite3`. The server opens that database once at startup
and keeps it open for the life of the process; it closes the database and
exits when stdin closes.

Point an MCP client at the `recall-mcp` binary. Example client configuration:

```json
{
  "mcpServers": {
    "recall": {
      "command": "recall-mcp",
      "env": {
        "RECALL_DB": "/path/to/project/.recall/store.sqlite3"
      }
    }
  }
}
```

Omit the `env` block to use the home local store instead of a project-specific
one.

The server answers three JSON-RPC methods: `initialize` (protocol version and
server info), `tools/list` (the tool array below), and `tools/call` (invoke a
tool by name with an `arguments` object). A request with no `id` is treated as
a notification and receives no response.

## Conventions

Every tool call returns its result as a JSON string inside the standard MCP
`content` array (`{ "content": [{ "type": "text", "text": "<json>" }] }`). The
inner JSON is what each tool section below documents as "returns."

Unknown or unresolved identifiers do not raise a protocol-level error; they
come back as an ordinary JSON payload with an `error` field, for example
`{"error": "unknown page: bogus"}` or `{"error": "unknown dag overlay: xyz"}`.
An actual JSON-RPC error (the `error` field on the envelope, not inside the
result text) is reserved for malformed requests: a missing `name` param, a
missing method, or an unknown tool name.

Several tools accept a `derive: true` flag. Deriving computes a deterministic
key from the operation's inputs (a `drv_<kind>_<hash>` cell key) and admits a
witness cell pinned to that key. Running the same derivation again is a no-op:
the response reports `duplicateOf` (or, for `recall_dag_analyze`, a
`duplicates` count) instead of writing a second cell. This makes repeated
`derive: true` calls safe to retry.

## Reading

### recall_status

Returns graph counts and the active lexical backend.

Parameters: none.

Returns: `{ cells, activeCells, edges, indexedCells, lexicalBackend }`, where
`lexicalBackend` is one of `fts5-bm25`, `like`, `federated`, `cosine`, `fused`.

### recall_storage

Returns storage stats: database path and size on disk, per-table row counts,
and cell size statistics.

Parameters: none.

Returns:

```json
{
  "databasePath": "/path/to/store.sqlite3",
  "databaseBytes": 1048576,
  "tables": {
    "cells": 120,
    "edges": 340,
    "hyperedges": 4,
    "semanticVectors": 118,
    "dagOverlays": 2,
    "programRuns": 15,
    "evalRuns": 3,
    "operatorRuns": 7
  },
  "averageCellBytes": 812,
  "maximumCell": { "key": "...", "handle": "obs_a1b2", "title": "...", "bytes": 4096 }
}
```

`databaseBytes` includes the `-wal` and `-shm` sidecar files alongside the main
database file, since write-ahead logging can hold a substantial share of live
data in the sidecars.

### recall_search

Lexical search over the store (FTS5/BM25 when available, LIKE fallback
otherwise).

Parameters:
- `query` (string, required)
- `limit` (number, optional, default 10)

Returns: an array of `{ id, kind, title, score }`, where `score` is rounded to
two decimal places.

Example call: `{ "query": "routing decision", "limit": 5 }`

### recall_semantic

Semantic (vector, cosine similarity) search over stored embeddings.

Parameters:
- `query` (string, required)
- `limit` (number, optional, default 10)
- `minScore` (number, optional; hits below this score are excluded)

Returns: an array of `{ key, handle, title, score, backend }`.

Embeddings are computed by a pluggable backend. By default, Recall uses a
deterministic local hash embedding (`hash:v1`, 256 dimensions, no network
call). Setting `RECALL_EMBEDDING_URL` switches to an HTTP embedding backend
(compatible with OpenAI's `{data:[{embedding:[...]}]}` response shape or
Ollama's `{embeddings:[[...]]}` shape); `RECALL_EMBEDDING_MODEL` and
`RECALL_EMBEDDING_API_KEY` configure the model name and bearer token sent to
that endpoint. If the HTTP call fails or returns an unusable payload, indexing
falls back to `hash:v1` for that cell and a warning is written to stderr.
Cells are embedded automatically on admission; a store migrated from an older
version may need its cells re-indexed before semantic search returns hits.

Example call: `{ "query": "why did we pick sqlite", "limit": 5, "minScore": 0.2 }`

### recall_compile

Compiles a budgeted context packet for a task: a ranked, ID-first summary of
relevant memory, active beliefs, conflicts, dependencies, risks, tasks, cell
state, standing programs, translated references, and health signals, trimmed
to fit a word budget.

Parameters:
- `task` (string, required): the objective to compile context for
- `words` (number, optional, default 900): the target word budget
- `health` (boolean, optional, default true): include the memory health
  section (belief pressure, contradictions, staleness, next actions)
- `inlineRefs` (boolean, optional, default false): inline resolved reference
  values in the `translated_references` section
- `refParams` (boolean, optional, default false): include a
  `reference_parameters` section with per-reference type and target state
  detail

Returns: a plain text rendering of the context packet (not JSON), with one
section per packet field: `objective`, `compiler_state`, `relevant_memory`,
`active_beliefs`, `conflicts`, `dependencies`, `risks`, `tasks`, `cell_state`,
`standing_programs`, `translated_references`, `reference_parameters`,
`stale_or_low_trust`, `suggested_next_actions`, and `expansion_handles`. Each
section lists `- none` when empty. When the packet exceeds the word budget,
sections are trimmed from the back in a fixed order (reference parameters
first, standing programs never trimmed) until it fits.

Example call: `{ "task": "decide on the storage backend", "words": 600 }`

### recall_cell

Expands one cell by id, id prefix (four or more hex characters, must be
unique), handle, or graph-qualified address.

Parameters:
- `idOrAddress` (string, required)

Returns: `{ id, handle, kind, title, body, scores, status, edgesOut }`. An
ambiguous id prefix (matching more than one cell) raises an error rather than
returning silently the first match.

Example call: `{ "idOrAddress": "obs_a1b2" }`

### recall_ref

Resolves a cell reference of the form `handle#field.path` (or a bare handle
or key with no path) to its addressed value.

Parameters:
- `reference` (string, required)

Returns, when the target resolves: `{ targetId, handle, path, value, resolved: true }`.
When it does not resolve: `{ targetId, resolved: false }`. `value` is a
truncated preview (strings capped at 180 characters, arrays and objects
capped at 8 entries), not necessarily the full field content.

Example call: `{ "reference": "obs_a1b2#scores.effective" }`

### recall_page

Returns a curated, kind-filtered view over active cells.

Parameters:
- `name` (string, required): one of `index`, `reflections`, `objectives`,
  `workbench`, `witnesses`, `handoffs`, `team-metrics`, `agent-profile`,
  `user-profile`
- `project` (string, optional): restrict to one project
- `topics` (array of strings, optional): every listed topic must be present
  on a cell (AND) for it to be included
- `since` (string, optional): ISO date/time; filters on the cell's last
  update, not its creation time
- `limit` (number, optional)

Returns: `{ name, createdAt, filter, summary, cells }`. The `index` page
returns a summary of active cell counts with an empty `cells` array; every
other page returns matching cells newest-updated first. The kind mapping per
page:

| page | kinds |
| --- | --- |
| reflections | ref |
| objectives | obj, tsk, rsk |
| workbench | hyp, bel, rsk |
| witnesses | obs |
| handoffs | obs (gated: `tags.lifecycle` must include `handoff` or `session`) |
| team-metrics | ver, bel |
| agent-profile | bel (gated: `tags.entities` non-empty) |
| user-profile | bel (gated: `tags.entities` non-empty) |

Example call: `{ "name": "objectives", "project": "recall", "limit": 20 }`

### recall_subgraph

Tag-composed retrieval over active cells: every listed kind, project, topic,
entity, and time bound acts as an AND filter, and within each array family
(topics, entities), every listed value must be present on a cell for it to
match. Results are ordered newest-updated first.

Parameters:
- `kinds` (array of strings, optional)
- `project` (string, optional)
- `topics` (array of strings, optional)
- `entities` (array of strings, optional)
- `since` (string, optional): ISO date/time, filters on last update
- `limit` (number, optional, default 50)

Returns: an array of `{ key, handle, kind, title, updatedAt }`.

Example call: `{ "kinds": ["bel", "rsk"], "topics": ["storage"], "limit": 10 }`

## Writing

### recall_write

Admits a durable write proposal through the admission gate: schema
validation, secret screening, confidence attenuation, cell construction, and
(with a store) dedup, supersede, and effective-confidence recalculation from
graph mass.

Parameters:
- `kind` (string, required)
- `title` (string, required)
- `body` (string, required)
- `confidence` (number, required; must be in `(0, 1]`)
- `topics` (array, optional)
- `edges` (array, optional): each entry `{ relation, target, weight? }`

Additional proposal fields accepted by the underlying write path (not listed
in the tool schema but read from `arguments` if present): `entities`,
`sourceRefs`, `verification`.

Returns: `{ accepted, id, issues, warnings, attenuations }`. `id` is the new
or existing cell's key (an identical active cell with the same kind, title,
and body is deduplicated rather than duplicated, and `accepted` is still
`true` with a warning noting the dedup). `issues` is populated only when
`accepted` is `false`.

Example call:

```json
{
  "kind": "obs",
  "title": "Release check passed",
  "body": "The local package passed tests and npm pack dry-run.",
  "confidence": 0.92,
  "topics": ["release"]
}
```

## Graph structures

### recall_hyperedge_add

Creates a hyperedge grouping cell members under a kind and title. Members may
be given as bare cell key or handle strings, or as partial member objects;
each is resolved against the store, and an unresolved member raises an error
naming the missing reference.

Parameters:
- `kind` (string, required)
- `title` (string, required)
- `members` (array, required): strings or partial `{ key, role?, ordinal?, weight?, metadata? }` objects
- `metadata` (object, optional)

Returns: the created `Hyperedge`: `{ id, kind, title, members, metadata, createdAt }`.

### recall_hyperedge_show

Expands one hyperedge by id.

Parameters:
- `id` (string, required)

Returns: the `Hyperedge` object, or `{ error: "unknown hyperedge: <id>" }` if
not found.

### recall_hyperedge_list

Lists hyperedges, optionally filtered to those containing a given cell.

Parameters:
- `limit` (number, optional)
- `forCell` (string, optional): a cell key; when given, only hyperedges
  containing that cell are returned

Returns: an array of `Hyperedge` objects.

### recall_dag_analyze

Analyzes a stored DAG overlay for cycles and holonomy witnesses (places where
two structurally different edge-label paths connect the same pair of nodes,
signaling that the overlay's story about how one node leads to another is not
singular).

Parameters:
- `id` (string, required): the DAG overlay id
- `derive` (boolean, optional, default false)

Returns without `derive`: `{ analysis }`, where `analysis` is
`{ overlayId, isDag, topologicalOrder, cycles, witnesses }`. `witnesses` is
empty when the overlay is not a DAG (cycle detection takes priority). Each
witness carries `{ from, to, pathCount, signatures, concern }`.

Returns with `derive: true`: `{ analysis, derived: { accepted, duplicates, rejected } }`.
One `obs` witness cell is derived per holonomy witness; witnesses at or above
a concern threshold additionally derive an `rsk` concern cell; each detected
cycle derives an `rsk` cycle cell. Re-running against an unchanged overlay
counts entirely toward `duplicates`, not `accepted`.

Returns `{ error: "unknown dag overlay: <id>" }` if the overlay id does not
resolve.

Example call: `{ "id": "overlay-1", "derive": true }`

## Programs and health

### recall_program_run

Runs a standing program cell (a deterministic, no-LLM check stored as a `prg`
cell) by key or handle.

Parameters:
- `key` (string, required): the program's cell key or handle
- `derive` (boolean, optional, default false): admit the program's witness
  (if any) as a keyed derived write

Returns: `{ id, operation, tripped, witness, derived }`. `operation` is one of
`score`, `emit_witness`, `tag_projection`, `watch`, `drift`, `quorum`,
`trend`, `reflex`, `allocate`. `tripped` and `witness` are present only for
operations that produce them (`watch`, `drift`, `trend`, and conditionally
`reflex`/`allocate`/`quorum`); `witness` here is just the witness title.
`derived` is `{ accepted, duplicateOf }` when `derive` was requested, else
omitted. Returns `{ error: "unknown program: <key>" }` if the key does not
resolve to a cell.

Example call: `{ "key": "prg_watch_conf", "derive": true }`

### recall_program_runs

Lists program run history, optionally filtered to one program.

Parameters:
- `key` (string, optional): a program cell key or handle; when given, only
  runs for that program are returned
- `limit` (number, optional)

Returns: an array of `{ id, operation, tripped, witness }`. Returns
`{ error: "unknown program: <key>" }` if `key` is given but does not resolve,
or `{ error: "program run history is unavailable on this store" }` if the
underlying store does not support run history.

### recall_eval_run

Runs the default model-free eval suite (pure, read-only checks over the
store: search/semantic/compile smoke tests plus structural invariants like
key-handle consistency, edge-target resolution, effective-confidence bounds,
depends-on acyclicity, and prefix resolution).

Parameters:
- `derive` (boolean, optional, default false): admit the eval result as a
  keyed derived `ver` cell

Returns: `{ name, passed, score, cases }`, where `cases` is an array of
`{ name, passed }`. With `derive: true`, an additional `derived: { accepted, duplicateOf }`
field is included. An unchanged eval outcome (same name, passed, score, and
per-case results) collides with a prior derivation instead of creating a new
witness cell.

### recall_health

Produces a memory health report: belief pressure (support/contradiction
weight per belief, with a trust/watch/reverify/downgrade recommendation),
stale cells (expired, due for reverification, or aged past their stability
class), contradiction and concern edges between active cells, dangling edges
(whose target no longer resolves to a cell), provenance concentration risk,
critical warnings, and suggested next actions.

Parameters:
- `derive` (boolean, optional, default false): admit a day-bucketed witness
  cell summarizing the report

Returns: the full `MemoryHealthReport` object: `{ createdAt, stats, provenance, beliefs, stale, contradictions, dangling, criticalWarnings, nextActions }`.
With `derive: true`, a `derived: { accepted, duplicateOf }` field is appended.
Because the derivation key is bucketed by calendar day (UTC), only the first
`derive: true` call on a given day admits a new witness cell; later calls the
same day report `duplicateOf` regardless of whether the report content
changed.
