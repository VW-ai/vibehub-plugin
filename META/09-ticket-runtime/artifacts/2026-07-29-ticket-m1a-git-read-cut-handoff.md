# Ticket M1A implementation handoff: Git read cut

Date: 2026-07-29
Status: implemented
Parent plan:
`2026-07-29-ticket-git-native-skill-driven-pivot-plan.md`
Closure:
`2026-07-29-ticket-m1a-git-read-cut-implementation.md`

## Outcome

The first implementation slice is one narrow, product-visible read path:

```text
.vibehub/tickets
  -> deterministic Git ledger reader
  -> existing graph projection
  -> Core / CLI / MCP
  -> read-only Ticket graph HTML
```

It is complete when the same current-worktree Ticket graph is visible through
Core, CLI, MCP, and the accepted HTML surface when the old
`.vibehub/ticket-store` is absent and after a deleted operational SQLite
database is recreated and the repository is re-registered.

This slice does not implement planning, proposal, decision, execution, or
closeout writes. It first establishes the semantic substrate those Skills will
use and retires the old production Ticket read authority.

## Protocol frozen for this slice

M1A introduces only the protocol document and Ticket definitions:

```text
.vibehub/tickets/
  protocol.yaml
  tickets/<ticket-id>.yaml
```

There is no manifest, generation, mutable latest pointer, relation directory,
event stream, or SQLite projection.

`protocol.yaml` contains only:

```yaml
schema_version: 1
kind: ticket_protocol
format: vibehub.ticket-ledger
```

A minimal Ticket is:

```yaml
schema_version: 1
kind: ticket
ticket_id: ticket-ledger-read-cut

outcome: >-
  A fresh process can reconstruct the current Ticket graph from one exact Git
  source without SQLite.

context: |-
  This is the deterministic substrate used by Ticket Skills and graph HTML.

acceptance:
  - acceptance_id: exact-source
    criterion: An exact Git ref resolves once and every document comes from it.
  - acceptance_id: no-db
    criterion: Deleting the local database does not change the graph.

constraints:
  - Never union facts from sibling worktrees.
  - Core does not decide which Ticket should execute next.

context_refs:
  - ref: META/09-ticket-runtime/specs/decision-ticket-git-native-ledger-001.yaml
    purpose: Durable authority

relations:
  - type: depends_on
    target_ticket_id: ticket-authority-cut
    rationale: The authority boundary must be frozen first.

provenance_refs:
  - META/09-ticket-runtime/artifacts/2026-07-29-ticket-git-native-skill-driven-pivot-plan.md
```

Frozen rules:

- `ticket_id` is a readable, lowercase, path-safe ID and must match the
  filename. Direct readable paths are preferred over hashed filenames.
- Ticket documents are strict. `parent_id`, nested children, `scenario_id`,
  `status`, workflow stage, next action, and review flags are not fields in the
  protocol.
- `outcome` binds one stable promise. A material promise change creates a new
  Ticket; Core does not attempt to judge materiality.
- `acceptance` may be empty while a coarse Ticket or Planning Fog is not yet
  executable. Skills, not schema flags, judge readiness.
- The first relation vocabulary contains only `depends_on`. The relation is
  stored on the dependent Ticket; the review projection reverses it into the
  user-facing prerequisite-to-dependent unlock edge.
- Relation identity is derived from protocol version, subject Ticket ID,
  relation type, and target Ticket ID. It does not include graph snapshot
  identity, so unrelated graph edits do not rename every relation.
- A Ticket revision is the SHA-256 digest of its validated normalized semantic
  value. It is derived, not manually incremented or stored. Exact source
  identity distinguishes equal content on different commits or worktrees.
- The graph digest covers the protocol version plus normalized Tickets sorted
  by Ticket ID. It excludes YAML formatting, comments, key order, branch name,
  HEAD, mtime, and SQLite.
- Acceptance IDs are unique. Acceptance, context references, relations, and
  provenance references normalize by stable identity; constraints preserve
  author order and are therefore semantic.
- Use a maintained YAML 1.2 parser. Reject custom tags, merge keys, duplicate
  keys, aliases, unknown semantic fields, and documents over their byte limit.
  Do not write a new YAML parser.

The vocabulary can gain `contributes_to`, `verifies`, or `supersedes` when a
real planning or closeout case requires them. M1A does not pre-build their
semantics.

## Exact source model

The reader has two source modes.

### Worktree

A worktree read binds:

- canonical repository/common-dir identity;
- stable worktree identity and canonical worktree root;
- exact HEAD commit, including detached HEAD;
- current semantic graph digest;
- committed HEAD graph digest;
- Ticket-root dirty paths, including untracked and deleted files;
- unmerged Ticket-root paths, which fail closed.

Uncommitted Ticket files are pending local semantics and are included. Dirty
files outside `.vibehub/tickets` neither change the graph digest nor block a
read.

### Git ref

A ref read resolves the requested ref to one commit exactly once, then lists
and reads every Ticket document from that tree. It never mixes a moving branch
tip with files from another commit and never changes the current checkout.

