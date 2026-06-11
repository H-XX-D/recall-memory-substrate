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
- Secret-looking values are rejected from the primary graph.
- Secrets can be stored only through the encrypted Secrets side graph and only
  after explicit confirmation.
- MCP exposes the same operations as Recall. It is not a separate trust
  boundary.
