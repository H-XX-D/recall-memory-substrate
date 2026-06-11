# Recall Plan

## Goal

Build Recall as a clean GitHub-ready active memory substrate for LLM agents.
It combines graph-backed cognition, operational continuity, and
verification-oriented workflow patterns as one efficient system.

Recall should operate invisibly as an AI memory substrate unless the user opens
the CLI/TUI. It should give the LLM concise compiled context, not a memory dump.

## Non-Goals

- Do not clone any prior prototype wholesale.
- Do not make a note-taking app.
- Do not let the LLM write directly to the graph.
- Do not write the README until the core architecture, schema, and CLI plan are
  settled.

## Design Inputs

Recall rebuilds three proven idea families behind one public runtime:

- graph-backed cognition: witnesses, beliefs, contradictions, provenance,
  connectors, autonomous loop.
- operational continuity: objectives, tasks, checkpoints, rollbackable writes,
  firewall/admission, MCP portability, cross-session continuity.
- verification-oriented workflow: map, approximate, allocate, verify,
  recalibrate, record misses, and separate measured facts from estimates.

The target is not three systems glued together. Recall should rebuild each one
behind a shared substrate:

- one graph model
- one write proposal schema
- one tag/subgraph system
- one context compiler
- one daemon scheduler
- one eval surface
- one CLI/TUI control plane

## Product Shape

Recall is a local-first memory kernel with:

- SQLite graph store.
- Password-protected encrypted Secrets side graph.
- Strict write schema.
- LLM write proposals and admission.
- Evidence-weighted beliefs.
- Contradiction and stale-memory detection.
- Robust tagging for subgraph composition.
- Sandboxed declared graph operations for controlled extra behavior.
- Word-budget context compiler.
- CLI for automation and inspection.
- TUI for human review.
- MCP/connector bridge for cross-agent use.
- Background daemon that is quiet unless asked.

## Milestones

### Phase 0: Repo Plan

- Create clean repo folder.
- Capture architecture, schema, CLI/TUI, compiler, and declared graph operation
  plan.
- Write README only after the working skeleton stabilizes.

### Phase 1: Core Schema

- Implement graph tables.
- Implement strict write proposal schema.
- Implement admission/firewall checks.
- Implement rollback journal.
- Keep secret writes out of the primary graph.
- Add schema tests before any daemon work.
- Include witnesses, beliefs, conflicts, tasks, risks, decisions, work
  candidates, proxy scores, and verification results in one schema.

### Phase 2: Context Compiler

- Implement word-budget packet generation.
- Support expansion handles by graph ID.
- Add stale/conflict/provenance-aware ranking.
- Add eval fixtures for recall precision and stale-memory suppression.
- Compile task-specific packets from evidence, operational state, and
  work-allocation state without dumping raw memory into the LLM.

### Phase 3: CLI

- Implement `recall init`.
- Implement `recall write-propose`, `recall admit`, `recall search`.
- Implement `recall compile`.
- Implement `recall subgraph`.
- Implement `recall rollback`.
- Implement `recall audit`.
- Implement `recall secrets save/list/get` as an explicitly invoked encrypted
  side graph, not an automatic memory path.
- Include graph inspection, session/task management, and planning/allocation
  commands through the same control plane.

### Phase 4: TUI

- Implement quiet inspection dashboard.
- Show beliefs, tasks, conflicts, stale memories, write queue, rollback journal,
  subgraphs, and declared graph operations.

### Phase 5: Declared Graph Operations

- Implement sandboxed program registration.
- Attach declared operations to typed graph inputs and outputs.
- Require deterministic mode by default.
- Require permissions for side effects.

### Phase 6: Daemon And MCP

- Implement invisible daemon loop.
- Add MCP bridge for agent portability.
- Add background maintenance jobs: stale checks, dedupe, contradiction scans,
  eval runs, and subgraph refresh.
- Run allocation as daemon policy, not as a separate manual workflow.

### Phase 7: README

- Write README only after the repo has a working skeleton and verified CLI flow.

## First Implementation Bias

Use TypeScript for the first clean implementation because the CLI/TUI/MCP
ecosystem is straightforward.
Keep the core schema portable enough that a Rust/native core can replace the
runtime later without changing the write protocol.

## Integration Standard

Every feature must answer which layer it belongs to:

- evidence state: graph core
- operational continuity: session/task ledger
- work allocation: workflow engine
- user inspection: CLI/TUI
- agent context: compiler
- background improvement: daemon

If a feature creates a second competing memory path, it is wrong.
