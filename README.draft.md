<p align="center">
  <img src="assets/recall-hero.svg" alt="Recall" width="100%">
</p>

<p align="center">
  <strong>Push-based memory for AI agents. It rides in context every prompt, fixes itself when a fact changes, and remembers across sessions on its own. Local, free, yours.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-Apache--2.0-0d9488.svg" alt="license">
  <img src="https://img.shields.io/badge/node-%E2%89%A524-0d9488.svg" alt="node 24+">
  <img src="https://img.shields.io/badge/os-mac%20%C2%B7%20linux%20%C2%B7%20windows-2dd4bf.svg" alt="os">
  <img src="https://img.shields.io/badge/storage-local%20SQLite-5eead4.svg" alt="sqlite">
</p>

<p align="center">
  <a href="#install">install</a> &middot;
  <a href="#put-your-agent-on-it">agents</a> &middot;
  <a href="#where-memory-lives">databases</a> &middot;
  <a href="#the-hooks">hooks</a> &middot;
  <a href="#edge-programs">edge programs</a> &middot;
  <a href="#the-bigger-system">the bigger system</a> &middot;
  <a href="ROADMAP.md">roadmap</a>
</p>

---

## The problem

Your agent forgets everything between sessions. The memory tools that bolt on to fix that are a search box over a pile of notes. The agent has to remember to ask, they hand back whatever matches a string, and none of them ever tell the agent a fact went stale. So it reads a wrong answer at full confidence, and you are the one who catches it three days later, after it already built on it.

## What Recall does instead

It pushes. Pull memory sits in a store and waits to be queried. Recall is already in the agent's context. Before every prompt a hook drops the cells relevant to what you typed into the model, with the stale and superseded ones flagged. The agent reads what it knows, does the work, writes back what it learned. When a fact changes, the new write supersedes the old one. The old one loses confidence on its own, nothing gets deleted, and the change is there next session without anyone asking.

No second model deciding what to keep. No cloud. The whole graph is a SQLite file on your disk, and every cell carries who wrote it, a confidence the graph recomputes live, and a one-command undo.

## Install

```bash
npm install -g github:H-XX-D/recall-memory-substrate
```

Or the script that clones, builds, and links it:

```bash
curl -fsSL https://raw.githubusercontent.com/H-XX-D/recall-memory-substrate/main/scripts/install.sh | bash
```

Node 24+, built-in SQLite, no server, no native build, no account. Runs on macOS, Linux, and Windows. You get two binaries: `recall` (CLI and a read-only TUI) and `recall-mcp`.

## Put your agent on it

```bash
recall claude sync     # Claude Code
recall codex sync      # Codex
```

That installs the skill, the MCP server, and the hooks. For Claude it also turns off the built-in note memory so Recall is not fighting a second store, and lifts whatever you already saved into the graph so nothing gets stranded. It backs up your config first, is safe to re-run, and reverts. Restart the agent and it reads before it answers and writes back on its own. You never tell it to save.

## The part that matters

Correcting a fact is not an overwrite. You write a new cell that contradicts the old one, and from then on every read demotes the old value instead of deleting it.

```text
decision:6eba1114   conf:0.70  eff:0.70               # cache ttl is 60s
decision:6eba1114   conf:0.70  eff:0.29(challenged)   # after one cell contradicts it
```

No model ran to do that. Effective confidence is recomputed on every read from what supports a cell, what challenges it, and how often that writer has been wrong before. Challenged cells sink, the old answer stays in the graph with the trail of why it changed, and exactly one current answer comes back. That is the difference between memory that piles up and memory that stays straight.

## Where memory lives

One SQLite file per project, routed by working directory. Nothing dumps into a single bucket.

- A registered project writes to `~/.recall/db/<project>.sqlite3`.
- Outside a project, writes go to the home db `~/.recall/db/home.sqlite3`, and reads there union across home plus every project, so shared facts are visible anywhere.
- The CLI walks up from your current directory and picks the first project it matches. No match uses home.

```bash
recall project init      # register this directory
recall project where     # which db am I hitting, and why
```

Point a whole machine at one graph with `RECALL_DB=/path.sqlite3`. The CLI, the MCP server, and the helper scripts all read it.

