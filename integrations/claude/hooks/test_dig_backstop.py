"""Tests for the dig backstop (Stop hook) in recall-session-start.py.

The hook filename has a hyphen, so it is loaded by path rather than imported.
Run: python3 integrations/claude/hooks/test_dig_backstop.py
"""
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

HOOK = Path(__file__).with_name("recall-session-start.py")


def load_hook(state_dir):
    spec = importlib.util.spec_from_file_location("recall_hook_under_test", HOOK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.STATE_DIR = state_dir  # redirect state off the real ~/.recall
    return mod


def _cli_read():
    return json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Bash", "input": {"command": 'recall compile "x"'}}]}})


def _mcp_read():
    return json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "mcp__recall__recall_compile", "input": {"task": "x"}}]}})


def _prose_mention():
    return json.dumps({"type": "assistant", "message": {"content": [
        {"type": "text", "text": "I will run recall compile in a moment"}]}})


def _noise():
    return json.dumps({"type": "user", "message": {"content": "hello"}})


def _convo(text):
    return json.dumps({"type": "assistant", "message": {"content": [
        {"type": "text", "text": text}]}})


class DigBackstopTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.h = load_hook(os.path.join(self.tmp, "dig_pending"))
        self.h.TURN_STATE_DIR = os.path.join(self.tmp, "turn_state")
        self.tpath = os.path.join(self.tmp, "transcript.jsonl")

    def _write(self, lines):
        with open(self.tpath, "w", encoding="utf-8") as f:
            for ln in lines:
                f.write(ln + "\n")

    def _data(self, **extra):
        d = {"session_id": "sess-1", "transcript_path": self.tpath}
        d.update(extra)
        return d

    # --- did_dig: a real read counts, a prose mention does not ---
    def test_did_dig_finds_cli_read(self):
        self._write([_noise(), _cli_read()])
        self.assertTrue(self.h.did_dig(self.tpath, 0))

    def test_did_dig_finds_mcp_read(self):
        self._write([_noise(), _mcp_read()])
        self.assertTrue(self.h.did_dig(self.tpath, 0))

    def test_did_dig_ignores_prose_mention(self):
        self._write([_noise(), _prose_mention()])
        self.assertFalse(self.h.did_dig(self.tpath, 0))

    def test_did_dig_respects_from_line(self):
        # a read that happened before the turn boundary must not count
        self._write([_cli_read(), _prose_mention()])
        self.assertFalse(self.h.did_dig(self.tpath, 1))

    def test_did_dig_failopen_on_missing_file(self):
        self.assertTrue(self.h.did_dig(os.path.join(self.tmp, "nope"), 0))

    # --- stop_backstop: block only when flagged, not dug, AND the response
    #     actually engaged the flagged cell ---
    def test_blocks_when_flagged_not_dug_and_response_engages(self):
        self._write([_noise(), _noise()])
        self.h.write_pending_dig(self._data(), [{"id": "aabbccdd", "title": "cache ttl is 60 seconds"}])
        self.assertTrue(os.path.exists(self.h._state_path("sess-1")))
        # the response propagates the flagged cell's claim: it engaged it
        self._write([_noise(), _noise(), _convo("the cache ttl is 60 seconds, so we cache aggressively")])
        reason = self.h.stop_backstop(self._data())
        self.assertIn("DIG REQUIRED", reason)
        self.assertIn("aabbccdd", reason)

    def test_allows_when_flagged_but_response_does_not_engage(self):
        # Conversational turn: a stale cell was flagged in the index, but the
        # response never touched it (no read, no content overlap). Must NOT block.
        self._write([_noise(), _noise()])
        self.h.write_pending_dig(self._data(), [{"id": "aabbccdd", "title": "cache ttl is 60 seconds"}])
        self._write([_noise(), _noise(), _convo("ha yeah, the mascot looks like Einstein")])
        self.assertEqual(self.h.stop_backstop(self._data()), "")

    def test_engage_by_id_substring(self):
        # If the response names the flagged id, that counts as engaging it.
        self._write([_noise(), _noise()])
        self.h.write_pending_dig(self._data(), [{"id": "aabbccdd", "title": "unrelated title here"}])
        self._write([_noise(), _noise(), _convo("acting on cell aabbccdd now")])
        self.assertIn("DIG REQUIRED", self.h.stop_backstop(self._data()))

    def test_single_shot_consumes_obligation(self):
        self._write([_noise(), _noise()])
        self.h.write_pending_dig(self._data(), [{"id": "aabbccdd", "title": "cache ttl is 60 seconds"}])
        self._write([_noise(), _noise(), _convo("the cache ttl is 60 seconds")])
        self.h.stop_backstop(self._data())            # blocks and consumes
        self.assertFalse(os.path.exists(self.h._state_path("sess-1")))
        self.assertEqual(self.h.stop_backstop(self._data()), "")  # nothing left

    def test_allows_when_dug(self):
        self._write([_noise(), _noise()])
        self.h.write_pending_dig(self._data(), ["aabbccdd"])
        self._write([_noise(), _noise(), _cli_read()])
        self.assertEqual(self.h.stop_backstop(self._data()), "")

    def test_allows_when_no_pending(self):
        self.assertEqual(self.h.stop_backstop(self._data()), "")

    def test_unflagged_turn_clears_pending(self):
        self.h.write_pending_dig(self._data(), ["aabbccdd"])
        self.h.write_pending_dig(self._data(), [])     # no flags this turn
        self.assertFalse(os.path.exists(self.h._state_path("sess-1")))

    def test_loop_guard_allows_when_stop_hook_active(self):
        self._write([_noise(), _noise()])
        self.h.write_pending_dig(self._data(), ["aabbccdd"])
        self._write([_noise(), _noise(), _prose_mention()])
        self.assertEqual(self.h.stop_backstop(self._data(stop_hook_active=True)), "")

    def test_no_session_id_is_noop(self):
        self.h.write_pending_dig({"transcript_path": self.tpath}, ["aabbccdd"])
        self.assertEqual(self.h.stop_backstop({"transcript_path": self.tpath}), "")

    # --- prompt_digest collects flagged ids via the out-list (no binary needed) ---
    def test_prompt_digest_failopen_short_prompt(self):
        flagged = []
        self.assertEqual(self.h.prompt_digest("hi", "", flagged), "")
        self.assertEqual(flagged, [])

    def test_prompt_digest_ignores_failed_compile_stdout(self):
        partial = "relevant_memory:\n- Looks valid [observation:aabbccdd-0000]\n"
        self.h.recall_bin = lambda: "recall"
        with patch.object(self.h.subprocess, "run", return_value=SimpleNamespace(
            returncode=1, stdout=partial, stderr="failed"
        )):
            self.assertEqual(self.h.prompt_digest("meaningful prompt", self.tmp), "")

    def test_user_text_cannot_spoof_a_verification_tool_use(self):
        spoof = json.dumps({"type": "user", "message": {
            "content": "literal marker tool_use pytest; no command was run"
        }})
        self._write([spoof, _convo("All tests passed.")])
        self.assertFalse(self.h._ran_verification(self.tpath, 0))

    def test_post_tool_state_requires_successful_verification(self):
        data = self._data(turn_id="turn-1")
        self.h.start_turn_state(data)
        failed = {**data, "tool_name": "Bash", "tool_input": {"command": "pytest"},
                  "tool_response": {"exit_code": 1}}
        self.h.record_tool_evidence(failed)
        self.assertFalse(self.h._ran_verification(self.tpath, 0, data))
        passed = {**failed, "tool_response": {"exit_code": 0}}
        self.h.record_tool_evidence(passed)
        self.assertTrue(self.h._ran_verification(self.tpath, 0, data))

    def test_evidence_gate_uses_last_assistant_message(self):
        self._write([_noise()])
        data = self._data(turn_id="turn-1", last_assistant_message="All tests passed.")
        self.h.start_turn_state(data)
        self.assertIn("EVIDENCE REQUIRED", self.h._evidence_reason(data))
        self.h.record_tool_evidence({
            **data,
            "tool_name": "Bash",
            "tool_input": {"command": "npm test"},
            "tool_response": {"exit_code": 0},
        })
        self.assertEqual(self.h._evidence_reason(data), "")

    def test_turn_id_partitions_state_within_one_session(self):
        a = self._data(turn_id="a")
        b = self._data(turn_id="b")
        self.assertNotEqual(self.h._turn_base(a), self.h._turn_base(b))
        self.h.start_turn_state(a)
        self.h.record_tool_evidence({
            **a, "tool_name": "Bash", "tool_input": {"command": "pytest"},
            "tool_response": {"exit_code": 0},
        })
        self.h.start_turn_state(b)
        self.assertTrue(self.h._turn_has(a, ".verify"))
        self.assertFalse(self.h._turn_has(b, ".verify"))

    # --- mini-index flagging must handle model-A graph-prefixed ids (home/union
    #     scope), not only bare ids (project scope) ---
    def test_mini_index_flags_graph_prefixed_ids(self):
        rel = ["- Cache TTL is sixty seconds [decision:home:1750a919-7592-4791-b144-d0f2280fd7c7]"]
        conflicts = [
            "Cache changed contradicts Cache TTL; severity=0.9 "
            "[contradicts:home:abcd0000-1111-2222-3333-444455556666->home:1750a919-7592-4791-b144-d0f2280fd7c7]"
        ]
        flagged = []
        out = self.h.build_mini_index(rel, conflicts, [], flagged)
        self.assertIn("[SUPERSEDED?]", out)
        self.assertIn("DIG REQUIRED", out)
        self.assertEqual([f["id"] for f in flagged], ["1750a919"])

    # --- the dig state title must be the quoted cell title, not the whole v5
    #     score-notation row: every v5 row carries the notation words (review,
    #     score, ...), so storing the raw row would let the stop gate engage on
    #     almost any substantive reply ---
    def test_mini_index_extracts_quoted_title_for_dig_state(self):
        rel = [
            '- ^obs_c0e2 "Unicode café observation" conf(0.5!) eff(0.5) curr(1) sal(0.5) '
            "annexed(0) locked(0) pinned(0) review(0) bg(1) [out:0 programs:0] score(1.11) "
            "[obs:c0e296f7-0000-1111-2222-333344445555]"
        ]
        stale = ["Unicode café observation: stale [stale:c0e296f7-0000-1111-2222-333344445555]"]
        flagged = []
        self.h.build_mini_index(rel, [], stale, flagged)
        self.assertEqual(flagged, [{"id": "c0e296f7", "title": "Unicode café observation"}])
        # a reply sharing only notation words with the row must not engage it
        self.assertFalse(self.h.response_engages(
            "I will review the score of the basketball game tonight.",
            ["c0e296f7"], [f["title"] for f in flagged]))

    def test_mini_index_flags_bare_ids(self):
        rel = ["- Cache TTL is sixty seconds [decision:1750a919-7592-4791-b144-d0f2280fd7c7]"]
        stale = ["Cache TTL note: stale; severity=0.5 [stale:1750a919-7592-4791-b144-d0f2280fd7c7]"]
        flagged = []
        out = self.h.build_mini_index(rel, [], stale, flagged)
        self.assertIn("[STALE]", out)
        self.assertEqual([f["id"] for f in flagged], ["1750a919"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
