# Recall CLI reference

`recall` is the command line interface to the Recall memory substrate: typed
memory cells stored in SQLite, admitted through schema and firewall checks,
compiled into compact context packets, and organized into per-project stores.
Every verb accepts `--db <path>` to point at a specific SQLite file, or
`--project <slug>` to route by project slug. If neither is given, Recall
resolves a route in this order: an explicit `--db`, then `--project <slug>`,
then the deepest registered project whose root contains the current
directory, and otherwise the home store at `~/.recall/db/home.sqlite3`. The
`RECALL_DB` environment variable overrides all of that and points every verb
at one file directly.

Run `recall` with no arguments (or `recall help`) to print the full command
list. Run `recall version` to print the CLI name and version as JSON.

## Projects and routing

**`recall project init`** registers the current directory (or `--root path`)
as a project in the central registry at `~/.recall/db/registry.sqlite3`. Each
project gets its own SQLite file under `~/.recall/db/`.

```sh
recall project init --slug my-project --root .
recall project init --slug my-project --description "backend service" --db /custom/path.sqlite3
```

Flags: `--slug name` (defaults to a slugified directory name), `--description
text`, `--root path` (defaults to the current directory), `--db path` (use a
specific database file instead of the default per-project location).

**`recall project list`** prints every registered project as JSON: slug, root
path, database path, description, and creation time.

**`recall project where`** (alias: **`recall where`**) prints how the current
invocation would route: which scope it resolved to (`explicit`, `project`, or
`home`), the resolved database path, and the reason. When it resolves to
`home`, the output also lists every local graph that a federated read spans
(see Reading, below).

```sh
recall where
recall project where --project my-project
```

## Reading

These verbs open a store read-only when possible. When routing resolves to
the home scope with no explicit `--db` or `--project`, `status`, `storage`,
`compile`, `search`, and `cell show` read across a federation of every local
graph (home plus every registered project) rather than just the home file.

**`recall status`** prints the CLI name and version, the resolved route, and
store statistics (cell counts, active/superseded breakdown, and similar
summary figures).

```sh
recall status --project my-project
```

**`recall storage`** prints lower-level storage statistics for the resolved
database (page counts, byte sizes, and related figures used to gauge disk
footprint).

```sh
recall storage --project my-project
```

**`recall compile "task"`** compiles a context packet for the given task
description: the top-ranked cells plus a memory health summary, formatted as
compact text. Flags:

- `--words 900`: word budget for the packet (default 900).
- `--limit 10`: maximum number of cells to include (default 10).
- `--no-health`: omit the memory health summary.
- `--inline-refs`: inline the resolved values of any reference fields instead
  of leaving them as pointers.
- `--ref-params`: include reference parameters in the inlined output.

```sh
recall compile "what should I remember before this task?" --project my-project
recall compile "release checklist" --words 500 --limit 5 --project my-project
```

**`recall search "query"`** runs lexical FTS5/BM25 search and prints the
query plus a list of hits. `--limit 10` caps the number of hits (default 10).

```sh
recall search "routing" --project my-project
```

**`recall diff --since <when>`** reports what changed in the resolved store
since a timestamp: new cells (created inside the window), updated cells
(created before the window but updated inside it), supersede events (a cell
admitted inside the window whose `supersedes` edge demoted an older cell),
and new hyperedges. `--since` accepts an ISO timestamp or a relative window
with an `m`, `h`, `d`, or `w` suffix: `30m`, `2h`, `7d`, `4w`. Output is JSON
by default; `--summary` renders the markdown summary that the Claude Code
session hook injects at session start (see `docs/integrations.md`). Flags:

- `--kinds a,b`: only count cells of the listed kinds.
- `--summary`: render markdown instead of JSON.
- `--max-items 12`: cap each section of the result (default 12).

```sh
recall diff --since 7d --summary --project my-project
recall diff --since 2026-07-01T00:00:00Z --kinds dec,rsk --max-items 5
```

