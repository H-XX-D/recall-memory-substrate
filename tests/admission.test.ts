import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { makeProposal, tempDbPath } from "./helpers.js";

describe("admission", () => {
  it("warns on titles over 20 words without rejecting them", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const longTitle = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
      const result = admitWriteProposal(makeProposal({ content: { title: longTitle } }), store);

      assert.equal(result.accepted, true);
      assert.ok(
        result.warnings.some((warning) => /title has 30 words/.test(warning)),
        `expected long-title warning, got: ${JSON.stringify(result.warnings)}`
      );

      const shortResult = admitWriteProposal(
        makeProposal({ content: { title: "Short title cell", body: "Different body for derivation." } }),
        store
      );
      assert.equal(shortResult.accepted, true);
      assert.equal(shortResult.warnings.some((warning) => /title has/.test(warning)), false);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("warns when a new cell nearly duplicates an existing one", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      admitWriteProposal(
        makeProposal({
          content: {
            title: "Flux capacitor calibration approach decided",
            body: "We calibrate the flux capacitor against the reference oscillator at startup, recording drift per session.",
            summary: "Calibration approach."
          }
        }),
        store
      );

      const nearDup = admitWriteProposal(
        makeProposal({
          content: {
            title: "Decided the flux capacitor calibration approach",
            body: "We calibrate the flux capacitor against the reference oscillator at startup, recording drift per session.",
            summary: "Calibration approach again."
          }
        }),
        store
      );
      assert.equal(nearDup.accepted, true);
      assert.ok(
        nearDup.warnings.some((warning) => /similar to existing cell/.test(warning)),
        `expected near-duplicate warning, got: ${JSON.stringify(nearDup.warnings)}`
      );

      const different = admitWriteProposal(
        makeProposal({
          content: {
            title: "Daemon lease renewal cadence observed",
            body: "Lease renewal happens every thirty seconds under contention; no starvation seen in the soak run.",
            summary: "Lease cadence."
          }
        }),
        store
      );
      assert.equal(different.accepted, true);
      assert.equal(different.warnings.some((warning) => /similar to existing cell/.test(warning)), false);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("warns on oversized bodies without rejecting them", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const result = admitWriteProposal(
        makeProposal({
          content: {
            title: "Large transcript artifact",
            body: "x".repeat(33 * 1024),
            summary: "Large transcript should be linked or split."
          }
        }),
        store
      );

      assert.equal(result.accepted, true);
      assert.ok(
        result.warnings.some((warning) => /bodies over 32KB/.test(warning)),
        `expected oversized-body warning, got: ${JSON.stringify(result.warnings)}`
      );
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("admits a valid proposal into the graph and rollback journal", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const result = admitWriteProposal(makeProposal(), store);

      assert.equal(result.accepted, true);
      assert.equal(store.stats().nodes, 1);
      assert.equal(store.stats().rollbackEntries, 1);
      assert.equal(result.node?.kind, "observation");
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("creates evidence relations from proposal evidence arrays", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      // Trust-bearing edges must resolve to a real node, so the references
      // below point at admitted cells rather than free-text labels (which are
      // dropped with a warning — see evidence-target-resolution.test.ts).
      const supportTarget = admitWriteProposal(
        makeProposal({ content: { title: "Recall active memory", body: "support target", summary: "support" } }),
        store
      ).node!.id;
      const concernTarget = admitWriteProposal(
        makeProposal({ content: { title: "Context flooding risk", body: "concern target", summary: "concern" } }),
        store
      ).node!.id;

      const result = admitWriteProposal(
        makeProposal({
          content: { title: "Cell carrying evidence edges", body: "edges", summary: "edges" },
          evidence: {
            supports: [supportTarget],
            concerns: [concernTarget]
          }
        }),
        store
      );

      assert.equal(result.accepted, true);
      assert.equal(store.stats().relations, 2);
      assert.equal(result.relations.map((relation) => relation.kind).sort().join(","), "concerns,supports");
      assert.equal(result.relations.find((relation) => relation.kind === "supports")!.targetId, supportTarget);
      assert.equal(result.relations.find((relation) => relation.kind === "concerns")!.targetId, concernTarget);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("normalizes cell-address evidence links to existing cell ids", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const target = admitWriteProposal(makeProposal({ content: { title: "Addressable target cell" } }), store);
      assert.ok(target.node);

      const linked = admitWriteProposal(
        makeProposal({
          content: { title: "Address link witness" },
          evidence: {
            supports: [target.node.cellAddress]
          }
        }),
        store
      );

      assert.equal(linked.accepted, true);
      assert.equal(linked.relations[0]?.targetId, target.node.id);
      const evidence = linked.node?.data.evidence as { supports: string[] } | undefined;
      assert.equal(evidence?.supports[0], target.node.id);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("normalizes cell-address field references while preserving the entry parameter", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const target = admitWriteProposal(
        makeProposal({
          content: {
            title: "Target with summary",
            body: "The full body should not be copied into later cells.",
            summary: "Reusable compact summary."
          }
        }),
        store
      );
      assert.ok(target.node);

      const linked = admitWriteProposal(
        makeProposal({
          content: { title: "Field link witness" },
          evidence: {
            supports: [`${target.node.cellAddress}#content.summary`]
          }
        }),
        store
      );

      assert.equal(linked.accepted, true);
      assert.equal(linked.relations[0]?.targetId, target.node.id);
      assert.deepEqual(linked.relations[0]?.data, {
        targetPath: "content.summary",
        targetRef: `${target.node.id}#content.summary`
      });
      const evidence = linked.node?.data.evidence as { supports: string[] } | undefined;
      assert.equal(evidence?.supports[0], `${target.node.id}#content.summary`);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("rejects secret-looking content", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const result = admitWriteProposal(
        makeProposal({
          content: {
            body: `Never store this key: ${"sk-" + "test123456789012345678901234567890"}`
          }
        }),
        store
      );

      assert.equal(result.accepted, false);
      assert.equal(result.issues.some((issue) => issue.code === "secret_pattern"), true);
      assert.equal(store.stats().nodes, 0);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("rejects common credential shapes from the primary graph", () => {
    const cases = [
      ["Stripe key", "rk_live_1234567890abcdef"],
      ["GitHub fine-grained PAT", `github_pat_${"A".repeat(30)}`],
      ["Slack token", "xoxb-1234567890-abcdefghi"],
      ["Google API key", `AIza${"A".repeat(35)}`],
      // built via concat so no contiguous AWS-key literal sits in source (secret-scanner hygiene);
      // the firewall still sees the full 20-char ASIA… string at runtime and must reject it.
      ["AWS session key id", `ASIA${"A".repeat(16)}`],
      ["JWT", `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`],
      ["URI credentials", "postgres://user:password@localhost/db"],
      ["secret assignment", "client_secret = not-a-real-secret-value"],
      ["env assignment", "export DB_PASSWORD=not-a-real-secret-value"]
    ];

    for (const [label, value] of cases) {
      const temp = tempDbPath();
      const store = new SQLiteRecallStore(temp.path);
      try {
        const result = admitWriteProposal(
          makeProposal({
            content: {
              title: `Secret firewall ${label}`,
              body: `The primary graph must reject ${value}.`
            }
          }),
          store
        );
        assert.equal(result.accepted, false, `${label} should be rejected`);
        assert.equal(result.issues.some((issue) => issue.code === "secret_pattern"), true);
      } finally {
        store.close();
        temp.cleanup();
      }
    }
  });

  it("rejects additional vendor credential shapes", () => {
    const cases = [
      ["GitLab PAT", "glpat-ABCDEFGHIJ1234567890xy"],
      ["npm token", `npm_${"a".repeat(36)}`],
      ["Hugging Face token", `hf_${"b".repeat(34)}`],
      ["SendGrid key", `SG.${"a".repeat(22)}.${"b".repeat(43)}`],
      ["Shopify token", `shpat_${"a".repeat(32)}`],
      ["DigitalOcean token", `dop_v1_${"a".repeat(64)}`],
      ["Doppler token", `dp.pt.${"A".repeat(40)}`],
      ["Square token", `sq0atp-${"a".repeat(22)}`],
      ["Telegram bot token", `123456789:${"A".repeat(35)}`],
      ["Twilio API key", `SK${"a".repeat(32)}`],
      ["Mailgun key", `key-${"a".repeat(32)}`]
    ];

    for (const [label, value] of cases) {
      const temp = tempDbPath();
      const store = new SQLiteRecallStore(temp.path);
      try {
        const result = admitWriteProposal(
          makeProposal({
            content: { title: `Vendor secret ${label}`, body: `the primary graph must reject ${value}` }
          }),
          store
        );
        assert.equal(result.accepted, false, `${label} should be rejected`);
        assert.equal(result.issues.some((issue) => issue.code === "secret_pattern"), true, `secret_pattern for ${label}`);
        assert.equal(store.stats().nodes, 0, `${label} must not persist`);
      } finally {
        store.close();
        temp.cleanup();
      }
    }
  });

  it("does not flag the graph's own UUID and hex identifiers as secrets", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const result = admitWriteProposal(
        makeProposal({
          content: {
            title: "Supersession note",
            body:
              "Cell recall://cell/f30ce5a1-3d6d-40c7-8134-c12df03c116f supersedes " +
              "8702b4bc-1111-2222-3333-444455556666; verified at commit fe8a3aa, " +
              "blob 0123456789abcdef0123456789abcdef on a clean tree."
          }
        }),
        store
      );
      assert.equal(result.accepted, true, "graph identifiers must not trip the secret firewall");
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("attenuates unsupported high confidence", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const result = admitWriteProposal(
        makeProposal({
          evidence: {
            source_refs: []
          },
          confidence: {
            value: 0.96,
            source_quality: "unknown"
          },
          provenance: {
            verification: "unverified"
          }
        }),
        store
      );

      assert.equal(result.accepted, true);
      const confidence = result.node?.data.confidence as { value: number } | undefined;
      assert.equal(confidence?.value, 0.7);
      assert.equal(result.attenuations.length, 1);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("requires review for program writes", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const result = admitWriteProposal(
        makeProposal({
          intent: {
            kind: "program"
          }
        }),
        store
      );

      assert.equal(result.accepted, false);
      assert.equal(result.issues.some((issue) => issue.code === "program_requires_review"), true);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("rejects common secret shapes beyond key formats (passwords, URI creds, env dumps, chat tokens)", () => {
    const secrets = [
      "password: CorrectHorseBatteryStaple",
      "db url postgres://admin:s3cr3tpw@db.acme.io:5432/prod",
      "export DB_PASSWORD=hunter2pass",
      "slack token xoxb-2401-2401-aBcDeFgHiJkLmNoP",
    ];
    for (const body of secrets) {
      const temp = tempDbPath();
      const store = new SQLiteRecallStore(temp.path);
      try {
        const result = admitWriteProposal(makeProposal({ content: { body } }), store);
        assert.equal(result.accepted, false, `should reject: ${body}`);
        assert.equal(result.issues.some((issue) => issue.code === "secret_pattern"), true, `secret_pattern for: ${body}`);
        assert.equal(store.stats().nodes, 0);
      } finally {
        store.close();
        temp.cleanup();
      }
    }
  });

  it("does not falsely reject benign prose that merely mentions security words", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const result = admitWriteProposal(
        makeProposal({ content: { body: "The password reset flow emails a link; rotate the API key quarterly per policy." } }),
        store
      );
      assert.equal(result.accepted, true);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("warns (without rejecting) on an oversized body that would bloat compile packets", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const result = admitWriteProposal(makeProposal({ content: { body: "x".repeat(40 * 1024) } }), store);
      assert.equal(result.accepted, true);
      assert.equal(result.warnings.some((warning) => /body is \d+KB/.test(warning)), true);
    } finally {
      store.close();
      temp.cleanup();
    }
  });
});
