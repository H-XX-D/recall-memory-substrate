#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// v5 UserPromptSubmit hook (node). Stamps the turn-start timestamp so the Stop
// gate can tell whether a durable write happened THIS turn (any cell created
// at/after turnStart). Injects nothing; it is purely the marker stamp half of
// the write-back gate lifecycle.
//
// Marker: $RECALL_STOP_STATE, else $HOME/.recall/state/stop/<session_id>.json.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { stdin, stdout, env } from "node:process";
import { dirname } from "node:path";

function markerPath(sessionId: string | undefined): string {
  return env.RECALL_STOP_STATE || (sessionId && env.HOME ? `${env.HOME}/.recall/state/stop/${sessionId}.json` : "");
}

function main(): void {
  if (stdin.isTTY) {
    stdout.write("{}\n");
    return;
  }
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  let sessionId: string | undefined;
  try {
    sessionId = (JSON.parse(raw) as { session_id?: string }).session_id;
  } catch {
    // malformed stdin
  }
  const path = markerPath(sessionId);
  if (path) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ turnStart: new Date().toISOString() }));
    } catch {
      // best effort; if we cannot stamp, the Stop gate fails closed (holds)
    }
  }
  stdout.write("{}\n"); // inject nothing
}

main();
