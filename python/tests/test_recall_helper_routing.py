#!/usr/bin/env python3
"""test_recall_helper_routing.py — DB-routing regression tests for BOTH shipped
copies of recall_helper.py (the OSS library copy and the bundled Claude skill
copy).

Pins the model-A registry-location contract: the `projects` registry lives in
the home local (`<home>/db/home.sqlite3`), honoring RECALL_HOME / RECALL_GLOBAL_DB
exactly the way src/core/routing.ts resolves them. Neither the pre-model-A
single-file `~/.recall/recall.sqlite3` nor the old `global.sqlite3` is consulted.

Both copies are loaded under distinct module names and run through the same
battery, so the two cannot silently drift apart again.

Usage:
    python3 python/tests/test_recall_helper_routing.py
"""
from __future__ import annotations

import importlib.util
import os
import sqlite3
import sys
import tempfile
import types
from contextlib import contextmanager
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
COPIES = {
    "oss (python/scripts)": REPO / "python" / "scripts" / "recall_helper.py",
    "skill (integrations/claude)": (
        REPO / "integrations" / "claude" / "skill" / "scripts" / "recall_helper.py"
    ),
}

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


def load_helper(label: str, path: Path) -> types.ModuleType:
    """Import a recall_helper.py copy under a label-derived module name so two
    files that share the basename `recall_helper` don't collide in sys.modules.
    """
    mod_name = "recall_helper__" + "".join(c if c.isalnum() else "_" for c in label)
    spec = importlib.util.spec_from_file_location(mod_name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)
    return mod


# Env vars the resolvers read; saved/restored around every case so a test can
# never leak routing state into the next one (or into the real environment).
_ROUTING_ENV = ("RECALL_DB", "RECALL_GLOBAL_DB", "RECALL_HOME")


@contextmanager
def scratch_env(**overrides):
    """Apply env overrides (None clears a var) and an optional `_cwd`, restore both."""
    saved_env = {k: os.environ.get(k) for k in _ROUTING_ENV}
    saved_cwd = os.getcwd()
    try:
        for key in _ROUTING_ENV:
            os.environ.pop(key, None)
        cwd = overrides.pop("_cwd", None)
        for key, val in overrides.items():
            if val is not None:
                os.environ[key] = val
        if cwd:
            os.chdir(cwd)
        yield
    finally:
        os.chdir(saved_cwd)
        for key, val in saved_env.items():
            if val is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = val


