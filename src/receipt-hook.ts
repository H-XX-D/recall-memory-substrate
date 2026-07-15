#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// PostToolUse half of the agent-integrity gate. It attributes an accepted
// recall_write result to the exact session/turn marker. Stop verifies these
// IDs against the routed store; ambient/background writes never count.
import { readFileSync, writeFileSync } from "node:fs";
import { stdin, stdout, env } from "node:process";

interface Marker {
  turnStart?: string;
  sessionId?: string;
  turnId?: string;
  cwd?: string;
  admittedIds?: string[];
}

function markerPath(sessionId: string | undefined): string {
  return env.RECALL_STOP_STATE || (sessionId && env.HOME ? `${env.HOME}/.recall/state/stop/${sessionId}.json` : "");
}

function acceptedId(value: unknown): string | undefined {
  if (typeof value === "string") {
    try { return acceptedId(JSON.parse(value)); } catch { return undefined; }
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.accepted === true && typeof record.id === "string") return record.id;
  if (record.accepted === true && record.cell && typeof record.cell === "object") {
    const key = (record.cell as Record<string, unknown>).key;
    if (typeof key === "string") return key;
  }
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      const found = acceptedId(item);
      if (found) return found;
    }
  }
  if (typeof record.text === "string") return acceptedId(record.text);
  return undefined;
}

function main(): void {
  if (stdin.isTTY) { stdout.write("{}\n"); return; }
  let input: Record<string, unknown> = {};
  try { input = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>; } catch { /* no receipt */ }
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (!/(?:^|__)recall_write$/.test(toolName)) { stdout.write("{}\n"); return; }
  const id = acceptedId(input.tool_response);
  const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
  const turnId = typeof input.turn_id === "string" ? input.turn_id : undefined;
  const path = markerPath(sessionId);
  if (!id || !path) { stdout.write("{}\n"); return; }
  try {
    const marker = JSON.parse(readFileSync(path, "utf8")) as Marker;
    if (marker.sessionId && sessionId && marker.sessionId !== sessionId) { stdout.write("{}\n"); return; }
    if (marker.turnId && turnId && marker.turnId !== turnId) { stdout.write("{}\n"); return; }
    const admittedIds = [...new Set([...(marker.admittedIds ?? []), id])];
    writeFileSync(path, JSON.stringify({ ...marker, admittedIds }), { mode: 0o600 });
  } catch {
    // Missing/malformed marker fails closed at Stop; never create one here.
  }
  stdout.write("{}\n");
}

main();
