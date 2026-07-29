# 09-ticket-runtime — Ticket Runtime

> Provisional destination: turn durable intent and semantic context into a
> machine-validated, executable Ticket Graph, then dogfood the smallest
> trustworthy loop inside the existing Plugin before committing to the final
> App/Runtime product shape.

- **Intent**:
  [`specs/intent-ticket-runtime-001.yaml`](specs/intent-ticket-runtime-001.yaml)
- **Exploration artifact**:
  [`artifacts/2026-07-27-ticket-runtime-exploration.md`](artifacts/2026-07-27-ticket-runtime-exploration.md)
- **Proposal authority contract**:
  [`artifacts/2026-07-29-ticket-proposal-authority-contract.md`](artifacts/2026-07-29-ticket-proposal-authority-contract.md)
- **Proposal query and validation ledger contract**:
  [`artifacts/2026-07-29-proposal-query-validation-ledger.md`](artifacts/2026-07-29-proposal-query-validation-ledger.md)
- **Trusted authority and application runtime**:
  [`artifacts/2026-07-29-ticket-proposal-application-runtime.md`](artifacts/2026-07-29-ticket-proposal-application-runtime.md)
- **Artifact policy**:
  [`specs/convention-ticket-runtime-artifacts-001.yaml`](specs/convention-ticket-runtime-artifacts-001.yaml)

## What lives here

This room is the planning and authority boundary for the proposed Ticket
Runtime. It preserves the reasoning that led from context management to an
executable work graph, charts the unresolved product and domain decisions, and
will eventually hold the canonical Ticket/Plan/Run/Gate/Outcome contracts.

It does not silently rewrite the active Task/Run, plugin-first, App, or storage
decisions in older rooms. A new decision changes those authorities only after
its required authority gate is resolved and an active Spec explicitly relates
to or supersedes the existing Spec.

## Material policy

| Layer | Location | Authority |
|---|---|---|
| Raw conversation and tool trace | Codex session / external work log | Cold provenance; not checked into META |
| Exploration synthesis | `artifacts/` | High-fidelity but non-normative |
| Intent, decision, constraint, contract | `specs/` | Canonical and active after machine validation; uncertainty and human gates are explicit |
| Execution milestones and evidence | `progress.yaml` and linked artifacts | Added only after the relevant design decisions are clear |

`active` means that a Spec is part of the live knowledge layer. It does not mean
that every question mentioned by the Spec is resolved or that a human approved
the text. Temporary authoring drafts are non-canonical; unresolved choices
belong in active Decision Tickets explicitly tagged `open`.

## Decisions so far

- [decision-ticket-work-unit-001] (active) Ticket is the only canonical durable
  work unit; outcome and execution granularity use the same Ticket contract
  family, while `task` remains ordinary or compatibility vocabulary.
- [decision-ticket-contract-001] (active) Ticket Contract v0 binds a stable
  outcome to one versioned Ticket definition, progresses through three
  intelligence handoffs under independent validation, uses flat verifiable
  acceptance, and derives maturity and operational state from linked facts.
  Proposal/candidate validation is now explicitly a separate evidence family
  and cannot satisfy Ticket-revision readiness.
- [decision-ticket-runtime-boundary-001] (active) Core owns the one canonical
  Ticket implementation; composable Skills own semantic intelligence, CLI/MCP
  are thin peers, the first slice is in-process, and App/daemon remain clients
  or hosts of the same Core. The first concrete
  `vibehub-ticket-validate` Skill records claimed-unverified semantic evidence
  for immutable graph-change proposals without granting authority.
- [decision-ticket-intelligence-loop-001] (active) Human-understandable
  scenarios constrain and review one typed Ticket Graph without becoming a
  second entity or hierarchy; the Agent composes intelligence by scene,
  proceeds under delegated authority, and escalates experience/principle
  changes or deviations.
- [decision-ticket-review-surface-001] (active) The project review surface is
  one complete direct-unlock Ticket Graph with stable pan/zoom layout, scenario
  review lenses, in-situ authority/deviation/proof signals, and a docked
  progressive Inspector whose comments and edits remain Core proposals.
