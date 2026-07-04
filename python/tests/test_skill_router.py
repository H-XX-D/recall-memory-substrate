"""Routing and command-construction tests for the skill-tree query router.

The router lives in the claude skill tree (installed by `recall claude sync`
to ~/.claude/skills/recall/scripts/recall_router.py). Its mapping contract:
8+ hex chars route to the peek script, temporal wording routes to the
`recall diff` verb, health wording routes to `recall health`, code-symbol
shapes route to the peek script with --match, and everything else falls back
to `recall compile <q> --words 300`.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "integrations" / "claude" / "skill" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import recall_router  # noqa: E402


class RouteMappingTests(unittest.TestCase):
    def test_hex_id_routes_to_peek(self) -> None:
        decision = recall_router.route("what is 4ae7579e about")
        self.assertEqual(decision.tool, "peek-id")
        self.assertEqual(decision.arg, "4ae7579e")

    def test_temporal_wording_routes_to_diff(self) -> None:
        decision = recall_router.route("what changed in the last 2 hours")
        self.assertEqual(decision.tool, "diff")
        self.assertEqual(decision.arg, "2h")

    def test_health_wording_routes_to_health(self) -> None:
        decision = recall_router.route("are there contradictions or stale cells")
        self.assertEqual(decision.tool, "health")

    def test_code_symbol_routes_to_peek_match(self) -> None:
        decision = recall_router.route("find the build_proposal function")
        self.assertEqual(decision.tool, "peek-match")
        self.assertEqual(decision.arg, "build_proposal")

    def test_open_question_falls_back_to_compile(self) -> None:
        decision = recall_router.route("how should we think about pricing")
        self.assertEqual(decision.tool, "compile")


class BuildCommandTests(unittest.TestCase):
    def decide(self, tool: str, arg: str | None) -> "recall_router.RouteDecision":
        return recall_router.RouteDecision(tool=tool, arg=arg, reason="test", confidence=1.0)

    def test_diff_calls_the_cli_verb(self) -> None:
        cmd = recall_router.build_command(self.decide("diff", "2h"), "q", db=None, recall="recall")
        self.assertEqual(cmd[:4], ["recall", "diff", "--since", "2h"])
        self.assertIn("--summary", cmd)
        self.assertNotIn("recall_diff.py", " ".join(cmd))

    def test_health_calls_the_cli_verb(self) -> None:
        cmd = recall_router.build_command(self.decide("health", None), "q", db=None, recall="recall")
        self.assertEqual(cmd, ["recall", "health"])

    def test_compile_fallback_uses_words_300(self) -> None:
        cmd = recall_router.build_command(
            self.decide("compile", None), "open question", db=None, recall="recall"
        )
        self.assertEqual(cmd, ["recall", "compile", "open question", "--words", "300"])

    def test_peek_id_calls_the_sibling_peek_script(self) -> None:
        cmd = recall_router.build_command(self.decide("peek-id", "4ae7579e"), "q", db=None, recall="recall")
        self.assertIn(str(SCRIPTS / "recall_peek.py"), cmd)
        self.assertIn("4ae7579e", cmd)

    def test_peek_match_calls_the_sibling_peek_script(self) -> None:
        cmd = recall_router.build_command(
            self.decide("peek-match", "build_proposal"), "q", db=None, recall="recall"
        )
        self.assertIn(str(SCRIPTS / "recall_peek.py"), cmd)
        self.assertIn("--match", cmd)
        self.assertIn("build_proposal", cmd)

    def test_db_flag_passes_through_when_given(self) -> None:
        cmd = recall_router.build_command(self.decide("diff", "1d"), "q", db="/tmp/x.sqlite3", recall="recall")
        self.assertIn("--db", cmd)
        self.assertIn("/tmp/x.sqlite3", cmd)

    def test_db_flag_omitted_when_absent_so_the_cli_owns_routing(self) -> None:
        cmd = recall_router.build_command(self.decide("compile", None), "q", db=None, recall="recall")
        self.assertNotIn("--db", cmd)


if __name__ == "__main__":
    unittest.main()
