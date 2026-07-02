# Cell scores: stated vs effective, and the graph's relational math

What numeric values a cell carries, which are the model's retained anchors versus
values the graph attenuates or derives, and where the leverage is. Grounded in the
prior three-axis decay decisions, the prior call that effective confidence is
recomputed from the graph (not a fixed field), and the calibration anti-drift rule.

## 1. The two numbers

Every cell has two headline numbers:

- Model-proposed: what the model claims. Retained as an anchor: never overwritten,
  but not frozen as the working value either.
- Effective: the proposed number attenuated against the graph and the actor's
  calibration. Alive, recomputed.

Nothing is frozen. The working number is attenuated, not fixed. What we keep is the
model's original proposed number as a non-drifting anchor, and every attenuation is
computed from that anchor, not from the last attenuated value, so repeated
attenuation does not compound and drift. We keep the model's own calibration signal
for exactly this reason. This was already established.

## 2. Where the leverage is: relation to what is already there

When you state something, the graph evaluates it relative to existing cells. That
relation is where most of the math comes from:

- Corroboration: supporting neighbors raise the effective value.
- Contradiction pressure: contradicting neighbors lower it, or demote it versus
  the incumbent depending on the actors' calibration.
- Isolation / novelty: no neighbors means higher uncertainty.
- Redundancy: a near-duplicate is merged rather than double-counted.

None of this needs to be frozen at write. It is a function of position in the
graph, so it is naturally recomputed, at write as a cached snapshot and at read
when freshness matters.

## 3. The three axes (prior, resolved)

- Evidence: how well-supported the claim is. Stated confidence lives here and
  stays evidence-only. Time does not change it.
- Currency: staleness. `c(t) = c_floor + (c0 - c_floor) * e^(-lambda * dt)`,
  per-type lambda (stable 3650 days, volatile 30, ephemeral 7), reinforcement
  resets dt. Separate ranking surface, never merged into confidence.
- Salience: importance. Seeded, reinforced by use, decays.

## 4. The ordered legend (the canonical Y set)

Position is meaning, so `(X, Y)` = `(cell hex id, index)` addresses any value
without storing labels on every cell. The "immutable" column is the only hard
line; "recompute" is where the value is naturally produced, not a rule.

| Y | name | axis | immutable input or graph-derived | recompute | notes |
|---|------|------|----------------------------------|-----------|-------|
| 0 | confidence (proposed) | evidence | model input, required, (0,1] | retained anchor | the model's number; kept un-overwritten to prevent drift |
| 1 | uncertainty | evidence | immutable if stated, else derived | write | default `(1 - confidence) * 0.7` |
| 2 | concern | evidence | immutable if stated, else derived | write | default `(1 - confidence) * 0.3` |
| 3 | stability | evidence/currency | immutable input | never | selects the currency lambda class |
| 4 | source_quality | evidence | graph-derived (from stated) | write | label from confidence |
| 5 | actor_calibration | evidence | graph-derived (actor history) | read/tick | the writer's stated-vs-outcome multiplier |
| 6 | effective_confidence | evidence | graph-derived (relational) | read | the second headline number: stated, reconciled against the graph |
| 7 | evidence_balance | evidence | graph-derived (relational) | read | from supports/contradicts/concerns neighbors |
| 8 | currency | currency | derived (time) | read | `c(t)`; stored inputs are c0, lambda class, last_reinforced |
| 9 | salience | salience | derived (use) | read | seeded then reinforced by access/citation |

Nothing here is frozen. Y0 and Y3 are retained anchors (never overwritten); the
rest the graph produces or attenuates, at whatever time is cheapest, from the
cell's relations and the actor's calibration.

## 5. The boolean actuators (flags)

Booleans ride in the same ordered block after the numbers. They gate effect
rather than measure it.

| B | name | effect | default |
|---|------|--------|---------|
| 0 | annexed | effect neutralized, cell retained and reinstatable (replaces delete and rollback) | false |
| 1 | locked | immutability lock: no supersede, no annex | false |
| 2 | requires_review | held for review before background use | false |
| 3 | allow_background_use | programs and compile may use without prompting | true |
| 4 | pinned | exempt from currency decay, always retrievable | false |

Annex is the rollback replacement: flip `annexed = true` and the cell stops
affecting scores, retrieval, and relation resolution, but stays in the store and
can be reinstated.

## 6. Calibration and anti-drift

Calibration compares the model's proposed number (Y0, the retained anchor) against
what later happened to the cell (contradicted, superseded, or held). The actor's
track record over many cells is `actor_calibration` (Y5), which attenuates the
effective number (Y6) for their future writes. Keeping Y0 un-overwritten is what
prevents drift: attenuation is always taken from the anchor, never re-applied to an
already-attenuated value, so it does not compound. We keep the model's own
calibration signal for this reason. Established earlier, restated here.

## 7. Addressing: (X, Y)

- X = the cell, by short hex id. The id is the handle, no long path address.
- Y = a field. For scores, Y is the index in section 4. For structural fields
  (title, body, summary, kind, owner, timestamp), Y is the field name.

`(a3ee009, 0)` is that cell's stated confidence; `(a3ee009, 6)` is its effective
confidence; `(a3ee009, body)` is its content.

## 8. Open decisions

- Confirm the legend membership and order (sections 4 and 5).
- evidence_balance and effective_confidence formulas: how corroboration and
  contradiction pressure combine into the effective number.
- Whether to cache a write-time snapshot of the graph-derived values for cheap
  reads, and how stale that snapshot is allowed to get before a recompute.
- salience seeding and reinforcement rule.
- currency c_floor, and whether pinned cells skip currency entirely.
