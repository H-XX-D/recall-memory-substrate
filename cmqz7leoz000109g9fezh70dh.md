---
title: "Memory Abstraction Layer: MAL is HAL concepts applied to agentic memory systems"
datePublished: 2026-06-29T12:43:43.153Z
cuid: cmqz7leoz000109g9fezh70dh
slug: memory-abstraction-layer-mal-is-hal-concepts-applied-to-agentic-memory-systems
cover: https://cdn.hashnode.com/uploads/covers/6a338dc87bf3ea1f3591dbb9/a9470bfc-0623-4cff-84de-aa8dacb810b8.png

---

I am a mechanical engineer by trade. I build CNC robots. In that world, two things cause errors and crashes: **bad program instructions and noise**. A programmatic error comes from a bug, either in the control system or in the subprogram instructions the machine is running. Noise is electrical: EMI out of circuit coupling, current taking a path it should not because of impedance back to the source. One is a fault in what you told the machine to do. The other is the environment corrupting a signal that was clean when it left.

I have run **LinuxCNC** for years. It uses a system called **HAL**, the Hardware Abstraction Layer, to define and control the machine. HAL is how you describe every pin, signal, and component, then wire them into one running system you can read off a page.

When I started pulling AI into what I do, the biggest hurdle was not a new problem. It was the same two failure modes in different clothes. A model gives you bad instructions when its context is wrong, and it drifts when the known-good state degrades over time, which is just noise corrupting a signal that used to be clean. Keeping the model's current state accurate, and stopping the good state from rotting, was the whole fight.

So I treated it like a machine fault. I put my critical thinking, problem solving, and diagnostic troubleshooting to work on it the same way I would on a crash on the shop floor. The result is **MAL**, the Memory Abstraction Layer, the functional layer of how Recall works. It is a distillation of what I already knew, applied to AI systems and accelerated by AI to fill the gaps in my knowledge and write the harder code syntax for me.

MAL is HAL one layer up. Instead of abstracting hardware, it abstracts memory. It is not a literal port, not HAL's wiring copied onto a database pin for pin. It is the concept of how HAL works, the whole pattern of pins, signals, components, and a scheduler, applied to an AI's durable memory. HAL controls a machine. MAL controls the thing that kept breaking when I put AI on the bench: the state carried across each user and AI turn.

**Status: this is implemented as a running Recall prototype, not just an architecture sketch.** The screenshot shows the Recall panel operating against a persistent graph, and the code snippets later in this post show the four boundaries that matter: compiling a mini-index, expanding selected cells, writing claims through an admission gate, and running deterministic recomputation outside the model. The full source is not published here, so read this as a prototype disclosure rather than a reproducible benchmark.

