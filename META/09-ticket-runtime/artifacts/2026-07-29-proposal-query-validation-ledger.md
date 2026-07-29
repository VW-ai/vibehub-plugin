# Ticket Proposal Query and Validation Evidence Ledger V0

Status: active contract for the bounded proposal-query and proposal-validation
slice governed by `contract-ticket-review-operations-001`,
`decision-ticket-graph-lifecycle-001`, `decision-ticket-storage-001`, and
`decision-ticket-runtime-boundary-001`.

## Boundary

This slice makes immutable proposal contributions and independent semantic
reviews inspectable. By itself it grants no proposal application,
Ticket-readiness, trusted authority, or mutable review lifecycle. The separate
trusted authority/application layer consumes this immutable ledger without
changing those properties; see
`2026-07-29-ticket-proposal-application-runtime.md`.

The five public operations are:

| Operation | Responsibility |
|---|---|
| `ticket.proposal.inspect` | Read one immutable proposal contribution by its stable identity |
| `ticket.proposal.list` | Read bounded proposal summaries within one verified repository/worktree scope |
| `ticket.proposal.validation.record` | Append one proposal-bound semantic validation contribution |
| `ticket.proposal.validation.list` | Read all bounded validation summaries bound to one proposal |
| `ticket.proposal.validation.inspect` | Read one immutable proposal-validation contribution |

All five operations use the shared Core operation registry and the same thin
CLI/MCP/Skill adapter boundary as the existing Ticket operations. No caller may
query SQLite directly.

## Proposal reads

`ticket.proposal.inspect` returns the immutable submitted contribution,
including its exact proposal digest, scope binding, observed snapshot and
target bindings, claimed attribution, mechanical-review result, and candidate
digest when the proposal contains a graph-change candidate. It does not
reclassify the proposal against the current graph head or synthesize an
approval, readiness, currentness, or application status.

Materialized graph changes expose a compact semantic delta rather than copying
the complete prior definition into the proposal record. A create carries its
`localRef`, allocated `ticketId`, complete new `definition`, and a
`dependencyDelta` whose added prerequisites are the new definition's
dependencies and whose removed set is empty. A revision carries its
`ticketId`, `expectedDefinitionRevision`, `previousOutcome`,
`previousParentId`, complete replacement `definition`, and a
`dependencyDelta` with exact added and removed prerequisite Ticket IDs. It does
not carry `previousDefinition`. The observed snapshot remains the authority for
any additional prior-state context.

The complete materialized proposal output is capped at 8 MiB. Core checks that
cap before persistence and fails with a validation error plus guidance to split
the work into smaller bounded proposal contributions. An oversized or otherwise
corrupt stored record fails closed on inspection rather than being returned as
an unbounded payload.

`ticket.proposal.list` returns bounded summaries rather than every complete
proposal body. Pagination is stable within a captured ledger watermark and
fails closed when a cursor is malformed or belongs to another scope, filter, or
watermark. The watermark is a transport consistency boundary, not a semantic
claim that the last proposal is preferred or current. Complete payloads remain
available only through explicit inspection.

Both operations remain bound to the verified repository, worktree, and
repository incarnation. Claimed actors are displayable attribution, never
trusted principals.

## Proposal-validation evidence

Proposal validation is a new record family. It is deliberately distinct from
the Ticket-revision `ValidationReceipt` that may eventually derive
`outline | specified | executable` maturity.

A proposal-validation contribution:

- binds one immutable graph-change proposal by proposal identity and digest;
- binds the exact mechanically materialized candidate digest;
- records one independently produced semantic assessment, findings, evidence
  references, validator/policy identifiers, and claimed validator attribution;
- is append-only and `claimed_unverified`;
- does not derive Ticket maturity, operational readiness, GateDecision,
  authority, approval, application eligibility, or graph mutation.

The recorder input names the proposal and supplies
`expectedProposalDigest` plus `expectedCandidateDigest` as stale-input
preconditions. Core loads the immutable proposal and derives the stored
proposal, snapshot, candidate, scope, worktree, and repository-incarnation
bindings; callers cannot rewrite those facts in the validation record.

Each of the six checks has one finite semantic judgment and bounded findings.
Core derives the record's overall `passed | failed | inconclusive` conclusion
from those checks rather than trusting a caller-authored overall result. The
result has `effect: validation_evidence_only`; `authorityGranted`,
`applicationAuthorized`, and `graphMutationApplied` are always false.
Validation-record logical input is bounded at 1 MiB.

