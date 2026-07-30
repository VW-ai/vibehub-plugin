# Ticket M3.6 — Install-local Decision authority pivot

Date: 2026-07-30
Status: implementation and successor documentation complete in the working
tree; commit pending

## Outcome

Ticket Runtime keeps durable, exact, fresh-process-verifiable Decision receipts
without requiring WebAuthn. One explicit click in the installed Plugin review
host records one exact Decision and signs its detached Git attestation with a
repository-scoped, installation-local Ed25519 key.

The active contract is
[`contract-ticket-install-local-decision-attestation-001`](../specs/contract-ticket-install-local-decision-attestation-001.yaml).
The M3.5 WebAuthn contract is superseded. Its
[`implementation artifact`](2026-07-30-ticket-m3-5-durable-decision-attestation.md)
remains unchanged historical evidence of the first durable-receipt boundary.

This successor is not an Agent-selected security-policy change. In the live
planning session, the user explicitly rejected mandatory Touch ID/passkey and
then authorized the install-local pivot. That conversation approval bootstraps
this replacement before its own Decision surface exists; it is durable here as
product provenance, not misrepresented as a cryptographic receipt.

## Why WebAuthn was removed

M3.5 correctly proved that an editable Decision document cannot authenticate
itself and that durable authority needs an external trust root plus an exact
signed receipt. Its WebAuthn ceremony, however, imposed browser/authenticator
complexity and represented stronger human-presence semantics than this local
development product currently needs.

The successor keeps the security property that matters now:

```text
repo-only facts cannot mint authority
  + one explicit Plugin-host click
  + one exact signed Decision receipt
  + dynamic fresh-process verification and revocation
```

It deliberately gives up the claim that an authenticator or biometric verified
a particular human. This makes the current product semantics smaller and more
truthful while retaining an upgrade path to an OS-backed or remote authority
if the threat model later requires it.

## Current authority material

The Plugin installation owns one Ed25519 profile per repository incarnation.
The default trust store is outside the repository and SQLite:

```text
~/.vibehub/trust/decision-authority.v1/
├── registry.json
└── keys/
    └── tdk-<sha256-public-key>.pk8.pem
```

Directories and files are constrained to owner-only `0700` and `0600`
permissions and symlinked trust paths fail closed. The registry contains the
public verification profile and revocation fact. The PKCS#8 private key never
enters Git, Ticket YAML, SQLite, a browser request, or the receipt.

Identity is deterministic:

```text
keyFingerprint = sha256(SPKI DER public key)
keyId           = "tdk-" + keyFingerprint
profileId       = "tla-" + sha256(JSON.stringify({
                    keyId,
                    keyFingerprint,
                    repositoryIncarnation,
                    algorithm: "Ed25519"
                  }))
principalId     = "local-installation:" + profileId
authorityRef    = "vibehub:local-installation:" + profileId
```

The profile uses `designated_human` as the semantic host attribution. It does
not claim that the key authenticates the repository owner. The key is
repository-scoped through `repositoryIncarnation`, not
worktree-scoped. Individual receipts still bind one exact worktree and checkout,
so sibling worktrees can share the installation profile without sharing a
Decision's authority.

Authority writes use a 0600 owner-record lock inside a process-releasing
SQLite writer mutex. The SQLite file is pre-created owner-only before SQLite
opens it and contains no key, profile, Decision, receipt, identity, or other
semantic authority; it only serializes local writers, and its kernel lock
disappears if a process exits. The complete owner record is fsynced to a unique
temporary inode before an atomic no-replace hard link publishes it, so a crash
cannot leave an empty or truncated canonical lock. While holding the mutex, a
well-formed owner record whose process no longer exists is recovered on retry;
an active, malformed, symlinked, or insecure canonical owner record fails
closed. This prevents a crashed signer from permanently disabling future
confirmations without leaving a stale-lock check/unlink race between concurrent
recoverers.

## Exact signed receipt

The detached attestation envelope binds:

- Decision ID, document path, and canonical document digest;
- authority principal, principal kind, basis, and basis reference;
- repository incarnation and root;
- worktree identity and root;
- the named branch;
- plan-review graph digest, disposition, and any delegated boundaries; or
- protected Ticket ID and revision, boundary, disposition, and any selection;
- signer key ID, public-key fingerprint, and `Ed25519`;
- `confirmation.method: plugin_host_click`;
- a fresh nonce and `issued_at`.

