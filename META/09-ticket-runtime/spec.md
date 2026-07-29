# 09-ticket-runtime — Ticket Runtime

> Build a Git-native, Skill-driven Ticket system in which a fresh Agent can
> understand, execute, validate, and close the correct next unit of work.

## Current direction

Ticket Runtime is a Skill-operated Git collaboration protocol:

```text
Git documents  = durable semantic memory
Skills         = planning, judgment, orchestration, execution, closeout
Skill scripts  = deterministic reads, validation, diffing, and writes
HTML           = human projection and intervention surface
SQLite         = disposable live coordination, index, and cache
```

The implementation pivot is planned in
[`2026-07-29-ticket-git-native-skill-driven-pivot-plan.md`](artifacts/2026-07-29-ticket-git-native-skill-driven-pivot-plan.md).

The immediate code slice is frozen in
[`2026-07-29-ticket-m1a-git-read-cut-handoff.md`](artifacts/2026-07-29-ticket-m1a-git-read-cut-handoff.md):
one complete Git-document read path through Core, CLI, MCP, and the existing
graph HTML, with no SQLite semantic replay.

## Canonical decisions

### Product and intelligence

- [`decision-ticket-work-unit-001`](specs/decision-ticket-work-unit-001.yaml):
  Ticket is the only canonical durable work unit.
- [`decision-ticket-contract-002`](specs/decision-ticket-contract-002.yaml):
  Ticket is an executable context package with one stable outcome promise.
  Tickets form a flat typed-relation graph; there is no mandatory parent
  hierarchy.
- [`decision-ticket-intelligence-loop-001`](specs/decision-ticket-intelligence-loop-001.yaml):
  the Agent creates and tends Tickets within delegated boundaries and raises
  genuine product, principle, permission, or risk decisions to a human.
- [`convention-ticket-backchain-forward-normalize-002`](specs/convention-ticket-backchain-forward-normalize-002.yaml):
  planning backchains from observable outcomes, then reads forward to remove
  duplicates, dead ends, orphans, and false serialization.

### Authority and architecture

- [`decision-ticket-git-native-ledger-001`](specs/decision-ticket-git-native-ledger-001.yaml):
  all durable Ticket semantics—from definitions and proposals through
  Decisions, Outcomes, Evidence, and semantic receipts—follow Git.
- [`decision-ticket-skill-driven-boundary-001`](specs/decision-ticket-skill-driven-boundary-001.yaml):
  Skills own semantic orchestration; bundled scripts and shared libraries are
  deterministic hands rather than a workflow engine.
- [`decision-ticket-graph-lifecycle-002`](specs/decision-ticket-graph-lifecycle-002.yaml):
  Git ref/commit/worktree semantics own graph history and collaboration.
  Proposal, Validation, Decision, and Receipt documents exist when their
  meaning is needed, not as mandatory stages.
- [`decision-ticket-mvp-002`](specs/decision-ticket-mvp-002.yaml):
  the first dogfood loop is Git documents + Skills + deterministic scripts +
  graph HTML + disposable runtime.

### Human surface

- [`decision-ticket-review-surface-001`](specs/decision-ticket-review-surface-001.yaml):
  the default view is one complete zoomable direct-unlock graph answering
  “when this finishes, what may execute next?” Scenario is a derived review
  lens; the graph remains the same typed Ticket graph.
- [`convention-ticket-runtime-artifacts-001`](specs/convention-ticket-runtime-artifacts-001.yaml):
  high-value HTML and decision-shaping artifacts remain versioned references;
  canonical Specs become active after machine validation rather than a default
  draft/human-promotion lifecycle.

## Worktree model

- Each worktree reads the Ticket documents in its checked-out Git tree.
- Dirty Ticket documents are pending local semantic changes.
- Commits are durable branch truth; push/PR exposes collaborative proposals.
- SQLite Run state binds exact worktree, HEAD or dirty graph digest, Ticket ID,
  and Ticket revision.
- Branch switches or relevant Ticket edits stale/suspend an old Run.
- Deleting SQLite may lose a heartbeat or claim, but never Ticket meaning,
  decisions, accepted completion, or evidence.

## Open focused decisions

- [`decision-ticket-context-binding-001`](specs/decision-ticket-context-binding-001.yaml):
  exact Feature Room and repository context compilation.
- [`decision-ticket-workflow-role-001`](specs/decision-ticket-workflow-role-001.yaml):
  reusable method/intelligence assets without introducing a generic workflow
  engine.
- [`decision-ticket-closeout-001`](specs/decision-ticket-closeout-001.yaml):
  final Outcome/Evidence adjudication and semantic closeout.
- A successor deterministic operation contract is still needed for the Git
  document protocol; the previous SQLite-backed
  [`contract-ticket-review-operations-001`](specs/contract-ticket-review-operations-001.yaml)
  is stale.

## Historical implementation artifacts

The following remain valuable provenance and code archaeology, but their
SQLite authority, generation/latest, trusted-provider, and cross-store fenced
application paths are superseded:

- [`ticket generation publisher contract`](artifacts/2026-07-28-ticket-generation-publisher-contract.md)
- [`proposal query and validation ledger`](artifacts/2026-07-29-proposal-query-validation-ledger.md)
- [`proposal authority contract`](artifacts/2026-07-29-ticket-proposal-authority-contract.md)
- [`proposal application runtime`](artifacts/2026-07-29-ticket-proposal-application-runtime.md)
- [`local review host and planning entrypoint`](artifacts/2026-07-29-ticket-review-host-and-planning-entrypoint.md)

The accepted visual reference remains:

- [`Ticket review surface prototype v4`](artifacts/2026-07-28-ticket-review-surface-prototype-v4.html)

The earlier first-dogfood plan and JSON proposal remain source material. They
must be regenerated under the new flat typed-relation Git document protocol;
they are not migration inputs or current runtime facts.

## Current implementation status

M1A—the Git read authority cut—is implemented:

- `.vibehub/tickets/protocol.yaml` plus flat Ticket YAML documents are the only
  production Ticket graph source;
- Core, CLI, MCP, and the HTML host expose the same three pure reads;
- the graph HTML is intentionally read-only while retaining full topology,
  pan/zoom/fit, minimap, causal focus, and executable-context inspection;
- Ticket reads require no SQLite repository/task identity and create no
  operation receipts;
- the early-stage generation store, proposal/application services, semantic
  SQLite tables, write operations, and three obsolete Ticket Skills are
  retired.

The next implementation boundary is M1B: one validated, exact-source-bound
worktree patch capability for Skills. Planning, semantic validation, decisions,
and closeout documents should be designed through that dogfood loop rather
than restored as a fixed workflow.

Implementation evidence and the deletion ledger are recorded in
[`2026-07-29-ticket-m1a-git-read-cut-implementation.md`](artifacts/2026-07-29-ticket-m1a-git-read-cut-implementation.md).
