#!/usr/bin/env python3
"""
recall_ci_ingest.py — Ingest CI test results into Recall as cells + hyperedges.

Closes the loop between "we have a cell about this function" and "this
function actually passes its tests." After a CI run produces a test
report, this tool walks the report and:

1. **Creates a Recall cell per test result**:
   - Passing tests → `kind=verification_result`, topics include `test`, `passed`
   - Failing tests → `kind=risk`, topics include `test`, `failed`
   - Skipped/errored tests → `kind=observation`, topics include status

2. **Creates typed hyperedges to the function-under-test**:
   - Passing tests → `test-supports` edge from result-cell to function-cell
   - Failing tests → `test-contradicts` edge from result-cell to function-cell
   - Resolution: strip `test_` prefix from test name, look up cells with
     matching `py-sym:` / `js-sym:` / `ts-sym:` entity in the project

Supported input formats (auto-detected by file extension or explicit `--format`):

- **pytest JSON** (`pytest --json-report`, or `pytest-json-report` plugin)
- **JUnit XML** (`pytest --junitxml=`, default for many runners)
- **simple** (one line per test: `STATUS NAME [DURATION] [FILE:LINE] [MESSAGE]`)

CLI:

    # pytest JSON ingest with cell + edge creation:
    recall_ci_ingest.py --results pytest-report.json --project my-repo --admit

    # JUnit XML (also auto-detected from .xml extension):
    recall_ci_ingest.py --results junit.xml --project my-repo --admit

    # Stats only (no writes), useful before committing:
    recall_ci_ingest.py --results report.json --project my-repo --stats-only

    # JSONL output (no admit), composable with other tools:
    recall_ci_ingest.py --results report.json --project my-repo --out cells.jsonl

Resolution semantics:

- Test name `test_foo_bar` matches a symbol named `foo_bar` (strip leading `test_`)
- Test name `TestClass.test_method` matches symbol `TestClass` or `method`
  (best-effort, both candidates tried)
- Test names that don't match any symbol still produce a result cell, but
  no hyperedge is created. The cell is searchable; an agent can manually
  link later if needed.
- Multi-match (same symbol name in different files) creates edges to all.

Idempotence (v1): re-ingesting the same report creates duplicate cells.
A future `--rebuild` flag could supersede prior test-result cells for
the same (project, test_name) pair. For now, document and skip.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from recall_helper import build_proposal, DEFAULT_DB  # noqa: E402


# ---- Data ----

@dataclass
class TestResult:
    """Normalized test result across input formats."""
    name: str  # full test ID (e.g., "tests/test_auth.py::test_validate_user")
    short_name: str  # leaf test name (e.g., "test_validate_user")
    status: str  # one of: passed | failed | skipped | error
    duration: float | None = None  # seconds
    file_path: str | None = None
    lineno: int | None = None
    message: str = ""  # failure/error message
    traceback: str = ""  # for failed/errored tests
    class_name: str | None = None  # parent class for class-based tests


@dataclass
class IngestStats:
    parsed: int = 0
    by_status: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    cells_admitted: int = 0
    cells_failed: int = 0
    edges_created: int = 0
    edges_skipped_no_match: int = 0
    edges_failed: int = 0


# ---- Parsers ----

def parse_pytest_json(path: Path) -> list[TestResult]:
    """Parse a pytest-json-report file."""
    with open(path) as f:
        data = json.load(f)
    results: list[TestResult] = []
    for t in data.get("tests", []):
        nodeid = t.get("nodeid", "")
        # nodeid format: "path/to/file.py::TestClass::test_method" or "path/to/file.py::test_func"
        parts = nodeid.split("::") if nodeid else []
        file_path = parts[0] if parts else None
        if len(parts) >= 3:
            class_name = parts[1]
            short = parts[-1]
        elif len(parts) == 2:
            class_name = None
            short = parts[1]
        else:
            class_name = None
            short = nodeid

        # Extract failure info if present
        outcome = t.get("outcome", "unknown")
        call_info = t.get("call", {})
        message = ""
        traceback = ""
        if outcome in ("failed", "error"):
            longrepr = call_info.get("longrepr", "") or t.get("longrepr", "")
            if isinstance(longrepr, dict):
                message = longrepr.get("message", "")
                traceback = longrepr.get("reprcrash", {}).get("message", "") or message
            else:
                # First line is usually the summary
                first_line = str(longrepr).strip().split("\n", 1)
                message = first_line[0] if first_line else ""
                traceback = str(longrepr)
        elif outcome == "skipped":
            message = t.get("setup", {}).get("longrepr", "") or ""

        results.append(TestResult(
            name=nodeid,
            short_name=short,
            status=outcome,
            duration=call_info.get("duration"),
            file_path=file_path,
            lineno=t.get("lineno"),
            message=message[:500] if message else "",
            traceback=traceback[:2000] if traceback else "",
            class_name=class_name,
        ))
    return results


def parse_junit_xml(path: Path) -> list[TestResult]:
    """Parse JUnit XML test report."""
    tree = ET.parse(path)
    root = tree.getroot()

    # Root is either <testsuite> or <testsuites>
    suites = [root] if root.tag == "testsuite" else root.findall("testsuite")
    results: list[TestResult] = []

    for suite in suites:
        suite_file = suite.get("file")  # not always present
        for tc in suite.findall("testcase"):
            class_name = tc.get("classname") or None
            name = tc.get("name", "")
            file_path = tc.get("file") or suite_file
            lineno = tc.get("line")
            try:
                duration = float(tc.get("time", "0"))
            except (TypeError, ValueError):
                duration = None

            # Determine status from child elements
            failure = tc.find("failure")
            error = tc.find("error")
            skipped = tc.find("skipped")
            if failure is not None:
                status = "failed"
                message = (failure.get("message") or "")[:500]
                traceback = (failure.text or "")[:2000]
            elif error is not None:
                status = "error"
                message = (error.get("message") or "")[:500]
                traceback = (error.text or "")[:2000]
            elif skipped is not None:
                status = "skipped"
                message = (skipped.get("message") or skipped.text or "")[:500]
                traceback = ""
            else:
                status = "passed"
                message = ""
                traceback = ""

            full_name = f"{class_name}::{name}" if class_name else name

            results.append(TestResult(
                name=full_name,
                short_name=name,
                status=status,
                duration=duration,
                file_path=file_path,
                lineno=int(lineno) if lineno and str(lineno).isdigit() else None,
                message=message,
                traceback=traceback,
                class_name=class_name,
            ))
    return results


SIMPLE_LINE_PAT = re.compile(
    r'^(?P<status>PASS|FAIL|ERROR|SKIP|passed|failed|error|skipped)\s+'
    r'(?P<name>\S+)'
    r'(?:\s+(?P<duration>\d+(?:\.\d+)?))?'
    r'(?:\s+(?P<file>\S+:\d+))?'
    r'(?:\s+(?P<message>.*))?$',
    re.IGNORECASE,
)


def parse_simple(path: Path) -> list[TestResult]:
    """Parse simple line-based test report:
        STATUS NAME [DURATION] [FILE:LINE] [MESSAGE]
    """
    results: list[TestResult] = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = SIMPLE_LINE_PAT.match(line)
        if not m:
            continue
        status_raw = m.group("status").lower()
        status_map = {"pass": "passed", "fail": "failed"}
        status = status_map.get(status_raw, status_raw)
        file_lineno = m.group("file")
        file_path = None
        lineno = None
        if file_lineno and ":" in file_lineno:
            file_path, _, ln = file_lineno.rpartition(":")
            try:
                lineno = int(ln)
            except ValueError:
                lineno = None
        try:
            duration = float(m.group("duration")) if m.group("duration") else None
        except (TypeError, ValueError):
            duration = None
        results.append(TestResult(
            name=m.group("name"),
            short_name=m.group("name").rsplit(".", 1)[-1].rsplit("::", 1)[-1],
            status=status,
            duration=duration,
            file_path=file_path,
            lineno=lineno,
            message=(m.group("message") or "")[:500],
        ))
    return results


def detect_format(path: Path) -> str:
    """Auto-detect input format by extension."""
    suffix = path.suffix.lower()
    if suffix == ".json":
        return "pytest"
    if suffix in (".xml", ".junit"):
        return "junit"
    return "simple"


def parse_results(path: Path, fmt: str) -> list[TestResult]:
    if fmt == "pytest":
        return parse_pytest_json(path)
    if fmt == "junit":
        return parse_junit_xml(path)
    if fmt == "simple":
        return parse_simple(path)
    raise ValueError(f"Unknown format: {fmt}")


# ---- Function-under-test resolution ----

def _candidate_symbol_names(test_result: TestResult) -> list[str]:
    """Heuristic: derive candidate function-under-test names from the test name.

    Common patterns handled:
        test_foo           → ["foo", "_foo", "test_foo"]
        test_foo_bar       → ["foo_bar", "_foo_bar", "test_foo_bar"]
        TestClass.test_x   → ["x", "_x", "Class", "_Class", "test_x"]
        testCamelCase      → ["CamelCase", "_CamelCase", "testCamelCase"]

    The leading-underscore variant covers the common case where helpers
    are named `_helper` in source but tested as `test_helper` (the
    underscore is omitted from the test name).
    """
    candidates: list[str] = []
    seen: set[str] = set()

    def _add(name: str) -> None:
        if name and name not in seen:
            seen.add(name)
            candidates.append(name)

    short = test_result.short_name

    # Strip leading test_ / test / Test prefix
    stripped = short
    for prefix in ("test_", "Test", "test"):
        if stripped.startswith(prefix):
            stripped = stripped[len(prefix):]
            break

    if stripped and stripped != short:
        bare = stripped.lstrip("_")
        _add(bare)
        # Also try the underscore-prefixed variant (private helper convention)
        _add("_" + bare)

    # Class-based: try parent class name variants too
    if test_result.class_name:
        cls = test_result.class_name
        cls_stripped = cls
        for prefix in ("Test", "test_"):
            if cls_stripped.startswith(prefix):
                cls_stripped = cls_stripped[len(prefix):]
                break
        if cls_stripped and cls_stripped != cls:
            bare_cls = cls_stripped.lstrip("_")
            _add(bare_cls)
            _add("_" + bare_cls)

    # Last resort: the full short name as-is
    _add(short)
    return candidates


def build_symbol_index(project: str, db: str) -> dict[str, list[str]]:
    """Build symbol_name -> [cell_ids] map from code cells in the project."""
    result = subprocess.run(
        ["recall", "subgraph", "--project", project, "--category", "code", "--db", db],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        return {}
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {}
    cells = payload.get("results", [])
    idx: dict[str, list[str]] = defaultdict(list)
    for cell in cells:
        topics = cell.get("tags", {}).get("topics", [])
        if "module" in topics:
            continue  # skip modules, only resolve to symbol cells
        for ent in cell.get("tags", {}).get("entities", []):
            for prefix in ("py-sym:", "js-sym:", "ts-sym:"):
                if ent.startswith(prefix):
                    name = ent[len(prefix):]
                    idx[name].append(cell["id"])
                    break
    return dict(idx)


# ---- Hyperedge creation ----

def _edge_kind_for_status(status: str) -> str | None:
    """Map test status to edge kind. Returns None if no edge should be created."""
    if status == "passed":
        return "test-supports"
    if status in ("failed", "error"):
        return "test-contradicts"
    # skipped / other statuses don't contradict the function-under-test;
    # they're informational. Skip edge creation.
    return None


def _create_test_edge(test_cell_id: str, target_cell_id: str,
                      status: str, db: str, title: str) -> tuple[bool, str]:
    """Create a test-supports or test-contradicts hyperedge."""
    kind = _edge_kind_for_status(status)
    if kind is None:
        return True, "skipped (no edge for this status)"
    test_role = "test-result"
    target_role = "function-under-test"
    he = {
        "kind": kind,
        "title": title[:200],
        "members": [
            {"nodeId": test_cell_id, "role": test_role},
            {"nodeId": target_cell_id, "role": target_role},
        ],
        "metadata": {"test_status": status, "created_by": "recall_ci_ingest"},
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


# ---- Cell construction ----

def test_result_to_proposal(t: TestResult, *, project: str, repo_label: str,
                            run_id: str) -> dict:
    """Build a Recall proposal for a single test result."""
    is_pass = t.status == "passed"
    is_fail = t.status in ("failed", "error")
    is_skip = t.status == "skipped"

    # Pick cell kind based on status
    if is_pass:
        kind = "verification_result"
    elif is_fail:
        kind = "risk"
    elif is_skip:
        kind = "observation"
    else:
        kind = "observation"

    title = f"test result: {t.short_name} [{t.status}]"

    body_lines = [
        f"# Test: {t.name}",
        "",
        f"**Status:** `{t.status}`",
    ]
    if t.duration is not None:
        body_lines.append(f"**Duration:** {t.duration:.3f}s")
    if t.file_path:
        loc = f"{t.file_path}:{t.lineno}" if t.lineno else t.file_path
        body_lines.append(f"**Location:** `{loc}`")
    if t.class_name:
        body_lines.append(f"**Test class:** `{t.class_name}`")
    body_lines.append(f"**CI run:** `{run_id}`")
    if t.message:
        body_lines.extend(["", "## Message", "", "```", t.message, "```"])
    if t.traceback and t.traceback != t.message:
        body_lines.extend(["", "## Traceback / detail", "", "```", t.traceback, "```"])
    body = "\n".join(body_lines)

    # Confidence reflects test outcome certainty (not the validity of the test itself)
    if is_pass or is_fail:
        confidence = 0.95
    elif is_skip:
        confidence = 0.5  # we know it was skipped but not why
    else:
        confidence = 0.7

    topics = ["test", t.status, "ci", "test-result"]
    lifecycle = ["active", "test-result"]
    if is_fail:
        lifecycle.append("failing")
    elif is_pass:
        lifecycle.append("passing")

    # Quality tag carries the verdict directly for downstream filtering
    quality = ["test-passed"] if is_pass else (["test-failed"] if is_fail else ["test-other"])

    entities = [
        repo_label,
        f"test:{t.short_name}",
        f"test-run:{run_id}",
    ]
    if t.class_name:
        entities.append(f"test-class:{t.class_name}")

    return build_proposal(
        kind=kind,
        title=title,
        body=body,
        confidence=confidence,
        topics=topics,
        source_files=[f"{t.file_path}#L{t.lineno}" if t.file_path and t.lineno
                      else (t.file_path or t.name)],
        project=project,
        rings=["runtime"],
        lifecycle=lifecycle,
        category=["test"],
        quality=quality,
        idea=[f"test-{t.short_name}-{t.status}"],
        subject=f"test-{t.short_name}",
        extra_entities=entities,
        path=t.file_path,
        verification="tested",  # the cell IS the verification record
        stability="ephemeral",  # test results are point-in-time snapshots
    )


# ---- CLI ----

def _cli() -> int:
    ap = argparse.ArgumentParser(
        description="Ingest CI test results into Recall as cells + typed hyperedges.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  # pytest JSON report, full ingest:\n"
            "  recall_ci_ingest.py --results pytest-report.json --project my-repo --admit\n\n"
            "  # JUnit XML (auto-detected from .xml extension):\n"
            "  recall_ci_ingest.py --results junit.xml --project my-repo --admit\n\n"
            "  # Stats-only preview:\n"
            "  recall_ci_ingest.py --results report.json --project my-repo --stats-only\n\n"
            "  # JSONL output (no admit, composable with jq):\n"
            "  recall_ci_ingest.py --results report.json --project my-repo --out cells.jsonl\n"
        ),
    )
    ap.add_argument("--results", required=True,
                    help="Path to test results file (pytest JSON / JUnit XML / simple).")
    ap.add_argument("--project", required=True,
                    help="Recall project name (used for cells AND for symbol resolution).")
    ap.add_argument("--repo-label", default=None,
                    help="Repository label for entity tags. Defaults to --project.")
    ap.add_argument("--format", choices=("auto", "pytest", "junit", "simple"),
                    default="auto", help="Input format. Default: auto-detect by extension.")
    ap.add_argument("--run-id", default=None,
                    help="CI run identifier (e.g., commit SHA or build number). "
                         "Auto-generated from timestamp if omitted.")
    ap.add_argument("--admit", action="store_true",
                    help="Validate and admit each cell + create hyperedges via CLI write path.")
    ap.add_argument("--no-edges", action="store_true",
                    help="Skip hyperedge creation (cells only).")
    ap.add_argument("--stats-only", action="store_true",
                    help="Print summary stats; emit no cells.")
    ap.add_argument("--out", default="-",
                    help="JSONL output file. Default '-' = stdout. (Ignored if --admit.)")
    ap.add_argument("--db", default=DEFAULT_DB,
                    help=f"Recall DB path. Default: {DEFAULT_DB}")
    args = ap.parse_args()

    results_path = Path(args.results)
    if not results_path.exists():
        print(f"ERROR: results file not found: {results_path}", file=sys.stderr)
        return 2

    fmt = args.format
    if fmt == "auto":
        fmt = detect_format(results_path)
    print(f"Parsing {results_path} as {fmt}...", file=sys.stderr)

    try:
        test_results = parse_results(results_path, fmt)
    except (ET.ParseError, json.JSONDecodeError, ValueError) as e:
        print(f"ERROR: failed to parse results: {e}", file=sys.stderr)
        return 2

    repo_label = args.repo_label or args.project
    run_id = args.run_id or f"run-{Path(results_path).stem}"

    stats = IngestStats(parsed=len(test_results))
    for t in test_results:
        stats.by_status[t.status] += 1

    print(f"  parsed {stats.parsed} test results", file=sys.stderr)
    for status, count in sorted(stats.by_status.items()):
        print(f"    {status}: {count}", file=sys.stderr)

    if args.stats_only:
        return 0

    # Build symbol index for function-under-test resolution (only when admitting)
    sym_index: dict[str, list[str]] = {}
    if args.admit and not args.no_edges:
        print(f"Indexing code cells for project '{args.project}'...", file=sys.stderr)
        sym_index = build_symbol_index(args.project, args.db)
        print(f"  indexed {len(sym_index)} distinct symbol names", file=sys.stderr)

    out_file = sys.stdout if args.out == "-" else open(args.out, "w")
    try:
        for t in test_results:
            proposal = test_result_to_proposal(
                t, project=args.project, repo_label=repo_label, run_id=run_id,
            )
            if not args.admit:
                out_file.write(json.dumps(proposal) + "\n")
                continue

            # Admit the cell
            # Reuse the helper-style admit (lazy import to avoid circular dependency)
            from recall_code_extract import _admit_proposal  # noqa: E402
            ok, result = _admit_proposal(proposal, args.db)
            if not ok:
                stats.cells_failed += 1
                print(f"  CELL ADMIT FAIL ({t.short_name}): {result}", file=sys.stderr)
                continue
            stats.cells_admitted += 1

            test_cell_id = None
            if isinstance(result, dict):
                test_cell_id = result.get("node", {}).get("id")

            # Skip edge creation if no edges flag or no cell ID returned
            if args.no_edges or not test_cell_id:
                continue

            # Resolve function-under-test and create typed hyperedge
            candidates = _candidate_symbol_names(t)
            target_ids: list[str] = []
            for name in candidates:
                ids = sym_index.get(name, [])
                target_ids.extend(ids)
                if ids:
                    break  # use first matching candidate name

            # Skip edge creation entirely for statuses that don't map to a meaningful edge
            edge_kind = _edge_kind_for_status(t.status)
            if edge_kind is None:
                continue

            if not target_ids:
                stats.edges_skipped_no_match += 1
                continue

            for target_id in target_ids:
                title = (
                    f"{edge_kind}: "
                    f"{t.short_name} ↦ {candidates[0] if candidates else t.short_name}"
                )
                edge_ok, edge_msg = _create_test_edge(
                    test_cell_id, target_id, t.status, args.db, title,
                )
                if edge_ok:
                    stats.edges_created += 1
                else:
                    stats.edges_failed += 1
                    print(f"  EDGE FAIL ({t.short_name} → {target_id[:8]}): {edge_msg}",
                          file=sys.stderr)
    finally:
        if out_file is not sys.stdout:
            out_file.close()

    print(f"--- recall_ci_ingest summary ---", file=sys.stderr)
    print(f"  parsed:           {stats.parsed}", file=sys.stderr)
    for status, count in sorted(stats.by_status.items()):
        print(f"    {status}: {count}", file=sys.stderr)
    if args.admit:
        print(f"  cells admitted:   {stats.cells_admitted}", file=sys.stderr)
        print(f"  cells failed:     {stats.cells_failed}", file=sys.stderr)
        if not args.no_edges:
            print(f"  edges created:    {stats.edges_created}", file=sys.stderr)
            print(f"  edges skipped (no match): {stats.edges_skipped_no_match}", file=sys.stderr)
            print(f"  edges failed:     {stats.edges_failed}", file=sys.stderr)
        return 1 if (stats.cells_failed > 0 or stats.edges_failed > 0) else 0
    else:
        print(f"  proposals emitted: {stats.parsed}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
