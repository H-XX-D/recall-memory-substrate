// Encrypted project secret side store. Secret values never become cells; the
// graph only receives boring aliases like sec_4f2a19c8d031.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { openDb, type Db } from "./db.js";

export const SECRET_SCHEMA_VERSION = 1;
export const SECRET_ALIAS_RE = /^sec_[0-9a-f]{12}$/;
const SECRET_ALGORITHM = "aes-256-gcm";
const SECRET_KEY_BYTES = 32;
const SECRET_NONCE_BYTES = 12;
const SECRET_TAG_BYTES = 16;

export interface SecretKeyMaterial {
  keyId: string;
  key: Uint8Array;
}

export interface SecretKeyProvider {
  getActiveKey(project: string): SecretKeyMaterial;
  getKey(project: string, keyId: string): SecretKeyMaterial;
}

export interface SaveSecretInput {
  project: string;
  value: string | Uint8Array;
  alias?: string;
  now?: string;
}

export interface SecretReference {
  project: string;
  alias: string;
  schemaVersion: typeof SECRET_SCHEMA_VERSION;
  createdAt: string;
  updatedAt: string;
}

interface SecretRow {
  project: string;
  alias: string;
  schema_version: number;
  key_id: string;
  nonce: string;
  ciphertext: string;
  tag: string;
  aad: string;
  created_at: string;
  updated_at: string;
}

export class SecretDecryptionError extends Error {
  constructor() {
    super("secret decryption failed");
    this.name = "SecretDecryptionError";
  }
}

export function ensureSecretsSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS secrets (
      project TEXT NOT NULL,
      alias TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      key_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      tag TEXT NOT NULL,
      aad TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project, alias)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_secrets_project ON secrets(project)");
}

export function generateSecretAlias(): string {
  return `sec_${randomBytes(6).toString("hex")}`;
}

export function isSecretAlias(value: string): boolean {
  return SECRET_ALIAS_RE.test(value);
}

export class ProjectSecretStore {
  private db: Db;
  private ownsDb: boolean;

  constructor(pathOrDb: string | Db, private keys: SecretKeyProvider) {
    if (typeof pathOrDb === "string") {
      this.db = openDb(pathOrDb);
      this.ownsDb = true;
    } else {
      this.db = pathOrDb;
      this.ownsDb = false;
    }
    ensureSecretsSchema(this.db);
  }

  save(input: SaveSecretInput): SecretReference {
    const project = normalizeProject(input.project);
    const alias = input.alias ? normalizeAlias(input.alias) : this.generateUniqueAlias(project);
    const active = normalizeKeyMaterial(this.keys.getActiveKey(project));
    const plaintext = secretBytes(input.value);
    const now = input.now ?? new Date().toISOString();
    const aad = secretAad(project, alias, active.keyId);
    const nonce = randomBytes(SECRET_NONCE_BYTES);
    const cipher = createCipheriv(SECRET_ALGORITHM, active.key, nonce, {
      authTagLength: SECRET_TAG_BYTES,
    });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    this.db
      .prepare(
        `INSERT INTO secrets
           (project, alias, schema_version, key_id, nonce, ciphertext, tag, aad, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project, alias) DO UPDATE SET
           schema_version = excluded.schema_version,
           key_id = excluded.key_id,
           nonce = excluded.nonce,
           ciphertext = excluded.ciphertext,
           tag = excluded.tag,
           aad = excluded.aad,
           updated_at = excluded.updated_at`,
      )
      .run(
        project,
        alias,
        SECRET_SCHEMA_VERSION,
        active.keyId,
        b64(nonce),
        b64(ciphertext),
        b64(tag),
        b64(aad),
        now,
        now,
      );

    const ref = this.get(project, alias);
    if (!ref) throw new Error("secret save failed");
    return ref;
  }

  get(project: string, alias: string): SecretReference | undefined {
    const row = this.row(normalizeProject(project), normalizeAlias(alias));
    return row ? rowToReference(row) : undefined;
  }

