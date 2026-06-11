<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/recall-banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/recall-banner-light.svg">
  <img alt="Recall — active memory substrate for LLM agents" src=".github/assets/recall-banner-light.svg" width="100%">
</picture>

<br/>
<br/>

**Disciplined, operable memory for LLM agents — evidence-weighted, auditable, and compiled to a budget instead of poured back into the prompt.**

[![License](https://img.shields.io/badge/license-Apache--2.0-0d9488.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-0d9488.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-94%20passing-2dd4bf.svg)](#development)
[![E2E](https://img.shields.io/badge/e2e-94%20checks-2dd4bf.svg)](scripts/e2e.mjs)
[![Local-first](https://img.shields.io/badge/local--first-no%20cloud%20required-5eead4.svg)](#why-recall)
[![Status](https://img.shields.io/badge/status-early%20runtime-f59e0b.svg)](#project-status)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-0d9488.svg)](CONTRIBUTING.md)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-5eead4.svg)](CODE_OF_CONDUCT.md)

[Install](#install) ·
[Quickstart](#the-60-second-tour) ·
[Agents & MCP](#hook-up-your-agent) ·
[How it works](#how-it-works) ·
[Why Recall](#why-recall) ·
[Compare](#how-recall-compares) ·
[Docs](docs/README.md) ·
[Roadmap](ROADMAP.md)

</div>

---

**Recall is disciplined, operable memory — a runtime, not a pile of notes.** Most agent "memory" is
chat logs or a vector index you pour back into the prompt and hope. With
Recall, an LLM proposes a structured write; an admission firewall validates
it; the graph store persists it as addressable cells and n-ary hyperedges in
local SQLite; and the compiler returns only the relevant subgraph — ranked by
evidence, fit to a word budget. Every fact carries provenance, confidence,
and a rollback entry. Memory you can **inspect, question, and undo**.

One installable Node.js tool: CLI, read-only TUI, MCP server, quiet
maintenance daemon, strict write schema, semantic search, encrypted secrets
side graph, and a reproducible benchmark harness.

## Install

```bash
npm install -g github:H-XX-D/recall-memory-substrate
```

Or use the installer script, which clones, builds, and links `recall` +
`recall-mcp`:

```bash
curl -fsSL https://raw.githubusercontent.com/H-XX-D/recall-memory-substrate/main/scripts/install.sh | bash
```

Requires **Node.js 24+**. Recall uses Node's built-in SQLite — no database
server, no native builds, no account, no network. Runs on macOS and Linux.
Upgrades, uninstall, and troubleshooting: [Installation Guide](docs/11_INSTALLATION.md).

## The 60-second tour

```bash
recall init       # create the local graph in ./.recall
recall status     # store health, counts, config
```

Memory enters as **structured, schema-validated proposals** — normally your
agent submits these over MCP ([see below](#hook-up-your-agent)), but the same
path is available from the shell:

```bash
recall admit --json decision.json   # validated, provenance-stamped, rollbackable
```

And it comes back as a **compiled context packet**, not a dump of the store:

```bash
recall compile "prepare the auth service deploy" --words 220
```

```text
objective:
prepare the auth service deploy

compiler_state:
- retrieval=fts5-bm25; query="prepare the auth service deploy"; selected_cells=3; budget_words=220
- health=beliefs:0, contradictions:0, stale_or_low_trust:0, critical_warnings:0

relevant_memory:
- Cap the Postgres pool at 20 connections: Staging fell over at 35 concurrent
  connections during the load test on June 3. Capped pool_size at 20 in service
  config; raising it requires a load test sign-off. [decision:07fbbfd9-…]

risks:
- Auth tokens expire but never rotate: Access tokens have 24h expiry but no
  rotation path; a leaked token stays valid until expiry. [risk:1cb991a1-…]

tasks:
- Add a smoke check for the new rate limiter: The rate limiter shipped behind a
  flag; nobody has verified the 429 path end to end. [task:8bddbb07-…]

expansion_handles:
- 07fbbfd9-…  1cb991a1-…  8bddbb07-…
```

The packet is the product: ranked evidence, surfaced risks and open tasks,
contradiction warnings when they exist, and expansion handles for drilling
into any cell — all under a hard word budget. Browse the graph anytime:

```bash
recall tui                          # read-only terminal dashboard
recall search "rate limiter"        # FTS5 + BM25 lexical search
recall semantic "token rotation"    # semantic search (hash or real embeddings)
```

**And the graph prices its own claims.** Next to the author's immutable
stated confidence, every cell carries a living **effective confidence** —
recomputed on every read from incoming supports, challenges, and the
writer's contradiction record. Write one contradiction and watch the number
move:

```text
# before — the pool-cap decision stands alone
decision:6eba1114…  state=active/conf:0.7/eff:0.7/…

# after — one cell contradicts it (nothing deleted, no model ran)
decision:6eba1114…  state=active/conf:0.7/eff:0.29(challenged)/…
```

Challenged cells sink in ranking, supported cells hold, and chronically
overconfident writers get discounted — deterministically, offline,
reproducibly.

Runtime state stays local and is git-ignored by default:

```text
.recall/recall.sqlite3      # primary graph
.recall/secrets.sqlite3     # encrypted secrets side graph
```

## Hook up your agent

Routine memory is **agent-managed through MCP** — users shouldn't hand-save
ordinary observations, decisions, risks, or tasks.

```bash
recall mcp config --db .recall/recall.sqlite3   # print an MCP config block
recall-mcp                                       # start the stdio MCP server
```

Paste the config block into any MCP-capable client (Claude Code, desktop
apps, agent runtimes), then drop the
[LLM System Prompt](docs/LLM_SYSTEM_PROMPT.md) into your agent's instructions.
The agent's loop becomes: **compile → work → write back**.

| Tool | Purpose |
|---|---|
| `recall_compile` | Compile a compact context packet for a task — **start here** |
| `recall_write` | Submit a strict, evidence-aware memory proposal |
| `recall_search` / `recall_semantic` | Retrieve graph evidence by exact or semantic match |
| `recall_subgraph` | Compose subgraphs from structured tags |
| `recall_daemon_run_once` | Run one outside-the-LLM maintenance pass |

There are 42 MCP tools in total — status, hyperedges, programs, DAGs, evals,
ACP agent coordination, calibration, and more. The
[LLM Integration Guide](docs/LLM_INTEGRATION.md) is the full operating
contract, including the proposal shape.

## How it works

<div align="center">
<img alt="The Recall loop: an LLM proposes a write, admission validates and firewalls it, the graph store persists addressable cells and hyperedges, and the context compiler returns a compact packet." src=".github/assets/recall-architecture.svg" width="100%">
</div>

1. **Propose.** The LLM submits a `recall.write.v1` proposal with content,
   evidence, confidence, provenance, and structured tags.
2. **Admit.** Admission validates the schema, applies firewall checks,
   attenuates unsupported claims, warns on near-duplicates, blocks
   secret-looking content, and journals a rollback entry.
3. **Store.** Memory persists as addressable cells and n-ary hyperedges in
   SQLite — reachable by address, tag, relation, or semantic search.
4. **Compile.** The compiler builds a compact, task-specific packet under a
   word budget, surfacing each cell's challengers alongside it and pricing
   every cell's effective confidence from the live graph.
5. **Maintain.** A quiet daemon runs stale-memory, contradiction, derivation,
   and eval passes *outside* the LLM — writing back through the same
   admission path as everyone else.

The base structure is a hypernetwork; DAGs are optional overlays for ordered
workflows, evidence chains, and execution traces.

**Relations can also act.** A hyperedge can carry a declared, versioned,
sandboxed operation (`recall.program.v1` — score, tag projection, witness
emission) and be run on demand. Bind a decision to its risks and
verifications, and the bundle audits itself — scored from **live effective
confidence**, so it doubles as a tripwire:

```text
recall program run <program-id>     # Friday deploy gate
  → averageEffectiveConfidence: 0.7, score: 0.827

# …new evidence contradicts the load-test verification…

recall program run <program-id>     # same gate — no model ran
  → averageEffectiveConfidence: 0.322, score: 0.638

recall program run <program-id> --derive
  → derives a first-class witness cell, filed through the same admission
    gate as every other write
```

No other memory system has active relations: passive triplets and prose
blocks can only be acted *upon* by an external model. Here, a deploy gate's
score falls on its own when any member is contradicted — by a teammate,
another agent, or a failing test wired in through `test-contradicts` edges.
The graph takes minutes of its own meetings, deterministically. See
[Advanced Graph Operations](docs/06_ADVANCED_GRAPH_OPERATIONS.md).

**And relations can stand guard.** The `watch` operation turns a bundle
into a standing reflex: it baselines against its own previous run (history
is state — no extra machinery), trips when the bundle's live effective
confidence moves more than `delta`, and stays silent otherwise — silence
means *verified* stability, not no-news:

```text
recall program add <hyperedge-id> --json watch.json
  # { "schemaVersion": "recall.program.v1", "operation": "watch",
  #   "params": { "delta": 0.15, "concernTarget": "<decision-cell-id>" } }

recall program run <program-id> --derive
  → untripped: derives nothing
  → tripped:   files a concern against the target decision, through the
               same admission gate as every other write, attributed to
               program:<id>
```

A reflex never pokes values — it **files claims**. Tripped watches propose
through admission like everyone else, which means reflexes carry
`produced_by` and accumulate a calibration record: a trigger-happy watcher
whose concerns keep getting refuted gets discounted by the same loop that
disciplines humans and LLMs. Chain them — a verification collapses, its
watcher files a concern on the decision built on it, the decision's
effective confidence falls, *its* watcher wakes — and belief revision
propagates through your dependency graph one audited write at a time. Cron
a watch and any standing decision becomes a monitored service: gate score
in your dashboards, alerts in the channel your team already reads. Deeper concepts live in the
[docs](docs/README.md): the [write schema](docs/02_WRITE_SCHEMA.md),
[tagging & subgraphs](docs/03_TAGGING_AND_SUBGRAPHS.md), the
[context compiler](docs/04_CONTEXT_COMPILER.md), and
[cells & graph views](docs/14_ADDRESSABLE_CELLS_AND_GRAPH_VIEWS.md).

## Why Recall

Recall makes a few opinionated bets that most memory layers don't:

| | Most memory layers | **Recall** |
|---|---|---|
| **Trust model** | Append text, trust later | Every write passes an **admission firewall**: schema-validated, provenance-stamped, rollbackable |
| **What returns to the model** | The whole store, or a top-k blob | A **compiled context packet** — the relevant subgraph, ranked by evidence, fit to a word budget |
| **Structure** | Flat notes or a single knowledge graph | **Addressable cells + n-ary hyperedges**, with optional DAG overlays for ordered work |
| **Where it lives** | A cloud service you send data to | **Local-first.** SQLite on your machine. No account, no network required |
| **Secrets** | Mixed into the same store | A separate **encrypted side graph**, opt-in, never in the primary graph |
| **Mistakes** | Overwrite and move on | **Rollback, don't overwrite** — supersede by relation, keep the audit trail |
| **Maintenance** | Manual curation, or none | A **quiet daemon** runs stale-memory, contradiction, and derivation passes _outside_ the LLM |
| **Calibration** | Confidence is decoration | **Closed-loop calibration** — each actor's stated confidence is scored against survived contradictions |
| **Confidence** | A static number typed once | A **living number** — effective confidence is recomputed from supports, challenges, and the writer's track record on every read, with no LLM in the loop |

The throughline: **memory you can audit.** Provenance on every cell, a
firewall on every write, a packet you can read instead of a prompt you can't.

## How Recall compares

The deepest split in agent memory is **how trust changes** when new
information arrives. The field has three mechanisms:

| Mechanism | Who uses it | What happens to a contested claim |
|---|---|---|
| **A model decides** | mem0, Zep, Letta, Hindsight | An LLM resolves the conflict at ingest, invalidates the fact, or "reflects" beliefs into new shapes — opaque, non-reproducible, and the loser is often rewritten or deleted |
| **The clock decides** | decay-based systems | Importance fades on a forgetting curve, whether or not any evidence arrived |
| **The evidence decides** | **Recall** | Effective confidence is recomputed from typed supports, challenges, and the writer's contradiction record — same graph, same number, every time |

**Other systems ask a model what to believe. Recall computes it.**

The rest are **architectural design properties**, not benchmark claims. Pick
the tool that matches how much you care about auditability and local control.

| Property | Vector RAG | Knowledge-graph memory | Cloud memory APIs | **Recall** |
|---|:---:|:---:|:---:|:---:|
| Runs fully local, no account | sometimes | sometimes | ✗ | ✅ |
| Structured write schema enforced | ✗ | partial | varies | ✅ |
| Admission firewall on every write | ✗ | ✗ | varies | ✅ |
| Provenance + rollback per write | ✗ | partial | varies | ✅ |
| N-ary hyperedges (not just pairwise) | ✗ | rare | ✗ | ✅ |
| Word-budgeted compiled context | ✗ | ✗ | partial | ✅ |
| Encrypted, segregated secrets store | ✗ | ✗ | varies | ✅ |
| Single runtime, one memory API | ✗ | varies | n/a | ✅ |
| Trust evolves with **no LLM in the loop** | ✗ | ✗ | ✗ | ✅ |
| Tiered reads over **trust-annotated claims** (title → peek → full cell) | ✗ | partial | partial | ✅ |

Tiered, agent-navigated retrieval is an emerging pattern across the field —
Letta pages between memory tiers, and progressive-disclosure indexes are
appearing elsewhere. Recall's difference is **what sits at each tier**: not
auto-summaries of activity, but gate-vetted claims carrying live trust
state, addressed in the same namespace the evidence machinery uses — so the
index layer tells the agent *where* digging is warranted, not just that it
may.

Recall trades turnkey cloud convenience for **local control and an audit
trail.** If you want a hosted, batteries-included memory service, projects
like mem0, Letta, and Zep are excellent. If you want memory that lives on
your machine and that you can interrogate write-by-write, that's Recall.

## CLI cheat sheet

```bash
# inspect
recall status
recall tui [--watch]

# retrieve
recall search "query"
recall semantic "query"
recall subgraph --project Recall --category memory --subject compiler
recall compile "task description" --words 900

# write (agent/debug path; normal memory flows through MCP recall_write)
recall validate --json proposal.json
recall admit    --json proposal.json

# undo
recall rollback list
recall rollback show <journal-id>
recall rollback apply <journal-id>

# advanced graph runtime
recall hyperedge add --json hyperedge.json
recall program add <hyperedge-id> --json program.json
recall dag analyze <overlay-id> --derive
recall eval run --derive
recall operate once --derive

# health & trust
recall beliefs
recall calibration
recall maintenance --derive

# daemon
recall daemon run-once [--derive]
recall daemon run --interval-ms 60000

# secrets (encrypted side graph, explicit confirmation required)
printf 'password\nsecret-value' | recall secrets save \
  --title "service token" --confirm-secret-save --password-stdin --value-stdin
```

Run `recall help` for the full command surface, or see the
[CLI & TUI reference](docs/05_CLI_TUI.md).

## Benchmarks

Recall ships a reproducible public benchmark — a synthetic corpus in a
throwaway database, measuring latency and throughput across the operational
surfaces (`admit_write`, `search`, `semantic`, `compile`, paging, daemon and
operator passes, secrets):

```bash
npm run bench:public
```

Numbers vary by machine; the harness is the claim, not a leaderboard. See
[Public Benchmark](docs/19_PUBLIC_BENCHMARK.md) for methodology.

## Documentation

Start with the [docs index](docs/README.md) — it routes by purpose and by
audience. Highlights:

- [Installation Guide](docs/11_INSTALLATION.md)
- [Architecture](docs/01_ARCHITECTURE.md)
- [Strict Write Schema](docs/02_WRITE_SCHEMA.md) — the `recall.write.v1` contract
- [Context Compiler](docs/04_CONTEXT_COMPILER.md)
- [LLM Integration Guide](docs/LLM_INTEGRATION.md) · [LLM System Prompt](docs/LLM_SYSTEM_PROMPT.md)
- [Secrets Side Graph](docs/12_SECRETS_SIDE_GRAPH.md)
- [Daemon, MCP & Semantic Search](docs/13_DAEMON_MCP_SEMANTIC_SUBGRAPHS.md)
- [Public Benchmark](docs/19_PUBLIC_BENCHMARK.md)

## Development

```bash
npm install
npm run build     # tsc
npm test          # 94 unit/integration tests
npm run e2e       # 94 end-to-end checks across user + agent workflows
npm run smoke     # init + status on a throwaway db
```

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Keep changes schema-first, small,
tested, and aligned with the single-runtime architecture. A good first PR
runs `npm test && npm run e2e` clean. The [Roadmap](ROADMAP.md) lays out
direction by ring — Foundation, Runtime, and Interfaces. Working in this repo
with an AI agent? Point it at [AGENTS.md](AGENTS.md).

## Security

Read [SECURITY.md](SECURITY.md) before using Recall with sensitive data.
Important defaults:

- runtime databases and logs are git-ignored
- primary-graph writes reject secret-looking content
- encrypted secret saves require explicit confirmation
- primary-graph writes are schema-validated and rollbackable

Report vulnerabilities via GitHub Security Advisories — see the policy for
details.

## Project status

Recall is an early working runtime foundation. It is suitable for local
experimentation and integration work, and it deliberately does **not** claim
production-grade or state-of-the-art behavior without external benchmarks and
deployment review. Interfaces may change before a stable release. Treat
compiled context packets as evidence, not unquestionable truth — which is
exactly how Recall is designed to be used.

## Citation

If Recall helps your work, please cite it — see [CITATION.cff](CITATION.cff)
or use GitHub's "Cite this repository" button.

## License

Recall is licensed under the [Apache License 2.0](LICENSE). See
[NOTICE](NOTICE).

<div align="center">
<br/>
<sub>Built for agents that should <strong>remember responsibly</strong>.</sub>
</div>
