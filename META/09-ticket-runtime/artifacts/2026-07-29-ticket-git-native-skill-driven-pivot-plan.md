# Ticket Runtime: Git-native, Skill-driven pivot plan

Date: 2026-07-29
Status: working implementation plan
Authority: derived from the active successor Specs in this room

## Outcome

Replace the current SQLite-authority / generation-publication Ticket path with
a smaller system in which:

```text
Git documents  = durable semantic memory
Skills         = planning, judgment, orchestration, execution, closeout
Skill scripts  = deterministic reads, validation, diffing, and writes
HTML           = human projection and intervention surface
SQLite         = disposable live coordination, index, and cache
```

The pivot is successful when one real Plugin feature can be planned, optionally
reviewed, executed, verified, and closed through Tickets; a fresh clone can
recover the complete semantic loop without the local SQLite database.

## Why this is a pivot

The current implementation contains valuable planning intelligence and graph
UX, but its semantic write path became a trusted publication subsystem:

- `.vibehub/ticket-store/` models immutable definitions, generations, and a
  mutable `latest.yaml`;
- SQLite owns proposal, validation, authority-decision, application-intent,
  and application-receipt ledgers;
- Git visibility and SQLite receipt persistence are coordinated through a
  durable writer fence and crash-recovery protocol;
- the local review host participates in a trusted authority-provider flow.

That assurance model is internally coherent, but it duplicates Git history and
makes the database a second durable semantic authority. It also puts most
engineering effort into publication machinery while the executable Ticket
context and actual plan-to-outcome loop remain unfinished.

The project already ratified the correct repository-wide split in
`decision-project-028`: Git owns durable semantics, SQLite owns operational
truth and rebuildable caches. Ticket Runtime should conform to that decision.

## Frozen pivot invariants

1. Deleting SQLite can interrupt a live Run, but cannot remove a Ticket,
   planning decision, semantic validation, applied change, Outcome, or accepted
   Evidence reference.
2. Skills decide what the work means and what should happen next. Scripts and
   shared libraries enforce only deterministic mechanics.
3. Ticket nodes form a flat typed-relation graph. No mandatory `parentId` or
   hidden containment hierarchy exists.
4. Git ref/commit/worktree identity is the semantic namespace. Branch facts
   are never silently unioned.
5. Proposal, Validation, Decision, and Receipt are semantic document types, not
   mandatory workflow stages.
6. There is one authority cutover and no Git/SQLite semantic dual-write.
7. Existing early-stage Ticket DB rows and generation files have no migration
   or compatibility obligation.

## Target document protocol

Recommended v0 root:

```text
.vibehub/tickets/
  protocol.yaml
  tickets/<ticket-id>.yaml
  proposals/<proposal-id>.yaml
  validations/<proposal-id>/<validation-id>.yaml
  decisions/<subject-id>/<decision-id>.yaml
  applications/<proposal-id>/<receipt-id>.yaml
  outcomes/<ticket-id>/<outcome-id>.yaml
  evidence/<ticket-id>/<evidence-id>.yaml
```

The format is structured YAML with Markdown-capable prose fields. Stable
identity-derived paths minimize unrelated merge conflicts. Inventory, relation
indexes, graph snapshots, and semantic digests are derived rather than stored
in a mutable global manifest.

`protocol.yaml` declares only the version and invariant vocabulary. It does
not identify a mutable latest generation.

The protocol must distinguish:

| Durable Git fact | Meaning |
|---|---|
| Ticket | Stable outcome promise and executable context contract |
| Typed relation | Dependency/unlock, contribution, supersession, evidence, or other explicit graph meaning |
| Proposal | A bounded candidate semantic change when review or durable comparison is useful |
| Validation | Independent semantic findings bound to exact candidate/source digests |
| Decision | Human or delegated authority over an exact protected question |
| Application receipt | Proof that one exact candidate became the current worktree/branch Ticket world |
| Outcome | Attempted, partial, failed, or successful result bound to a Ticket revision and Run |
| Evidence | Durable proof reference and adjudication metadata |

Transport request receipts, retries, file-watch cursors, leases, heartbeat, and
browser capabilities remain local runtime facts.

## Worktree and branch semantics

- A worktree reads the Ticket documents in its checked-out tree.
- Uncommitted Ticket changes are pending local semantics and must be visible as
  dirty Ticket changes.
- A commit is durable branch truth; push/PR makes it collaborative.
- A merge conflict is an explicit semantic conflict, not something a local DB
  should resolve behind Git.
- A Run binds repository identity, stable worktree identity, HEAD when clean,
  dirty graph digest when applicable, Ticket ID, and Ticket revision.
- Branch name is display metadata. It is not sufficient Run identity.
- Switching branches or changing the bound Ticket revision suspends/stales the
  old Run.
- The same Ticket ID on two branches or worktrees may run independently. A
  warning is allowed; a global semantic lock is not.

## What is reused

