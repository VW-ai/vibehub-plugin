# Skill package architecture audit

Date: 2026-07-21

Status: passed

## Boundary

```text
Skill intelligence and workflow policy
  -> stable kb.* / distill.* semantic operations
  -> dispatcher and validators
  -> repository-aware semantic authority, caches and operational persistence
```

A persistence migration alone must not rewrite intelligence. Public semantic
operation changes may update contracts. CLI, MCP, packaging and host changes
may update mechanical scripts and setup host references.

## Audited inventory

| Layer | Count | Result |
|---|---:|---|
| Entry `SKILL.md` files | 6 | Semantic workflows depend only on operations, lifecycle, provenance, evidence and review rules |
| `_stdlib` references | 8 | Storage claim removed; `operations.md` defines the stable boundary and permitted change zones |
| Skill method/host references | 9 | Domain methods are storage-agnostic; setup references contain only host and packaging mechanics |
| Mechanical scripts | 7 | Use CLI transport, Git inventory, artifact validation and bounded temporary capture; no persistence driver, SQL or semantic-store access |
| Contracts | 7 | Describe public workflow artifacts and operation inputs; contain no persistence paths or authority mechanism |
| Agent metadata | 6 | Names and prompts describe capabilities, not storage |

## Changes made

- Renamed `_stdlib/db-operations.md` to `_stdlib/operations.md`.
- Replaced the stale `SQLite is canonical` ontology statement with governed
  operation/lifecycle/source-kind authority.
- Removed database, SQL, filesystem-checkpoint and session-row language from
  intelligence and references.
- Retained `scripts/_dispatch.mjs` forwarding of the public CLI `--db` option as
  an uninterpreted mechanical configuration. The script never opens or queries
  the configured store; this adapter is an explicitly permitted change point.
- Added package validation and tests that reject storage products, semantic
  store paths and protocol markers in intelligence and contracts.

## Verification

- Every Markdown resource link resolves.
- Every named `kb.*` and `distill.*` operation exists in the canonical registry.
- Progressive reference-loading rules pass.
- Generated operation contract hashes and positive/negative fixtures pass.
- Wrapper, inventory, artifact, schema and bounded-output tests pass.
