# Daemon, MCP, Semantic Search, And Facet Subgraphs

## Daemon

Recall's daemon path must operate outside the LLM. The daemon can inspect graph
state and write maintenance observations through the same admission path as
other writes.

Commands:

```bash
recall daemon status
recall daemon run-once
recall daemon run-once --derive
recall daemon run --interval-ms 60000
recall daemon run --derive --interval-ms 60000
recall daemon plist
recall daemon install
recall daemon service-status
```

The current daemon pass records a maintenance observation with graph stats.
With `--derive`, it also schedules semantic reindexing and default eval closure.
Derived eval and maintenance writes are bucket-gated so repeated daemon ticks in
the same day skip duplicate graph cells instead of flooding the primary graph.
Daemon passes acquire a short SQLite-backed lease before writing; an overlapping
worker returns `daemon_lease_active` and does no graph write until the active
lease is released or expires. This is a first runtime hook for future stale
checks, contradiction scans, dedupe, and richer eval suites.

## Semantic Search

Recall now has a deterministic local semantic index. It uses hash embeddings so
the first install stays dependency-light and offline. This is not the final
semantic backend; it is the stable interface.

Command:

```bash
recall semantic "compact evidence packet"
recall semantic reindex
```

External embedding backends can be plugged in without changing the graph schema
by setting `RECALL_EMBEDDING_COMMAND`. The command receives JSON on stdin:

```json
{ "text": "memory text", "dims": 256 }
```

It must return either a JSON number array or `{ "vector": [0.1, 0.2] }`.
`recall semantic reindex` rebuilds vectors for the active backend.

## Facet Tags

The primary subgraph vocabulary is optional but useful:

```json
{
  "category": ["memory"],
  "type": ["witness"],
  "subject": ["compiler"],
  "project": ["Recall"],
  "idea": ["context-packet"],
  "timestamp": ["2026-05-21"],
  "identities": [
    "agent:codex"
  ]
}
```

Records do not need all facets at once. Full facets give precise subgraphs;
sparse facets are acceptable for lightweight observations.

Subgraph command:

```bash
recall subgraph \
  --category memory \
  --type witness \
  --subject compiler \
  --project Recall \
  --idea context-packet \
  --timestamp 2026-05-21
```

Identity tags remain available for actor/role composition. They should not
replace provenance or the primary facets. Provenance says where a claim came
from. Facets say what subgraph it belongs to. Identity tags say which actors,
adapters, daemons, or roles should be able to retrieve it.

## MCP

Recall exposes a lightweight stdio MCP-compatible server:

```bash
recall-mcp
```

Tools:

- `recall_status`
- `recall_search`
- `recall_semantic`
- `recall_compile`
- `recall_subgraph`
- `recall_write`
- `recall_hyperedge_add`
- `recall_hyperedge_show`
- `recall_hyperedge_list`
- `recall_program_add`
- `recall_program_show`
- `recall_program_list`
- `recall_program_run`
- `recall_program_runs`
- `recall_program_run_show`
- `recall_dag_add`
- `recall_dag_show`
- `recall_dag_list`
- `recall_dag_analyze`
- `recall_eval_run`
- `recall_eval_list`
- `recall_eval_show`
- `recall_daemon_run_once`

`recall_program_run`, `recall_dag_analyze`, `recall_eval_run`, and
`recall_daemon_run_once` accept `derive: true` to close runtime output back into
admitted graph cells.

MCP must stay a surface over the same runtime, not a second memory layer.
