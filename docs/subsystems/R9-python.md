# R9 Python: current helper-script contract

Date: 2026-06-26
Status: core helper slice implemented on `rewrite/integration`

R9 keeps Python as a skill-side convenience layer while making `recall-mal` the
only runtime authority for validation, routing, admission, storage, and cell
inspection. The old direct-SQLite helper pattern is not carried forward into v5.

## Module Map

| Module | Role |
|--------|------|
| `python/recall_helper.py` | Builds v5 `WriteProposal` JSON from agent-friendly flags and optionally delegates to `recall-mal validate` or `recall-mal admit` |
| `python/recall_peek.py` | Runs `recall-mal cell show` and renders a compact cell preview for low-token inspection |
| `python/tests/*` | Unittest coverage for proposal building, CLI validation delegation, admit, and peek |

## Helper Contract

`recall_helper.py` accepts the compact v5 proposal vocabulary:

```text
--kind dec|obs|bel|tsk|obj|rsk|ref|ver|hyp|prg
--title text
--body text | --body-file path
--confidence number
--topics a,b --entities x,y --source-refs file-or-cell
--edge relation:target[:weight]
--supports target --contradicts target --depends-on target
--project scope --tenant scope --owner actor
--validate | --admit
--db path | --route-project slug
```

Without `--validate` or `--admit`, it prints proposal JSON. With either flag, it
writes a temporary proposal file and shells out to `recall-mal`, printing the CLI
JSON result unchanged.

CLI resolution order:

1. `--cli`
2. `RECALL_CLI`
3. local `dist/cli.js`
4. `recall-mal` from `PATH`

The helper refuses `--sensitivity secret` because normal graph writes must not
carry secret values. Secrets belong to the encrypted side store.

## Peek Contract

`recall_peek.py <key-or-handle>` shells out to:

```text
recall-mal cell show <target> [--db path] [--project slug]
```

It emits either a compact human preview or JSON with:

- key, handle, kind, title, status, scope, and sensitivity
- confidence/effective/uncertainty/concern
- topics, entities, source refs
- body preview and truncation state
- incoming/outgoing counts and expansion handles

## Package Contract

`package.json` now includes:

- `python/*.py` in the npm package file list
- `npm run test:python`, which builds the CLI and runs `python3 -m unittest`

Python tests are intentionally separate from `npm test` so the TypeScript core
loop remains fast and unambiguous.

## Deferred From This Slice

- Direct SQLite Python readers and writers
- Legacy health/diff/router/code-ingest helpers
- Installer sync commands
- Python packaging metadata
- Secret side-store CLI wrappers
