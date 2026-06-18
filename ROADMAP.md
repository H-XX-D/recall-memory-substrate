# Recall Roadmap

This roadmap describes **direction, not promises.** Recall is an early working
runtime, and the point of the project is auditability, including being honest
about what is built, what is planned, and what is still just an idea. Dates are
deliberately omitted; sequencing reflects priority, and priorities shift with
real usage and contributor interest.

The roadmap is organized around Recall's three rings. A change is "done" only
when it lands schema-first, tested, and through the same admission path
everything else uses.

> **Legend:** ✅ shipped in 0.2.0 · 🛠️ actively planned · 🔭 exploratory

---

## Guiding principles

These don't change. They're the filter every roadmap item passes through:

- **One store, one memory API.** No second store, no parallel write path.
- **Every durable write is admitted, provenanced, and rollbackable.**
- **Return a compiled packet, not the whole store.**
- **Local-first by default.** Cloud is opt-in, never required.
- **Honesty over hype.** No production-grade or state-of-the-art claims without
  external benchmarks and deployment review.

---

## Foundation: schema, graph semantics, evidence calculus, compiler

- ✅ Strict `recall.write.v1` schema, admission firewall, rollback journal
- ✅ Addressable cells + n-ary hyperedges in SQLite
- ✅ Context compiler with word-budgeted, evidence-ranked packets
- ✅ DAG overlays, derivation closure, holonomy analysis
- 🛠️ Evidence-calculus refinements: better calibration of confidence decay,
  contradiction scoring, and supersedure-by-relation heuristics
- 🛠️ Schema-versioned migrations with a documented upgrade/export path
- 🔭 Pluggable ranking strategies for the compiler, selectable per task

## Runtime: daemon, firewall, scheduler, rollback, eval harness

- ✅ Quiet maintenance daemon (stale memory, contradictions, derivations, evals)
- ✅ SQLite-backed lease control for single-writer daemon passes
- ✅ Eval harness with persisted eval-result cells
- 🛠️ Cross-platform daemon service helpers (Linux systemd + Windows in addition
  to the current macOS LaunchAgent)
- ✅ Reproducible public benchmark harness (`npm run bench:public`)
- 🛠️ Expanded eval suites and memory-*quality* benchmarks, so the comparison
  tables can graduate from *design properties* to *measured results*
- 🔭 Configurable maintenance policies (cadence, budgets, which passes run)

## Interfaces: CLI, TUI, MCP, bridges, importers, integrations

- ✅ CLI, read-only TUI, stdio MCP server (42 tools, idle self-exit)
- ✅ Enforcement hook templates + compliance/longitudinal instrumentation
- ✅ Real-embedding semantic backend via `RECALL_EMBEDDING_COMMAND`
- 🛠️ **Publish to npm** so `npm install -g recall-memory-substrate` works
  directly (today's install is from GitHub)
- 🛠️ **Shared team graph:** one project graph served to a whole team. The
  admission firewall already makes multi-writer memory safe: every write is
  schema-gated, attributed (`actor`, `produced_by`), timestamped,
  rollbackable, and calibration scores each writer separately, so a
  teammate is never operating blind on what changed, who changed it, or
  how much to trust it. WAL covers many processes on one host today; the
  remaining work is transport and identity: an HTTP/SSE MCP endpoint in
  front of the store, and authenticated actor identity (signed witnesses
  are the existing upgrade path from declared identity).
- 🛠️ Workflow-engine CLI surface (`recall workflow allocate` shipped; the
  remaining commands are planned, see
  [`docs/09_WORKFLOW_ENGINE.md`](docs/09_WORKFLOW_ENGINE.md))
- ✅ Auto-memory importer (`recall import auto-memory [--root path] [--project name] [--apply] [--db path]`):
  imports Claude Code auto-memory files (`~/.claude/projects/<slug>/memory/*.md`)
  as calibrated cells through admission; dry-run by default with `--apply`,
  idempotent per file content, supersedes changed files via a `contradicts` edge
- 🛠️ Importers for additional note/agent-log formats, writing through admission
- 🔭 Additional embedding backends and external graph integrations
- 🔭 A short, copy-pasteable "first 5 minutes" demo and a recorded walkthrough

---

## How to influence this

The fastest way to move something up the list is to open an issue describing
the problem you hit. Real usage beats speculation. If you want to build, pick
up a [good first issue][gfi] or propose a design before writing a lot of code.
See [CONTRIBUTING.md](CONTRIBUTING.md).

[gfi]: https://github.com/H-XX-D/recall-memory-substrate/labels/good%20first%20issue
