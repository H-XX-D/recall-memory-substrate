---
name: recall
description: "Use when the user says /recall, or asks to start, inspect, compile, or operate the Recall active-memory substrate — and as the durable memory layer for any substantial coding, research, planning, debugging, or multi-step work. Read from Recall before relying on recollection; write durable findings back."
---

# Recall — active memory for Codex

Recall is a local-first active memory substrate. It stores structured evidence,
decisions, risks, tasks, witnesses, and contradictions **outside the context
window**, and returns compact compiled context packets on demand. Treat it as
long-term memory: read from it before relying on recollection, and write durable
findings back as they arise.

This is the Codex-flavored skill. On Codex you read files via `shell` (cat/grep),
edit via `apply_patch`, and your instructions file is **`AGENTS.md`**. The
operating discipline below is identical to every other runtime — only the tool
verbs differ.

## Two access paths

**MCP path** — tools named `recall_*` (e.g. `recall_write`, `recall_compile`,
`recall_search`). Registered in `~/.codex/config.toml` under `[mcp_servers.recall]`.
This is the routine path for reads and durable writes.

**CLI path** — the `recall` command (on PATH after `npm link`/install). Always
works. The wrapper auto-routes to the right per-project DB by walking up from the
current working directory; pass `--db <path>` to target a specific DB. Verbs:
`recall compile "task"`, `recall search "q"`, `recall semantic "q"`,
`recall cell show <id>`, `recall validate`/`recall admit` (the write path),
`recall status`, `recall beliefs`, `recall maintenance`,
`recall repair` (prune dangling/unresolvable trust edges; dry-run default,
`--apply` deletes), `recall calibration` (per-actor Brier calibration: stated
confidence vs contradiction outcomes), `recall import auto-memory`
(`[--root path] [--project name] [--apply] [--db path]`).

## Migrate existing Claude Code auto-memory

To bring existing Claude Code auto-memory into Recall, run
`recall import auto-memory [--root path] [--project name]`. It imports Claude
Code auto-memory files (`~/.claude/projects/<slug>/memory/*.md`) as calibrated
Recall cells — dry-run by default; pass `--apply` to write. It is idempotent per
file content, and a changed source file supersedes its prior version via a
`contradicts` edge. This is the migration wedge: own your memory.

## Operating loop

1. **Read first.** Start a task by compiling a context packet for it:
   `recall compile "<task>"`. Expand specific cells only when exact content is
   needed (`recall cell show <id>`).
2. **Do the work.**
3. **Write durable memory seamlessly.** Whenever a durable observation,
   decision, risk, task, or witness arises, write it back via `recall_write`
   (MCP) or `recall admit` (CLI). Do not ask permission for routine memory.
   **If the new memory corrects, updates, or invalidates something already
   stored, supersede it — do not add an unlinked cell or edit in place.**
4. Search / semantic / subgraph to retrieve more; check `recall beliefs` /
   `recall maintenance` when a task depends on old or contested memory.

## Corrections supersede — never silently overwrite

When new information **changes, corrects, or invalidates** a fact already in
memory, the win is recording the *resolution*: the new fact is current, the old
one is superseded, and a later session sees both plus why. On **any** correction:

1. Find the prior cell — `recall search "<topic>"` to get its id.
2. Admit the new fact with `evidence.contradicts: ["<prior-cell-id>"]` (helper
   flag `--contradicts <id>`). Recall then drops the old cell's effective
   confidence and marks it challenged, so `recall compile` in any future session
   surfaces the **current** value and flags the **stale** one.

A correction admitted **without** a `contradicts` link leaves two competing
cells and no resolution — the exact way memory goes quietly stale. **Never edit
a cell's value in place** to "fix" it: supersede it, so the history and the
demotion survive.

## Write contract & helper

Durable memory enters only as a `recall.write.v1` proposal. The required tag
families are `topics`, `entities`, `rings`, `lifecycle`, `quality` (each a
non-empty string array). For routine writes, prefer the bundled helper over
hand-building proposals — it emits a schema-valid proposal from minimal inputs:

```bash
python3 ~/.codex/skills/recall/scripts/recall_helper.py \
  --kind lemma --title "X" --body "..." \
  --confidence 0.85 --topics "topic-1,topic-2" \
  --contradicts "<prior-cell-id>" --admit
```

`reference/llm-integration.md` (copied into this skill) has the full field
reference and a worked example. **Read it before composing your first proposal.**

## Bundled scripts

Installed under `~/.codex/skills/recall/scripts/` (runtime-agnostic; CLI-backed):

- `recall_helper.py` — build/admit schema-valid write proposals.
- `recall_peek.py <id>` — token-budget-aware cell preview (triage before a full fetch).
- `recall_health_peek.py` — compact memory-health summary.
- `recall_diff.py --since 7d --summary` — what changed since (great at session start).
- `recall_router.py "<query>"` — route a query to the right operator tool.
- `recall_code_extract.py` / `recall_code_link.py` / `recall_ci_ingest.py` — Recall-for-Code.
- `recall_bench.py` — operator-vs-naive retrieval benchmark.

## Secrets — hard rule

Never put secrets (tokens, passwords, keys) into the primary graph. Admission
flags common secret shapes (API keys, passwords, URI-embedded credentials, env
dumps) and rejects them, but this is a **high-recall heuristic backstop, not a
guarantee** — do not rely on it. Secrets go ONLY into the encrypted side graph,
via `recall secrets save --confirm-secret-save`.

## Common mistakes

- Writing memory before reading — always compile a context packet first.
- Admitting a correction without `contradicts` — leaves memory to go stale.
- Editing a cell value in place — supersede instead, keep the audit trail.
- Omitting a required tag family — proposal rejected.
- Pasting an existing cell body into a new write — reference it by `recall://cell/...` address.
- Expecting paraphrase queries to hit without shared vocabulary — lexical
  retrieval is BM25+stemming; include the words a future asker would use, or
  configure an embedding backend (`RECALL_EMBEDDING_URL`) and reindex.
