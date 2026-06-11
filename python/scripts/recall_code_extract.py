#!/usr/bin/env python3
"""
recall_code_extract.py — Extract Recall write proposals from a Python codebase.

Walks one or more Python source files / directories using the stdlib `ast`
module and emits schema-valid `recall.write.v1` proposals — one per
extracted symbol — to stdout as JSON Lines or to a target file.

What it extracts (v1):

- **Module cells** (kind=artifact, tags.type=[module]): one per .py file.
  Body includes file path, line count, top-level symbol list, and import
  list. Used as the anchor cell for all symbols defined in that file.
- **Symbol cells** (kind=artifact, tags.type=[function|class|async-function]):
  one per top-level def/class. Body includes signature, decorators, line
  range, docstring (if present), and a body excerpt.

Defaults that keep cell count bounded on real codebases:

- Skips private symbols (leading underscore) unless --include-private.
- Skips class methods at the cell level (the class cell summarizes them);
  use --methods-as-cells to expand.
- Skips files matching common ignore patterns (tests/, __pycache__, .venv,
  .git, etc.) unless --include-tests / --no-default-excludes.

Relations (typed graph edges):

- v1 emits `tags.entities` mentioning all referenced symbol names and
  imports. This makes cells findable by entity-based subgraph queries.
- Explicit typed relations (`depends_on` to imported modules, `supports`
  from test → function) are deferred to a separate `recall_code_link.py`
  linker pass that resolves stable code-refs to admitted cell addresses.

Usage:

    # Emit proposals to stdout, one per line (JSONL):
    python3 recall_code_extract.py --path src/ --project my-repo

    # Write to a file:
    python3 recall_code_extract.py --path src/ --project my-repo --out proposals.jsonl

    # Admit directly through the CLI write path (validates + admits each):
    python3 recall_code_extract.py --path src/ --project my-repo --admit

    # Dry run with summary stats only:
    python3 recall_code_extract.py --path src/ --project my-repo --stats-only

Idempotence note (v1): re-running creates new cells. Use --rebuild to
archive prior code cells for the same project first (TODO: not yet
implemented; for v1 the graph will accumulate duplicates on re-extraction).
The agent can use the most recent cells via `recall_search` ordered by time.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import subprocess
import sys
import tempfile
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

# Reuse the canonical write-side helper for proposal construction.
sys.path.insert(0, str(Path(__file__).parent))
from recall_helper import build_proposal, DEFAULT_DB  # noqa: E402


# ---- Defaults ----

DEFAULT_EXCLUDES = (
    "__pycache__", ".git", ".venv", "venv", ".env", "env",
    "node_modules", "dist", "build", ".tox", ".pytest_cache",
    ".mypy_cache", ".ruff_cache", "site-packages",
)
TEST_PATTERNS = ("tests/", "test_", "_test.py", "/tests/")
MAX_BODY_EXCERPT_CHARS = 2000


# ---- Data classes ----

@dataclass
class ExtractedSymbol:
    """A symbol extracted from a Python source file."""
    file_path: str  # relative-to-repo path
    name: str  # symbol name
    kind: str  # function | async-function | class | method
    lineno: int
    end_lineno: int
    signature: str  # e.g., "def foo(x: int, y: str = 'a') -> bool"
    docstring: str  # may be empty
    decorators: list[str] = field(default_factory=list)
    body_excerpt: str = ""  # source-code excerpt, capped
    parent: str | None = None  # parent class name if this is a method
    calls: list[str] = field(default_factory=list)  # names referenced in body
    is_test: bool = False  # heuristic: name starts with test_ or in tests/


@dataclass
class ExtractedModule:
    """A Python module (file)."""
    file_path: str
    line_count: int
    docstring: str
    imports: list[str] = field(default_factory=list)  # fully-qualified-ish
    symbol_names: list[str] = field(default_factory=list)
    is_test_module: bool = False


# ---- AST inspection helpers ----

def _signature(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    """Reconstruct a function signature string from the AST."""
    try:
        args_str = ast.unparse(node.args)
    except Exception:
        args_str = "(...)"
    returns = ""
    if node.returns is not None:
        try:
            returns = f" -> {ast.unparse(node.returns)}"
        except Exception:
            returns = " -> ..."
    prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
    return f"{prefix} {node.name}({args_str}){returns}"


def _class_signature(node: ast.ClassDef) -> str:
    """Reconstruct a class signature line."""
    bases = []
    for base in node.bases:
        try:
            bases.append(ast.unparse(base))
        except Exception:
            bases.append("...")
    base_str = f"({', '.join(bases)})" if bases else ""
    return f"class {node.name}{base_str}"


def _decorator_name(node: ast.expr) -> str:
    try:
        return ast.unparse(node)
    except Exception:
        return "<decorator>"


def _extract_imports(tree: ast.Module) -> list[str]:
    """Collect import statements as fully-qualified-ish names."""
    out: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                out.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            for alias in node.names:
                if mod:
                    out.append(f"{mod}.{alias.name}")
                else:
                    out.append(alias.name)
    # Dedupe while preserving order
    seen: set[str] = set()
    deduped: list[str] = []
    for name in out:
        if name not in seen:
            seen.add(name)
            deduped.append(name)
    return deduped


def _extract_calls(node: ast.AST) -> list[str]:
    """Walk a function/class body, collect bare names referenced (calls + attr roots).

    This is a lightweight reference scan, not a full symbol-resolution pass.
    """
    names: set[str] = set()
    for n in ast.walk(node):
        if isinstance(n, ast.Call):
            func = n.func
            if isinstance(func, ast.Name):
                names.add(func.id)
            elif isinstance(func, ast.Attribute):
                # Collect the root of the attribute chain
                root = func
                while isinstance(root, ast.Attribute):
                    root = root.value
                if isinstance(root, ast.Name):
                    names.add(root.id)
        elif isinstance(n, ast.Attribute):
            root = n
            while isinstance(root, ast.Attribute):
                root = root.value
            if isinstance(root, ast.Name) and root.id not in {"self", "cls"}:
                names.add(root.id)
    return sorted(names)


def _is_test_path(path: str) -> bool:
    p = path.lower()
    return any(pat in p for pat in TEST_PATTERNS)


def _body_excerpt(source_lines: list[str], lineno: int, end_lineno: int) -> str:
    """Return a capped excerpt of the source for lines [lineno, end_lineno]."""
    if not (1 <= lineno <= len(source_lines)):
        return ""
    end = min(end_lineno, len(source_lines))
    excerpt = "\n".join(source_lines[lineno - 1:end])
    if len(excerpt) > MAX_BODY_EXCERPT_CHARS:
        excerpt = excerpt[:MAX_BODY_EXCERPT_CHARS] + "\n... [truncated]"
    return excerpt


# ---- File walker ----

def iter_python_files(
    root: Path,
    excludes: Iterable[str] = DEFAULT_EXCLUDES,
    include_tests: bool = True,
) -> Iterator[Path]:
    """Yield .py files under root, respecting exclude patterns."""
    excludes_set = set(excludes)
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune excluded directories in-place so os.walk doesn't descend
        dirnames[:] = [d for d in dirnames if d not in excludes_set]
        for fn in filenames:
            if not fn.endswith(".py"):
                continue
            full = Path(dirpath) / fn
            rel = full.relative_to(root) if full.is_relative_to(root) else full
            rel_str = str(rel)
            if not include_tests and _is_test_path(rel_str):
                continue
            yield full


# ---- Extraction ----

def extract_file(
    path: Path,
    repo_root: Path,
    *,
    include_private: bool = False,
    methods_as_cells: bool = False,
) -> tuple[ExtractedModule, list[ExtractedSymbol]]:
    """Parse a Python file, return (module info, list of symbols)."""
    try:
        source = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError) as e:
        # Return empty extraction for un-parseable files
        rel = str(path.relative_to(repo_root)) if path.is_relative_to(repo_root) else str(path)
        return (
            ExtractedModule(file_path=rel, line_count=0, docstring=f"<unreadable: {e}>"),
            [],
        )

    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError as e:
        rel = str(path.relative_to(repo_root)) if path.is_relative_to(repo_root) else str(path)
        return (
            ExtractedModule(file_path=rel, line_count=len(source.splitlines()),
                            docstring=f"<syntax error: {e}>"),
            [],
        )

    source_lines = source.splitlines()
    rel_path = str(path.relative_to(repo_root)) if path.is_relative_to(repo_root) else str(path)
    is_test_module = _is_test_path(rel_path)

    module_info = ExtractedModule(
        file_path=rel_path,
        line_count=len(source_lines),
        docstring=ast.get_docstring(tree) or "",
        imports=_extract_imports(tree),
        is_test_module=is_test_module,
    )

    symbols: list[ExtractedSymbol] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if not include_private and node.name.startswith("_") and not node.name.startswith("__"):
                continue
            kind = "async-function" if isinstance(node, ast.AsyncFunctionDef) else "function"
            sym = ExtractedSymbol(
                file_path=rel_path,
                name=node.name,
                kind=kind,
                lineno=node.lineno,
                end_lineno=getattr(node, "end_lineno", node.lineno),
                signature=_signature(node),
                docstring=ast.get_docstring(node) or "",
                decorators=[_decorator_name(d) for d in node.decorator_list],
                body_excerpt=_body_excerpt(source_lines, node.lineno, getattr(node, "end_lineno", node.lineno)),
                calls=_extract_calls(node),
                is_test=is_test_module or node.name.startswith("test_"),
            )
            symbols.append(sym)
            module_info.symbol_names.append(node.name)

        elif isinstance(node, ast.ClassDef):
            if not include_private and node.name.startswith("_") and not node.name.startswith("__"):
                continue
            cls_sym = ExtractedSymbol(
                file_path=rel_path,
                name=node.name,
                kind="class",
                lineno=node.lineno,
                end_lineno=getattr(node, "end_lineno", node.lineno),
                signature=_class_signature(node),
                docstring=ast.get_docstring(node) or "",
                decorators=[_decorator_name(d) for d in node.decorator_list],
                body_excerpt=_body_excerpt(source_lines, node.lineno, getattr(node, "end_lineno", node.lineno)),
                calls=_extract_calls(node),
                is_test=is_test_module,
            )
            symbols.append(cls_sym)
            module_info.symbol_names.append(node.name)

            if methods_as_cells:
                for sub in node.body:
                    if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        if not include_private and sub.name.startswith("_") and not sub.name.startswith("__"):
                            continue
                        method_kind = "async-method" if isinstance(sub, ast.AsyncFunctionDef) else "method"
                        method_sym = ExtractedSymbol(
                            file_path=rel_path,
                            name=f"{node.name}.{sub.name}",
                            kind=method_kind,
                            lineno=sub.lineno,
                            end_lineno=getattr(sub, "end_lineno", sub.lineno),
                            signature=_signature(sub),
                            docstring=ast.get_docstring(sub) or "",
                            decorators=[_decorator_name(d) for d in sub.decorator_list],
                            body_excerpt=_body_excerpt(source_lines, sub.lineno, getattr(sub, "end_lineno", sub.lineno)),
                            calls=_extract_calls(sub),
                            parent=node.name,
                            is_test=is_test_module or sub.name.startswith("test_"),
                        )
                        symbols.append(method_sym)

    return module_info, symbols


# ---- Proposal construction ----

def module_to_proposal(mod: ExtractedModule, *, project: str, repo_label: str) -> dict:
    """Build a Recall proposal for a module-level cell."""
    body_parts = [
        f"# Module: {mod.file_path}",
        "",
        f"Line count: {mod.line_count}",
    ]
    if mod.docstring:
        body_parts.extend(["", "## Module docstring", "", mod.docstring])
    if mod.imports:
        body_parts.extend(["", "## Imports", ""])
        body_parts.extend(f"- `{imp}`" for imp in mod.imports[:40])
        if len(mod.imports) > 40:
            body_parts.append(f"- ... ({len(mod.imports) - 40} more)")
    if mod.symbol_names:
        body_parts.extend(["", "## Top-level symbols", ""])
        body_parts.extend(f"- `{name}`" for name in mod.symbol_names[:50])
        if len(mod.symbol_names) > 50:
            body_parts.append(f"- ... ({len(mod.symbol_names) - 50} more)")
    body = "\n".join(body_parts)

    title = f"module: {mod.file_path}"
    # Build entities from file path components, imports, and symbol names
    entities = [repo_label, Path(mod.file_path).stem]
    entities.extend(f"py-import:{i}" for i in mod.imports[:10])
    entities.extend(f"py-sym:{s}" for s in mod.symbol_names[:15])

    topics = ["code", "python", "module"]
    if mod.is_test_module:
        topics.append("test-module")

    lifecycle = ["active", "code"]
    if mod.is_test_module:
        lifecycle.append("test")

    return build_proposal(
        kind="artifact",
        title=title,
        body=body,
        confidence=0.9,  # the source code itself is high-confidence factual
        topics=topics,
        source_files=[mod.file_path],
        project=project,
        rings=["runtime"],
        lifecycle=lifecycle,
        category=["code"],
        idea=[f"py-module-{Path(mod.file_path).stem}"],
        extra_entities=entities,
        path=mod.file_path,
        verification="checked",  # AST extraction is deterministic
        stability="volatile",  # code changes
    )


def symbol_to_proposal(sym: ExtractedSymbol, *, project: str, repo_label: str) -> dict:
    """Build a Recall proposal for a symbol-level cell (function/class/method)."""
    body_parts = [
        f"# {sym.kind}: {sym.name}",
        f"",
        f"**File:** `{sym.file_path}`",
        f"**Lines:** {sym.lineno}–{sym.end_lineno}",
        f"**Signature:** `{sym.signature}`",
    ]
    if sym.parent:
        body_parts.append(f"**Parent class:** `{sym.parent}`")
    if sym.decorators:
        body_parts.append(f"**Decorators:** {', '.join('`@'+d+'`' for d in sym.decorators)}")
    if sym.is_test:
        body_parts.append(f"**Is test:** yes")
    if sym.docstring:
        body_parts.extend(["", "## Docstring", "", sym.docstring])
    if sym.calls:
        body_parts.extend(["", "## References (calls / attribute roots)", ""])
        body_parts.extend(f"- `{c}`" for c in sym.calls[:30])
        if len(sym.calls) > 30:
            body_parts.append(f"- ... ({len(sym.calls) - 30} more)")
    if sym.body_excerpt:
        body_parts.extend(["", "## Source excerpt", "", "```python", sym.body_excerpt, "```"])
    body = "\n".join(body_parts)

    title = f"{sym.kind}: {sym.file_path}::{sym.name}"

    entities = [
        repo_label,
        Path(sym.file_path).stem,
        f"py-sym:{sym.name}",
    ]
    if sym.parent:
        entities.append(f"py-sym:{sym.parent}")
    entities.extend(f"py-ref:{c}" for c in sym.calls[:10])

    topics = ["code", "python", sym.kind]
    if sym.is_test:
        topics.append("test")
    if sym.parent:
        topics.append("method")

    lifecycle = ["active", "code"]
    if sym.is_test:
        lifecycle.append("test")

    return build_proposal(
        kind="artifact",
        title=title,
        body=body,
        confidence=0.9,
        topics=topics,
        source_files=[f"{sym.file_path}#L{sym.lineno}-L{sym.end_lineno}"],
        project=project,
        rings=["runtime"],
        lifecycle=lifecycle,
        category=["code"],
        idea=[f"py-{sym.kind}-{sym.name}"],
        subject=f"{Path(sym.file_path).stem}-{sym.name}",
        extra_entities=entities,
        path=sym.file_path,
        verification="checked",
        stability="volatile",
    )


# ---- Admit pipeline ----

def _admit_proposal(proposal: dict, db: str) -> tuple[bool, str | dict]:
    """Write proposal to temp file, validate, admit. Return (accepted, admit_result_or_error)."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(proposal, f)
        tmp_path = f.name
    try:
        v = subprocess.run(
            ["recall", "validate", "--json", tmp_path, "--db", db],
            capture_output=True, text=True, check=False,
        )
        try:
            v_result = json.loads(v.stdout)
        except json.JSONDecodeError:
            return False, f"validate output not JSON: {v.stdout}{v.stderr}"
        if not v_result.get("ok"):
            return False, f"validate failed: {v.stdout}"

        a = subprocess.run(
            ["recall", "admit", "--json", tmp_path, "--db", db],
            capture_output=True, text=True, check=False,
        )
        try:
            a_result = json.loads(a.stdout)
        except json.JSONDecodeError:
            return False, f"admit output not JSON: {a.stdout}{a.stderr}"
        if a_result.get("accepted"):
            return True, a_result
        return False, a.stdout
    finally:
        Path(tmp_path).unlink(missing_ok=True)


