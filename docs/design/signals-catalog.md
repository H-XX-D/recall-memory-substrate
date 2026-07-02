# Recall v5 / MAL: between-turn signals catalog

Date: 2026-06-23
Status: DECIDED (Item 8). 30 per-cell signals + 5 meta-signals.

A signal is a cheap, deterministic metric the operator computes between turns from
cell scores + signed edges, wired from the op palette, that drives a between-turn
action. No LLM, one or two hops, single-writer.

Tag on each: **[silent]** acts only between turns (re-rank / demote / annex / pin /
reinforce / gate) and never enters the model's context; **[surfaced]** raises a
compact flag the model sees next turn. Keeping most signals silent is what holds
the compiled packet lean (see the model-load decision).

---

## Evidence axis

- **contradiction-load-ratio** [high, silent] — signed pressure `S_neg/(S_neg+S_pos)` in [0,1]; >0.6 = held up mostly by what fights it. Wiring: score the signed masses, clamp, smooth(EMA .3), watch(>.6). Acts: demote eff by (1-ratio), annex to a "disputed" shelf so it never surfaces alone.
- **contradiction-acceleration (flip-imminent)** [high, surfaced] — 2nd finite-diff of incoming contradicts count; distinguishes a collapsing claim from a settled dispute. Wiring: record(4)+trend+trend, clamp, watch(accel>=+2). Acts: pre-emptively gate it from being cited as a premise, queue for adjudication.
- **effective-momentum (signed eff slope)** [high, silent] — `EMA(eff_t - eff_{t-1})`, keeps sign vs the unsigned volatility. Wiring: record+trend+smooth+clamp. Acts: rising → reinforce salience; falling → demote, annotate "eroding".
- **confabulation-volatility-spike** [high, silent] — large |Deff| while the edge set is unchanged = a value moving with no evidence. Wiring: trend(eff) + drift(edge-set hash) + reflex AND. Acts: freeze eff at pre-jump value (clamp slew 0), flag for review, block propagation.
- **corroboration-independence-index** [high, surfaced] — effective number of INDEPENDENT supporters (provenance roots, overlap-discounted); 10 restatements of one source ~ 1. Wiring: fanout supports → derived_from roots, score with 1/(1+overlap), watch(<2). Acts: cap support mass at independent count, tag "single-source echo", seek an independent source.
- **checkpoint-freshness** [medium, surfaced] — `cp_eff * e^(-age/tau)`, zeroed if contradicted after verification. Wiring: snapshot(cp_time) + watchdog + watch(contradicts after cp). Acts: downgrade done→needs-review, stop counting toward burn-down.

## Structural axis

- **isolation-vs-anchor** [high, surfaced] — high-conf cell with ~0 signed degree = an orphan/unfalsifiable assertion. Wiring: score degree + reflex(lut5 over deg/conf/currency/immutable). Acts: route to needs-grounding, apply a volatile-currency penalty so it decays unless grounded.
- **cut-criticality / bridge** [high, silent] — share of neighbors that reach the graph only through this cell (single point of failure). Wiring: 2-hop score + latch(orphaned-if-removed) + funnel term, quorum. Acts: pin currency so the lone bridge does not age out, mark non-evictable, solicit a redundant edge.
- **local-cluster-density (echo index)** [medium, silent] — local clustering coefficient; high = echo pocket, low-at-high-degree = real bridge. Wiring: triangle count over 2-hop, drift vs global mean. Acts: echo pocket → down-weight intra-cluster support; bridge → reinforce/pin.
- **dangling-supersession (annex-without-heir)** [medium, surfaced] — superseded_by target gone/annexed, leaving a dead terminal still retrieved. Wiring: watchdog on superseded_by target + reflex + oneshot. Acts: queue for re-anchor, gate from authoritative service until reanchored.
- **orphan-drift** [medium, surfaced] — live-degree falling over a window as neighbors get annexed, before true degree-0. Wiring: record(live-degree) + trend + watchdog(deg→1, slope<0). Acts: alert and annex for re-linking before it rots unseen.

## Currency axis

