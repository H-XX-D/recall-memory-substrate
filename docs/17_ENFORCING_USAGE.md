# Enforcing Recall Usage

The problem: AI agents drift away from using Recall mid-session. They
read the operating contract at session start, use Recall for a few turns,
and then increasingly default to generating answers from in-context
information rather than consulting persistent memory. This document
covers why this happens and the layered mitigations that solve it.

## Why agents forget to use Recall

Four real causes, each addressable by a different technique:

1. **System-prompt drift.** Instructions to use Recall are loaded once at
   session start. As the conversation grows and the context window fills
   with other content, attention to those instructions fades. The agent
   doesn't *forget* in any explicit sense; it just stops weighting the
   "check Recall first" instruction relative to more recent context.

2. **Training pull toward in-context inference.** LLMs are trained to be
   helpful with whatever's in their context window. Reaching for an
   external tool requires extra reasoning steps, runs the risk of an
   unhelpful response, and isn't strongly rewarded during training
   compared to fluent in-context generation.

3. **No friction for skipping memory.** The agent can produce plausible-
   looking output without consulting Recall. Nothing immediately signals
   "you should have checked memory first." The friction shows up later
   (next session, the agent re-derives the same thing) and by then it's
   too late to correct.

4. **Effort gradient.** A Recall query costs reasoning steps. Generating
   text directly doesn't. At the margin, the path of least resistance is
   to skip the tool call.

## The shipped path: `recall claude sync`

The techniques below are the portable building blocks. The product wires them
into one installed hook, `integrations/claude/hooks/recall-session-start.py`,
put in place by `recall claude sync`. It runs in three modes and is the closed
loop in practice:

- **SessionStart** emits the operating directive plus a 7-day activity summary.
- **UserPromptSubmit (`--prompt`)** is the push (Technique 1, productized): a
  mini index of the cells relevant to the prompt, ids and titles plus tripwire
  counts, deliberately incomplete so the agent still runs a real `recall
  compile`. The dig is danger-proportional: a row is marked `[SUPERSEDED?]` or
  `[STALE]` only when it is itself the superseded or stale cell, escalating to
  `DIG REQUIRED` only then.
- **Stop (`--stop`)** is the dig backstop, the one structural enforcement point
  in the soft loop. When a row was flagged `DIG REQUIRED`, it blocks the turn
  from ending until the transcript shows the agent actually read the flagged
  cell. It is single-shot and loop-guarded (it nudges once, never hard-traps)
  and fails open on any error. This closes the gap that made the dig a
  suggestion: the push and the firewalled write are structural, but the dig
  itself was behavioral until this mode gave it a backstop.

The `.sample` templates in `python/hooks/` documented below are the lower-level,
runtime-agnostic version of the same ideas (and the PreToolUse guard, Technique
4, is hard enforcement the shipped hook does not install by default). Use
`recall claude sync` for Claude Code; use the templates to wire another runtime
or to add hard enforcement.

## The fix: ambient presence, not stronger prompting

Stronger system prompts don't work; they fade like the original. The
fix is to make Recall **ambient**: continuously present in the model's
context, not just announced once. Combine three techniques:

### Technique 1: UserPromptSubmit hook injects status header

On every user prompt, a hook prepends a tiny header showing what Recall
has on the topic. The agent literally cannot miss it because it's in
every prompt the agent reads.

Header is typically 100-200 bytes and looks like:

```
[recall: 3 cells touch this topic. Top hit: `4ae7579e` "L7 closure".
 Try: `recall_peek 4ae7579e` or `recall_router.py "<query>"`]
```

Template: [`python/hooks/recall_inject_context.py.sample`](../python/hooks/recall_inject_context.py.sample).

