---
name: recall
description: Use when work benefits from durable structured memory across sessions — recalling prior decisions, evidence, risks, tasks, or contradictions, or persisting new ones. Triggers on "remember", "recall", "what did we decide", resuming past work, or starting any non-trivial task that should accumulate memory.
---

# Recall — Active Memory Substrate

## Overview

Recall is a local-first active memory substrate. It stores structured evidence,
decisions, risks, tasks, witnesses, and contradictions **outside the context
window**, and returns compact compiled context packets on demand. Treat it as
long-term memory: read from it before relying on recollection, and write durable
findings back as they arise.

## Setup (already done on this machine)

- DB directory: `~/.recall/db/`
  - `global.sqlite3` — projects registry + cross-cutting/shared cells
  - `<slug>.sqlite3` — one per registered project (auto-created by `recall project init`)
- Back-compat: `~/.recall/recall.sqlite3` symlinks to `db/global.sqlite3` (old hardcoded paths keep working)
- CLI wrapper at `~/.recall/bin/recall` shadows the real binary on PATH and routes by CWD
- MCP server `recall` is registered (user scope), pinned to the legacy path → resolves via symlink to `db/global.sqlite3`
- Real binary still at `/opt/homebrew/bin/recall` (the wrapper calls it via absolute path)

## Project-based DB routing (CWD auto-routing)

Recall now stores cells in per-project SQLite databases. The wrapper picks
which DB to use by walking up from the current working directory through a
registry of project roots; first match wins, fallback to global.

**Register a project once:**

```bash
cd /path/to/your/project
recall project init                       # slug auto-derived from dir name
recall project init --slug my-thing --description "..."
```

**Inspect routing:**

```bash
recall project list                       # all registered projects
recall project where                      # which DB this cwd resolves to + why
```

**Routing precedence** (first match wins):
1. Explicit `--db <path>` → pass through, no routing
2. `--project <slug>` → look up that project's DB
3. Walk cwd upward against registry → deepest registered root wins
4. Fallback → `~/.recall/db/global.sqlite3`

**Federated reads** (project + global in one call):

```bash
recall --include-global compile "topic"   # also works for search/semantic/subgraph
```

Returns `{"federated": true, "project": {...}, "global": {...}}`. Only works
for read verbs; writes always go to exactly one DB.

**Removing:** `recall project remove <slug> [--delete-db]`

## Two access paths — pick the one that works now

**MCP path** — tools named `mcp__recall__*` (e.g. `mcp__recall__recall_write`).
This is the routine path. **But MCP tools only load when Claude Code starts.**
If you do not see `mcp__recall__*` tools in your session, the server was
registered after the session began: tell the user to restart Claude Code to
enable them, and use the CLI path meanwhile.

**MCP limitation — important:** the MCP server is a long-running process
pinned to one DB (the global one via the back-compat symlink). It has no
per-call CWD context, so CWD-based project routing **does not apply to MCP
tool calls** — they all hit global. For project-scoped writes use the CLI
path; reserve MCP for cross-cutting personal memory or when you don't care
which DB lands the cell.

**CLI path** — the `recall` command (the wrapper). Always works, no restart
needed. The wrapper auto-routes based on cwd, so you can usually omit `--db`.
If you do pass `--db <path>`, the wrapper passes it through unchanged — handy
for migrations, debugging, or one-off queries against a specific DB. The old
guidance "every CLI call must pass `--db ~/.recall/recall.sqlite3`" is now
obsolete; let CWD routing handle it.

CLI verbs differ from MCP tool names: MCP `recall_cell` ↔ CLI `recall cell show`.

## Make agents adopt Recall — disable Claude Code's built-in auto-memory