- **supersession-depth + staleness gradient** [medium, surfaced] — bounded walk (MAXHOP 6) of the chain behind a cell, weighted by worst currency along it. Wiring: trend walks supersedes chain, track min currency, watchdog(>.6). Acts: alert "rests on aged base", re-verify the root, demote deep chains.
- **currency-half-life ETA (time-to-stale)** [high, surfaced] — closed-form `days_to_stale` until currency hits 0.5. Wiring: score from (currency, tau-by-class, floor), siggen recompute, watch(<=7). Acts: latch into a refresh queue BEFORE decay bites.
- **staleness-under-demand** [high, surfaced] — high salience + old CONTENT-touch (retrieval-touch masks stale content). Wiring: separate content_touched ts, watchdog(content_age), watch(salience>median), reflex AND, oneshot. Acts: one-shot re-verify so the system stops serving stale-but-popular memory confidently.
- **staleness-divergence (vs neighborhood)** [medium, silent] — `currency_self - EMA(supporters' currency)`; forgotten cell vs whole-cluster aging. Wiring: fanout supporters + smooth + drift, watch(<=-.3). Acts: targeted refresh bumped ahead; cluster-wide aging → one batched alert.

## Salience axis

- **demand-acceleration** [high, silent] — 2nd-diff of retrieval salience; heating vs plateaued vs cooling. Wiring: record(16)+trend+trend+smooth, watch(+/-.05). Acts: re-rank — pre-warm rising cells into the working set before they fully heat.
- **citation-in-degree-momentum** [medium, silent] — rate of new distinct inbound edges (anti-echo normalized) = a node becoming load-bearing. Wiring: score inbound edges 1/(#from same producer), trend, watch(>.3 & in>=4). Acts: bump currency tau one tier, pin into the candidate set.
- **supply-demand-gap** [medium, surfaced] — per topic: queried a lot, thin high-quality evidence. Wiring: smooth(demand) vs score(supply), subtract, watchdog(>.4 for 3 ticks). Acts: surface an "evidence is thin here" caveat, gate auto-confident answers.
- **attention-monopoly** [low, silent] — one cell hogging a topic's hits while siblings starve. Wiring: score(max/total salience), drift, watch(>.6). Acts: down-weight the dominant, lift two siblings into view.
- **query-cluster-coherence** [low, silent] — recent hits tight (focused) vs scattered (exploratory). Wiring: record(12) + quorum(3-of-12 within 1 hop), route. Acts: high → narrow retrieval (deeper); low → widen fan-out (broader).

## Task axis

- **ready-gate (blocked-vs-ready)** [high, silent] — 1 = all depends_on done and none blocked. Wiring: quorum over prereq done-bits + watchdog(any prereq eff<.2) + reflex AND, latch. Acts: admit to ready queue; flips exactly when the last blocker clears.
- **dependency-rot** [high, surfaced] — a depends_on target annexed, superseded-without-heir, OR eff-collapsed. Wiring: watchdog + drift(prereq eff vs attach snapshot) + reflex OR + latch + route(offending addr). Acts: pull from ready queue, surface "dependency rotted: <addr>".
- **objective burn-down (velocity + ETA)** [medium, surfaced] — `burn_rate` of children-done + `eta_ticks`. Wiring: score done-count + trend + reciprocal, watchdog(rate<eps while open). Acts: stalled → raise in status digest with ETA; healthy → demote.
- **task-staleness + risk-aging** [medium, surfaced] — monotonic clocks: open-task aging pressure, and `concern*age*(1-mitigation)`. Wiring: watchdog(tau) + clamp + reflex(gate to open); risk: score(coverage)*age. Acts: stale tasks bubble up the ready-sort; hot risk forced into context, gates a parent's done-transition.
- **allocation-pressure** [high, surfaced] — which open work to do next, folding in the proven workflow formula verbatim: `pressure = impact * (uncertainty + concern + novelty) * (0.5 + dependency) * (0.5 + reversibility/2) / cost`. Value terms ADD (one being 0 doesn't kill it), structural terms are floored multipliers, cost divides. Wiring: score over a task's fields — uncertainty/concern from the cell, dependency = depends_on in-degree, impact/cost/novelty/reversibility = task fields or derived (novelty ~ isolation, reversibility ~ policy). Acts: the ready-queue sort key; high pressure surfaces first. The workflow primitives (work_candidate/allocation_plan/proxy_score/miss) stay deferred; only this math folds in. `triage-rank` (meta) reuses this multiplicative shape for retrieval ordering.

## Actor axis

- **calibration-weighted authority skew** [high, silent] — signed EMA of `stated_conf - realized_eff` per actor (a LEVEL). Wiring: score bias per resolved claim + smooth(.1) + clamp. Acts: subtract the bias at intake so an overconfident actor's new writes auto-deflate (calibration self-corrects between turns).
- **calibration-drift (residual slope)** [medium, silent] — signed rate of an actor's reliability change (early-warning derivative). Wiring: score residual + record(20) + trend, watch(<-.15). Acts: scale calibration factor down 0.85 on a falling source, relax back up on recovery.
- **cross-actor agreement (concordance)** [medium, surfaced] — per claim k-of-m author sign agreement; per actor concordance vs majority. Wiring: quorum over authors' signs + score concordance + drift. Acts: agreement<.34 annex as contested; concordance falling flags actor, raises concern, does NOT auto-demote (contrarians can be right).
- **provenance-diversity trend** [medium, surfaced] — distinct-source count growing or shrinking (collapse onto one source). Wiring: score distinct producers + record(15) + trend, watch(slope<0 & D<=2). Acts: raise uncertainty, emit a task to seek a corroborating source.
- **actor specialization (topic concentration)** [low, silent] — Herfindahl of eff-weighted contributions over topics + best-topic. Wiring: fanout authored→topics, score per bucket, reduce H, route argmax. Acts: specialist prior in-domain, generalist haircut out-of-domain.

---

## Meta-signals (the completeness layer over the 29)

The completeness pass flagged that 29 per-cell signals each drive their own re-rank
or actuator and can fight each other, and that nothing audits the operators or the
graph globally. Five meta-signals close that:

- **triage-rank** [high, silent] — ONE fused priority per cell: weighted combine of
  effective-momentum, contradiction-load, currency-ETA, and salience into a single
  retrieval/attention order. Wiring: score(weighted sum of the named signals) +
  clamp. Acts: the single sort key compile/retrieval uses, so the operator applies
  ONE ordering instead of N re-ranks that conflict.
- **actuator-arbitration** [high, silent] — detects two programs latching opposing
  actuators on one cell (pin vs compact, reinforce vs freeze) and resolves by fixed
  precedence (freeze/safety > pin > demote > reinforce). Wiring: reflex(lut5 over
  the conflicting bits) → one resolved action + watch(conflict) to audit. Acts:
  deterministic precedence; logs conflicts for tuning.
- **compaction-pressure** [high, silent] — graph-global `node/edge count vs capacity`
  scalar in [0,1] that gates how hard eviction/annex fire this tick (every per-cell
  signal assumes unbounded room). Wiring: global score(counts vs cap) + smooth.
  Acts: clamps the annex/evict rate by pressure — aggressive when full, conservative
  when roomy.
- **reflex-meta-calibration** [medium, surfaced] — audits the operators, not the
  cells: per reflex, `overridden trips / total trips`. Wiring: score(override rate)
  + watch(high). Acts: flag a mis-firing reflex personality for re-tuning or disable
  it. Calibration for the programs themselves.
- **edge mis-wiring** [medium, silent] — flags a likely-wrong edge (a supports edge
  between cells that mostly contradict their shared neighbors) before one bad edge
  poisons load-ratio, independence, and bridge scores at once. Wiring: score(edge
  sign vs neighborhood consensus) + watch(low). Acts: down-weight/quarantine the
  suspect edge pending review.

---

## Merged / dropped (11)

volatility-regime-latch → confab-spike; source-independence/collusion → corroboration-independence; contradiction-onset → contradiction-acceleration; betweenness-proxy → cut-criticality (funnel term); reinforcement-rate → currency-ETA; touch-recency slope → demand-acceleration; dispute-quorum-stall → load-ratio + watchdog; actor-silence → staleness-divergence + currency; hub-imbalance → cluster-density + independence; orphan-demand → citation-momentum + demand-accel. Full reasons in the workflow output.

## Surfacing summary

Of 34 signals, ~13 are **[surfaced]** (they raise a compact flag the model reads
next turn: disputes, flip-imminent, single-source, stale, dependency-rot, contested,
thin-evidence, stalled-objective, hot-risk, reflex-misfire). The rest are **[silent]**
(re-rank, pin, reinforce, gate, arbitrate between turns). The model never sees the
math, only the handful of flags, which is what keeps its load flat as the catalog
grows.

## See also
- `docs/PLAN.md` Items 8 and 10
- `docs/design/write-time-scores.md`, `docs/design/cell-anatomy.md`
