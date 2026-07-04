# Changelog

## 0.9.0 - 2026-07-03

Phase 4 of the subsystem port: adapters and ingest. Import hardening, the mem0/zep/auto-memory/local/claude-sync adapters, and a v2 export archive land on top of the Phase 1 to 3 store, retrieval, and graph work.

- Adds deterministic import keys in `src/adapters.ts`: `importCellKey(fingerprint)` derives a stable key from a record's fingerprint, and a one-pass batch index builds fingerprint and entity lookups across the whole import batch instead of scanning per item. Adds an active-prior lookup that unions a pre-batch active cell with any same-batch admitted cell, capped at `MAX_PRIOR_VERSIONS` (1000) so the supersedes edge list cannot grow unbounded across repeated imports of the same record.
- Fixes same-batch duplicates (an identical record listed twice in one export) and content duplicates (a record whose fingerprint prop is gone but whose content still matches) to skip identically in both dry-run and apply, closing a parity gap where dry-run and apply could disagree on what would be skipped.
- Adds proposal lifecycle, quality, and subject tag families, screened by the firewall alongside the existing tag families. Adds a zep expired marker so an invalidated zep record's predecessor is correctly stamped as superseded on reimport instead of staying active.
- Adds a v2 export archive (`EXPORT_SCHEMA_VERSION_V2`, `recall.cells.export.v2`): alongside cells and edges, the archive now carries hyperedges, semantic vectors, DAG overlays, and the program run, eval run, and operator run ledgers. Adds `reindexSemantic(store, opts)` to backfill missing semantic vectors, `recall export --out <file>` to write the archive straight to disk, `recall import archive --reindex` to reindex on import, and a standalone `recall reindex [--missing-only]` verb.
- Adds `importGlobalToLocal` in `src/local-import.ts`: pulls a project or topic-scoped subgraph out of a source store (typically the home or global db) and lands it in a local store through the shared import admission engine, then rehydrates any hyperedge whose members all landed. Exposed as `recall import local --project <name> [--topics a,b] [--limit N] [--no-hyperedges] [--apply]`. The source store is read-only throughout.
- Adds `recall claude sync [--apply] [--keep-automemory] [--root path]` and `recall claude status` in `src/claude-sync.ts`, composing the existing auto-memory and export transforms with home-isolated default paths so a dry run touches no disk and an apply run writes a `.bak` backup before overwriting anything. Adds `DEFAULT_AUTO_MEMORY_ROOT` as the default root for auto-memory import when no root is given.
- Adds a stdin byte cap (`MAX_IMPORT_BYTES`, 128 MiB) to `--json -` imports, rejecting an oversized payload before it is parsed. Import commands now return a nonzero exit code when every item in the batch was rejected, instead of always exiting 0.
- Fixes `src/local-import.ts` hyperedge rehydration, which called `hyperedgesForCell` without a limit and silently lost any cell with more than the store's default 50 hyperedges before the `MAX_HYPEREDGES` (5000) accumulation cap ever applied; the call now passes `MAX_HYPEREDGES` explicitly.
- Verified against the migrated 1,184-cell store: a full export and reimport into a fresh store round-trips every v2 section (cells, edges, hyperedges, semantic vectors) with matching counts; `recall reindex --missing-only` backfills semantic vectors and a lexical search over the reimported store returns hits; `recall import local --project Recall-GitHub-Clean --limit 50` dry-run against a temp target reports a sane, correctly truncated selection; a mem0 fixture import run twice creates once then skips everything on the second run.

## 0.8.0 - 2026-07-03

Phase 3 of the subsystem port: graph operations. Hyperedges, DAG analysis, deterministic derivation, deeper standing programs, evals, and a memory health engine land on top of the Phase 1/2 store and retrieval work.

