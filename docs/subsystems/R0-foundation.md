# R0 Foundation: current MAL contract

Date: 2026-06-26
Status: implemented on `rewrite/integration`

R0 is the vocabulary and deterministic front door for Recall v5 / MAL. It has no
database, no network, and no mutation outside building in-memory values. Everything
downstream speaks the types defined here.

## Module Map

| Module | Role |
|--------|------|
| `src/types.ts` | Runtime vocabularies, TypeScript types, `WriteProposal`, `Cell`, edges, scores, flags, store interfaces |
| `src/schema.ts` | Structural validation for thin `WriteProposal` objects |
| `src/build.ts` | Builds a full `Cell` from a schema-valid proposal |
| `src/address.ts` | MAL handle/value/path parsing and value rendering |
| `src/render.ts` | Mini-index and expanded cell netlist rendering |
| `src/scores.ts` | Pure score math for effective confidence and currency |
| `src/resolve.ts` | In-cell field selection for `-` field walks |

R1 starts after this: secret screening, confidence attenuation, admission, and
calibration. R2 starts where a store is needed.

## Vocabulary

The runtime constants in `src/types.ts` are the contract:

- `KINDS`: `dec`, `obs`, `bel`, `tsk`, `obj`, `rsk`, `ref`, `ver`, `hyp`, `prg`
- `RELATIONS`: `supports`, `contradicts`, `concerns`, `depends_on`,
  `supersedes`, `derived_from`
- `STABILITIES`: `ephemeral`, `volatile`, `stable`
- `ORIGINS`: `human`, `llm`, `daemon`, `connector`, `program`, `external`
- `VERIFICATIONS`: `unverified`, `checked`, `tested`, `external`
- `SENSITIVITIES`: `public`, `private`, `secret`
- `OPERATIONS`: `create`, `update`, `supersede`, `link`, `annex`
- Handle policy: `HANDLE_HEX_LENGTH = 4`; `HANDLE_SOFT_LENGTH_CAP = 41`

## Write Proposal

`WriteProposal` is intentionally thin. Required fields:

- `kind`: one of `KINDS`
- `title`: non-empty string
- `body`: string, allowed to be empty
- `confidence`: finite number in `(0, 1]`

Optional fields are also validated when present:

- string fields: `owner`, `summary`, `project`, `tenant`
- string arrays: `topics`, `entities`, `sourceRefs`
- probabilities: `uncertainty`, `concern` in `[0, 1]`
- enums: `operation`, `origin`, `verification`, `sensitivity`, `stability`
- dates: `expiresAt`, `reverifyAfter` as ISO-8601 strings or `null`
- `flags`: partial boolean `Flags`
- `props`: object
- `edges`: relation/target/weight objects

Edge polarity is part of R0:

- `supports`: positive weight
- `contradicts`: negative weight
- `concerns`: negative weight, default `-0.5`
- `depends_on`, `supersedes`, `derived_from`: zero weight

The builder enforces the same edge-weight rules as the validator, so direct
`buildCell()` calls cannot silently create sign-inverted evidence.

## Cell Built By R0

`buildCell()` turns a valid proposal into a full `Cell`:

- stable `key`
- display `handle` in `kind_hex` form
- `scope` with project/tenant defaults
- ordered `scores` block
- `flags`, defaulting to safe baseline values
- `edgesOut`, with signed weights
- `sourceRefs`
- `lineage`, initially empty
- `programs`, initially empty; R3+ attaches standing program ids
- `provenance`
- `tags`
- `policy`
- `props`
- timestamps
- `status: "active"`

Default score derivation:

- `conf = proposal.confidence`
- `uncertainty = (1 - confidence) * 0.7` unless stated
- `concern = (1 - confidence) * 0.3` unless stated
- `sourceQuality`: `1` for confidence `>= .8`, `.66` for `>= .5`, `.33` for `> 0`
- `actorCalibration = 1`
- `effective = confidence`
- `currencyC0 = 1`, `currency = 1`
- `salienceSeed = .5`, `salience = .5`

## Addressing And Rendering

Mutable handles are validated as lowercase `kind_hex`, with an optional subject
facet in the middle, for example `dec_a3ee` or `dec_auth_a3ee`. Immutable constant
handles may be capitalized, for example `RECALL_v5`.

Path syntax:

- `_` joins words inside a handle
- `-` walks fields inside a cell: `dec_a3ee-scores-conf`
- `.` crosses graph edges: `dec_a3ee.supports`
- `>` marks forward edge traversal
- `<` or `~` marks reverse edge traversal
- `@vN` selects a version on the supersession chain
- `*` is wildcard fanout

Values render as `field(value)`; immutable numeric anchors render as
`field(value!)`, for example `conf(0.7!)`.

The mini-index renderer emits handle, title, confidence, effective, currency,
salience, flag bits, outgoing edge count, and attached program count. Incoming
degree requires store context and is therefore R2/R4 territory.

## R0 Boundary

R0 does not:

- inspect secrets
- calibrate actors
- deduplicate writes
- resolve graph edge hops through a store
- resolve supersession heads
- run operator ticks
- attach or execute standing programs
- provide CLI/MCP surfaces

Those belong to R1 and later subsystems. R0 only makes malformed input difficult
to admit and gives later layers a stable, typed cell shape.
