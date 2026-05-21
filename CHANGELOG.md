# Changelog

All notable changes to Recall will be documented in this file.

The format follows a simple release-oriented structure and the project uses
semantic versioning once public releases begin.

## 0.1.0 - Unreleased

### Added

- Strict `recall.write.v1` admission path with firewall checks and rollback.
- SQLite-backed graph store with addressable cells and tag-composed subgraphs.
- Local semantic search with a deterministic hash backend.
- Encrypted Secrets side graph with explicit save confirmation.
- CLI, read-only TUI, and stdio MCP server.
- Background daemon maintenance path with SQLite-backed lease control.
- N-ary hyperedges, sandboxed hyperedge programs, DAG overlays, holonomy
  analysis, derivation closure, and eval persistence.
- End-to-end release smoke script covering user and agent workflows.