def make_registry(db_path: Path, rows) -> None:
    """Create a model-A-shaped `projects` registry (root_path PK, db_path)."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "CREATE TABLE IF NOT EXISTS projects ("
        "  root_path TEXT PRIMARY KEY,"
        "  slug TEXT NOT NULL,"
        "  db_path TEXT NOT NULL UNIQUE,"
        "  description TEXT,"
        "  created_at TEXT NOT NULL)"
    )
    conn.executemany(
        "INSERT INTO projects(root_path, slug, db_path, description, created_at)"
        " VALUES(?,?,?,?,?)",
        [(root, slug, dbp, None, "2026-06-23T00:00:00Z") for root, slug, dbp in rows],
    )
    conn.commit()
    conn.close()


def run_battery(label: str, rh: types.ModuleType) -> None:
    print(f"\n[{label}]")

    # --- path resolvers ---
    with scratch_env():
        check(
            f"{label}: RECALL_HOME unset -> ~/.recall",
            rh._recall_home_dir() == os.path.expanduser("~/.recall"),
            rh._recall_home_dir(),
        )
    with scratch_env(RECALL_HOME="/tmp/recall-xyz"):
        check(f"{label}: RECALL_HOME honored", rh._recall_home_dir() == "/tmp/recall-xyz")
    with scratch_env(RECALL_HOME="/tmp/recall-home"):
        path = rh._registry_db_path()
        check(
            f"{label}: registry is <home>/db/home.sqlite3",
            path == os.path.join("/tmp/recall-home", "db", "home.sqlite3"),
            path,
        )
        check(f"{label}: registry is not global.sqlite3", "global.sqlite3" not in path)
        check(
            f"{label}: registry is not single-file recall.sqlite3",
            not path.endswith(os.path.join("recall-home", "recall.sqlite3")),
            path,
        )
    with scratch_env(RECALL_GLOBAL_DB="/tmp/custom-registry.sqlite3"):
        check(
            f"{label}: RECALL_GLOBAL_DB overrides registry",
            rh._registry_db_path() == "/tmp/custom-registry.sqlite3",
        )

    # --- RECALL_DB short-circuit ---
    with scratch_env(RECALL_DB="/tmp/explicit.sqlite3", RECALL_HOME="/tmp/whatever"):
        check(
            f"{label}: RECALL_DB short-circuits everything",
            rh._resolve_default_db() == "/tmp/explicit.sqlite3",
        )

    # --- cwd inside a registered project (and ancestor walk) ---
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp) / "home"
        # realpath: the resolver realpaths cwd and each root; on macOS /tmp is a
        # symlink, so the registered root must be realpath'd to match.
        proj_root = Path(os.path.realpath(tmp)) / "proj"
        (proj_root / "sub").mkdir(parents=True)
        proj_db = str(home / "db" / "proj.sqlite3")
        make_registry(home / "db" / "home.sqlite3", [(str(proj_root), "proj", proj_db)])
        with scratch_env(RECALL_HOME=str(home), _cwd=str(proj_root)):
            check(
                f"{label}: cwd == registered root -> project db",
                rh._resolve_default_db() == proj_db,
                rh._resolve_default_db(),
            )
        with scratch_env(RECALL_HOME=str(home), _cwd=str(proj_root / "sub")):
            check(
                f"{label}: cwd below registered root -> project db (ancestor walk)",
                rh._resolve_default_db() == proj_db,
                rh._resolve_default_db(),
            )

    # --- unregistered cwd falls back to home local ---
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp) / "home"
        registry = home / "db" / "home.sqlite3"
        registered = Path(os.path.realpath(tmp)) / "registered"
        registered.mkdir(parents=True)
        unrelated = Path(os.path.realpath(tmp)) / "unrelated"
        unrelated.mkdir(parents=True)
        make_registry(
            registry, [(str(registered), "registered", str(home / "db" / "r.sqlite3"))]
        )
        with scratch_env(RECALL_HOME=str(home), _cwd=str(unrelated)):
            check(
                f"{label}: unregistered cwd -> home local",
                rh._resolve_default_db() == str(registry),
                rh._resolve_default_db(),
            )

    # --- decisive: stale siblings (global.sqlite3 + single-file) are ignored ---
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp) / "home"
        db_dir = home / "db"
        proj_root = Path(os.path.realpath(tmp)) / "proj"
        proj_root.mkdir(parents=True)
        correct_db = str(db_dir / "correct.sqlite3")
        stale_db = str(db_dir / "STALE.sqlite3")
        single_db = str(db_dir / "SINGLEFILE.sqlite3")
        make_registry(db_dir / "home.sqlite3", [(str(proj_root), "proj", correct_db)])
        make_registry(db_dir / "global.sqlite3", [(str(proj_root), "proj", stale_db)])
        # The pre-model-A single-file location this copy used to read.
        make_registry(home / "recall.sqlite3", [(str(proj_root), "proj", single_db)])
        with scratch_env(RECALL_HOME=str(home), _cwd=str(proj_root)):
            resolved = rh._resolve_default_db()
            check(
                f"{label}: reads home.sqlite3, not global.sqlite3 / recall.sqlite3",
                resolved == correct_db,
                f"got {resolved!r}; stale={stale_db!r} single={single_db!r}",
            )

    # --- fresh install: missing registry -> home-local path (never crashes) ---
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp) / "home"  # nothing created under it
        with scratch_env(RECALL_HOME=str(home)):
            expected = os.path.join(str(home), "db", "home.sqlite3")
            check(
                f"{label}: missing registry -> home-local path default",
                rh._resolve_default_db() == expected,
                rh._resolve_default_db(),
            )


def main() -> int:
    print("recall_helper routing regression tests (both shipped copies)")
    for label, path in COPIES.items():
        if not path.exists():
            check(f"{label}: file exists at {path}", False)
            continue
        run_battery(label, load_helper(label, path))
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
