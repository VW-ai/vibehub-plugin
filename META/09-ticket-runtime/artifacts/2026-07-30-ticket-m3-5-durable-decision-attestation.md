# Ticket M3.5 implementation: durable human Decision attestation

## Outcome

An installed VibeHub Plugin can ask a human to approve one exact Decision with
WebAuthn user verification, preserve the resulting assertion beside the
Decision in Git, and let a fresh CLI, MCP, or Skill process independently
verify that authority after the writer and browser host have exited.

Raw Decision YAML remains inspectable intent. It is never authority by itself.

## Trust boundary

V0 protects against a process that can edit the governed repository, Ticket
documents, SQLite, Git author metadata, browser payloads, or the loopback
bearer. Such a process can delete evidence and cause denial of service, but
cannot mint or widen accepted human authority.

V0 does not claim to survive compromise of the authenticator, the complete OS
account, the installed Plugin runtime, or the repo-external VibeHub trust
registry. It is local single-installation authority, not federated identity.

The private key remains inside a platform authenticator, Windows Hello, Touch
ID/passkey provider, or FIDO2 security key. Every enrollment, Decision,
re-attestation, and revocation requires WebAuthn user presence and user
verification. There is no key-file or unlocked signer API for an Agent.

## Durable facts

```text
~/.vibehub/trust/decision-authorities.v1.json
  enrolled credential public keys, principal binding, repository scope,
  counters, and authoritative revocation state

.vibehub/tickets/decisions/<decision-subject-digest>.yaml
  exact human Decision intent

.vibehub/tickets/attestations/<decision-id>/<attestation-id>.yaml
  detached WebAuthn assertion over one exact Decision and execution locus
```

The trust registry is outside the governed repository and SQLite. It is
strictly parsed and atomically maintained with a private directory and file
mode. A repository-provided public key is never trusted on first use.

Attestations are append-only Git facts. They participate in
`semanticLedgerDigest` and `sourceToken`, but never in `graphDigest`.
Re-attestation adds a receipt and preserves older receipts.

## Exact signed envelope

The WebAuthn challenge is the base64url SHA-256 of one canonical envelope. The
envelope binds:

- the complete canonical Decision digest, ID, and repository path;
- principal, human kind, authority basis, and basis reference;
- repository incarnation and root;
- worktree identity and canonical root;
- named branch, or the exact commit for detached HEAD;
- graph digest and complete plan disposition/delegated scope, or Ticket ID,
  Ticket revision, protected boundary, disposition, and selection;
- credential ID and enrolled key fingerprint;
- RP ID, exact localhost origin, nonce, issued/not-before time, and expiry.

The durable receipt retains the exact `clientDataJSON`, `authenticatorData`,
and signature. Verification re-derives the challenge, verifies ES256 against
the repo-external enrolled public key, requires the WebAuthn UP and UV flags,
and compares every duplicated claim with the canonical Decision and current
Ticket snapshot.

Named-branch receipts bind the branch name and exact current Decision subject;
unrelated later commits do not silently revoke them. Detached receipts bind
the exact detached commit. Repository incarnation and worktree identity prevent
transfer to a clone or sibling worktree.

## Human ceremony

1. The installed `vibehub-ticket-review` Skill launches the versioned Plugin
   runtime and opens the loopback graph at `http://localhost:<ephemeral-port>`.
2. Enrollment freezes a named principal, authority basis, repository
   incarnation, nonce, and short validity window before
   `navigator.credentials.create()`. Only the verified result enters the
   external trust registry.
3. A Decision POST carries content only. The host rejects browser-supplied
   identity, authority, time, path, expiry, or proof fields.
4. The host freezes the prospective canonical Decision and exact source,
   returns a one-use authentication challenge, and requires
   `navigator.credentials.get()` with user verification.
5. Completion verifies the assertion and rechecks the exact source. The
   Decision is written first through the existing strict writer, followed by
   the matching append-only attestation. A crash between them is safe: the
   Decision remains visible but unverified.
6. The one-use challenge is consumed. Replaying the bearer or completion
   payload cannot change the signed content or produce a wider receipt.

The signer is never left unlocked for the host lifetime. Browser access and
human authority remain separate capabilities.

## Implemented cut

The implementation follows the boundary above without adding a daemon or
semantic database:

- Core defines and strictly decodes the detached attestation document, includes
  it in semantic-ledger identity, appends it through the existing exact-source
  writer boundary, and projects authority only after full ES256/WebAuthn
  verification.