| Existing asset | Reuse |
|---|---|
| `skills/vibehub-ticket-plan/SKILL.md` | Keep backchain, forward-normalize, Planning Fog, human-boundary judgment |
| `skills/vibehub-ticket-validate/SKILL.md` | Keep independent semantic validation rubric; write Git validation documents |
| `packages/core/src/ticket-review-projector.ts` and read-service seams | Keep pure graph projection and bounded reads; change source to the Git document ledger |
| `packages/cli/assets/ticket-review-host/` | Keep layout, pan/zoom, Inspector, quiet visual language |
| `packages/core/src/git-facade.ts` | Keep repository/common-dir/worktree resolution |
| Ticket contract types and validators | Reuse stable identity, exact binding, canonical serialization, DAG and stale checks after removing storage-specific fields |
| Existing semantic checkpoint discipline | Extend path coverage to Ticket semantic documents rather than inventing a second commit system |

## What changes or disappears

| Current area | Pivot |
|---|---|
| `ticket_proposals` and four related Ticket ledgers in `db.ts` | Git documents; later delete tables and triggers |
| `ticket-proposal-service.ts` | Keep candidate materialization and validation; replace SQL persistence/query with Git document operations |
| `ticket-application-service.ts` | Reduce to exact-base/digest check plus one validated Git worktree change set |
| `git-ticket-store.ts` | Keep safe reads, canonical bytes, graph validation; remove internal generations, `latest.yaml`, and cross-store fence |
| `ticket-review-host.ts` | Keep local serving/projection; remove trusted-provider and dual-store authority responsibilities |
| `vibehub-ticket-apply` | Become a Skill-led Git proposal/validation/decision/apply loop |
| CLI/MCP dispatcher | Keep a thin common capability surface; remove DB semantic ownership |

## Implementation sequence

The sequence deliberately establishes the new authority before deleting the old
code, while forbidding production dual-write.

### M0 — Freeze the authority cut

Outcome: META and tests express the new source-of-truth boundary before runtime
changes begin.

Work:

- activate the successor decisions accompanying this plan;
- mark the old storage/runtime/contract/lifecycle/MVP path superseded or stale;
- add one invariant test fixture containing Ticket, relation, Proposal,
  Validation, Decision, ApplicationReceipt, Outcome, and Evidence;
- document the old runtime as historical implementation evidence only.

Acceptance:

- no active Spec claims that SQLite owns Ticket semantic receipts;
- no active Spec requires a mandatory containment parent;
- the fixture can be understood without database or conversation history;
- the pivot has an explicit no-migration and no-dual-write rule.

### M1 — Build the Git Ticket ledger kernel

Outcome: a fresh process reconstructs the full Ticket semantic world from one
worktree or Git ref.

Work:

- define the small document schemas and stable path rules;
- implement canonical parse/serialize, bounded safe reads, exact ref/worktree
  loading, derived inventory/graph digest, typed relation validation, and
  deterministic queries;
- add atomic worktree writes with exact base/digest preconditions;
- extend semantic checkpoint validation/path isolation to the Ticket root;
- adapt the existing review projector to the new reader.

Acceptance:

- deleting a disposable DB does not change loaded Ticket semantics;
- two worktrees at different commits display their own graphs without leakage;
- dirty Ticket changes are reported distinctly from committed branch truth;
- invalid schema, missing references, unsupported relation types, cycles where
  prohibited, duplicate IDs, and stale bases fail with actionable errors;
- no production read falls back to SQLite or `.vibehub/ticket-store`;
- no internal generation or mutable latest pointer is required.

### M2 — Move planning, validation, and apply to Skills

Outcome: the Agent creates and tends the Git Ticket graph through composable
intelligence rather than a hard-coded workflow.

Work:

- update `vibehub-ticket-plan` to emit Git proposal/current-graph documents;
- update `vibehub-ticket-validate` to inspect exact Git facts and write a
  bound Validation document;
- simplify `vibehub-ticket-apply` to choose the next semantic action, invoke
  deterministic stale/DAG checks, request a human Decision only for protected
  boundaries, and apply one file change set;
- package reader/writer/validator scripts behind stable Skill-facing commands;
- expose two planning policies:
  `review-plan` and `auto-apply-unless-human-gate`.

Acceptance:

- a fresh Agent can plan parallel paths, joins, blockers, and honest Planning
  Fog from a deliverable;
- forward normalization removes duplicates, dead ends, false serialization,
  and orphan outcome paths without requiring hierarchy;
- ordinary technical choices proceed under delegation;
- experience/product, architecture/principle deviation, permission/side-effect,
  and risk/policy boundaries create a Git-native blocker/Decision;
- stale HEAD or graph digest blocks apply and leaves a clear recoverable diff;
- scripts contain no policy for deciding whether a semantic change is useful
  or human-owned;
- planning, validation, and apply perform no Ticket semantic SQLite read/write.

