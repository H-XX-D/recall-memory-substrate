# Sprints — Multi-Session AI Work in Recall

A **sprint** is a structured multi-session work project represented as a graph
of task cells in Recall. The AI executes the sprint by querying Recall for the
next open task, doing the work, writing the outcome back as cells, and
proceeding to the next task — without stopping to ask the user what to do at
every step.

Sprints are the highest-leverage usage pattern for Recall as operatable
memory. They let one user direct sustained work across days, weeks, or months
without micro-managing each session. They work across AI providers (any model
with subprocess access to the `recall` CLI can drive a sprint). They preserve
audit trail (every task and outcome is a Recall cell with timestamps,
provenance, and typed relations).

This doc explains how sprints are structured, how to set them up, and how
to operate them.

## When to use sprints

A sprint is appropriate when:

- The work spans multiple sessions (more than ~2 hours of focused effort)
- The work has structure: discrete steps with dependencies, not just a
  single open-ended conversation
- The work benefits from audit trail (later you'll want to know what was
  done when, why, and what evidence supported each step)
- You want the AI to make progress autonomously between your check-ins
  rather than waiting for prompts at every step

A sprint is NOT appropriate when:

- The work is a single conversation that completes in one session
- The work is exploratory in a way that doesn't admit structured planning
- The work is genuinely throwaway (debugging a one-off issue, casual
  questions, etc.) — don't pollute the substrate with cells you won't
  reference again

## Sprint anatomy

A sprint is a graph of cells in your Recall database. The minimum structure:

### 1. Sprint root cell

One cell describing the sprint's overall goal. Typically `kind=goal` or
`kind=objective` depending on what's most appropriate to your project.

```bash
python3 python/scripts/recall_helper.py \
  --kind goal \
  --title "Sprint: refactor parser.py to new structured-error pattern" \
  --body "Multi-session work to migrate src/parser.py from ad-hoc try/except to the structured ParseError hierarchy introduced in PR #142. Sprint root; task cells reference this via depends_on. Sprint complete when: parser.py uses new pattern, all callers updated, test suite green, CHANGELOG entry written." \
  --confidence 0.8 \
  --topics "sprint,refactor-parser,error-pattern" \
  --project "myapp" \
  --lifecycle "active,sprint-root" \
  --admit
```

The sprint root cell does two things:

- Captures the goal in one addressable place
- Acts as a tag-anchor for the task cells (`sprint-root` lifecycle tag
  identifies it; task cells reference it via `depends_on`)

### 2. Task cells

One cell per concrete work item. Use `kind=task` with clear acceptance
criteria in the body.

```bash
python3 python/scripts/recall_helper.py \
  --kind task \
  --title "Task 1: audit current error handling in parser.py" \
  --body "List all try/except sites in src/parser.py. For each, identify which ParseError subclass it should map to per the PR #142 hierarchy. Acceptance criterion: complete audit table covering every site. Expected output: artifact cell with the audit table linked back to the sprint root." \
  --confidence 0.9 \
  --topics "sprint,refactor-parser,audit" \
  --project "myapp" \
  --lifecycle "open,sprint-task" \
  --admit
```

Key elements:

- **Clear acceptance criterion**: the AI should know when the task is done
- **Expected output**: what kind of cell(s) the task should produce
- **Topics include `sprint`**: so the task is findable by sprint query
- **Lifecycle `open`**: status marker the AI updates as work progresses
- **Lifecycle `sprint-task`**: marks it as a task cell vs. another kind

### 3. Dependencies

If task B depends on task A, link them with a `depends_on` edge:

```bash
python3 python/scripts/recall_helper.py \
  --kind task \
  --title "Task 2: refactor parser.py to use ParseError hierarchy" \
  --body "Using the Task 1 audit table, replace every try/except site in parser.py with the appropriate raise ParseError(...) call per PR #142 conventions. Acceptance: all sites converted, parser.py compiles, no behavior change for passing inputs. Expected output: task supersedure cell referencing the commit SHA." \
  --confidence 0.85 \
  --topics "sprint,refactor-parser,implementation" \
  --project "myapp" \
  --lifecycle "open,sprint-task" \
  --depends-on "recall://cell/<task-1-cell-id>" \
  --admit
```

The AI executing the sprint sees Task 2 is blocked until Task 1 is complete,
and doesn't pick it up until then.

### 4. Outcome cells

When the AI completes a task, it writes outcome cell(s) capturing the
findings. Outcome cells are typed by what they represent: `kind=lemma` for
derivations, `kind=decision` for choices, `kind=verification_result` for
test outcomes, `kind=reflection` for substantive observations, etc. The
outcome cells link back to the task via `supports` or `concerns` edges.

### 5. Status updates

When a task is complete, the AI either:

- Writes a new cell that supersedes the task cell (the new cell's
  lifecycle is `done,sprint-task` and the typed edge is `supersedes`),
- OR writes an update reflecting completion (and the original task's
  lifecycle is changed to `done` via a separate write).

Status states for sprint tasks:

- `open` — not yet started
- `in-progress` — actively being worked
- `blocked` — waiting on resolution (typically with a `concerns` cell
  explaining what's needed)
- `done` — completed, outcome cells written
- `abandoned` — no longer applicable, with reason in a superseding cell

## Setting up a sprint

Step by step:

### 1. Write the sprint root cell

Describe the sprint's goal in 1-3 paragraphs. Be specific about what
"done" looks like at the sprint level.

### 2. Decompose into tasks

Break the goal into 3-10 task cells. Each task should be:

- Concretely actionable (the AI can start working on it without further
  decomposition)
- Have a clear acceptance criterion (the AI knows when it's done)
- Specify expected output (what cells it should produce)
- Reference the sprint root via `depends_on` so it's findable by the
  sprint's tag set

### 3. Model dependencies

If tasks have ordering dependencies, model them explicitly with
`depends_on` edges. The AI uses these to determine which task to pick up
next (only tasks whose dependencies are all `done` are eligible).

### 4. Set initial lifecycle

All tasks start as `open`. The AI will move them to `in-progress` when
starting work, then `done` (or `blocked`) when finished.

### 5. Hand off to the AI

End your setup session with a clear hand-off prompt:

> "I've set up the sprint root at cell `<sprint-root-id>` with N task
> cells. Please begin executing the sprint: query Recall for open tasks
> tagged `sprint-task` in project `<project>`, work through them in
> dependency order, write outcome cells per the acceptance criteria,
> and update task lifecycle as you go. Check in with me at sprint
> completion or when blocked."

## AI execution loop

Once the sprint is set up, the AI's loop looks like this:

```
1. Query Recall: open sprint tasks in project P, ordered by dependencies satisfied
   (filter: kind=task, lifecycle=open, all depends_on targets have lifecycle=done)
2. If no eligible task: check for blocked tasks needing resolution; if none,
   sprint is complete or stalled — write reflection cell summarizing state.
3. For the next eligible task:
   a. Mark lifecycle=in-progress (write update cell or supersedure)
   b. Read task body, expected output, acceptance criteria
   c. Read any cells referenced by depends_on for context
   d. Execute the task
   e. Write outcome cell(s) per the expected output spec
   f. Verify acceptance criteria are met
   g. Mark task lifecycle=done with supersedure edge to the outcome
4. Loop to step 1 until sprint complete or blocked
```

This loop is what the AI does autonomously between user check-ins. The
user doesn't direct each step — they directed the sprint plan, and the AI
executes within it.

## User check-ins

The user engages with the sprint at meaningful points:

- **At sprint completion**: review outcome cells, decide on next sprint
  (extend with more tasks, start new sprint, archive sprint).
- **When blocked**: if the AI writes a blocker cell explaining what's
  needed, the user provides resolution (either by writing a cell with
  the missing information, or by clarifying the task scope, or by
  decomposing the blocked task into smaller items).
- **At decision points**: some tasks explicitly require user input
  (which of several approaches to take, whether a controversial
  derivation should be committed to, etc.). The task body specifies
  the decision; the AI writes a `decision-required` cell and pauses
  for the user.
- **Periodic review** (optional): query sprint progress (`recall search
  "sprint" project=<P>`) to see what's been done, what's open, what's
  blocked. Helps catch drift early.

## Cross-provider portability

Because Recall is a CLI accessible via subprocess, any AI that can
execute subprocesses can drive a sprint. The sprint state lives in
SQLite locally on your machine, not in any provider's memory.

Practical workflow:

- Session 1: Claude sets up the sprint and executes tasks 1-3
- Session 2: ChatGPT (with MCP or shell access to Recall) picks up at
  task 4, executes through task 7
- Session 3: Future Claude picks up at task 8, completes the sprint
- Session 4: Different ChatGPT instance reviews outcomes and plans
  the next sprint

The sprint doesn't care which AI is currently executing. The task graph
defines the work; the AI is the executor. This protects your work from
provider lock-in and lets you use whichever AI is best for the current
phase.

## Failure modes and recovery

**AI drifts away from Recall mid-sprint.** Hooks help (see
[17_ENFORCING_USAGE.md](17_ENFORCING_USAGE.md)). If drift happens, the
sprint state shows it: tasks marked in-progress without outcome cells,
gaps in the audit trail. Recovery: query sprint state, identify drift
point, restart from there with reinforced discipline (force-enable
hooks, explicit reminder).

**Task plan turns out wrong.** Write a superseding cell explaining why
the plan needs revision; mark old tasks as `abandoned` with reason;
write new tasks with corrected approach. The audit trail preserves the
revision history.

**Sprint becomes too large.** Split into sub-sprints. Mark the original
sprint root as superseded by N new sprint roots, each focused on a
subset of the original tasks.

**Sprint becomes irrelevant.** Mark sprint root and all open tasks as
`abandoned` with a reflection cell explaining why. Don't delete —
preserve the audit trail of work that was planned but not pursued.

**AI executes task without writing outcome cells.** The audit trail
will show the discrepancy. Recovery: ask AI to retroactively write the
outcomes from what was done; if that's not possible, mark task as
needs-rework and re-execute.

## Best practices

**Task granularity**: aim for tasks that take 15 minutes to a few hours
of AI work each. Tasks shorter than 15 minutes generate too much
task-cell overhead; tasks longer than a few hours are usually
under-decomposed and benefit from breaking into sub-tasks.

**Clear acceptance criteria**: the AI should know when a task is done
without having to ask. Vague tasks ("explore the implications of X")
produce vague outcomes. Specific tasks ("update parser.py to use the
new error pattern across all callers; output: artifact cell with diff
and test results") produce specific outcomes.

**Explicit dependencies**: model all real dependencies as `depends_on`
edges. Hidden dependencies (tasks that conceptually need each other but
aren't linked) cause the AI to pick tasks in wrong order, producing
work that has to be redone.

**Topic tagging consistency**: use the same project + sprint topics
across all sprint cells. Lets you query the whole sprint with one
filter. A typical tag set: `topics=[sprint, <project-name>, <sprint-theme>]`,
`project=<project-name>`, `lifecycle=[active, sprint-root]` or
`[open, sprint-task]`.

**End-of-session enforcement**: install the writeback reminder hook
(see [17_ENFORCING_USAGE.md](17_ENFORCING_USAGE.md)) so the AI is
reminded to persist task state before ending each session. Without
this, mid-session crashes lose progress that wasn't written back.

**Sprint root as anchor**: always have an addressable sprint root cell
even for small sprints. It gives you a single handle to query against
when you want to see the whole sprint state.

## Anti-patterns

**Sprint with no clear goal**: if you can't write a sprint root cell
that says specifically what "done" looks like, the work isn't structured
enough to be a sprint. Either clarify the goal or treat it as
exploratory single-session work.

**Tasks without acceptance criteria**: "Explore the implications of
the new caching layer" is not a task — it's a topic. Convert to:
"Identify three specific behavioral changes the new caching layer
introduces in the hot path; write one observation cell per change
with measured before/after performance numbers and any regression
risks."

**Hidden dependencies**: if task B requires the outcome of task A but
isn't linked via `depends_on`, the AI might attempt task B before task
A is done. Always model real dependencies explicitly.

**Skipping outcome cells**: an AI that executes tasks without writing
outcome cells is doing work that doesn't persist. The next session has
no way to know what was done or build on it. Outcome cells aren't
optional — they're the substrate of cross-session continuity.

**Treating sprints as project management software**: sprints are
structured AI work, not Jira boards. The granularity, language, and
purpose are different. Resist importing PM practices that don't serve
the AI-execution model.

## Example: sprint walkthrough

Concrete example of a small sprint from setup to completion.

**Goal**: refactor a Python module to use the project's new error-handling
pattern, with tests, documentation, and a CHANGELOG entry.

**Sprint setup** (user session):

```bash
# Root
recall_helper.py --kind goal \
  --title "Sprint: refactor parser.py to new error pattern" \
  --body "Migrate src/parser.py from ad-hoc try/except to the structured ParseError hierarchy introduced in PR #142. Sprint complete when: parser.py uses new pattern, all callers updated, test suite green, CHANGELOG entry written. Estimated 4-6 task cells." \
  --confidence 0.8 \
  --topics "sprint,refactor-parser,error-pattern" \
  --project "myapp" \
  --lifecycle "active,sprint-root" --admit
# Returns cell ID: 4ae7579e-...

# Tasks
recall_helper.py --kind task \
  --title "Task 1: audit current error handling in parser.py" \
  --body "List all try/except sites in src/parser.py. For each, identify which ParseError subclass it should map to. Output: artifact cell with the audit table." \
  --topics "sprint,refactor-parser" --project "myapp" \
  --lifecycle "open,sprint-task" --confidence 0.9 \
  --depends-on "recall://cell/4ae7579e-..." --admit

recall_helper.py --kind task \
  --title "Task 2: refactor parser.py to use new pattern" \
  --body "Update parser.py based on Task 1 audit. Acceptance: all old try/except replaced with raise ParseError(...). Output: task supersedure cell pointing at the commit." \
  --topics "sprint,refactor-parser" --project "myapp" \
  --lifecycle "open,sprint-task" --confidence 0.85 \
  --depends-on "recall://cell/<task-1-id>" --admit

# ...tasks 3-5 for callers, tests, CHANGELOG...
```

**Hand-off prompt to AI**: "Sprint root at 4ae7579e. Begin executing
sprint tasks tagged `refactor-parser` in project `myapp`. Work in
dependency order. Write outcome cells. Check in at sprint completion."

**AI execution** (autonomous):

- Queries Recall: open sprint-task cells in myapp where depends_on
  targets are all done → finds Task 1
- Marks Task 1 in-progress
- Reads parser.py, audits try/except sites, writes artifact cell with
  audit table
- Marks Task 1 done, supersedure edge to audit artifact
- Queries again → Task 2 is now eligible (Task 1 is done)
- Executes Task 2: refactors parser.py per the audit
- Writes outcome cell, marks Task 2 done
- Continues through Tasks 3-5
- All tasks done → writes sprint-completion reflection cell summarizing
  what changed, links sprint root via supersedes-with-outcomes

**User check-in** at sprint completion:

```bash
# See the sprint outcomes
recall search "Sprint completion: refactor-parser" --db ~/.recall/recall.sqlite3

# Review the work
recall cell show <sprint-completion-cell-id>
```

User reviews, decides whether to merge the changes, plans the next sprint.

## Operational tips

**Daily sprint status check**: alias a one-liner that shows current
sprint state.

```bash
alias sprint-status='recall search "sprint" --db ~/.recall/recall.sqlite3 | head -20'
```

**Quick task addition mid-sprint**: if you realize a sprint needs an
additional task, add it without restarting:

```bash
recall_helper.py --kind task \
  --title "Task 6: also update docs/parser.md" \
  --body "Add example of new error pattern to docs. Acceptance: docs updated, example tested." \
  --topics "sprint,refactor-parser" --project "myapp" \
  --lifecycle "open,sprint-task" --confidence 0.9 \
  --depends-on "recall://cell/<task-2-id>" --admit
```

The next time the AI queries for open tasks, the new one appears in
the queue.

**Sprint archiving**: when a sprint completes, write a summary
reflection cell that captures lessons learned, then mark the sprint
root lifecycle as `done,archived`. Don't delete — preserve for future
queries about how similar work was done.

## Where sprints fit in the Recall architecture

Sprints aren't a Recall feature in the sense of a CLI subcommand or
schema kind. They weren't designed into Recall — they emerged from
users discovering that Recall's existing primitives compose to
support this kind of structured cross-session work. The first user
who articulated the pattern simply asked their AI to "set up a
multi-session work project," and the AI produced what we now call a
sprint because the primitives were there to support it.

This emergence is significant. Good protocol design has emergent
uses; over-specified design only does what it was explicitly built
for. The fact that sprints fall out of Recall's primitives without
anyone designing the sprint pattern in advance is evidence the
primitives were well-chosen. It also means there are probably other
useful patterns Recall's primitives support that haven't been
documented yet — users will keep discovering them.

The primitives sprints compose from:

- Cell kinds (`goal`, `task`, `decision`, `verification_result`, etc.)
  to represent sprint elements
- Lifecycle tags (`open`, `in-progress`, `done`, `blocked`,
  `abandoned`) for status tracking
- Typed relations (`depends_on`, `supersedes`, `concerns`, `supports`)
  to model task ordering, completion, blocking, evidence
- Faceted tag queries (`topics`, `project`, `lifecycle`) to find sprint
  state efficiently
- Audit trail (provenance, timestamps, confidence) for sustained-work
  accountability

Because sprints are a pattern rather than a built-in feature, you can
adapt them to your project's needs. Some teams use heavier ceremony
(sprint retrospective cells, velocity tracking, story points encoded
in confidence values). Others use lighter ceremony (sprint root +
flat task list, no dependencies). Both work. The pattern's value is
in the structured cross-session continuity it enables, not in any
specific implementation detail.

## See also

- [15_LLM_MANAGED_MEMORY.md](15_LLM_MANAGED_MEMORY.md) — the broader
  discipline of agent-managed memory that sprints sit within
- [17_ENFORCING_USAGE.md](17_ENFORCING_USAGE.md) — hooks that help
  enforce the writeback discipline sprints depend on
- [04_CONTEXT_COMPILER.md](04_CONTEXT_COMPILER.md) — how the AI
  retrieves sprint state efficiently via compile
- [14_ADDRESSABLE_CELLS_AND_GRAPH_VIEWS.md](14_ADDRESSABLE_CELLS_AND_GRAPH_VIEWS.md)
  — cell addressing that makes cross-session task references reliable
