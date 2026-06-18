# Backup And Recovery

Recall keeps runtime state in local SQLite files. The primary graph is
rollbackable at the write level, and it can be exported to a portable JSON
archive for machine or project moves.

## What To Back Up

```text
.recall/recall.sqlite3      # primary graph
.recall/secrets.sqlite3     # encrypted secrets side graph, if used
```

Runtime files are git-ignored by default. Keep backups outside the repository
unless the graph is intentionally public.

## Portable Graph Export

```bash
recall export --db .recall/recall.sqlite3 > recall-export.json
```

The archive uses `recall.export.v1` and contains the durable graph tables:
cells, relations, proposals, rollback journal, semantic index, hyperedges,
programs, DAG overlays, evals, operator runs, ACP queue, and derivation index.
It does not include the encrypted secrets side graph.

## Restore Into A New Database

```bash
recall import --json recall-export.json --db .recall/restored.sqlite3
recall status --db .recall/restored.sqlite3
recall semantic reindex --db .recall/restored.sqlite3
```

Import refuses to write into a non-empty database by default. To replace the
target database's graph rows, pass `--force`:

```bash
recall import --json recall-export.json --db .recall/recall.sqlite3 --force
```

Use `--force` only after making a file-level copy of the current database.

## Import Claude Code Auto-Memory

The archive restore above (`recall import --json`) is one import path. The other
brings existing Claude Code auto-memory into Recall:

```bash
recall import auto-memory [--root path] [--project name] [--apply] [--db path]
```

This imports Claude Code auto-memory files (`~/.claude/projects/<slug>/memory/*.md`)
as calibrated Recall cells. It is dry-run by default; pass `--apply` to write. It
is idempotent per file content, and a changed file supersedes its prior version
via a `contradicts` edge — the migration wedge for owning your memory.

This is distinct from the JSON-archive restore (`recall import --json`): the
archive path rehydrates a full graph export, while `import auto-memory` admits
flat memory markdown files as new cells.

## File-Level Copy

For a same-machine backup, stop long-running MCP/daemon clients if practical,
then copy the SQLite files and WAL sidecars:

```bash
mkdir -p ~/recall-backups/my-project
cp .recall/recall.sqlite3* ~/recall-backups/my-project/
cp .recall/secrets.sqlite3* ~/recall-backups/my-project/ 2>/dev/null || true
```

The JSON export is better for portability. A file copy is better for exact
local recovery.

## Undo A Bad Write

Every admitted write creates rollback entries.

```bash
recall rollback list
recall rollback show <journal-id>     # dry-run preview
recall rollback apply <journal-id>    # archive inserted node or delete relation
```

Rollback does not rewrite history; it archives or removes the affected graph
surface and marks the journal entry as applied.

## Upgrade Safety

Recall runs forward migrations on first open. Before upgrading a heavily used
store:

```bash
recall export > recall-before-upgrade.json
npm install -g github:H-XX-D/recall-memory-substrate
recall status
npm run smoke:mcp   # from a source checkout
```

If the upgraded binary cannot read the store, keep the file copy and restore
from `recall-before-upgrade.json` into a fresh database with the last known good
binary.
