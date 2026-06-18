# Recall: Python Client Toolkit

This directory contains an optional **Python client toolkit** that sits on top
of the core Recall TypeScript runtime. The toolkit provides agent-facing tools
that make the operatable-memory pattern practical for AI agents written in
Python or talking to Recall via subprocess / MCP.

The core Recall runtime (TypeScript, in `src/`) is the source of truth for
storage, write validation, and graph operations. The Python tools here wrap
the CLI surface (`recall` and `recall-mcp`) with agent-friendly conveniences.

## What's in the box

| Tool | Purpose |
|---|---|
| `scripts/recall_helper.py` | Schema-validated write helper. Eliminates first-write schema-retry friction. |
| `scripts/recall_peek.py` | Token-budget-aware cell summary. ~45× reduction vs naive cell expansion. |
| `scripts/recall_health_peek.py` | Compacted graph-health summary. ~20× reduction vs raw beliefs report. |
| `scripts/recall_diff.py` | "What changed since" query for session resumption. |
| `scripts/recall_router.py` | Meta-router dispatching queries to the right retrieval tool. |
| `scripts/recall_code_extract.py` | Python AST extractor (cells for modules + symbols). |
| `scripts/recall_code_extract_js.py` | JavaScript/TypeScript extractor (regex-based; tree-sitter v2 planned). |
| `scripts/recall_code_link.py` | Code-relation linker. Creates typed hyperedges between code cells. |
| `scripts/recall_ci_ingest.py` | CI test ingest. Connects test results to function-under-test cells. |
| `scripts/recall_bench.py` | Benchmark harness: naive / op-fixed / router retrieval comparison. |
| `scripts/vector_rag_bench.py` | Real vector RAG benchmark (sentence-transformers + cosine). |
| `scripts/recall_semantic_real.py` | Real-embedding backend (mpnet, 768-dim). Standalone batched indexer with `query` / `compare` / `verify` / `status` subcommands. |
| `scripts/recall_mpnet_embedder.py` | Adapter for `RECALL_EMBEDDING_COMMAND` that wires mpnet into the TS-side `recall semantic` so per-query and per-write embedding use real vectors. |
| `hooks/recall_inject_context.py.sample` | UserPromptSubmit hook injecting Recall status into every user turn (soft enforcement). |
| `hooks/recall_writeback_reminder.py.sample` | Stop/SubagentStop hook reminding the agent to persist substantive findings (soft enforcement). |
| `hooks/recall_pretooluse_guard.py.sample` | PreToolUse hook blocking mutations without a recorded rationale cell (hard enforcement). |
| `hooks/audit_compliance.py` | Point-in-time compliance score (write-day ratio, kind/confidence diversity, supersedure use). |
| `hooks/longitudinal_tracker.py` | Snapshot + trajectory analysis: rationale quality, rework, enforcement events, continuity value over time. |
| `hooks/test_hooks.py` | 23-test verification suite for all hooks + tracker. |
| `tests/system_tests.py` | 20-test system suite: 10 stress tests + 10 capability tests against Recall primitives. |
| `tests/competitive_tests.py` | 10-test head-to-head comparison vs 6 competitor memory architectures. |
| `git-hooks/post-commit.sample` | Auto-extract code cells on every commit. |
| `reference/code-integration.md` | Code extension reference with agent integration patterns. |
| `reference/HOW_TO_BENCHMARK.md` | Benchmark methodology + how to reproduce. |

## Configuration

All tools accept `--db <path>` flag. The default resolution order:

1. `RECALL_DB` environment variable (recommended for production)
2. `~/.recall/recall.sqlite3` (XDG-ish standard, where `recall init` puts it by default)
3. `./.recall/recall.sqlite3` (per-project, useful for repo-scoped use)

For the helper's tenant default:
- `RECALL_TENANT` environment variable, OR
- `recall-<project-slug>` (anonymous-friendly default)

## Installation

The Python tools split into three dependency tiers:

```bash
# Tier 1: Core tools. Stdlib only, no install needed.
#   helper, peek, diff, router, code extractors, linker, CI ingest,
#   all hooks, audit_compliance, longitudinal_tracker (snapshot/report).
python3 python/scripts/recall_helper.py --help

# Tier 2: Real embeddings + benchmark suite.
#   Needs sentence-transformers + numpy.
#   Enables: recall_semantic_real, recall_mpnet_embedder, vector_rag_bench.
pip install sentence-transformers numpy

# Tier 3: Optional: TS-side semantic via mpnet (production setup).
#   After installing tier 2, point Recall at the adapter:
export RECALL_EMBEDDING_COMMAND='python3 /full/path/to/python/scripts/recall_mpnet_embedder.py'
python3 python/scripts/recall_semantic_real.py reindex --ts-compatible
recall semantic "any natural-language query"   # now uses real embeddings
```

See [docs/13_DAEMON_MCP_SEMANTIC_SUBGRAPHS.md](../docs/13_DAEMON_MCP_SEMANTIC_SUBGRAPHS.md)
for the full backend integration explanation.

To make the tools callable from anywhere, either:

