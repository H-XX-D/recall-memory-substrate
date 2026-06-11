# Recall — Agent Instructions

Instructions for AI coding agents working in this repository. Recall is a
local-first active memory substrate: one Node.js runtime exposing a CLI, a
read-only TUI, and a stdio MCP server over a SQLite graph store. Keep it
small, auditable, and schema-first.

This file covers two roles. **Working on the repo** (building, testing,
changing Recall) is covered here in full. **Operating Recall as your memory**
(an agent using the MCP tools) is governed by
[`docs/LLM_INTEGRATION.md`](docs/LLM_INTEGRATION.md) — read that before
composing your first write proposal, and see
[`docs/LLM_SYSTEM_PROMPT.md`](docs/LLM_SYSTEM_PROMPT.md) for the drop-in
operating prompt.

## Orientation

| Path | What lives there |
|---|---|
| `src/cli.ts` | CLI dispatch — every user-facing verb |
| `src/core/` | Runtime: `store` (SQLite + FTS5), `admission` (write firewall), `retrieval`, `context-compiler`, `daemon`, `calibration`, `acp`, `secrets`, … |
| `src/mcp/server.ts` | Stdio MCP server (42 tools) and idle self-exit |
| `tests/` | `node:test` suites — compiled to `dist/tests` and run from there |
| `scripts/` | `e2e.mjs` (94 checks), `bench.mjs`, `public-bench.mjs`, installers |
| `python/` | Optional Python client toolkit (stdlib-first; wraps the CLI) |
| `docs/` | Reference docs — [`docs/README.md`](docs/README.md) is the index |

## Build & verify

```bash
npm install
npm run build     # tsc
npm test          # 83 unit/integration tests
npm run e2e       # 94 end-to-end checks across user + agent workflows
npm run smoke     # init + status on a throwaway db
```

**Definition of done for any change:**

1. `npm test && npm run e2e` pass clean.
2. Docs updated when the command surface, MCP tools, or write schema change —
   including the implementation-status table in `docs/README.md` and the
   README cheat sheet/counts.
3. A `CHANGELOG.md` entry under `[Unreleased]`.
4. No secrets, personal paths, or private content in code, tests, or docs.

## Prime directive

Do not treat memory as chat history. Recall stores structured evidence,
beliefs, tasks, risks, decisions, contradictions, programs, and provenance
outside the LLM context window. The LLM receives only compiled, task-specific
context packets.

## Development rules

- All graph writes from an LLM must go through the strict write schema and
  admission/firewall path. There is exactly one write gate; never add a
  second one.
- Runtime-derived graph writes (daemon, programs, evals, derivations) are
  allowed only through declared, versioned, sandboxed interfaces — and they
  write back through the same admission path as everyone else.
- Admission philosophy: **warn, don't reject**, for quality signals (title
  length, near-duplicates); reject only schema violations and secret-looking
  content.
- Prefer structured records over prose blobs. Every durable write needs
  scope, provenance, tags, confidence, uncertainty, source quality, and
  rollback metadata.
- Rollback, don't overwrite: supersede by relation and keep the audit trail.
- MCP surfaces must expose existing Recall operations; do not create a second
  memory API.
- Semantic search and subgraph composition must use the same graph records
  and multi-identity tags as everything else.
- Keep the daemon quiet by default; users inspect state through CLI/TUI.
- Retrieval behavior (IDF, stemming, graph prior, recency decay, literal
  code-symbol matching) is pinned by the adversarial tests in
  `tests/retrieval-quality.test.ts` — a ranking change that breaks them needs
  a deliberate test update with rationale, not a workaround.
- Never store secrets in the primary graph. Secrets go only through the
  encrypted side graph via explicit
  `recall secrets save --confirm-secret-save`.

## Operating Recall as memory (quick contract)

The loop is **compile → work → write back**:

1. Start tasks with `recall_compile` (700–1200 word budget); treat the packet
   as evidence, not unquestionable truth, and check its `conflicts:` section.
2. Expand only what you need via `recall_search` / `recall_semantic` /
   `recall_cell`.
3. Write durable observations, decisions, risks, tasks, and witnesses back
   through `recall_write` — calibrated confidence, evidence links by cell id
   (free-text `contradicts` references never resolve and starve calibration).
4. Never claim memory was saved if the write was rejected.

Full contract, proposal shape, and tag families:
[`docs/LLM_INTEGRATION.md`](docs/LLM_INTEGRATION.md).

## Ring model

- **Foundation:** schema, graph semantics, evidence calculus, context compiler.
- **Runtime:** daemon, write firewall, scheduler, rollback, eval harness.
- **Interface:** CLI, TUI, MCP, and LLM bridges.

Changes should respect ring boundaries: Foundation changes ripple outward, so
they need the strongest tests and docs; Interface changes must not reach
around the Runtime to touch storage directly.
