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

The implementation pivot began from
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

M3 adds strict Git-native Review and Decision facts plus the structured graph
intervention surface. M3.5 historically established durable WebAuthn-backed
receipts. M3.6 preserves their exact Git binding and fresh-process verification
while replacing the ceremony with one explicit Plugin-host click and a
repository-scoped, installation-local Ed25519 key. The result makes no
biometric or named-human-presence claim.

M4 adds the complete MR-ready execution loop without requiring the unfinished
runtime to dogfood itself: derived frontier, exact bounded ContextBinding,
disposable Run leases, executor-authored Git Evidence, independent Outcome
closeout, direct downstream unlock, and quiet operational projection. Real
Plugin-feature dogfood is post-merge M5 evidence.

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
- [`decision-ticket-mr-ready-boundary-001`](specs/decision-ticket-mr-ready-boundary-001.yaml):
  M4 reaches MR-ready through a bounded synthetic execution/closeout
  conformance loop and release gates; real Plugin-feature dogfood moves to
  post-merge M5.
- [`contract-ticket-git-worktree-patch-001`](specs/contract-ticket-git-worktree-patch-001.yaml):
  Skills receive one receiptless `ticket.worktree.patch` hand. It binds the
  exact worktree, HEAD, semantic graph, raw ledger inventory, and targeted
  Ticket revisions; validates the complete prospective graph; and leaves one
  verified dirty-worktree change for optional separate checkpointing.
- [`contract-ticket-planning-validation-skills-001`](specs/contract-ticket-planning-validation-skills-001.yaml):
  two composable Skills own plan shaping and independent semantic validation.
  Passing graph definitions enter the current graph directly; review and
  protected decisions gate execution rather than activation.
- [`contract-ticket-git-review-interventions-001`](specs/contract-ticket-git-review-interventions-001.yaml):
  comments, complete Ticket edit proposals, plan reviews, and protected
  Decisions are exact-subject Git facts. Browser attribution is host-bound;
  durable Decision YAML is evidence rather than self-authenticating authority;
  only an exact currently verified install-local receipt or deliberately
  session-only injected attestation may project a gate. Skills decide how
  non-authoritative review context changes a candidate.
- [`contract-ticket-install-local-decision-attestation-001`](specs/contract-ticket-install-local-decision-attestation-001.yaml):
  M3.6 lets a fresh host or Agent verify one exact Decision after one explicit
  Plugin-host click. A repository-scoped installation-local Ed25519 key lives
  outside Git and SQLite; exact detached receipts have no expiry and are
  dynamically revocable. The click is a host assertion, not WebAuthn,
  biometric proof, or named-human identity.
- [`contract-ticket-durable-decision-attestation-001`](specs/contract-ticket-durable-decision-attestation-001.yaml):
  the superseded M3.5 WebAuthn contract remains historical provenance for the
  first durable-receipt boundary.
- [`contract-ticket-context-binding-001`](specs/contract-ticket-context-binding-001.yaml):
  execution compiles one exact, bounded, fail-closed repository and Feature
  Room context packet. This objectively adjudicable technical contract is
  Agent-owned rather than a protected human decision.
- [`contract-ticket-closeout-001`](specs/contract-ticket-closeout-001.yaml):
  executor Evidence cannot self-certify; a different verifier records the
  terminal Outcome, and only a current successful Outcome derives DONE and
  direct downstream eligibility.

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
- SQLite Run state binds repository identity, exact worktree, branch,
  execution-start HEAD and non-ledger source digest, Ticket revision,
  ContextBinding, actor, and lease generation.
- Branch switches or relevant Ticket edits stale/suspend an old Run.
- Deleting SQLite may lose a heartbeat or claim, but never Ticket meaning,
  decisions, accepted completion, or evidence.

## Open focused decisions

- [`decision-ticket-workflow-role-001`](specs/decision-ticket-workflow-role-001.yaml):
  reusable method/intelligence assets without introducing a generic workflow
  engine.

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

After the Skill package commit changed HEAD, a fresh planning Agent
semantically reconciled the historical seven-Ticket candidate to current
repository truth. It removed `ticket-planning-validation-ready` because M2 had
already established that outcome, refreshed the remaining six Ticket
definitions, and passed independent validation with
`human_decision_required` and no material findings. The exact candidate
(SHA-256
`587c4e14c19f19db1dc160915aa1dbad4bf2799cae7814f74033ee8ea7038984`)
was applied through `ticket.worktree.patch`, reloaded at graph digest
`sha256:f7e89de4cd1fc1e51226223ad89b4f03dfc1bf389579b2ab8c2a5ac036dfda39`,
and path-exact checkpointed as
`b427ca6e2b1d9c24ad88fd4a34dee438afdab62e`. M2 is complete.

