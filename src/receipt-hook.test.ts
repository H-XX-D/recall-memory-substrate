import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function runReceipt(statePath: string, input: Record<string, unknown>): void {
  const result = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(here, "receipt-hook.ts")],
    { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, RECALL_STOP_STATE: statePath } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
}

test("receipt hook attributes only an accepted recall_write to the matching turn", () => {
  const tmp = mkdtempSync(join(tmpdir(), "recall-receipt-hook-"));
  const state = join(tmp, "state.json");
  try {
    writeFileSync(state, JSON.stringify({ sessionId: "s1", turnId: "t1", turnStart: "2026-07-12T00:00:00Z", admittedIds: [] }));
    runReceipt(state, {
      session_id: "s1", turn_id: "t1", tool_name: "mcp__recall__recall_write",
      tool_response: { content: [{ type: "text", text: JSON.stringify({ accepted: true, id: "cell-1" }) }] },
    });
    assert.deepEqual(JSON.parse(readFileSync(state, "utf8")).admittedIds, ["cell-1"]);

    runReceipt(state, {
      session_id: "s1", turn_id: "t1", tool_name: "Bash",
      tool_response: { accepted: true, id: "spoofed" },
    });
    runReceipt(state, {
      session_id: "s1", turn_id: "wrong", tool_name: "mcp__recall__recall_write",
      tool_response: { accepted: true, id: "wrong-turn" },
    });
    runReceipt(state, {
      session_id: "s1", turn_id: "t1", tool_name: "mcp__recall__recall_write",
      tool_response: { accepted: false, id: "rejected" },
    });
    assert.deepEqual(JSON.parse(readFileSync(state, "utf8")).admittedIds, ["cell-1"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("receipt hook ignores an accepted write from a different session", () => {
  const tmp = mkdtempSync(join(tmpdir(), "recall-receipt-hook-"));
  const state = join(tmp, "state.json");
  try {
    writeFileSync(state, JSON.stringify({ sessionId: "s1", turnId: "t1", turnStart: "2026-07-12T00:00:00Z", admittedIds: [] }));
    runReceipt(state, {
      session_id: "s2", turn_id: "t1", tool_name: "mcp__recall__recall_write",
      tool_response: { accepted: true, id: "cross-session" },
    });
    assert.deepEqual(JSON.parse(readFileSync(state, "utf8")).admittedIds, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
