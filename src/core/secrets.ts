import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scryptSync
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ENVELOPE_VERSION = "recall.secret.v1";
const KDF = "scrypt";
const CIPHER = "aes-256-gcm";
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const SCRYPT_COST = 16384;

export interface SecretSaveInput {
  title: string;
  plaintext: string;
  password: string;
  tags: string[];
  scope: string;
  now?: Date;
}

export interface SecretNodeMetadata {
  id: string;
  title: string;
  tags: string[];
  scope: string;
  createdAt: string;
  updatedAt: string;
}

export interface SecretNode extends SecretNodeMetadata {
  plaintext: string;
}

export interface SecretStats {
  secretNodes: number;
  secretRelations: number;
}

interface SecretEnvelope {
  version: typeof ENVELOPE_VERSION;
  kdf: typeof KDF;
  cipher: typeof CIPHER;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  scrypt: {
    cost: number;
    keyBytes: number;
  };
}

export class SecretGraphStore {
  private readonly db: DatabaseSync;

  constructor(readonly path: string = ".recall/secrets.sqlite3") {
    const dbPath = resolve(path);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  save(input: SecretSaveInput): SecretNodeMetadata {
    assertSecretInput(input);
    const now = (input.now ?? new Date()).toISOString();
    const node: SecretNodeMetadata = {
      id: randomUUID(),
      title: input.title,
      tags: normalizeTags(input.tags),
      scope: input.scope,
      createdAt: now,
      updatedAt: now
    };
    const envelope = encryptSecret(input.plaintext, input.password);

    this.db
      .prepare(
        `INSERT INTO secret_nodes
          (id, title, tags_json, scope, envelope_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        node.id,
        node.title,
        JSON.stringify(node.tags),
        node.scope,
        JSON.stringify(envelope),
        node.createdAt,
        node.updatedAt
      );

    return node;
  }

  get(id: string, password: string): SecretNode | null {
    if (password.trim() === "") {
      throw new Error("Secret password cannot be empty");
    }
    const row = this.db.prepare("SELECT * FROM secret_nodes WHERE id = ?").get(id) as SecretRow | undefined;
    if (!row) {
      return null;
    }
    const metadata = rowToMetadata(row);
    const envelope = JSON.parse(row.envelope_json) as SecretEnvelope;
    return {
      ...metadata,
      plaintext: decryptSecret(envelope, password)
    };
  }

  list(limit = 20): SecretNodeMetadata[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, tags_json, scope, created_at, updated_at
         FROM secret_nodes
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(limit) as unknown as SecretMetadataRow[];
    return rows.map(rowToMetadata);
  }

  stats(): SecretStats {
    return {
      secretNodes: count(this.db, "secret_nodes"),
      secretRelations: count(this.db, "secret_relations")
    };
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS secret_nodes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        scope TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS secret_relations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_secret_nodes_scope ON secret_nodes(scope);
      CREATE INDEX IF NOT EXISTS idx_secret_nodes_updated ON secret_nodes(updated_at);
      CREATE INDEX IF NOT EXISTS idx_secret_relations_source ON secret_relations(source_id);
      CREATE INDEX IF NOT EXISTS idx_secret_relations_target ON secret_relations(target_id);
    `);
  }
}

export function encryptSecret(plaintext: string, password: string): SecretEnvelope {
  if (password.trim() === "") {
    throw new Error("Secret password cannot be empty");
  }
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv(CIPHER, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    version: ENVELOPE_VERSION,
    kdf: KDF,
    cipher: CIPHER,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    scrypt: {
      cost: SCRYPT_COST,
      keyBytes: KEY_BYTES
    }
  };
}

export function decryptSecret(envelope: SecretEnvelope, password: string): string {
  validateEnvelope(envelope);
  if (password.trim() === "") {
    throw new Error("Secret password cannot be empty");
  }

  const salt = Buffer.from(envelope.salt, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const authTag = Buffer.from(envelope.authTag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const key = deriveKey(password, salt);
  const decipher = createDecipheriv(CIPHER, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

function deriveKey(password: string, salt: Buffer): Buffer {
  const key = scryptSync(password, salt, KEY_BYTES, { N: SCRYPT_COST });
  return Buffer.from(key);
}

function validateEnvelope(envelope: SecretEnvelope): void {
  if (
    envelope.version !== ENVELOPE_VERSION ||
    envelope.kdf !== KDF ||
    envelope.cipher !== CIPHER ||
    envelope.scrypt?.keyBytes !== KEY_BYTES
  ) {
    throw new Error("Unsupported secret envelope");
  }
}

function assertSecretInput(input: SecretSaveInput): void {
  if (input.title.trim() === "") {
    throw new Error("Secret title is required");
  }
  if (input.plaintext === "") {
    throw new Error("Secret plaintext cannot be empty");
  }
  if (input.password.trim() === "") {
    throw new Error("Secret password cannot be empty");
  }
  if (input.scope.trim() === "") {
    throw new Error("Secret scope is required");
  }
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].sort();
}

interface SecretMetadataRow {
  id: string;
  title: string;
  tags_json: string;
  scope: string;
  created_at: string;
  updated_at: string;
}

interface SecretRow extends SecretMetadataRow {
  envelope_json: string;
}

function rowToMetadata(row: SecretMetadataRow): SecretNodeMetadata {
  return {
    id: row.id,
    title: row.title,
    tags: JSON.parse(row.tags_json) as string[],
    scope: row.scope,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function count(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
  return row.count;
}