# ---- Rebuild support (preservation-discipline supersedure) ----

def _query_existing_cells_for_path(project: str, path: str, db: str) -> list[dict]:
    """Find existing code cells in (project, path). Returns list of cell dicts."""
    result = subprocess.run(
        ["recall", "subgraph",
         "--project", project,
         "--category", "code",
         "--db", db],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        return []
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return []
    return [c for c in payload.get("results", [])
            if c.get("scope", {}).get("path") == path]


def _create_superseded_edge(old_cell_id: str, new_cell_id: str, db: str,
                            title: str, rationale: str) -> tuple[bool, str]:
    """Create a code-superseded-by hyperedge from old → new."""
    he = {
        "kind": "code-superseded-by",
        "title": title[:200],
        "members": [
            {"nodeId": old_cell_id, "role": "superseded"},
            {"nodeId": new_cell_id, "role": "successor"},
        ],
        "metadata": {"rationale": rationale, "created_by": "recall_code_extract --rebuild"},
    }
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(he, f)
        tmp = f.name
    try:
        result = subprocess.run(
            ["recall", "hyperedge", "add", "--json", tmp, "--db", db],
            capture_output=True, text=True, check=False,
        )
        return result.returncode == 0, (result.stderr or result.stdout)[:300]
    finally:
        Path(tmp).unlink(missing_ok=True)


def _supersede_old_with_new(
    old_cells: list[dict],
    new_id_by_title: dict[str, str],
    fallback_new_id: str | None,
    db: str,
) -> tuple[int, int, int]:
    """For each old cell, find a matching new cell by title and create a
    code-superseded-by hyperedge. Old cells with no title match get superseded
    by `fallback_new_id` (usually the new module cell) with a "deleted" rationale.

    Returns (matched, fallback, failed) counts.
    """
    matched = 0
    fallback = 0
    failed = 0
    for old in old_cells:
        old_id = old["id"]
        old_title = old.get("title", "")
        new_id = new_id_by_title.get(old_title)
        if new_id:
            ok, _ = _create_superseded_edge(
                old_id, new_id, db,
                title=f"superseded: {old_title[:120]}",
                rationale="re-extracted by recall_code_extract --rebuild; new cell is the current state",
            )
            if ok:
                matched += 1
            else:
                failed += 1
        elif fallback_new_id:
            ok, _ = _create_superseded_edge(
                old_id, fallback_new_id, db,
                title=f"superseded (no successor): {old_title[:100]}",
                rationale="symbol removed from source on re-extraction; superseded by current module cell",
            )
            if ok:
                fallback += 1
            else:
                failed += 1
    return matched, fallback, failed


# ---- CLI ----

def _cli() -> int:
    ap = argparse.ArgumentParser(
        description="Extract Recall write proposals from a Python codebase.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  # JSONL to stdout:\n"
            "  recall_code_extract.py --path src/ --project my-repo\n\n"
            "  # Admit each proposal directly:\n"
            "  recall_code_extract.py --path src/ --project my-repo --admit\n\n"
            "  # Stats only (count of modules/symbols, no proposals emitted):\n"
            "  recall_code_extract.py --path src/ --project my-repo --stats-only\n"
        ),
    )
    ap.add_argument("--path", required=True, help="File or directory to extract from.")
    ap.add_argument("--project", required=True, help="Project name for scope.project tag.")
    ap.add_argument("--repo-label", default=None,
                    help="Repository label for entities. Defaults to --project.")
    ap.add_argument("--include-private", action="store_true",
                    help="Include symbols starting with _ (excludes dunder unless include-private).")
    ap.add_argument("--include-tests", action="store_true",
                    help="Include test files (matched by path heuristic). Default: include.")
    ap.add_argument("--exclude-tests", action="store_true",
                    help="Exclude test files from extraction.")
    ap.add_argument("--methods-as-cells", action="store_true",
                    help="Emit a cell for each class method, not just class cells.")
    ap.add_argument("--out", default="-",
                    help="Output file path. Default '-' = stdout. Always JSONL.")
    ap.add_argument("--stats-only", action="store_true",
                    help="Emit no proposals; print summary stats to stderr and exit.")
    ap.add_argument("--admit", action="store_true",
                    help="Validate and admit each proposal via the CLI write path.")
    ap.add_argument("--db", default=DEFAULT_DB,
                    help=f"Recall DB path. Default: {DEFAULT_DB}")
    ap.add_argument("--limit", type=int, default=None,
                    help="Cap on number of proposals emitted (debug aid).")
    ap.add_argument("--rebuild", action="store_true",
                    help=("Idempotent re-extraction: after admitting new cells, query "
                          "old cells for the same scope.path and create "
                          "code-superseded-by hyperedges from old → new (matched by title). "
                          "Old cells are preserved in the graph (audit trail). "
                          "Requires --admit."))
    args = ap.parse_args()

    if args.include_tests and args.exclude_tests:
        print("ERROR: --include-tests and --exclude-tests are mutually exclusive",
              file=sys.stderr)
        return 2

    include_tests = not args.exclude_tests  # default include
    repo_label = args.repo_label or args.project

    root = Path(args.path).resolve()
    if not root.exists():
        print(f"ERROR: path does not exist: {root}", file=sys.stderr)
        return 2

    # Build the file list (single file or walk directory)
    if root.is_file():
        if not root.name.endswith(".py"):
            print(f"ERROR: {root} is not a .py file", file=sys.stderr)
            return 2
        files = [root]
        # For single-file extraction the "repo root" is the file's parent
        repo_root = root.parent
    else:
        files = list(iter_python_files(root, include_tests=include_tests))
        repo_root = root

    if args.rebuild and not args.admit:
        print("--rebuild requires --admit (it operates on admitted cells).", file=sys.stderr)
        return 2

    # Open output sink
    out_file = sys.stdout if args.out == "-" else open(args.out, "w")
    try:
        n_modules = 0
        n_symbols = 0
        n_admitted = 0
        n_failed = 0
        emitted = 0
        # --rebuild tracking
        n_superseded_matched = 0
        n_superseded_fallback = 0
        n_superseded_failed = 0

        for f in files:
            mod, syms = extract_file(
                f, repo_root,
                include_private=args.include_private,
                methods_as_cells=args.methods_as_cells,
            )
            n_modules += 1
            n_symbols += len(syms)

            if args.stats_only:
                continue

            # --rebuild: snapshot existing cells for this file BEFORE admitting new ones
            old_cells: list[dict] = []
            if args.rebuild:
                old_cells = _query_existing_cells_for_path(args.project, mod.file_path, args.db)

            # Track new cell IDs by title for supersedure matching
            new_id_by_title: dict[str, str] = {}
            new_module_id: str | None = None

            # Module proposal
            if args.limit is None or emitted < args.limit:
                mod_prop = module_to_proposal(mod, project=args.project, repo_label=repo_label)
                if args.admit:
                    ok, result = _admit_proposal(mod_prop, args.db)
                    if ok:
                        n_admitted += 1
                        # Capture new cell ID for supersedure matching
                        if isinstance(result, dict):
                            new_id = result.get("node", {}).get("id")
                            if new_id:
                                new_module_id = new_id
                                new_id_by_title[mod_prop["content"]["title"]] = new_id
                    else:
                        n_failed += 1
                        print(f"ADMIT FAIL ({mod.file_path}): {result}", file=sys.stderr)
                else:
                    out_file.write(json.dumps(mod_prop) + "\n")
                emitted += 1

            # Symbol proposals
            for sym in syms:
                if args.limit is not None and emitted >= args.limit:
                    break
                sym_prop = symbol_to_proposal(sym, project=args.project, repo_label=repo_label)
                if args.admit:
                    ok, result = _admit_proposal(sym_prop, args.db)
                    if ok:
                        n_admitted += 1
                        if isinstance(result, dict):
                            new_id = result.get("node", {}).get("id")
                            if new_id:
                                new_id_by_title[sym_prop["content"]["title"]] = new_id
                    else:
                        n_failed += 1
                        print(f"ADMIT FAIL ({sym.file_path}::{sym.name}): {result}",
                              file=sys.stderr)
                else:
                    out_file.write(json.dumps(sym_prop) + "\n")
                emitted += 1

            # --rebuild: now create supersede edges from old cells → new ones (per file)
            if args.rebuild and old_cells:
                # Don't supersede cells we just created in this same run
                new_ids = set(new_id_by_title.values())
                old_to_supersede = [c for c in old_cells if c["id"] not in new_ids]
                m, fb, fl = _supersede_old_with_new(
                    old_to_supersede, new_id_by_title, new_module_id, args.db,
                )
                n_superseded_matched += m
                n_superseded_fallback += fb
                n_superseded_failed += fl
    finally:
        if out_file is not sys.stdout:
            out_file.close()

    # Summary to stderr
    print(f"--- recall_code_extract summary ---", file=sys.stderr)
    print(f"  files scanned:    {n_modules}", file=sys.stderr)
    print(f"  symbols extracted: {n_symbols}", file=sys.stderr)
    if args.admit:
        print(f"  cells admitted:   {n_admitted}", file=sys.stderr)
        print(f"  failures:         {n_failed}", file=sys.stderr)
        if args.rebuild:
            print(f"  old cells superseded (title match): {n_superseded_matched}", file=sys.stderr)
            print(f"  old cells superseded (fallback to module): {n_superseded_fallback}", file=sys.stderr)
            print(f"  supersede edges failed: {n_superseded_failed}", file=sys.stderr)
        return 1 if (n_failed > 0 or n_superseded_failed > 0) else 0
    elif not args.stats_only:
        print(f"  proposals emitted: {emitted}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
