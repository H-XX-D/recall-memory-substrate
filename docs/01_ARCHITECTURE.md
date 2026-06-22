# Recall Architecture

## Core Loop

```text
LLM or daemon action
  -> write proposal
  -> schema validation
  -> firewall/admission
  -> graph write + rollback journal
  -> maintenance jobs
  -> context compiler
  -> compact packet back to LLM
```

## Unified Runtime Principle

Recall combines graph memory, operational continuity, and verification workflow
as one runtime. The ideas stay; duplicate subsystem boundaries do not.

```text
Graph cognition -> evidence graph + beliefs + contradictions
Operational substrate -> sessions + tasks + risks + rollback
Verification workflow -> allocation policy + measured checks

Shared Recall core -> schema + tags + compiler + daemon + CLI/TUI
```

## Layers

### Graph Core

Stores durable state as nodes, relations, multi-party relations, tags, provenance, and
rollback entries.

Every admitted node is also an addressable cell:

```text
recall://cell/<project>/<category>/<type>/<subject>/<idea>/<timestamp>/<id>
```

Facet tags are useful but not mandatory. Missing address facets are derived from
scope, intent, title, topic, and provenance timestamp.

Every cell carries two confidences: the immutable stated confidence the writer
asserted, and a living effective confidence the graph computes on every read
from incoming `supports`/`contradicts`/`concerns` and per-actor calibration
(`clamp01(stated × actor-calibration + support − challenge)`). Ranking and
compile packets use the effective value, so a contradicted cell sinks on its own
with no model in the loop. Corrections supersede rather than overwrite: a new
fact admitted with a `contradicts` edge demotes the prior cell and surfaces the
resolution to later sessions instead of leaving two competing rows.

Storage is per-project. The CLI wrapper routes each call to a SQLite database by
walking up from the current directory through a registry of project roots (first
match wins), falling back to a shared global database. Reads can federate the
project and global databases with `--include-global`; writes always land in
exactly one database.

Primary node classes:

- observation
- witness
- belief
- contradiction
- task
- objective
- decision
- risk
- constraint
- artifact
- source
- program
- eval_run
- context_packet
- work_candidate
- proxy_score
- verification_result
- blind_lock

Primary relation classes:

- supports
- contradicts
- concerns
- depends_on
- derived_from
- supersedes
- belongs_to
- mentions
- executes
- emits
- invalidates

### Write Admission

The LLM never writes raw graph rows. It submits a write proposal. The admission
layer validates schema, redacts or rejects sensitive content, detects duplicate
claims, applies confidence attenuation, and records rollback metadata.

Once Recall is running, normal memory writes are LLM-managed and seamless. The
LLM submits observations, witnesses, tasks, risks, decisions, and context updates
through MCP or an agent bridge. The user should not have to manually save
routine memory.

The user role is inspection, correction, rollback, review, and explicit commands
through CLI/TUI.

### Secrets Side Graph

Secrets do not enter the primary graph. Recall keeps a separate encrypted side
graph for secrets. It stores minimal metadata in cleartext and encrypts payloads
with a password-derived key.

Secret writes require an explicit secrets command. No normal LLM write proposal
can silently become a secret write.

### Tagging Layer

Tags are first-class routing metadata, not decoration. Tags compose subgraphs by
scope, topic, entity, project, ring, lifecycle state, source quality, and
permission level.

### Context Compiler

The compiler returns compact word-budget packets. It ranks by relevance,
planning pressure, conflict, freshness, provenance quality, and user task. It
returns IDs for expansion instead of flooding the LLM context window.

### Workflow Engine

The workflow engine maps a task into candidates, assigns cheap proxy scores,
allocates expensive checks, records misses, and feeds verified results back into
the graph.

It should be callable by CLI, daemon, MCP, and declared graph operations.

### CLI/TUI

The CLI is the automation interface. The TUI is the quiet human control panel.
The daemon should remain invisible unless the user asks for status or a problem
crosses an alert threshold.

### Declared Runtime Layer

Declared graph operations transform graph-local inputs into declared outputs.
They must be versioned, sandboxed, permissioned, testable, and auditable.

The current implementation supports multi-party graph relations and a sandboxed
`recall.program.v1` runtime with deterministic operations: `score`,
`emit_witness`, `tag_projection`, `watch` (a standing reflex that trips when a
bundle's effective confidence moves past a delta), `drift` (watch with member
attribution), `quorum` (k-of-m sign-off as a graph object), and `trend`
(finite-difference calculus over a program's run history: direction, slope, and
acceleration; over confidence, member count, or declared numeric fields). It
does not execute arbitrary user code. See
[`06_ADVANCED_GRAPH_OPERATIONS.md`](06_ADVANCED_GRAPH_OPERATIONS.md).

Program, DAG, eval, and daemon outputs can be closed back into graph memory with
explicit derivation mode. Derivation creates strict `recall.write.v1` proposals
and admits them through the same firewall/admission/rollback path instead of
writing raw rows.

The base graph is not a DAG. Optional DAG overlays may be used for specific
ordered workflows, evidence pipelines, or execution plans. Consistency checks
over those overlays can produce witnesses, concerns, or contradiction pressure
without forcing the whole graph to be acyclic.

### Eval And Service Layer

Recall has a local eval harness for search, semantic search, compile, and
subgraph cases. Eval results are persisted in the same runtime so recall quality
can be tracked instead of guessed.

The daemon can run in-process through CLI or be installed as a macOS LaunchAgent
plist. Service loading stays explicit.

## Efficiency Rule

Recall should filter by structured tags and graph neighborhoods before semantic
search. It should compile short packets before asking the LLM to reason. It
should run maintenance incrementally instead of rescanning the whole graph on
every turn.
