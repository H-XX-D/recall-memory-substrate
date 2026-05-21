# Workflow Engine

The workflow engine is Substrate-Guided Workflow rebuilt as executable runtime
logic.

## Work Cycle

```text
map
  -> approximate
  -> allocate
  -> verify
  -> recalibrate
  -> write back
  -> compile next packet
```

## Graph Nodes

- `work_candidate`: possible file, source, action, hypothesis, benchmark, or
  adapter path.
- `proxy_score`: cheap estimate of impact, risk, uncertainty, cost,
  reversibility, dependency, and expected information gain.
- `verification_result`: expensive check result.
- `miss`: case where proxy under-ranked an important region.
- `blind_lock`: pre-registered prediction or expected outcome.
- `allocation_plan`: selected candidates and reason.

## Allocation Formula

Initial planning pressure:

```text
pressure = impact * uncertainty * concern * dependency_weight / estimated_cost
```

This is not truth. It is attention allocation. Verified results update the graph
after checks run.

## Required Separation

- proxy score is not proof
- verification result is not global certainty
- measured result is not aggressive envelope
- stale result is not current evidence
- concern is not contradiction

## CLI Commands

```text
recall workflow map "task"
recall workflow score <candidate-id>
recall workflow allocate --top 8
recall workflow verify <candidate-id>
recall workflow misses
recall workflow handoff
```

