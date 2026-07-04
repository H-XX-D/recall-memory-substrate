# Import and export

Recall moves memory in and out of a store in two ways: portable archives
(full backup and restore of a store) and adapters for other memory systems
(mem0, Zep, Claude Code auto-memory). A separate command seeds a project
store from the home graph, and another migrates pre-0.6 legacy databases.

Every import is a dry run by default. It reports what would happen without
writing anything. Pass `--apply` to actually write.

## Archives

An archive is a JSON snapshot of a store: cells, hyperedges, semantic
vectors, DAG overlays, and the program/eval/operator run ledgers.

### Export

```sh
recall export --project my-project --out recall-archive.json
```

Without `--out`, the archive prints to stdout. The archive carries:

- `cells`: every cell in the store (active and superseded).
- `hyperedges`, `dagOverlays`, `semanticVectors`: the full contents of each,
  not paginated.
- `programRuns`, `evalRuns`, `operatorRuns`: the run ledgers, if the store
  backing the export supports them.

The exported `schemaVersion` is `recall.cells.export.v2`.

### Import

```sh
recall import archive --json recall-archive.json --project my-project --apply
```

Cells import first, so hyperedge members, semantic vector node IDs, and DAG
overlay node IDs resolve against the restored cells. For each cell, an
unchanged cell (identical JSON already present at that key) reports as
skipped with reason `unchanged`. Anything new or different is imported.
Hyperedges, semantic vectors, and DAG overlays follow the same rule: byte
identical to what is already stored skips, anything else upserts. The run
ledgers (program/eval/operator runs) are immutable once recorded, so those
sections gate on existence alone. An id already present skips; a new id
imports. Restoring more than 1000 operator runs will not fully survive: the
operator run ledger keeps only the newest 1000 after each insert.

The summary reports per-section counts (`imported`/`skipped`) for every
section, plus a top-level `imported`/`skipped` count for cells.

### What round-trips

Export and reimport of the same store round-trips cleanly: every section
reports `unchanged`/skip on reimport, since the archive holds the same JSON
that was exported.

### v1 compatibility

Archives written under the older schema version, `recall.cells.export.v1`,
still import. A v1 archive holds only `cells`; it has no hyperedges, semantic
vectors, DAG overlays, or run ledgers. Importing one restores cells and
leaves those other sections empty.

### Partial archives

If you hand-edit an archive down to a subset of cells before importing, that
still imports cleanly, but importing a cell overwrites its outgoing edges
wholesale with whatever is in the archive. It is not a merge with the edges
the target store already has for that key. Prefer full-store archives
(export everything, import everything) unless you specifically intend to
replace a cell's edge list.

### Reindexing after import

Semantic vectors travel with a v2 archive, but if you are restoring into a
store that predates semantic indexing, or importing a v1 archive, there will
be no semantic vectors to restore. Pass `--reindex` to rebuild the semantic
index from the imported cells after `--apply`:

```sh
recall import archive --json recall-archive.json --project my-project --apply --reindex
```

`--reindex` only runs when combined with `--apply` (a dry run does not
reindex).

## Importing from other systems

Every adapter below shares the same identity model. Each imported record
carries a fingerprint and a source tag.

- The fingerprint identifies an exact version of a source record (its
  content, hashed together with its source and reference). If a record with
  the same fingerprint already exists, the import skips it with reason
  `unchanged`. Nothing is rewritten.
- The source tag identifies the record across versions, independent of
  content. If a record's fingerprint has changed (its content changed) but
  its source tag matches a prior import, the new version supersedes the
  prior cell instead of creating an unrelated duplicate.
- Independently, if a record's kind and title match an already-active cell
  (titles compare case- and whitespace-insensitively) and its body matches
  that cell exactly, the import reports it as a content duplicate and skips,
  regardless of fingerprint or source tag.

All adapters clamp bodies to 32 KiB and reject input files over 128 MiB.

### mem0

```sh
recall import mem0 --json mem0-export.json --project my-project --apply
```

Accepts a mem0 export JSON shape: an array of memories, or an object with a
`memories`, `results`, or `data` array. Each row is read for `memory`,
`content`, or `text` (whichever is present) as the body, `categories` (or
`metadata.categories`) as topics, and `created_at`/`createdAt`. A row missing
an `id` is skipped as malformed; an empty body is skipped as empty.

### Zep

```sh
recall import zep --json zep-facts.json --project my-project --apply
```

Accepts a Zep fact/edge export: an array, or an object with an `edges`,
`facts`, or `data` array. Each row needs a `uuid` (or `id`) and a non-empty
fact/content string; rows without either are skipped. Facts are grouped by
their `(source, relation)` pair and ordered by `valid_at`/`created_at`. Within
a group, when a fact has an `invalid_at` (or `expired_at`), the next fact in
the group supersedes it, forming a supersede chain that mirrors Zep's own
fact invalidation history. An invalidated fact is tagged with the lifecycle
value `expired`; an active fact is tagged `active`.

Note: because the import fingerprint only hashes the fact's source, id, and
body text, a fact whose text is unchanged but which has since gained an
`invalid_at` (it just expired) still re-skips as `unchanged` on reimport,
even though its lifecycle tag would now read differently in a fresh export.

