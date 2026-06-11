# Recall Python toolkit: Quickstart

A literal copy-paste walkthrough from fresh install to first useful query.
All commands verified end-to-end against a fresh empty Recall DB.

## Prerequisites

You need:

1. **Node.js 24+** and the Recall TypeScript core installed (see top-level
   `README.md` for `./scripts/install.sh`). This provides the `recall` CLI.
2. **Python 3.10+**. All core Python tools use stdlib only, so no pip install
   is needed.
3. **(Optional, for benchmarks)** `pip install sentence-transformers numpy`

## 1. Initialize an empty DB

```bash
recall init --db ~/.recall/recall.sqlite3
```

This creates an empty Recall database at the standard XDG location. All the
Python tools auto-discover this path by default. You can override with the
`RECALL_DB` environment variable:

```bash
export RECALL_DB=~/projects/myproject/.recall/recall.sqlite3
```

## 2. Write your first cell

Pick the directory containing the Python tools (we'll call it `$SCRIPTS`):

```bash
SCRIPTS=/path/to/recall/python/scripts
```

Write a decision cell as if you're recording an architectural choice:

```bash
python3 $SCRIPTS/recall_helper.py \
  --kind decision \
  --title "Use bcrypt for password hashing" \
  --body "After comparing bcrypt, scrypt, argon2: bcrypt is the safest default for our use case. Argon2 is theoretically stronger but bcrypt has wider library support and battle-tested for 20 years." \
  --confidence 0.85 \
  --topics "auth,security,architecture-decision" \
  --project "myproject" \
  --admit
```

**Note**: `--confidence` is required with no default. The helper deliberately
forces you to commit to a number. This is the calibration discipline that
makes Recall's epistemic substrate work. Pick a value in (0, 1]:
- `0.95+` for things you've verified and tested
- `0.8` for confident decisions with some uncertainty
- `0.5-0.7` for working hypotheses
- `<0.5` for speculation worth recording but not relying on

Successful admission returns a JSON response with the new cell's ID:

```
{ "accepted": true, "node": { "id": "abc12345-...", "title": "...", ... } }
```

## 3. Peek the cell you just wrote

```bash
# Cheapest possible probe — just the title (~150 bytes):
python3 $SCRIPTS/recall_peek.py abc12345 --field title

# Summary with body excerpt + relation counts (~1-2 KB):
python3 $SCRIPTS/recall_peek.py abc12345

# Full body when needed (no truncation):
python3 $SCRIPTS/recall_peek.py abc12345 --field body --no-truncate
```

The summary shows everything an agent needs to decide whether to fetch the
full body: title, kind, scope, topics, lifecycle, entity sample, provenance,
body excerpt, and relation counts by kind.

## 4. Search across the graph

```bash
# Find cells matching a keyword or substring:
python3 $SCRIPTS/recall_peek.py --match "bcrypt" --limit 5

# Filter by kind:
python3 $SCRIPTS/recall_peek.py --match "auth" --kind decision --limit 5

# Filter by project:
python3 $SCRIPTS/recall_peek.py --match "auth" --project myproject --limit 5
```

## 5. See what's changed

```bash
# Activity in the last hour, with a human-readable summary:
python3 $SCRIPTS/recall_diff.py --since 1h --summary

# Scoped to one project:
python3 $SCRIPTS/recall_diff.py --project myproject --since 1d --summary

# Since a specific cell was written:
python3 $SCRIPTS/recall_diff.py --since-cell abc12345 --summary
```

## 6. Auto-route queries via the meta-router

The router picks the right tool based on the question shape:

```bash
# Temporal queries → recall_diff:
python3 $SCRIPTS/recall_router.py "what changed in the last 2 hours"

# Health queries → recall_health_peek:
python3 $SCRIPTS/recall_router.py "show me contradictions"

# Identifier-shaped lookups → recall_peek --match:
python3 $SCRIPTS/recall_router.py "find the validate_user function"

# Synthesis / open-ended → recall compile (fallback):
python3 $SCRIPTS/recall_router.py "explain the authentication architecture"

# Show routing decision + reasoning without executing:
python3 $SCRIPTS/recall_router.py "your query" --explain-only
```

## 7. Check graph health

```bash
# Compact summary of graph state (stats + warnings + contradictions + stale):
python3 $SCRIPTS/recall_health_peek.py

# Filter contradictions to high-severity only:
python3 $SCRIPTS/recall_health_peek.py --min-severity 0.85

# Drill into one section in full:
python3 $SCRIPTS/recall_health_peek.py --section contradictions --limit 20
```

## 8. Extract a codebase (Python or JavaScript/TypeScript)

```bash
# Python codebase:
python3 $SCRIPTS/recall_code_extract.py \
  --path src/ --project myproject --admit

# JavaScript / TypeScript:
python3 $SCRIPTS/recall_code_extract_js.py \
  --path src/ --project myfrontend --admit

# Single file:
python3 $SCRIPTS/recall_code_extract.py \
  --path src/auth/login.py --project myproject --admit
```

This creates a cell per module and per top-level symbol (function, class,
method), with entity tags that the linker can use to create typed
dependency hyperedges.

## 9. Create typed code-dependency hyperedges

After extracting code cells, run the linker to materialize relationships
between them as hyperedges (`code-defined-in`, `code-references`,
`code-imports`, `code-method-of`):

```bash
# Discovery only (JSONL report, no writes):
python3 $SCRIPTS/recall_code_link.py --project myproject

# Apply (create the hyperedges):
python3 $SCRIPTS/recall_code_link.py --project myproject --apply

# Idempotent re-run (skip edges that already exist):
python3 $SCRIPTS/recall_code_link.py --project myproject --apply --skip-existing
```

## 10. Ingest CI test results

Connect test outcomes to function-under-test cells via typed hyperedges
(`test-supports` for passes, `test-contradicts` for failures):

```bash
# pytest JSON report:
python3 $SCRIPTS/recall_ci_ingest.py \
  --results pytest-report.json --project myproject --admit \
  --run-id "${COMMIT_SHA:-manual}"

# JUnit XML (auto-detected by extension):
python3 $SCRIPTS/recall_ci_ingest.py \
  --results junit.xml --project myproject --admit

# Stats-only preview before admitting:
python3 $SCRIPTS/recall_ci_ingest.py \
  --results report.json --project myproject --stats-only
```

## 11. Re-extract idempotently when code changes

Re-running the extractor by default creates duplicate cells. To re-extract
while preserving history via supersedure hyperedges:

```bash
python3 $SCRIPTS/recall_code_extract.py \
  --path src/ --project myproject --admit --rebuild
```

This creates new cells for each module and symbol, then creates
`code-superseded-by` hyperedges from each old cell to its title-matched new
cell. Old cells remain in the graph (audit trail) but downstream queries can
filter to currently-active cells.

## 12. Auto-extract on every commit

```bash
# From the repo where you want auto-extraction:
cp /path/to/recall/python/git-hooks/post-commit.sample .git/hooks/post-commit
chmod +x .git/hooks/post-commit

# Set the script directory if not in a standard install location:
export RECALL_SCRIPT_DIR=/path/to/recall/python/scripts
```

## 13. Run the benchmark on your own graph

```bash
# Operator-vs-naive comparison (stdlib only):
python3 $SCRIPTS/recall_bench.py --out my-bench.md

# Vector RAG comparison (requires extra deps):
pip install sentence-transformers numpy

python3 $SCRIPTS/recall_bench.py --format json --out router.json
python3 $SCRIPTS/vector_rag_bench.py --compare-router router.json --out vs-rag.md
```

See `reference/HOW_TO_BENCHMARK.md` for full benchmark methodology and how
to customize scenarios for your project.

## Recommended agent integration pattern

For an AI agent (Claude, GPT, Aider, Cursor, etc.) consuming Recall:

```python
# Pseudocode for an agent loop
def agent_turn(user_query):
    # 1. Get graph health if it might affect this turn
    health = subprocess.run(["recall_health_peek.py", "--max-tokens", "1500"])
    if "critical" in health.stdout:
        # Surface critical warnings to the agent's reasoning context
        ...

    # 2. Use the router to fetch context for the query
    context = subprocess.run(["recall_router.py", user_query, "--fallback"])

    # 3. Do the work (LLM call with context)
    result = llm.complete(system_prompt + context.stdout + user_query)

    # 4. Write a cell recording what was learned (if substantive)
    if is_substantive(result):
        subprocess.run([
            "recall_helper.py",
            "--kind", choose_kind(result),
            "--title", extract_title(result),
            "--body", result.body,
            "--confidence", str(result.confidence),
            "--topics", ",".join(extract_topics(result)),
            "--admit",
        ])

    return result
```

For agents that prefer MCP, use the `recall-mcp` server (provided by the
TypeScript core) and call `recall_compile`, `recall_cell`, `recall_search`,
`recall_write` etc. as MCP tools.

## Configuration reference

| Environment variable | Purpose | Default |
|---|---|---|
| `RECALL_DB` | Path to the SQLite DB | `~/.recall/recall.sqlite3` |
| `RECALL_TENANT` | Default tenant for write proposals | `recall-<project-slug>` |
| `RECALL_SCRIPT_DIR` | (Git hook) directory containing the Python tools | tries common install paths |
| `RECALL_PROJECT` | (Git hook) project label for cells | repo basename |

## Troubleshooting

**"DEFAULT_DB resolved to a path that doesn't exist"**

The Python tools resolve `DEFAULT_DB` via env var → `~/.recall/recall.sqlite3`
→ `./.recall/recall.sqlite3`. If none exists, the helper falls back to the
home location. Either run `recall init --db <path>` to create one, or pass
`--db <path>` to every tool invocation.

**"build_proposal failed schema validation"**

If you're getting schema validation errors, you're probably skipping the
helper and constructing proposals manually. Use the helper. It handles all
the schema scaffolding. The helper rejects only missing required fields
(`kind`, `title`, `body`, `confidence`, `topics`) and invalid enum values;
everything else is auto-derived from your inputs.

**"recall_cell returns 80+ KB on a dense cell"**

Use `recall_peek.py` instead. The peek tool returns a bounded summary
(~1-2 KB) by truncating body at the SQL layer and aggregating relations as
counts. Use `recall_peek.py <id> --field body --no-truncate` only when you
actually need the full body.

**"vector_rag_bench.py fails on first run"**

First run downloads `all-mpnet-base-v2` (~80 MB). Make sure
`pip install sentence-transformers numpy` succeeded and you have a network
connection. Subsequent runs use cached embeddings.

## Next steps

- Read the [code-integration reference](./reference/code-integration.md) for
  the full code extension API
- Read [HOW_TO_BENCHMARK.md](./reference/HOW_TO_BENCHMARK.md) for benchmark
  methodology
- See the top-level repo `README.md` for the TypeScript core docs
- See the top-level repo `docs/` directory for architecture, write schema,
  and integration details