- [decision-ticket-storage-001] (active, partially resolved) The
  outline-compatible Ticket definition subset and published dependency
  topology now use an independent Git-native `.vibehub/ticket-store/` read
  authority. Immutable generations retain exact review snapshots; SQLite and
  META/Task/prototype data are not fallback Ticket definition authorities. A
  Core-owned whole-generation publisher now has a fenced application path:
  worktree-specific Git-admin writer arbitration, expected-snapshot CAS,
  immutable installation, atomic visibility publication, and exact-intent
  reconciliation. SQLite owns
  immutable proposals, validation evidence, trusted authority decisions,
  application intents, and terminal application receipts without becoming a
  Ticket Graph definition authority. The Git writer fence remains held until
  the matching SQLite application receipt commits. Complete definition
  storage, retention/GC, and the remaining runtime fact authorities stay open.
- [decision-ticket-graph-lifecycle-001] (active, partially resolved) The V0
  default review graph is the latest published complete generation in the
  verified worktree. Exact generation reads are immutable and retained. The
  storage-level publisher admits only complete additive/revision generations
  under CAS and rejects implicit removal. Submit-only comments and graph-change
  proposals are now immutable review contributions with exact snapshot/target
  binding and Core-generated materialization, but never mutate the graph.
  Proposal-specific semantic evidence is append-only, candidate-bound, and
  never Ticket readiness or authority by itself. Trusted host authority can now
  bind the complete validation ledger and authorize the exact candidate;
  application persists an immutable intent, publishes through a fenced Git
  CAS, and records a terminal published/reconciled receipt. Partial planning
  frontiers, explicit removal/supersession, and execution lifecycle stay open.
- [decision-ticket-mvp-001] (active, partially resolved) The contract-first
  dogfood slice now covers canonical Ticket reads, immutable proposal
  submission/query, independent proposal-validation evidence, proposal review,
  trusted authority resolution, and crash-reconcilable application through one
  Core/CLI/MCP spine. Default CLI/MCP callers cannot mint authority: bootstrap
  and every protected boundary remain blocked until a trusted host injects an
  authenticated human authority provider. Ticket-readiness
  validation/currentness, generic GateDecision recording, context compilation,
  Run/Outcome writers, and semantic closeout remain open.

## Contracts

- [contract-ticket-review-operations-001] (active) The first executable slice
  freezes three coherent reads—one whole-project graph snapshot,
  snapshot-bound subject inspection, and as-of trace listing—plus
  `ticket.proposal.submit`. Submit appends an immutable comment or mechanically
  reviewed graph-change contribution with `graphMutationApplied: false`.
  Claimed actor and authorAssessment never grant authority; independent machine
  validation and trusted human authority remain separate. Bootstrap indicates
  `initial_plan_authority`, caller provenance is rejected, caller-derived
  creation attribution is marked unverified, and aggregate input is bounded.
  Five bounded proposal-ledger operations add proposal inspect/list and
  proposal-validation record/list/inspect. Validation is graph-candidate
  semantic evidence over promise_preservation, containment_truth,
  dependency_truth, change_classification, delegated_scope, and
  protected_boundaries. Materialized proposal records use compact prior
  outcome/parent and dependency deltas instead of embedding a complete prior
  definition, and their complete output is capped at 8 MiB with split guidance
  on overflow. Semantic validation resolves required context from the exact
  observed snapshot, including existing relationship evidence by
  `relationRef`; it never substitutes latest. Multiple contrary records
  coexist; none is current, latest, Ticket readiness, authority, GateDecision,
  application, or graph mutation by itself. Three further bounded operations
  are now registered: `ticket.proposal.review.inspect`,
  `ticket.proposal.authority.decide`, and `ticket.proposal.apply`. Review
  exposes the exact validation-set digest and next required action. Authority
  decisions can only come from a non-serializable trusted provider injected by
  the host. Application input binds the exact authorized proposal, candidate,
  and decision; Core creates and persists the immutable intent internally.
  Generic GateDecision recording remains separate.

## Planning conventions

- [convention-ticket-backchain-forward-normalize-001] Ticket shaping
  backchains necessary proof paths from observable outcomes, then normalizes
  forward from current facts to remove orphan, duplicate, redundant, and
  falsely serialized work before proposing the graph.

## Frontier

These questions are currently unblocked:

- [decision-ticket-context-binding-001] How does a Ticket declare and bind
  semantic context without freezing a giant Run prompt?
- [decision-ticket-graph-lifecycle-001] How may planning and execution
  elaborate, decompose, propose, and tend the Ticket Graph?
- [decision-ticket-workflow-role-001] Is Workflow a reusable method, a
  versioned intelligence asset, or part of the graph?

## Blocked

- Closeout remains blocked on context binding and graph lifecycle.
- Graph lifecycle must also decide how human planning gates allow a partial
  graph with directional fog beyond blocker Tickets, rather than fabricated
  downstream Tickets.
- Storage beyond the definition/topology authority and immutable
  proposal/validation/authority/application facts remains blocked on complete
  Ticket definitions, closeout, and runtime-fact semantics.
- The full dogfood implementation loop depends on the preceding contracts; it
  must not become the place where unresolved ontology is accidentally decided
  in code.

The dependency-light browser-safe DTOs, opt-in strict schemas, deterministic
projector, and storage-agnostic read service now sit behind a real canonical
outline/topology read-bootstrap provider. The provider reads immutable
outline-compatible definition revisions and retained generation manifests from
`.vibehub/ticket-store/`, verifies repository and worktree scope, rejects
unsafe/corrupt files, and never substitutes `latest` for an unavailable bound
snapshot. Atomic pointer replacement yields a complete old or new generation,
per-file parsing and cumulative source bytes are bounded fail-closed, and
filesystem projection does not hold an immediate SQLite transaction.

The same three reads and submit-only proposal contribution are registered once
in the Core dispatcher and exposed by thin CLI (`vibehub ticket ...`) and MCP
(`ticket_operation`) adapters. Ticket selector and proposal target validation
precede persistence. Operation receipts bind the verified
repository/worktree/incarnation scope before replay, preventing data from one
worktree, a foreign repository, or a repository replaced at the same path from
leaking into another. Large Ticket read payloads use immutable
content-addressed blobs, so repeated reads of the same projection do not copy
the full graph into every request receipt.

Proposal submission binds an exact observed snapshot and exact revised
definition revisions. Core generates proposal/Ticket identity, revisions,
timestamps, and proposal provenance, then mechanically checks the complete
candidate under a 4 MiB decoded logical-input budget. CLI and Skill adapters
apply the same limit to raw proposal JSON before parsing; MCP separately
bounds every stdio frame at 64 MiB and an identified proposal call at 5 MiB
including its transport envelope. Repository incarnation is
rechecked around graph loading, task attribution binds the exact task
worktree, caller provenance is rejected, and caller-derived creation
attribution remains claimed/unverified.
Materialized creates return the complete new definition plus an
added-only `dependencyDelta`; revisions return the complete replacement,
`previousOutcome`, `previousParentId`, and exact added/removed dependency
deltas, not a copied `previousDefinition`. The complete materialized proposal
output is capped at 8 MiB before persistence; overflow fails with guidance to
split the proposal into smaller bounded contributions.
The immutable proposal and operation receipt commit together in SQLite; the Git
Ticket store is untouched. Machine semantic validation is a separate receipt,
and human authority is separately reserved for protected experience/product,
principle, permission/side-effect, risk/policy, and initial-plan boundaries.
Bootstrap always indicates initial-plan authority; technical difficulty alone
is not a human gate.

The proposal ledger now has five additional frozen operations:
`ticket.proposal.inspect`, `ticket.proposal.list`,
`ticket.proposal.validation.record`, `ticket.proposal.validation.list`, and
`ticket.proposal.validation.inspect`. Proposal and validation lists expose
bounded summaries under scope/filter/high-water cursors; complete immutable
records require explicit inspection. Each validation binds one graph-change
proposal and its mechanically materialized candidate, remains
claimed_unverified, and records semantic evidence only. Contrary records remain
side by side with no current/latest/winner. The independent
`vibehub-ticket-validate` Skill performs the six-question review against the
proposal's exact `observedSnapshotId`. It inspects affected existing Tickets,
parents, and dependency endpoints at that snapshot and uses the snapshot-bound
`relationRef` when retained-edge or changed-existing-relation evidence is
needed; missing context becomes inconclusive rather than a latest-snapshot
substitution. It records one `claimed_unverified`,
`validation_evidence_only` contribution with no maturity effect, authority,
application authorization, or graph mutation.

