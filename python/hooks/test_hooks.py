#!/usr/bin/env python3
"""
test_hooks.py — verification harness for Recall enforcement hooks.

Runs both hooks through a suite of representative inputs and checks
that each produces the correct shape of output for its scenario. This
exercises the contract the hooks are *supposed* to fulfill, not just
that they exit zero.

Run from anywhere:
    python3 python/hooks/test_hooks.py

Exit code: 0 if all checks pass, 1 otherwise.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

HOOKS = Path(__file__).parent
INJECT = HOOKS / "recall_inject_context.py.sample"
WRITEBACK = HOOKS / "recall_writeback_reminder.py.sample"
GUARD = HOOKS / "recall_pretooluse_guard.py.sample"
TRACKER = HOOKS / "longitudinal_tracker.py"
SCRIPTS = HOOKS.parent / "scripts"
SEMANTIC_REAL = SCRIPTS / "recall_semantic_real.py"
MPNET_ADAPTER = SCRIPTS / "recall_mpnet_embedder.py"

# ANSI for terminal output
G = "\033[32m"; R = "\033[31m"; Y = "\033[33m"; X = "\033[0m"


def run_hook(script: Path, stdin: str, env_overrides: dict | None = None) -> tuple[int, str, str]:
    env = os.environ.copy()
    if env_overrides:
        env.update(env_overrides)
    p = subprocess.run(
        ["python3", str(script)],
        input=stdin, capture_output=True, text=True, timeout=10, env=env,
    )
    return p.returncode, p.stdout, p.stderr


def check(name: str, ok: bool, detail: str = "") -> bool:
    mark = f"{G}PASS{X}" if ok else f"{R}FAIL{X}"
    print(f"  [{mark}] {name}" + (f" — {detail}" if detail and not ok else ""))
    return ok


def test_inject_topical() -> bool:
    print(f"\n{Y}TEST 1{X}: inject-context with topical query (graph has cells)")
    rc, out, _ = run_hook(INJECT, "tell me about cone winding")
    ok = True
    ok &= check("exits zero", rc == 0)
    ok &= check("emits a [recall: ...] header", "[recall:" in out and out.rstrip().endswith("]"))
    ok &= check("header is non-empty", len(out.strip()) > 10)
    ok &= check("header references a tool", "recall_" in out)
    return ok


def test_inject_temporal() -> bool:
    print(f"\n{Y}TEST 2{X}: inject-context with temporal query")
    rc, out, _ = run_hook(INJECT, "what changed since yesterday")
    ok = True
    ok &= check("exits zero", rc == 0)
    ok &= check("detects temporal intent", "temporal" in out.lower() or "diff" in out.lower())
    ok &= check("suggests recall_diff", "recall_diff" in out)
    return ok


def test_inject_identifier() -> bool:
    print(f"\n{Y}TEST 3{X}: inject-context with snake_case identifier")
    rc, out, _ = run_hook(INJECT, "find the build_proposal function")
    ok = True
    ok &= check("exits zero", rc == 0)
    ok &= check("emits non-empty header", "[recall:" in out)
    # Note: may either match (if cell exists) or fall back to generic — both are valid
    return ok


def test_inject_disabled() -> bool:
    print(f"\n{Y}TEST 4{X}: inject-context with RECALL_HOOK_DISABLE=1")
    rc, out, _ = run_hook(INJECT, "anything", env_overrides={"RECALL_HOOK_DISABLE": "1"})
    ok = True
    ok &= check("exits zero", rc == 0)
    ok &= check("emits NO header", "[recall:" not in out)
    return ok


def test_inject_json_input() -> bool:
    print(f"\n{Y}TEST 5{X}: inject-context with JSON-shaped stdin (hook-runtime style)")
    rc, out, _ = run_hook(INJECT, '{"prompt": "what changed today"}')
    ok = True
    ok &= check("exits zero", rc == 0)
    ok &= check("parses JSON and emits header", "[recall:" in out)
    return ok


def test_writeback_substantive() -> bool:
    print(f"\n{Y}TEST 6{X}: writeback-reminder with substantive signals (forced)")
    rc, out, _ = run_hook(
        WRITEBACK,
        "I found the root cause and the fix is to update the SOCKS config",
        env_overrides={"RECALL_WRITEBACK_FORCE": "1"},
    )
    ok = True
    ok &= check("exits zero", rc == 0)
    ok &= check("emits reminder", "[recall reminder]" in out)
    ok &= check("identifies signal words", "found" in out and "root cause" in out)
    ok &= check("includes write-helper template", "recall_helper.py" in out)
    ok &= check("template has --kind, --title, --confidence", all(f in out for f in ("--kind", "--title", "--confidence")))
    return ok


def test_writeback_trivial() -> bool:
    print(f"\n{Y}TEST 7{X}: writeback-reminder with trivial turn (no signals)")
    rc, out, _ = run_hook(WRITEBACK, "what time is it")
    ok = True
    ok &= check("exits zero", rc == 0)
    ok &= check("emits NO reminder (silent)", "[recall reminder]" not in out)
    return ok


def test_writeback_disabled() -> bool:
    print(f"\n{Y}TEST 8{X}: writeback-reminder with RECALL_WRITEBACK_DISABLE=1")
    rc, out, _ = run_hook(
        WRITEBACK,
        "I found the root cause",
        env_overrides={"RECALL_WRITEBACK_DISABLE": "1", "RECALL_WRITEBACK_FORCE": "1"},
    )
    ok = True
    ok &= check("exits zero", rc == 0)
    ok &= check("DISABLE overrides FORCE", "[recall reminder]" not in out)
    return ok


def test_writeback_signal_coverage() -> bool:
    print(f"\n{Y}TEST 9{X}: writeback-reminder catches each signal class")
    classes = [
        ("decision",   "we decided to use postgres"),
        ("discovery",  "discovered that the query plan changes"),
        ("fix",        "fixed the deadlock by reordering locks"),
        ("benchmark",  "benchmarked at 9.1x token reduction"),
        ("refactor",   "refactored the parser to use chevrotain"),
    ]
    ok = True
    for label, msg in classes:
        rc, out, _ = run_hook(WRITEBACK, msg, env_overrides={"RECALL_WRITEBACK_FORCE": "1"})
        ok &= check(f"catches '{label}' class", "[recall reminder]" in out, detail=f"input={msg!r}")
    return ok


def test_hooks_dont_block() -> bool:
    print(f"\n{Y}TEST 10{X}: hooks are non-blocking even on errors")
    # Point to a bogus DB path — hook should still exit zero and pass through
    bogus = "/tmp/nonexistent-recall-db-xyz.sqlite3"
    rc, out, _ = run_hook(INJECT, "anything", env_overrides={"RECALL_DB": bogus})
    ok = True
    ok &= check("inject exits zero on missing DB", rc == 0)
    rc, out, _ = run_hook(WRITEBACK, "I found a bug", env_overrides={"RECALL_DB": bogus})
    ok &= check("writeback exits zero on missing DB", rc == 0)
    return ok


# ===== PreToolUse guard tests =====

def _guard_payload(tool: str, **inp) -> str:
    return json.dumps({"tool_name": tool, "tool_input": inp})


def test_guard_passes_through_read_tools() -> bool:
    print(f"\n{Y}TEST 11{X}: guard is silent for non-mutating tools")
    # The hook should only be installed via matcher for Edit|Write|Bash, but
    # if it gets invoked for anything else (or with no tool name), it should
    # pass through cleanly. We test by passing an unrecognized tool name.
    rc, _, _ = run_hook(GUARD, _guard_payload("Read", file_path="/etc/hosts"))
    return check("guard exits 0 for non-guarded tool", rc == 0)


def test_guard_bypass_env() -> bool:
    print(f"\n{Y}TEST 12{X}: RECALL_GUARD_BYPASS allows any mutation")
    payload = _guard_payload("Edit", file_path="/src/critical.py")
    rc, _, _ = run_hook(GUARD, payload, env_overrides={"RECALL_GUARD_BYPASS": "1"})
    return check("bypass=1 → exit 0", rc == 0)


def test_guard_allowlist() -> bool:
    print(f"\n{Y}TEST 13{X}: allowlist permits matching paths")
    payload = _guard_payload("Write", file_path="/tmp/scratch.txt")
    rc, _, _ = run_hook(GUARD, payload,
                        env_overrides={"RECALL_GUARD_ALLOWLIST": "/tmp"})
    return check("allowlisted /tmp → exit 0", rc == 0)


def test_guard_blocks_unrationalized_edit() -> bool:
    print(f"\n{Y}TEST 14{X}: guard blocks Edit when no rationale found")
    # Point at a non-existent DB so the cold-start path triggers grace.
    # We need a real DB without a rationale to actually test the BLOCK.
    import tempfile
    tmp_db = tempfile.mktemp(suffix=".sqlite3", prefix="guard-test-")
    subprocess.run(["recall", "init", "--db", tmp_db], capture_output=True)
    payload = _guard_payload("Edit", file_path="/src/widget.py")
    rc, _, err = run_hook(
        GUARD, payload,
        env_overrides={"RECALL_DB": tmp_db, "RECALL_GUARD_WINDOW": "60"},
    )
    try: os.unlink(tmp_db)
    except FileNotFoundError: pass
    ok = True
    ok &= check("blocks with exit code 2", rc == 2)
    ok &= check("emits 'BLOCKED' message to stderr", "BLOCKED" in err)
    ok &= check("includes unblock command", "recall_helper.py" in err)
    ok &= check("names the target file", "widget" in err)
    return ok


def test_guard_allows_with_rationale() -> bool:
    print(f"\n{Y}TEST 15{X}: guard allows Edit when matching rationale exists")
    import tempfile
    tmp_db = tempfile.mktemp(suffix=".sqlite3", prefix="guard-test-")
    subprocess.run(["recall", "init", "--db", tmp_db], capture_output=True)
    # Write a rationale cell that mentions "widget"
    helper = HOOKS.parent / "scripts" / "recall_helper.py"
    subprocess.run([
        "python3", str(helper),
        "--kind", "decision",
        "--title", "refactor widget component",
        "--body", "Refactoring widget.py to use the new pattern because of test failures",
        "--confidence", "0.7", "--topics", "widget,refactor",
        "--project", "test-proj", "--admit", "--db", tmp_db,
    ], capture_output=True, text=True, timeout=15)
    payload = _guard_payload("Edit", file_path="/src/widget.py")
    rc, _, err = run_hook(
        GUARD, payload,
        env_overrides={"RECALL_DB": tmp_db, "RECALL_GUARD_WINDOW": "3600",
                       "RECALL_GUARD_VERBOSE": "1"},
    )
    try: os.unlink(tmp_db)
    except FileNotFoundError: pass
    ok = True
    ok &= check("allows with exit code 0", rc == 0)
    ok &= check("verbose log confirms approval", "approved" in err)
    return ok


def test_guard_destructive_bash() -> bool:
    print(f"\n{Y}TEST 16{X}: guard blocks destructive Bash without rationale")
    import tempfile
    tmp_db = tempfile.mktemp(suffix=".sqlite3", prefix="guard-test-")
    subprocess.run(["recall", "init", "--db", tmp_db], capture_output=True)
    payload = _guard_payload("Bash", command="rm -rf /tmp/old-cache")
    rc, _, err = run_hook(GUARD, payload, env_overrides={"RECALL_DB": tmp_db})
    try: os.unlink(tmp_db)
    except FileNotFoundError: pass
    ok = True
    ok &= check("blocks destructive rm -rf", rc == 2)
    ok &= check("identifies as 'destructive command'", "destructive command" in err)
    return ok


def test_guard_readonly_bash_allowed() -> bool:
    print(f"\n{Y}TEST 17{X}: guard ignores read-only Bash (ls, git status, etc.)")
    import tempfile
    tmp_db = tempfile.mktemp(suffix=".sqlite3", prefix="guard-test-")
    subprocess.run(["recall", "init", "--db", tmp_db], capture_output=True)
    ok = True
    for cmd in ["ls -la /tmp", "git status", "cat README.md", "grep foo bar.txt"]:
        payload = _guard_payload("Bash", command=cmd)
        rc, _, _ = run_hook(GUARD, payload, env_overrides={"RECALL_DB": tmp_db})
        ok &= check(f"read-only allowed: {cmd[:30]}", rc == 0)
    try: os.unlink(tmp_db)
    except FileNotFoundError: pass
    return ok


def test_guard_dry_run() -> bool:
    print(f"\n{Y}TEST 18{X}: dry-run mode emits block message but exits 0")
    import tempfile
    tmp_db = tempfile.mktemp(suffix=".sqlite3", prefix="guard-test-")
    subprocess.run(["recall", "init", "--db", tmp_db], capture_output=True)
    payload = _guard_payload("Edit", file_path="/src/anything.py")
    rc, _, err = run_hook(
        GUARD, payload,
        env_overrides={"RECALL_DB": tmp_db, "RECALL_GUARD_DRY_RUN": "1"},
    )
    try: os.unlink(tmp_db)
    except FileNotFoundError: pass
    ok = True
    ok &= check("dry-run exits 0", rc == 0)
    ok &= check("dry-run still emits BLOCKED message", "BLOCKED" in err)
    ok &= check("dry-run logs DRY_RUN notice", "DRY_RUN" in err)
    return ok


def test_guard_cold_start_grace() -> bool:
    print(f"\n{Y}TEST 19{X}: cold-start (missing DB) allows with warning")
    payload = _guard_payload("Edit", file_path="/src/anything.py")
    rc, _, err = run_hook(
        GUARD, payload,
        env_overrides={"RECALL_DB": "/tmp/nonexistent-cold-start.sqlite3"},
    )
    ok = True
    ok &= check("cold-start exits 0", rc == 0)
    ok &= check("cold-start emits initialization hint", "recall init" in err)
    return ok


# ===== Longitudinal tracker tests =====

def _run_tracker(args: list[str], env_overrides: dict | None = None) -> tuple[int, str, str]:
    env = os.environ.copy()
    if env_overrides:
        env.update(env_overrides)
    p = subprocess.run(["python3", str(TRACKER), *args],
                       capture_output=True, text=True, timeout=15, env=env)
    return p.returncode, p.stdout, p.stderr


def test_tracker_guard_writes_events() -> bool:
    print(f"\n{Y}TEST 20{X}: guard appends structured events to event log")
    import tempfile
    tmp_db = tempfile.mktemp(suffix=".sqlite3", prefix="track-test-")
    tmp_log = tempfile.mktemp(suffix=".jsonl", prefix="track-events-")
    subprocess.run(["recall", "init", "--db", tmp_db], capture_output=True)
    env = {"RECALL_DB": tmp_db, "RECALL_GUARD_EVENT_LOG": tmp_log}
    # Block event
    run_hook(GUARD, _guard_payload("Edit", file_path="/src/foo.py"), env_overrides=env)
    # Bypass event
    run_hook(GUARD, _guard_payload("Edit", file_path="/src/bar.py"),
             env_overrides={**env, "RECALL_GUARD_BYPASS": "1"})
    # Allowlist approve
    run_hook(GUARD, _guard_payload("Write", file_path="/tmp/x.txt"),
             env_overrides={**env, "RECALL_GUARD_ALLOWLIST": "/tmp"})
    ok = True
    ok &= check("event log file created", Path(tmp_log).exists())
    if Path(tmp_log).exists():
        events = [json.loads(line) for line in Path(tmp_log).read_text().splitlines() if line.strip()]
        outcomes = {e["outcome"] for e in events}
        ok &= check("logged 3 events", len(events) == 3)
        ok &= check("captured block, bypass, approve",
                    {"block", "bypass", "approve"}.issubset(outcomes))
        ok &= check("each event has ts + tool + target",
                    all("ts" in e and "tool" in e and "target" in e for e in events))
    for p in (tmp_db, tmp_log):
        try: os.unlink(p)
        except FileNotFoundError: pass
    return ok


def test_tracker_snapshot_and_report() -> bool:
    print(f"\n{Y}TEST 21{X}: tracker snapshot + report round-trip")
    import tempfile
    tmp_db = tempfile.mktemp(suffix=".sqlite3", prefix="track-test-")
    tmp_snap = tempfile.mktemp(suffix=".jsonl", prefix="snap-")
    tmp_log = tempfile.mktemp(suffix=".jsonl", prefix="ev-")
    subprocess.run(["recall", "init", "--db", tmp_db], capture_output=True)
    # Seed a rationale cell so the snapshot has something to measure
    helper = HOOKS.parent / "scripts" / "recall_helper.py"
    subprocess.run([
        "python3", str(helper),
        "--kind", "decision", "--title", "tracker seed",
        "--body", "Seed cell for tracker test. " + ("body padding " * 10),
        "--confidence", "0.82",
        "--topics", "tracker,seed",
        "--project", "track-test", "--admit", "--db", tmp_db,
    ], capture_output=True, text=True, timeout=15)

    env = {"RECALL_DB": tmp_db, "RECALL_LONGITUDINAL_LOG": tmp_snap,
           "RECALL_GUARD_EVENT_LOG": tmp_log}
    rc, out, _ = _run_tracker(["snapshot"], env_overrides=env)
    ok = True
    ok &= check("snapshot exits 0", rc == 0)
    ok &= check("snapshot file created", Path(tmp_snap).exists())

    rc, out, _ = _run_tracker(["report"], env_overrides=env)
    ok &= check("report exits 0", rc == 0)
    ok &= check("report mentions Rationale quality", "Rationale quality" in out)
    ok &= check("report mentions Continuity", "Continuity" in out)
    ok &= check("report shows verdict", "trajectory:" in out.lower() or "trajectory" in out)

    for p in (tmp_db, tmp_snap, tmp_log):
        try: os.unlink(p)
        except FileNotFoundError: pass
    return ok


def test_tracker_events_command() -> bool:
    print(f"\n{Y}TEST 22{X}: tracker events command surfaces recent events")
    import tempfile
    tmp_log = tempfile.mktemp(suffix=".jsonl", prefix="ev-")
    # Manually seed a couple events
    with open(tmp_log, "w") as f:
        f.write(json.dumps({"ts": "2026-05-25T00:00:00Z", "outcome": "block",
                            "tool": "Edit", "target": "/src/x.py"}) + "\n")
        f.write(json.dumps({"ts": "2026-05-25T00:01:00Z", "outcome": "approve",
                            "tool": "Edit", "target": "/src/x.py"}) + "\n")
    rc, out, _ = _run_tracker(["events", "--limit", "10"],
                              env_overrides={"RECALL_GUARD_EVENT_LOG": tmp_log})
    ok = True
    ok &= check("events exits 0", rc == 0)
    ok &= check("events output mentions Edit", "Edit" in out)
    ok &= check("events output shows outcomes", "block" in out and "approve" in out)
    try: os.unlink(tmp_log)
    except FileNotFoundError: pass
    return ok


def test_tracker_trend_needs_two_snapshots() -> bool:
    print(f"\n{Y}TEST 23{X}: tracker trend requires ≥2 snapshots")
    import tempfile
    tmp_snap = tempfile.mktemp(suffix=".jsonl", prefix="snap-")
    # No snapshots present
    rc, out, _ = _run_tracker(["trend"], env_overrides={"RECALL_LONGITUDINAL_LOG": tmp_snap})
    ok = check("trend with 0 snapshots → exit 1", rc == 1)
    try: os.unlink(tmp_snap)
    except FileNotFoundError: pass
    return ok


# ===== Real-embedding backend smoke tests =====
# These verify the SCRIPT CONTRACTS without requiring sentence-transformers
# to be installed. If sentence-transformers IS available, we exercise an
# actual embed; otherwise we verify the script reports the missing-dep
# error cleanly (non-crashing exit 2 with helpful stderr).

def _have_sentence_transformers() -> bool:
    p = subprocess.run(
        ["python3", "-c", "import sentence_transformers"],
        capture_output=True, text=True,
    )
    return p.returncode == 0


def test_mpnet_adapter_contract() -> bool:
    print(f"\n{Y}TEST 24{X}: mpnet adapter satisfies RECALL_EMBEDDING_COMMAND contract")
    payload = json.dumps({"text": "smoke test text", "dims": 256})
    p = subprocess.run(["python3", str(MPNET_ADAPTER)],
                       input=payload, capture_output=True, text=True, timeout=60)
    ok = True
    if _have_sentence_transformers():
        ok &= check("returns JSON vector when deps available", p.returncode == 0)
        if p.returncode == 0:
            try:
                vec = json.loads(p.stdout)
                ok &= check("vector is a number list", isinstance(vec, list) and all(isinstance(x, (int, float)) for x in vec))
                ok &= check("vector is 768-dim (mpnet native)", len(vec) == 768)
                norm = sum(x * x for x in vec) ** 0.5
                ok &= check("vector is normalized (|v|≈1)", abs(norm - 1.0) < 0.05)
            except json.JSONDecodeError as e:
                ok &= check(f"output parses as JSON: {e}", False)
    else:
        ok &= check("exits 2 with helpful message when deps missing", p.returncode == 2)
        ok &= check("stderr names sentence-transformers",
                    "sentence-transformers" in p.stderr)
    return ok


def test_mpnet_adapter_invalid_input() -> bool:
    print(f"\n{Y}TEST 25{X}: mpnet adapter handles invalid input gracefully")
    p = subprocess.run(["python3", str(MPNET_ADAPTER)],
                       input="not valid json", capture_output=True, text=True, timeout=15)
    ok = check("exits nonzero on invalid JSON", p.returncode != 0)
    ok &= check("stderr explains the failure", "JSON" in p.stderr or "json" in p.stderr)
    return ok


def test_semantic_real_help() -> bool:
    print(f"\n{Y}TEST 26{X}: recall_semantic_real script structure is valid")
    p = subprocess.run(["python3", str(SEMANTIC_REAL), "--help"],
                       capture_output=True, text=True, timeout=10)
    ok = True
    ok &= check("--help exits 0", p.returncode == 0)
    ok &= check("documents reindex subcommand", "reindex" in p.stdout)
    ok &= check("documents query subcommand", "query" in p.stdout)
    ok &= check("documents compare subcommand", "compare" in p.stdout)
    ok &= check("documents verify subcommand", "verify" in p.stdout)
    return ok


def test_semantic_real_status_runs() -> bool:
    print(f"\n{Y}TEST 27{X}: recall_semantic_real status reads an empty DB without crashing")
    import tempfile
    tmp_db = tempfile.mktemp(suffix=".sqlite3", prefix="semreal-")
    subprocess.run(["recall", "init", "--db", tmp_db], capture_output=True)
    p = subprocess.run(["python3", str(SEMANTIC_REAL), "status"],
                       env={**os.environ, "RECALL_DB": tmp_db},
                       capture_output=True, text=True, timeout=10)
    try: os.unlink(tmp_db)
    except FileNotFoundError: pass
    ok = check("status on empty DB exits 0", p.returncode == 0)
    ok &= check("status output mentions backends", "Backends indexed" in p.stdout)
    return ok


def main() -> int:
    tests = [
        test_inject_topical,
        test_inject_temporal,
        test_inject_identifier,
        test_inject_disabled,
        test_inject_json_input,
        test_writeback_substantive,
        test_writeback_trivial,
        test_writeback_disabled,
        test_writeback_signal_coverage,
        test_hooks_dont_block,
        test_guard_passes_through_read_tools,
        test_guard_bypass_env,
        test_guard_allowlist,
        test_guard_blocks_unrationalized_edit,
        test_guard_allows_with_rationale,
        test_guard_destructive_bash,
        test_guard_readonly_bash_allowed,
        test_guard_dry_run,
        test_guard_cold_start_grace,
        test_tracker_guard_writes_events,
        test_tracker_snapshot_and_report,
        test_tracker_events_command,
        test_tracker_trend_needs_two_snapshots,
        test_mpnet_adapter_contract,
        test_mpnet_adapter_invalid_input,
        test_semantic_real_help,
        test_semantic_real_status_runs,
    ]
    print(f"Running {len(tests)} hook tests...\n")
    results = [t() for t in tests]
    passed = sum(results)
    total = len(results)
    print(f"\n{'='*60}")
    color = G if passed == total else R
    print(f"{color}{passed}/{total} tests passed{X}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
