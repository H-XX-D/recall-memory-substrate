# R8 Surfaces: current CLI/package contract

Date: 2026-06-26
Status: core CLI/index slice implemented on `rewrite/integration`

R8 gives v5 a real npm-facing surface without pulling in deferred servers or UI.
This slice adds a package entry point, typed exports, and a small CLI over the
core modules implemented so far.

## Module Map

| Module | Role |
|--------|------|
| `src/index.ts` | Public ESM export barrel for the implemented v5 modules |
| `src/cli.ts` | Testable `runCli(argv, opts)` plus executable `recall-mal` bin |

## CLI Contract

Implemented commands:

```text
recall-mal project init [--slug name] [--description text] [--root path] [--db path]
recall-mal project list
recall-mal project where
recall-mal where
recall-mal status [--db path] [--project slug]
recall-mal compile "task" [--words 900] [--limit 10] [--db path] [--project slug]
recall-mal search "query" [--limit 10] [--db path] [--project slug]
recall-mal cell show <key-or-handle> [--db path] [--project slug]
recall-mal validate --json proposal.json
recall-mal admit --json proposal.json [--db path] [--project slug]
recall-mal version
```

Routing follows R5:

- `--db` is an explicit single-DB override.
- `--project` resolves through the central registry.
- otherwise cwd resolves to the deepest registered project, falling back to home.
- home-scope reads use the federated read union.

Writes (`admit`) always route to one concrete DB.

## Package Contract

`package.json` now declares:

- `main`: `./dist/index.js`
- `types`: `./dist/index.d.ts`
- `exports` for `.` and `./cli`
- `bin`: `recall-mal -> ./dist/cli.js`
- `files` constrained to runtime `dist` artifacts and docs, excluding compiled tests

`npm run build` compiles TypeScript and marks `dist/cli.js` executable.

## Release Metadata Closure

The npm release polish pass finalized the first public package contract:

- package name: `recall-mal`
- version: `0.1.0`
- license: Apache-2.0
- Node engine floor: `>=22.5.0`
- public npm access in `publishConfig`
- README, CHANGELOG, and LICENSE included
- `npm run test:acceptance` packs the artifact, installs it into a clean temp
  consumer, and verifies installed CLI/library/Python behavior plus lattice
  structure
- `npm run release:check` wired to tests, typecheck, build, Python tests,
  installed-artifact acceptance, and `npm pack --dry-run`

The public npm registry returned 404 for `recall-mal` on 2026-06-26, so the name
was available at release-check time.

## Deferred From This Slice

- MCP server runtime and MCP stdio protocol
- TUI
- `recall codex sync` / `recall claude sync` filesystem installers
- provenance-enabled publish automation
