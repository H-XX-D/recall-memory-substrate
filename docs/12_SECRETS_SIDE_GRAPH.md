# Secrets Side Graph

Recall's primary graph must reject secrets. Secret-looking content should not
enter normal memory, context packets, witnesses, tasks, or rollback records.

When the user explicitly wants secret storage, Recall uses a separate encrypted
Secrets side graph.

## Rules

- Secrets are never saved by normal `admit` or `write-propose` commands.
- Saving a secret requires `recall secrets save --confirm-secret-save`.
- Secret payloads are encrypted with AES-256-GCM.
- Keys are derived from a user password with scrypt.
- The side graph stores minimal metadata in cleartext: id, title, tags, scope,
  created time, and updated time.
- The encrypted payload is stored as an envelope containing salt, iv, auth tag,
  ciphertext, cipher name, KDF name, and version.
- Listing secrets never prints plaintext.
- Reading a secret requires the password again.
- Passwords should be passed through stdin, not command-line arguments.

## CLI

Save:

```bash
printf 'password\nsecret-value' | recall secrets save \
  --title "service token" \
  --tags service,local \
  --scope local \
  --confirm-secret-save \
  --password-stdin \
  --value-stdin
```

List metadata:

```bash
recall secrets list
```

Read:

```bash
printf 'password\n' | recall secrets get <secret-id> --password-stdin
```

## Isolation

Default primary graph:

```text
.recall/recall.sqlite3
```

Default encrypted side graph:

```text
.recall/secrets.sqlite3
```

The `.recall/` directory is ignored by git.

## Design Boundary

The secrets side graph exists because users sometimes need agent-adjacent secret
storage, but it must not weaken the normal memory firewall. The normal graph
should keep rejecting API keys, bearer tokens, private keys, and other
secret-looking content.

