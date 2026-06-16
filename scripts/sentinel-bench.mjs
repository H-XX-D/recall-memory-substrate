#!/usr/bin/env node
// SENTINEL — the unprompted-contradiction benchmark (L1: explicit value-flip).
//
// Tests the PUSH capability pull-architecture memory systems lack: as facts
// arrive over time, does the store surface — UNPROMPTED — that a new fact
// invalidated a prior belief? Fully deterministic and model-free, so the score
// is the reliability FLOOR, not a model's navigation.
//
// Mechanism under test: a standing `watch` program on a belief-bundle. A
// deterministic value-flip detector links a contradicting fact to the belief on
// admission (evidence.contradicts); the belief's effective confidence collapses;
// the watch program, run each tick, TRIPS — surfacing it with no query.
// Distractors (reinforcements / unrelated facts) are not linked, so the program
// stays quiet (precision). A pull system has no standing program to emit such an
// unqueried signal, so it scores 0 on this axis without re-querying every belief.
//
// See docs/10_SENTINEL_BENCHMARK.md for the full design and difficulty ladder.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { SQLiteRecallStore, admitWriteProposal } from "../dist/src/index.js";

function proposal(title, attr, value, contradicts) {
  const body = `${attr}=${value}`;
  return {
    schema_version: "recall.write.v1",
    actor: { kind: "llm", id: "sentinel", display: "Sentinel" },
    intent: { kind: "observation", operation: "create" },
    content: { title, body, summary: body },
    scope: { project: "sentinel", path: ".", tenant: "local" },
    tags: {
      category: ["memory"], type: ["observation"], subject: ["fact"], project: ["sentinel"], idea: ["stream"],
      timestamp: ["2023-01-01"], topics: ["fact", attr], entities: [attr], identities: ["agent:stream"],
      rings: ["adapter"], lifecycle: ["active"], quality: ["source-grounded"], sensitivity: ["public"], permission: ["read"]
    },
    evidence: { source_refs: [], depends_on: [], supports: [], contradicts: contradicts || [], concerns: [] },
    confidence: { value: 0.8, uncertainty: 0.1, concern: 0.05, source_quality: "high", stability: "stable" },
    provenance: { created_at: new Date("2023-01-01").toISOString(), origin: "llm", produced_by: "sentinel", verification: "checked", signature_status: "unsigned" },
    policy: { sensitivity: "public", allow_background_use: true, requires_review: false, expires_at: null, reverify_after: null }
  };
}

// Deterministic stream generator (no RNG). Each "contradiction" stream contains
// exactly one value-flip; each "distractor" stream contains none (reinforcements
// of the same value + unrelated facts). No reinforcement is placed after a flip,
// so the stream never contradicts itself.
function makeStreams(n) {
  const streams = [];
  for (let i = 0; i < n; i++) {
    const attr = `attr_${i}`;
    const isContra = i % 2 === 0;
    const pos = (i % 4) + 1; // contradictor position (latency variety)
    const events = [];
    for (let e = 0; e < 5; e++) {
      if (isContra && e === pos) events.push({ kind: "contradictor", attr, value: "B" });
      else if (e < pos && e % 2 === 0) events.push({ kind: "reinforce", attr, value: "A" });
      else events.push({ kind: "unrelated", attr: `other_${i}_${e}`, value: "Z" });
    }
    streams.push({ attr, anchorValue: "A", isContra, events });
  }
  return streams;
}

export function runSentinel(streamCount = 24, delta = 0.1) {
  const streams = makeStreams(streamCount);
  let trueContradictions = 0, detectedTrips = 0, falseTrips = 0, totalTicks = 0, beliefs = 0;
  const latencies = [];
  for (const stream of streams) {
    // Isolated store per stream: each scenario is independent, and a shared
    // producer's calibration factor must not couple unrelated streams.
    const tmp = mkdtempSync(join(os.tmpdir(), "sentinel-"));
    const store = new SQLiteRecallStore(join(tmp, "d.sqlite3"));
    try {
      const anchor = admitWriteProposal(proposal(`belief:${stream.attr}`, stream.attr, stream.anchorValue), store).node;
      beliefs += 1;
      const edge = store.addHyperedge({ kind: "evidence-bundle", title: `watch:${stream.attr}`, members: [{ nodeId: anchor.id, role: "claim" }] });
      const program = store.attachProgram(edge.id, { schemaVersion: "recall.program.v1", operation: "watch", params: { delta } });
      store.runProgram(program.id); // baseline tick (never trips)

      let knownValue = stream.anchorValue;
      let beliefCellId = anchor.id;
      let contradictorTick = -1, trippedTick = -1;

      stream.events.forEach((event, idx) => {
        const isContradiction = event.attr === stream.attr && event.value !== knownValue;
        const contradicts = isContradiction ? [beliefCellId] : [];
        const cell = admitWriteProposal(proposal(`event:${event.attr}=${event.value}`, event.attr, event.value, contradicts), store).node;
        if (isContradiction) { knownValue = event.value; beliefCellId = cell.id; if (contradictorTick < 0) contradictorTick = idx; }
        const out = store.runProgram(program.id).output; // unprompted tick
        totalTicks += 1;
        if (out.tripped === true && trippedTick < 0) trippedTick = idx;
        if (event.kind === "contradictor") trueContradictions += 1;
      });

      if (stream.isContra) {
        if (trippedTick === contradictorTick) { detectedTrips += 1; latencies.push(trippedTick - contradictorTick); }
        else if (trippedTick >= 0) falseTrips += 1;
      } else if (trippedTick >= 0) {
        falseTrips += 1;
      }
    } finally {
      store.close?.();
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const recall = trueContradictions ? detectedTrips / trueContradictions : 1;
  const precision = (detectedTrips + falseTrips) ? detectedTrips / (detectedTrips + falseTrips) : 1;
  const medLatency = latencies.length ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)] : null;
  return { streams: streamCount, trueContradictions, detectedTrips, falseTrips, recall, precision, medLatency, nativeCost: totalTicks, boltOnCost: totalTicks * beliefs, beliefs };
}

const r = runSentinel(24);
const pct = (x) => `${Math.round(x * 100)}%`;
console.log("==================== SENTINEL L1 — unprompted contradiction ====================\n");
console.log(`streams: ${r.streams} (half contain one value-flip; half are distractor-only) · true contradictions: ${r.trueContradictions}\n`);
console.log(`detection recall : ${pct(r.recall)} (${r.detectedTrips}/${r.trueContradictions} surfaced unprompted by the watch program)`);
console.log(`precision        : ${pct(r.precision)} (false trips: ${r.falseTrips} — distractors/reinforcements must not trip)`);
console.log(`median latency   : ${r.medLatency} tick(s) from contradictor arrival to surfacing\n`);
console.log("---- surfacing cost (native standing program vs pull bolt-on) ----");
console.log(`native (Recall) : ${r.nativeCost} program-runs — O(writes)`);
console.log(`pull bolt-on    : ${r.boltOnCost} re-queries — O(writes x beliefs=${r.beliefs}) = ${(r.boltOnCost / r.nativeCost).toFixed(1)}x, and only on demand`);
console.log("\nincumbents (no standing-program primitive): score 0 on the push axis by construction.");
