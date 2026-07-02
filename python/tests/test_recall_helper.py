from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "python" / "recall_helper.py"
CLI = ROOT / "dist" / "cli.js"


class RecallHelperTests(unittest.TestCase):
    def test_builds_v5_proposal_from_minimal_flags(self) -> None:
        result = run_helper(
            "--kind",
            "obs",
            "--title",
            "R9 helper proposal",
            "--body",
            "The helper emits a v5 WriteProposal.",
            "--confidence",
            "0.82",
            "--topics",
            "recall-v5,python",
            "--entities",
            "Recallv.5,R9",
            "--source-refs",
            "docs/subsystems/R9-python.md",
            "--supports",
            "abc123",
            "--edge",
            "concerns:def456:-0.25",
            "--project",
            "Recallv.5",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        proposal = json.loads(result.stdout)
        self.assertEqual(proposal["kind"], "obs")
        self.assertEqual(proposal["confidence"], 0.82)
        self.assertEqual(proposal["topics"], ["recall-v5", "python"])
        self.assertEqual(proposal["entities"], ["Recallv.5", "R9"])
        self.assertEqual(proposal["sourceRefs"], ["docs/subsystems/R9-python.md"])
        self.assertEqual(proposal["project"], "Recallv.5")
        self.assertEqual(
            proposal["edges"],
            [
                {"relation": "concerns", "target": "def456", "weight": -0.25},
                {"relation": "supports", "target": "abc123"},
            ],
        )

    def test_reads_body_file_and_props_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            body = Path(tmp) / "body.txt"
            body.write_text("body from disk", encoding="utf-8")
            result = run_helper(
                "--kind",
                "dec",
                "--title",
                "Body file decision",
                "--body-file",
                str(body),
                "--confidence",
                "0.7",
                "--props-json",
                '{"phase":"r9"}',
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        proposal = json.loads(result.stdout)
        self.assertEqual(proposal["body"], "body from disk")
        self.assertEqual(proposal["props"], {"phase": "r9"})

    def test_refuses_secret_sensitivity_for_normal_graph(self) -> None:
        result = run_helper(
            "--kind",
            "obs",
            "--title",
            "Secret write",
            "--body",
            "This should not enter the normal graph.",
            "--confidence",
            "0.6",
            "--sensitivity",
            "secret",
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("encrypted side store", result.stderr)

    @unittest.skipUnless(CLI.exists(), "dist/cli.js is not built")
    def test_validate_delegates_to_recall_mal(self) -> None:
        env = {**os.environ, "RECALL_CLI": str(CLI)}
        result = run_helper(
            "--kind",
            "ver",
            "--title",
            "R9 validate helper",
            "--body",
            "The helper validation path delegates to recall-mal.",
            "--confidence",
            "0.9",
            "--verification",
            "checked",
            "--validate",
            env=env,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"ok": True, "issues": []})


def run_helper(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(HELPER), *args],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


if __name__ == "__main__":
    unittest.main()
