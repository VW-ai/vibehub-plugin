# Exploration and execution-workspace scope v0

`src/core/branch-scope.mjs`, exported through `src/index.mjs`, supplies pure wire
version 1 constructors, validation, transitions, resolution and view selection.
It is a bounded executable contract for the local Git enrollment work. It does
not add a database, branch-aware Working Graph, sync engine or Ticket lifecycle.

## Identity and explicit enrollment

`createBranchScope({ catalog, scope })` pins one accepted identity catalog and
`{ tenant_id, project_id }`. `validateBranchScope(state)` checks the complete
snapshot. Every command and lookup carries that exact scope; cross-Project input
is rejected. IDs are caller-allocated opaque identifiers under the existing
identity grammar. The host must persist them and authenticate the caller.

| Record | Immutable identity and relationships | Mutable facts |
| --- | --- | --- |
| Exploration | Project-scoped `exploration_id`; selected Git commit bases and shared Context revision/digest pins | No automatic base replacement or adoption |
| Ref incarnation | `ref_incarnation_id`, repository and local checkout | Ref name and active/deleted state |
| Enrollment | Exact exploration–ref-incarnation pair | Append only |
| Execution workspace | `execution_workspace_id`, exploration, installation, optional worktree and ref incarnation | Active/retired state |
| Ticket provenance | Record ID, exact Ticket Contract and Acceptance pins, execution origin and Evidence association | Append only |

A local ref belongs to one enrolled checkout, so two clones' `feature` branches
are separate incarnations even when their repository and commit agree. Linked
worktrees within that checkout use the same registered incarnation when they
refer to the same branch. Branch names and filesystem paths never allocate or
resolve identity. Remote refs and connector enrollment remain adapter work.

`applyBranchScopeChange(state, { schema_version: 1, scope, type, value })` returns
a new frozen state and preserves its input. Supported changes are:

- `register_ref`: `{ ref_incarnation_id, repository_id, checkout_id, ref_name,
  state: "active" }`.
- `create_exploration`: `{ exploration_id, base_revisions: { git,
  shared_context } }`. Git bases are `{ repository_id, commit }` with exact
  40/64-character OIDs. Shared pins are `{ context_id, revision, identity }`.
- `enroll_ref`: `{ exploration_id, ref_incarnation_id }`. The exploration must
  have a selected base for that repository. Sharing an exploration across clones
  requires enrolling each clone's incarnation explicitly.
- `rename_ref`: `{ ref_incarnation_id, ref_name }`.
- `delete_ref`: `{ ref_incarnation_id }`; retains the ref and retires its active
  execution-workspace bindings.
- `register_execution_workspace`: `{ execution_workspace_id, exploration_id,
  source_installation_id, worktree_id, ref_incarnation_id, state: "active" }`.
  `worktree_id` and `ref_incarnation_id` are explicitly nullable.
- `retire_execution_workspace`: `{ execution_workspace_id }`.

There is one active execution-workspace binding per physical worktree in this
Project snapshot, with any number of Sessions and executions using it. A branch
switch retires that binding and creates a fresh one; it does not rewrite past
executions. A detached HEAD can have an explicitly chosen exploration and
worktree with `ref_incarnation_id: null`. Repository-free work can use a mapped
installation with both fields null. The local App's Git-folder requirement is
an onboarding rule, not a reason to invent Git identity for repository-free
core records.

Deleting/recreating a branch or worktree at the same name/path requires fresh
IDs. Tombstones reserve old IDs. A proven rename preserves the incarnation.
The Git adapter must detect these changes; if it cannot prove continuity, it
must request enrollment or report ambiguity rather than guess from a timestamp,
HEAD, remote URL or `main`.

`resolveExploration(state, observation)` accepts scope plus optional
`exploration_id`, `execution_workspace_id`, `checkout_id`, `ref_incarnation_id`
and inert `hints: { branch, path, commit }`. It returns `resolved`, `ambiguous`
or `unmapped`, a bounded reason, candidate IDs and ignored hint names. Ref-only
lookup with multiple explicit exploration enrollments is ambiguous; adding the
selected exploration disambiguates it. Lookup never creates enrollment. A
retired workspace cannot resolve as a replacement at the same directory.

## Ticket participation and durable origins

`recordTicketWorkspaceProvenance(state, { schema_version: 1, scope, provenance })`
appends a record containing:

