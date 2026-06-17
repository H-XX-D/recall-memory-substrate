#!/usr/bin/env python3
"""
recall_code_link.py — Create typed hyperedge relations between code cells.

After `recall_code_extract.py` admits module/symbol cells with entity tags
(`py-sym:<name>`, `py-ref:<name>`, `py-import:<module>`), this linker walks
the graph for a project, resolves references against definitions, and
creates typed hyperedges to materialize the dependencies as graph edges.

Edges created (hyperedge `kind` values):

| Kind | Source role | Target role | Meaning |
|---|---|---|---|
| `code-defined-in` | `symbol` | `module` | symbol cell is defined in module cell (same scope.path) |
| `code-references` | `referrer` | `referent` | symbol's body calls or references another symbol |
| `code-imports` | `importer` | `imported` | module imports another module (matched by file stem) |
| `code-method-of` | `method` | `class` | method cell belongs to class cell (matched via py-sym:<class>) |

Usage:

    # Discover and report intended edges (no writes):
    python3 recall_code_link.py --project my-repo

    # Create the hyperedges:
    python3 recall_code_link.py --project my-repo --apply

    # JSONL report of intended edges (for jq / inspection):
    python3 recall_code_link.py --project my-repo --out edges.jsonl

Idempotence (v1): re-running with --apply creates duplicate hyperedges
(no dedup). Use --skip-existing to query existing hyperedges first and
skip ones with matching (kind, source, target) — slower but idempotent.

Resolution semantics:

- `py-ref:X` resolves against cells with `py-sym:X` in their entities.
  Multiple matches create multiple edges (the linker doesn't disambiguate
  by call site; future v2 could use AST scope analysis to narrow).
- `py-import:foo.bar.X` resolves by matching the trailing component (`X`)
  against module file stems. Cross-package imports may not resolve.
- Self-references (cell references itself by py-ref:<own-name>) are
  skipped to avoid noise.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from collections import defaultdict
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

# Reuse defaults from helper
sys.path.insert(0, str(Path(__file__).parent))
from recall_helper import DEFAULT_DB  # noqa: E402


# ---- Data ----

@dataclass
class LinkEdge:
    """A discovered link between two code cells."""
    kind: str
    source_id: str
    source_role: str
    target_id: str
    target_role: str
    title: str
    rationale: str  # short text explaining why this link exists

    def to_hyperedge(self) -> dict:
        return {
            "kind": self.kind,
            "title": self.title[:200],
            "members": [
                {"nodeId": self.source_id, "role": self.source_role},
                {"nodeId": self.target_id, "role": self.target_role},
            ],
            "metadata": {
                "rationale": self.rationale,
                "created_by": "recall_code_link",
            },
        }

    def to_report_dict(self) -> dict:
        return {
            "kind": self.kind,
            "title": self.title,
            "source": {"id": self.source_id, "role": self.source_role},
            "target": {"id": self.target_id, "role": self.target_role},
            "rationale": self.rationale,
        }


# ---- Graph queries ----

def fetch_code_cells(project: str, db: str) -> list[dict]:
    """Query Recall for all code cells in a project via subgraph filter."""
    result = subprocess.run(
        ["recall", "subgraph",
         "--project", project,
         "--category", "code",
         "--db", db],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"recall subgraph failed: {result.stderr}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"recall subgraph returned non-JSON: {e}\n{result.stdout[:500]}")
    return payload.get("results", [])


def latest_generation(cells: list[dict]) -> list[dict]:
    """Keep only the newest cell per title.

    Re-extraction with --rebuild supersedes old code cells but keeps them in
    the graph for audit. Link discovery must target the active generation
    only — otherwise every edge is duplicated once per superseded generation
    (found by the 2026-06-11 dogfood run, finding F6).
    """
    newest: dict[str, dict] = {}
    for cell in cells:
        title = cell.get("title", "")
        prev = newest.get(title)
        if prev is None or cell.get("createdAt", "") > prev.get("createdAt", ""):
            newest[title] = cell
    return list(newest.values())


def fetch_existing_hyperedges(db: str, limit: int = 1000) -> list[dict]:
    """List existing hyperedges (for --skip-existing dedup)."""
    result = subprocess.run(
        ["recall", "hyperedge", "list", "--limit", str(limit), "--db", db],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        return []
    try:
        return json.loads(result.stdout).get("hyperedges", [])
    except json.JSONDecodeError:
        return []


# ---- Entity parsing ----

# Language-prefix namespaces for code entity tags. New language extractors
# (Python uses py-, JS uses js-, TS uses ts-, future Go/Rust would use go-/rs-)
# add their prefix here so the linker auto-discovers all language references.
LANG_PREFIXES = ("py", "js", "ts")


@dataclass
class CellEntities:
    """Parsed entity tags relevant to code linking, across all language prefixes."""
    symbols: list[str]   # <lang>-sym:<name>
    refs: list[str]      # <lang>-ref:<name>
    imports: list[str]   # <lang>-import:<module>


def parse_entities(cell: dict) -> CellEntities:
    """Extract code-relevant entity prefixes from a cell's tags.

    Resolves across all known language prefixes so a single linker run
    handles polyglot codebases without per-language invocations.
    """
    entities = cell.get("tags", {}).get("entities", [])
    symbols: list[str] = []
    refs: list[str] = []
    imports: list[str] = []
    for prefix in LANG_PREFIXES:
        sym_p = f"{prefix}-sym:"
        ref_p = f"{prefix}-ref:"
        imp_p = f"{prefix}-import:"
        for e in entities:
            if e.startswith(sym_p):
                symbols.append(e[len(sym_p):])
            elif e.startswith(ref_p):
                refs.append(e[len(ref_p):])
            elif e.startswith(imp_p):
                imports.append(e[len(imp_p):])
    return CellEntities(symbols=symbols, refs=refs, imports=imports)


def is_module_cell(cell: dict) -> bool:
    return "module" in cell.get("tags", {}).get("topics", [])


CODE_FILE_EXTS = (
    ".py", ".mjs", ".cjs", ".jsx", ".tsx", ".mts", ".cts", ".js", ".ts",
)


def strip_code_ext(name: str) -> str:
    for ext in CODE_FILE_EXTS:
        if name.endswith(ext):
            return name[: -len(ext)]
    return name


def cell_file_stem(cell: dict) -> str:
    """Return the file stem from scope.path (e.g., 'recall_helper' from 'a/b/recall_helper.py',
    'plans' from 'lib/plans.mjs')."""
    path = cell.get("scope", {}).get("path", "")
    name = path.rsplit("/", 1)[-1] if "/" in path else path
    return strip_code_ext(name)


def module_import_stem(imp: str) -> str:
    """File stem for an import specifier across languages.

    JS paths resolve by basename: './plans.mjs' → 'plans',
    '../lib/store.js' → 'store'. Node builtins ('node:fs') and bare package
    names match by their own name. Python dotted modules keep the trailing
    component: 'foo.bar.Baz' → 'Baz'.
    """
    if imp.startswith("node:"):
        return imp[5:]
    if "/" in imp or any(imp.endswith(ext) for ext in CODE_FILE_EXTS):
        return strip_code_ext(imp.rsplit("/", 1)[-1])
    return imp.rsplit(".", 1)[-1]


def cell_path(cell: dict) -> str:
    return cell.get("scope", {}).get("path", "")


# ---- Link discovery ----

def build_indices(cells: list[dict]) -> tuple[dict[str, list[str]], dict[str, list[str]], dict[str, list[str]]]:
    """Build lookup maps:
      defines: symbol_name -> [cell_ids that define it (py-sym)]
      modules_by_stem: file_stem -> [module cell_ids]
      cells_by_path: scope.path -> [cell_ids in that file]
    """
    defines: dict[str, list[str]] = defaultdict(list)
    modules_by_stem: dict[str, list[str]] = defaultdict(list)
    cells_by_path: dict[str, list[str]] = defaultdict(list)

    for cell in cells:
        cid = cell["id"]
        ents = parse_entities(cell)
        # Only SYMBOL cells define symbols; module cells list py-sym entries
        # for navigation but should not be treated as definers for ref-resolution.
        if not is_module_cell(cell):
            for sym in ents.symbols:
                defines[sym].append(cid)
        if is_module_cell(cell):
            modules_by_stem[cell_file_stem(cell)].append(cid)
        path = cell_path(cell)
        if path:
            cells_by_path[path].append(cid)

    return defines, modules_by_stem, cells_by_path


def discover_links(
    cells: list[dict],
    *,
    include_self_refs: bool = False,
) -> Iterator[LinkEdge]:
    """Walk cells and yield discovered LinkEdge instances."""
    cell_by_id = {c["id"]: c for c in cells}
    defines, modules_by_stem, cells_by_path = build_indices(cells)

    # 1. code-defined-in: every non-module cell with same scope.path as a module cell
    for path, cids_in_path in cells_by_path.items():
        mods = [cid for cid in cids_in_path if is_module_cell(cell_by_id[cid])]
        syms = [cid for cid in cids_in_path if not is_module_cell(cell_by_id[cid])]
        for sym_id in syms:
            for mod_id in mods:
                sym = cell_by_id[sym_id]
                mod = cell_by_id[mod_id]
                yield LinkEdge(
                    kind="code-defined-in",
                    source_id=sym_id, source_role="symbol",
                    target_id=mod_id, target_role="module",
                    title=f"defined-in: {sym['title'][:80]} ⇐ {mod['title'][:60]}",
                    rationale=f"same scope.path: {path}",
                )

    # 2. code-references: cell.refs[X] → cells defining X
    for cell in cells:
        cid = cell["id"]
        ents = parse_entities(cell)
        for ref in ents.refs:
            targets = defines.get(ref, [])
            for target_id in targets:
                if target_id == cid and not include_self_refs:
                    continue
                tgt = cell_by_id[target_id]
                yield LinkEdge(
                    kind="code-references",
                    source_id=cid, source_role="referrer",
                    target_id=target_id, target_role="referent",
                    title=f"references: {cell['title'][:60]} → {ref}",
                    rationale=f"py-ref:{ref} → py-sym:{ref} in {tgt['title'][:60]}",
                )

    # 3. code-imports: module cell imports another module cell (matched by file stem)
    for cell in cells:
        if not is_module_cell(cell):
            continue
        cid = cell["id"]
        ents = parse_entities(cell)
        for imp in ents.imports:
            # Match by language-aware file stem (JS relative paths, node
            # builtins, bare packages, Python dotted modules).
            candidates: list[str] = []
            stem = module_import_stem(imp)
            candidates.extend(modules_by_stem.get(stem, []))
            for target_id in candidates:
                if target_id == cid:
                    continue
                tgt = cell_by_id[target_id]
                yield LinkEdge(
                    kind="code-imports",
                    source_id=cid, source_role="importer",
                    target_id=target_id, target_role="imported",
                    title=f"imports: {cell['title'][:60]} → {imp}",
                    rationale=f"import '{imp}' matched module file stem '{stem}'",
                )

    # 4. code-method-of: method cell (title contains "method:" or has parent class)
    #    For now, detect via "method" topic added by methods-as-cells extraction.
    for cell in cells:
        if "method" not in cell.get("tags", {}).get("topics", []):
            continue
        cid = cell["id"]
        # The method's title is "method: <file>::<Class>.<method>", parent in name
        ents = parse_entities(cell)
        # First sym is the method's own qualified name; second is the parent class (if extractor added it)
        parent_candidates = [s for s in ents.symbols if "." not in s]
        # Pick parent from py-sym entries that match a known class
        for sym_name in parent_candidates:
            targets = defines.get(sym_name, [])
            for target_id in targets:
                target = cell_by_id.get(target_id)
                if not target or target["id"] == cid:
                    continue
                if "class" in target.get("tags", {}).get("topics", []):
                    yield LinkEdge(
                        kind="code-method-of",
                        source_id=cid, source_role="method",
                        target_id=target_id, target_role="class",
                        title=f"method-of: {cell['title'][:50]} ⇐ {target['title'][:50]}",
                        rationale=f"method's py-sym:{sym_name} matched a class cell",
                    )


# ---- Apply ----

def apply_edge(edge: LinkEdge, db: str) -> tuple[bool, str]:
    """Create a hyperedge via `recall hyperedge add`."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(edge.to_hyperedge(), f)
        tmp = f.name
    try:
        result = subprocess.run(
            ["recall", "hyperedge", "add", "--json", tmp, "--db", db],
            capture_output=True, text=True, check=False,
        )
        if result.returncode == 0:
            return True, result.stdout
        return False, (result.stderr or result.stdout)[:500]
    finally:
        Path(tmp).unlink(missing_ok=True)


