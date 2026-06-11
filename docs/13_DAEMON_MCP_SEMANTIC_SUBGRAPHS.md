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

The current daemon pass records a maintenance witness with graph stats, belief
pressure, stale-memory findings, contradiction/concern findings, and next
actions. With `--derive`, it also schedules semantic reindexing and default
eval closure.
Derived eval and maintenance writes are bucket-gated so repeated daemon ticks in
the same day skip duplicate graph cells instead of flooding the primary graph.
Daemon passes acquire a short SQLite-backed lease before writing; an overlapping
worker returns `daemon_lease_active` and does no graph write until the active
lease is released or expires.

## Operator Cycle

The operator cycle is the top-level mechanical pass over the runtime:

```bash
recall operate once
recall operate once --derive --compact
recall operate list
recall operate show <operator-run-id>
recall acp run --interval-ms 5000
```

It acquires a separate SQLite-backed operator lease, captures preflight storage
and health, runs semantic reindexing, runs eval closure, runs daemon
maintenance, runs the cognitive tick, optionally compacts SQLite, and emits a
postflight report. The phase order is deliberate: daemon maintenance owns the
daily maintenance bucket first, then the cognitive tick records planner and
repair state. Repeated runs report duplicate or skipped writes instead of
silently flooding graph memory.

Every operator pass is persisted to `operator_runs`. This is an operational
ledger, not the primary memory graph. It preserves phase reports, preflight and
postflight counters, write counts, failures, recommendations, and the run
status so agents can audit the mechanical runtime without spending normal cell
storage or context budget.

ACP is the internal agent communication protocol. It adds a bounded request
queue for a graph-manager agent so other agents can hand off status checks,
searches, writes, and bounded maintenance work from inside the runtime instead
of forcing everything through the outer user surface.
The continuous `recall acp run` loop is the simplest way to keep that internal
manager draining requests on a timer.

## Semantic Search

Recall now has a deterministic local semantic index. It uses hash embeddings so
the first install stays dependency-light and offline. This is not the final
semantic backend; it is the stable interface.

Command:

```bash
recall semantic "compact evidence packet"
recall semantic reindex
```

External embedding backends can be plugged in without changing the graph schema.
The recommended path is an HTTP endpoint (Ollama or any OpenAI-compatible
embeddings API):

```bash
export RECALL_EMBEDDING_URL="http://localhost:11434/api/embed"   # Ollama
export RECALL_EMBEDDING_MODEL="nomic-embed-text"
# or any OpenAI-compatible /v1/embeddings endpoint:
export RECALL_EMBEDDING_URL="https://api.example.com/v1/embeddings"
export RECALL_EMBEDDING_API_KEY="..."                            # optional bearer token
```

The request body is `{"model": ..., "input": text}`; accepted response shapes
are OpenAI-compatible (`{"data":[{"embedding":[...]}]}`), Ollama-native
(`{"embeddings":[[...]]}`), `{"embedding":[...]}`, or a bare array.

Alternatively set `RECALL_EMBEDDING_COMMAND` to a shell command. It receives
JSON on stdin:

```json
{ "text": "memory text", "dims": 256 }
```

It must return either a JSON number array or `{ "vector": [0.1, 0.2] }`.

**Failure never blocks writes.** If an external backend is unreachable or
returns garbage, Recall logs one warning, latches that backend off for the
rest of the process, and falls back to the deterministic `hash:v1` embedding.
Queries under a backend that has indexed nothing yet degrade to the hash
index automatically.

After switching backends, rebuild the index under the new one:
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
daemons, tools, or roles should be able to retrieve it.

## MCP

Recall exposes a lightweight stdio MCP-compatible server:

```bash
recall-mcp
```

Tools:

- `recall_status`
- `recall_storage`
- `recall_compact`
- `recall_beliefs`
- `recall_maintenance`
- `recall_trust`
- `recall_tick`
- `recall_acp_status`
- `recall_acp_send`
- `recall_acp_list`
- `recall_acp_show`
- `recall_acp_process`
- `recall_acp_exchange`
- `recall_operate_once`
- `recall_operate_list`
- `recall_operate_show`
- `recall_page`
- `recall_cell`
- `recall_search`
- `recall_semantic`
- `recall_compile`
- `recall_subgraph`
- `recall_write`
- `recall_workflow_allocate`
- `recall_blind_lock`
- advanced graph operation tools
- `recall_dag_add`
- `recall_dag_show`
- `recall_dag_list`
- `recall_dag_analyze`
- `recall_eval_run`
- `recall_eval_list`
- `recall_eval_show`
- `recall_daemon_run_once`

Advanced graph operations, `recall_dag_analyze`, `recall_eval_run`, and
`recall_daemon_run_once` accept `derive: true` to close runtime output back
into admitted graph cells.

MCP clients should keep references compact. Evidence arrays, multi-party
relation members, and DAG overlay nodes can use cell IDs,
`recall://cell/...` addresses, or field references such as
`recall://cell/...#content.summary`. Recall resolves the target cell and keeps
the path as relation/member metadata.

`recall_compile` is ID-first by default. It returns short cell handles and
minimal state; clients should call `recall_cell` to expand a handle. Set
`inlineReferenceValues: true` and `includeReferenceParameters: true` only when
the MCP client needs resolved values inside the compiled packet.

MCP must stay a surface over the same runtime, not a second memory layer.
