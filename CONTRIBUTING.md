# Contributing to Recall

Thanks for being here. Recall is a small, schema-first project, and it stays
healthy by keeping contributions **small, testable, and aligned with the
single-runtime architecture**. You don't need to be an expert in memory systems
to help. A clear bug report or a one-line doc fix is a real contribution.

By participating you agree to uphold our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug**: open an issue with what you did, what you expected, and what
  happened. A minimal reproduction is gold.
- **Improve docs**: typos, unclear steps, missing examples. Docs PRs are always
  welcome and a great first contribution.
- **Fix or build**: pick up a [good first issue][gfi], or open an issue to
  discuss a change before writing a lot of code.

[gfi]: https://github.com/H-XX-D/recall-memory-substrate/labels/good%20first%20issue

## Development setup

Recall requires **Node.js 24 or newer** (it uses Node's built-in SQLite).

```bash
git clone https://github.com/H-XX-D/recall-memory-substrate.git
cd recall-memory-substrate
npm install
npm run build
npm test
npm run e2e
```

A green `npm test && npm run e2e` is the bar for any PR.

## Ground rules

These keep Recall's trust model intact. Please don't work around them:

- **All graph writes go through `recall.write.v1` admission and the firewall.**
  No side doors.
- **One memory store, one agent API.** Don't add a second store or a parallel
  MCP/CLI surface; extend the existing ones.
- **Never put secrets in the primary graph.** Secret-looking content must be
  rejected or routed to the encrypted Secrets side graph.
- **Structured records over prose blobs.** Prefer typed cells with provenance,
  confidence, and tags.
- **Add tests** for any change to schema, admission, rollback, daemon, MCP, CLI,
  semantic search, or the compiler.
- **Keep runtime state out of git**: databases, logs, and local secrets are
  git-ignored for a reason.

## Pull requests

Before opening a PR:

```bash
npm test
npm run e2e
npm run smoke
```

In the PR description, include a short summary of **what changed**, **the tests
you ran**, and **any remaining risk**. Keep the diff focused. One logical change
per PR is much easier to review and roll back.

Commits should be signed off (`git commit -s`) to certify the
[Developer Certificate of Origin](https://developercertificate.org/).

## Where things live

| Path | What's there |
|---|---|
| `src/core/` | Schema, admission/firewall, store, compiler, daemon, semantic, secrets |
| `src/cli.ts` | Command-line surface |
| `src/mcp/` | MCP server and entry point |
| `docs/` | Architecture, schema, and integration reference ([index](docs/README.md)) |
| `tests/` · `scripts/e2e.mjs` | Unit/integration tests and end-to-end checks |

Questions or a design you want to sanity-check before building? Open an issue.
We'd rather talk early than review a large surprise later.