  list(project: string): SecretReference[] {
    const normalizedProject = normalizeProject(project);
    const rows = this.db
      .prepare(
        `SELECT project, alias, schema_version, key_id, nonce, ciphertext, tag, aad, created_at, updated_at
         FROM secrets WHERE project = ? ORDER BY alias`,
      )
      .all(normalizedProject) as unknown as SecretRow[];
    return rows.map((row) => rowToReference(row));
  }

  reveal(project: string, alias: string): string | undefined {
    const normalizedProject = normalizeProject(project);
    const normalizedAlias = normalizeAlias(alias);
    const row = this.row(normalizedProject, normalizedAlias);
    if (!row) return undefined;
    if (row.schema_version !== SECRET_SCHEMA_VERSION) {
      throw new Error(`unsupported secret schema version: ${row.schema_version}`);
    }
    const material = normalizeKeyMaterial(this.keys.getKey(normalizedProject, row.key_id));
    if (material.keyId !== row.key_id) throw new SecretDecryptionError();
    const aad = secretAad(row.project, row.alias, row.key_id);
    if (row.aad !== b64(aad)) throw new SecretDecryptionError();
    try {
      const decipher = createDecipheriv(SECRET_ALGORITHM, material.key, fromB64(row.nonce), {
        authTagLength: SECRET_TAG_BYTES,
      });
      decipher.setAAD(aad);
      decipher.setAuthTag(fromB64(row.tag));
      return Buffer.concat([
        decipher.update(fromB64(row.ciphertext)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new SecretDecryptionError();
    }
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }

  private generateUniqueAlias(project: string): string {
    for (let i = 0; i < 16; i++) {
      const alias = generateSecretAlias();
      if (!this.row(project, alias)) return alias;
    }
    throw new Error("unable to allocate a unique secret alias");
  }

  private row(project: string, alias: string): SecretRow | undefined {
    return this.db
      .prepare(
        `SELECT project, alias, schema_version, key_id, nonce, ciphertext, tag, aad, created_at, updated_at
         FROM secrets WHERE project = ? AND alias = ?`,
      )
      .get(project, alias) as SecretRow | undefined;
  }
}

function rowToReference(row: SecretRow): SecretReference {
  if (row.schema_version !== SECRET_SCHEMA_VERSION) {
    throw new Error(`unsupported secret schema version: ${row.schema_version}`);
  }
  return {
    project: row.project,
    alias: row.alias,
    schemaVersion: SECRET_SCHEMA_VERSION,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeProject(project: string): string {
  if (typeof project !== "string") throw new Error("project must be a string");
  const value = project.trim();
  if (!value) throw new Error("project is required");
  if (value.length > 128) throw new Error("project is too long");
  if (value.includes("\0")) throw new Error("project contains a null byte");
  return value;
}

function normalizeAlias(alias: string): string {
  if (typeof alias !== "string") throw new Error("secret alias must be a string");
  if (!isSecretAlias(alias)) {
    throw new Error("secret alias must be boring: sec_ followed by 12 lowercase hex chars");
  }
  return alias;
}

function normalizeKeyMaterial(material: SecretKeyMaterial): { keyId: string; key: Buffer } {
  const keyId = material.keyId.trim();
  if (!keyId) throw new Error("secret key id is required");
  if (keyId.length > 128) throw new Error("secret key id is too long");
  if (keyId.includes("\0")) throw new Error("secret key id contains a null byte");
  const key = Buffer.from(material.key);
  if (key.byteLength !== SECRET_KEY_BYTES) {
    throw new Error(`secret key must be ${SECRET_KEY_BYTES} bytes`);
  }
  return { keyId, key };
}

function secretBytes(value: string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

function secretAad(project: string, alias: string, keyId: string): Buffer {
  return Buffer.from(
    JSON.stringify(["recall.secret", SECRET_SCHEMA_VERSION, project, alias, keyId]),
    "utf8",
  );
}

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function fromB64(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
