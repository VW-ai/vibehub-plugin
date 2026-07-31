# Ticket M1B implementation: exact-source Git worktree patch

Date: 2026-07-29
Status: implemented
Contract:
[`contract-ticket-git-worktree-patch-001`](../specs/contract-ticket-git-worktree-patch-001.yaml)

## Outcome

Ticket Runtime now has one bounded mutation hand over the Git-native definition
graph:

```text
Skill judgment
  -> exact current Ticket source
  -> ticket.worktree.patch
  -> validated dirty-worktree change
  -> optional separate checkpoint
```

The operation can create, replace, and delete full Ticket documents while
preserving the M1 authority cut: Git documents own Ticket meaning, Skills own
semantic decisions, and Core/CLI/MCP own only deterministic mechanics.

## Exact-source contract

Every request binds the source observed by the caller:

- opaque source token;
- stable worktree identity;
- resolved HEAD commit;
- normalized graph digest;
- expected normalized revision, or exact absence, for every targeted Ticket.

The source token is intentionally stricter than semantic identity. It now
includes a physical inventory digest derived from every ledger path, file mode,
and raw byte digest. A YAML comment, formatting edit, or mode change therefore
rotates the source token even if normalization produces the same graph digest
and Ticket revision. This prevents a mechanically valid patch from silently
overwriting a human's physical edit.

The patch accepts unique, bounded `put` and `delete` changes. A `put` carries a
complete Ticket document; a `delete` carries the exact current revision. The
canonical file path is always derived from `ticket_id`, and the protocol
document is outside the mutation surface.

## Prospective validation and installation

Before any canonical path changes, the writer:

1. resolves the trusted worktree and takes a worktree-local writer lock;
2. reloads and compares all exact-source fields;
3. checks the expected revision or absence of every target;
4. materializes the complete prospective Ticket graph in memory;
5. applies strict document, path, encoded per-file and aggregate capacity,
   relation endpoint, duplicate, self-edge, and cycle validation;
6. serializes normalized Ticket documents to staged files;
7. reloads and rechecks the exact source immediately before installation;
8. verifies each targeted raw preimage immediately before its rename or
   deletion;
9. installs each file atomically;
10. reloads the ledger and requires the precomputed target graph digest.

The result contains before/after exact sources, changed paths, per-Ticket
revision deltas, and a `checkpointSelection`. `noop` is an explicit successful
result when the normalized documents already match.

Unrelated staged and unstaged files are never added, reset, rewritten, or
committed by this operation. Writer exclusion is scoped to one worktree, so a
sibling worktree retains its independent Git world.

## Atomicity and recovery boundary

The operation does not claim transactional multi-file writes.

- Each replacement uses an atomic file rename.
- A process crash between two files may leave a partial dirty worktree.
- A synchronous failure after installation starts attempts a reverse rollback
  from in-memory preimages.
- Rollback proceeds only while each installed path still has the exact
  candidate physical revision; it will not overwrite a concurrent external
  edit.
- If safe rollback cannot be established, the failure reports installed paths
  and directs the caller to inspect `git diff -- .vibehub/tickets`.

There is no durable local semantic journal. The verified dirty worktree is the
patch result; normal Git commit is the multi-file durable semantic boundary.

## Receipt and checkpoint boundaries

`ticket.graph.snapshot`, `ticket.subject.inspect`, `ticket.trace.list`, and
`ticket.worktree.patch` all evaluate the selected Git source on every call.
They require no persisted repository/task identity for Ticket meaning and
create, consult, or replay no SQLite operation receipt. Reusing an old request
after a source change reaches current Git state and fails stale; it cannot
return a cached success.

The patch does not automatically create a semantic ApplicationReceipt and does
not commit. The returned `checkpointSelection` is only a precise handoff for an
optional, separately invoked Ticket checkpoint capability.

M1B includes that optional Core companion as `prepareTicketCheckpoint` and
`commitTicketCheckpoint`. It reuses a path-isolated Git checkpoint kernel to
bind branch, HEAD, raw source token, graph digest, worktree identity, and the
exact Ticket paths; builds through an isolated temporary index; validates the
candidate commit as both the same Ticket graph and the same Git-normalized raw
ledger inventory; and advances the branch by compare-and-swap without staging
unrelated work. A branch switch detected around ref advancement conditionally
rolls back the original branch rather than returning an error after leaving a
hidden commit. It remains an explicit action outside the patch transaction,
and patch completion does not depend on invoking it.

## Bootstrap and authority

A ledger containing only:

```yaml
schema_version: 1
kind: ticket_protocol
format: vibehub.ticket-ledger
```

is a valid empty graph. M1B requires this fixed protocol seed to exist and does
not expose a magic missing-ledger write mode. A setup or planning Skill may
install the seed as an explicit repository change before using the patch.

No Proposal, Validation, Decision, Receipt, Outcome, or Evidence document is
made mandatory by M1B. A Skill decides when those semantic facts are useful,
which changes are delegated, and which product, experience, architecture,
permission, or risk boundaries require a human. The patch only proves that one
exact candidate definition graph can be installed safely enough to become a
reviewable Git change.

## Verification evidence

The M1B test surface exercises:

- protocol-only empty graph creation, full-document update, and explicit
  deletion;
- raw-format source staleness, targeted revision staleness, and duplicate
  targets with zero writes;
- complete prospective graph rejection before canonical writes;
- prospective encoded per-file and aggregate byte-capacity rejection with
  zero canonical writes;
- descriptor-bounded reads that stop at the one-byte overflow sentinel even
  when a regular file grows after its size check;
- worktree-local writer exclusion and sibling-worktree independence;
- partially initialized writer-lock cleanup and exact-base retry;
- synchronous mid-install rollback;
- hard-linked target replacement without mutating the external inode;
- candidate-checkpoint rejection when Git clean filters alter raw Ticket
  inventory, plus conditional original-branch rollback when HEAD switches
  during ref advancement;
- a generated public patch contract that validates the complete closed Ticket
  document and the equality of patch key and `document.ticket_id`;
- receiptless dispatcher behavior, including stale retry instead of output
  replay;
- CLI and MCP access to the same registered operation;
- nonblocking rejection of unsafe special files on the shared read path;
- bounded checkpoint-wrapper input before the CLI process is invoked.

The operation contract, generated adapter registry, CLI, MCP capability, and
packaged Skill dispatch vocabulary all name the same
`ticket.worktree.patch` capability.

## Next boundary

M2 should consume this hand from Skills rather than enlarge it into a workflow
engine:

- plan a real deliverable into a flat executable Ticket graph;
- backchain from observable outcomes and forward-normalize the candidate;
- use independent semantic validation and protected-boundary judgment;
- apply the approved/delegated graph through the exact patch;
- introduce Proposal, Validation, or Decision documents only where the first
  dogfood loop demonstrates their semantic need.

The first real repository Ticket graph is the next proof that the boundary is
usable, not merely mechanically correct.
