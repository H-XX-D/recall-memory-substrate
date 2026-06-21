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

## The admission firewall

The rejection in the first rule is enforced by `src/core/firewall.ts`, which
screens every write proposal before admission and refuses content that matches a
known secret shape:

- vendor key prefixes (for example Stripe `sk_live_` / `rk_live_`, AWS secret
  access keys),
- private-key blocks (`-----BEGIN ... PRIVATE KEY-----`),
- secret-named assignments (`password:`, `api_key=`, `client_secret=`, and the
  like, where a six-or-more-character value follows),
- `KEY=value` env dumps whose key name itself reads as a secret (for example
  `export DB_PASSWORD=...`),

and it rejects outright any proposal marked `policy.sensitivity: "secret"`. It is
a high-recall heuristic backstop, not a guarantee: it stops the common accidents
(an agent pasting a live credential into memory), but it cannot catch a secret
that does not look like one, so a bare high-entropy string with no telltale name
will pass. Treat it as the net that keeps obvious leaks out of the plaintext
graph, and put anything you actually need to keep in the encrypted side graph
below.

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