The authority/application slice adds three registered operations:
`ticket.proposal.review.inspect`,
`ticket.proposal.authority.decide`, and `ticket.proposal.apply`. Review returns
one proposal, the complete bounded validation ledger binding
(`digest`, high-water sequence, and count), any terminal authority decision and
application receipt, plus one derived eligibility/next action. Authority
decision input contains schema version, proposal ID, and immutable expected
proposal/candidate/validation-set digests only. The caller's actor and JSON
input never contain a principal, disposition, or authority proof; Core accepts
those only from a host-injected
`TrustedTicketProposalAuthorityProviderV0`. Bootstrap, expansion, a declared
human gate, or any protected authority signal requires an authenticated human
authority basis. Non-protected elaboration/decomposition may use a trusted
delegation basis. An authorized decision must cite at least one exact passing,
non-blocking validation receipt, while contrary evidence remains bound in the
complete set. Recording the immutable decision closes that proposal's
validation ledger.

The packaged `vibehub-ticket-apply` Skill is the thin intelligence layer over
those operations. It follows the derived next action, invokes independent
validation when needed, retries an exact interrupted application, and stops at
an unavailable trusted-authority boundary. It never turns caller identity or
conversation approval into an authority proof.

Application first records an immutable intent containing the exact authorized
candidate generation, base snapshot, candidate snapshot, and publication
counts. Core then enters the Git publisher under a durable fence derived from
that intent. The operational lock is an untracked directory in the
worktree-specific Git administration path, installed by atomic rename from a
fully written, nonempty staging directory. The writer fence is released only
after the
immutable SQLite application receipt commits: release first claims the exact
`owner-T` marker to `releasing-T`, unlinks only that token-specific marker, then
removes the canonical directory only if it is still empty. A successor's
nonempty `owner-U` makes a stale removal fail harmlessly; a crash-empty
canonical directory can be removed or atomically replaced by staged
acquisition. If Git visibility advanced but receipt insertion did not, retry
adopts only the byte-identical fence: current equals candidate reconciles,
current equals base resumes publication, and every malformed or foreign fence
or third head fails closed. Cleanup after an already-committed receipt is
permitted only for the exact fence after verifying the canonical Git head
equals its candidate. Successful receipts distinguish `published` from
`reconciled`. Authority/application failures are not cached as terminal
operation failures, so a later trusted-host or exact recovery retry can
proceed; immutable domain receipts still make successful replay idempotent.

Capability and trace inventories are currently empty rather than fabricated.
META Specs, legacy Task rows, and v4 reference artifacts remain explicitly
ineligible as production Ticket facts. The Core storage-level compiler and
generation publisher described in
`artifacts/2026-07-28-ticket-generation-publisher-contract.md` are now
implemented and tested. The low-level publisher remains outside the package
root and operation registry; only Core's authorized application service may
invoke its fenced path. The three authority/application operations are exposed
through Core/CLI/MCP, but ordinary CLI/MCP construction injects no authority
provider. It can inspect review state and request apply, but it cannot authorize
bootstrap or a protected change by claiming a human actor. A trusted browser or
other host decision bridge, Ticket-readiness validation/currentness,
current-capability selection, receipt/blob quotas and retention/GC, complete
definition storage, and the wider Run/Outcome loop are the next gates.

## Not yet specified (wayfind)

- How non-coding semantic providers such as MyLibrary should satisfy the same
  context-binding contract.
- How planning quality will be evaluated by comparing the initial graph with
  the execution graph.

## Out of scope (wayfind)

- Rebranding, domain selection, and packaging of the future closed-source App
  are not required to prove the first Ticket loop.
- Sprint, roadmap, team capacity, labels, and general project-management
  features belong to upstream systems.
- Full Linear/Jira/GitHub bidirectional synchronization is deferred.
- Unattended scheduling, remote workers, and the Server/Team control plane are
  deferred until the local manual-control loop is proven.
- [decision-ticket-runtime-boundary-001] A separately packaged Local Runtime
  daemon is deferred until concurrency, subscriptions, background work, or
  multi-client coordination justify it.
