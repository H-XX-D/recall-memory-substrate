# Changelog

## 0.6.1 - 2026-07-03

Keeps SQL query ability while the cell stays an evolvable JSON blob: MAL becomes the operational language over indexed SQLite columns rather than trading queryability away.

- Adds VIRTUAL generated columns on `cells` derived from the JSON blob via `json_extract` (`created_at`, `updated_at`, `project`, `effective`), each indexed. No write duplication and no drift: the blob stays the single source of truth; the columns are computed and indexed by SQLite. Idempotent on open (uses `PRAGMA table_xinfo` so reopen does not re-add columns), so migrated and existing DBs gain them automatically.
- Adds `SqliteStore.cellsCreatedSince(iso, limit)`, a temporal read pushed down to the indexed `created_at` column instead of scanning and parsing every row. Verified against a 1,184-cell store: the query plan uses `idx_cells_created_at`.

## 0.6.0 - 2026-07-03

Phase 1 of the subsystem port: store foundation + data migration. The MAL store gains the rich overlay tables and can read pre-0.6 memory.

- Adds `hyperedges`, `semantic_index`, and `dag_overlays` tables to the store, with `putHyperedge`/`listHyperedges`, `putSemanticVector`/`getSemanticVector`, and `putDagOverlay`/`listDagOverlays` accessors.
- Adds `recall migrate --from <old.sqlite3> [--apply] [--db <path>]`, a dry-run-first, one-shot migration from the legacy `graph_nodes` schema into the MAL `cells`/`edges` store. Cell-level lossless: any legacy field with no first-class MAL home is preserved under `cell.props._migrated`. The old database is opened read-only and never mutated.
- Verified against a 1,184-cell store: cells, 1,159 relations, 5 hyperedges, and 1,184 semantic vectors migrate, and `recall compile` then sees the memory.

## 0.5.2 - 2026-07-03

Wires the two under-used relation primitives to real behavior.

- `depends_on` now surfaces in the compiled context packet under a `dependencies:` section, flagging any dependency whose target is no longer active (e.g. superseded), so a plan built on a retracted foundation is visible at read time. Previously `depends_on` was validated and stored but consumed by nothing.
- Admission emits a non-blocking warning when a newly admitted cell depends on a target that is already superseded. The write still stands; the caller is told what it leaned on.
- `inspectCell` now returns `derivedFrom` (what a cell was derived from) and `derivations` (what was derived from it), giving the `derived_from` provenance marker a reader.

## 0.5.1 - 2026-07-02

- Fixes the build to remove `dist/` before compiling, so the published tarball no longer carries stale artifacts from the previous nested source layout. 0.5.0 was functional but shipped dead `dist/src/**` files.

## 0.5.0 - 2026-07-02

Transitions the published `recall-memory-substrate` package onto the v5 Memory
Abstraction Layer core and ships two previously deferred surfaces.

- Adds the MCP stdio server (`recall-mcp`): a hand-rolled JSON-RPC 2.0 dispatcher over stdin/stdout with a lean tool set, database resolved from `RECALL_DB` or the home local.
- Adds the Stop-gate write-back lifecycle: a `UserPromptSubmit` hook stamps turn start, and the `Stop` hook holds the turn until a durable cell was admitted this turn, re-injecting a fill-or-reject write template.
- Adds admission fill-or-reject (a field still equal to its template description is rejected) and dangling-edge rejection (an edge target that resolves to no cell is rejected, not silently dropped).
- Adds `resolveCell`, accepting every id form the CLI and peek accept: full key, `>=4`-hex id prefix, handle, and `graph:uuid` address.
- Keeps the published npm identity `recall-memory-substrate` and the `recall` CLI command; the CLI/library/docs no longer reference the interim `recall-mal` name.

## 0.1.0 - 2026-06-26

Initial public preview of Recall MAL.

- Adds typed v5 memory cells, handles, MAL row rendering, and strict proposal validation.
- Adds admission checks for schema, public-data safety, secret screening, calibration, and encrypted secret aliases.
- Adds SQLite storage, FTS5/BM25 search with fallback, evidence mass walks, and store stats.
- Adds context packet compile/formatting, lazy cell inspection, and expansion handles.
- Adds central project routing, local graph discovery, and federated home reads.
- Adds deterministic standing programs and `recall operate once`.
- Adds CLI commands for project routing, status, compile, search, cell inspection, validation, admission, operation, export, and dry-run-first imports.
- Adds Mem0, Zep, Claude auto-memory, and portable cell archive import/export adapters.
- Adds Python helper scripts that delegate validation, admission, and inspection to `recall`.
- Adds installed-artifact release acceptance coverage for CLI/library/Python behavior and graph lattice structure.
- Fixes project routing across canonicalized/symlinked roots so nested cwd resolution matches registered project roots.