M3—the Git-native review intervention loop—is implemented:

- strict Review and Decision documents live beside Ticket definitions in the
  Git semantic ledger without changing Ticket-only `graphDigest`;
- `semanticLedgerDigest` and raw-inventory `sourceToken` bind the full ledger,
  and Review/Decision writers reuse the exact-source worktree lock,
  no-replace publication, verification, recovery, and path-exact checkpoint;
- public `ticket.review.append` and `ticket.decision.record` operations accept
  exact content and subjects but no caller identity, time, path, or authority;
- comments and Ticket edits require a host-attested human in the browser;
  Decisions additionally require exact host-bound human authority;
- raw or freshly reconstructed Decision YAML remains current-unverified
  evidence; only the exact Decision written or explicitly re-attested by the
  active trusted host session projects as execution authority, and that
  in-memory receipt never enters SQLite;
- the M3 default graph host is read-only without trusted capabilities, while
  the host API exposes only intervention actions covered by an injected grant;
- current and historical facts project to their graph, Ticket, or relation
  loci without changing graph topology or layout;
- the complete direct-unlock canvas remains primary, with quiet progressive
  Review controls inside the Inspector, visible trace failures, stale-draft
  preservation, and named durable write targets;
- Planning and Validation Skills refresh same-snapshot review facts, treat
  comments as context, reconcile current edit proposals into fresh candidates,
  read complete durable Review and Decision documents, and honor only current
  exact trusted-session authority receipts.

Review remains optional intelligence rather than a mandatory activation stage.
Adversarial review established that editable Decision YAML cannot authenticate
its own authority. M3 therefore fails closed with active-session attestation.
M3.5 historically supplied the first durable cross-process attestation. M3.6
now supplies the active, honestly scoped local-installation authority whenever
a genuine protected product or permission boundary needs durable confirmation.
Subsequent M4 analysis classified context binding and closeout mechanics as
objectively adjudicable Agent-owned contracts, so neither carries a manufactured
human-ratification gate.
The independently validated truth-boundary candidate was applied as 11 Tickets
and 11 direct relations at graph digest
`sha256:8d126f52313d97fd7ed529ae6e52847a3d426d3fcf6d22b9420979f385e94992`
and path-exact checkpointed in
`802111ca57d1916a96dd425fa2c40108600be333`.

M3.5 is implemented:

- the installed Ticket Review Skill resolves the versioned Plugin runtime and
  opens one exact worktree graph;
- enrollment and every Decision or revocation require WebAuthn user presence
  and user verification;
- the private key remains in the authenticator, while an owned 0700/0600
  repo-external registry stores only public verification and revocation facts;
- append-only Git attestation receipts bind the complete Decision, principal,
  repository incarnation, worktree, branch or detached commit, graph or Ticket
  subject, protected boundary and selection or delegated scope, origin,
  credential, nonce, and validity window;
- raw Decisions remain current-unverified without a current exact receipt;
  fresh Core, CLI, MCP, and Skill readers dynamically reread revocation state;
- the production Inspector exposes both plan-review and protected-boundary
  ceremonies without accepting browser-supplied authority, time, path, or
  proof fields.

Implementation commit `dbc60dc3fbc22995060a0ee1e6768602c928470c`
passes 529 package tests, complete typechecks/builds, npm package verification,
Skill validation, and release-marketplace verification. Its independently
validated one-Ticket settlement keeps 11 Tickets and 11 direct relations at
graph digest
`sha256:deb8bbe622fff55343016cae043e0792a0b7a6c6dcb330a28e9ffdc7ca2421a9`
and is path-exact checkpointed in
`e8f2afd23d5651b3a90442f5d92e02ee2559720c`.

M3.6 is implemented in
`dd771df13185fc472ade73d6962b3e3e8be78403`:

- the WebAuthn ceremony is replaced by one explicit Plugin-host Decision click;
- one repository-scoped Ed25519 profile stores its private key and revocable
  public trust outside Git and SQLite;
- detached Git receipts retain the exact Decision, repository, worktree,
  named-branch checkout, subject, disposition, scope, signer, confirmation,
  nonce, and issuance bindings; detached checkouts stay readable but cannot
  record durable Decisions;
- signatures cover the fixed domain-separated canonical envelope and have no
  expiry window;
- fresh and already-running Core, CLI, MCP, and Skill readers dynamically
  reread the external registry, so revocation and mismatch fail closed;
- revoked profiles remain inspectable, the next named-branch host rotates to
  one new active profile while the revoked running host stays fail-closed, and
  a non-semantic process-releasing SQLite writer mutex serializes stale
  owner-record recovery; the complete owner record is atomically published so
  a crash cannot leave an empty canonical lock;
