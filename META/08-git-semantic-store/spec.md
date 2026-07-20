# 08-git-semantic-store — Git Semantic Store

This room is an architecture exploration, not an approved migration.

## Draft intent

Durable semantic truth may move to strict, versioned YAML tracked by Git so
intent, decisions, constraints, specs, relations and provenance gain native
diff, review, branch, merge and clone semantics.

SQLite would remain the operational database for sessions, hooks, events,
checkpoint cadence, injection claims, writer leases, Run state, live timeline,
indexes and materialized projections.

## Current authority

**SQLite remains the source of truth.** Existing implementation and
`decision-workbench-011/012` remain valid until a successful spike and explicit
architecture review supersede them.

## First gate

Prove a lossless round trip:

```text
SQLite durable semantic subset
  → deterministic strict YAML
  → clean SQLite
```

Identity, relations, revisions, activation pointers and provenance must rebuild
without semantic loss. Until then:

- no canonical write-through;
- no one-table-per-file migration;
- no hook/session/distillation-run state in Git;
- no App dependency on a proposed YAML layout.
# Canonical Specs

- [intent-project-004] (draft) Explore Git/YAML for durable semantics while
  SQLite remains the approved canonical and operational store.
