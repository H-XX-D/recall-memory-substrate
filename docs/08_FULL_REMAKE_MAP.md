# Integrated Design Map

Recall is a clean public implementation of an active memory substrate. The goal
is not a bridge layer. The goal is a single coherent runtime.

## Graph Cognition

Recall includes:

- typed cognitive graph
- witness ingestion
- belief state
- contradiction and concern relations
- provenance and source quality
- stale memory detection
- autonomous maintenance loop
- adapter signal ingestion
- graph health diagnostics
- context boot/focus packets

Clean improvements:

- no route-specific special cases unless encoded as policy
- one provenance enum across all write paths
- first-class concern edges separate from contradiction edges
- typed belief calculators instead of ad hoc belief mutation
- graph metrics count all node/relation kinds

## Operational Substrate

Recall includes:

- objectives
- tasks
- decisions
- risks
- constraints
- checkpoints
- project/session scope
- write firewall
- admission policy
- rollback journal
- lifecycle maintenance
- MCP portability
- context packs
- dashboard/health surfaces

Clean improvements:

- COS state lives in the same graph as CC evidence
- rollback applies to all durable write kinds
- session state compiles into LLM packets instead of being pasted wholesale
- operational pressure uses confidence, uncertainty, concern, and importance

## Verification Workflow

Recall includes:

- candidate mapping
- LO proxy scoring
- NLO verification allocation
- miss analysis
- recalibration
- blind-lock records
- noise-floor discipline
- measured-vs-envelope separation
- report/handoff packets

Clean improvements:

- workflow state is graph-native
- candidates, proxy scores, checks, misses, and verified results are typed nodes
- allocation can be triggered by daemon, CLI, or agent request
- workflow decisions are auditable and replayable

## One Shared Runtime

```text
write proposal
  -> admission/firewall
  -> graph core
  -> workflow allocator
  -> daemon jobs
  -> context compiler
  -> LLM packet
```

## No Duplicate Subsystems

Do not build:

- one memory store for graph evidence and another for operational state
- one tag format for graph search and another for tasks
- one context compiler for LLMs and another for CLI
- one daemon for memory cleanup and another for workflow allocation

Everything routes through the same schema.

## Minimum Viable Integrated Core

The first useful version must support:

- `recall init`
- write proposal validation
- graph write admission
- tags and subgraph query
- task/objective nodes
- witness/belief nodes
- work-candidate/proxy-score nodes
- rollback journal
- context compiler
- `recall status`
- `recall compile`
- `recall tui`