### M3 — Make HTML a pure projection and review surface

Outcome: the accepted graph experience remains, with Git documents as its only
semantic backing.

Work:

- feed the current worktree/ref ledger into the existing graph projector;
- make comments, simple edits, plan review, and decisions produce inspectable
  Git document patches;
- remove trusted authority-provider minting and SQLite application receipt
  verification from the host;
- display committed ref/commit, dirty semantic changes, stale base, and human
  blockers without turning the page into a dashboard.

Acceptance:

- pan/zoom/fit, deterministic orthogonal routing, complete graph visibility,
  causal focus, and Inspector behavior remain intact;
- the page answers “when this finishes, what may execute next?”;
- reload after DB deletion preserves every semantic node, relation, decision,
  outcome, and evidence item;
- no UI-only or SQLite-only comment/edit/decision exists;
- HTML owns no lifecycle, authority model, or source of truth.

### M4 — Complete execution and closeout

Outcome: a fresh Agent can execute one eligible Ticket and leave durable
evidence that unlocks or blocks downstream work.

Work:

- add a small execution/closeout Skill rather than a generic scheduler;
- compile the executable context package from Ticket and referenced project
  knowledge;
- keep claim/lease/heartbeat/live progress in disposable runtime state;
- write Outcome, Evidence, deviation, blocker, and follow-up Ticket documents
  to Git;
- derive readiness and durable completion from semantic facts, with live Run
  state as an optional observation.

Acceptance:

- a fresh Agent starts correctly from the Ticket package alone;
- Run scope is exact-worktree plus HEAD/graph digest and Ticket revision;
- branch switch or relevant Ticket edit stales/suspends the Run;
- successful, partial, failed, and deviated outcomes remain distinguishable;
- accepted completion and downstream readiness recover after deleting SQLite;
- a protected deviation creates a visible decision/blocker and stops the
  affected path while independent work may continue.

### M5 — Dogfood and remove the legacy semantic runtime

Outcome: one real Plugin feature completes through the new loop and the repo
contains only one Ticket semantic model.

Work:

- regenerate the existing first-dogfood graph as a new-format seed rather than
  migrate old ledgers;
- run plan → optional review/delegation → parallel execution → join →
  verification → Outcome/Evidence → follow-up/closeout;
- exercise two worktrees and a branch switch;
- cut CLI/MCP/HTML handlers to the Git ledger;
- delete the five Ticket semantic SQLite table families, SQL triggers,
  application-intent recovery, trusted-provider plumbing, generation publisher,
  old operation schemas and generated contracts, obsolete CLI/MCP/host glue,
  dead exports, and tests or fixtures that only prove the retired protocol;
- remove unused imports, dependencies, feature flags, commented-out code,
  compatibility shims, and active documentation that describes the retired
  path;
- retain or rewrite tests around final user scenarios.

Acceptance:

- the full loop uses no old proposal/application backend;
- deleting the DB and rebuilding local indexes preserves the same semantic
  graph and completion state;
- two worktrees remain semantically isolated by Git;
- `rg` finds no active production Ticket semantic read/write against the
  retired SQLite tables;
- `.vibehub/ticket-store`, internal generations, `latest.yaml`, and the
  cross-store writer fence are absent from the active architecture;
- no retired Ticket table, trigger, service, operation name, provider type,
  package export, generated contract, CLI/MCP adapter, or host route survives
  merely for compatibility;
- repository search, typecheck, package tests, and packaged-file inspection
  prove there is no unreachable or accidentally shipped legacy path;
- the graph HTML still completes the human review use case.

### Cleanup gate

Cleanup is part of the pivot, not a follow-up hygiene ticket. A legacy artifact
may remain only when it is one of the dated META references intentionally kept
for design provenance. Production source, schemas, generated files, package
exports, adapters, tests, fixtures, and current documentation must describe and
exercise only the new authority model after M5.

## Cutover rule

This is a capability-by-capability code transition but a single authority
model:

1. build and test the Git document path behind a non-production entry;
2. switch a complete capability to Git;
3. never dual-write that capability;
4. once the full dogfood loop passes, delete the old semantic path in the same
   pivot branch.

No SQLite Ticket data export, compatibility mapping, legacy generation reader,
or long-lived feature flag is required.

## Explicitly deferred

- daemon hosting and generic workflow engine;
- remote/multi-host arbitration;
- cryptographic user-presence proof or hostile same-UID security;
- global cross-branch scheduling or Ticket locking;
- automatic Git conflict resolution;
- external issue-tracker synchronization;
- retention, GC, quota, and very-large-graph optimization;
- legacy DB/API/generation compatibility;
- hidden auto-merge, force-push, or branch deletion.

## Pivot completion test

The pivot is done only when this sentence is literally true:

> Git contains enough semantic truth for a fresh Agent to understand the plan,
> select and execute the correct next Ticket, explain every human boundary,
> verify the result, and recover completion after SQLite is deleted.