Comment proposals remain inspectable contributions but have no graph candidate
for this semantic validator to adjudicate. The V0 validation recorder therefore
accepts candidate-bearing graph-change proposals only.

The semantic assessment covers these independent questions:

1. `promise_preservation` — does the proposed candidate preserve the outcome
   promise it claims to elaborate or decompose?
2. `containment_truth` — do parent relationships truthfully express outcome
   containment rather than execution order or convenience?
3. `dependency_truth` — do dependency relationships truthfully express direct
   execution prerequisites without invented serialization?
4. `change_classification` — is the proposed change honestly classified as
   elaboration, decomposition, or expansion?
5. `delegated_scope` — does the candidate remain inside the scope and
   decision authority already delegated to the affected ancestor?
6. `protected_boundaries` — does it introduce or alter any
   `initial_plan_authority`, `experience_product`, `principle_deviation`,
   `permission_side_effect`, or `risk_policy` boundary?

Technical difficulty alone is not a protected-boundary finding. Database
locking, schema mechanics, research, and similar technical choices remain
delegated when accepted experience, architecture, principles, permissions, and
risk constraints already make the choice objectively adjudicable.

Protected-boundary signals from the original proposal and from the validator's
findings may be unioned for later routing. The union is still untrusted routing
evidence and never an authority grant.

## Coexisting assessments

Every successful `ticket.proposal.validation.record` appends a new immutable
contribution and its idempotent operation receipt atomically in SQLite. Core
generates its stable identity, digest, scope binding, and recorded time.

Several validators may reach different or directly opposing conclusions about
the same proposal. All such records coexist. V0 defines no mutable validation
status, `current`, `latest`, winner, quorum, precedence, supersession,
revocation, or automatic aggregation rule.

`ticket.proposal.validation.list` therefore returns the complete bounded ledger
view selected by its proposal binding and pagination watermark; it must not
collapse disagreement. `ticket.proposal.validation.inspect` returns one exact
record and never promotes it into authority.

## Intelligence boundary

`vibehub-ticket-validate` is an independent semantic intelligence Skill. It:

1. inspects the immutable proposal through Core;
2. when `observedSnapshotId` is present, reads every affected existing Ticket,
   parent, and dependency endpoint through `ticket.subject.inspect` at that
   exact snapshot and uses bounded `ticket.trace.list` at the same snapshot
   when cited history or evidence is required; it never substitutes a new or
   latest graph snapshot;
3. when retained-edge evidence or a changed existing relation is needed,
   discovers the exact-snapshot `relationRef` from the affected Ticket
   inspection and inspects that relation by `relationRef` at the same snapshot;
   endpoint IDs alone do not replace the relation binding;
4. reviews the proposal and mechanically materialized candidate independently
   from the author's `authorAssessment`;
5. evaluates the six questions above and cites actionable findings/evidence;
6. records that assessment through
   `ticket.proposal.validation.record`;
7. may inspect the resulting record, but never authorizes, applies, or publishes
   the proposal.

The Skill does not import storage, write proposal rows, invoke the internal Git
publisher, call an application operation, record a GateDecision, or claim that
its own actor identity is trusted. Missing evidence remains an explicit
uncertain finding rather than being fabricated or silently converted into a
human approval. Every persisted contribution remains `claimed_unverified` with
`maturityEffect: none` and `effect: validation_evidence_only`;
`authorityGranted`, `applicationAuthorized`, and `graphMutationApplied` remain
false.

## Downstream authority and what remains blocked

The downstream application policy is now frozen and implemented without
promoting this ledger into authority. It binds the complete validation set by
digest/high-water/count, requires one exact passing non-blocking receipt for an
authorized decision, preserves contrary receipts in the bound set, and obtains
trusted principal/basis/disposition only from a host-injected provider.
Application persists an immutable exact-candidate intent and uses an
intent-fenced Git publication protocol with a terminal `published` or
`reconciled` SQLite receipt.

Default CLI/MCP construction supplies no trusted provider, so bootstrap and
protected changes still require a trusted host decision bridge; caller actor
claims cannot grant that authority.

Generic GateDecision recording, validation aggregation/currentness,
Ticket-readiness ValidationReceipt storage, proposal and receipt retention/GC,
the complete Ticket definition authority, and the broader execution lifecycle
remain separate decisions.