An empty window renders `_No activity in this window._` under the summary
header. A populated summary looks like:

```
# Recall diff in project `my-project` since 2026-06-27T00:00:00.000Z

**Summary:** 2 new cells · 1 updated · 0 new edges · 0 supersede events

## New cells (2)
- `1750a919` [dec] Adopted the v5 routing layer
- `4ae7579e` [obs] Peek reads the cells schema
```

**`recall cell show <key-or-handle>`** inspects a single cell: full content,
footprint (word and byte counts, tag counts, edge counts), incoming and
outgoing edges, derivation lineage, and any expansion handles it exposes. The
target can be a cell key, a short handle, or a handle with a field reference
(for example `handle#scores.effective`).

```sh
recall cell show a1b2 --project my-project
```

## Writing

Recall never accepts free-form writes: every write is a proposal JSON object
that passes through validation and the admission gate.

A proposal has this shape:

```json
{
  "kind": "obs",
  "title": "Release check passed",
  "body": "The local package passed tests and npm pack dry-run.",
  "confidence": 0.92,
  "summary": "npm pack dry-run and test suite both passed",
  "topics": ["release", "ci"],
  "entities": ["recall-memory-substrate"],
  "sourceRefs": ["ci-run-4821"],
  "verification": "tested",
  "sensitivity": "private",
  "origin": "human",
  "edges": [
    { "relation": "supports", "target": "a1b2", "weight": 0.8 },
    { "relation": "depends_on", "target": "c3d4", "weight": 0 }
  ]
}
```

`kind` must be one of: `dec`, `obs`, `bel`, `tsk`, `obj`, `rsk`, `ref`, `ver`,
`hyp`, `prg` (decision, observation, belief, task, objective, risk,
reference, verification, hypothesis, program). `title` and `body` are
required strings; `confidence` is a number in `(0, 1]`. Optional fields
include `owner`, `project`, `tenant`, `topics`, `entities`, `lifecycle`,
`quality`, `subject`, `sourceRefs`, `uncertainty`, `concern`, `operation`
(`create`, `update`, `supersede`, `link`, `annex`), `origin` (`human`, `llm`,
`daemon`, `connector`, `program`, `external`), `verification` (`unverified`,
`checked`, `tested`, `external`), `sensitivity` (`public`, `private`,
`secret`), `stability` (`ephemeral`, `volatile`, `stable`), `expiresAt`,
`reverifyAfter`, `flags`, `props`, `programs` (existing prg cell keys or handles that should watch the cell), and `hyperedges` (memberships to join in existing bundles, each `{id, role, weight}`). Membership targets must exist or the write is rejected, the same contract as edge targets.

Edges are directed and signed: `relation` must be one of `supports`,
`contradicts`, `concerns`, `depends_on`, `supersedes`, `derived_from`, with
`target` naming the cell key or handle it points at. Weight conventions are
enforced: `supports` weight must be positive, `contradicts` and `concerns`
weight must be negative, and `depends_on`, `supersedes`, `derived_from`
weight must be `0`.

**`recall validate --json proposal.json`** checks a proposal against the
schema without writing anything. Prints `{ ok, issues }` and exits 0 if
valid, 1 if not. Pass `-` to read the proposal from stdin.

**`recall admit --json proposal.json`** validates, screens for secrets, and
if accepted, writes the cell. Prints the admission result (accepted cell, or
issues/warnings if rejected) and exits 0 if accepted, 1 if rejected.

On an accepted write, the printed result also carries a `guidance` object,
computed against the store at admit time and never persisted:

- `candidateEdges`: up to three similar active cells the new cell does not
  already link, each with the target's key, handle, title, and kind, a
  suggested relation (`supports`, `supersedes`, or `depends_on`), its
  lexical score, and a reason. The cell itself, cells it already links, and
  `prg` cells are excluded.