- `plugin_host_click` is an honest host assertion, not WebAuthn, biometric
  verification, named-human identity, or resistance to arbitrary same-UID or
  Plugin compromise.

Core 414/414, CLI 100/100, and MCP 23/23 tests pass, together with complete
typechecks/builds, npm package verification, and thin release-marketplace
verification. The independently validated successor graph preserves the
historical M3.5 outcome and inserts the distinct M3.6 Ticket on the path to
context binding, producing 12 Tickets and 12 direct relations at graph digest
`sha256:09d0081f034778d293e4563b0a45bb411c1e2e1baf714cb1d9c8abe20f247be2`.

M4 execution and independent closeout are implemented on the branch:

- `ticket.frontier.read` derives READY, RUNNING, DONE, BLOCKED, DEVIATED, and
  STALE from current Git facts, dynamically verified Decision authority, and
  disposable live Runs;
- `ticket.context.compile` deterministically expands bounded repository
  references, binds the exact staged index state plus verified Decision
  receipts, rejects Git administration paths and the semantic Ticket ledger as
  generic file context—including through a containing directory—and appends
  the exact ContextBinding manifest to Git;
- `ticket.run.claim` recompiles that exact context before work begins, so
  ignored-file changes and new ignored files inside a referenced directory
  cannot bypass source staleness;
- claim, heartbeat, and release use short-lived SQLite leases whose deletion
  loses no Ticket meaning or accepted completion;
- executor-authored Evidence over ordinary symlink-free worktree paths and
  independently adjudicated Outcomes append as exact Git facts; Evidence
  cannot cite Git administration paths, one exact Run generation admits only
  one terminal Outcome, and successful Outcomes unlock direct dependents only
  while their bound Decision authority remains dynamically current;
- the Run and Closeout Skills orchestrate the seven public operations while
  keeping semantic judgment in Skill intelligence rather than a generic
  workflow engine;
- CLI, MCP, and the HTML graph expose the same operational truth, with healthy
  state quiet and deviations elevated; MCP uses one stable claimed actor per
  connection so executor and verifier sessions do not collapse into one
  global identity;
- installed Ticket and checkpoint wrappers prefer their own bundled runtime
  before PATH, so the thin marketplace artifact remains callable without a
  separately installed global CLI;
- bounded conformance fixtures cover success, a real two-path join,
  partial/failed retry, deviation blocking, stale historical attempts,
  replacement Runs, source movement, staged-index differences, raw/revoked/
  tampered or post-closeout-revoked Decision authority, semantic-ledger
  context-ref exclusion, ignored-context mutation, Git-administration
  exclusion, conflicting terminal closeout, and SQLite deletion recovery.

M4 MR readiness is intentionally established without real-project dogfood.
The bounded Plugin-feature proof remains M5 after merge and must not be
retroactively claimed from the synthetic fixture.

The first real write also exposed a host-integration boundary: the Agent
sandbox may reject an arbitrary Node adapter's otherwise authorized `.git`
lock and checkpoint writes even though the same exact public operation succeeds
from the user's shell. This is not Ticket authority and must not be worked
around by weakening the Git lock or writing Ticket YAML directly. The
checkpoint wrapper now reuses the shared local-CLI resolver so a repository or
packaged CLI wins over an unrelated PATH binary.

Proposal, Validation, Decision, and closeout documents should be introduced
from later dogfood need rather than restored as a fixed workflow.

Implementation evidence is recorded in:

- [`Ticket M1A Git read authority cut`](artifacts/2026-07-29-ticket-m1a-git-read-cut-implementation.md)
- [`Ticket M1B exact-source worktree patch`](artifacts/2026-07-29-ticket-m1b-git-worktree-patch-implementation.md)
- [`Ticket M2 planning and independent validation Skills`](artifacts/2026-07-29-ticket-m2-planning-validation-skills.md)
- [`First Git Ticket Graph validated candidate`](artifacts/2026-07-29-first-git-ticket-graph-validated-candidate.json)
- [`Ticket M3 Git-native review intervention`](artifacts/2026-07-30-ticket-m3-git-review-intervention.md)
- [`Ticket M3/M3.5 authority-boundary validated candidate`](artifacts/2026-07-30-ticket-m3-5-authority-boundary-candidate.json)
- [`Ticket M3.5 durable Decision attestation`](artifacts/2026-07-30-ticket-m3-5-durable-decision-attestation.md)
- [`Ticket M3.6 install-local Decision authority pivot`](artifacts/2026-07-30-ticket-install-local-decision-authority-pivot.md)
- [`Ticket M4 execution and independent closeout`](artifacts/2026-07-30-ticket-m4-execution-closeout.md)
