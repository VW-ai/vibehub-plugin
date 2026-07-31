# Ticket M4 — MR-ready execution and independent closeout

Date: 2026-07-30
Status: MR-ready on `codex/ticket-runtime-wayfind`

## Outcome

M4 completes the Ticket runtime surface without requiring the unfinished
runtime to dogfood itself. A fresh Agent can discover the correct executable
frontier, compile the exact bounded context, hold a short-lived Run lease,
append acceptance-scoped Evidence, release the attempt, and hand it to a
different verifier for Outcome closeout. Current successful Outcomes derive
DONE and unlock only direct dependents whose prerequisites are all DONE.

Real Plugin-feature dogfood is deliberately post-merge M5. The synthetic
conformance repository proves runtime semantics, not real-project value.

## Durable and disposable split

Git owns:

- Ticket definitions and typed dependency graph;
- exact ContextBinding manifests, verified Decision receipt refs, and packet
  digests;
- acceptance-scoped Evidence;
- terminal Outcomes, including successful, partial, failed, deviated, and
  stale attempts;
- enough identity to reconstruct completion, deviation, and frontier after
  SQLite loss.

SQLite owns only:

- short-lived Run claims, generations, heartbeats, and release state;
- one-time bearer verification material;
- current-process coordination that may be deleted without losing semantic
  truth.

The execution-start source binds HEAD, branch, worktree identity, non-Ticket
worktree bytes and modes, and the exact staged index blob IDs and modes.
Context compilation rejects traversal, symlinks, special or binary files,
overlapping references, Git administration segments, source movement, and
capacity overflow. Claim recompiles the exact context manifest before work
begins, including ignored files and newly added files below referenced
directories. Relevant Decisions enter the packet only after dynamic authority
verification; raw, revoked, tampered, changed, or non-authorizing Decisions
keep the operational frontier blocked. `.vibehub/tickets` cannot be
reintroduced directly, through a descendant, or through a containing directory
as generic file context because it changes as bindings and evidence are
appended; Ticket, graph, Decision, verification, and prerequisite Outcome
semantics are already bound through first-class packet fields. A legacy
binding that violates this current policy remains traceable but cannot derive
operational DONE or downstream READY. Evidence likewise rejects `.git`
administration paths and may cite only ordinary symlink-free worktree files or
commits.

## Public hands and Skill intelligence

Seven receiptless operations expose deterministic mechanics:

1. `ticket.frontier.read`
2. `ticket.context.compile`
3. `ticket.run.claim`
4. `ticket.run.heartbeat`
5. `ticket.run.release`
6. `ticket.evidence.append`
7. `ticket.closeout.append`

`vibehub-ticket-run` owns execution orchestration and never self-closes.
`vibehub-ticket-closeout` requires an independent verifier, checks every
acceptance against matching Evidence, and chooses the honest terminal form
before planning follow-up work. These Skills were authored with the repository
Skill packaging conventions and the official Skill Creator guidance, keeping
judgment in concise instructions and mechanics in the shared wrapper.

CLI callers provide an actor ref explicitly. MCP derives one stable claimed
actor ref per connection from client metadata plus a session nonce, caches the
capability context for that connection, and offers no per-call actor override.
Thus one MCP session cannot masquerade as its own independent closeout Agent,
while a separate verifier session receives a distinct attribution. Actor refs
remain attribution, not protected Decision authority.

The thin installed Plugin wrappers prefer an explicit `VIBEHUB_BIN`, then a
source-tree CLI, then their own bundled runtime, and only then PATH. Ticket and
checkpoint operations therefore remain callable from the marketplace artifact
without requiring a separately installed global CLI.

One exact Ticket subject, Run ID, and generation admits only one terminal
Outcome. Equivalent delivery is idempotent; sequential or competing
contradictory closeout fails closed and cannot unlock downstream work.
A successful Outcome remains a durable Git trace if its bound Decision
authority is later withdrawn, but it immediately stops deriving operational
DONE or downstream READY in the execution frontier and trusted graph view.

## Projection

The existing zoomable workflow graph remains the primary human view. Git
projection supplies operational READY, DONE, BLOCKED, and DEVIATED state to
nodes, minimap, Inspector, and Outcome trace. Healthy state stays quiet;
deviation is the only state promoted to the Corner Signal. The surface does not
invite hand-editing Ticket YAML or claim that the Inspector already contains
the compiled execution packet.

## Verification map

| Concern | Primary implementation | Adversarial evidence |
| --- | --- | --- |
| Exact source and bounded context | `ticket-context-compiler.ts`, `git-facade.ts` | traversal, symlink, binary, overlap, size, source-change, ignored-file/directory mutation, staged-blob/mode, and linked-worktree index tests |
| Decision authority in execution | `ticket-execution-service.ts`, `ticket-decision-attestation.ts` | raw, revoked, tampered, request-changes, exact-receipt, post-closeout revocation, host-session restart, and fresh-process tests |
| Semantic context boundary | `ticket-context-compiler.ts`, execution and Evidence path checks | Ticket-ledger root/descendant rejection, case-folded Git-administration exclusion, component-safe lookalikes, and legacy stale-packet claim tests |
| Disposable ownership | `ticket-run-store.ts` | lease takeover, generation, bearer, expiry, release tests |
| Durable facts and derivation | `ticket-ledger/{contract,codec,reader,writer,projection}.ts` | malformed identity, independent verifier, all-acceptance, single-terminal, conflicting-closeout, fail-closed projection, and DB-loss tests |
| End-to-end execution | `ticket-execution-service.ts`, dispatcher | direct unlock, two-path join, retry, deviation, stale replacement conformance |
| Agent use | `skills/vibehub-ticket-run`, `skills/vibehub-ticket-closeout` | package validation, clean-PATH thin-runtime wrapper tests, MCP session actor separation, and forward-use review |
| Human projection | `assets/ticket-review-host` | focused host integration tests |
| Installed surfaces | generated operation contracts, CLI and MCP registries | contract fixtures, capability tests, release-marketplace verification |

## MR boundary

MR gates are the complete non-dogfood package tests and typechecks, generated
contract consistency, Skill validation, package/release verification,
clean-cut searches, independent Ticket-graph validation, and final adversarial
code review. A real Plugin feature completed through Tickets is M5 follow-up
evidence and does not block this merge.

Final evidence:

- Core 450/450, CLI 105/105, and MCP 25/25 tests passed; all workspace
  typechecks passed.
- npm package contents and tarballs, release metadata, the thin marketplace,
  real Claude/Codex host installation, the artifact runtime and MCP startup,
  and Codex plugin ingestion passed.
- The final public `npm audit` was not repeated because it requires separate
  authorization to disclose dependency metadata to npm. Dependency manifests
  are unchanged; the same branch had already passed that audit, and the final
  isolated artifact/host installations passed.
- Independent adversarial code review and Skill/package review returned
  ACCEPT. The exact four-Ticket truth candidate
  `c6fdc8f0c3f9aa236b572a18329b161ea255adaef69df28713faecdeae4263fa`
  passed independent semantic validation and was checkpointed in `85c7eb4`.
- No real Ticket dogfood was run.