- `kindHint` (optional): present when an `obs` or `dec` cell's text reads
  like an open action, an unconfirmed claim, or a hazard, naming the kind
  (`tsk`, `bel` or `hyp`, `rsk`) that would put it in the matching compile
  section.
- `evidenceHint` (optional): present exactly when confidence was attenuated,
  stating what keeps higher confidence (verification, sourceRefs, or a
  weighted supports edge).
- `programSuggestions`: empty unless suggestions are enabled (below). Each
  entry is `{ operation, reason, proposal }` where `operation` is `watch`,
  `quorum`, or `allocate` and `proposal` is a ready-to-admit `prg` write
  proposal. Suggestions never write anything themselves: admitting the
  proposal is always a separate, explicit call.

Flags:

- `--suggest-programs`: include standing-program suggestions in guidance. A
  topic shared by 5 or more active cells suggests a watch program, a pool of
  4 or more open tasks on one topic suggests an allocate program, and a
  `contradicts` edge onto a belief or hypothesis suggests a quorum program
  targeted at it. Topics and targets already covered by an active program
  are skipped, and at most 2 suggestions are returned. Setting
  `RECALL_SUGGEST_PROGRAMS=1` in the environment is equivalent to passing
  the flag.
- `--no-guidance`: omit the guidance block entirely.

Rejected writes carry no guidance.

```sh
recall validate --json proposal.json
recall admit --json proposal.json --project my-project
recall admit --json proposal.json --suggest-programs --project my-project
recall admit --json proposal.json --no-guidance --project my-project
```

## Graph structures

**Hyperedges** group an arbitrary set of cells under a labeled relationship
that a plain directed edge cannot express (for example, a multi-cell
decision record).

- `recall hyperedge add --json edge.json`: creates a hyperedge. The JSON
  needs `kind`, `title`, and `members` (an array of cell keys/handles or
  `{ key, role, ordinal, weight?, metadata? }` objects); `id`, `metadata`,
  and `createdAt` are optional. Every member must resolve to an existing
  cell.
- `recall hyperedge show <id>`: prints one hyperedge by id.
- `recall hyperedge list [--limit 10]`: lists hyperedges, most recent first.

**DAG overlays** attach an explicit directed-acyclic-graph structure over a
set of cells, independent of the cells' own edges.

- `recall dag add --json overlay.json`: creates a DAG overlay. The JSON needs
  `title`, `nodeIds` (cell keys/handles), and `edges` (`{ source, target,
  label?, weight? }`); `id`, `metadata`, and `createdAt` are optional.
- `recall dag show <id>`: prints one overlay by id.
- `recall dag list [--limit 10]`: lists overlays, most recent first.
- `recall dag analyze <id>`: computes structural analysis over the overlay
  (for example topological ordering or cycle detection results). Add
  `--derive` to also admit the analysis findings as derived cells in the
  store.

```sh
recall hyperedge add --json edge.json --project my-project
recall dag analyze dag_1 --derive --project my-project
```

## Programs and evals

A program is a standing, deterministic, no-model check stored as a `prg`
cell (operations include scoring, witness emission, tag projection, drift
and trend watches, quorum checks, and simple reflex/allocation rules).

- `recall program run <key-or-handle>`: runs one program cell and records
  the run. Add `--derive` to admit the run's output as a derived cell.
- `recall program list`: lists program cells with their operation,
  description, and run count.
- `recall program runs [<key-or-handle>] [--limit 10]`: lists run history,
  optionally filtered to one program.
- `recall program show-run <id>`: prints one recorded run in full.

```sh
recall program run drift-check --derive --project my-project
recall program runs drift-check --limit 20 --project my-project
```

An eval is a cheap, deterministic suite of checks over the store itself
(search/semantic/compile smoke tests plus structural invariants such as
key-handle consistency, dangling edge targets, confidence bounds, and
acyclic `depends_on`), with no model call and no mutation of the store it
inspects.

