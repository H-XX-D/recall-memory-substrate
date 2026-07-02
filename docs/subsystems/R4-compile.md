# R4 Compile / Push: current context packet contract

Date: 2026-06-26
Status: core compile/cell-context slice implemented on `rewrite/integration`

R4 turns the store retrieval surface into an agent-readable context packet. The
packet is intentionally ID-first: it carries enough text to orient the reader,
then gives expansion handles for exact cell inspection.

## Module Map

| Module | Role |
|--------|------|
| `src/compile.ts` | Store-backed mini-index retrieval, ID-first context packets, packet formatting |
| `src/cell-context.ts` | Lazy expansion of a packet handle into exact cell context and field previews |
| `src/render.ts` | MAL mini-index row rendering used by packet entries |

## Packet Contract

`compileContext(store, objective, opts)` returns:

- `objective`
- `compilerState`
- `relevantMemory`
- `activeBeliefs`
- `conflicts`
- `risks`
- `tasks`
- `cellState`
- `staleOrLowTrust`
- `suggestedNextActions`
- `expansionHandles`
- `wordCount`

The packet routes v5 kinds into sections:

- `bel` -> `activeBeliefs`
- `rsk` -> `risks`
- `tsk` and `obj` -> `tasks`
- everything else -> `relevantMemory`

Each selected cell contributes its MAL mini-index row, a compact cell-state line,
and its stable key in `expansionHandles`.

## Conflict Surfacing

For every selected cell, the packet scans incoming normalized edges. Active
incoming `contradicts` and `concerns` edges are surfaced in `conflicts`, and the
challenging source cell key is added to `expansionHandles`.

Cells that require review, have reverify/expiry policy, or whose effective
confidence collapsed below half their stated confidence are marked in
`staleOrLowTrust`.

## Lazy Expansion

`inspectCell(store, handle)` expands either a stable key or a display handle. A
field can be requested with `#`, for example:

```text
dec_a3ee#scores.effective
```

The result includes the full cell, an optional requested-field preview,
footprint metrics, incoming/outgoing neighbor links, and neighboring expansion
handles.

## Deferred From This Slice

- named pages/views
- full memory-health analysis
- standing program and hyperedge overlays
- reference translation against legacy `recall://` cell addresses
- CLI/MCP surfaces for compile and cell expansion