## The hooks

`claude sync` installs one hook that runs in three modes:

- SessionStart hands the agent a directive and a 7-day diff of the project.
- UserPromptSubmit is the push: an index of the cells relevant to your prompt, ids and titles only, with contested or stale ones flagged. It is deliberately partial so the agent still runs a real compile. It escalates to DIG REQUIRED only when a row you might lean on is actually superseded or stale.
- Stop is the backstop: when a row was flagged DIG REQUIRED, it holds the turn open until the transcript shows the agent read it, then gets out of the way. Single shot, fails open.

## Edge programs

A hyperedge can carry a program that runs with no model in it. Bind a decision to its risks and verifications and the bundle scores itself off live confidence, so it works as a tripwire: contradict any member, even with a failing test wired in, and the score drops on the next run.

- `score` prices the bundle.
- `watch` fires when it moves more than delta since the last run.
- `trend` reads direction and slope over the run history, so an eroding belief trips before it crosses a hard line.
- `drift` is watch that names which member moved.
- `quorum` is k-of-m sign-off across distinct actors, and an approval stops counting if its cell later gets contradicted.

Run one from cron and a standing decision becomes a monitored service. The run prints plain JSON, so it pipes to Slack or scrapes into Grafana, and the graph stays the source of truth.

## Inception

`recall incept` is for making something new, not finding something. It compiles a slice of the graph for an open question and hands back a write template already linked to those cells. The model fills in the idea and admits it, so the new cell is born tied to what it came from. The model does the thinking, Recall does the grounding and lets the graph judge it later. The generative step stays out of the runtime on purpose, because a model in the loop would break the no-model trust.

## Primitives

Recall is a small set of typed primitives. Sprints, deploy gates, code graphs, and the rest are not features, they compose from these.

Structure:

- `cell`: the unit of memory, an addressable record with content, tags, two confidences, and provenance.
- `hyperedge`: a typed relation binding any number of cells, not just two.
- `relation`: a typed pairwise edge between two cells.
- `dag overlay`: an ordered overlay on the graph for workflows, evidence chains, and execution traces.
- `program`: a sandboxed operation bound to a hyperedge that runs with no model in it.
- `context packet`: a compiled, word-budgeted slice of the graph returned for a task.
- `address`: a stable `recall://cell/...` handle so a cell can be referenced across sessions.

Cell kinds, what you write:

- `observation`: something noticed or measured, the default factual record.
- `decision`: a choice made, with the reason it was made.
- `risk`: a hazard worth tracking.
- `task`: an open action to do.
- `objective` / `goal`: a target outcome and the higher aim it serves.
- `hypothesis`: a proposed claim, admitted unverified, that the graph vets over time.
- `lemma`: a load-bearing sub-result other claims build on.
- `question`: an open question to resolve.
- `assumption`: something taken as true without proof, marked as such.
- `constraint`: a rule or limit the work must respect.
- `preference`: a stated like or dislike that should guide choices.
- `reflection`: a lesson about the work itself, not the subject.
- `contradiction`: a recorded clash between two claims.
- `conflict`: a broader unresolved tension that needs a call.
- `verification_result`: the outcome of a declared check (verified, refuted, unverifiable, error, partial).
- `witness`: a piece of evidence or attestation backing a claim.
- `belief` / `belief_update`: a claim that can be confirmed, contradicted, or superseded later, the update revising a prior one.
- `artifact`: a produced output, a file, a document, a code module.
- `source`: an external origin or reference.
- `domain`: a subject area the work lives in.
- `checkpoint`: a saved state to resume from.
- `handoff`: a context handoff to another session or agent.
- `session`: a record of a working session.
- `identity`: an actor record.
- `trust`: a trust statement about an actor.
- `transfer`: a result carried from one domain into another.
- `action`: an executed step recorded as memory.
- `meta`: a note about the memory system itself.
- `benchmark_run`: a recorded benchmark run and its numbers.
- `miss`: a recorded gap or failure, what was missed.

Workflow allocation:

- `work_candidate`: a unit of possible work (file, source, action, hypothesis, benchmark) up for selection.
- `proxy_score`: a cheap estimate of a candidate's impact, risk, uncertainty, or cost.
- `allocation_plan`: the chosen candidates and the reason they were chosen.
- `blind_lock`: a prediction pre-registered before the result, so the goalposts cannot move.

Typed relations, the edges:

- `supports` / `contradicts`: evidence for or against a cell, which moves its effective confidence.
- `concerns`: a flagged worry against a cell that does not delete it.
- `depends_on`: this cell needs that one.
- `supersedes`: this cell replaces that one.
- `derived_from`: this cell was synthesized from those.
- `belongs_to` / `mentions` / `executes` / `emits` / `invalidates`: membership, reference, run, output, and revocation links.

Program operations:

- `score`: price a bundle from its members' live confidence.
- `watch`: fire when the bundle moves more than delta since the last run.
- `trend`: read direction, slope, and acceleration over the run history.
- `drift`: watch that names which member moved.
- `quorum`: k-of-m sign-off across distinct actors.
- `emit_witness`: derive a witness cell from a bundle.
- `tag_projection`: project a tag family across a bundle's members.

Engine mechanisms:

- `effective confidence`: a cell's trust, recomputed every read from supports, challenges, and the writer's record.
- `admission firewall`: the one gate every write passes, schema, provenance, attenuation, secret-blocking, rollback entry.
- `supersession`: corrections demote the old cell instead of deleting it.
- `calibration`: a per-actor Brier score, stated confidence judged against survived contradictions.
- `rollback journal`: a one-command undo for any write.
- `provenance`: who wrote a cell, when, and on what evidence, on every cell.
- `secrets side graph`: an encrypted, separate store for credentials, never the primary graph.
- `daemon`: a quiet maintenance pass that runs stale, contradiction, and derivation work outside the model.

## The bigger system

Recall is the memory layer. Three more parts plug into the same graph through the same write path, none with a model in the loop:

- **Solver** is the compute layer. A private suite of small gated solvers across control, signal, estimation, and optimization, each checked against a reference oracle before any speed number counts, each carrying a contract that says whether its answer is exact, bounded, or heuristic. The model sets up the problem, Solver solves it, the answer lands in Recall as a priced claim.
- **Lattice** is the code-analysis layer, enterprise, not in the open build. It reads a codebase over LSP into the same kind of graph Recall uses and runs structure on it: blast radius before an edit, ranked structural bugs, dead code and cycles in one pass, and a diff gate that reports only the regressions a change caused. Findings land as cells, so a regression is tracked instead of a warning that scrolls away.
- **Ledger** is the verification layer. It runs declared checks and records honest verdicts (verified, refuted, unverifiable, error, partial) instead of calling no-failure a pass. Its attestation is tied to an exact commit on a clean tree, and a fail-closed pre-push hook gates on it. It writes support and contradiction edges into the graph, where a verification outweighs peer testimony.
- **Hard-Recall** is a security-hardened build of Recall, the same runtime under a stricter threat model, for teams that need their memory locked down.

Solver, Lattice, Ledger, and Hard-Recall are access-gated. For any of them: [todd@hendrixxdesign.com](mailto:todd@hendrixxdesign.com).

## SENTINEL

SENTINEL is the in-repo benchmark. It measures what push and a model-independent trust floor actually buy: catching contradictions nobody pointed out, holding supersession under load, and the cross-session and cross-actor behavior a pull store cannot reproduce. It runs against a throwaway graph in the repo, so anyone who clones it can rerun it.

## Roadmap

Direction, not promises. Full list in [ROADMAP.md](ROADMAP.md). Next up: publish to npm, a shared team graph served over HTTP with signed actor identity, sharper evidence calculus, and an epoch-anchored history log with inclusion proofs.

## The rest

```bash
npm install && npm run build && npm test && npm run e2e
```

Schema-first, small, tested. [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) set the bar. Read [SECURITY.md](SECURITY.md) before you put anything sensitive in: runtime dbs are git-ignored, writes reject credential shapes, and real secrets go in the encrypted side graph behind an explicit flag. Apache-2.0, full docs in [docs/](docs/README.md).

Built and maintained by Todd Hendrixx. [todd@hendrixxdesign.com](mailto:todd@hendrixxdesign.com).
