# How Recall works

Recall is a local memory system for AI agents and the people who work with them. It keeps everything in one SQLite file per graph, runs entirely on your machine, and exposes the same engine through a CLI, an MCP server, and a TypeScript library. This page explains the model; the reference pages cover each surface in detail.

## Cells

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

- **Scores.** `conf` is the stated confidence at write time and never changes. `effective` is recomputed from the graph: support raises it, contradiction and concern lower it, weighted by how trustworthy each neighbor is. `currency` decays with age at a rate set by the cell's stability class (`stable`, `volatile`, or `ephemeral`), so old volatile facts fade while pinned or stable ones persist.
- **Provenance.** Who produced the cell (`human`, `llm`, `daemon`, `connector`, `program`, `external`), the producing actor's identity, and a verification level from `unverified` to `external`.
- **Tags.** Topics and entities are the retrieval surface; optional lifecycle, quality, and subject facets refine filtering.
- **Policy.** Sensitivity (`public`, `private`, `secret`), an optional expiry, and an optional reverify-after clock that resurfaces the cell for review.

## Edges

Cells connect through directed, signed edges with six relations: `supports`, `contradicts`, `concerns`, `depends_on`, `supersedes`, and `derived_from`. Edges are the single source of truth for how memories relate; scores are derived by walking them, never stored redundantly. When a new cell supersedes an old one, the old cell is demoted to `superseded` status and preserved with its lineage intact, so history is never destroyed.

Beyond pairwise edges, hyperedges group any number of cells into a typed, named structure with per-member roles and weights, and DAG overlays capture ordered dependency structure that can be analyzed for cycles and conflicting paths.

## The admission gate

Every write enters through one gate. A write proposal is a small JSON object (kind, title, body, confidence, optional tags and edges). The gate validates the schema, screens all text fields for credential patterns, rejects edges pointing at cells that do not exist, deduplicates identical content, applies confidence attenuation when a claim is stated more strongly than its evidence supports, and processes supersede chains. What comes out is a fully formed cell with derived scores. There is no path around the gate except restoring a portable archive.

Derived writes (program witnesses, health reports, analysis results) use deterministic keys, so re-deriving the same result is a no-op that returns the existing cell instead of stacking duplicates.

## Retrieval

Reads run through three engines that can be combined:

- **Lexical search** uses SQLite FTS5 with BM25 ranking over titles, bodies, summaries, and tags.
- **Semantic search** ranks by cosine similarity over stored embeddings. Every admitted cell is embedded automatically; a deterministic hash backend works with no configuration, and `RECALL_EMBEDDING_URL` (with optional `RECALL_EMBEDDING_MODEL` and `RECALL_EMBEDDING_API_KEY`) switches to a real embedding endpoint.
- **Subgraph retrieval** filters by kind, project, topics, entities, and time with AND semantics.

The compile step is the primary read surface: it takes a task description and a word budget and produces a context packet. Ranking is hybrid: BM25 fused with a graph-degree prior, the stored effective confidence, and recency decay, so a well-supported memory outranks a keyword-stuffed one. The packet groups results into sections (relevant memory, active beliefs, conflicts, dependencies, risks, tasks, cell state, standing programs, translated references, stale or low-trust items, suggested next actions) and trims to budget in a fixed priority order.

## Programs and the operator

A standing program is an ordinary `prg` cell whose spec selects member cells and applies one of nine deterministic operations on every run: `score`, `emit_witness`, `tag_projection`, `watch` (trip on a moved average), `drift` (watch plus per-member attribution), `quorum` (k of m distinct actors above a threshold), `trend` (slope, acceleration, and streaks over a window), `reflex` (a 32-entry boolean truth table over cell state), and `allocate` (rank open work by a pressure formula). Programs run without any model in the loop.

The operator is the deterministic between-turn tick: it decays currency, recomputes effective confidence from current neighbor state, runs all standing programs, and records the pass in a run ledger. Tripped programs emit witness cells through the admission gate, deduplicated by output, so an unchanged world produces no new cells.

## Evals and health

A built-in eval suite audits the store itself: search and compile smoke checks plus structural invariants (every edge target resolves, scores stay in bounds, dependency edges stay acyclic, handles and key prefixes resolve). The health engine analyzes belief pressure, staleness, contradictions, dangling edges, and provenance concentration, and can admit a once-per-day health witness into the graph. Both record their runs in ledgers.

## Maintenance

One command, `recall maintain`, runs the full upkeep pass: operator tick with witness derivation, the eval suite, the daily health witness, and semantic indexing of any unindexed cells. Every leg is idempotent, so the pass is safe at any frequency, and `recall service install` schedules it on a timer. Between explicit runs, the same tick fires from the assistant session hooks after each released turn.

## Projects and routing

Memory lives in graphs: one home graph per machine plus one graph per registered project. A small registry (kept in its own file, so a damaged graph never hides your project list) maps project roots to their stores. Commands route by explicit `--db`, then `--project`, then the deepest registered project containing the current directory, then home. Reads can federate across all local graphs; writes always target exactly one.

## Moving memory

Portable archives round-trip an entire graph (cells, edges, hyperedges, embeddings, overlays, and run ledgers) as one JSON file. Importers bring memory in from mem0 exports, Zep fact exports, and Claude Code auto-memory directories, with dry-run previews, exact idempotence on re-import, and supersede chains when a source record changes. See [import-export.md](import-export.md).
