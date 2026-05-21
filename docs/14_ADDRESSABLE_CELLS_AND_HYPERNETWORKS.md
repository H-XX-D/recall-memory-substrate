# Addressable Cells And Hypernetworks

Recall graph nodes are addressable cells.

## Cell Address

```text
recall://cell/<project>/<category>/<type>/<subject>/<idea>/<timestamp>/<id>
```

Facet tags are optional on write. Recall derives missing address parts from:

- scope project
- first topic
- intent kind
- content title
- provenance timestamp

## Hypernetwork Rule

The base Recall hypernetwork is general. It may contain cycles, contradictions,
reciprocal links, n-ray connections, and programmable hyperedges.

Do not make the whole hypernetwork a DAG.

## Optional DAG Overlays

DAGs are optional overlays for specific ordered processes:

- execution plans
- evidence pipelines
- verification chains
- adapter refresh sequences
- reproducible workflow traces

DAG overlays point at addressable cells. They are views over the hypernetwork,
not replacements for it.

Implemented commands:

```bash
recall dag add --json overlay.json
recall dag analyze <overlay-id>
recall dag analyze <overlay-id> --derive
recall dag list
```

Overlay shape:

```json
{
  "title": "Verification route",
  "nodeIds": ["cell-a", "cell-b", "cell-c"],
  "edges": [
    { "from": "cell-a", "to": "cell-b", "label": "direct" },
    { "from": "cell-a", "to": "cell-c", "label": "via" },
    { "from": "cell-c", "to": "cell-b", "label": "indirect" }
  ]
}
```

## Holonomy Witnesses

When a DAG overlay has multiple comparable paths between addressable cells,
Recall can check whether path transport is consistent.

The result should produce a normal witness:

- consistency witness when transports agree;
- concern witness when transports disagree;
- contradiction witness only when mismatch crosses a stricter threshold.

The current implementation returns analysis JSON with:

- `isDag`
- `topologicalOrder`
- `cycles`
- `witnesses`

Witnesses identify comparable multi-path transports whose signatures differ.
With `--derive`, those witnesses and concerns enter the normal admission path as
addressable graph cells.