```bash
# Option A: add to PATH:
export PATH="$PATH:$(pwd)/python/scripts"

# Option B: symlink into a directory already on PATH:
for f in python/scripts/recall_*.py; do
  ln -s "$(pwd)/$f" "$HOME/.local/bin/$(basename $f .py)"
done
```

## End-to-end quickstart

See [QUICKSTART.md](./QUICKSTART.md) for a literal copy-paste walkthrough
from fresh install to first useful query, covering all 11 tools with
verified-working commands.

## Quick examples

### Write a cell (with calibrated confidence)

```bash
python3 python/scripts/recall_helper.py \
  --kind lemma \
  --title "API rate limit is 5K req/hour per token" \
  --body "Discovered via production traffic spike. Documented in handbook." \
  --confidence 0.9 \
  --topics "api,rate-limits,production-discovery" \
  --source-files "docs/api/limits.md" \
  --project "my-api" \
  --admit
```

The `--confidence` flag is required with no default. This is by design:
forcing the agent to commit to a numerical confidence preserves calibration
discipline across the corpus.

### Triage a cell cheaply

```bash
# Just the title (cheapest probe, ~150 bytes):
python3 python/scripts/recall_peek.py abc12345 --field title

# Summary with body excerpt + relation counts (~1-2 KB):
python3 python/scripts/recall_peek.py abc12345

# Full body when needed:
python3 python/scripts/recall_peek.py abc12345 --field body --no-truncate

# Cross-graph keyword search:
python3 python/scripts/recall_peek.py --match "rate-limit" --limit 5
```

### Resume a session

```bash
# What changed in the last day in this project:
python3 python/scripts/recall_diff.py --project my-api --since 1d --summary

# What's been added since a specific cell:
python3 python/scripts/recall_diff.py --since-cell abc12345 --summary
```

### Auto-route a query

```bash
python3 python/scripts/recall_router.py "what changed in the last 2 hours"   # → diff
python3 python/scripts/recall_router.py "show me contradictions"             # → health
python3 python/scripts/recall_router.py "find validate_user function"        # → peek-match
python3 python/scripts/recall_router.py "explain the auth architecture"      # → compile
```

### Code extension

```bash
# Extract cells from a Python codebase:
python3 python/scripts/recall_code_extract.py --path src/ --project my-api --admit

# JS/TS:
python3 python/scripts/recall_code_extract_js.py --path src/ --project my-frontend --admit

# Create typed dependency hyperedges:
python3 python/scripts/recall_code_link.py --project my-api --apply

# Ingest CI test results (links tests to function-under-test cells):
python3 python/scripts/recall_ci_ingest.py \
  --results pytest-report.json --project my-api --admit \
  --run-id "${COMMIT_SHA}"

# Auto-extract on every commit:
cp python/git-hooks/post-commit.sample .git/hooks/post-commit
chmod +x .git/hooks/post-commit
# Set RECALL_SCRIPT_DIR env var pointing at this scripts directory
```

### Run the benchmark

```bash
# Operator-vs-naive comparison (uses recall search as the naive baseline):
python3 python/scripts/recall_bench.py --out bench-report.md

# Real vector RAG comparison (requires sentence-transformers):
python3 python/scripts/recall_bench.py --format json --out router.json
python3 python/scripts/vector_rag_bench.py --compare-router router.json --out vs-rag.md
```

No reference benchmark results are shipped. The output is specific to
the graph state at run time, and we don't ship private content. See
`reference/HOW_TO_BENCHMARK.md` for how to run the benchmark against
your own graph and what the results mean.

## Design philosophy

The Python tools are intentionally:

- **Minimal-dependency**: core tools use only stdlib, so they install with zero
  pip work in any modern Python environment
- **Compositional**: each tool does one thing well; they compose via JSON output
  and shell pipelines
- **Calibration-preserving**: the helper requires explicit numerical
  confidence at write time (no defaults), preserving the discipline that makes
  Recall's operatable-memory pattern accurate
- **Read-side disciplined**: peek-first, drill-down only when needed, with
  token budgets bounded by design

If you want to contribute additional language extractors, integration tools, or
benchmark scenarios, see the top-level `CONTRIBUTING.md` in the repo root.

## Relationship to the TypeScript core

This Python toolkit does not replace the core Recall TypeScript runtime
(`src/`). The TS runtime:
- Owns the SQLite storage and schema
- Implements the write-validation firewall
- Provides the `recall` CLI and `recall-mcp` MCP server
- Handles secrets side-graph, daemon scheduling, eval machinery

The Python tools wrap and extend that core, providing:
- Agent-friendly write helpers
- Token-budget-aware read mechanisms
- Code extension subsystems
- The meta-router
- Benchmark harnesses

For most production use, you'd install both: the TS core for the storage and
write firewall, plus the Python tools for the agent-facing client surface.

## Reference docs

- [code-integration.md](./reference/code-integration.md): full code extension reference
- [HOW_TO_BENCHMARK.md](./reference/HOW_TO_BENCHMARK.md): how to run the benchmark against your own graph
