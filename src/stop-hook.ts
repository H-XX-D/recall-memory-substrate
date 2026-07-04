#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// v5 Stop hook (node). On the Stop event it asks the store whether a durable cell
// was created THIS turn (created at/after the turn-start timestamp that the
// UserPromptSubmit hook stamped). If yes, it releases and runs the endcap
// operator tick; if no, it holds the turn (block) with the fill-or-reject
// template. Imports stop.js directly, so the gate logic is the engine-tested code.
//
// Marker: $RECALL_STOP_STATE, else $HOME/.recall/state/stop/<session_id>.json,
// shaped { "turnStart": ISO }. No marker means fail-closed (hold).
import { readFileSync } from "node:fs";
import { stdin, stdout, env } from "node:process";
import { stopHookResponse } from "./stop.js";
import { SqliteStore } from "./store.js";
import { runOperatorCycle } from "./operator.js";
import { homeDbPath } from "./routing.js";

function markerPath(sessionId: string | undefined): string {
  return env.RECALL_STOP_STATE || (sessionId && env.HOME ? `${env.HOME}/.recall/state/stop/${sessionId}.json` : "");
}
function turnStart(sessionId: string | undefined): string | undefined {
  const path = markerPath(sessionId);
  if (!path) return undefined;
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { turnStart?: string }).turnStart;
  } catch {
    return undefined;
  }
}
function dbPath(): string {
  // RECALL_DB overrides; otherwise the RECALL_HOME-derived home store, which
  // itself falls back to the HOME-derived ~/.recall/db/home.sqlite3.
  return env.RECALL_DB ?? homeDbPath(env);
}
function wroteSince(store: SqliteStore, since: string | undefined): boolean {
  if (!since) return false; // no turn-start marker => fail closed (hold)
  return store.active().some((c) => c.createdAt >= since);
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
  if (!raw.trim()) {
    stdout.write("{}\n");
    return;
  }
  let sessionId: string | undefined;
  try {
    sessionId = (JSON.parse(raw) as { session_id?: string }).session_id;
  } catch {
    // malformed stdin
  }

  const path = dbPath();
  if (!path) {
    stdout.write("{}\n"); // no db: cannot gate, do not block
    return;
  }

  let store: SqliteStore;
  try {
    store = new SqliteStore(path);
  } catch {
    stdout.write("{}\n"); // store failed to open: cannot gate, do not block
    return;
  }
  try {
    const response = stopHookResponse({ wroteThisTurn: wroteSince(store, turnStart(sessionId)) });
    if (!response.decision) {
      // released: run the endcap operator cycle so the graph is current for the
      // next turn. Best-effort: a tick error must never block release.
      // derive:true admits standing-program witnesses here too. This is
      // idempotent by construction: deriveAdmit dedups on programRunDerivationKey
      // (programKey + output only), so an unchanged re-run collapses onto the
      // existing cell as a duplicateOf and admits nothing new; a changed output
      // legitimately admits a fresh witness.
      try {
        runOperatorCycle(store, new Date().toISOString(), { derive: true });
      } catch {
        // swallow
      }
    }
    stdout.write(JSON.stringify(response));
  } finally {
    store.close();
  }
}

main();
