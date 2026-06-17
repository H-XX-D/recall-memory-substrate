# Security Policy

Recall is local-first and may handle sensitive operational memory. Treat all
security issues seriously.

## Reporting A Vulnerability

Please report vulnerabilities through GitHub Security Advisories for the
repository. If advisories are not enabled on your fork, open a private channel
with the project maintainers before publishing details.

Do not include real secrets, credentials, personal data, or production memory
databases in reports. Use minimal reproductions.

## Security Boundaries

- Normal graph writes must pass through admission and firewall checks.
- Secret-looking values are rejected from the primary graph by a high-recall
  heuristic. This is a backstop, not a substitute for not pasting secrets into
  prompts or logs.
- Secrets can be stored only through the encrypted Secrets side graph and only
  after explicit confirmation.
- MCP exposes the same operations as Recall. It is not a separate trust
  boundary.
- Runtime databases are local files. Back them up and restore them using the
  documented export/import or file-copy paths in
  [Backup And Recovery](docs/20_BACKUP_AND_RECOVERY.md).

## Threat Model Notes

Recall assumes local filesystem access to the database is privileged. It does
not protect a graph from a user or process that can freely read and write the
SQLite files. The security controls in this repository focus on preventing
accidental primary-graph secret writes, preserving provenance and rollback,
and keeping the MCP surface aligned with the same admission path as the CLI.
