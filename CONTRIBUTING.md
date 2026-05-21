# Contributing

Thanks for your interest in Recall. This project is early, so contributions
should stay small, testable, and aligned with the schema-first architecture.

## Development Setup

```bash
git clone https://github.com/H-XX-D/recall-memory-substrate.git
cd recall
npm install
npm test
npm run e2e
```

Recall requires Node.js 24 or newer.

## Ground Rules

- Keep graph writes behind `recall.write.v1` admission.
- Do not add a second memory store or a second agent API.
- Do not store secrets in the primary graph.
- Add tests for schema, admission, rollback, daemon, MCP, CLI, or compiler
  behavior when touching those areas.
- Keep generated output, runtime databases, logs, and local secrets out of git.

## Pull Requests

Before opening a pull request, run:

```bash
npm test
npm run smoke
npm run e2e
```

Include a short summary of the behavior changed, the tests run, and any
remaining risk.
