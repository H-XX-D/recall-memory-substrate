from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PEEK = ROOT / "python" / "recall_peek.py"
CLI = ROOT / "dist" / "cli.js"

LONG_BODY = "The v5 peek reader loads the envelope from the cells table. " * 30


def scrubbed_env(**extra: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in {"RECALL_DB", "RECALL_HOME"}}
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


def add_hyperedge(db: str, payload: dict) -> None:
    proc = subprocess.run(
        ["node", str(CLI), "hyperedge", "add", "--json", "-", "--db", db],
        cwd=ROOT,
        env=scrubbed_env(),
        text=True,
        capture_output=True,
        input=json.dumps(payload),
        check=False,
    )
    if proc.returncode != 0:
        raise AssertionError(f"hyperedge add failed: {proc.stderr or proc.stdout}")


def run_peek(args: list[str], env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(PEEK), *args],
        cwd=ROOT,
        env=env or scrubbed_env(),
        text=True,
        capture_output=True,
        check=False,
    )


@unittest.skipUnless(CLI.exists(), "dist/cli.js is not built")
class RecallPeekV5Tests(unittest.TestCase):
    tmp: tempfile.TemporaryDirectory
    db: str
    cell_a: dict
    cell_b: dict

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = str(Path(cls.tmp.name) / "peek.sqlite3")
        cls.cell_a = admit(
            cls.db,
            {
                "kind": "obs",
                "title": "Peek target alpha",
                "body": LONG_BODY,
                "confidence": 0.9,
                "topics": ["peek", "v5"],
                "entities": ["alpha"],
                "project": "peek-proj",
            },
        )
        cls.cell_b = admit(
            cls.db,
            {
                "kind": "dec",
                "title": "Peek supporter beta",
                "body": "Short body that supports alpha.",
                "confidence": 0.8,
                "topics": ["peek"],
                "project": "peek-proj",
                "edges": [{"relation": "supports", "target": cls.cell_a["key"]}],
            },
        )
        add_hyperedge(
            cls.db,
            {
                "kind": "cluster",
                "title": "Peek cluster",
                "members": [cls.cell_a["key"], cls.cell_b["key"]],
            },
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()
        super().tearDownClass()

    def test_envelope_by_key_prefix(self) -> None:
        prefix = self.cell_a["key"][:8]
        proc = run_peek([prefix, "--db", self.db, "--format", "json"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        summary = json.loads(proc.stdout)
        self.assertEqual(summary["key"], self.cell_a["key"])
        self.assertEqual(summary["handle"], self.cell_a["handle"])
        self.assertEqual(summary["kind"], "obs")
        self.assertEqual(summary["title"], "Peek target alpha")
        self.assertEqual(summary["status"], "active")
        self.assertEqual(summary["scope"]["project"], "peek-proj")
        self.assertAlmostEqual(summary["scores"]["conf"], self.cell_a["scores"]["conf"])
        self.assertIn("effective", summary["scores"])
        body = summary["body"]
        self.assertEqual(body["full_length"], len(LONG_BODY))
        self.assertTrue(body["truncated"])
        self.assertLessEqual(len(body["excerpt"]), 800)
        relations = summary["relations"]
        self.assertEqual(relations["incoming_by_relation"], {"supports": 1})
        self.assertEqual(relations["incoming_count"], 1)
        self.assertEqual(relations["outgoing_count"], 0)
        memberships = summary["hyperedge_memberships"]
        self.assertEqual(memberships.get("cluster", {}).get("member"), 1)

    def test_handle_resolves(self) -> None:
        proc = run_peek([self.cell_a["handle"], "--db", self.db, "--format", "json"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        summary = json.loads(proc.stdout)
        self.assertEqual(summary["key"], self.cell_a["key"])

    def test_match_listing_with_filters(self) -> None:
        proc = run_peek(
            ["--match", "Peek", "--project", "peek-proj", "--db", self.db, "--format", "json"],
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        listing = json.loads(proc.stdout)
        keys = {row["key"] for row in listing["results"]}
        self.assertEqual(keys, {self.cell_a["key"], self.cell_b["key"]})

        proc = run_peek(
            ["--match", "Peek", "--kind", "dec", "--db", self.db, "--format", "json"],
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        listing = json.loads(proc.stdout)
        self.assertEqual([row["key"] for row in listing["results"]], [self.cell_b["key"]])

    def test_field_title_prints_raw_value(self) -> None:
        proc = run_peek([self.cell_a["key"], "--field", "title", "--db", self.db])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "Peek target alpha")

    def test_field_body_honors_no_truncate(self) -> None:
        truncated = run_peek(
            [self.cell_a["key"], "--field", "body", "--excerpt-chars", "40", "--db", self.db],
        )
        self.assertEqual(truncated.returncode, 0, truncated.stderr)
        self.assertEqual(truncated.stdout.rstrip("\n"), LONG_BODY[:40])

        full = run_peek([self.cell_a["key"], "--field", "body", "--no-truncate", "--db", self.db])
        self.assertEqual(full.returncode, 0, full.stderr)
        self.assertEqual(full.stdout.rstrip("\n"), LONG_BODY)

    def test_max_tokens_shrinks_body_excerpt(self) -> None:
        unbounded = run_peek([self.cell_a["key"], "--db", self.db, "--format", "json"])
        bounded = run_peek(
            [self.cell_a["key"], "--max-tokens", "80", "--db", self.db, "--format", "json"],
        )
        self.assertEqual(bounded.returncode, 0, bounded.stderr)
        self.assertLess(len(bounded.stdout), len(unbounded.stdout))
        summary = json.loads(bounded.stdout)
        self.assertTrue(summary["body"]["truncated"])

    def test_human_format_renders_envelope(self) -> None:
        proc = run_peek([self.cell_a["key"], "--db", self.db, "--format", "human"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("Peek target alpha", proc.stdout)
        self.assertIn(self.cell_a["key"], proc.stdout)
        self.assertIn("supports=1", proc.stdout)

    def test_unknown_prefix_exits_2(self) -> None:
        proc = run_peek(["ffffffff", "--db", self.db, "--format", "json"])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("no cell matching", proc.stderr)

    def test_default_db_resolution_recall_home_then_recall_db(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            recall_home = Path(tmp) / "rhome"
            home_db = recall_home / "db" / "home.sqlite3"
            home_db.parent.mkdir(parents=True)
            cell = admit(
                str(home_db),
                {
                    "kind": "obs",
                    "title": "Home resolved cell",
                    "body": "Lives under RECALL_HOME.",
                    "confidence": 0.7,
                    "topics": ["routing"],
                },
            )
            env = scrubbed_env(RECALL_HOME=str(recall_home))
            proc = run_peek([cell["key"], "--format", "json"], env=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(json.loads(proc.stdout)["key"], cell["key"])

            other_db = Path(tmp) / "other.sqlite3"
            other = admit(
                str(other_db),
                {
                    "kind": "obs",
                    "title": "RECALL_DB resolved cell",
                    "body": "Lives at RECALL_DB.",
                    "confidence": 0.7,
                    "topics": ["routing"],
                },
            )
            env = scrubbed_env(RECALL_HOME=str(recall_home), RECALL_DB=str(other_db))
            proc = run_peek([other["key"], "--format", "json"], env=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(json.loads(proc.stdout)["key"], other["key"])


if __name__ == "__main__":
    unittest.main()
