# Context Compiler

The compiler is the boundary between durable memory and the LLM context window.

## Purpose

Return only what the model needs for the current task. Store everything else in
the graph.

## Input

```json
{
  "task": "Current user or agent objective",
  "scope": "Recall",
  "budget_words": 900,
  "include_conflicts": true,
  "include_stale_warnings": true,
  "include_next_actions": true
}
```

## Output Packet

```text
objective:
relevant_memory:
active_beliefs:
conflicts:
risks:
tasks:
stale_or_low_trust:
suggested_next_actions:
expansion_handles:
```

## Ranking Signals

- lexical match
- semantic match
- tag overlap
- identity tag overlap
- graph distance
- confidence
- uncertainty
- concern
- freshness
- source quality
- contradiction pressure
- task dependency

## Word Budget Rule

Recall budgets in words, not tokenizer-specific tokens. Approximate is enough.
The compiler should prefer selectivity and IDs for expansion over exact token
math.

## Expansion Rule

Every compiled packet should include stable IDs so the LLM can ask for more:

```text
expand: belief:ccArchitectureStrength witness:9917df67 subgraph:compiler-runtime
```