Branch name is display metadata. Two worktrees at the same commit and digest
remain distinct worktree sources for Run or write binding.

The worktree source token is derived from:

```text
protocol version
+ repository incarnation
+ stable worktree identity
+ HEAD commit
+ graph digest
```

The graph digest intentionally remains content-only; the source token supplies
the Git/worktree binding. A branch switch to a different HEAD therefore
expires an old review snapshot even when Ticket content is identical.

An exact-ref source token replaces worktree identity and HEAD with its
once-resolved commit; the requested-ref label remains display metadata. Moving
the branch later does not mutate the already-resolved source, while a new load
resolves a new source.

Worktree loading must not return a graph assembled across concurrent edits.
Capture HEAD and Ticket-root status, read and hash one complete bounded
inventory, repeat the capture and inventory, and accept only when HEAD, status,
paths, file modes, and bytes agree. Retry a small bounded number of times, then
fail with `source_changed_during_read`. A ref read needs no double read after
the ref has resolved to one immutable commit.

The existing public review API can reconstruct an exact snapshot only while
the addressed worktree still has the same graph. `loadSnapshot` reloads the
current worktree and returns `snapshot_expired` when its complete source token
or derived snapshot ID differs. It does not recreate internal generation
retention. Exact historical reads use an explicit Git ref/commit source.

## Implementation boundary

### Core additions

Create a small module family rather than adding more responsibilities to the
legacy 2,000-line Ticket store:

```text
packages/core/src/ticket-ledger/
  contract.ts
  codec.ts
  reader.ts
  projection.ts
  index.ts
```

The public mechanical capabilities are:

```text
ticketDocumentPath(ticketId)
loadTicketLedgerFromWorktree(worktreePath)
loadTicketLedgerAtRef(repositoryPath, ref)
validateTicketLedger(candidate)
projectTicketLedgerForReview(snapshot)
```

`contract.ts` owns bounded Zod schemas and types. `codec.ts` owns safe YAML
parsing and normalized semantic digests, with no Git or DB access. `reader.ts`
owns exact worktree/ref inventory and source metadata. `projection.ts` is the
only adapter into Ticket Review DTOs.

Extend `GitFacade` with Ticket-root-scoped primitives instead of privately
shelling out from the ledger:

```text
resolveCommitAt(anyPath, ref)
listTreeFilesAt(anyPath, commit, pathspec)
readFileAtCommit(anyPath, commit, repositoryRelativePath)
statusPathsAt(anyPath, pathspec)
```

Reuse the existing common-dir/worktree resolution, HEAD lookup, bounded schema
style, deterministic graph projector, pagination, Inspector reads, DAG checks,
and orthogonal HTML layout. Reuse the semantic-store design discipline for
sorted inventories, path containment, symlink rejection, and digests, but do
not import its Spec schemas, SQLite adapters, canonical-JSON-only codec, global
manifest, or checkpoint implementation.

### Review read cutover

Replace the default generation provider with a Git Ticket document provider.
The provider emits current Ticket definitions and direct unlock relations;
capability projections and trace records are empty in M1A.

Replace `definitionRevision: number` with `ticketRevision: string`, carrying
the derived Ticket digest. Bump the Ticket Review wire schema version and
replace the old field in place; do not support both shapes.

The graph snapshot remains a compact topology view. `ticket.subject.inspect`
must expose the selected Ticket's complete executable-context fields:
`outcome`, `context`, `acceptance`, `constraints`, `context_refs`, provenance,
and its typed relations. A fresh Agent must not need direct filesystem access
or the old proposal service to read the package.

Extend the review source/header with explicit Git-source metadata needed by the
HTML:

- source mode (`worktree` or exact `ref`);
- resolved commit;
- worktree identity/root when applicable;
- graph digest;
- semantic-dirty boolean and bounded dirty paths;
- opaque complete source token.

Keep these operation names:

- `ticket.graph.snapshot`
- `ticket.subject.inspect`
- `ticket.trace.list`

These three pure reads must bypass request-receipt persistence and output-blob
replay in `OperationDispatcher`. Their payload hash currently has no HEAD or
graph digest binding, so replay can return an obsolete graph after a branch
switch or dirty edit. Each call must evaluate the addressed Git source. A
future cache is allowed only when keyed by exact commit or worktree graph
digest.

They must also resolve their source without requiring a repository or task row
from SQLite. CLI, MCP, and the local host bind a trusted worktree path when
constructing the adapter; Core resolves and verifies Git identity from that
path. `repoId` and `taskId` may remain operational routing metadata, but they
cannot select or authorize Ticket semantics. This lets MCP recover after an
empty DB reinitialization without fabricating an active task row.

### HTML cutover

Temporarily narrow `vibehub ticket review` to an honest read-only
current-worktree graph:

- do not require a proposal ID;
- build state only from the three Ticket review reads;
- retain complete graph visibility, orthogonal layout, pan/zoom/fit, minimap,
  causal focus, Inspector, responsive disclosure, and local serving;
- remove the current SQLite proposal review, trusted local authority, Decision,
  and Apply routes and controls;
