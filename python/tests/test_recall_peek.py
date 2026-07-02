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
PEEK = ROOT / "python" / "recall_peek.py"
CLI = ROOT / "dist" / "cli.js"


@unittest.skipUnless(CLI.exists(), "dist/cli.js is not built")
class RecallPeekTests(unittest.TestCase):
    def test_peek_compacts_cli_cell_show(self) -> None:
        env = {**os.environ, "RECALL_CLI": str(CLI)}
        with tempfile.TemporaryDirectory() as tmp:
            db = str(Path(tmp) / "recall.sqlite3")
            admit = subprocess.run(
                [
                    sys.executable,
                    str(HELPER),
                    "--kind",
                    "obs",
                    "--title",
                    "R9 peek round trip",
                    "--body",
                    "This body is intentionally long enough for the preview truncation path.",
                    "--confidence",
                    "0.88",
                    "--topics",
                    "recall-v5,python",
                    "--entities",
                    "R9",
                    "--source-refs",
                    "python/tests/test_recall_peek.py",
                    "--project",
                    "Recallv.5",
                    "--admit",
                    "--db",
                    db,
                ],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(admit.returncode, 0, admit.stderr)
            admitted = json.loads(admit.stdout)
            key = admitted["cell"]["key"]

            peek = subprocess.run(
                [
                    sys.executable,
                    str(PEEK),
                    key,
                    "--db",
                    db,
                    "--format",
                    "json",
                    "--chars",
                    "24",
                ],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(peek.returncode, 0, peek.stderr)
            summary = json.loads(peek.stdout)
            self.assertEqual(summary["key"], key)
            self.assertEqual(summary["title"], "R9 peek round trip")
            self.assertEqual(summary["scope"]["project"], "Recallv.5")
            self.assertEqual(summary["incomingCount"], 0)
            self.assertEqual(summary["outgoingCount"], 0)
            self.assertTrue(summary["bodyTruncated"])
            self.assertTrue(summary["bodyPreview"].endswith("..."))

            human = subprocess.run(
                [sys.executable, str(PEEK), key, "--db", db, "--chars", "24"],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(human.returncode, 0, human.stderr)
            self.assertIn("R9 peek round trip", human.stdout)
            self.assertIn("edges: incoming=0 outgoing=0", human.stdout)


if __name__ == "__main__":
    unittest.main()