- `recall eval run [--json suite.json|-]`: runs the default suite, or a
  custom suite JSON (an object with `name` and `cases`); pass `-` to read
  the suite from stdin. Add `--derive` to admit the result as a derived
  cell.
- `recall eval list [--limit 10]`: lists recorded eval runs.
- `recall eval show <id>`: prints one recorded eval run in full.

```sh
recall eval run --derive --project my-project
recall eval run --json suite.json --project my-project
```

**`recall health [--derive]`** analyzes overall memory health: belief
pressure, stale findings, contradictions, dangling edges, provenance health,
and critical warnings. Add `--derive` to admit the report as a derived
witness cell.

**`recall operate once [--derive]`** runs one operator cycle: ticks live
scores (currency/salience decay) and runs any due standing programs in one
pass. Add `--derive` to admit derived witnesses from that cycle.

- `recall operate list [--limit 20]`: lists recorded operator cycle runs.
- `recall operate show <id>`: prints one recorded operator run in full.

```sh
recall health --derive --project my-project
recall operate once --derive --project my-project
```

## Netlists

Netlists are a compact, human-readable text serialization of the cell graph:
one line per cell, edge, or schedule directive.

**`recall render`** serializes every active cell (and its edges) in the
resolved store to netlist text on stdout.

```sh
recall render --project my-project > snapshot.mal
```

**`recall load --file netlist.mal`** parses a `.mal` netlist file and loads
it into the store. `--mode` controls how loaded cells interact with what is
already in the store:

- `replay` (default): re-admits every cell as new writes.
- `verify`: checks the netlist against the current store's state without
  writing.
- `merge`: merges the netlist's cells and edges into the existing store.

```sh
recall load --file snapshot.mal --mode verify --project my-project
```

## Import and export

Import commands follow a dry-run-first discipline: without `--apply`, they
report what would happen (created, superseded, skipped, with per-item
reasons) and write nothing. Pass `--apply` to actually write.

Import is idempotent: re-importing the same source data a second time skips
records that are unchanged (matched by a stable per-record fingerprint), and
only writes for records whose content actually changed, which supersede
their prior version rather than duplicating it.

**`recall export [--out file.json]`** writes a full archive of the resolved
store (cells, hyperedges, semantic vectors, DAG overlays, program runs, eval
runs, and operator runs) as JSON. Without `--out`, the archive prints to
stdout.

```sh
recall export --project my-project --out recall-archive.json
```

**`recall import archive --json archive.json [--apply] [--reindex]`** loads a
Recall archive (as produced by `recall export`) into the resolved store.
`--reindex` (only meaningful with `--apply`) re-runs semantic indexing on the
imported cells afterward.

**`recall import mem0 --json mem0.json [--apply]`** imports Mem0-format
memories, normalizing each into a proposal.

**`recall import zep --json zep.json [--apply]`** imports Zep-format facts,
normalizing each into a proposal; superseded facts (those with an
`invalidAt`) supersede their prior imported version.

**`recall import auto-memory [--root path] [--apply]`** imports Claude Code
auto-memory files discovered under `--root` (defaults to
`~/.claude/projects`).

**`recall import local [--global-db path] [--topics a,b] [--limit N]
[--no-hyperedges] [--apply]`** imports cells from another local Recall store
(defaults to the home store) into the resolved store, optionally filtered by
topic and capped by count. `--no-hyperedges` skips carrying hyperedges over.

```sh
recall export --project my-project --out archive.json
recall import archive --json archive.json --apply --reindex --project my-project
recall import mem0 --json mem0.json --apply --project my-project
recall import zep --json zep.json --apply --project my-project
recall import auto-memory --root ~/.claude/projects --apply --project my-project
recall import local --topics release,ci --limit 200 --apply --project my-project
```

Import verbs exit 1 when at least one item was rejected by admission and
nothing landed in the store; a run with no rejections, including a fully
idempotent no-op re-import, exits 0.

