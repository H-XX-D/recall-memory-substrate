#!/usr/bin/env python3
"""toolkit_unit_tests.py — fast, DB-free regression tests for the code toolkit.

Pins the two extractor/linker bugs found by the 2026-06-11 dogfood run:
  F2: exported const data (e.g. `export const PLANS = {...}`) was not
      extracted as a symbol.
  F3: JS import specifiers ('./plans.mjs') resolved to the file *extension*
      under Python-style dot-splitting, so no code-imports edges were created;
      module cells likewise kept their '.mjs' suffix in the stem index.

Usage:
    python3 python/tests/toolkit_unit_tests.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from recall_code_extract_js import extract_file  # noqa: E402
from recall_code_link import (  # noqa: E402
    cell_file_stem,
    latest_generation,
    module_import_stem,
)

PASS = 0
FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}  {detail}")


def test_const_data_extraction(tmp: Path) -> None:
    src = tmp / "plans.mjs"
    src.write_text(
        'import { helper } from "./util.mjs";\n'
        "export const PLANS = {\n"
        '  starter: { id: "starter", monthlyUsd: 9 },\n'
        "};\n"
        "export const LIMIT = 25;\n"
        "const internal = { hidden: true };\n"
        "export const arrow = (x) => x + 1;\n"
        "export const fn = function named() { return 1; };\n"
        "export function getPlan(id) { return PLANS[id]; }\n"
    )
    _, symbols = extract_file(src, tmp)
    by_name = {s.name: s for s in symbols}

    check("F2: exported const object extracted", "PLANS" in by_name)
    check(
        "F2: const data has const-data kind",
        by_name.get("PLANS") is not None and by_name["PLANS"].kind == "const-data",
        f"kind={getattr(by_name.get('PLANS'), 'kind', None)}",
    )
    check("F2: exported const scalar extracted", "LIMIT" in by_name)
    check("F2: unexported const data skipped", "internal" not in by_name)
    check(
        "F2: arrow binding stays const-function",
        by_name.get("arrow") is not None and by_name["arrow"].kind == "const-function",
        f"kind={getattr(by_name.get('arrow'), 'kind', None)}",
    )
    check(
        "F2: function-expression binding not double-counted as data",
        by_name.get("fn") is not None and by_name["fn"].kind != "const-data",
        f"kind={getattr(by_name.get('fn'), 'kind', None)}",
    )
    check("F2: plain functions still extracted", "getPlan" in by_name)


def test_import_stem_resolution() -> None:
    cases = [
        ("./plans.mjs", "plans"),
        ("../lib/store.js", "store"),
        ("./subscriptions.mjs", "subscriptions"),
        ("node:fs", "fs"),
        ("react", "react"),
        ("foo.bar.Baz", "Baz"),          # python dotted module
        ("./component.tsx", "component"),
    ]
    for imp, want in cases:
        got = module_import_stem(imp)
        check(f"F3: stem('{imp}') == '{want}'", got == want, f"got '{got}'")


def test_cell_file_stem() -> None:
    cases = [
        ("lib/plans.mjs", "plans"),
        ("a/b/recall_helper.py", "recall_helper"),
        ("server.mjs", "server"),
        ("src/App.tsx", "App"),
    ]
    for path, want in cases:
        cell = {"scope": {"path": path}}
        got = cell_file_stem(cell)
        check(f"F3: cell stem('{path}') == '{want}'", got == want, f"got '{got}'")


def test_latest_generation() -> None:
    cells = [
        {"id": "old", "title": "module: lib/plans.mjs", "createdAt": "2026-06-10T01:00:00Z"},
        {"id": "new", "title": "module: lib/plans.mjs", "createdAt": "2026-06-11T01:00:00Z"},
        {"id": "only", "title": "module: server.mjs", "createdAt": "2026-06-10T01:00:00Z"},
    ]
    kept = {c["id"] for c in latest_generation(cells)}
    check("F6: superseded generation dropped", kept == {"new", "only"}, f"kept={kept}")


def main() -> int:
    import tempfile

    print("toolkit unit tests")
    with tempfile.TemporaryDirectory() as td:
        test_const_data_extraction(Path(td))
    test_import_stem_resolution()
    test_cell_file_stem()
    test_latest_generation()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