- show commit/worktree and dirty semantic state quietly in the projection.

Git Proposal, Validation, Decision, comments, and edits return to this surface
only after their document protocol and Skill operations exist. The HTML must
not silently keep the old SQL workflow behind a new graph reader.

## Deletion boundary in M1A

Delete or rewrite in the same slice:

- the legacy generation-backed review provider and store;
- `ticket-proposal-service` and `ticket-application-service`;
- the old proposal, validation, review, authority, and apply operation schemas,
  generated contracts, dispatcher handlers/services, CLI/MCP capabilities,
  public exports, and fixtures;
- the five Ticket semantic SQLite table families, their triggers, output-blob
  special cases, writer fence/recovery code, and tests that only prove them;
- proposal-only review-host state builders, authority provider, Decision and
  Apply routes, request parsers, and matching browser controls;
- Ticket-read tests that require request-ID output replay from SQLite;
- “publish/repair generation” guidance on the read path;
- resolver comments and current docs that claim the review graph comes from a
  published latest generation;
- dead imports, CSS selectors, fixtures, and helpers made unreachable by the
  read-only HTML cut.

The retired operation names are:

```text
ticket.proposal.submit
ticket.proposal.inspect
ticket.proposal.list
ticket.proposal.validation.record
ticket.proposal.validation.inspect
ticket.proposal.validation.list
ticket.proposal.review.inspect
ticket.proposal.authority.decide
ticket.proposal.apply
```

They are removed rather than redirected or retained as fail-open compatibility
shells. Until M2 introduces Git document mutations, the honest product surface
is read-only. No released or pushed checkpoint may expose the new read
authority alongside the old semantic write authority.

## Implementation order

Use two internal checkpoints but one authority cut:

1. Build and test the protocol, codec, reader, source token, and review adapter
   behind a non-default test seam.
2. In one final cut, switch all three reads, make them DB-independent and
   non-persistent, remove every retired operation and backend, and narrow the
   HTML host to the current Git graph.
3. Run focused Core, CLI, MCP, host, typecheck, build, package-file, repository
   search, and local browser checks before the cut is published or pushed.

Intermediate local commits may exist for review, but there is no supported
intermediate runtime and no production dual authority.

## P0 test matrix

The slice is not done without evidence for:

- committed worktree and exact-ref loads with no DB or daemon;
- one ref resolution followed by coherent reads from that commit;
- sibling worktrees at different commits with no semantic leakage;
- dirty, untracked, and deleted Ticket files changing only the worktree graph;
- unrelated dirty files not changing the Ticket digest;
- branch switch to a different HEAD, stale graph, concurrent-edit detection,
  and old snapshot fail-closed behavior;
- malformed YAML, unknown fields, duplicate IDs or edges, filename/ID mismatch,
  missing endpoints, self-dependency, dependency cycle, symlink, path escape,
  conflict, oversized file, and oversized ledger failures;
- YAML comments, whitespace, and key ordering not changing semantic digests;
- SQLite deletion plus empty operational reinitialization, or contradictory
  legacy rows, not changing any ledger result;
- MCP reads succeeding without a persisted active-task row;
- the three reads creating no SQLite operation receipt or output blob;
- repository search finding no registered or exported retired Ticket semantic
  operation, table, provider, service, or host route;
- Core, CLI, MCP, and HTML producing the same snapshot from one fixture;
- `ticket.subject.inspect` returning the full executable context package;
- the review host exposing no legacy Decision or Apply route;
- retained graph layout, pan/zoom/fit, causal focus, and Inspector behavior.

No M1A performance benchmark, crash-recovery journal, browser redesign,
multi-host concurrency, or general query engine is required.

## Stop conditions

Do not expand M1A to implement:

- Proposal, Validation, Decision, ApplicationReceipt, Outcome, or Evidence;
- a writer fence, application journal, internal snapshot retention, or
  automatic commit;
- Ticket readiness, next-Ticket selection, planning judgment, human-gate
  classification, or a generic workflow engine;
- SQLite index/cache, daemon/watch loop, global branch lock, or migration of
  the early-stage Ticket database.

If the read cut appears to require a compatibility generation or an SQLite
semantic fallback, stop and remove that assumption rather than carrying it
into the new protocol.

## Next after M1A

M1B adds one Skill-facing, validated worktree patch capability bound to exact
worktree, HEAD, graph digest, and targeted Ticket revisions. It validates the
complete prospective graph before writing, uses per-file temp plus atomic
rename, reloads and verifies the target digest afterward, and leaves Git
commit as the multi-file semantic atomic boundary.

M1B also generalizes the existing path-isolated temporary-index and
compare-and-swap checkpoint discipline to a bounded Ticket change set. The
checkpoint remains an optional Skill collaboration capability, not a mandatory
writer stage; protected-branch policy stays in the Skill.

Only then do the planning and validation Skills create the first real Git
Proposal/Validation/Decision documents. This keeps Core mechanical and lets
the document types emerge from the real dogfood loop instead of pre-building
another workflow service.