Install in Claude Code settings.json:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "command": "python3 /path/to/python/hooks/recall_inject_context.py.sample"
      }
    ]
  }
}
```

For other agent runtimes, wire into whatever pre-prompt hook the
runtime provides.

**Why this works**: the model sees the header on EVERY turn. It can't
drift away because every input has a fresh reminder. The cost is ~100
bytes per turn, negligible against any realistic budget.

### Technique 2: Stop hook prompts writeback before turn ends

The asymmetric failure mode: agents that DO read from Recall often
still FAIL TO WRITE durable findings back. A decision is made, a bug is
root-caused, a contradiction is noticed, and the agent moves on
without persisting. Next session, the same agent rediscovers the same
things.

A Stop / SubagentStop hook scans the conversation for substantive-
finding signals ("decided", "found", "fixed", "root cause", etc.) and
emits a writeback reminder if any are present and no Recall write
happened in the recent window.

Template: [`python/hooks/recall_writeback_reminder.py.sample`](../python/hooks/recall_writeback_reminder.py.sample).

Install in Claude Code settings.json:

```json
{
  "hooks": {
    "Stop": [
      {
        "command": "python3 /path/to/python/hooks/recall_writeback_reminder.py.sample"
      }
    ],
    "SubagentStop": [
      {
        "command": "python3 /path/to/python/hooks/recall_writeback_reminder.py.sample"
      }
    ]
  }
}
```

**Why this works**: the agent gets a final nudge at the right moment.
Catching the writeback at end-of-turn is more reliable than hoping the
agent remembers to write during the turn (when it's focused on the
user's request).

### Technique 3: Strong system prompt with operating contract

The hooks reinforce; they don't replace baseline instruction. The
[`LLM_SYSTEM_PROMPT.md`](LLM_SYSTEM_PROMPT.md) document is designed to
be loaded as the agent's system prompt or persistent project memory. It
establishes the operating contract:

- Read first (compile a context packet before relying on recall)
- Write durable findings back without asking permission
- Use addresses instead of copying bodies
- Keep secrets out of the primary graph

The system prompt establishes the discipline; the hooks maintain it
across the session.

## Combined effect (soft layer only)

| Mechanism | What it does | When it fires |
|---|---|---|
| System prompt | Establishes operating contract at session start | Once (session start) |
| UserPromptSubmit hook | Injects Recall status before every user prompt | Every user turn |
| Stop / SubagentStop hook | Reminds agent to write back substantive findings | End of every turn |
| Router auto-dispatch | Picks the right Recall tool when the agent queries | Every Recall-via-router call |

The four reinforcement points combined produce **continuous Recall
presence** across the session. The agent doesn't have to remember to use
Recall. Recall keeps reminding it.

## Configuration controls

Both hook templates honor environment variables for fine-tuning:

| Variable | Effect |
|---|---|
| `RECALL_DB` | Override database path (default is the routed local `~/.recall/db/home.sqlite3`, or a registered project's `~/.recall/db/<slug>.sqlite3`) |
| `RECALL_HOOK_DISABLE` | Disable the inject-context hook entirely |
| `RECALL_HOOK_MAX_HITS` | Max cells mentioned in injection (default 3) |
| `RECALL_HOOK_VERBOSE` | Debug output to stderr |
| `RECALL_WRITEBACK_DISABLE` | Disable the writeback reminder entirely |
| `RECALL_WRITEBACK_FORCE` | Always emit writeback reminder (training mode) |
| `RECALL_WRITEBACK_VERBOSE` | Debug output to stderr |

For an established agent that doesn't need training-wheels: turn off
the inject-context hook and keep just the writeback reminder. For a
new deployment: use both. For high-volume production where any extra
latency matters: profile the hooks (each adds ~10-50ms) and decide.

## Soft vs hard enforcement

Techniques 1 to 3 above are **soft enforcement**. They don't:

- Block the agent from doing anything
- Force the agent to call Recall before responding
- Override the agent's reasoning

They make Recall presence ambient and writeback friction-free. The
agent still chooses what to do.

### Technique 4: PreToolUse guard (HARD enforcement)

The hard-enforcement tier blocks substantive mutations (Edit, Write,
NotebookEdit, destructive Bash commands) unless a recent Recall cell
exists that records the rationale for the change.

Template: [`python/hooks/recall_pretooluse_guard.py.sample`](../python/hooks/recall_pretooluse_guard.py.sample).

Install in Claude Code settings.json:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit|Bash",
        "command": "python3 /path/to/python/hooks/recall_pretooluse_guard.py.sample"
      }
    ]
  }
}
```

The matcher field ensures the hook only runs for the tools we guard;
Read/Grep/Glob calls aren't affected.

