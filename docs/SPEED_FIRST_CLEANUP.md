# Speed-first cleanup evidence

Ticket: `ticket-speed-first-cleanup`

## Rollback baseline

Commit `9dee0f095374211d8d7cbeeacac653ebb87bed91` captured the completed
ticket-first runtime pivot, its independently accepted Evidence/Outcome, and
the speed-first cleanup Ticket before hard deletion.

## Footprint

The same production-code scope was measured before and after:
`packages/*/src`, `runtime/`, `skills/scripts/`, and `scripts/`.

| Measure | Before | After |
|---|---:|---:|
| Production files | 110 | 5 |
| Production lines | 40,211 | 1,086 |
| Workspace packages | 3 | 0 |
| External production dependencies | `better-sqlite3`, `yaml`, `zod` | 0 |
| Plugin artifact files | 74 | 28 |
| Plugin artifact bytes | 2,495,913 | 65,042 |

The production-code line count fell by about 97.3%, and artifact bytes fell by
about 97.4%. These are the exact cleanup-closeout measurements; later
gap-driven rebuilds are reported by their own Tickets rather than rewriting
this historical baseline.

## Removed product paths

- Core, CLI, and MCP packages and their test suites
- SQLite/native persistence and package lock/workspace metadata
- generic operation dispatcher and runtime launcher
- lifecycle hooks and per-turn context cadence
- Run coordination, compiled Context copies, and local Decision attestation
- writable loopback Ticket review host
- npm runtime publication and installer pipeline
- CAS-style semantic store and historical runtime Ticket artifact graph
- distillation/update workflows whose complexity depended on the removed runtime

The previous ledger was preserved in Git history. The active product decision
was converted once into
`.vibehub/context/decision-speed-first-skill-plugin.yaml`; the executing Ticket
and baseline Evidence were converted into the new direct layout.

## Preserved minimum quality

- Four shared JSON Schemas cover Context, Ticket, Evidence, and Outcome.
- The persisted `.yaml` format is a deterministic JSON-compatible YAML 1.2
  subset, so a clean plugin install needs no package dependency.
- Context validation enforces stable IDs, readable source/evidence, strict
  fields, and valid relation endpoints.
- Ticket validation enforces strict fields, acceptance IDs, readable context
  refs, dependency endpoints, acyclic graphs, acceptance-linked Evidence, and
  complete Outcome accounting.
- Only a successful Outcome unlocks direct dependents.
- Setup detects overlapping documentation/memory/Skill surfaces and requires a
  user choice before dual-write or replacement.

## Verification

`npm run verify` passed:

- 4 fresh-process Context/Ticket tests
- malformed persisted input and dangling Context failures
- missing Ticket endpoint and dependency-cycle failures
- acceptance-linked Evidence and success/non-success unlock behavior
- dependency-free artifact build and installed Context roundtrip

Both Claude and Codex marketplace builders also completed against the new
artifact.

## Observed gaps and disposition

- The old Ticket-only checkpoint helper could not isolate a new Ticket while
  previous Ticket Evidence was dirty. We did not repair it; a normal Git commit
  became the rollback boundary, and the helper was deleted.
- The old governed reads required opening SQLite outside the restricted
  worktree and the MCP transport had previously closed during use. We did not
  repair either path; direct files now work in a fresh process.
- Full free-form YAML syntax is not parsed. The product currently writes and
  accepts the JSON-compatible YAML subset. This keeps the install dependency
  free; richer YAML should be rebuilt only if real editing behavior proves the
  subset insufficient.
- At cleanup closeout there was no local graph web UI. Subsequent dogfood made
  that absence an owner-confirmed product gap, so
  `ticket-restore-local-graph-ui` selectively restores the visual experience as
  a direct-YAML, read-only loopback projection without restoring the old
  runtime stack.
