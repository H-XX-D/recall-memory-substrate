# Changelog

All notable changes to Recall will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Effective confidence** (`src/core/evidence.ts`): every cell now carries a
  living, graph-computed confidence alongside its immutable stated one —
  `clamp01(stated × actor-calibration + support − challenge)`, derived
  one-hop from incoming `supports`/`contradicts`/`concerns` relations and
  `*-supports`/`*-contradicts` hyperedges, recomputed on every read with no
  LLM involved. Search ranking consumes the effective value (challenged
  cells sink even though challenge edges raise their graph degree — the
  ranking-inversion class found in stress testing), compile packets render
  it per cell as `eff:<value>(challenged|supported|actor-discounted)`, and
  actor discounts use the overconfidence signal (contradicted rate × mean
  confidence-when-wrong) so humble-but-right writers are never penalized.
  Pinned by a new test suite and a new adversarial retrieval gate case.
- **Graph reflexes** (`watch` program operation): a hyperedge program that
  baselines against its own previous run, trips when the bundle's live
  effective confidence moves more than `delta`, and — with `--derive` —
  files a concern against a configured target cell through the admission
  gate, attributed to `program:<id>` so reflexes accumulate per-actor
  calibration like any other writer. Untripped watch runs derive nothing:
  silence means verified stability. Consequents file claims, never value
  assignments — belief revision propagates as audited evidence, one
  admission at a time.
- **Tripwire bundles**: scored hyperedge programs now price their members
  from live effective confidence (`averageEffectiveConfidence` in the score
  output; stated-confidence average retained for explainability). A scored
  evidence bundle — a deploy gate, a launch review — loses score on its
  next run when any member is contradicted anywhere in the graph, with no
  model involved. Pinned by an end-to-end tripwire test.

- Real HTTP embedding backends: `RECALL_EMBEDDING_URL` (+ `RECALL_EMBEDDING_MODEL`,
  `RECALL_EMBEDDING_API_KEY`) plug Ollama or any OpenAI-compatible embeddings
  endpoint into the backend-aware semantic index. External failures latch off
  per process and fall back to `hash:v1`, so writes never block on an embedding
  service. `recall semantic reindex` rebuilds under the active backend.
- Closed-loop calibration v1: `recall calibration` scores each writing actor's
  stated confidence against survived-contradiction outcomes (Brier score,
  contradicted rate, overconfidence signal). Only `contradicts` references that
  resolve to actual cells count toward the score.
- Agent coordination (ACP): a durable agent-to-agent request queue over the same
  store — `recall acp send / list / show / process / run` plus matching MCP tools.
- Operator runs (`recall operate once/list/show`), workflow allocation
  (`recall workflow allocate`), pages (`recall page`), storage stats
  (`recall storage`), trust and beliefs reports, blind locks, and compaction.
- MCP server idle self-exit: the stdio server shuts down after an idle period
  (default 30 minutes, `RECALL_MCP_IDLE_EXIT_MS`, `0` disables) so abandoned
  spawns no longer accumulate; clients respawn on demand.
- Public benchmark harness: `npm run bench` and `npm run bench:public` against a
  reproducible synthetic corpus — see `docs/19_PUBLIC_BENCHMARK.md`.
- Adversarial retrieval-quality test gate: IDF, stemming, graph prior, recency
  decay, and literal code-symbol matching are pinned by tests.

### Fixed

- Python toolkit, JS/TS code extractor: exported const data bindings
  (`export const PLANS = {...}`) are now extracted as `const-data` symbol
  cells; previously only functions and classes were captured, leaving the
  most change-sensitive symbols (catalogs, configs) invisible to
  `subgraph --entity` queries.
- Python toolkit, code linker: JS import specifiers (`./plans.mjs`) resolved
  under Python-style dot-splitting to the file *extension*, so `code-imports`
  hyperedges were never created for JS/TS projects; module file stems also
  kept their `.mjs`/`.ts` suffixes. Both sides now share language-aware stem
  derivation (relative paths, `node:` builtins, bare packages, Python dotted
  modules).
- Python toolkit, code linker: link discovery now targets only the newest
  cell generation per title (older generations are kept for audit by
  `--rebuild` supersedure but previously duplicated every discovered edge);
  `--include-superseded` restores the old behavior.
- Python toolkit, JS/TS extractor: `--rebuild` now warns when code cells
  reference paths missing from the scanned tree (renamed or deleted files
  leave stale active cells; detection-only, retirement semantics planned).