```js
{
  provenance_id: 'record-1',
  kind: 'participated', // created | execution_completed | acceptance_recorded
  ticket: {
    ticket_id: 'ticket-1', contract_revision: 2,
    contract_identity: 'sha256:…',
    acceptance_revisions: [
      { acceptance_id: 'usable', revision: 2, identity: 'sha256:…' },
    ],
  },
  origin: {
    kind: 'execution', execution_workspace_id: 'workspace-a',
    execution_id: 'attempt-a',
  },
  evidence: [{
    evidence_id: 'evidence-1',
    acceptance_revision: { acceptance_id: 'usable', revision: 2, identity: 'sha256:…' },
  }],
}
```

Each Evidence reference must match an exact Acceptance pin in this record's
Ticket contract. These pins must come from the trusted Ticket reader; this
module does not recreate the Ticket hashing algorithm, fetch its records or
certify an Outcome. `acceptance_recorded` records the origin of a separately
adjudicated acceptance, and grants no authority. Actual independent acceptance
and human gates remain with the existing lifecycle/Outcome contract.

One Ticket can have many executions across explorations. Its single creation
origin is immutable; participation, execution completion and independent
acceptance have separate records and can come from different workspaces. A
Session restart creates a new Session/Execution under the accepted identity
contract. An Execution already used in one workspace cannot later be rebound to
another. Deleting the worktree retains all past origin records. Administrative
`Workspace` remains the tenant grouping; `execution_workspace_id` is a different
kind of identity.

Legacy imports with no provable origin use exactly `origin: { kind: "unknown" }`.
Never infer birthplace from today's checkout. This module does not implement
workspace Ticket filtering, cancellation, reopening, deletion or archive state.

## Scoped views and authority

`selectExplorationView` consumes already-authorized exact assertion references,
explicit shared selection and upstream issue judgments. It never classifies text
or interprets model confidence as permission. Each assertion carries:
`{ assertion_id, scope, exploration_id, revision, identity, governing }`.
`exploration_id: null` means a shared Project assertion. `governing: true` is
allowed only there and must be supplied by the trusted governing-context reader.

The input is `{ scope, exploration_id, assertions, shared_assertion_ids, issues }`.
Issues contain `kind`, `left_assertion_id`, `right_assertion_id`. The supported
kinds are `concurrent`, `incompatible` and `governing_violation`. Unknown endpoints
and cross-Project records fail. Returned collections separate:

- Selected shared assertions, including every governing assertion even if the
  optional selection omitted it.
- Local exploration assertions.
- Other explorations' assertions as awareness, without adoption.
- Same-scope issues, governing violations and cross-scope notices.

Incompatible Cloud and Kubernetes hypotheses in separate explorations become a
cross-scope notice. Same-scope concurrency stays explicit. Governing violations
remain visible across exploration boundaries. This does not change any shared
assertion's status or declare Project truth contested. These input issues are
already assessed by another stage; the selector does not discover concurrency,
prove a contradiction, resolve it or decide which user to notify.

`exploration_id: null` selects the Project overview: an aggregate of all supplied
explorations and selected shared Context, with no chosen `main` lineage. Access
control must filter supplied records before this function; visibility is not
authorization. No hidden assertion body or filesystem read is performed.

## Bounds and integration migration

The reference state has at most 512 records per array; one exploration has at
most 64 repository bases and 128 shared Context bases. Inputs reject unknown
fields/versions, accessors, sparse/cyclic/oversized JSON and cross-Project or
dangling references. Results are detached and deeply frozen. Snapshot validation
does not prove historical authenticity; retain the preceding accepted state and
use transitions rather than trusting a client-supplied replacement.

The catalog is immutable in this reference state. New worktree, Session or
Execution enrollment needs a deliberate successor catalog/state generation that
retains historical identities; no production catalog migration is implemented
here. The fixture includes explicitly enrolled old and replacement instances to
exercise lifecycle behavior without pretending that old IDs change ownership.

The pure registry above does not itself isolate Graph writes. The separate
[local exploration projection](exploration-projection-v0.md) now assigns each
exploration an owned Project/generation lineage, binds writes to a real enrolled
worktree, and returns its immutable origin base separately from the selected
Project baseline. Existing Graph addresses remain valid; existing data with no
exploration origin stays unscoped. This is a local in-process service boundary;
explicit adoption, base updates, merge lineage and host/UI integration remain
follow-up work.

Conformance: `node --test test/branch-scope.test.mjs` exercises the public package
entry; `npm run check:boundaries` checks independent component imports. All
fixtures are synthetic. No model call, host collection or live integration is
claimed by these tests.