**`recall migrate --from old.sqlite3 [--apply]`** migrates cells from a
pre-Recall database schema into the resolved store (defaults to the home
store), mapping legacy node kinds onto current cell kinds. When the legacy
database carries a `projects` table (a legacy home store), each project row
is also imported into the central project registry, idempotently: a slug,
root, or database path that is already registered skips, and a reserved slug
(such as `home`) is renamed through the standard collision rule with the
rename reported in the output, never applied silently. The migrate summary
reports the registry work as `projects` and `projectRenames` alongside the
cell counts. Dry-run by default; pass `--apply` to write.

```sh
recall migrate --from old.sqlite3 --apply
```

**`recall reindex [--missing-only]`** rebuilds semantic embeddings for cells
in the resolved store. `--missing-only` skips cells that already have a
vector, useful after a bulk import or after migrating a database that
predates semantic search.

```sh
recall reindex --project my-project
recall reindex --missing-only --project my-project
```

## Maintenance and scheduling

**`recall maintain`** runs one composed maintenance pass over the resolved
store: an operator tick, an eval run, a memory health check, and a semantic
reindex, admitting derived witnesses for each. Add `--all-graphs` to run the
pass over every local graph (home plus every registered project) in one
invocation instead of just the resolved store; each graph's legs run
independently, so a failure in one graph's eval or operator step does not
stop the pass for the others.

```sh
recall maintain --project my-project
recall maintain --all-graphs
```

**`recall service install [--interval-min 60]`** writes a launchd agent
definition (a plist) that runs `recall maintain --all-graphs` on a fixed
interval, default 60 minutes. On macOS, this only writes the plist file to
`~/Library/LaunchAgents/`; it prints the `launchctl load` command you must
run yourself to activate it. The agent uses `StartInterval`, so it fires on
a repeating schedule rather than staying running continuously, and it does
not run immediately on install.

On non-macOS platforms there is no launchd, so `service install` still
writes the plist file (harmless, and portable if copied to a Mac later) but
prints an equivalent crontab line instead, which you can add with `crontab
-e`.

**`recall service uninstall`** removes the plist file and prints the
`launchctl unload` command to run first if the agent is currently loaded
(non-macOS: prints a reminder to remove the equivalent crontab line).

**`recall service status`** prints the agent's label, file path, and whether
the plist file is currently installed.

```sh
recall service install --interval-min 30
recall service status
recall service uninstall
```

## Assistant integrations

**`recall claude sync [--apply]`** wires Recall into Claude Code: merges MCP
server registration and hook settings into Claude's settings file, installs
the bundled session hook script and the Recall skills tree (`SKILL.md` plus
the peek and router helper scripts under `~/.claude/skills/recall/`), and
(by default) imports and disables the built-in auto-memory files in favor of
Recall. Flags:

- `--keep-automemory`: leave Claude's built-in auto-memory enabled and skip
  importing it.
- `--write-gate`: enable the Stop-hook write-back gate.
- `--root path`: auto-memory root to import from, if importing.
- `--db path`: database path to point the installed MCP server at.

Without `--apply`, it reports what would change and writes nothing; any file
it does change is backed up first (a `.bak` copy of prior content).

**`recall claude status`** reports whether the settings file has Recall's
hooks installed and whether built-in auto-memory is disabled.

**`recall codex sync [--apply]`** wires Recall into Codex: merges MCP server
registration into Codex's config and merges a Recall block into `AGENTS.md`.
Same dry-run-by-default and backup behavior as `claude sync`.

**`recall codex status`** reports whether the MCP server is registered and
whether the `AGENTS.md` Recall block is present.

```sh
recall claude sync --apply --project my-project
recall claude status
recall codex sync --apply --project my-project
recall codex status
```

See `docs/integrations.md` for the full detail on what each integration
installs and how the write-back hooks behave.
