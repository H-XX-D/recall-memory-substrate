# 10 · SENTINEL: the Unprompted-Contradiction Benchmark

**Thesis.** Every shipping memory benchmark (LoCoMo, LongMemEval, …) tests
*read accuracy*: given history, answer a query. They are **pull** tests, and the
systems built for them (Mem0, Zep, Letta, LangMem) are pull architectures:
information flows only in response to a question.

SENTINEL is a **push** test. It measures whether a memory system, as new
information arrives over time, **autonomously surfaces that a newly-stored fact
invalidates a previously-held belief, without being asked**. That is the
reliability-floor-over-time capability: a model-independent invariant, not
model-dependent navigation.

Harness: `scripts/sentinel-bench.mjs` (`npm run bench:sentinel`).

## Why the incumbents don't compete (structural, not rigged)

A pull system has no place to emit a signal nobody queried for. To score on
SENTINEL at all, a system needs a **write-time evaluation hook** that runs on
admission and can re-price/flag prior beliefs. Recall has this natively (reflex
programs `watch`/`drift`/`score` + contradiction-on-admission + effective-
confidence demotion). Mem0/Zep/Letta do not, so they score **0 by construction**,
not because they're weak, but because the capability is outside their shape.

**Fairness guardrails (so it isn't a strawman):**
1. The capability is *independently valuable*: silently serving a stale fact is
   a top production failure mode; users need to be told "the thing you believed
   changed" without re-auditing.
2. Anyone can compete by bolting on a hook. SENTINEL provides the **fair bolt-on
   baseline**: re-query every prior belief after each write. It can score, at
   **O(beliefs × writes)** cost. Detection *and* cost are reported, so
   "native vs bolted-on" is an honest axis.
3. **Precision is scored**: a system that flags everything is useless and loses.

## Task & metrics

Input: a chronologically-ordered stream of claims for one subject. A subset are
**contradictors** (a value-flip of an earlier belief); the rest are
**distractors** (reinforcements of the same value, or unrelated facts). No
questions are asked. After each event the system may surface contradiction
flags; SENTINEL reads only what it surfaces unprompted.

- **Detection recall**: flagged contradictions / total contradictions
- **Precision**: true flags / all flags (distractors must not fire)
- **Latency**: events between a contradictor's arrival and its flag
- **Surfacing cost**: native (standing program, O(writes)) vs pull bolt-on
  (O(writes × beliefs)); never collapsed into the capability score

## Difficulty ladder (floor → floor+ceiling)

- **L1: explicit value-flip** ("Chicago" → "Denver"). Pure floor; deterministic
  detection, no model. *(Implemented.)*
- **L2: entailed contradiction** ("allergic to penicillin" → "took amoxicillin,
  felt fine"). Light inference; the model re-enters. *(Implemented.)*
- **L3: transitive / holonomy** (A>B, B>C, C>A, pairwise plausible, globally
  impossible). Global-consistency detection: the substrate refuses to admit a
  cyclic ordering overlay (`addDagOverlay` rejects it at write time). No
  incumbent has this primitive. *(Implemented.)*
- **L4: stale-by-implicit-expiry** ("training for the June marathon" → stale in
  July). Time-aware staleness. *(Implemented.)*

## L1 results (deterministic, zero-budget)

24 synthetic streams (12 with one value-flip, 12 distractor-only), isolated
store per stream. A deterministic value-flip detector links the contradictor on
admission → the belief's effective confidence collapses (0.7 → ~0.14) → a
standing `watch` program trips on the next tick, surfacing it unprompted.

| metric | result |
|---|---|
| detection recall | **100%** (12/12) |
| precision | **100%** (0 false trips) |
| median latency | **0 ticks** |
| cost | native O(writes); pull bolt-on O(writes × beliefs) = 24× here |

**Honest scope.** L1 *linking* uses a deterministic value-flip detector; general
semantic contradiction (L2+) needs an LLM/Checker extraction step at ingest. The
Recall-unique, model-free part is the *unprompted surfacing* (the standing
program), which is why the push-axis claim holds regardless of detector
sophistication.

## L3 results (transitive / holonomy, deterministic, zero-budget)

24 triples (12 inconsistent A>B,B>C,C>A; 12 consistent A>B,B>C,A>C). Each
ordering is admitted as a fact, then folded into a DAG overlay. The closing edge
that would complete a cycle is rejected by `addDagOverlay` at write time; the
consistent triples admit cleanly.

| metric | result |
|---|---|
| detection recall | **100%** (12/12 cyclic orderings rejected) |
| precision | **100%** (0 false rejections of consistent orderings) |
| latency | caught on the closing edge; pairwise checks never see it |

This is the global-consistency guarantee no pull memory system has: each edge is
individually plausible, so storing facts and answering queries can never surface
the contradiction; only a substrate that materializes the ordering and checks it
for cycles catches A>B>C>A.

## L2 results (entailed contradiction, floor + ceiling)

12 cases (6 true entailment-contradictions, 6 superficially-similar distractors:
amoxicillin vs ibuprofen, lives-in vs visited, spent-$1500 vs $800). Detection is
reported separately from surfacing, because L2's whole point is that detection
needs the *ceiling*:

| competency | result |
|---|---|
| literal baseline (L1-style) detection | recall **0%**: cannot see entailments (different words) |
| entailment detector (KB stand-in for LLM/Checker) | recall **100%**, precision **100%** |
| unprompted surfacing (floor, given links) | recall **100%** (6/6), 0 false trips |

The literal-vs-entailment contrast is the result: a value-flip detector scores 0
here, so L2 genuinely requires a model/Checker to *detect* the contradiction,
but once linked, the *surfacing* is the same model-free standing-program
mechanism as L1. The KB is a deterministic stand-in for the LLM/Checker;
independent judgment by a strong model agrees with all 12 gold labels, though at
scale on adversarial data a real model is high-but-imperfect (NLI-level). The
floor is unaffected by detector imperfection: it surfaces exactly what it's told.

## L4 results (stale-by-implicit-expiry, floor + ceiling)

8 beliefs (4 expired by NOW=2023-07-15, 4 timeless-or-future). The ceiling
extracts an implicit expiry from the text ("June marathon" → 2023-06-30) into
`policy.expires_at`; the floor (`analyzeMemory`) surfaces the belief as `expired`
when `now` passes it, unprompted (the maintenance/daemon loop). Contrasted with
a naive age baseline (flag if older than 30 days):

| detector | recall | precision |
|---|---|---|
| naive age baseline | 75% | 50% |
| expiry-aware (ceiling extract + floor) | **100%** | **100%** |

The age baseline fails *both* ways: it **misses** a recent-but-expired belief
(June marathon written June 28, stale by July 2) and **false-flags** timeless-but-
old ones ("is vegetarian", "lives in Paris") and future-dated ones (annual plan
through December). Time-aware staleness is not age: the ceiling does the temporal
extraction, the floor does the `expires_at <= now` comparison deterministically.
Pull memory systems have no staleness model: they return the stale belief on
query as if it were current.

## Summary: the four axes

| level | axis | mechanism | pull-system score |
|---|---|---|---|
| L1 | unprompted value-flip | standing `watch` program | 0 (no standing program) |
| L2 | entailed contradiction | model detects → program surfaces | 0 (no push surface) |
| L3 | transitive / holonomy | write-time cyclic-overlay rejection | 0 (no consistency check) |
| L4 | stale-by-implicit-expiry | `expires_at` + `analyzeMemory` | 0 (no staleness model) |

L1/L3 are pure floor (deterministic detection + surfacing); L2/L4 are
floor+ceiling (a model detects the semantic/temporal trigger, the model-free
floor surfaces it). Every axis is a write-time/standing capability the
pull-architecture incumbents lack by construction.

## Sibling axes (same "they lack the primitive" logic)
- **Trust discrimination**: does per-actor Brier calibration down-weight
  systematically-unreliable sources?
- **Belief-revision audit**: "what did you believe X was at t2, and what changed
  it?" (supersede chains + rollback journal)
- **Poisoned-memory quarantine**: does admission + contradiction + trust isolate
  an injected false fact?
