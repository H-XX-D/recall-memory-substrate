---
name: recall
description: "Use when work benefits from durable structured memory across sessions: recalling prior decisions, evidence, risks, tasks, or contradictions, or persisting new ones. Triggers on \"remember\", \"recall\", \"what did we decide\", resuming past work, or starting any non-trivial task that should accumulate memory."
---

# Recall: durable structured memory

Recall keeps decisions, evidence, risks, tasks, and contradictions in a local
SQLite store and returns compact compiled context on demand. Read from it
before trusting recollection; write durable findings back when they emerge.
This tree is installed by `recall claude sync --apply`; rerun that to refresh
it.

## Read before you trust memory

1. Compile first. `recall compile "<task>"` returns the context packet for
   what you are about to do: relevant cells, conflicts, stale or low-trust
   rows, and calibration. Run it before asserting anything from memory.
2. Cheap reads. `python3 ~/.claude/skills/recall/scripts/recall_peek.py <id>`
   previews one cell (envelope, body excerpt, relation counts) without paying
   for a full compile. `--match "term"` lists matching cells; `--field title`
   is the cheapest probe; keys, handles, and 8+ char key prefixes all resolve.
3. What changed. `recall diff --since 7d --summary` reports new, updated, and
   superseded cells in a window. `--since` accepts an ISO timestamp or a
   relative window (30m, 2h, 7d, 4w).
4. Pressure check. `recall health` reports contradictions, stale cells, and
   calibration drift. Run it when the graph feels off and before large writes.
5. Lookup. `recall search "query"` for ranked lexical search, and
   `recall cell show <key-or-handle>` for one full cell.

## Routing

The CLI routes by cwd: inside a registered project it uses that project's
store, elsewhere the home store. `recall where` prints the resolved scope as
JSON ({scope, dbPath, slug, reason}). Any verb takes `--db <path>` or
`--project <slug>` as an explicit override.

## Writing back

Write durable findings with `recall admit --json proposal.json` (`--json -`
reads stdin). `recall validate --json proposal.json` checks a proposal
without writing. Pick the kind that fits so the write enriches the working
state instead of adding one more flat note:

| kind | meaning |
| ---- | ------- |
| dec  | decision taken |
| obs  | observation, evidence |
| bel  | belief: a claim later confirmed, contradicted, or superseded |
| tsk  | open task |
| obj  | objective, goal |
| rsk  | risk, hazard worth tracking |
| ref  | reference, source |
| ver  | verification result |
| hyp  | hypothesis |
| prg  | program, standing procedure |

Admission returns a guidance block: related cells, contradictions, suggested
edges. Add `--suggest-programs` to include standing-program suggestions, or
`--no-guidance` to omit the block.

Structure beyond single cells: `recall hyperedge add --json edge.json`
records n-ary relations, and `recall program run <key-or-handle>` plus
`recall program list` operate standing programs (trend, watch, drift, quorum,
score) that keep a rolling read outside the loop. When a value worth tracking
over time, a state to watch for change, or a claim needing k-of-m sign-off
recurs, offer to create a program instead of re-deriving it by hand.

## Maintenance

`recall maintain` runs decay, the contradiction sweep, and the eval suite on
the routed store. The background service usually owns this; run it by hand
after a large import.

## Query router

`python3 ~/.claude/skills/recall/scripts/recall_router.py "<question>"` picks
the cheapest tool for a question shape: 8+ hex chars route to the peek
script, temporal wording routes to `recall diff`, health wording routes to
`recall health`, code-symbol shapes route to the peek script with `--match`,
and anything else falls back to `recall compile "<q>" --words 300`. Add
`--explain` to see the routing decision.
