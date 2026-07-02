# R5 Routing / Federation: current residency contract

Date: 2026-06-26
Status: core routing/federated-read slice implemented on `rewrite/integration`

R5 gives v5 a deterministic answer to "which SQLite local does this request
use?" and a read-only union for home-scope retrieval across locals.

## Module Map

| Module | Role |
|--------|------|
| `src/routing.ts` | Recall home paths, project registry, cwd/slug resolution, local graph discovery |
| `src/federated-store.ts` | Read-only `Store` union over home/project locals with graph-prefixed keys |

## Routing Contract

`RECALL_HOME` relocates the central model. By default, the home local is:

```text
~/.recall/db/home.sqlite3
```

The same DB carries the project registry table. Registered project locals live
beside it under boring slug filenames:

```text
~/.recall/db/<project-slug>.sqlite3
```

Resolution order:

1. `RECALL_DB` wins as an explicit single-DB override.
2. The deepest registered project root containing `cwd` wins.
3. Otherwise the home local wins.

Project root is the stable registry identity. Slugs are human routing labels and
federated graph prefixes. Slug collisions and the reserved `home` graph are
disambiguated with a short root hash.

## Federation Contract

`FederatedReadStore` implements the v5 `Store` interface as a read-only union.
Each returned cell key is prefixed as:

```text
<graph>:<local-key>
```

Edges, lineage keys, program keys, and neighbor links are prefixed with the same
graph. Trust and relation math stay inside each local; the union does not merge,
deduplicate, or reconcile across graphs.

Writes always throw. A caller must route writes to a concrete home or project
local first.

## Deferred From This Slice

- CLI commands for `init`, `projects`, and `where`
- MCP per-call `project` routing
- automatic home read-union use in CLI/MCP surfaces
- first-run migration from legacy `global.sqlite3`
- federation over future R3/R6/R8 surfaces beyond the current `Store` contract