- Adds a rich hyperedge API in `src/hyperedges.ts`: `HyperedgeMember` (key, role, ordinal, optional weight and metadata) replaces bare member strings; `normalizeHyperedgeMembers` reads legacy shapes (plain strings, `nodeId`-keyed objects) back into the rich shape so old rows never brick a read; `addHyperedge` resolves every member against the store before writing, so a hyperedge can never reference a nonexistent cell. CRUD and membership: `addHyperedge`, `getHyperedge` (exact id or unique 8-char prefix), `listHyperedges`, `hyperedgesForCell`. Fixes the migration path in `src/migrate.ts` so migrated hyperedge members map onto the new normalized shape instead of losing role/ordinal information.
- Adds a DAG overlay analyzer in `src/dag.ts`: `analyzeDagOverlay` walks a `DagOverlay` for cycles and produces `DagHolonomyWitness` entries (a `DagAnalysis` result), and `addDagOverlay` persists overlays with the same id-prefix resolution as hyperedges. A `dag_overlays` migration adds the backing table and `recall dag analyze <id>` / `recall_dag_analyze` MCP tool render the analysis; with `derive:true`, witnesses and cycles are admitted as keyed derived writes.
- Adds deterministic derivation in `src/derivation.ts`: `derivationHash(kind, value)` produces a stable `drv_<kind>_<hex24>` key (a clean break from the legacy `<kind>:<hex24>` format, whose colon is ambiguous once a federation prefix is layered on top). `deriveAdmit` probes the store at the derived key first: an existing active cell there returns a side-effect-free duplicate result via the new `AdmissionResult.duplicateOf` field (no put, no supersede walk, no reindexing). A non-active occupant (superseded or annexed) is never overwritten; the re-derivation instead admits under a fresh random key, mirroring the legacy re-derive-under-a-new-id behavior.
- Deepens standing programs in `src/programs.ts`: every program run is recorded to a `program_runs` ledger (`recordProgramRun`, `listProgramRuns`, `getProgramRun`, all with id-prefix resolution), hyperedge hooks can now target cells with explicit roles, drift output carries a `concernTarget`, and trend analysis reports an `acceleration` value (slope of the late half minus slope of the early half) alongside the existing slope and direction.
- Adds a model-free eval harness in `src/evals.ts`: `runRecallEval` runs a default suite (`search-smoke`, `semantic-smoke`, `compile-smoke`, `key-handle-consistency`, `edge-targets-resolve`, `effective-confidence-bounds`, `depends-on-acyclic`, `prefix-resolution`) and records results to an `eval_runs` ledger. `recall eval run` / `recall eval list` / `recall eval show` and the `recall_eval_run` MCP tool expose it; with `derive:true`, the eval result is admitted as a keyed derived write.
- Adds an `operator_runs` ledger in `src/operator.ts`: `recordOperatorRun` writes each operator tick and prunes the ledger to the newest 1000 rows immediately after insert, so the table never grows unbounded.
- Adds SQL push-down retrieval in `src/subgraph.ts`: `subgraphCells(store, filter)` takes a `SubgraphFilter` (kinds, project, topics, entities, since, limit, all AND-composed, every listed value within an array family required) and uses the store's `activeWhere` push-down when available, falling back to app-side filtering otherwise. Golden tests confirm both paths return identical rows, in identical order, with ties broken on key ascending.
- Adds `activeByProject` to the store (`src/store.ts`): a thin wrapper over `activeWhere` scoped to one project, used by `src/pages.ts` to seed page views without an app-side scan.
- Adds a memory health engine in `src/analysis.ts`: `analyzeMemory` returns a `MemoryHealthReport` with belief pressure, stale findings, contradiction findings, dangling-edge reports, provenance concentration, critical warnings, and suggested next actions. `recall health` and the `recall_health` MCP tool surface it; with `derive:true`, the report is admitted as a keyed derived write.
- Extends `recall compile` with new packet sections: a `health=` summary line in `compiler_state`, plus `standing_programs:`, `translated_references:`, and `reference_parameters:` sections, all rendered within the existing word budget.
- Adds CLI verbs: `recall hyperedge add|show|list`, `recall dag add|show|list|analyze`, `recall program runs`, `recall program show-run`, `recall eval run|list|show`, `recall health`, `recall operate once|list|show`. Adds MCP tools: `recall_hyperedge_add`, `recall_hyperedge_show`, `recall_hyperedge_list`, `recall_dag_analyze`, `recall_program_run`, `recall_program_runs`, `recall_eval_run`, `recall_subgraph`, `recall_health`.
- Verified against the migrated 1,184-cell store: `hyperedge list` returns normalized members (key, role, ordinal) on all 5 migrated hyperedges; `health` produces populated sections; `eval run` records a run and honestly reports dangling `depends_on` targets on migrated data while every other invariant passes; `compile` renders the new sections within the 900-word budget.

## 0.7.0 - 2026-07-03

Phase 2 of the subsystem port: retrieval and compile richness. Semantic search, hybrid fusion re-ranking, and curated views land on the MAL base.

- Adds `src/semantic.ts`: a hash-fallback embedding core (`hashEmbedding`, `cosine`, `embedTextRecord` with an optional HTTP-via-curl backend), `indexCell`, and `semanticSearch` (cosine scan with a dims-mismatch guard). Every admitted cell is auto-indexed into `semantic_index`, and a new `recall_semantic` MCP tool exposes cosine search.
- Adds `src/retrieval.ts`: a shared Unicode FTS phrase builder (reused by the store), and `fuseCandidates`, a hybrid re-ranker combining normalized BM25, a graph-degree prior, the stored effective-confidence, and recency decay, with per-kind lexical factors (`TASK_CONTEXT_KIND_FACTOR`).
- `compileContext` now fetches a wide candidate pool and drives packet ordering through the fusion, so a high-confidence low-BM25 cell can outrank a saturated keyword stub; challenged cells surface as low-trust.
- Adds `src/references.ts`: cell-reference parsing/resolution and field-path addressing over a cell (`resolveCellReference`, `cellReferenceView`, `selectCellPath`), plus a `recall_ref` MCP tool.
- Adds `src/pages.ts`: curated named views over the graph by kind (`getRecallPage`, `buildPageIndex`), plus a `recall_page` MCP tool.
- Verified against the migrated 1,184-cell store: semantic search, fused compile ordering, and pages all return sensible results.
- Note: migrated (pre-0.7) stores carry old-model embedding vectors that the dims-guard skips, so semantic search returns few or no hits until embeddings are backfilled (loop over `store.active()` calling `indexCell`).

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
