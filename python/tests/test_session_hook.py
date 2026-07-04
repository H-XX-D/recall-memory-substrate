"""Subprocess tests for the packaged Claude session hook.

Drives integrations/claude/hooks/recall-session-start.py the way Claude Code
does: stdin JSON, mode flags, and a `recall` binary on PATH. Everything runs
against a temp HOME and RECALL_HOME; no real user state is touched.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
HOOK = ROOT / "integrations" / "claude" / "hooks" / "recall-session-start.py"
CLI = ROOT / "dist" / "cli.js"

STALE_REVERIFY = "2999-01-01T00:00:00Z"


def scrubbed_env(**extra: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in {"RECALL_DB", "RECALL_HOME", "RECALL_CLI"}}
    env.update(extra)
    return env


def admit(db: str, proposal: dict) -> dict:
    proc = subprocess.run(
        ["node", str(CLI), "admit", "--json", "-", "--db", db],
        cwd=ROOT,
        env=scrubbed_env(),
        text=True,
        capture_output=True,
        input=json.dumps(proposal),
        check=False,
    )
    if proc.returncode != 0:
        raise AssertionError(f"admit failed: {proc.stderr or proc.stdout}")
    return json.loads(proc.stdout)["cell"]


def write_shim(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(0o755)


def noise_line() -> str:
    return json.dumps({"type": "user", "message": {"content": "hello"}})


def assistant_line(text: str) -> str:
    return json.dumps(
        {"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}
    )


@unittest.skipUnless(CLI.exists(), "dist/cli.js is not built")
class SessionHookTests(unittest.TestCase):
    tmp: tempfile.TemporaryDirectory
    base: Path
    home: Path
    recall_home: Path
    work: Path
    bin_dir: Path
    nodiff_dir: Path
    cell_plain: dict
    cell_stale: dict

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.tmp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.tmp.name)
        cls.home = cls.base / "home"
        cls.home.mkdir()
        cls.recall_home = cls.base / "rhome"
        (cls.recall_home / "db").mkdir(parents=True)
        cls.work = cls.base / "work"
        cls.work.mkdir()

        db = str(cls.recall_home / "db" / "home.sqlite3")
        cls.cell_plain = admit(
            db,
            {
                "kind": "obs",
                "title": "Cache ttl sixty seconds on the edge tier",
                "body": "The cache ttl is sixty seconds for the edge tier.",
                "confidence": 0.8,
                "topics": ["cache"],
            },
        )
        cls.cell_stale = admit(
            db,
            {
                "kind": "obs",
                "title": "Retry budget capped at five attempts",
                "body": "Retries are capped at five attempts per request.",
                "confidence": 0.8,
                "topics": ["retry"],
                "reverifyAfter": STALE_REVERIFY,
            },
        )

        cls.bin_dir = cls.base / "bin"
        cls.bin_dir.mkdir()
        write_shim(
            cls.bin_dir / "recall",
            f'#!/bin/sh\nexec node "{CLI}" "$@"\n',
        )
        cls.nodiff_dir = cls.base / "bin-nodiff"
        cls.nodiff_dir.mkdir()
        write_shim(
            cls.nodiff_dir / "recall",
            '#!/bin/sh\nif [ "$1" = "diff" ]; then\n'
            '  echo "unknown command: diff" >&2\n  exit 1\nfi\n'
            f'exec node "{CLI}" "$@"\n',
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()
        super().tearDownClass()

    def hook_env(self, bin_dir: Path | None = None) -> dict[str, str]:
        path = f"{bin_dir or self.bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"
        return scrubbed_env(
            HOME=str(self.home),
            RECALL_HOME=str(self.recall_home),
            PATH=path,
        )

    def run_hook(
        self,
        args: list[str],
        payload: dict,
        env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(HOOK), *args],
            cwd=str(self.work),
            env=env or self.hook_env(),
            text=True,
            capture_output=True,
            input=json.dumps(payload),
            check=False,
            timeout=60,
        )

    def hook_context(self, proc: subprocess.CompletedProcess[str], event: str) -> str:
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        hso = out.get("hookSpecificOutput") or {}
        self.assertEqual(hso.get("hookEventName"), event, proc.stdout)
        return hso.get("additionalContext") or ""

    def state_path(self, session_id: str) -> Path:
        digest = hashlib.sha1(session_id.encode("utf-8")).hexdigest()[:16]
        return self.recall_home / ".dig_pending" / f"{digest}.json"

    def transcript(self, name: str, lines: list[str]) -> Path:
        path = self.base / name
        path.write_text("".join(line + "\n" for line in lines), encoding="utf-8")
        return path

    # --- (a) --prompt pushes a mini-index plus the PROMPT_DIRECTIVE primer ---
    def test_prompt_mode_pushes_mini_index_with_prompt_directive(self) -> None:
        tpath = self.transcript("transcript-a.jsonl", [noise_line()])
        proc = self.run_hook(
            ["--prompt"],
            {
                "prompt": "cache ttl sixty seconds on the edge tier",
                "session_id": "sess-a",
                "transcript_path": str(tpath),
                "cwd": str(self.work),
            },
        )
        ctx = self.hook_context(proc, "UserPromptSubmit")
        self.assertIn("[Recall mini-index for THIS prompt", ctx)
        self.assertRegex(ctx, r"\[obs:(?:[a-z0-9_-]+:)*[0-9a-f]{8}[0-9a-f-]*\]")
        self.assertIn("Cache ttl sixty seconds", ctx)
        # v5 renders empty sections as `- none (populated by ...)`; those hint
        # placeholders must not count as tripwires.
        self.assertIn("This is awareness, not a substitute.", ctx)
        self.assertNotIn("tripwires elsewhere", ctx)
        self.assertIn("[Recall primer: this forward pass]", ctx)
        self.assertIn("capacity for better things.", ctx)

    # --- (b) a stale row is tagged and the dig obligation is recorded ---
    def test_prompt_mode_tags_stale_row_and_records_dig_state(self) -> None:
        tpath = self.transcript("transcript-b.jsonl", [noise_line(), noise_line()])
        proc = self.run_hook(
            ["--prompt"],
            {
                "prompt": "retry budget capped at five attempts",
                "session_id": "sess-b",
                "transcript_path": str(tpath),
                "cwd": str(self.work),
            },
        )
        ctx = self.hook_context(proc, "UserPromptSubmit")
        self.assertIn("[STALE]", ctx)
        self.assertIn("DIG REQUIRED", ctx)
        state_file = self.state_path("sess-b")
        self.assertTrue(state_file.exists(), "dig state was not recorded under RECALL_HOME")
        state = json.loads(state_file.read_text(encoding="utf-8"))
        self.assertIn(self.cell_stale["key"][:8], state.get("ids") or [])
        self.assertEqual(state.get("from_line"), 2)

    # --- (c) --stop blocks when the reply names a flagged cell without reading it ---
    def test_stop_blocks_when_flagged_cell_named_but_not_read(self) -> None:
        id8 = self.cell_stale["key"][:8]
        tpath = self.transcript("transcript-c.jsonl", [noise_line(), noise_line()])
        prompt_proc = self.run_hook(
            ["--prompt"],
            {
                "prompt": "retry budget capped at five attempts",
                "session_id": "sess-c",
                "transcript_path": str(tpath),
                "cwd": str(self.work),
            },
        )
        self.assertEqual(prompt_proc.returncode, 0, prompt_proc.stderr)
        self.assertTrue(self.state_path("sess-c").exists())
        with open(tpath, "a", encoding="utf-8") as f:
            f.write(assistant_line(f"Working from cell {id8} on the retry budget.") + "\n")
        proc = self.run_hook(
            ["--stop"],
            {"session_id": "sess-c", "transcript_path": str(tpath)},
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out.get("decision"), "block", proc.stdout)
        self.assertIn("DIG REQUIRED", out.get("reason") or "")
        self.assertIn(id8, out.get("reason") or "")

    # --- (d) --stop loop guard: stop_hook_active short-circuits to {} ---
    def test_stop_loop_guard_emits_empty(self) -> None:
        tpath = self.transcript("transcript-d.jsonl", [noise_line()])
        proc = self.run_hook(
            ["--stop"],
            {
                "stop_hook_active": True,
                "session_id": "sess-d",
                "transcript_path": str(tpath),
            },
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout), {})

    # --- (e) SessionStart: directive plus the diff-verb activity summary ---
    def test_session_start_emits_directive_with_diff_summary(self) -> None:
        proc = self.run_hook([], {})
        ctx = self.hook_context(proc, "SessionStart")
        self.assertIn(
            "[Recall active memory is available. Consult it before trusting recollection.]",
            ctx,
        )
        self.assertIn("Recent graph activity (last 7d, graph-wide (global memory)):", ctx)
        self.assertIn("# Recall diff (graph-wide) since", ctx)

    def test_session_start_degrades_when_diff_verb_missing(self) -> None:
        proc = self.run_hook([], {}, env=self.hook_env(bin_dir=self.nodiff_dir))
        ctx = self.hook_context(proc, "SessionStart")
        self.assertIn(
            "[Recall active memory is available. Consult it before trusting recollection.]",
            ctx,
        )
        self.assertNotIn("Recent graph activity", ctx)

    # --- --expansion: command-scoped mini-index, no primer ---
    def test_expansion_mode_emits_command_scoped_index(self) -> None:
        tpath = self.transcript("transcript-e.jsonl", [noise_line()])
        proc = self.run_hook(
            ["--expansion"],
            {
                "command_name": "/ship",
                "command_args": "retry budget capped at five attempts",
                "session_id": "sess-e",
                "transcript_path": str(tpath),
                "cwd": str(self.work),
            },
        )
        ctx = self.hook_context(proc, "UserPromptExpansion")
        self.assertIn(
            "[Recall mini-index for /ship retry budget capped at five attempts "
            "(ids + titles only). Command-scoped; do not ask or assert blind:]",
            ctx,
        )
        self.assertNotIn("[Recall primer: this forward pass]", ctx)
        self.assertRegex(ctx, r"\[obs:(?:[a-z0-9_-]+:)*[0-9a-f]{8}[0-9a-f-]*\]")


if __name__ == "__main__":
    unittest.main(verbosity=2)
