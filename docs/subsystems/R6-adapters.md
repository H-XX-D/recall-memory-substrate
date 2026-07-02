# R6 Adapters / Import-Export: current core contract

Date: 2026-06-26
Status: core adapter/import-export slice implemented on `rewrite/integration`

R6 gives v5 dry-run-first import adapters and a portable cell archive without
adding a second storage/indexing contract. External sources normalize into thin
v5 `WriteProposal`s and enter through R1/R2 admission. Exact backup/restore uses
cell archive JSON and `Store.put()`.

## Module Map

| Module | Role |
|--------|------|
| `src/adapters.ts` | Import core, Mem0/Zep/auto-memory parsers, portable cell archive export/import |
| `src/cli.ts` | Adds `export`, `import archive`, `import mem0`, `import zep`, and `import auto-memory` |

## Import Core

External records become `ImportItem`s with:

- `ref`: source-visible record/file id
- `sourceTag`: stable identity for this source record
- `fingerprint`: source id + body hash for unchanged detection
- `proposal(priorKeys)`: builds the v5 write proposal after prior versions are resolved
- `supersedesTags`: optional stable tags for other source records this item supersedes

`importItems()` is dry-run by default. Dry-run predicts admission by running the
same R1 checks without a store write. Apply mode admits through R1/R2 with the
target store, so dedup and `supersedes` demotion remain centralized.

Idempotency and supersession are implemented using normal cell data:

- `cell.props.import.fingerprint` detects unchanged re-imports.
- `cell.props.import.sourceTag` and `tags.entities` locate prior versions.
- Changed records add `supersedes` edges to prior keys, letting R2 demote old heads.

## Implemented Adapters

- Mem0: accepts top-level arrays or `{ memories | results | data }` envelopes and
  reads text from `memory`, `content`, or `text`.
- Zep: accepts `{ edges | facts | data }`, groups by `(source, relation)`, and
  reconstructs supersession when the predecessor has `invalid_at`/`expired_at`.
- Claude auto-memory: discovers `<root>/<slug>/memory/*.md`, skips symlinks,
  parses flat frontmatter (`name`, `description`, `type`), and imports bounded
  markdown files.

## Archive Contract

Portable archives have schema `recall.cells.export.v1`:

```json
{
  "schemaVersion": "recall.cells.export.v1",
  "exportedAt": "2026-06-26T00:00:00.000Z",
  "stats": {},
  "cells": []
}
```

Archive import is also dry-run by default. Apply mode preserves exact cell keys,
handles, scores, edges, lineage, props, and statuses via `Store.put()`.

## CLI Contract

```text
recall-mal export [--db path] [--project slug]
recall-mal import archive --json archive.json [--apply] [--db path] [--project slug]
recall-mal import mem0 --json mem0.json [--apply] [--db path] [--project slug]
recall-mal import zep --json zep.json [--apply] [--db path] [--project slug]
recall-mal import auto-memory --root path [--apply] [--db path] [--project slug]
```

All import commands default to dry-run; `--apply` is required to write.

## Deferred From This Slice

- legacy global-to-local `local-import` with hyperedge rehydration
- API-client connectors for live Mem0/Zep services
- semantic/vector reindexing during import
- archive replacement/delete semantics
- streaming huge archives beyond the current bounded JSON path