**Decision rule.** A tool call is APPROVED if any of these hold:
1. `RECALL_GUARD_BYPASS=1` is set (documented escape hatch for emergencies)
2. The target path matches the allowlist (default `/tmp,.recall`)
3. A Recall cell of an appropriate kind (`decision`, `task`, `hypothesis`,
   `lemma`, `risk`, `verification_result`, `reflection`, `blind_lock`)
   was written in the last `RECALL_GUARD_WINDOW` seconds (default 30 min)
   AND mentions the target file, parent directory, project name, or a
   topic that matches the file
4. The Recall DB doesn't exist yet (cold-start grace)

Otherwise the tool call is blocked with exit code 2 and a structured
message that names the target, shows the exact `recall_helper.py`
invocation to unblock, and reminds about the BYPASS escape hatch.

**Configuration controls:**

| Variable | Effect |
|---|---|
| `RECALL_GUARD_BYPASS` | Disable guarding entirely (audit logged) |
| `RECALL_GUARD_WINDOW` | Lookback seconds for rationale (default 1800) |
| `RECALL_GUARD_ALLOWLIST` | Comma-separated path prefixes always allowed |
| `RECALL_GUARD_PROJECT` | Project name used to match rationale cells |
| `RECALL_GUARD_VERBOSE` | Debug output to stderr |
| `RECALL_GUARD_DRY_RUN` | Emit block messages but always exit 0 (trial mode) |

**Recommended rollout:**

1. Start with `RECALL_GUARD_DRY_RUN=1` for a week. The hook will print
   block messages but not actually block. Audit how often you'd be
   blocked and whether your writeback discipline is sufficient.
2. If the block rate is acceptable (you're recording rationales for
   most changes already), unset DRY_RUN. Hard enforcement kicks in.
3. Tune `RECALL_GUARD_WINDOW` and `RECALL_GUARD_ALLOWLIST` for your
   project. A typical setup: 30-minute window, allowlist
   `.recall,/tmp,docs/scratch,tests/fixtures`.
4. Keep `RECALL_GUARD_BYPASS` documented but treat its use as a
   reportable event: the whole point is no untracked mutations.

**When to use hard enforcement.** Regulated environments where every
change requires an audit trail. Multi-agent systems where one agent's
mutations affect another's working set. Long-horizon research where
"why did I make this change six months ago" must be answerable. NOT
recommended for casual personal use; the friction-to-payoff ratio
inverts when you're the only writer and reader.

## Diagnosing usage in practice

**Verify the hooks themselves** with the included test suite (27 tests covering
the hooks and their Python toolkit, exit code 0 if all pass):

```bash
python3 python/hooks/test_hooks.py
```

For ad-hoc spot checks:

```bash
echo "find the validate_user function" | \
  python3 python/hooks/recall_inject_context.py.sample

echo "I found the root cause and the fix is to update the SOCKS config" | \
  RECALL_WRITEBACK_FORCE=1 python3 python/hooks/recall_writeback_reminder.py.sample
```

**Measure whether the agent is following the hooks** with the
compliance audit:

```bash
python3 python/hooks/audit_compliance.py --since 7d
python3 python/hooks/audit_compliance.py --since 30d --json
```

The audit reports a 0..1 compliance score across four dimensions:
write-day ratio (40%), confidence-grading diversity (25%), cell-kind
diversity (20%), and supersedure use (15%). It also distinguishes
epistemic writes from ACP (Agent Communication Protocol) traffic since
ACP cells use a different payload shape and shouldn't be counted in
the epistemic-discipline score. A score below 0.5 returns exit code 1
(useful for CI gating or daily report alerting).

For lower-level inspection, query the graph directly:

```bash
# Cells written in the last hour:
python3 python/scripts/recall_diff.py --since 1h --summary

# Total writes today:
sqlite3 ~/.recall/db/home.sqlite3 \
  "SELECT COUNT(*) FROM graph_nodes WHERE created_at >= date('now')"
```

If the count is unexpectedly low for a session that should have
produced substantive findings, the agent is drifting. Increase the
inject-context frequency or enable `RECALL_WRITEBACK_FORCE` to make the
reminder unconditional for a few sessions until the pattern sticks.