def _edge_signature(edge_or_he: dict | LinkEdge) -> tuple:
    """Stable signature for dedup: (kind, frozenset of (nodeId, role) pairs)."""
    if isinstance(edge_or_he, LinkEdge):
        members = ((edge_or_he.source_id, edge_or_he.source_role),
                   (edge_or_he.target_id, edge_or_he.target_role))
        kind = edge_or_he.kind
    else:
        members = tuple(sorted(
            (m["nodeId"], m.get("role", ""))
            for m in edge_or_he.get("members", [])
        ))
        kind = edge_or_he.get("kind", "")
    return (kind, frozenset(members))


# ---- CLI ----

def _cli() -> int:
    ap = argparse.ArgumentParser(
        description="Create typed hyperedge relations between extracted code cells.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  # Discover only (default): JSONL report to stdout:\n"
            "  recall_code_link.py --project my-repo\n\n"
            "  # Create the hyperedges:\n"
            "  recall_code_link.py --project my-repo --apply\n\n"
            "  # Idempotent re-run (skip edges that already exist):\n"
            "  recall_code_link.py --project my-repo --apply --skip-existing\n"
        ),
    )
    ap.add_argument("--project", required=True,
                    help="Recall project name to link.")
    ap.add_argument("--apply", action="store_true",
                    help="Actually create the hyperedges (default: report only).")
    ap.add_argument("--skip-existing", action="store_true",
                    help="Query existing hyperedges and skip duplicates (slower).")
    ap.add_argument("--include-self-refs", action="store_true",
                    help="Include cells that reference themselves.")
    ap.add_argument("--include-superseded", action="store_true",
                    help="Link against all cell generations, not just the "
                         "newest per title (default links the active "
                         "generation only).")
    ap.add_argument("--kinds", default=None,
                    help="Comma-separated edge kinds to create. Default: all four.")
    ap.add_argument("--limit", type=int, default=None,
                    help="Cap on edges processed (debug aid).")
    ap.add_argument("--out", default="-",
                    help="Report file path. Default '-' = stdout. JSONL format.")
    ap.add_argument("--db", default=DEFAULT_DB,
                    help=f"Recall DB path. Default: {DEFAULT_DB}")
    args = ap.parse_args()

    kinds_filter = None
    if args.kinds:
        kinds_filter = {k.strip() for k in args.kinds.split(",") if k.strip()}

    # Fetch cells
    print(f"Fetching code cells for project '{args.project}'...", file=sys.stderr)
    try:
        cells = fetch_code_cells(args.project, args.db)
        if not args.include_superseded:
            cells = latest_generation(cells)
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
    print(f"  {len(cells)} code cells found", file=sys.stderr)

    if not cells:
        print("No code cells to link. Run recall_code_extract.py first.", file=sys.stderr)
        return 0

    # Discover edges
    print("Discovering links...", file=sys.stderr)
    edges = list(discover_links(cells, include_self_refs=args.include_self_refs))
    if kinds_filter is not None:
        edges = [e for e in edges if e.kind in kinds_filter]
    print(f"  {len(edges)} edges discovered", file=sys.stderr)

    # Stats by kind
    by_kind: dict[str, int] = defaultdict(int)
    for e in edges:
        by_kind[e.kind] += 1
    for kind, count in sorted(by_kind.items()):
        print(f"    {kind}: {count}", file=sys.stderr)

    # Dedup against existing
    if args.skip_existing and args.apply:
        print("Fetching existing hyperedges for dedup...", file=sys.stderr)
        existing = fetch_existing_hyperedges(args.db, limit=10000)
        existing_sigs = {_edge_signature(he) for he in existing}
        before = len(edges)
        edges = [e for e in edges if _edge_signature(e) not in existing_sigs]
        skipped = before - len(edges)
        print(f"  {skipped} edges already exist, skipping; {len(edges)} new", file=sys.stderr)

    if args.limit is not None:
        edges = edges[:args.limit]

    # Apply or report
    if not args.apply:
        out_file = sys.stdout if args.out == "-" else open(args.out, "w")
        try:
            for e in edges:
                out_file.write(json.dumps(e.to_report_dict()) + "\n")
        finally:
            if out_file is not sys.stdout:
                out_file.close()
        print(f"Report written ({len(edges)} edges).", file=sys.stderr)
        if not args.apply:
            print("Use --apply to actually create the hyperedges.", file=sys.stderr)
        return 0

    # Apply
    print(f"Applying {len(edges)} hyperedges...", file=sys.stderr)
    n_ok = 0
    n_fail = 0
    for e in edges:
        ok, msg = apply_edge(e, args.db)
        if ok:
            n_ok += 1
        else:
            n_fail += 1
            print(f"  FAIL ({e.kind} {e.source_id} → {e.target_id}): {msg}", file=sys.stderr)
    print(f"  applied: {n_ok}, failed: {n_fail}", file=sys.stderr)
    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(_cli())
