# R1 Secret Side Store

Date: 2026-06-26
Status: first slice implemented on `rewrite/integration`

The admission firewall still rejects recognized secrets in normal write
proposals. When a secret value intentionally needs to be retained, it belongs in
the encrypted side store, not the MAL cell graph.

## Current Contract

`src/secrets.ts` provides `ProjectSecretStore`, backed by the same project SQLite
DB as cells and edges. It creates a `secrets` table with:

- `project`
- boring alias (`sec_` + 12 lowercase hex chars)
- schema version
- key id
- nonce
- ciphertext
- auth tag
- associated-data fingerprint
- created/updated timestamps

Secret payloads are encrypted with AES-256-GCM. Associated data binds the schema
version, project, alias, and key id, so moving a row to another project or alias
breaks authentication. Listing returns only `SecretReference` metadata; plaintext
is available only through `reveal()` with key material supplied by the
`SecretKeyProvider`.

## Alias Policy

Current aliases are intentionally boring and non-descriptive:

```text
sec_4f2a19c8d031
```

Descriptive names such as provider, environment, purpose, or owner are rejected
at the alias boundary. The later Total-Recall hardening pass can add richer
alias governance and metadata controls without changing the current encrypted DB
shape.

## Key Provider Boundary

The module does not talk directly to macOS Keychain, Secure Enclave, TPM, or a
cloud KMS yet. It depends on:

```ts
interface SecretKeyProvider {
  getActiveKey(project: string): SecretKeyMaterial;
  getKey(project: string, keyId: string): SecretKeyMaterial;
}
```

That seam is where the OS/OEM-backed project key unwrap belongs. Tests use
deterministic in-memory keys; production should use a provider that requires
local unlock authority before returning a project DEK.

## Non-Goals In This Slice

- CLI commands such as `secrets save`, `secrets list`, or `secrets reveal`
- macOS Keychain / Secure Enclave provider implementation
- cross-platform key providers
- key rotation workflows
- secret references automatically embedded into cells
