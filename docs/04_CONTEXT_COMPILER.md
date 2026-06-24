# Context Compiler

The compiler is the boundary between durable memory and the LLM context window.

## Purpose

Return only what the model needs for the current task. Store everything else in
the graph and give the model stable handles for deliberate expansion.

## Input

```json
{
  "task": "Current user or agent objective",
  "budget_words": 900,
  "include_conflicts": true,
  "include_stale_warnings": true,
  "include_next_actions": true,
  "inline_reference_values": false,
  "include_reference_parameters": false
}
```

## Output Packet

```text
objective:
compiler_state:
relevant_memory:
active_beliefs:
conflicts:
risks:
tasks:
cell_state:
standing_programs:
translated_references:
reference_parameters:
stale_or_low_trust:
suggested_next_actions:
expansion_handles:
```

## ID-First Contract

The default output is ID-first. A compiled packet is a task-specific index of
compact memory lines, cell IDs, addresses, field handles, and trust state. It is
not a graph dump.

- `compiler_state` should declare the ID-first policy, active budget, and
  whether inline values or parameter metadata were requested.
- `relevant_memory`, `active_beliefs`, `conflicts`, `risks`, and `tasks` should
  be compact enough to reason from, with IDs or addresses attached.
- `cell_state` lines carry both the author's immutable stated confidence and
  the live **effective confidence**, `eff:<value>` with a cause tag
  (`challenged`, `supported`, `actor-discounted`), recomputed from the graph
  surface on every compile. Treat `eff` as the claim's current price and the
  cause tag as the dig heuristic: a challenged cell warrants a peek before
  you rely on it.
- `standing_programs` lists the enabled programs (watch, drift, quorum,
  trend, score) covering each selected cell, with program and hyperedge handles.
  When you write new evidence about a guarded cell, tie it into the listed
  bundle instead of orphaning it.
- `conflicts` includes each selected cell's incoming `contradicts`/`concerns`
  challengers (capped per cell, with expansion handles), so a contested
  claim never arrives looking settled.
- `cell_state` should expose only minimal lifecycle/trust state needed for the
  task, not full cell bodies.
- `translated_references` should identify source cell, relation, target cell,
  and a short handle such as `<cell-id>#content.summary` without dumping the
  value.
- `reference_parameters` should stay absent or minimal unless
  `include_reference_parameters` is true.
- `expansion_handles` should be the explicit menu of handles an LLM can expand
  next.

Inline reference values are opt-in through `inline_reference_values`; detailed
parameter metadata is opt-in through `include_reference_parameters`. Leave both
off for normal agent operation. Turn them on only when the caller truly needs a
self-contained packet, such as for an audit, quote, migration, or offline
handoff.

## Ranking Signals

The compile ranker (`fuseCandidates`) scores each candidate on four terms:

- lexical match (FTS5 bm25, normalized to the strongest hit)
- graph degree (the cell's combined in + out relation count)
- effective confidence (recomputed from the graph at read time, so contradicted
  or superseded cells sink)
- freshness (recency, 30-day half-life)

Contradiction pressure is not a separate term: it acts through effective
confidence, which collapses a challenged cell's score.

## Word Budget Rule

Recall budgets in words, not tokenizer-specific tokens. Approximate is enough.
The compiler should prefer selectivity and IDs for expansion over exact token
math.

## Expansion Rule

Every compiled packet should include stable IDs so the LLM can ask for more:

```text
MCP: recall_cell 9917df67
MCP: recall_cell 9917df67#content.summary
CLI: recall cell show 9917df67
CLI: recall cell show '9917df67#content.summary'
```

Expansion should be lazy and narrow. Expand one cell or field handle when the
next decision depends on the exact value, provenance, or relation details. Do
not bulk-expand handles just to make the context feel complete, and do not paste
expanded values into new writes unless the new write makes a new source-grounded
claim about those values.
