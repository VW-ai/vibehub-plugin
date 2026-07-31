# Ticket M1A implementation: Git read authority cut

Date: 2026-07-29
Status: implemented
Handoff:
`2026-07-29-ticket-m1a-git-read-cut-handoff.md`

## Outcome

The production Ticket read path now has one semantic authority:

```text
.vibehub/tickets
  -> strict bounded Git ledger
  -> pure review projection
  -> Core / CLI / MCP / read-only HTML
```

`protocol.yaml` and flat `tickets/<ticket-id>.yaml` documents are sufficient to
reconstruct the graph. SQLite may still hold disposable operational state for
the wider Plugin, but it neither selects, stores, replays, nor authorizes
Ticket meaning.

## Implemented boundary

The new `packages/core/src/ticket-ledger/` kernel provides:

- strict YAML 1.2 protocol and Ticket decoding;
- normalized `ticketRevision`, graph digest, and stable relation identity;
- one flat `depends_on` DAG with endpoint, duplicate, self-edge, and cycle
  validation;
- bounded worktree reads with a stable double inventory;
- exact-ref reads that resolve the ref once and then read one immutable commit;
- repository, worktree, commit, dirty-path, and complete source-token identity;
- one adapter into the existing Ticket Review projection.

The public Ticket operation family is deliberately only:

```text
ticket.graph.snapshot
ticket.subject.inspect
ticket.trace.list
```

All three reads evaluate the trusted worktree path on every call, bypass
SQLite request receipts and output replay, and work without a persisted
repository or active-task row. `ticket.subject.inspect` returns the complete
executable context package rather than only graph chrome.

The CLI, MCP tool, and local HTML host expose that same read family. The HTML
retains the full orthogonal graph, pan/zoom/fit, minimap, causal focus,
Inspector, source commit, dirty state, and worktree identity. It has no
Decision, Apply, validation, authority, or other mutation route.

## Authority deletion

The cut removed the early-stage parallel authority rather than migrating it:

- generation/latest-backed `GitTicketStore`;
- proposal and application services and their public contracts;
- proposal, validation, review, authority, and apply operations;
- five Ticket semantic SQLite table families and the Ticket-only outcome-blob
  extension;
- every legacy `ticket.*` request receipt, with a dispatcher registration gate
  that prevents removed operations from replaying even against a forged or
  pre-migration receipt;
- proposal/application host routes and controls;
- the three obsolete plan/validate/apply Ticket Skills whose instructions
  encoded the retired backend.

Database migration 21 deletes those semantic tables from an existing local
database. Earlier Ticket migration slots remain inert so schema history stays
monotonic.

Package builds now delete only their own `dist` directory before compiling,
and release verification rejects retired Ticket backend artifacts. This keeps
incremental local releases from accidentally publishing code that was removed
from source.

## Verification evidence

The implementation is covered by:

- committed worktree, dirty worktree, exact-ref, moving-ref, sibling-worktree,
  detached-HEAD, branch-switch, and concurrent-edit tests;
- malformed/unsafe YAML, path, file mode, conflict, size, graph endpoint,
  duplicate, self-edge, cycle, and capacity tests;
- snapshot expiry and exact source-token tests;
- empty/contradictory SQLite and no-Ticket-receipt tests;
- CLI and MCP reads without persisted Ticket identity;
- live loopback host tests for bearer/Host isolation, no mutation routes,
  branch refresh, complete context inspection, and the maximum legal
  1,000-Ticket / 5,000-relation graph;
- full typecheck, build, Core/CLI/MCP tests, Skill artifact validation, npm
  package verification, JavaScript syntax checking, and retired-surface
  repository searches.

Final counts were 355 Core tests, 72 CLI tests (67 non-host plus 5 live
loopback-host cases), and 23 MCP tests.

An interactive browser pass was attempted but the available browser bridge
could not open the local file/host target in this run. The same live host path
is exercised through its loopback integration suite; this limitation does not
weaken the Git authority cut, but visual interaction remains a sensible first
smoke check when M1B begins.

## Next boundary

M1B should add one deterministic Skill-facing worktree patch primitive:

- bind the exact worktree, HEAD, graph digest, and targeted Ticket revisions;
- validate the complete prospective graph before any write;
- apply one bounded file change set without creating a local semantic journal;
- optionally hand the validated change to the existing Git checkpoint path.

It must not reintroduce Proposal, Decision, Outcome, or Evidence as mandatory
workflow stages. Those document meanings should enter only when the first real
planning and closeout Skills require them.
