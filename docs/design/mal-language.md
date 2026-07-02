# MAL: the Memory Abstraction Layer, system and language

Date: 2026-06-23
Status: DECIDED

MAL is HAL (LinuxCNC's Hardware Abstraction Layer) one layer up, over a memory
graph instead of hardware. This doc is the system overview plus the language:
the lexicon (the words) and the grammar (the sentences).

## 1. The system

| HAL | MAL |
|-----|-----|
| pin | a cell field |
| signal | an addressable value; a derived field has one owning op (tick determinism) |
| component | an op (watch / watchdog / trend / drift / quorum / score / reflex / smooth / clamp / latch / route / fanout / snapshot / record / replay / pid / oneshot) |
| thread | the operator tick (between turns) |
| net (the wire) | the dotted address |
| netlist (the .hal file) | the memory netlist |

Trust premise: MANY WRITERS, ONE READER. Many actors write claims/edges/supersessions
to a cell; the calibration + effective math reconcile them for the one agent reading
the compiled slice. (This is the inverse of HAL's one-writer-many-readers, and it is
why effective != stated: the value is the reconciliation of many fallible writers.)
A derived field is still single-op-owned, but only for tick determinism; its inputs
are the many writers' contributions.

Deterministic: every op is pure math, no LLM. The model only states a claim + a
calibrated confidence + the edges it intends; MAL computes scores, currency,
salience, and the 34 between-turn signals on the tick. The model reads back a lean
slice (mini-index then expand). Per-turn protocol: PUSH, EXPAND, WORK, WRITE-BACK,
TICK (START primes once per session).

## 2. The lexicon (the words)

- Handle: `kind_hex` (snake_case 3-letter kind prefix + short hex), e.g. `dec_a3ee`.
  CAPS = an IMMUTABLE cell (`RECALL_v5`); lowercase = mutable.
- Separators by binding tightness: `_` joins words in one name; `-` walks a field
  within a cell (`dec_a3ee-scores-eff`); `.` crosses an edge to a neighbor
  (`dec_a3ee.supports`), so periods count graph hops.
- Values: `field(value)`. `!` inside marks an IMMUTABLE number (`conf(.7!)`); bare
  is mutable. Types: float (scores), bit (actuators).
- Version: `@vN` (a point on the supersede chain). Wildcard: `.*` fans out over all
  neighbors via an edge (`dec_a3ee.supports.*`).
- `^` (leading) = EXPAND REQUIRED in the mini-index: the cell is
  superseded/stale/challenged, the model must expand it before use (`^dec_a3ee ...`).

## 3. The grammar (the sentences)

Modeled on HAL's `halcmd` syntax.

THE RULE: tokens are separated by a single SPACE; the signal/name comes FIRST;
connections follow. Direction uses `<` / `>` and is MEANINGFUL: `a > b` is the
directed edge a->b (a DAG connection), `a < b` is b->a. (This is where MAL departs
from HAL: HAL ignores its arrows because dataflow direction is implicit in
writer/reader; MAL edges are semantic and directional, so direction is real.)

EXCEPTION: a `"..."` quoted string is ONE token, exempt from space-separation. It
may contain spaces, commas, anything, used for free text (titles, body).

COMMENT: `#` to end of line.

Sentence forms:

| form | shape | example |
|------|-------|---------|
| wire (net) | `net <signal> <target> <input> ...` | `net eff dec_a3ee < conf calib supports.* contradicts.*` |
| set (setp) | `<addr> = <value>` (or `setp <addr> <value>`) | `dec_a3ee-flags-annexed = true` |
| schedule (addf) | `addf <op> tick` | `addf contradiction-load tick` |
| edge | `<source> <relation>> <target> (<weight>)` (`>` fwd, `<` rev) | `dec_a3ee supports> dec_signals_a2b7 (+.6)` |
| render (read) | `<handle> "<title>" <field(value)>... <relation>-><target>(<w>)...` | see below |

Conditions and thresholds are op PARAMETERS, not syntax: set them with `setp`
(`setp watch.thresh 0.6`), exactly as HAL sets a component's parameter.

## 4. Worked example (a netlist snippet)

```
# a cell, rendered (read form): handle, title, scores, then edges
dec_a3ee "add watchdog op" conf(.7!) unc(.10) eff(.61) curr(.9) sal(.5) annexed(0) pinned(0)
  supports> dec_signals_a2b7(+.6)  contradicts> obs_9c1f(-.8)

# wire the effective-confidence signal on it (write form)
net eff dec_a3ee < conf calib supports.* contradicts.*

# declare an edge (direction: > forward a->b, < reverse)
dec_a3ee supports> dec_signals_a2b7 (+.6)

# fire an actuator
dec_a3ee-flags-annexed = true

# schedule a between-turn signal onto the tick
addf contradiction-load tick
```

## 5. The boundary (what the language does NOT do)

The language WIRES ops; it does not DEFINE their math. The formulas (`eff =
clamp01(stated*calib + support - challenge)`, the per-type currency decay, the
allocation pressure formula) live INSIDE the ops, like a HAL component's math lives
in compiled C, not in the `.hal` file. The grammar only connects pre-built ops.

The single op configurable without code is `reflex`/`lut5`: a user sets its
behavior with a personality (`setp reflex.personality 0x...`), a truth table, not a
formula. So user-configurable boolean logic needs no expression language.

[DEFERRED] an inline-formula form (HAL's separate `comp` tool equivalent) for
defining new op math in the language. Not needed for v0: the fixed op palette plus
the configurable reflex cover the cases.

## See also
- `docs/PLAN.md` (Items 4, 9, 10)
- `docs/design/cell-anatomy.md`, `write-time-scores.md`, `signals-catalog.md`