There is no `not_before`, `expires_at`, or TTL. `issued_at` is signed evidence,
not an expiry policy. The signature is canonical base64url Ed25519 over:

```text
"vibehub.ticket-decision-attestation.v1\0"
  + canonical_json(envelope_without_signature)
```

Any edit to the Decision or any bound repository, checkout, subject, scope,
authority, signer, confirmation, nonce, or issuance fact invalidates
verification.

Detached checkouts remain available for read-only graph inspection, but the
installed host hides durable Decision controls and rejects a direct Decision
request. Binding an exact detached commit would make the receipt invalidate
itself as soon as the Decision and receipt were committed, so M3.6 deliberately
requires a named branch.

## One-click write flow

```text
Plugin host receives explicit Decision click
  → reload exact current Git ledger snapshot
  → ensure one active repository-scoped local profile
  → prepare the exact Decision and authority attribution
  → build and sign its exact attestation envelope
  → inject only the matching one-Decision authority grant
  → write and verify the Decision
  → append and verify the detached receipt
  → return exact changed paths for optional checkpointing
```

Browser input never supplies principal, key, signature, time, document path, or
authority proof. The host owns those facts. There is no draft-to-human-review
stage and no second attestation ceremony.

The Decision is written before its receipt because the receipt binds the final
canonical Decision digest and path. If interruption occurs between those
writes, the raw Decision remains visible as current-unverified evidence. It
does not unblock protected execution; repeating the explicit Decision action
can safely produce the exact receipt.

## Verification and revocation

Core verifies the canonical envelope and Ed25519 signature only after resolving
the exact key ID, fingerprint, and repository incarnation from the external
registry. CLI, MCP, and Skill construction use the same resolver.

The resolver rereads the registry for every verification. It is not a
process-lifetime authority cache. Consequently:

- a fresh process can verify without a previous host session or SQLite;
- an already-running reader observes revocation on its next verification;
- an absent, malformed, ambiguous, mismatched, or revoked profile fails closed;
- a branch, detached checkout, worktree, repository, Decision, or scope mismatch
  fails closed;
- a raw Decision or copied receipt never becomes authority by attribution
  alone.

Revocation is profile-level. Because receipts have no expiry, revocation is the
explicit way to invalidate otherwise-current historical signatures from that
installation profile. The authority class exposes the bounded repository
revocation operation; a dedicated end-user revoke control is not part of the
current graph surface. Revoked profiles remain available for historical
verification. A running host remains bound to the exact profile selected at
startup and fails closed if it is revoked; it cannot silently rotate from an
old form or direct request. The next named-branch host startup rotates to one
new active profile.

## Honest trust statement

The receipt proves that the installation-local private key signed the exact
envelope and that the currently resolved repository profile is not revoked.
The signed `plugin_host_click` field records the Plugin host's assertion that
its explicit action occurred.

It does **not** prove:

- WebAuthn user presence or user verification;
- biometric confirmation;
- the identity of a named human;
- that another process running as the same OS user could not read or invoke the
  private key;
- that the Plugin/runtime or local OS account was uncompromised.

The current threat model excludes arbitrary same-UID compromise, malicious
Plugin code, and local OS-account compromise. Within that boundary, it protects
against repository-only, Git-only, and SQLite-only fabrication; copied or stale
checkout use; receipt tampering; and fresh-process trust confusion.

## Historical continuity and next boundary

M3.5 remains historically accurate: it implemented the first WebAuthn-backed
durable receipt and demonstrated the exact binding, external trust, dynamic
revocation, and fresh-process properties. M3.6 supersedes only its ceremony,
expiry, and identity claim. It does not rewrite that evidence.

Implementation commit `dd771df13185fc472ade73d6962b3e3e8be78403`
contains the runtime, installed surface, Skill, successor contract, and
independently validated 12-Ticket graph. Execution, Outcome, Evidence, and
semantic closeout remain the next Ticket Runtime milestone after the exact
protected context-binding and closeout choices are ratified through the
installed Plugin-host surface.
