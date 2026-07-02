# Recall v5: the plan of record

A living document. We walk it top to bottom, lock open items as we go, and I keep
it updated each turn. Nothing here is code; it is the design we agree on before
any building starts.

Detail docs this plan points at:
- Spec: `docs/superpowers/specs/2026-06-23-recall-v5-ground-up-rewrite-design.md`
- First program: `docs/subsystems/R0-foundation.md`
- Scores model: `docs/design/write-time-scores.md`

Legend: [DECIDED] settled. [OPEN] needs your call. [WIP] in progress. [LATER] parked.

## The architecture: MAL (Memory Abstraction Layer)

v5 IS the Memory Abstraction Layer, the direct analogue of LinuxCNC's HAL (Hardware
Abstraction Layer): MAL abstracts the memory store the way HAL abstracts hardware.
One-to-one mapping: cell fields = pins; addressable values = signals (one writer,
many readers); ops (watch/watchdog/trend/drift/quorum/score/reflex/pid/...) =
components; the operator tick = the thread (HAL `addf` scheduling); the dotted
address = the wire; a MAL graph rendered as text = a memory netlist, legible by
sight. Everything below is MAL's design.

---

## 0. Where we are in the walkthrough

DESIGN COMPLETE (Items 1-11 decided; 5 design docs + this plan committed). BUILD
STARTED, fresh, no port from the clone. R0 Foundation COMPLETE and sealed on
`rewrite/integration` (runtime vocabularies, strict proposal/handle contract,
rendered MAL row, current R0 docs). R1 Gate COMPLETE and hardened on
`rewrite/integration` (schema -> secret/public-data screen -> evidence-aware
confidence attenuation -> buildCell -> Brier calibration; invalid calibration
context rejected; store-backed relational work still belongs to R2). Secret side
store first slice is implemented: encrypted project-DB blobs, boring aliases, and
a key-provider seam for later OS/OEM keychain auth. R2 Store core slice is
implemented: normalized SQLite cells/edges, store-backed FTS5/BM25 lexical
retrieval with LIKE fallback, compile delegation, evidence mass walks, and store
stats. R4 Compile core slice is implemented: ID-first context packets, sectioned
mini-index push, incoming challenge surfacing, expansion handles, packet
formatting, and lazy cell/field inspection. R5 Routing core slice is implemented:
central Recall home/project registry routing, deepest-ancestor cwd resolution,
slug collision hardening, local graph discovery, and a read-only federated Store
union with graph-prefixed keys/edges. R7 Integrations core slice is implemented:
platform-neutral Recall directives, Store-backed prompt context pushes, stop
write-back reminders, Codex AGENTS/slash/MCP TOML merge helpers, and Claude
settings/MCP merge helpers with auto-memory disabling. R8 Surfaces core slice is
implemented: public ESM export barrel, `recall-mal` npm bin, project/status/read
CLI commands, validate/admit write commands, executable build output, and
runtime-only package file selection. R9 Python core helper slice is implemented:
`recall_helper.py` builds compact v5 write proposals and delegates validate/admit
to `recall-mal`, `recall_peek.py` renders compact cell previews from
`recall-mal cell show`, Python helpers are included in npm package files, and
`npm run test:python` covers build/validate/admit/peek. R3 Programs/Operator core
slice is implemented: `prg` cells carry `recall.program.v1` specs, the operator
cycle ticks active cells and runs standing programs, program witnesses re-enter
through admission when `--derive` is set, and `recall-mal operate once` exposes
the cycle. R6 Adapters core slice is implemented: dry-run-first import core,
Mem0/Zep/auto-memory JSON/markdown adapters, source fingerprints/source-tag
supersession through R1/R2 admission, portable `recall.cells.export.v1` archives,
and CLI `export`/`import` commands. Public npm release metadata is now prepared:
`recall-mal` version `0.1.0`, Apache-2.0 license, Node `>=22.5.0`, README,
CHANGELOG, public publish config, and `npm run release:check`. Release is gated
on installed-artifact acceptance: pack the npm tarball, install it into a clean
consumer, then verify CLI/library/Python behavior, routing, write/read/search,
compile/operate, import/export, and graph lattice structure before any real npm
publish. Current full verification: 159 TypeScript tests + 5 Python tests green;
typecheck clean, build clean, installed-package acceptance clean, npm pack
dry-run clean.

