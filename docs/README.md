# Recall — Documentation

Welcome to the Recall documentation. This directory contains the detailed
technical reference for Recall's architecture, schema, runtime behavior, and
integration surfaces. For a project-level overview, install instructions,
and quick examples, start with the top-level [`../README.md`](../README.md).

## Documentation by purpose

### Getting started

| Doc | What it covers |
|---|---|
| [`11_INSTALLATION.md`](11_INSTALLATION.md) | Installing Recall on a fresh machine; Node version requirements; standard install locations |
| [`05_CLI_TUI.md`](05_CLI_TUI.md) | Command-line surface and the read-only terminal UI |
| [`LLM_INTEGRATION.md`](LLM_INTEGRATION.md) | Full operating contract for LLM agents — read this before composing your first write proposal |
| [`LLM_SYSTEM_PROMPT.md`](LLM_SYSTEM_PROMPT.md) | Drop-in system prompt that teaches an LLM how to use Recall |
| [`../python/QUICKSTART.md`](../python/QUICKSTART.md) | Verified end-to-end walkthrough using the Python client toolkit |

### Architecture & concepts

| Doc | What it covers |
|---|---|
| [`01_ARCHITECTURE.md`](01_ARCHITECTURE.md) | High-level system architecture: storage, write firewall, retrieval mechanisms, MCP server |
| [`02_WRITE_SCHEMA.md`](02_WRITE_SCHEMA.md) | The strict `recall.write.v1` proposal schema — required blocks, field constraints, validation behavior |
| [`03_TAGGING_AND_SUBGRAPHS.md`](03_TAGGING_AND_SUBGRAPHS.md) | Tag families, subgraph composition, faceted retrieval |
| [`04_CONTEXT_COMPILER.md`](04_CONTEXT_COMPILER.md) | How the compile mechanism produces curated context packets under a word budget |
| [`14_ADDRESSABLE_CELLS_AND_GRAPH_VIEWS.md`](14_ADDRESSABLE_CELLS_AND_GRAPH_VIEWS.md) | Stable cell addresses, N-ary hyperedges, DAG overlays |
| [`06_ADVANCED_GRAPH_OPERATIONS.md`](06_ADVANCED_GRAPH_OPERATIONS.md) | Sandboxed `recall.program.v1` operations attached to hyperedges |
| [`15_LLM_MANAGED_MEMORY.md`](15_LLM_MANAGED_MEMORY.md) | The discipline of agent-managed memory: calibrated confidence, supersedure-by-relation, audit trail |
| [`16_DERIVATION_CLOSURE.md`](16_DERIVATION_CLOSURE.md) | Derivation index, eval-result and DAG-analysis closure mechanisms |

### Runtime & operations

| Doc | What it covers |
|---|---|
| [`12_SECRETS_SIDE_GRAPH.md`](12_SECRETS_SIDE_GRAPH.md) | Encrypted secrets storage outside the primary graph; explicit save confirmation |
| [`13_DAEMON_MCP_SEMANTIC_SUBGRAPHS.md`](13_DAEMON_MCP_SEMANTIC_SUBGRAPHS.md) | Background daemon, MCP server, semantic search backend, subgraph composition |
| [`07_EVALS.md`](07_EVALS.md) | Eval suites, eval-result cells, persistence |
| [`09_WORKFLOW_ENGINE.md`](09_WORKFLOW_ENGINE.md) | Workflow-engine design spec; cell kinds are implemented, CLI commands planned for v0.2+ |
| [`18_SPRINTS.md`](18_SPRINTS.md) | Multi-session AI work pattern — sprints as structured task graphs the AI executes autonomously across sessions and across providers |
| [`19_PUBLIC_BENCHMARK.md`](19_PUBLIC_BENCHMARK.md) | Reproducible public benchmark (`npm run bench:public`) over the main operational surfaces |

### Internal / planning (not user-facing)

These documents capture design rationale and project planning rather than
runtime behavior. Read them if you're contributing or want context on why
the system is shaped the way it is; skip if you're just trying to use it.

| Doc | What it covers |
|---|---|
| [`00_PLAN.md`](00_PLAN.md) | Project goals, non-goals, and design inputs |
| [`08_FULL_REMAKE_MAP.md`](08_FULL_REMAKE_MAP.md) | Mapping from earlier prototypes to the current architecture |

## Documentation by audience

### "I want to install and use Recall"

Read in order:
1. [`../README.md`](../README.md) — project overview
2. [`11_INSTALLATION.md`](11_INSTALLATION.md) — install
3. [`../python/QUICKSTART.md`](../python/QUICKSTART.md) — first useful query
4. [`05_CLI_TUI.md`](05_CLI_TUI.md) — full CLI surface

### "I'm an AI agent (or building one) that needs to use Recall"

Read in order:
1. [`LLM_INTEGRATION.md`](LLM_INTEGRATION.md) — operating contract
2. [`02_WRITE_SCHEMA.md`](02_WRITE_SCHEMA.md) — write proposal shape
3. [`03_TAGGING_AND_SUBGRAPHS.md`](03_TAGGING_AND_SUBGRAPHS.md) — how to compose retrievals
4. [`04_CONTEXT_COMPILER.md`](04_CONTEXT_COMPILER.md) — the compile mechanism
5. [`15_LLM_MANAGED_MEMORY.md`](15_LLM_MANAGED_MEMORY.md) — the discipline that makes the system work
6. [`LLM_SYSTEM_PROMPT.md`](LLM_SYSTEM_PROMPT.md) — drop-in prompt

### "I'm building an AI coding agent that uses Recall"

