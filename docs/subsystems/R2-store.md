# R2 Store: current MAL persistence and retrieval contract

Date: 2026-06-26
Status: core store/retrieval slice implemented on `rewrite/integration`

R2 owns the durable graph substrate: cells, edges, retrieval, and read-side
store statistics. It keeps relations normalized instead of embedding them in the
cell JSON blob.

## Module Map

| Module | Role |
|--------|------|
| `src/db.ts` | Opens `node:sqlite`, creates normalized `cells` and `edges` tables |
| `src/store.ts` | `SqliteStore`, content-key dedup probes, FTS5/LIKE lexical search, stats |
| `src/mass.ts` | Incoming support/challenge mass over normalized edges |
| `src/compile.ts` | Mini-index read path over the store search API |

## Persistence Contract

`SqliteStore.put(cell)` stores the cell body as JSON without `edgesOut`, then
rewrites the source cell's outgoing edges in the `edges` table. Reads rehydrate
`edgesOut` from the normalized edge rows.

The store exposes:

- `get(key)` and `getByHandle(handle)`
- `all()` and `active()`
- `neighbors(key)` for incident in/out edge walks
- `findByContentKey(kind, key)` for admission dedup
- `search(query, { limit })`
- `lexicalBackend()`
- `stats()`

`admit(..., { store })` uses this R2 surface for dedup, supersession demotion,
target effective-confidence recompute, and self recompute.

## Retrieval

On construction, `SqliteStore` attempts to create a `cells_fts` FTS5 table using
Porter tokenization over handle, title, tags, summary, and body. Each `put()`
keeps the lexical index synchronized with the stored cell.

`search()` uses FTS5 BM25 when available and falls back to escaped `LIKE` search
if FTS5 is unavailable or rejects a match expression. Search returns active
cells only; superseded and annexed cells can still be read directly by key but do
not appear in lexical retrieval.

`compile()` delegates lexical retrieval to the store and renders the returned
hits as mini-index lines.

## Stats

`stats()` reports:

- total cells
- active cells
- normalized edge count
- indexed cell count
- active lexical backend (`fts5-bm25` or `like`)

This is a narrow R2 stats surface, not the full storage-footprint report from the
old tree.

## Deferred From This Slice

- semantic/vector embedding index
- DAG overlay storage and holonomy derivations
- derivation-key idempotence
- hyperedges and program run storage
- full storage-footprint reports
