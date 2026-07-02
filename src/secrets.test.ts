import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.js";
import {
  ProjectSecretStore,
  type SecretKeyProvider,
  isSecretAlias,
} from "./secrets.js";

function provider(key: Uint8Array, keyId = "test-key"): SecretKeyProvider {
  return {
    getActiveKey() {
      return { keyId, key };
    },
    getKey() {
      return { keyId, key };
    },
  };
}

test("save and reveal round-trip an encrypted project secret", () => {
  const db = openDb(":memory:");
  const store = new ProjectSecretStore(db, provider(Buffer.alloc(32, 7)));

  const ref = store.save({
    project: "alpha",
    value: "plain-value-should-not-appear",
    now: "2026-06-26T12:00:00.000Z",
  });

  assert.equal(isSecretAlias(ref.alias), true);
  assert.equal(ref.project, "alpha");
  assert.equal(ref.createdAt, "2026-06-26T12:00:00.000Z");
  assert.equal(store.reveal("alpha", ref.alias), "plain-value-should-not-appear");
  assert.deepEqual(store.get("alpha", ref.alias), ref);
  db.close();
});

test("encrypted rows and list metadata do not expose plaintext", () => {
  const db = openDb(":memory:");
  const store = new ProjectSecretStore(db, provider(Buffer.alloc(32, 8)));
  const plaintext = "plain-value-should-not-appear";
  const ref = store.save({ project: "alpha", value: plaintext });

  const row = db
    .prepare(
      `SELECT key_id, nonce, ciphertext, tag, aad, created_at, updated_at
       FROM secrets WHERE project = ? AND alias = ?`,
    )
    .get("alpha", ref.alias) as
    | {
        key_id: string;
        nonce: string;
        ciphertext: string;
        tag: string;
        aad: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  assert.ok(row);
  assert.equal(JSON.stringify(row).includes(plaintext), false);
  assert.equal(JSON.stringify(store.list("alpha")).includes(plaintext), false);
  db.close();
});

test("aliases are generated as boring references and descriptive aliases are rejected", () => {
  const db = openDb(":memory:");
  const store = new ProjectSecretStore(db, provider(Buffer.alloc(32, 9)));

  const ref = store.save({ project: "alpha", value: "secret" });
  assert.match(ref.alias, /^sec_[0-9a-f]{12}$/);
  assert.equal(ref.alias.includes("openai"), false);
  assert.equal(ref.alias.includes("prod"), false);

  assert.throws(
    () => store.save({ project: "alpha", alias: "openai_prod_key", value: "secret" }),
    /secret alias must be boring/,
  );
  db.close();
});

test("AAD binding fails if an encrypted row is moved to another project", () => {
  const db = openDb(":memory:");
  const store = new ProjectSecretStore(db, provider(Buffer.alloc(32, 10)));
  const ref = store.save({ project: "alpha", value: "secret" });

  db.prepare(`UPDATE secrets SET project = ? WHERE project = ? AND alias = ?`).run(
    "beta",
    "alpha",
    ref.alias,
  );

  assert.throws(() => store.reveal("beta", ref.alias), /secret decryption failed/);
  db.close();
});

test("decryption fails with the wrong key material", () => {
  const db = openDb(":memory:");
  const good = new ProjectSecretStore(db, provider(Buffer.alloc(32, 11)));
  const ref = good.save({ project: "alpha", value: "secret" });
  const bad = new ProjectSecretStore(db, provider(Buffer.alloc(32, 12)));

  assert.throws(() => bad.reveal("alpha", ref.alias), /secret decryption failed/);
  db.close();
});

test("decryption fails when the provider returns the wrong key id", () => {
  const db = openDb(":memory:");
  const good = new ProjectSecretStore(db, provider(Buffer.alloc(32, 14), "key-a"));
  const ref = good.save({ project: "alpha", value: "secret" });
  const bad = new ProjectSecretStore(db, provider(Buffer.alloc(32, 14), "key-b"));

  assert.throws(() => bad.reveal("alpha", ref.alias), /secret decryption failed/);
  db.close();
});

test("revealing a missing secret returns undefined", () => {
  const db = openDb(":memory:");
  const store = new ProjectSecretStore(db, provider(Buffer.alloc(32, 13)));
  assert.equal(store.reveal("alpha", "sec_000000000000"), undefined);
  db.close();
});
