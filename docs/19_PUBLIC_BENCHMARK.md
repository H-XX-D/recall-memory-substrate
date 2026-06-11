# Public Benchmark

Recall ships a reproducible public benchmark so outside users can measure the
runtime on the same surfaces the product is built around.

## Run It

```bash
npm run bench:public
```

The benchmark uses a temporary SQLite database, seeds a fixed synthetic corpus,
and reports latency plus throughput for the main operational surfaces.

## What It Measures

Core surfaces:

- `admit_write`
- `search`
- `semantic_search`
- `compile_context`
- `addressable_cell_expand`
- `page_index`
- `page_witnesses`
- `tui_render`
- `memory_health`
- `cognitive_tick`
- `rollback_preview`
- `dag_analysis`
- `eval_run`
- `workflow_allocate`
- `acp_exchange`
- `storage_stats`
- `daemon_run_once`
- `secret_save`
- `secret_get`
- `secret_list`
- `operate_once`

These are the surfaces that matter for Recall because the product is not just a
retrieval layer. It is a graph-native, write-admitting, operator-managed memory
runtime.

## Recall-Only Benchmark Dimensions

These are included because they are first-class Recall capabilities and are not
surfaced as equivalent public benchmark dimensions in the competitor docs
reviewed for this comparison. That is an inference from public documentation,
not a claim about every possible deployment.

- Addressable cells: inspect a node by ID or cell address and expand only what
  the caller needs.
- Rollbackable writes: preview and apply rollback journal entries.
- ACP exchange: a bounded one-shot request/response path into the internal
  graph manager.
- Operator ledger: durable mechanical runtime reporting separate from normal
  memory cells.
- Memory health analysis: belief pressure, stale memory, contradictions,
  provenance, and curiosity targets are analyzed continuously.
- Cognitive tick: a structured planner loop turns current graph state into a
  compact maintenance report.
- Daemon maintenance: leased outside-LLM maintenance work runs through the same
  graph and admission path.
- Storage telemetry: the runtime can report graph footprint and average cell
  size.
- DAG analysis: optional overlays can produce holonomy-style witnesses.
- Workflow allocation: score and allocate work candidates before admitting the
  result.

## Public Field Baseline

The benchmark is designed against the public memory-field shape described in
official docs from:

- Mem0: https://docs.mem0.ai/
- Zep: https://docs.getzep.com/
- Letta: https://docs.letta.com/

Across those docs, the public emphasis is on memory layers, sessions, user
memory, documents, retrieval, and editable memory blocks. Recall keeps those
capabilities where they fit, but the benchmark also measures the control-plane
surfaces that make Recall a runtime rather than a memory widget.

## Report Shape

The script prints:

- environment details
- corpus size
- per-surface latency and throughput
- a feature matrix that highlights Recall-exclusive surfaces

The output is intended to be reproducible and easy to compare across machines
or future releases.