---

## 1. Project frame and workflow  [DECIDED]

- Ground-up redesign. Behavior and APIs may change. Old tests are reference only.
- Unit of work: one subsystem per cycle.
- Target: build v5 fresh in `~/Recallv.5` (local git, no remote).
- Source: `~/Recall-GitHub-Clean`, read-only reference, ported from.
- Burn the clone down: each ported subsystem is deleted from the clone on a
  `rewrite/burndown` branch; clone empty equals done.
- Branches in v5: `main` <- `rewrite/integration` <- `rewrite/<subsystem>` worktrees;
  one final merge to `main`.
- Recall stays in the loop: compile intent before each subsystem, write decisions
  and risks back as we go.

## 2. Scope: drop / defer / keep  [REVISED 2026-06-23 in your walkthrough]

Drop (cut entirely):
- ACP.
- `RollbackEntry` (replaced by annex).

Defer (add back after a stable core):
- MCP server and the launch-agent / service ("the servers").
- TUI.
- legacy global-to-local local-import and richer service import surfaces.
- eval / benchmark (might come in handy later).

Keep (the core):
- R0 Foundation (slimmed).
- R1 Gate: firewall + admission + calibration + secret/public-data screening +
  encrypted secret side store.
- R2 Store: store + FTS5 retrieval + evidence.
- R3: programs + daemon + scheduler + operator (full, not a minimal tick) +
  workflow-allocate (mine its ideas).
- R4 compile + cell-context.
- R5 routing (residency).
- R8 CLI.
- claude-integration (the hooks).
- R6 adapters: import core, portable cell archives, auto-memory, mem0, and zep.
- codex-integration.
- DAG homology / holonomy (both kept, per the prior correction that the
  hypernetwork allows both on its members).

Open (resolve before R-order):
- zep adapter: [decided/core implemented] keep alongside mem0 for JSON export import.
- DAG overlay analysis (heads-up: the holonomy witnesses are computed by it, so
  keeping holonomy probably means keeping this).
- semantic / vector embeddings (deferred beyond the current R2 core slice).
- pages views (named report views; deferred beyond the current R4 core slice).

Secrets (decided, first slice implemented): the stable-core gate rejects
recognized secret values and blocks likely personal data on public writes. Secret
values that must be retained go into the project SQLite DB as AES-256-GCM blobs
under boring aliases like `sec_4f2a19c8d031`; normal cells reference aliases only.
Decryption is routed through a `SecretKeyProvider` seam so the later macOS/OEM
keychain adapter can unwrap project keys without changing the DB contract.
Deferred: keychain adapter, lock/unlock CLI, cross-platform providers, and the
Total-Recall hardened alias/metadata policy.

## 3. The cell anatomy  [DECIDED, component view]

The v5 cell = the current cell's contents with edges and scores lifted out of the
untyped `data` bag into typed first-class primitives. `type` is folded into `kind`
(one memory class). Field groups (component / HAL lens):

- Identity: key (stable hex), handle (typed, item 4), kind, owner, timestamp.
- Lineage: supersedes chain (first-class), resolve to live head.
- Content: title, body, summary.
- Pins (wiring): signed edges (supports +, contradicts -, concerns -0.5),
  depends_on; incoming = input pins, outgoing = output pins.
- State: the ordered scores block (stated anchor + effective + three axes).
- Control bits (actuators): annexed, locked, pinned, requires_review,
  allow_background_use.
- Attached gates: the standing programs watching this cell.
- Custom: typed properties bag.
- Scope: project / tenant (also the residency key).

Dropped: long cellAddress path (hex handle replaces it), `type` tag (folded into
kind), likely signature_status. Full design + 2 flowcharts:
docs/design/cell-anatomy.md.

## 4. IDs and addressing  [DECIDED]

Two layers (proposed):
- Stable internal KEY (the database identifier): opaque, fixed, never changes.
  Every relation foreign-keys to this. Fixed width.
