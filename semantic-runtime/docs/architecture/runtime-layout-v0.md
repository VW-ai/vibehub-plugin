# Runtime layout contract v0

Status: migration baseline. This document describes where the Runtime is going
and the order that keeps current behavior reviewable. It does not claim that
the target directories already exist.

## Business boundary

The supported flow remains:

1. receive authenticated source observations;
2. form provenance-bearing candidates inside one Project and Exploration;
3. let Policy, Judge, and explicit human boundaries decide how candidates may
   be used;
4. answer Context Query with selected shared background, the caller's own
   Exploration, and labeled notices from related Explorations.

Seeing another Exploration and adopting from it are separate operations. A
layout change must not turn awareness, similarity, confidence, or a model
decision into canonical authority.

## Target roles

```text
src/domain/          pure business values, rules, and contracts
src/application/     authorized use cases and transaction orchestration
src/adapters/        SQLite, Git, providers, and secret-store implementations
src/app/local/       the one local composition root, service, HTTP, CLI, and UI
test/                deterministic product tests, fixtures, and support
verification/live/   explicitly invoked real provider, host, or Keychain checks
verification/reports deliberately selected measurements and their manifests
research/            Phase 0 replay, host probes, platform spikes, UX, examples
tools/               maintenance and release-boundary checks
docs/                product, architecture, contracts, operations, and history
```

`domain` may not depend on application, adapters, app/local, I/O, storage, Git,
or providers. `application` coordinates domain rules through fixed internal
capabilities and does not import app/local. Adapters implement external
capabilities and do not import app/local. Production source never imports test,
verification, or research code. `src/index.mjs` remains the single package
entry until a separate product decision changes the public surface.

Context may carry Graph references. Graph does not know the Context query
workflow. The Runtime may still use one SQLite transaction: directory roles do
not imply processes, databases, queues, or network services.

## Current structural facts

The machine baseline is
[`runtime-layout-baseline-v1.json`](runtime-layout-baseline-v1.json). It fixes
the current root exports, npm command names and live/offline classification,
version/schema/namespace constants, standalone copy roots, complete production
static and dynamic literal import edges, current SCCs, and a per-file
current-role/destination inventory. The inventory includes Runtime-root component
metadata, instructions, documentation, and configuration examples as well as
the files under the source, test, script, prototype, spike, policy, and docs
trees.
`npm run check:boundaries` verifies it without credentials, Keychain, host
subscriptions, provider calls, GitHub, or network access.

There is one production dependency cycle:

```text
graph-store
  -> context-inputs
  -> exploration-canonical
  -> canonical-source-reader
  -> graph-store
```

`graph-store.mjs` also coordinates Graph, Exploration, canonical selection,
Context lifecycle, and their shared transaction. Moving those files first
would preserve the cycle under better-looking paths and make behavioral changes
harder to review.

## Required composition seam

The cycle-removal batch keeps public constructors and the shared transaction.
It gives `CanonicalSourceReader` and `ExplorationCanonical` a narrow,
internally branded Graph capability and creates one fixed service bundle from a
local composition seam. The capability is not a public duck-typed extension
point. Existing nominal and WeakMap proofs must continue to be created and
asserted by the same instances.

The later application split must use transaction-scoped Graph operations
rather than nesting public `mutate()` calls or exposing a SQLite handle. Graph,
Exploration metadata, canonical proof, and Context proof that commit atomically
today continue to commit atomically.

## Migration order

1. Freeze this baseline and make structural drift visible.
2. Move the disconnected UX prototype, host probes, and Postgres spike as
   separate research batches.
3. Enforce target directions and reject every new or enlarged production SCC.
4. Remove the current Graph/Context/Canonical SCC without moving source.
5. Split Graph, Exploration, Context, Query, and Judge application services
   around the preserved transaction seam.
6. Move pure domain contracts, application services, adapters, and the local
   app by capability. Refine these Tickets only after the seam is proven.
7. Separate live verification and Phase 0 replay, then group deterministic
   tests and current documentation by capability.
8. Review and narrow the public API as its own product change.

No durable compatibility shims are required for old internal paths because the
package exports only `.`. Each move updates repository imports, current docs,
active Tickets, package commands, standalone copying, and Room alignment in the
same atomic batch. Historical Ticket, Evidence, and Outcome documents remain
unchanged.

## Relocation manifest

Before the first move, create a versioned JSON manifest under `docs/history/`.
Every entry contains:

```json
{
  "old_path": "semantic-runtime/prototype/serve.mjs",
  "new_path": "semantic-runtime/research/ux/project-exploration/serve.mjs",
  "old_blob": "<40 lowercase hex Git blob>",
  "migration_commit": "<40 lowercase hex commit>",
  "category": "ux-research"
}
```

Original measurement JSON moves byte-for-byte. New report metadata is adjacent
and records the command, working directory, sanitized input summary, source
revision, runtime/provider versions, tested and untested boundaries, and the
original SHA-256. Secrets and raw private trajectories are never recorded.

Every migration batch runs focused tests, `npm run verify`,
`npm run verify:standalone`, root `npm run verify:artifact`, `git diff --check`,
VibeHub project validation, and semantic-runtime Room alignment. A batch that
changes public exports, command names, wire/schema versions, database contents,
digests, receipts, error codes, authorization order, or transaction atomicity
is not a directory-only migration and must be replanned.
