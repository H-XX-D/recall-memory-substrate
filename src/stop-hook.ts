#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// v5 Stop hook (node). On the Stop event it asks the store whether a durable cell
// was created THIS turn (created at/after the turn-start timestamp that the
// UserPromptSubmit hook stamped). If yes, it releases and runs the endcap
// operator tick; if no, it holds the turn (block) with the fill-or-reject
// template. Imports stop.js directly, so the gate logic is the engine-tested code.
//
// Marker: $RECALL_STOP_STATE, else $HOME/.recall/state/stop/<session_id>.json,
// shaped { "turnStart": ISO }. No marker means fail-closed (hold).
import { readFileSync, writeFileSync } from "node:fs";
import { stdin, stdout, env } from "node:process";
import { NO_WRITE_RECEIPT, stopHookResponse } from "./stop.js";
import { SqliteStore } from "./store.js";
import { runOperatorCycle } from "./operator.js";
import { resolveDbForCwd } from "./routing.js";

interface TurnMarker {
  turnStart?: string;
  sessionId?: string;
  turnId?: string;
  cwd?: string;
  admittedIds?: string[];
  closure?: { kind: "write" | "no-write"; cellIds: string[]; closedAt: string };
}

function markerPath(sessionId: string | undefined): string {
  return env.RECALL_STOP_STATE || (sessionId && env.HOME ? `${env.HOME}/.recall/state/stop/${sessionId}.json` : "");
}
function readMarker(sessionId: string | undefined): TurnMarker {
  const path = markerPath(sessionId);
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TurnMarker;
  } catch {
    return {};
  }
}
function dbPath(cwd: string | undefined): string {
  return resolveDbForCwd(cwd || process.cwd(), env);
}
function verifiedTurnWrites(store: SqliteStore, marker: TurnMarker): string[] {
  const since = marker.turnStart;
  if (!since) return [];
  return [...new Set(marker.admittedIds ?? [])]
    .filter((id) => {
      const cell = store.get(id);
      return cell !== undefined && cell.createdAt >= since;
    })
    .sort();
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
  let turnId: string | undefined;
  let cwd: string | undefined;
  let lastAssistantMessage = "";
  try {
    const input = JSON.parse(raw) as { session_id?: string; turn_id?: string; cwd?: string; last_assistant_message?: string };
    sessionId = input.session_id;
    turnId = input.turn_id;
    cwd = input.cwd;
    lastAssistantMessage = input.last_assistant_message ?? "";
  } catch {
    // malformed stdin
  }

  const marker = readMarker(sessionId);
  const path = dbPath(cwd ?? marker.cwd);
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
    const markerMatchesTurn = !marker.turnId || !turnId || marker.turnId === turnId;
    const cellIds = markerMatchesTurn ? verifiedTurnWrites(store, marker) : [];
    const noWriteReceipt = markerMatchesTurn
      && typeof marker.turnStart === "string"
      && lastAssistantMessage.trimEnd().endsWith(NO_WRITE_RECEIPT);
    const response = stopHookResponse({ wroteThisTurn: cellIds.length > 0, noWriteReceipt });
    if (!response.decision) {
      const statePath = markerPath(sessionId);
      if (statePath) {
        try {
          writeFileSync(statePath, JSON.stringify({
            ...marker,
            closure: {
              kind: cellIds.length > 0 ? "write" : "no-write",
              cellIds,
              closedAt: new Date().toISOString(),
            },
          }));
        } catch {
          // receipt persistence is best effort; admission itself already succeeded
        }
      }
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