Claude Code ships its own **auto-memory** feature: a `# Memory` system-prompt
section that funnels "save this" / "remember this for later" into flat Markdown
files under `~/.claude/projects/<cwd-slug>/memory/` (`MEMORY.md` + per-fact
`.md` files with `node_type: memory` frontmatter). While it is ON it **shadows
Recall** — a fully-armed agent (this skill + the consult-recall hook + a
discoverable recall MCP) still writes the user's facts to those `.md` files, not
to Recall, because the native `# Memory` instruction competes with the Recall
arming and wins. A clean single-variable A/B confirmed auto-memory is the *sole*
determinant of which store the agent picks.

**Fix — set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.** It removes *only* the
auto-memory `# Memory` section and leaves everything else intact: keychain auth,
hooks, skills, the operating prompt — i.e. full native arming with auto-memory
off. With it off, a fully-armed agent **spontaneously** reaches for Recall on a
natural persist request, and the whole loop runs unprompted: write → supersede
via `contradicts` → cross-session inheritance of the current value.

- **Per run:** `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude …`
  (or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude -p "…"` for headless).
- **Persistently:** add it to the `env` block of `~/.claude/settings.json`:
  `"env": { "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1" }`.
- **Do NOT use `--bare` to turn off auto-memory.** `--bare` also skips hooks
  and keychain reads, so headless `claude -p` dies with `Not logged in` unless
  `ANTHROPIC_API_KEY` / `apiKeyHelper` is set — and it strips the very arming
  that points the agent at Recall. The env var is the surgical switch; `--bare`
  is the wrong tool.
- **Verify it's off:** after a "save this to memory" turn, no new file appears
  under `~/.claude/projects/*/memory/` and a Recall cell appears instead.

**Prompt-intent nuance:** a *passive* one-liner ("Remember that prod DB is
db-east-1.") persists **nowhere** — the agent treats a bare fact-statement as
conversational context in either configuration. Persistence (and thus the store
choice) triggers only when the prompt naturally calls for durable memory ("save
this so future sessions remember it"). Adoption = prompt intent × arming ×
auto-memory off.

## Operating loop

1. **Read first.** Start a task by compiling a context packet for it. Expand
   specific cells only when exact content is needed.
2. **Do the work.**
3. **Write durable memory seamlessly.** Whenever a durable observation,
   decision, risk, task, or witness arises, write it back. Do not ask permission
   for routine memory — this is the intended seamless-memory behavior. **If the
   new memory corrects, updates, or invalidates something already stored, do not
   add an unlinked cell or edit in place — supersede it (see "Corrections
   supersede" below).**
4. Search / semantic / subgraph to retrieve more.
5. Check beliefs/maintenance when a task depends on old or contested memory,
   and `recall calibration` when deciding how much to trust a specific
   actor's high-confidence cells.

## Corrections supersede — never silently overwrite

When new information **changes, corrects, or invalidates** a fact already in
memory, storing the new value is not the win — every memory does that. The win
is recording the *resolution*: the new fact is current, the old one is
superseded, and a later session sees both plus why. So on **any** correction:

1. **Find the prior cell** — `recall search "<topic>"` (or `recall_search`) to
   get its id.
2. **Admit the new fact with `contradicts: ["<prior-cell-id>"]`** (helper flag
   `--contradicts <id>`; MCP `evidence.contradicts`; CLI proposal
   `evidence.contradicts`). Recall then drops the old cell's effective confidence
   and marks it challenged, so `recall compile` in any future session surfaces
   the **current** value and flags the **stale** one.

A correction admitted **without** a `contradicts` link leaves two competing
cells and no resolution — the exact way memory goes quietly stale. And **never
edit a cell's value in place** to "fix" it: supersede it, so the history and the
demotion survive. This is the line between memory that merely *persists* and
memory that stays *honest* — it is the whole point of using Recall over a flat
note file.

## Quick reference

| Action | MCP tool | CLI command (wrapper auto-routes by cwd; no `--db` needed inside a registered project) |
|--------|----------|-----|
| Read context packet | `recall_compile` | `recall compile "task"` |
| Expand one cell | `recall_cell` | `recall cell show <id>` |
| Write memory | `recall_write` | `recall validate --json p.json` then `recall admit --json p.json` |
| Lexical / semantic search | `recall_search` / `recall_semantic` | `recall search "q"` / `recall semantic "q"` |
| Subgraph from tags | `recall_subgraph` | `recall subgraph --project X --category memory` |
| Memory health | `recall_beliefs` / `recall_maintenance` | `recall beliefs` / `recall maintenance` |
| Actor calibration | (in `recall_beliefs` report) | `recall calibration` — per-actor Brier score: stated confidence vs survived-contradiction outcomes |
| Counts / footprint | `recall_status` / `recall_storage` | `recall status` / `recall storage` |

**Retrieval (since 2026-06-09):** lexical search is FTS5+BM25 with porter
stemming and hybrid priors (graph degree, confidence, recency-as-decay) —
compile packets report `retrieval=fts5-bm25`. Compile is graph-aware: the
`conflicts:` section automatically lists incoming `contradicts`/`concerns`
challenges against every selected cell — check it before trusting
`relevant_memory`. Admission also warns when a fresh create nearly
duplicates an active cell (use `update`/`supersede` or reference it). Paraphrase queries still need
shared vocabulary unless a real embedding backend is configured:
`export RECALL_EMBEDDING_URL=http://localhost:11434/api/embed` +
`RECALL_EMBEDDING_MODEL=<model>` (Ollama or any OpenAI-compatible endpoint;
failures fall back to hash and never block writes; run `recall semantic reindex`
after switching). For calibration to close its loop, write `contradicts`
references against actual cell IDs/addresses — free-text claim names do not
resolve and leave the actor's record unscored.

The CLI write path: build a `recall.write.v1` JSON file, `recall validate` it
(returns `"ok": true` with no issues when valid), then `recall admit` it (returns
`"accepted": true` with a cell id and address). `recall admit` is the CLI
equivalent of `recall_write` — it is the correct write path when MCP is
unavailable, despite `recall --help` labeling it an "agent/debug" path.

## Write contract

Durable memory enters only as a `recall.write.v1` proposal — never write SQLite
directly. All nine blocks are required: `actor`, `intent`, `content`, `scope`,
`tags`, `evidence`, `confidence`, `provenance`, `policy`.

**Tags — get this right:** the schema *requires* five tag families —
`topics`, `entities`, `rings`, `lifecycle`, `quality` — each a non-empty string
array. The facet tags `category`, `type`, `subject`, `project`, `idea`,
`timestamp` are **optional** but strongly recommended (they power
`recall_subgraph` composition). Omitting a required family gets the proposal
rejected; omitting facets does not.

`reference/llm-integration.md` has the complete field reference (every enum,
every required/optional field, ranges) and a full worked example. **Read it
before composing your first proposal.** Reference existing memory by a
`recall://cell/...` address or `<cell-id>#field.path` instead of copying bodies.

**Two write disciplines that compound (added 2026-06-09):**

- **Titles ≤ 20 words.** Admission warns above that; long titles get echoed
  across every future compile packet and distort title-weighted ranking. Put
  detail in `body`/`summary`, searchable vocabulary in the title and `topics`.
- **`contradicts` must point at cell IDs or `recall://cell/...` addresses,
  never free-text claim names.** Unresolved references silently drop out of
  contradiction findings AND out of `recall calibration` — the closed-loop
  calibration score only counts contradictions that resolve to real cells.
  (First live calibration run found zero resolved contradictions in a graph
  full of free-text `contradicts` refs — the loop was starving.)

## Write helper — `scripts/recall_helper.py`

For routine writes, **prefer the helper over hand-building proposals**. It
takes minimal agent-friendly inputs (kind, title, body, confidence, topics,
evidence refs) and emits a schema-valid `recall.write.v1` proposal — handling
schema scaffolding, default actor.id (`claude-code`), tag-family construction,
entity auto-extraction (file paths, cell IDs, axiom names), confidence →
source_quality mapping, ISO timestamps, and policy defaults. Eliminates the
3-retry schema-friction tax on first writes per session.

Library use:

```python
import sys
sys.path.insert(0, "~/.claude/skills/recall/scripts")
from recall_helper import build_proposal
proposal = build_proposal(
    kind="lemma",
    title="...",
    body="...",
    confidence=0.85,                          # required; no default — keeps calibration honest
    topics=["topic-1", "topic-2"],            # required; the one tag family agent must commit to
    depends_on=["25e553cc-..."],              # bare IDs auto-normalized to recall://cell/<id>
    contradicts=["8702b4bc-..."],
    source_files=["spec/foo.md#section-3"],
    project="Substrate-V2",
)
# Pass `proposal` to mcp__recall__recall_write.
```

CLI use (emits JSON, optionally validates and/or admits via CLI write path):

```bash
python3 ~/.claude/skills/recall/scripts/recall_helper.py \
  --kind lemma --title "X" --body-file body.md \
  --confidence 0.85 --topics "topic-1,topic-2" \
  --depends-on "25e553cc-..." \
  --source-files "spec/foo.md#section-3" \
  --validate                    # check via `recall validate`
# add --admit to also write via `recall admit` in one shot.
```

What the helper does NOT do: pick `confidence` for you (deliberate — calibration
is the load-bearing discipline), pick the cell `kind` (you choose lemma vs
observation vs reflection vs decision etc.), or replace `recall_compile` /
`recall_cell` for the read side. It only smooths the write side.

## Recall for Code — `scripts/recall_code_extract.py`

For AI coding agents working on large codebases, Recall doubles as an
**epistemic memory substrate for code**: persistent across sessions,
structured for the agent to reason against, with the same calibrated
confidence + supersedure-via-relations + curated compile discipline as
the rest of the system.

The code extension ships extractors for Python (AST-based, full fidelity)
and JavaScript/TypeScript (regex-based, best-effort). Cells are linkable
via entity tags (`py-sym:`/`js-sym:`/`ts-sym:`, etc.) and queryable
through `recall_search`, `recall_subgraph`, and `recall_compile` like
any other cell.

Quick usage:

```bash
# Python codebase:
python3 ~/.claude/skills/recall/scripts/recall_code_extract.py \
  --path src/ --project my-repo --admit

# JavaScript / TypeScript codebase:
python3 ~/.claude/skills/recall/scripts/recall_code_extract_js.py \
  --path src/ --project my-repo --admit

# Single file (auto-detected by extension):
python3 ~/.claude/skills/recall/scripts/recall_code_extract.py \
  --path src/auth/login.py --project my-repo --admit

# JSONL to stdout for inspection (no admit):
python3 ~/.claude/skills/recall/scripts/recall_code_extract.py \
  --path src/ --project my-repo
```

Idempotent re-extraction (preserves old cells, creates `code-superseded-by`
hyperedges from old to new):

```bash
python3 ~/.claude/skills/recall/scripts/recall_code_extract.py \
  --path src/ --project my-repo --admit --rebuild
```

After admitting code cells, run the linker to materialize typed
hyperedge relations (`code-defined-in`, `code-references`, `code-imports`,
`code-method-of`):

```bash
# Discovery only (JSONL report, no writes):
python3 ~/.claude/skills/recall/scripts/recall_code_link.py --project my-repo

# Create the hyperedges:
python3 ~/.claude/skills/recall/scripts/recall_code_link.py --project my-repo --apply

# Idempotent re-apply (skip edges that already exist):
python3 ~/.claude/skills/recall/scripts/recall_code_link.py \
  --project my-repo --apply --skip-existing
```

Inspect edges with `recall hyperedge list --limit 50`.

Auto-run on every commit via the git hook template:

```bash
cp ~/.claude/skills/recall/scripts/git-hooks/post-commit.sample \
   <your-repo>/.git/hooks/post-commit
chmod +x <your-repo>/.git/hooks/post-commit
```

After extraction, agent patterns include "tell me about this function"
(`recall_search "py-sym:validate_user"`), "what depends on this module?"
(`recall_subgraph --entities py-import:my_module`), and "what's decided
about this area?" (`recall_search "decision: <area>"` filtered by kind).

Architectural decision cells, bug-pattern cells, and WIP cells are
written by agents using the standard write helper with code-specific tag
conventions — the extractor handles structural extraction; the agent
handles epistemic capture (decisions, contradictions, debugging insights).

**See `reference/code-integration.md`** for the full schema conventions,
agent-integration patterns, storage expectations, v1 limits, and roadmap.

## Diff-aware compile — `scripts/recall_diff.py`

For agents resuming work mid-task or coming back to a project after time
away: a "what changed since" query that complements the static
`recall_compile` / `recall_search` / `recall_subgraph` reads.

`recall_diff.py` queries the existing CLI verbs and post-filters by
`createdAt` / `updatedAt` timestamps. No new schema. Returns:

- **new_cells** — cells created since the threshold
- **updated_cells** — cells whose `updatedAt > createdAt` since the threshold
- **new_hyperedges** — typed graph edges created since the threshold
- **supersede_events** — surfaced separately because they represent
  retractions / replacements, not additions

Threshold can be a timestamp (ISO-8601 or relative shorthand like
`2h`/`7d`/`4w`) or a cell ID prefix (uses that cell's `createdAt`).

Quick usage:

```bash
# What's changed in the whole graph in the last 2 hours (JSON):
python3 ~/.claude/skills/recall/scripts/recall_diff.py --since 2h

# Human-readable summary scoped to one project (great for session-start context):
python3 ~/.claude/skills/recall/scripts/recall_diff.py \
  --project my-repo --since 1d --summary

# What's been added since cell X was written:
python3 ~/.claude/skills/recall/scripts/recall_diff.py \
  --since-cell 569d3e16 --summary

# Code-only filter (skips non-code cells in mixed-domain DBs):
python3 ~/.claude/skills/recall/scripts/recall_diff.py \
  --project my-repo --since 1w --code-only --summary
```

Use cases: resuming agent sessions ("what happened while I was gone?"),
code review, onboarding to a project, audit ("what got added between
release A and release B?"). The `--summary` mode is designed to be
read directly by an agent at session start to recover context cheaply.

## CI test ingestion — `scripts/recall_ci_ingest.py`

Connects build/test reality to the graph. After CI runs, this tool walks
the test report and:

- Creates a Recall cell per test result (`verification_result` for passes,
  `risk` for failures, `observation` for skipped)
- Creates typed hyperedges from each test-result cell to the function-
  under-test cell (resolved by stripping `test_` prefix from the test
  name and matching against `py-sym:`/`js-sym:`/`ts-sym:` entities)
- Passing tests → `test-supports` hyperedges
- Failing tests → `test-contradicts` hyperedges
- Skipped tests → cell only, no edge

Supports three input formats (auto-detected by extension):
- **pytest JSON** (`pytest --json-report`)
- **JUnit XML** (`pytest --junitxml=`, default for many runners)
- **simple** (one line per test: `STATUS NAME [DURATION] [FILE:LINE] [MESSAGE]`)

Quick usage:

```bash
# pytest JSON ingest:
python3 ~/.claude/skills/recall/scripts/recall_ci_ingest.py \
  --results pytest-report.json --project my-repo --admit

# JUnit XML (auto-detected from .xml extension):
python3 ~/.claude/skills/recall/scripts/recall_ci_ingest.py \
  --results junit.xml --project my-repo --admit

# Stats-only preview before admitting:
python3 ~/.claude/skills/recall/scripts/recall_ci_ingest.py \
  --results report.json --project my-repo --stats-only
```

After ingestion, agent queries like "show me failing tests for this
function" become structured: subgraph by `py-sym:foo` (find the cell),
look at incoming `test-contradicts` hyperedges (find failing tests),
read their bodies (failure messages + tracebacks). Builds the loop:
**static code structure (extractor) → typed dependencies (linker) →
test reality (CI ingest) → resume context (diff).**

Typical CI pipeline integration:

```yaml
# .github/workflows/test.yml (sketch)
- run: pytest --json-report --json-report-file=report.json
- run: |
    python3 ~/.claude/skills/recall/scripts/recall_ci_ingest.py \
      --results report.json --project my-repo --admit \
      --run-id "${{ github.sha }}"
```

## Secrets — hard rule

Never put secrets (tokens, passwords, keys) into the primary graph. Admission
flags common secret shapes (API keys, passwords, URI-embedded credentials, env
dumps) and rejects them — but this is a **high-recall heuristic backstop, not a
guarantee**; do not rely on it to catch a secret. Secrets go ONLY into the
encrypted side graph, ONLY via the explicit CLI command (the
`--confirm-secret-save` flag is required):

```bash
recall secrets save --confirm-secret-save --db ~/.recall/recall.sqlite3
```

## Token-budget-aware cell peek — `scripts/recall_peek.py`

Solves the read-budget bottleneck where `recall_cell` and `recall_beliefs`
return responses larger than the LLM token cap (observed: 85 KB cell
expansion, 57 KB beliefs report, both forcing disk-dump + jq filtering).

Reads SQLite directly (read-only) for column-level control over what
gets loaded. The cell envelope (title, kind, scope, tags, lifecycle,
provenance) is always small; only the body is huge. `recall_peek.py`
returns envelope + configurable body excerpt + relation counts +
hyperedge memberships — without ever loading the full body.

Default response is ~1-2 KB regardless of cell size. ~45× reduction
measured against the L6 substrate-physics cell that previously broke
workflow.

Quick usage:

```bash
# Summary of a cell (default 800-char body excerpt):
python3 ~/.claude/skills/recall/scripts/recall_peek.py 4ae7579e

# Cheapest possible probe (just the title):
python3 ~/.claude/skills/recall/scripts/recall_peek.py 4ae7579e --field title

# Full body opt-in:
python3 ~/.claude/skills/recall/scripts/recall_peek.py 4ae7579e --field body --no-truncate

# Find cells matching a keyword, filtered by kind:
python3 ~/.claude/skills/recall/scripts/recall_peek.py --match "L7" --kind lemma --limit 5

# Hard token-budget cap (shrinks excerpt to fit):
python3 ~/.claude/skills/recall/scripts/recall_peek.py 4ae7579e --max-tokens 2000

# Human-readable format (Markdown) instead of JSON:
python3 ~/.claude/skills/recall/scripts/recall_peek.py 4ae7579e --format human
```

Triage pattern: use `recall_peek` first to decide whether a cell is
worth fetching in full via `recall_cell` / `recall cell show`. The peek
shows lifecycle, relation counts, and body excerpt — enough to decide
"do I need the full thing or is this enough?" without paying the full
fetch cost.

## Token-budget-aware health summary — `scripts/recall_health_peek.py`

Same fix shape as `recall_peek.py`, applied to the other read-side
bottleneck: `recall beliefs` returning 50-60+ KB (hundreds of
contradictions × ~500 chars each + stale list + warnings + provenance +
stats). Wrapping the raw call to compact the report into ~1-3 KB while
preserving the actionable signal.

What's preserved in full (always shown):
- Graph stats (nodes/relations/hyperedges/etc.)
- Provenance summary (witness count, signed/verified ratio, trust)
- Critical warnings (codes + messages)
- Next actions (the system's suggestions)

What's compacted:
- Contradictions: total count + bucket by severity (high/medium/low) +
  top N by severity (titles only, no full bodies)
- Stale cells: total + top N by severity
- Beliefs: total + sample
- Curiosity targets: total + sample

Quick usage:

```bash
# Compact human summary (default):
python3 ~/.claude/skills/recall/scripts/recall_health_peek.py

# Filter contradictions to high-severity only:
python3 ~/.claude/skills/recall/scripts/recall_health_peek.py --min-severity 0.85

# Full drill-down on one section (escape hatch):
python3 ~/.claude/skills/recall/scripts/recall_health_peek.py \
  --section contradictions --limit 30

# Hard token-budget cap (iteratively shrinks per-section item count):
python3 ~/.claude/skills/recall/scripts/recall_health_peek.py --max-tokens 1500
```

Measured: 63 KB raw → 3.2 KB compact (~20× reduction). The compact view
keeps everything an agent needs to decide "do I need to dig further?"
without paying the full payload cost. Use `--section` when the answer
is yes for a specific section.

## Common mistakes

- Forgetting that MCP tools always hit the global DB — they cannot use CWD routing because the server has no per-call cwd. Use the CLI wrapper for project-scoped writes.
- Bypassing the wrapper by calling `/opt/homebrew/bin/recall` directly → loses CWD routing. Always use bare `recall` (resolves to `~/.recall/bin/recall` via PATH).
- Forgetting to `recall project init` a new workspace → writes land in global instead of a dedicated project DB. Run `recall project where` if unsure.
- Omitting a required tag family (`topics`/`entities`/`rings`/`lifecycle`/`quality`) → proposal rejected.
- Assuming `mcp__recall__*` tools exist → check first; fall back to CLI if absent.
- Dumping prose blobs instead of structured records → defeats the schema.
- Pasting an existing cell body into a new write → reference it by address.
- Writing memory before reading → always compile a context packet first.
- Asking the user to save routine observations → write them yourself.
- Calling `recall_cell` on a cell whose relation graph is dense → response can blow past
  token budget. Use `recall_peek.py` for triage first.
- Writing 50-word titles → admission warns, packets bloat, ranking distorts. Detail belongs in body/summary.
- Writing `contradicts` against free-text claim names → never resolves; contradiction findings and `recall calibration` both go blind. Use cell IDs/addresses.
- Expecting paraphrase queries to hit without shared vocabulary → lexical retrieval is BM25+stemming, not semantic. Either include the words a future asker would use (title + `topics`), or configure a real embedding backend (`RECALL_EMBEDDING_URL`) and reindex.
- Authoring eval/bench expected substrings that appear in a tool's echo or error output (e.g. `peek --match` echoes its search term in "0 cells matching '...'") → false-positive relevance hits. Expected substrings must come from a verified answer cell's content only.

## Benchmark — `scripts/recall_bench.py`

For validating the operator-style vs naive-retrieval cost claim against
your own graph state. Runs a 7-scenario suite covering lookups, synthesis,
diff, health, and code lookup; compares `recall search` (full-body
top-k, vector-RAG cost profile) against the appropriate operator tool
per scenario.

```bash
python3 ~/.claude/skills/recall/scripts/recall_bench.py --out report.md
```

Reference benchmark run (2026-06-09, post FTS5+BM25 retrieval rebuild,
expectations refreshed against current graph state): **op-fixed 7/7 and
router 7/7 relevance**, naive (`recall search`) 5/7 — its two misses are
structural, not retrieval bugs: temporal ("what changed in 4h") and
computed-state ("current contradiction load") questions cannot be answered
by searching stored cell bodies; they need `recall_diff` / health tools.
Byte profile: ~39× naive→router reduction.

History: the 2026-05-24 run scored 4/7 with "compile lexical-ranking
issues" (`reference/benchmark-2026-05-24.md`) — that ranking bug class was
fixed 2026-06-09 (FTS5+BM25 + adversarial test gate in the Recall repo).
Expected substrings age with the graph: when scenarios start missing,
re-verify each against a READ answer cell before blaming retrieval.

## Meta-router — `scripts/recall_router.py`

Picks the right operator tool per query based on pattern detection.
Closes the relevance gap exposed in the benchmark by routing queries
to the tool whose retrieval shape matches the question shape.

Routing rules (zero-dep, explainable):

| Pattern | Tool |
|---|---|
| 8+ hex chars (cell-ID prefix) | `recall_peek` |
| Time expression ("Nh"/"Nd"/"Nw") or temporal keyword | `recall_diff --since` |
| Health keyword (contradictions/stale/warnings) | `recall_health_peek` |
| Identifier-y (snake_case, CamelCase, version-string, L7-style) | `recall_peek --match` |
| Anything else | `recall compile` |

```bash
# Auto-route and execute:
python3 ~/.claude/skills/recall/scripts/recall_router.py "what changed in the last 2 hours"

# Show routing decision + reasoning:
python3 ~/.claude/skills/recall/scripts/recall_router.py "find build_proposal" --explain

# Fallback to secondary tool if primary returns empty:
python3 ~/.claude/skills/recall/scripts/recall_router.py "v1.4 CI" --fallback

# Force a specific tool:
python3 ~/.claude/skills/recall/scripts/recall_router.py "..." --tool compile
```

Since the 2026-06-09 retrieval rebuild, compile's relevance gap (the
router's original motivation) is largely closed — the router's remaining
value is byte cost and question shape: temporal queries need `recall_diff`,
health queries need `recall_health_peek`, and cell-ID/identifier lookups
are far cheaper through peek than compile. 2026-06-09 run: router 7/7
relevance at ~39× byte reduction over naive. (Historical: 2026-05-24
router run scored 6/7 vs compile's 4/7 — see
`reference/benchmark-2026-05-24-router.md`.)

## ACP delegation — subagent worker pattern (validated 2026-06-09)

Recall's ACP layer (`recall acp ...` verbs, `acp_requests` table) is
substrate-mediated RPC between agents: a durable queue whose actions are
recall operations (`compile`, `search`, `semantic`, `subgraph`, `write`,
`maintenance`, `tick`, `operate_once`) — NOT an arbitrary task runner.
The working division of labor: **ACP carries coordination + memory I/O;
a spawned subagent carries the labor.**

The loop (live-validated; pattern cell tagged `acp-workflow` in global):

```bash
# 1. Orchestrator enqueues the worker's context packet as a queued request:
cat > /tmp/req.json << 'JSON'
{"fromAgent": "claude-main", "toAgent": "<worker-id>", "action": "compile",
 "payload": {"task": "<what the worker needs context about>", "words": 700}}
JSON
recall acp send --json /tmp/req.json

# 2. Spawn a subagent with identity <worker-id>. Its FIRST act:
recall acp process --acp-manager <worker-id> --acp-to-agent <worker-id> --limit 20
#    -> executes the queued compile; the response JSON is its context packet.

# 3. Worker does the labor with normal tools (edit/run/test).

# 4. Worker reports back THROUGH the queue: helper-generated proposal,
#    wrapped as {"action": "write", "payload": {"proposal": <object>}},
#    then acp send + acp process. Findings land as a cell; the admission
#    receipt is the ACP response.

# 5. Orchestrator verifies: recall acp list / acp show <id> / peek the cell.
```

What this buys over plain subagent prompting: the whole collaboration is
durable and auditable in `acp_requests` (who asked what of whom, full
responses); a dead worker's queue survives for another to drain; requests
can be enqueued now and processed later by a cron'd `recall acp run`
(cross-session asynchrony). What it does not buy: arbitrary task execution
inside the queue — the labor always needs an agent with tools.