Read in order:
1. [`../python/QUICKSTART.md`](../python/QUICKSTART.md) — install + first query
2. [`../python/reference/code-integration.md`](../python/reference/code-integration.md) — code extension API, extractors, linker, CI ingest
3. [`14_ADDRESSABLE_CELLS_AND_GRAPH_VIEWS.md`](14_ADDRESSABLE_CELLS_AND_GRAPH_VIEWS.md) — cell addressing and hyperedges
4. [`../python/reference/HOW_TO_BENCHMARK.md`](../python/reference/HOW_TO_BENCHMARK.md) — benchmark methodology

### "I'm operating Recall in production"

Read in order:
1. [`01_ARCHITECTURE.md`](01_ARCHITECTURE.md) — system architecture
2. [`13_DAEMON_MCP_SEMANTIC_SUBGRAPHS.md`](13_DAEMON_MCP_SEMANTIC_SUBGRAPHS.md) — daemon, MCP, semantic search
3. [`12_SECRETS_SIDE_GRAPH.md`](12_SECRETS_SIDE_GRAPH.md) — secrets handling
4. [`07_EVALS.md`](07_EVALS.md) — evaluation suites
5. [`16_DERIVATION_CLOSURE.md`](16_DERIVATION_CLOSURE.md) — derivation mechanisms

### "I'm contributing to Recall"

Read in order:
1. [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — contributor process and Code of Conduct
2. [`00_PLAN.md`](00_PLAN.md) — project goals and non-goals
3. [`01_ARCHITECTURE.md`](01_ARCHITECTURE.md) — architecture overview
4. [`08_FULL_REMAKE_MAP.md`](08_FULL_REMAKE_MAP.md) — design rationale

Then explore the runtime/operations docs above as the feature you're
contributing requires.

## Implementation status reference

The CLI commands documented across these files map to actual implementations
in [`../src/cli.ts`](../src/cli.ts). The current implemented surface (as of
Recall 0.1.0) is:

| Command | Subcommands | Documented in |
|---|---|---|
| `recall init` | — | 11, LLM_INTEGRATION |
| `recall status` / `storage` | — | 11 |
| `recall tui` | — | 05 |
| `recall validate` | — | 02, 05 |
| `recall admit` / `write-propose` | — | 02, 05 |
| `recall cell` | `show` | 14 |
| `recall search` | — | 05 |
| `recall semantic` | `reindex` | 13 |
| `recall subgraph` | — | 03 |
| `recall compile` | — | 04 |
| `recall page` | `index`, `reflections`, `witnesses`, … | 05 |
| `recall rollback` | `list`, `show`, `apply` | 05 |
| `recall hyperedge` | `add`, `show`, `list` | 14 |
| `recall program` | `add`, `list`, `show`, `run`, `runs`, `show-run` | 06 |
| `recall dag` | `add`, `show`, `analyze`, `list` | 14, 16 |
| `recall eval` | `run`, `list`, `show` | 07 |
| `recall workflow` | `allocate` | 09 |
| `recall operate` | `once`, `list`, `show` | 13 |
| `recall acp` | `status`, `send`, `list`, `show`, `process`, `run` | 13 |
| `recall beliefs` / `trust` / `calibration` | — | 13 |
| `recall maintenance` / `tick` / `compact` | — | 13 |
| `recall blind-lock` | `add` | 13 |
| `recall daemon` | `status`, `run-once`, `run`, `plist`, `install`, `uninstall`, `service-status` | 13 |
| `recall secrets` | `list`, `save`, `get` | 12, 15 |
| `recall mcp config` | — | LLM_INTEGRATION, LLM_SYSTEM_PROMPT |

### Semantic backend

The default semantic backend is `hash:v1` — 256-dim hash embeddings,
zero dependencies. Two real-embedding paths plug into the TS core:

- **HTTP backends** — set `RECALL_EMBEDDING_URL` (+ `RECALL_EMBEDDING_MODEL`,
  optionally `RECALL_EMBEDDING_API_KEY`) to use Ollama or any OpenAI-compatible
  embeddings endpoint. Failures latch off per process and fall back to
  `hash:v1`, so writes never block on an embedding service.
- **Command adapter** — a Python adapter (`mpnet:v1`, 768-dim,
  sentence-transformers) via the documented `RECALL_EMBEDDING_COMMAND`
  extension point.

Run `recall semantic reindex` after switching backends. See
[`13_DAEMON_MCP_SEMANTIC_SUBGRAPHS.md`](13_DAEMON_MCP_SEMANTIC_SUBGRAPHS.md)
for setup.

### Enforcement

Soft enforcement (UserPromptSubmit + Stop hooks) and hard enforcement
(PreToolUse guard) ship as template hooks in
[`python/hooks/`](../python/hooks/). Longitudinal tracking
(`audit_compliance.py`, `longitudinal_tracker.py`) measures whether
enforcement is producing better outcomes over time. See
[`17_ENFORCING_USAGE.md`](17_ENFORCING_USAGE.md).

## Where things changed recently

For changes since the last release, see [`../CHANGELOG.md`](../CHANGELOG.md).
The headline unreleased changes: **effective confidence** (a live,
graph-computed trust value on every cell, driving ranking and packets) and
**active relations** (scored tripwire bundles plus `watch`/`drift`/`quorum`
program operations — see
[`06_ADVANCED_GRAPH_OPERATIONS.md`](06_ADVANCED_GRAPH_OPERATIONS.md)).
Compile packets surface incoming challenges, per-cell `eff:` values, and
the standing programs covering each selected cell.

For changes to the docs themselves, see git history on this directory.

## Don't see what you need?

- File an issue: include what you were trying to do, what doc you expected
  to find that information in, and what you ended up doing instead.
- Pull request: documentation contributions are always welcome. See
  [`../CONTRIBUTING.md`](../CONTRIBUTING.md) to get started.
