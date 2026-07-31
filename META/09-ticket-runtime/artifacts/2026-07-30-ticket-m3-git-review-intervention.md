# Ticket M3 implementation handoff: Git-native review intervention

M3 turns the accepted graph HTML into a real, capability-scoped human
intervention surface without creating a review workflow engine.

## What is now durable

The Ticket ledger contains three semantic document families:

```text
.vibehub/tickets/
├── tickets/<ticket-id>.yaml
├── reviews/<subject-digest>/<review-id>.yaml
└── decisions/<decision-subject-digest>.yaml
```

Ticket definitions still determine `graphDigest`. Reviews and Decisions join
them in `semanticLedgerDigest`; `sourceToken` binds the exact raw inventory.
This keeps graph identity stable when review facts are added while making every
writer stale against any concurrent ledger edit.

Reviews are append-only comments or full Ticket edit proposals. Decisions are
stable exact-subject plan-review or protected-boundary facts. All documents are
strictly encoded, bounded, path-derived, Git-readable, and recoverable without
SQLite.

## Authority cut

- Browser payloads carry content and exact subjects only.
- Core allocates Review identity, path, attribution, and time.
- A browser Review requires a host-attested human.
- A Decision requires a host-bound human authority grant for the exact graph
  digest or Ticket revision plus protected boundary.
- The Git Decision is durable intent and evidence, not a self-authenticating
  authority receipt. Raw or freshly reconstructed Decision files remain
  `current_unverified` artifacts.
- A trusted host session promotes only the exact Decision it wrote or the human
  explicitly re-attested. The in-memory receipt binds repository, worktree,
  branch, path, ID, and the full canonical document, and expires on restart,
  scope change, tamper, or timeout. It is never stored in SQLite.
- Default `vibehub ticket review` has no trusted attribution or authority, so
  it is truly read-only.
- A trusted embedding can publish exact capabilities to the host API; the UI
  shows only actions that grant actually covers. M3 does not yet ship that
  trusted context through the installed launcher.

Comments are context, not authority. Ticket edits are proposals, not implicit
patches. Only current exact Decisions verified by the active trusted session
and projected with an authority receipt can gate or delegate execution.
Durable cross-session authority is intentionally deferred to a future signed
attestation rather than inferred from editable YAML.

The installed `vibehub ticket review` entrypoint remains intentionally
read-only because the repository does not yet have a production host adapter
that can establish trusted human identity. Injectable host capabilities and
their end-to-end tests prove the mechanism, not the final user entrypoint.
That adapter and fresh-process authority handoff are owned together by
`contract-ticket-durable-decision-attestation-001`.

## Writer and checkpoint behavior

Reviews, Decisions, and Ticket patches share one per-worktree writer lock and
physical compare-and-swap boundary. Writers validate the complete prospective
semantic ledger, publish with atomic no-replace links, re-read exact physical
inventory, and fail closed while preserving recovery facts if a concurrent
external edit wins after publication.

Review-only and Decision-only selections can be checkpointed without staging
unrelated work. The checkpoint receipt and commit trailer record
`semanticLedgerDigest` alongside `graphDigest`.

## Projection and UI

The review projection derives currentness at the fact's real locus:

- graph → exact graph digest;
- Ticket → exact Ticket ID and revision;
- relation → exact relation reference, endpoints, and dependent revision.

Historical and current-unverified facts stay visible as artifacts without
authority. Deleted Ticket loci retreat to the graph trace rather than
disappearing.

The host retains the accepted whole-graph layout, orthogonal direct-unlock
edges, pan/zoom/fit, minimap, causal focus, and progressive Inspector. Review
actions are quiet disclosure rows rather than dashboard panels. Trace failures
remain visible without hiding executable context. A stale write refreshes the
source while preserving and reopening the user's draft; a successful write
names its durable Git path even if the subsequent refresh fails.

## Skill intelligence

Planning and Validation now refresh the complete graph and same-snapshot traces
before judgment. Comments remain non-mutating context. A current `ticket_edit`
is reconciled into a newly authored complete candidate carrying the exact
Review record in provenance, then passed unchanged to an independent validator
before public patching. Only current authority receipts count; historical
facts remain evidence, not permission. Review remains optional rather than a
mandatory stage.

## Verification

- Core full package suite: 403 passing.
- CLI non-loopback suite: 73 passing.
- MCP full package suite: 23 passing.
- Secure loopback host suite: 9 passing.
- Core, CLI, and MCP typechecks pass.
- Secure loopback host suite covers bearer, Host, Origin, strict JSON/body
  limits, trusted attribution, exact Decision authority, stale writes, and
  full trace pagination.
- `node --check` and repository diff whitespace validation pass.

## Ticket graph settlement

The first M3.5 candidate failed independent semantic validation because the
new durable-attestation path made the old direct M3-to-final-dogfood edge
transitively redundant. Planning removed only that edge and resubmitted the
complete candidate.

The revised eight-Ticket candidate at
`2026-07-30-ticket-m3-5-authority-boundary-candidate.json` has SHA-256
`23cc728e1110d615eda54c7de160525b58e36022d9bd372f810d3eb666fda31f`.
Independent Validation passed it with no material finding and
`human_decision_required`. The public writer applied it as 11 Tickets and 11
direct relations with graph digest
`sha256:8d126f52313d97fd7ed529ae6e52847a3d426d3fcf6d22b9420979f385e94992`
and semantic-ledger digest
`sha256:3c5482ab94cf6d2ecb64353e9ae51e841aab1e4ebe0516160697a6abb461b5e0`.
The eight exact Ticket paths were checkpointed in
`802111ca57d1916a96dd425fa2c40108600be333`.

Durable cross-process Decision attestation remains M3.5. The
execution/Outcome/Evidence closeout loop remains M4.