## Longitudinal tracking

Point-in-time audit (`audit_compliance.py`) tells you whether today
looked healthy. It doesn't tell you whether enforcement is producing
*better outcomes over time*. The longitudinal tracker measures four
trajectory dimensions:

1. **Rationale quality**: substance (body length), linkage (evidence
   refs), confidence-grading variance, topic specificity. Composite
   `quality_score` 0..1.
2. **Rework / churn**: `contradicts_rate`, `supersedes_rate`, and
   `rediscovery_rate` (cells whose body has high token-overlap with
   older cells, indicating the agent re-derived instead of reading).
3. **Enforcement compliance**: from guard event log: approve/block/
   bypass rates, median time from block→write→retry. A healthy
   trajectory: bypass rate near zero, block-to-write latency falling.
4. **Continuity value**: `handle_reuse_rate` (fraction of cells
   referenced by later cells via typed edges) and avg incoming-edge
   count. This is the operatable-memory thesis becoming measurable:
   when continuity matters, addresses get reused.

Snapshots are stored in `~/.recall/longitudinal_snapshots.jsonl`
(append-only). Run from cron daily:

```bash
0 18 * * * python3 /path/to/python/hooks/longitudinal_tracker.py snapshot
```

Then review trajectories:

```bash
# Latest snapshot + Δ vs the prior one
python3 python/hooks/longitudinal_tracker.py report

# One metric across all snapshots (any dot-path into the JSON)
python3 python/hooks/longitudinal_tracker.py trend \
  --metric rationale_quality.quality_score
python3 python/hooks/longitudinal_tracker.py trend \
  --metric enforcement.bypass_rate

# Recent guard events (useful when investigating a block)
python3 python/hooks/longitudinal_tracker.py events --limit 30

# Full history as JSON for plotting / further analysis
python3 python/hooks/longitudinal_tracker.py history --json > snaps.json
```

The guard's event log (`~/.recall/guard_events.jsonl`) is the audit
substrate the tracker reads from. Every `approve` / `block` / `bypass`
/ `cold_start` / `dry_run` decision is appended as one JSONL record
with timestamp, tool, target, and (for approvals) the matched
rationale cell ID. This is what makes "did the enforcement loop
actually work" answerable instead of speculative.

**What healthy trajectories look like:**
- `rationale_quality.quality_score` ≥ 0.6 sustained
- `rework.rediscovery_rate` falling over weeks (agent is learning to read first)
- `enforcement.bypass_rate` < 0.05 sustained (escape hatch reserved for emergencies)
- `enforcement.median_block_to_write_seconds` falling (agent learns to write rationale first)
- `continuity.handle_reuse_rate` rising (cells become reference points, not write-only)

**What unhealthy trajectories look like:**
- Quality flat or falling: discipline is being skipped, possibly because the schema feels too heavy. Consider lowering required tag families or expanding the `--admit` helper.
- Rediscovery rising: agent isn't reading before writing. Increase `inject-context` aggressiveness or expand topic matching.
- Bypass rate climbing: hard enforcement is being routed around. Review allowlist scope and consider whether the window is too short.
- Handle reuse falling: cells are write-only, not building on each other. This is the operatable-memory thesis failing. Investigate why agents aren't linking new writes to prior ones.

## Enforcement roadmap

| Mechanism | Status |
|---|---|
| UserPromptSubmit injection (soft) | **shipped**: see Technique 1 |
| Stop / SubagentStop reminder (soft) | **shipped**: see Technique 2 |
| Stop dig backstop (`recall claude sync`, `--stop`) | **shipped**: blocks turn end until a `DIG REQUIRED` cell is read; single-shot, loop-guarded, fail-open |
| System prompt operating contract | **shipped**: see Technique 3 |
| PreToolUse guard / mandatory write-on-decision (hard) | **shipped**: see Technique 4 |
| Compliance attestation per session | planned: hash chain of writes and reads for audit-trail use |
| Multi-tenant enforcement profiles | planned: per-project guard profiles loaded by tenant |
| Replay-from-audit-log | planned: reconstruct prior session state from immutable write log |

If you need any of the planned items now, file an issue describing your
use case.