- The file-backed Core trust resolver rereads the external authority registry
  on every lookup. A revocation therefore affects an already-running CLI or
  MCP reader without making the registry part of Git or SQLite.
- CLI owns registration and authentication ceremonies, private registry
  maintenance, one-use short-lived ceremony state, the two-phase Decision
  write, re-attestation, and verified revocation.
- The production review host exposes only content fields to the browser. It
  derives identity, authority, time, path, source binding, and proof from the
  verified ceremony, then writes the Decision before its append-only receipt.
- CLI and MCP construct the external trust resolver for ordinary fresh
  processes. The installed `vibehub-ticket-review` Skill resolves the packaged
  runtime before a PATH fallback and documents the explicit human gesture
  boundary.

Primary implementation anchors are
`packages/core/src/ticket-decision-attestation.ts`,
`packages/core/src/ticket-decision-trust-store.ts`,
`packages/core/src/ticket-ledger/{contract,codec,reader,writer}.ts`,
`packages/cli/src/ticket-webauthn-authority.ts`,
`packages/cli/src/ticket-review-host.ts`, and
`skills/vibehub-ticket-review/SKILL.md`.

## Verification and recovery

A fresh process starts from the current Git ledger and external trust registry.
Only a current, unexpired, unrevoked, fully matching receipt projects as
`gate_decision/current` from an `authority_receipt`. All other valid Decision
documents remain `artifact/current_unverified` or historical evidence.

Tamper, wrong principal, wrong repository/worktree/branch/commit, changed
subject or scope, expiry, revocation, unknown credential, source drift, and
partial writes fail closed. Recovery requires a new explicit WebAuthn action:

- re-attest the same exact Decision to add a fresh receipt;
- create a new Decision when its subject or selection changed;
- enroll a replacement credential after explicit local reset;
- revoke a credential or receipt through a verified human ceremony.

Revocation is authoritative outside Git so deleting repository or SQLite facts
cannot restore authority. Git may retain an audit fact, but it cannot override
the external revocation state.

## Deliberate limits

- No remote account, identity provider, daemon, or generic approval workflow.
- No authority inferred from OS username, CLI actor, Git signature text,
  browser bearer, Decision fields, SQLite, or previous process memory.
- No silent fallback when WebAuthn user verification is unavailable.
- No mandatory review stage for Agent-owned technical choices.

The server ceremony uses SimpleWebAuthn on Node 20+. The browser host uses the
matching browser adapter. `localhost` is the fixed RP ID and the server
continues to bind its socket to loopback only.

## Verification evidence

- Core, CLI, and MCP complete test suites pass: 41 files / 414 tests, 9 files /
  92 tests, and 3 files / 23 tests respectively (529 tests total).
- Focused durable-attestation, external-registry, and secure-host suites cover
  both plan-review and protected-boundary ceremonies through the installed-host
  path, complete binding, fresh-process promotion, Decision-first crash
  recovery, browser-field forgery, replay, tamper, cross-repository/worktree/
  branch/commit/scope/principal failures, expiry, and immediate revocation.
- Core, CLI, and MCP typechecks and complete builds pass. The CLI build copies
  the pinned SimpleWebAuthn browser bundle into the managed host assets.
- Skill package validation, system Skill validation, npm package verification,
  release-marketplace construction, and release-marketplace verification pass.
- A local installed-host browser check loaded the real 11-Ticket / 11-edge
  graph and verified the quiet progressive enrollment disclosure. It
  intentionally stopped before a real Touch ID/passkey prompt; automated host
  integration tests use a real P-256 signature fixture rather than claiming a
  human gesture occurred.

## Settlement

The implementation is committed in
`dbc60dc3fbc22995060a0ee1e6768602c928470c`.

The exact one-Ticket implementation settlement candidate had SHA-256
`7f89f1145f90f25712b6d3877815101f13ed28a7580c2ca0bb76570fd1c98ddb`.
An independent Ticket Validation pass bound it to the fresh committed source,
inspected the changed Ticket, its direct predecessor and dependent, and their
empty traces, and returned `passed` with `delegated` authority and no material
finding. The public writer applied the unchanged candidate at Ticket revision
`sha256:58fd43058b27687a199f57fed5ecff790335fd6f1fde40e85a321d755d5c7565`.

The settled graph remains 11 Tickets and 11 direct relations at graph digest
`sha256:deb8bbe622fff55343016cae043e0792a0b7a6c6dcb330a28e9ffdc7ca2421a9`.
The exact changed Ticket path was checkpointed in
`e8f2afd23d5651b3a90442f5d92e02ee2559720c`.
