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

M1A established the complete Git-document read path through Core, CLI, MCP,
and the existing graph HTML. M1B now adds the one deterministic mutation hand
frozen by
[`contract-ticket-git-worktree-patch-001`](specs/contract-ticket-git-worktree-patch-001.yaml):
an exact-source-bound, full-document worktree patch with no SQLite semantic
replay and no embedded workflow judgment.

M2 now adds the first Skill intelligence over that hand:
[`contract-ticket-planning-validation-skills-001`](specs/contract-ticket-planning-validation-skills-001.yaml).
Planning shapes a flat executable graph through Backchain and Forward
Normalize; an independent semantic validator returns graph validity separately
from human execution authority.

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
- [`contract-ticket-git-worktree-patch-001`](specs/contract-ticket-git-worktree-patch-001.yaml):
  Skills receive one receiptless `ticket.worktree.patch` hand. It binds the
  exact worktree, HEAD, semantic graph, raw ledger inventory, and targeted
  Ticket revisions; validates the complete prospective graph; and leaves one
  verified dirty-worktree change for optional separate checkpointing.
- [`contract-ticket-planning-validation-skills-001`](specs/contract-ticket-planning-validation-skills-001.yaml):
  two composable Skills own plan shaping and independent semantic validation.
  Passing graph definitions enter the current graph directly; review and
  protected decisions gate execution rather than activation.

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
- The opaque worktree source token also binds ledger paths, modes, and raw
  bytes, so formatting-only or comment-only edits stale an old write even when
  normalized Ticket semantics have not changed.
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
- The first validated M2 graph must still be reconciled to a fresh Ticket
  source and applied through the active patch; the stale SQLite-backed
  [`contract-ticket-review-operations-001`](specs/contract-ticket-review-operations-001.yaml)
  is not an implementation source.

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

M1B—the exact-source Git worktree patch—is also implemented:

- `ticket.worktree.patch` creates, replaces, or deletes complete Ticket
  documents from one exact source and exact targeted revisions;
- the opaque source token binds raw inventory in addition to normalized
  semantics, preventing silent overwrite of formatting, comment, or mode
  changes;
- Core validates the complete prospective graph before canonical writes,
  installs each file atomically, and reloads the target graph for digest
  verification;
- multi-file and crash atomicity are not claimed; synchronous partial failure
  attempts conditional rollback, while Git commit remains the durable
  multi-file semantic boundary;
- reads and writes remain receiptless with respect to SQLite and are evaluated
  from current Git state on every call;
- protocol-only seed is a valid empty graph; a missing protocol is not
  auto-created by the patch;
- the result returns a precise `checkpointSelection`, but checkpointing is an
  optional separate action and never an implicit patch stage;
- Skills still own why to mutate, semantic validation, review/authority
  boundaries, and whether later semantic document types are needed.

The M2 Skill package is implemented:

- `vibehub-ticket-plan` recognizes planning and graph-tending scenes,
  backchains from observable outcomes, forward-normalizes direct dependencies,
  preserves Planning Fog, and builds one exact patch candidate;
- `vibehub-ticket-validate` independently judges the complete prospective
  graph and reports `passed`, `failed`, or `inconclusive` separately from
  delegated, review, protected-decision, or Planning Fog authority;
- the nine-entrypoint Skill package, focused suite, CLI build, and managed
  artifact copy pass;
- a fresh planning Agent and separate validator completed a real
  fail-revise-pass loop over a seven-Ticket graph.

The validated graph is preserved as a dated exact-bound artifact, but it is not
canonical yet. The public patch could not acquire its required short-lived Git
writer lock under the current sandbox approval policy, and no direct Ticket
file edit was used as a workaround. M2 therefore remains in progress until the
candidate is reconciled to a fresh source, independently revalidated, and
successfully applied.

Proposal, Validation, Decision, and closeout documents should be introduced
from later dogfood need rather than restored as a fixed workflow.

Implementation evidence is recorded in:

- [`Ticket M1A Git read authority cut`](artifacts/2026-07-29-ticket-m1a-git-read-cut-implementation.md)
- [`Ticket M1B exact-source worktree patch`](artifacts/2026-07-29-ticket-m1b-git-worktree-patch-implementation.md)
- [`Ticket M2 planning and independent validation Skills`](artifacts/2026-07-29-ticket-m2-planning-validation-skills.md)
- [`First Git Ticket Graph validated candidate`](artifacts/2026-07-29-first-git-ticket-graph-validated-candidate.json)