- Semantic HANDLE: human-readable snake_case, encodes what the cell is (typed
  prefix + facets), re-derivable, variable length. Bare cell short (`dec_a3ee`);
  rich cell longer (`dec_auth_a3ee`). Tuple internally `{kind, facets[], seq}`,
  string for display.
- Addressing is a variable-length PATH, not a fixed grid (the graph is a ragged
  table, cells have different columns). It grows three ways: deeper into a cell
  (`-` field walk), wider across cells (`.` edge hop), and back in time (`@vN`).
  Compose freely, e.g. `dec_a3ee@v2.supports-weight`.
- Separators (final), by binding tightness: `_` joins words in a name (snake_case
  identifier), `-` walks fields within a cell, `.` crosses an edge to another cell.
  Periods count graph hops: `dec_a3ee-scores-eff` (in-cell, 0 hops),
  `dec_a3ee.supports-eff` (1 hop), `dec_a3ee.supports.contradicts-title` (2 hops).
  Edges branch (sets/vectors); outgoing default, incoming via `~`. The address is
  the op wire (HAL `net`).

Why separate: a content-encoding id cannot be the relation target, because when
content changes the id would change and break every edge. Encode meaning in the
handle, keep the key stable.

Emergent property (legibility): because the notation is regular and ops are
single-writer-deterministic, the graph's text form is readable by sight, a "memory
netlist" (a MAL graph rendered as text; netlist is the EDA/HAL term). You read the
memory instead of querying it: `conf(0.7!) eff(0.42) curr(0.9)`, follow `.supports`,
done. Auditable by eye = the static counterpart to the scope.

Core pattern (recurring): immutable anchor + live resolution. Same move as
effective confidence and currency. Relations use it too (see below).

[DECIDED] relations RESOLVE through the supersession/annex chain: edges are
immutable and directed; a change supersedes (writes a new cell); the live target
is resolved at read by walking the chain. Backtracking = reading the edge in
reverse (incoming index), no mutation, no sign needed for direction.

Write cases (firewall decides): exact repeat -> dedup (no new cell); same subject
+ changed claim -> supersede (new head, old kept); novel -> plain add (no chain).
"I like banana" then "I like orange" = add, not supersede. Version depth is
COUNTED from the chain, not stored. A fork (two cells supersede one) resolves to a
single live head by recency/calibration. Transitive relatedness (hand-leg) is
DERIVED from path weight decayed per hop, never materialized. Rule: store direct
immutable edges only; resolve the live target, version depth, and relatedness from
paths. Spin-off signal: proximity score = best-path weight decayed by hops.

[DECIDED] edge weight is SIGNED (polarity): supports +, contradicts -, concerns
-0.5. Edges are value-bearing. Effective math becomes one signed sum, but
saturation stays SPLIT BY SIGN (positive capped ~0.15, negative ~0.6) so one
contradiction still outweighs many supports. Supersede forks resolve to the live
head by CALIBRATION, not recency.

[DECIDED] handle = `kind_hex` (snake_case): 3-letter kind prefix + short hex
(4 chars, git-style, grows on collision), e.g. `dec_a3ee`, `obs_7f1c`, `rsk_9b20`;
rich cells add a subject facet `dec_auth_a3ee`.
[DECIDED] notation (HAL-derived, extended for the graph): lowercase + digits;
type-tagged (float = scores, bit = actuators); abbreviation when unambiguous; soft
length cap (HAL = 41). THREE separators by binding tightness: `_` joins words in
one name/identifier (tightest, snake_case), `-` walks fields within a cell, `.`
crosses an edge to another cell (loosest) so periods count graph hops; plus `@vN`
for a version. Examples: `dec_auth_a3ee` (handle), `dec_a3ee-scores-eff` (float),
`dec_a3ee-flags-annexed` (bit), `dec_a3ee.supports-eff` (1 hop). CASE: a
CAPITALIZED handle marks an IMMUTABLE cell (`RECALL_v5`), a constant/anchor whose
contents never mutate in place (revise only by supersession; exempt from decay);
lowercase = ordinary mutable cell. For NUMBERS: a value attaches to its figure in
parens, `field(value)` (e.g. `eff(0.42)`); the immutable ones carry `!` inside the
parens, `field(value!)` (e.g. `conf(0.7!)` anchor, `c_floor(0.1!)` constant). So
the immutability markers are: CAPS for names, `!` inside parens for numbers.