- New DB-free regression suite: `python/tests/toolkit_unit_tests.py`
  (19 checks pinning the fixes above).

### Changed

- Lexical retrieval rebuilt on SQLite FTS5 + BM25 (porter stemming, IDF), with
  hybrid ranking fusing graph relation degree, calibrated confidence, and
  recency as exponential decay rather than sort key. Falls back to LIKE search
  on SQLite builds without FTS5; `compiler_state` reports the active backend.
  The FTS shadow table is trigger-synced, so writes from older binaries keep
  the index consistent; existing databases backfill on first open.
- Compile is graph-aware: each selected cell's incoming `contradicts`/`concerns`
  relations surface in the conflicts section with expansion handles (cap 6 per
  cell + overflow marker).
- Reference resolution handles the short `recall://cell/<id>` form everywhere —
  relations, compile translation, health findings, calibration; legacy
  address-form relation targets migrate to bare node ids on first open.
- Admission warns on near-duplicate creates (title Jaccard / content cosine vs
  active cells), naming the existing cell and suggesting `update`/`supersede`;
  it also warns (never rejects) when a title exceeds 20 words.
- Databases run in WAL journal mode (CLI, MCP server, daemon, and ACP workers
  share one file).
- Compile packets compress titles (20 words in `relevant_memory`, 12 in
  reference/cell-state/health lines) and cap translated references at 6 per
  cell with an overflow marker.
- Docs: `06_HYPEREDGE_PROGRAMS.md` reframed as `06_ADVANCED_GRAPH_OPERATIONS.md`,
  `14_ADDRESSABLE_CELLS_AND_HYPERNETWORKS.md` renamed to
  `14_ADDRESSABLE_CELLS_AND_GRAPH_VIEWS.md`, and `19_PUBLIC_BENCHMARK.md` added.
- Test suite grew to 83 unit/integration tests and 94 end-to-end checks.

## [0.1.0] - 2026-06-01

Initial public release — an early, honest working runtime for auditable agent
memory.

### Added

- Strict `recall.write.v1` admission path with firewall checks and rollback.
- SQLite-backed graph store with addressable cells and tag-composed subgraphs.
- Local semantic search with a deterministic hash backend.
- Encrypted Secrets side graph with explicit save confirmation.
- CLI, read-only TUI, and stdio MCP server.
- Background daemon maintenance path with SQLite-backed lease control.
- N-ary hyperedges, sandboxed hyperedge programs, DAG overlays, holonomy
  analysis, derivation closure, and eval persistence.
- End-to-end release smoke script covering user and agent workflows.
- Real-embedding semantic backend (`mpnet:v1`, 768-dim,
  sentence-transformers `all-mpnet-base-v2`) via the documented
  `RECALL_EMBEDDING_COMMAND` plug-in point. Ships two Python scripts:
  `python/scripts/recall_mpnet_embedder.py` (single-call adapter for
  per-query and per-write embedding) and
  `python/scripts/recall_semantic_real.py` (batched standalone
  indexer with `query` / `compare` / `verify` / `status` subcommands).
  Optional dependency pinned in `python/requirements-semantic.txt`.
  The default `hash:v1` backend remains zero-dependency and unchanged.
- Enforcement hook templates in `python/hooks/`: UserPromptSubmit
  injection (`recall_inject_context.py.sample`), Stop/SubagentStop
  writeback reminder (`recall_writeback_reminder.py.sample`), and
  PreToolUse guard (`recall_pretooluse_guard.py.sample`) for hard
  blocking of mutations without a recorded rationale cell.
- Compliance instrumentation: `python/hooks/audit_compliance.py`
  (point-in-time score) and `python/hooks/longitudinal_tracker.py`
  (snapshot + trajectory analysis: rationale quality, rework rate,
  enforcement events, continuity value).
- Comprehensive test suites: `python/hooks/test_hooks.py` (hook +
  tracker + adapter tests), `python/tests/system_tests.py` (10
  stress + 10 capability tests), `python/tests/competitive_tests.py`
  (head-to-head matrix vs 6 competitor memory architectures).
- Enforcement strategy doc: `docs/17_ENFORCING_USAGE.md` covering
  the four-tier discipline (system prompt, inject hook, writeback
  hook, PreToolUse guard) with rollout guidance and longitudinal
  metrics interpretation.

[Unreleased]: https://github.com/H-XX-D/recall-memory-substrate/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/H-XX-D/recall-memory-substrate/releases/tag/v0.1.0
