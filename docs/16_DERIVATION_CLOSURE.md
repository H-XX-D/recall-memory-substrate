# Derivation Closure

Recall's closure loop is that runtime-derived outputs can become future
retrieval material without bypassing the memory firewall.

```text
runtime derives output
  -> output is shaped as a strict recall.write.v1 proposal
  -> admission/firewall validates, attenuates, rejects, or requires review
  -> accepted proposal becomes an addressable graph cell
  -> compiler, search, subgraph, and MCP tools retrieve the cell later
```

The loop is self-closing because derived state does not remain only in stdout,
logs, chat, or temporary agent context. If it is durable enough to affect later
work, it must re-enter Recall through the same proposal path as any other
memory write.

## Closure Invariants

- Derived runtime outputs do not mutate graph rows directly.
- Every durable derived output uses `recall.write.v1`.
- Admission and firewall checks are always in the path.
- Accepted outputs receive provenance, confidence, policy, tags, rollback
  metadata, and an addressable cell ID.
- Retrieval uses the same graph through `recall compile`, lexical search,
  semantic search, facet subgraphs, or MCP tools.
- Rejected, review-blocked, or secret-looking outputs are not silently stored.
- Derived cells carry deterministic derivation keys so repeated closure can
  reuse existing cells instead of flooding the graph.

Closure is therefore not "the system writes anything it thinks." Closure means
the system can propose its own durable evidence, and the normal write policy
decides whether that evidence becomes memory.

## Agent Close/Derive Procedure

Agents should use close/derive as a disciplined loop:

```text
compile ID-first context
  -> expand only necessary handles with recall_cell
  -> run the work or runtime analysis
  -> derive only outputs that should become future evidence
  -> inspect accepted / duplicateOf / rejected / requires_review state
  -> reference accepted cells by ID or address in later writes
```

Do not treat stdout, a program run table, an eval transcript, or a daemon
summary as durable memory until the derived proposal is accepted or mapped to an
existing cell with `duplicateOf`. Rejected, review-blocked, or secret-looking
outputs must not be copied into another memory path to force persistence.

When a derivation returns `duplicateOf`, reuse the existing cell ID or address.
When it returns a new accepted cell, link future claims to that cell rather than
copying the derived body. When exact derived payload details are needed later,
retrieve them lazily with MCP `recall_cell` or CLI `recall cell show`.

## Derivation Identity

Derived writes are keyed before admission:

- operation output: operation id and deterministic output payload;
- DAG consistency: overlay id, endpoints, signatures, and witness/concern kind;
- eval output: suite name, pass/fail state, score, and case results.

Admission stores the key in `derivation_index` in the same transaction as the
graph cell. If the key already exists, Recall returns the existing node with
`duplicateOf` instead of inserting another durable cell. This makes repeated
derive commands safe enough for daemon use while still preserving raw runtime
tables such as `program_runs` and `eval_runs` for inspection.

Rollback is part of the identity lifecycle. Rolling back an inserted derived
node archives the cell, removes attached relations, and clears its
`derivation_index` row, so the same output can be derived again into a new
active cell. Store migration also removes stale derivation keys that point to
missing or non-active nodes.

## Operation Runs

Declared graph operations are sandboxed `recall.program.v1` specs attached to
graph relationships. Their implemented operations include `score`,
`emit_witness`, `tag_projection`, `watch`, `drift`, and `quorum`. Reflex
operations (`watch`, `drift`) derive only when tripped — an untripped run
produces no proposal — and a trip configured with `concernTarget` derives a
witness carrying a `concerns` reference against that cell, attributed
`produced_by: program:<id>`.

Operation output closes the loop only by becoming a proposal:

```text
recall program run <program-id>
recall program run <program-id> --derive
  -> deterministic runtime result
  -> witness, score, tag projection, or failure evidence proposal
  -> admission/firewall
  -> addressable cell
  -> later compiler/MCP retrieval
```

Declared operations should not write graph rows directly. Failed operation
execution is not yet automatically converted into a failure proposal; that is a
future closure path because failures can be relevant to trust, verification, or
workflow state.

## DAG Consistency Witnesses

DAG overlays are optional ordered views over the general graph. They are
used for workflows, evidence chains, execution traces, and verification routes;
they do not replace the cyclic base graph.

`recall dag analyze <overlay-id>` checks the stored overlay for DAG validity,
topological order, and multi-path transport disagreement. Stored CLI/MCP DAG
overlays are rejected if cyclic; cycle-concern proposal support exists in the
derivation builder for runtime analysis objects, but normal stored overlays are
kept acyclic. Consistency analysis closes through witnesses:

```text
recall dag analyze <overlay-id> --derive
DAG overlay analysis
  -> consistency, concern, or contradiction witness
  -> strict write proposal
  -> admission/firewall
  -> witness cell linked to relevant graph cells
  -> compiler/MCP can retrieve it as evidence
```

This makes path disagreement addressable. A future context packet can surface
that a conclusion depends on routes whose transported signatures disagree,
rather than requiring the model to rediscover the inconsistency from scratch.

## Eval Results

The eval harness measures search, semantic search, compile, and subgraph cases.
Eval runs are runtime outputs, but durable eval conclusions still follow the
proposal path:

```text
recall eval run
recall eval run --derive
  -> case results and aggregate report
  -> evaluation witness or concern proposal
  -> admission/firewall
  -> eval result cell
  -> later status, compiler, MCP, or subgraph retrieval
```

Eval closure is what prevents benchmark evidence from becoming an external
spreadsheet or a forgotten terminal transcript. It also keeps claims about
Recall quality grounded: a future packet can cite admitted eval cells instead of
claiming improvement from memory.

## Daemon Behavior

The daemon runs outside the LLM. It may inspect graph state and produce
maintenance observations, such as graph stats, stale-memory findings,
contradiction scans, dedupe candidates, semantic reindex notes, or eval run
summaries.

Daemon closure follows the same path:

```text
recall daemon run-once
recall daemon run-once --derive
recall daemon run --interval-ms 60000
  -> maintenance observation
  -> strict write proposal with actor.kind = daemon
  -> admission/firewall
  -> maintenance cell
  -> compiler/MCP retrieval for future work
```

The daemon should be quiet by default. It should not create a separate memory
plane, silently rewrite old records, or bypass review gates. Background work is
useful only when its durable outputs are inspectable, rollback-aware, and
retrievable through the same graph.

In derive mode, daemon closure is schedule-gated by a daily bucket. The first
derive tick for the bucket may reindex semantics, run the default eval suite,
admit an eval witness, and admit a derivation maintenance observation. Later
derive ticks in the same bucket still may reindex semantics, but skip duplicate
eval and maintenance graph writes with an explicit `daemon_schedule_skipped`
result.

Daemon passes also acquire a short SQLite-backed lease before writing. If
another daemon worker holds the lease, the pass returns `status: "skipped"` with
`daemon_lease_active` and performs no graph write. Expired leases can be
reacquired.

## Compiler And MCP Retrieval

Closure becomes operational when accepted cells are available to downstream
interfaces:

- `recall compile` can include derived witnesses, concerns, eval results, and
  maintenance observations in a word-budget context packet.
- `recall search` and `recall semantic` can find admitted derived cells.
- `recall subgraph` can retrieve them by project, category, type, subject,
  idea, timestamp, or identity tags.
- `recall-mcp` exposes the same operations through tools such as
  `recall_compile`, `recall_search`, `recall_semantic`, `recall_subgraph`,
  `recall_write`, `recall_program_run`, `recall_dag_analyze`,
  `recall_eval_run`, and `recall_daemon_run_once`.

MCP is a surface over the same runtime, not a second memory API. Agents can read
derived cells and submit new proposals, but accepted memory remains governed by
the shared schema, admission, firewall, provenance, and rollback rules.

Retrieval remains ID-first after closure. A derived witness may appear in a
compiled packet as a compact line, relation handle, and `expansion_handles`
entry. Inline derived payloads and detailed parameter metadata are not included
unless the caller explicitly asks for them, and agents should prefer one-handle
expansion before requesting a self-contained packet.

## What Is Not Automatic

Secrets are explicitly outside the automatic closure loop.

Normal proposals with `policy.sensitivity = "secret"` or secret-looking content
are rejected by the primary graph firewall. Secret payloads may be stored only
through the explicit encrypted side graph command:

```bash
recall secrets save --confirm-secret-save --password-stdin --value-stdin
```

The secrets side graph is user-directed. It is not populated by program runs,
DAG analysis, evals, daemon maintenance, compiler output, or MCP background
behavior.

Other non-automatic behavior:

- Review-required proposals remain pending or rejected until explicitly
  reviewed.
- Programs with side effects require human review.
- Duplicate derived outputs are reused by derivation key, not silently
  overwritten.
- Supersession and linking are explicit write operations; they are not implicit
  background rewrites.
- The daemon may propose maintenance observations, but it does not become an
  unrestricted autonomous editor.