[DECIDED 2026-06-26] prefix set is `dec`, `obs`, `bel`, `tsk`, `obj`, `rsk`,
`ref`, `ver`, `hyp`, `prg`. Handle suffix is 4 lowercase hex chars, git-style;
rich handles may add subject facets before the suffix. Soft length cap is 41.

## 5. The scores model  [DECIDED]

- Two headline numbers: model-proposed (a retained anchor, never overwritten) and
  effective (attenuated from the anchor, recomputed). Nothing is frozen.
- Anti-drift: attenuation is always taken from the anchor, never re-applied to an
  already-attenuated value, so it cannot compound. We keep the model's own number
  for exactly this.
- Three separate axes: evidence (confidence), currency (staleness), salience
  (importance). Time is not evidence.
- Why model-set values are OK (and the honest limit): every value is the writer
  model's call at write, grounded in its comprehension of what it ingested. But
  the next-turn reader is closer to FRESH than continuous, so the comprehension
  does NOT persist; only the value does. Calibration (retained anchor + Brier
  track-record) is what lets a fresh reader trust a value whose reasoning is gone.
  It BOUNDS the model's subjectivity over time; it does not erase it. A
  persistently miscalibrated writer still sets biased anchors; the graph's job is
  to SURFACE that (contradiction / drift / low calibration factor), not hide it.

[DECIDED] ordered legend (position = meaning; evidence -> currency -> salience;
anchor before derived; floats then bits so the push row is contiguous):
floats `0 confidence(stated anchor) 1 uncertainty 2 concern 3 source_quality
4 actor_calibration 5 effective 6 currency_c0 7 currency 8 salience_seed 9 salience`;
bits `10 annexed 11 locked 12 pinned 13 requires_review 14 allow_background_use`.
stability = enum input selecting the currency time-constant. Calibration reads 0..5.
Notation: values attach to their figure in parens `field(value)`; the immutable
ones (pos-0 anchor and config constants) carry `!` inside, e.g. `conf(0.7!)`,
`c_floor(0.1!)`; derived/live values (effective, currency, salience, masses) have
no `!`.

[DECIDED] salience = a leaky accumulator of USES: seed 0.5 at write, bump on each
retrieval into a compile packet (`s += (1-s)*k`), leak toward a floor on idle
ticks. Distinct from currency: currency resets on any TOUCH/update (freshness),
salience grows on USE/retrieval (demand). Currency = how fresh, salience = how
wanted.

## 6. The math  [GROUNDED in code]

- Effective confidence (real, `evidence.ts`):
  `effective = clamp01(stated x calibrationFactor + support - challenge)`,
  `support = 0.15 x tanh(supportMass)`, `challenge = 0.6 x tanh(challengeMass)`,
  masses summed over one hop of incoming trust edges weighted by each neighbor's
  stated confidence. The "K-mass / K-function": linear mass into a tanh saturation
  with asymmetric ceilings. One hop, deterministic, no LLM. v5: edges hold signed
  weight, so support - challenge collapses to one signed sum
  `Σ signed_edge_weight x neighbor_confidence`; saturation stays split by sign to
  keep the asymmetry (one challenger sinks it).
- Calibration (real, `calibration.ts`): per-actor Brier score of stated confidence
  vs survived-contradiction outcome, turned into `calibrationFactor` floored at
  0.5, neutral under 3 cells.
- Currency: the per-type lambda decay `c(t) = c_floor + (c0 - c_floor) e^(-lambda dt)`
  (stable 3650 / volatile 30 / ephemeral 7) is a DECISION but is NOT in either
  tree's code (both still carry a single 30-day recency half-life, no commit for
  the per-type work). v5 rebuilds it fresh from the decision.

