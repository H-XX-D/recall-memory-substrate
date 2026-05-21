import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decryptSecret, encryptSecret, SecretGraphStore } from "../src/core/secrets.js";
import { tempDbPath } from "./helpers.js";

describe("encrypted secrets side graph", () => {
  it("encrypts and decrypts secret payloads with a password", () => {
    const envelope = encryptSecret("side graph secret payload", "correct horse battery staple");

    assert.notEqual(envelope.ciphertext, "side graph secret payload");
    assert.equal(decryptSecret(envelope, "correct horse battery staple"), "side graph secret payload");
    assert.throws(() => decryptSecret(envelope, "wrong password"));
  });

  it("stores only encrypted secret payloads in the side graph database", () => {
    const temp = tempDbPath();
    const store = new SecretGraphStore(temp.path);
    try {
      const saved = store.save({
        title: "API credential placeholder",
        plaintext: "never-store-this-plaintext",
        password: "test-password",
        tags: ["api", "local"],
        scope: "test"
      });

      assert.equal(store.stats().secretNodes, 1);
      assert.equal(store.list()[0]?.id, saved.id);
      assert.equal(store.get(saved.id, "test-password")?.plaintext, "never-store-this-plaintext");

      const dbBytes = readFileSync(temp.path).toString("latin1");
      assert.equal(dbBytes.includes("never-store-this-plaintext"), false);
      assert.equal(dbBytes.includes("API credential placeholder"), true);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("rejects empty passwords and empty plaintext", () => {
    const temp = tempDbPath();
    const store = new SecretGraphStore(temp.path);
    try {
      assert.throws(() =>
        store.save({
          title: "bad",
          plaintext: "",
          password: "test-password",
          tags: [],
          scope: "test"
        })
      );
      assert.throws(() =>
        store.save({
          title: "bad",
          plaintext: "value",
          password: "",
          tags: [],
          scope: "test"
        })
      );
    } finally {
      store.close();
      temp.cleanup();
    }
  });
});