![Recall running inside the local agent workspace, connected to a SQLite-backed graph](https://cloudmate-test.s3.us-east-1.amazonaws.com/res/hashnode/image/upload/v1782734570409/8de87209-f36a-4cfc-beac-3bf32f7bab35.png align="center")

*Recall running inside the local agent workspace. The Recall panel is connected to a SQLite-backed graph, showing 1,148 cells, 1,143 relations, active memory-in-use cards, compile/search/write controls, and a 900-word compiled memory budget. This screenshot demonstrates the working interface; the snippets below show the MAL loop underneath.*

## What it actually does, one turn at a time

MAL is a **control system**, and the thing it controls is the user-and-AI exchange. Each turn is one cycle. The per-turn protocol has five beats: **push, expand, work, write-back, tick**. A session primes once at the start, then every turn runs the cycle.

1.  **Push.** A prompt arrives. Before the model sees it, a hook pushes a mini-index: a short list of candidate cells, each shown as an id, a title, a compact score row, and any flags. Not the contents, just the headers. The lines look like this:
    

```text
67ee107d [decision] Recall v5 architecture named: MAL (Memory Abstraction Layer)
b63c2d54 [decision] MAL offloads the work: model states claim + confidence  [SUPERSEDED?]
```

2.  **Expand.** The model reads by title and pulls the full body of only the few cells worth reading; the rest stay as one-line headers. A 200-cell graph and a 200,000-cell graph cost the model the same amount here, because it only ever reads the slice it asked for. If a row carries a flag (stale, challenged, superseded), the model has to open that cell before it can act on the topic. That rule is enforced, not suggested: skip the dig and the turn is blocked until it is done.
    
3.  **Work.** The model does the real task with the expanded cells in hand.
    
4.  **Write-back.** On the way out, the model writes what it learned. Its entire authoring job is a claim (a kind, a title, a body) and one calibrated confidence number, plus the edges it intends. If the new fact corrects an old one, it points a `contradicts` edge at that old cell's id, and the old cell loses standing. The model never hand-formats the notation or computes a score. The builder and the admission firewall do that.
    
5.  **Tick.** Between turns, with no model running, a deterministic operator pass recomputes the scores, currency, salience, and the standing signals. When the next prompt arrives, the push already reflects the new state.
    

> **That is the loop.** The model states claims and judges relevance. Everything stateful, scored, or always-on happens in deterministic code around it, between turns. No op calls an LLM.

## The hooks that close the loop

The five beats are not something the model remembers to do. They fire on their own, driven by three hooks at three moments. In HAL terms, the hooks are the thread: the scheduler that runs the parts in order, every cycle, whether or not anyone is paying attention.

*   **Session start (orient).** Once per session, before any work, a hook injects the operating manual: how the memory works and what the graph is about. It is inject-only. It primes the context window and then gets out of the way.
    
*   **Prompt submit (push).** On every prompt, before the model runs its forward pass, a hook pushes the mini-index: the seed cells, their flags, and a few terse reminders. This hook has teeth. It can block, so a flag like "expand required" is not a polite request. It also nudges the model to consider standing up a recurring read as its own op during the turn, before write-back.
    
*   **Stop (write-back and backstop).** After the answer, a third hook handles the end of the turn. It is the wrong place to prime anything, because the pass is already done, so its job is the opposite: make sure the turn wrote back what it learned, and refuse to release the turn if a flagged cell was never opened.
    

Between turns, with no model in the loop at all, the deterministic tick runs the ops and recomputes the signals. Orient before the session, push before the pass, write-back after it, tick between turns. That is the whole schedule, and the model only occupies the middle of it.

One rule keeps the hooks lean. The expensive, stable content (what every op means, how the addressing works) is taught once, in a single map cell inside the graph. The per-turn push never re-explains any of it. It only points, carrying the cheap, changing part: which cells are in play this turn and which ones are flagged. Teach once in the graph, reference tersely every turn. It is the same split as keeping the operating manual as cells instead of as a string baked into a hook.

## The concept, mapped from HAL to memory

The reason HAL was the right thing to copy is that its parts already have clean jobs, and every one of them has a memory counterpart. This is the correspondence, not a literal rewrite:

| HAL | MAL |
| --- | --- |
| pin | a cell field |
| signal | an addressable value (a derived field has one owning op, for tick determinism) |
| component | an op (watch, watchdog, trend, drift, quorum, score, reflex, smooth, clamp, latch, route, fanout, snapshot, record, replay, pid, oneshot) |
| thread | the operator tick, running between turns |
| net (the wire) | the dotted address |
| netlist (the .hal file) | the memory netlist |

In HAL you wire components to signals on a thread and you get a machine you can read off one file. In MAL you wire ops to values on the tick and you get a memory you can read off one netlist. The structure carried over. What changed is what flows through it.

## Why a control layer is the right shape

The analogy is not decoration. It holds because the two problems are the same problem.

A control system exists to keep a process in a known-good state against two enemies: bad commands and noise. On the machine, a bad command is a buggy instruction in the program, and noise is EMI corrupting a signal that left clean. The whole job of HAL is to make the machine legible enough that you can see both coming: every signal named, every connection on the page, a scheduler keeping the readings current.

Memory degradation in an AI is the same two enemies under different names. A bad command is a wrong or stale fact entering the model's context. Noise is drift: the known-good state decaying as new, weaker, or contradictory claims pile up over time. Left alone, both corrupt the state the model acts on, the same way they corrupt a machine. So the fix has the same shape: name every value, keep the wiring legible, reconcile conflicting inputs into one trustworthy reading, catch the bad state and replace it on the record, and run a scheduler that keeps the picture current between moves.

That is why a hardware abstraction layer, of all things, was the right pattern to lift. Not because memory is like hardware, but because keeping memory accurate is a control problem, and HAL is a control-system design that already solved the legibility and scheduling parts. MAL is that design pointed at the state of the user-AI exchange instead of at motors.

## Where MAL leaves HAL behind

A concept is only worth borrowing if you are honest about where it stops fitting. Three places MAL departs from HAL, and they are the interesting part.

**Many writers, one reader.** This is the inversion, and it is the heart of it. HAL is one writer, many readers: one pin drives a signal, many components read it, and the value is whatever the writer put there. MAL is the opposite. Many actors write to a cell over time, claims, edges, supersessions, from different agents and different sessions, and there is one reader: the single agent reading the compiled slice this turn. Because the writers are many and fallible, the value a cell shows is not any one writer's number. It is a reconciliation. This is why a cell has both a stated confidence and an effective confidence, and why they differ: stated is what a writer claimed, effective is what survives calibration, support, and contradiction once everyone's contributions are weighed.

**The edges are real and directional.** HAL draws arrows on its signals but ignores them, because in hardware the direction of flow is already implied by who writes and who reads. MAL edges carry meaning, so direction is load-bearing. `a > b` is the directed edge from a to b; `a < b` is from b to a. A `supports` edge and a `contradicts` edge pointing the same direction do very different things to the effective value downstream.

**Versions and supersession.** HAL is a flat wiring layer with no history. MAL has a time axis: a cell can be superseded, and the supersede chain is addressable by version (`@vN`). A correction does not overwrite the old value; it demotes it and records the replacement, so a later reader sees both the current fact and the one it replaced, plus why. That is the whole defense against the known-good state quietly rotting: nothing good gets silently overwritten, it gets superseded on the record.

Put together, these are why MAL is a control system and not just storage. It does not only hold the state of the user-AI exchange; it reconciles many fallible inputs into one trustworthy reading, keeps direction and history, and recomputes the picture every tick.

## The notation

Because the rendered graph is meant to be read by sight, MAL has its own small language, modeled on HAL's. It has a lexicon (the words) and a grammar (the sentences).

### The lexicon

*   **Handle:** `kind_hex`, a three-letter kind prefix and a short hex tag, like `dec_a3ee` for a decision. ALLCAPS marks an immutable cell (`RECALL_v5`); lowercase is mutable.
    
*   **Separators, by how tightly they bind:** `_` joins words inside one name; `-` walks a field within a cell (`dec_a3ee-scores-eff`); `.` crosses an edge to a neighbor (`dec_a3ee.supports`), so the number of periods is the number of graph hops.
    
*   **Values:** written `field(value)`. A `!` inside marks an immutable number (`conf(.7!)`); bare is mutable. Types are float for scores and bit for actuators.
    
*   **Version:** `@vN` is a point on the supersede chain. **Wildcard:** `.*` fans out over every neighbor through an edge (`dec_a3ee.supports.*`).
    
*   **Expand-required:** a leading `^` in the mini-index means the cell is superseded, stale, or challenged, and the model must expand it before use (`^dec_a3ee ...`). That caret is the dig flag from the loop above, written in one character.
    

### The grammar

The sentences follow HAL's `halcmd` style. Tokens are separated by a single space, the name comes first, and connections follow. A quoted `"..."` string is one token, exempt from the space rule, used for free text like a title or body. A `#` runs to end of line as a comment. Direction with `<` and `>` is meaningful.

The sentence forms:

| form | shape | example |
| --- | --- | --- |
| wire (net) | `net <signal> <target> <inputs>...` | `net eff dec_a3ee < conf calib supports.* contradicts.*` |
| set (setp) | `<addr> = <value>` | `dec_a3ee-flags-annexed = true` |
| schedule (addf) | `addf <op> tick` | `addf contradiction-load tick` |
| edge | `<source> <relation>> <target> (<weight>)` | `dec_a3ee supports> dec_signals_a2b7 (+.6)` |
| render (read) | `<handle> "<title>" <field(value)>... <relation>-><target>(<w>)...` | see below |

### A netlist snippet

Here is one cell rendered in read form, then wired and scheduled in write form:

```text
# a cell, rendered: handle, title, scores, then edges
dec_a3ee "add watchdog op" conf(.7!) unc(.10) eff(.61) curr(.9) sal(.5) annexed(0) pinned(0)
  supports> dec_signals_a2b7(+.6)  contradicts> obs_9c1f(-.8)

# wire the effective-confidence signal on it (write form)
net eff dec_a3ee < conf calib supports.* contradicts.*

# declare an edge (direction: > forward a to b, < reverse)
dec_a3ee supports> dec_signals_a2b7 (+.6)

# fire an actuator
dec_a3ee-flags-annexed = true

# schedule a between-turn signal onto the tick
addf contradiction-load tick
```

Read the top line and the many-writers-one-reader idea becomes concrete. `conf(.7!)` is the stated confidence, immutable, what the author claimed. `eff(.61)` is the effective confidence, mutable, what is left after calibration plus the `+.6` support and the `-.8` contradiction are reconciled. The reader gets `.61`, not `.7`. The `net eff` line is the wiring that produces it: the effective signal is a function of the stated confidence, the writer's calibration, and the fan-out over every supporting and contradicting edge.

### What the language does not do

The grammar wires ops; it does not define their math. The formulas (the effective-confidence reconciliation, the per-type currency decay, the allocation-pressure math) live inside the ops, the way a HAL component's math lives in compiled C and not in the `.hal` file. The language only connects pre-built ops to values and to the tick. The one op you can configure without code is the reflex, set with a truth-table personality rather than a formula, so even user-defined boolean logic needs no expression language. That keeps the surface small on purpose.

**Status of the language.** Be clear about what runs. The graph renders to this notation today, but one direction only: graph to text. A parser and loader that read a netlist back into a wired graph are specified here and not yet written. That reader is the next piece, and its acceptance test is a round trip: render the graph, parse it, load it, render again, and require the two renders to match. The model never reads the netlist either way; it reads the compiled slice. The netlist is for human audit and for tooling such as replay, diff, and version control.

## Borrowing the next layer: components

Everything so far buys one thing: a durable, structured state with a gate on what gets in, where admission has the same shape no matter who wrote it. Every claim, from any actor, any agent, any session, goes through the one firewall and comes out in the one contract. That uniformity is not a nicety. It is the precondition for the next borrow from HAL.

Here is why. In HAL, a component can read a signal without knowing or caring which component drives it, because every signal is a typed value with one shape. That is the only reason you can wire a deterministic component to a wire and trust what it reads. MAL gets the same guarantee from the admission gate: many writers, one shape. Once a value is guaranteed to have that shape regardless of author, a deterministic subprogram can wire to it and run on it safely. The gate is what turns a pile of claims into clean signals.

So you can take the second layer of HAL, the components. In HAL a component is a small compiled subprogram that reads signals, computes something, and drives other signals, all scheduled on the thread. In MAL a component is the same idea over memory: a small deterministic program that reads cell values, computes something more involved than a single score, and either writes a derived value back or fires an actuator, scheduled on the tick between turns. No model runs inside one, the same way no model runs inside any op.

The ones I wired up are the controls-room set: a watch that trips on a threshold, a trend that takes the rate and acceleration over a series of cells, a drift that measures a value against a pinned baseline, a quorum that fires on k-of-m agreement, a score that rolls a metric. The boolean logic is one configurable component, a reflex, that covers the whole and2, or2, xor2 family with a truth table instead of a formula. That is what lets you connect them the way you connect logic on a machine: wire two watches through an or2 so the alert trips if either condition goes bad, latch it so it stays tripped across turns, fan it out to a severity readout. A **tripwire** is that composition given a job: a deterministic condition that stays silent until it trips, so silence itself becomes the all-good signal, and the only thing that ever speaks up is a real change.

This is where the memory stops being a place you read from and starts being a system that watches itself. The components run between turns whether or not anyone asked. A threshold passes, a webhook fires, and a decision that drifted out of its known-good band tells you on its own.

> HAL gives a machine reflexes that do not wait for the operator. The same components, one layer up, give the memory reflexes that do not wait for the model.

## It is not rebuilt every turn

A fair worry about a stateless model is that it has to stand the whole apparatus up again on every fresh turn. It does not. The system persists in the store and in the deterministic tick, both of which run between turns with no model involved. The only thing that is fresh each turn is the model's working context, and rebuilding that context is exactly the cost MAL removes. Instead of re-deriving state from scratch or re-reading raw transcripts, the model reads back a thin, pre-digested, trust-weighted slice: the mini-index first, then selective expansion. And because the model wrote those cells in the first place, reading them re-evokes its earlier reasoning instead of reconstructing it cold.

## The graph boots itself

A fresh MAL graph starts from a deterministic 10-cell bootstrap, then the normal loop takes over and init never fires again for that graph.

Cells 1 to 5 are the system layer, the constitution: auto-written, locked, pinned, immutable, and identical in every graph.

1.  purpose
    
2.  method
    
3.  map (the MAL structure itself: addressing, cell anatomy, edge semantics)
    
4.  hooks (the lifecycle: orient, push, write-back, tick, the compaction boundary)
    
5.  expectations (the behavioral contract: wire your edges, pick the right kind, supersede on real change, confidence is recorded and weighed, do not assert from unchecked memory, dig flagged cells)
    

Cells 6 to 10 are the foundation, the project charter: answered one question at a time by the user, and mutable.

6.  objective
    
7.  constraints
    
8.  risks
    
9.  success criteria
    
10.  carried context
     

Putting the operating manual in the graph as cells, rather than as a string baked into a hook, is what lets it survive a context compaction and be re-evoked afterward. The map being cell 3 is the point: the structure teaches itself from inside the store it describes.

## How it came together

Two things had to meet for this to work, and they came from opposite directions.

The first was the problem, seen from the inside. Recall was not built as a database for me to query. It was built for the agent. It started by asking the model what it actually needed in order to remember well and to trust what it remembered, and the answers are the whole design: typed claims with a calibrated confidence, supersession instead of overwrite, and a record of what contradicts what. Earlier versions were far more ambitious and sprawling; the part that survived and narrowed into Recall was the memory core. Most pull-based memory tools inherited the human metaphor of a database you go and search. This came from asking the thing that has to live in the memory what would keep it honest.

The second was the structure, brought in from another trade. I already knew HAL cold from years on LinuxCNC, and when I sketched how to address and wire a memory graph, it landed on the same path-addressing shape HAL uses. Recalling HAL from the shop and deriving the addressing for memory met in the same place. Two independent routes arriving at one design is about the strongest signal you get that the design is sound.

After that it was diagnostic work plus acceleration. I used the troubleshooting habits I lean on for a machine crash to find where the memory state was breaking, and I used AI to fill the gaps in what I did not know and to write the harder code syntax. The concept is mine and comes off the shop floor. The speed of building it came from the same kind of system it was built to improve.

## Under the hood: the four boundaries

This part is a prototype disclosure, not a reproducible benchmark. The snippets below are from the running Recall v5 source, trimmed for readability with elisions marked; the formulas and signatures are verbatim. They show the four boundaries where the design either holds or it does not: Recall sits upstream of the model, the read is a mini-index then a selective expand, every write goes through one gate, and the scores recompute deterministically with no model in the loop.

**Recall is upstream of the model.** Before the model runs, the prompt's objective is compiled into a Recall packet and merged into the text the model receives. The packet is built first, so the model sees reconciled memory before it acts.

```ts
export function buildPromptContextPush(
  store: Store,
  objective: string,
  options: ContextCompileOptions & DirectiveOptions = {},
): PromptContextPush {
  const packet = compileContext(store, objective, options);
  const directive = recallDirectiveBlock(options);
  const expansionRequired =
    packet.staleOrLowTrust.length > 0 || packet.conflicts.length > 0;
  const text = [
    "[Recall context push for this prompt]",
    directive.trimEnd(),
    "",
    formatContextPacket(packet),
    expansionRequired
      ? "EXPAND REQUIRED: conflicts or low-trust cells are present; inspect relevant handles before relying on them."
      : "Use expansion_handles only when exact evidence matters.",
    "",
  ].join("\n");
  return { objective, directive, packet, text, expansionRequired };
}
```

The Codex adapter wires Recall's MCP server into Codex so the same packet and tools are reachable there; the push itself is platform-neutral.

**1\. Compile the mini-index.** The prompt becomes a ranked seed set, one mini-index line per hit, and a cell that needs review carries the expand flag. `compileContext` wraps this and trims the packet to a word budget (the 900 in the screenshot).

```ts
export function compile(
  store: Store,
  query: string,
  opts: { limit?: number } = {},
): CompileResult {
  const limit = opts.limit ?? 10;
  const hits = store.search(query, { limit });
  const lines = hits.map((h) =>
    renderMiniIndexLine(h.cell, { expand: h.cell.flags.requiresReview }),
  );
  return { hits, lines };
}
```

**2\. Expand selected cells.** Mini-index first, selective expansion second. A handle (a full id, or `id#field.path`) opens exactly one cell plus its neighbor links, never the whole graph.

```ts
export function inspectCell(store: Store, handle: string): CellContext {
  const parsed = parseExpansionHandle(handle);
  const cell = store.get(parsed.target) ?? store.getByHandle(parsed.target);
  if (!cell) throw new Error(`Unknown cell: ${parsed.target}`);
  const neighbors = store.neighbors(cell.key);
  const incoming = neighbors.filter((link) => link.direction === "in");
  const outgoing = neighbors.filter((link) => link.direction === "out");
  // ... footprint (word and byte counts), optional field preview ...
  return { cell, incoming, outgoing, /* footprint, */ expansionHandles };
}
```

**3\. Write through the admission gate.** The model hands in a claim (a kind, a title, a body), one confidence number, and the edges it intends. Every author runs the same pipeline: validate, screen for secrets, attenuate unsupported confidence, build the cell, then fold in the actor's calibration to get effective confidence. The model never formats the cell or computes a score.

```ts
export interface WriteProposal {
  kind: string;
  title: string;
  body: string;
  confidence: number; // (0, 1], required, no default
  edges?: { relation: string; target: string; weight?: number }[];
  // ... topics, entities, sourceRefs, operation, origin, verification ...
}

export function admit(proposal: WriteProposal, ctx: AdmitContext = {}): AdmissionResult {
  const validation = validateProposal(proposal);   // R0 schema; reject on any structural issue
  if (!validation.ok) return { accepted: false, issues: validation.issues, warnings: [], attenuations: [] };

  const screen = screenSecrets(proposal);           // reject if a credential pattern is present
  if (!screen.allowed) return { accepted: false, issues: screen.issues, warnings: [], attenuations: [] };

  const factor = ctx.calibrationFactor ?? 1;         // 0.5..1 from the actor's track record; 1 = neutral
  const att = attenuateConfidence(proposal);         // cap unsupported high confidence
  const cell = buildCell({ ...proposal, confidence: att.confidence }, { key: ctx.key, now: ctx.now });

  cell.scores.actorCalibration = factor;
  cell.scores.effective = effectiveConfidence({
    stated: att.confidence, calibration: factor, supportMass: 0, challengeMass: 0,
  });
  // with a store: dedup, apply supersedes edges, recompute neighbors' effective ...
  return { accepted: true, cell, issues: [], warnings: att.warnings, attenuations: att.attenuations };
}
```

**4\. Recompute on the tick, with no model.** This is the line between MAL and a plain memory database. Between turns, every active cell decays its currency from its own timestamp and recomputes its effective confidence from current support and contradiction mass. Pinned cells are exempt from decay, and a tick never counts as reinforcement.

```ts
// effective = clamp01(stated*calibration + 0.15*tanh(support) - 0.6*tanh(challenge))
export function effectiveConfidence({ stated, calibration, supportMass, challengeMass }) {
  return clamp01(
    stated * calibration + 0.15 * Math.tanh(supportMass) - 0.6 * Math.tanh(challengeMass),
  );
}

// currency = cFloor + (c0 - cFloor) * exp(-dt/tau)   (dt and tau in days)
export function currency({ c0, dt, tau, cFloor = 0.1 }) {
  return cFloor + (c0 - cFloor) * Math.exp(-dt / tau);
}

// the between-turn deterministic tick (HAL's "thread"); no LLM runs here
function recompute(store: Store, cell: Cell, now: string): Cell {
  const scores = { ...cell.scores };
  if (!cell.flags.pinned) {
    const dt = Math.max(0, (Date.parse(now) - Date.parse(cell.updatedAt)) / DAY_MS);
    scores.currency = currency({ c0: cell.scores.currencyC0, dt, tau: TAU_DAYS[cell.stability] });
  }
  const m = neighborMass(store, cell.key);
  scores.effective = effectiveConfidence({
    stated: cell.scores.conf, calibration: cell.scores.actorCalibration,
    supportMass: m.supportMass, challengeMass: m.challengeMass,
  });
  return { ...cell, scores }; // updatedAt preserved: a tick is not a reinforcement
}
```

**The verifier.** A functional verifier, `npm run verify:recall-panel`, was added for the Recall panel and passes. It checks that the panel is correctly wired to the graph (the SQLite-backed store and the compile, search, and write controls), not that it clears any performance number. Read it as a wiring check, not a benchmark.

## Recall, MAL, and AIDE

A quick map of the three names, because they get used together and they are not the same thing.

**Recall is the programming foundation.** At the bottom is a local-first memory substrate: a SQLite-backed graph of typed cells, an admission gate every write passes through, calibrated confidence, supersession instead of overwrite, and a compile path that returns a ranked, budgeted slice. That layer ships as a package and runs today. It is the working base everything else stands on, and it is what the four boundaries above are made of.

**MAL is what that foundation evolves into.** v5 recasts the same primitives as a hardware abstraction layer for memory: a cell field is a pin, an addressable value is a signal, an op is a component, the between-turn tick is the thread, and the rendered graph is a netlist. On top of the proven store it adds the deterministic op and signal layer and the addressing language. The four boundaries earlier in this post are MAL running. The netlist language is MAL specified, with the reader still to come.

**AIDE is where it runs.** The screenshot at the top is AIDE, an agent workspace with Recall embedded as a panel. The agent compiles, searches, and writes the same SQLite graph from inside the editor, against a live cell count and a word budget, so the memory layer is not a side service the agent calls out to; it sits in the workspace the agent already works in. MAL is the layer that panel stands on.

So Recall is the substrate, MAL is the abstraction layer it grows into, and AIDE is the workspace that puts both in front of a working agent.

## Why this shape holds up

Two things make MAL age well. It rides capability gains for free: a stronger model uses the same layer better with no rewrite, and a weaker model still gets the deterministic floor underneath it. And it keeps the expensive, stateful, always-on work in deterministic code where it belongs, leaving the model to do the one thing only it can do, which is to state a calibrated claim and judge relevance.

That is the whole bet, and it comes straight off the shop floor. A machine does not stay accurate because the controller is smart. It stays accurate because the wiring is legible, the signals are reconciled, the bad state gets caught and replaced instead of silently riding along, and a scheduler keeps the picture current between every move.

> MAL is that discipline, applied to an AI's memory. HAL one layer up, over memory instead of motors.

if you want to try Recall it is standalone and OSS [https://github.com/H-XX-D/recall-memory-substrate](https://github.com/H-XX-D/recall-memory-substrate)

The AIDDE (Artificial Intelligence Driven Development Environment)is a Codex Claude SDK native bring your subscription development environment that shifts the old IDE with AI chat to a High level view cockpit where you specify design, direct intent, monitor changes, audit actions control permissions and access in real time across a codebase. Beta is done and if your interested ask in the comments for a link to the Alpha