[DECIDED] currency params (commenter's formula, de5b7ec3): `currency(dt) = c_floor
+ (c0 - c_floor)*e^(-dt/tau)`, dt resets on any reinforcement; tau per stability =
stable 3650d / volatile 30d / ephemeral 7d; c0 = 1.0; c_floor = 0.1 (tunable).
Separate ranking surface, never merged into confidence. Pinned cells skip currency
(held at c0).

## 7. Value-bearing primitives  [OPEN, new]

Today only cells hold values. Make more primitives value-bearing:
- Edge / relation [DECIDED]: SIGNED weight (supports +, contradicts -, concerns
  -0.5). Value-bearing. Mass = `Σ signed_edge_weight x neighbor_confidence`,
  saturation split by sign.
- Tags (topics / entities): per-topic salience, per-entity weight.
- Actor / identity: standing calibration, trust, topic specialization.
- Hyperedge member: use the existing optional weight.
- Hyperedge / program: a rolling value the program holds.

[DECIDED] edges done (signed); ACTORS next (store the standing calibration factor
+ trust on the actor, addressable `actor_calibration`; effective already needs it).
Tags (per-entity/topic salience) layer on after cell salience works. Hyperedge
member weights used as programs need them. Program rolling-values come with the op
layer (item 10). So: actors now, the rest layer on.

## 8. Between-turn signals catalog  [DECIDED]

30 per-cell signals across 6 lenses (evidence / structural / currency / salience /
task / actor incl. allocation-pressure folding in the workflow pressure formula) +
5 meta-signals (triage-rank, actuator-arbitration,
compaction-pressure, reflex-meta-calibration, edge-mis-wiring) that close the
completeness gaps; 11 candidates merged/dropped. Each is a deterministic MAL wiring
driving a between-turn action. ~13 are [surfaced] (raise a compact flag the model
reads next turn); the rest are [silent] (re-rank / pin / reinforce / gate), which is
what keeps the compiled packet lean. Full catalog: docs/design/signals-catalog.md.

## 9. Session lifecycle: the three hooks  [DECIDED]

Three arming points that make the model USE the substrate. START fires once per
session; COMPILE + ENDCAP fire every turn; the Endcap tick feeds the next Compile.

1. START (`SessionStart`) -- orient + arm on the right graph.
   - Residency: filesystem-presence walk, cwd up to the first `.recall` db elects
     the local graph; none -> global/home. Not a registry (f5c83089).
   - Arm/orient: inject the MAL protocol + a boot digest (activity since last
     session, objectives, open tasks, contradiction/stale counts, standing programs).
   - Catch-up tick so scores/currency/signals reflect elapsed time.
   Goal: the model starts situated on the right graph, not cold.

2. COMPILE (`UserPromptSubmit`) -- push the lean relevant slice.
   - MINI index (8d70f7d9): ids + titles + tripwire counts (challenged/stale +
     surfaced-signal flags) for cells relevant to THIS prompt; deliberately
     INCOMPLETE, fail-open, ~0.16s. NOT the full digest.
   - Two-stage: mini push -> model judges by title -> full compile expands only the
     chosen. Raise EXPAND REQUIRED on relevant superseded/stale cells.
   - Arm against the ask-the-user bypass (make digging the path of least resistance).
   Goal: minimal trust-weighted slice that says what's relevant and what to expand.

3. ENDCAP (`Stop`) -- commit + reconcile + tick.
   - FORCE write-back through the firewall: new cells + intended edges + anchor
     values; firewall = secret-screen, schema, calibration attenuation,
     dedup/supersede/add, unprompted contradiction detection. Forced so the turn is
     captured even if the model didn't explicitly write.
   - Graph adjust: fill addresses/handles, place links, update lineage.
   - Operator tick: recompute scores, decay currency, update salience, run the 34
     signals + standing programs + meta-signals (triage-rank, arbitration,
     compaction-pressure), apply actuators (annex/demote/pin/reinforce).
   Goal: durably capture the turn and bring MAL current for the next Compile.

Theme: the hooks counter the three bypasses -- cold-start amnesia (Start), ignoring
memory (Compile), forgetting to write (Endcap). Arming = the most-missed moat.

Per-turn protocol (5 steps; START primes once per session):
0. START [session, once]: residency + orient + catch-up.
1. PUSH [system->model, injected on the prompt]: the mini-index (ids+titles+tripwire counts).
2. VERIFY [model]: expand the addresses pulled, read the actual cells, clear EXPAND-REQUIRED (do NOT trust titles).
3. WORK [model]: reason, act, answer.
4. WRITE-BACK [Stop, forced]: commit new cells + intended edges + anchors through the firewall.
5. TICK [system-only]: operator pass -- scores/currency/salience + signals + standing programs + graph-adjust; feeds the next PUSH.
The model participates in 1-4; step 5 is silent deterministic system. The VERIFY
step is why the mini-index is deliberately incomplete: titles say what exists, the
model must expand to read actuals.

Compile structure (v5, re-architected for the new cell/address). The address now
self-describes (handle = kind prefix + facets + CAPS-immutability; values written
`field(value!)`), so the compile renders a dense, self-describing NETLIST, not the
old verbose digest. This heavily rewrites R4 (context-compiler); it reads off R0's
address scheme, so build R0 first (it must nail handle parsing + `field(value!)`
rendering), then R4 renders over it. Does NOT block starting R0.
- Mini-index line: `<handle> "<title>" <score-sig> [<flags> <degree>]`, e.g.
  `^dec_watchdog_42c6 "add watchdog op" conf(.7!) eff(.61) curr(.9) [in:1 out:1]`
  (leading `^` = EXPAND REQUIRED, the compact glyph replacing verbose [challenged]).
  Line = TITLE (variable, lint-bounded <=20w) + ~12w of meta. Only the META
  compressed (old line was title + ~40w of state/facets/policy); the title is
  unchanged. Content lives on the cell: title/summary in the line, BODY only on
  expand (never in the push). Handle = kind prefix + subject slug + hex; it is NOT
  the title. Push size ~= N-selected * (short title + ~12w), so keeping titles
  short (the firewall lint) is what keeps the push lean.
- Expand (VERIFY): full cell = ordered scores block + edges as TRAVERSABLE neighbor
  handles (`.supports -> [obs_7f1c]`) + lineage (`@vN`) + body; the model digs by
  following `.edge`. The address IS the navigation.
- Compile = select relevant -> emit handles -> expand on demand. A netlist renderer,
  not a curated prose string.

## 10. Standing programs (the moat)  [LATER]

Programs that run outside the loop: watch / trend / drift / quorum / score. They
read the values from items 5 to 8 and act (re-rank, flag, demote, annex, reinforce,
alert). This is the treasure; design after the basics are solid.

### Op palette (mined from 45 LinuxCNC HAL man pages)

Core (have): `watch` `trend` `drift` `quorum` `score` + the anchor accumulator
`weighted-sum` (= signed-edge mass).

Adopt (the 5 capability classes the core lacks):
- `reflex` (lut5) [high]: configurable 5-input truth table -> bit; subsumes
  and2/or2/xor2/logic/match8. Declarative per-cell boolean policy set by a
  "personality" (HAL `logic`'s term, better than "hex mask"): one configured
  component, not a farm of wired gates.
- `smooth` (lowpass) [high]: EMA a score toward live evidence, damp noise.
- `clamp` (limit2) [high]: bound a score + cap per-tick slew (anti-whiplash).
- `latch` (flipflop) [high]: hold a bit across turns; set/reset overrides.
- `watchdog` (watchdog) [high]: the ABSENCE/timeout tripwire -- fire when a
  monitored value STOPS updating within a timeout (vs `watch` = presence/threshold
  cross). Staleness trip, program-liveness, dependency-silence. Absence-detection
  is a push-only capability a pull store structurally cannot do.
- `route` (mux_generic) [med]: select which evidence feeds the next op, debounced.
- `fanout` (demux) [med]: 1-of-N actuator dispatch, or bargraph = severity ladder.
- `snapshot` (sample_hold) [med]: pin a score as a baseline for drift to diff.
- `record`/`replay` (sampler/streamer) [med/low]: ring-buffer history + re-inject
  to regression-test a reflex.
- `pid` (pid) [high]: a full P+I+D controller driving a value to a setpoint; the
  precise-movement primitive (regulate packet size to a token budget, salience to a
  normalized total, contradiction-rate to a target).
- `oneshot` (oneshot) [med]: fire once for a fixed duration on a trigger edge (alert
  once, not every tick); complements `latch` (holds until cleared).
- `toggle`, `blend` [low].

Folded in as op CONFIG (not new ops): weighted_sum/sum2 = mass anchor; integ/time
= trend/currency accumulator; lowpass->0 = currency decay; edge+debounce =
contradiction-velocity trigger + hysteresis; comp/wcomp = banded watch; near =
pairwise quorum; deadzone = drift noise-gate; abs/scale = score pre-steps; logic =
wide quorum.

Headline: 45 components collapse to ~12 new ops because reflex + route subsume
whole gate/mux families. New classes: routing, value-filter/bound, held-state,
configurable reflex, record/replay, set-point control (pid).

DETERMINISTIC: every op is pure math, no LLM. Same inputs -> same outputs, so the
whole between-turn layer is reproducible, testable (record/replay regression), and
explainable. Model subjectivity is confined to the LEAF anchor values; all
propagation, derivation, and reflexes are deterministic over those leaves. The
reliability floor is fixed by math; the capability ceiling rises with the model.

SIGNALS: a signal is a named, typed (float/bit), addressable value carrier (the
address IS the signal name). Recall is MANY WRITERS, ONE READER: many actors write
claims/edges/supersessions to a cell, and the calibration + effective math reconcile
them for the one reading agent (the trust premise; inverse of HAL's
one-writer-many-readers, because Recall reconciles fallible writers). DERIVED fields
(eff/curr/sal) are single-op-owned only for tick determinism, but their INPUTS are
the many writers' contributions, so that does not contradict many-writers.
Persistent signals = cell fields (stored); transient signals = op-to-op wires; the
operator runs ops in scheduled order each tick (HAL `addf`).

Authoring & tooling:
- `halcmd` -> op-wiring CLI: net (signed edge, fan-out), setp (config / force a
  bit), addf (schedule an op on the tick), show/save (serialize + rehydrate the
  whole op-wired graph for backup/diff).
- ClassicLadder -> visual LADDER AUTHORING of multi-rung reflex policies [LATER]:
  contacts = truth-bits / score thresholds, coils = actuators / op triggers,
  timer/counter blocks = trend/currency/debounce. The config UX over reflex/latch;
  lut5 is one gate, ladder is a program.
- `siggen` -> `source` op [low]: synthetic periodic value (heartbeat, scope demo).
- inverse-clarke -> niche transform op over the 3-axis (evidence/currency/salience)
  score vector [parked].

Memory scope (halscope) [LATER, observability]: probe ANY addressable value
`(X.Y)` and plot its trace over ticks/turns -- effective confidence dipping when a
contradiction lands, currency decay, salience pulse, contradiction-velocity spike.
`trend` is the sampler, `watch` is the scope trigger (fire on threshold cross).
Possible because every value is addressable and the operator produces a time
series. Differentiator + demo.

## 11. Subsystem rewrite order and per-subsystem cycle  [DECIDED]

Order: R0 Foundation to R9, leaves first, so v5 compiles at every step.
Per-subsystem cycle:
1. `recall compile "rewrite <subsystem>"` for intent.
2. Read the clone module, write its intent card, record to Recall.
3. Worktree on `rewrite/<subsystem>` off integration.
4. Clean rewrite into v5.
5. Verify (new tests, build green).
6. Merge to `rewrite/integration`.
7. Burn the clone module down; record outcome.

---

## Open items queue (what we still owe a decision on)

- 3: [decided] cell field set locked; type folded into kind. See docs/design/cell-anatomy.md.
- 4: [decided] resolve, signed edges, calibration forks, HAL notation, prefix set, and length cap.
- 5: [decided] ordered score legend and salience definition.
- 6: [decided] c_floor, pinned-skips-currency, and lambda values.
- 7: [edges decided: signed value-bearing] remaining primitives (tags/actors/members) now or later?
- 8: [decided] catalog populated (29 + 5 meta). See docs/design/signals-catalog.md.
- 9: [decided] start/compile/endcap goals specified.
- 2: zep adapter [decided/core implemented]; overlay analysis; semantic/vector; which pages survive.