### Claude Code auto-memory

```sh
recall import auto-memory --root ~/.claude/projects --project my-project --apply
```

Without `--root`, this reads from `~/.claude/projects` by default (or the
directory named by `$HOME/.claude/projects` if `HOME` is set). It expects the
auto-memory directory layout: one subdirectory per project slug, each
containing a `memory/` directory of Markdown files. Every `.md` file in
`memory/` is imported except `MEMORY.md`. Files are capped at 1 MB;
oversized or unreadable files are skipped.

Each file may open with a YAML-style frontmatter block (`---` delimited)
carrying `name`, `description`, and `type`. The frontmatter's `type` maps to
a Recall kind: `project`, `decision`, and `architecture` become `dec`;
anything else becomes `obs`. The body after the frontmatter (or the whole
file, if there is no frontmatter) becomes the cell body. A file with no name
and an empty body is skipped as empty.

## Seeding a project from home

`import local` copies a scoped subgraph out of the home (global) store into
a project's local store, using the same admission and identity rules as the
other adapters.

```sh
recall import local --project my-project --topics roadmap,billing --apply
```

You must scope the selection with `--project`, `--topics`, or both; there is
no unscoped "import everything" mode. By default up to 500 cells are
selected (`--limit N` to change the cap); the summary's
`selectionTruncated` flag tells you whether more matching cells existed
than the cap allowed through.

Hyperedges are rehydrated automatically unless you pass `--no-hyperedges`: a
hyperedge from the home graph reattaches in the local store only if every
one of its member cells landed locally (created, superseded, or already
present unchanged). A hyperedge with even one member that did not land is
counted as partial and is not reattached.

`--global-db path` points at a home database other than the default; without
it, `import local` reads the standard home db path.

## Migrating legacy databases

`recall migrate` moves a pre-0.6 legacy SQLite database (the old
`graph_nodes`/`graph_relations` schema) into the current store format. It is
a one-shot operation, not an incremental adapter: run it once against a
legacy database, then use the current CLI going forward.

```sh
recall migrate --from old.sqlite3 --apply --db ~/.recall/db/home.sqlite3
```

Run it first without `--apply` to see counts (`cells`, `edges`,
`hyperedges`, `semanticVectors`, `dagOverlays`, `projects`) before writing
anything. The old database is opened read-only, so a dry run and a real run
are both safe to run against it repeatedly. Legacy node kinds are remapped
onto current kinds (for example, `observation` becomes `obs`, `decision`
becomes `dec`, `risk` becomes `rsk`); anything unrecognized becomes `obs`.
Legacy relation kinds outside Recall's current relation set are dropped
rather than imported.

### The projects registry

A legacy home store also carried the project registry as a `projects` table
(slug, root path, database path, description, creation time). When the
source database has project rows, `recall migrate` imports each one into the
current central registry (`registry.sqlite3` under the Recall home
directory), and the summary reports the count as `projects`.

The registry import is idempotent: a slug, root path, or database path that
is already registered skips the row, so a second `--apply` changes nothing.
That skip rule also covers a legacy slug already registered to a different
root: the existing registration wins and the legacy row is neither imported
nor renamed. A legacy slug that collides with the reserved `home` slug is
renamed through the same collision rule `recall project init` uses, and
every rename is reported in the summary's `projectRenames` list as a
`{ from, to }` pair, never applied silently. A dry run reports the same
`projects` count without touching the registry.

## Idempotence and re-imports

Every import path in Recall is safe to run more than once. Rerunning any
import, whether an archive, a mem0/Zep/auto-memory adapter, or `import
local`, against the same source will not create duplicate cells.

What happens on a rerun depends on what changed at the source:

- No change: the record's fingerprint matches what is already stored, so it
  skips with reason `unchanged`. Nothing is written.
- Changed content, same identity: the record's source tag matches a
  previously imported record, but its content differs, so the fingerprint no
  longer matches. The import creates a new cell and marks it as superseding
  the prior cell (or chain of prior cells) that shared that source tag. Over
  several reimports of a record that keeps changing, this produces a
  supersede chain: each new version points back at the version it replaced,
  and only the newest version is active.
- Same content, different identity: if the new record's kind and title match
  an already-active cell (titles compare case- and whitespace-insensitively)
  and its body matches that cell exactly, it is reported as a content
  duplicate and skipped, even though its source tag or fingerprint differ.

You can rerun the same import command as often as you like (a cron job, a
daily sync) and it will only ever add what actually changed.

## FAQ

**Why did a record skip as a content duplicate?**

Its kind and title matched an already-active cell (titles compare with case
and whitespace folded) and its body matched exactly, regardless of where it
came from. This catches the same memory arriving from two
different sources (or two different import runs with different identity
tags) without creating a second cell for it.

**Why does semantic search return nothing after a restore?**

A store restored from an archive that predates semantic indexing, or from a
v1 archive, has no semantic vectors. Semantic vectors are not rebuilt
automatically. Run `recall reindex --project my-project` (or pass
`--reindex` on `recall import archive --apply`) to rebuild the semantic
index from the cells now in the store.

Next: `docs/overview.md` for how the whole system fits together.
