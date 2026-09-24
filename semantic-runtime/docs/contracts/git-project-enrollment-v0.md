# Local Git project enrollment

`GitProjectRegistry` registers explicitly selected folders inside an already
authenticated Project. It uses the Git CLI, the accepted `DomainStore` and no
additional dependency. It is a local module: App project creation, pairing,
activation, folder-picker UI and live collection are separate integrations.

```js
import { GitProjectRegistry } from '@vibehub/semantic-runtime';
const registry = new GitProjectRegistry({ store, authority });
const inspection = registry.inspect(context, selectedFolder);
// If inspection.status is not_git, the UI can offer a separate explicit action:
// registry.initialize(context, selectedFolder);
const previous = registry.get(context);
const result = registry.enroll(context, {
  folder: selectedFolder, expectedVersion: previous?.version ?? null,
});
```

The store must register namespace `git-enrollment`. The authority issues opaque
local contexts scoped to exactly one tenant/Project. Inspection/get/catalog
require `project:inspect` and `store:read`. Enrollment, refresh and move require
`project:enroll`, `store:read` and `store:write`. Initialization requires
`project:initialize` plus both store actions; permission is checked before
filesystem discovery. No API accepts a caller-supplied Project override.

## Inspection and initialization

`inspect(context, folder)` returns `not_git`, `bare` (unsupported for enrollment),
or a version-1 Git observation. Symlink/nested selection normalizes to its real
worktree root and common Git directory. Git's own worktree inventory includes
registered external sibling worktrees. Branch refs are separate from worktrees:
a branch need not have a checkout. Each worktree records HEAD, branch,
detached/unborn, locked/prunable and available/unavailable state. Inspection
reads Git metadata, not source contents or arbitrary home directories.

Fixed argv subprocesses use no shell or remote operation. Inherited `GIT_DIR`,
worktree/config overrides and global/system Git configuration are excluded;
hooks, fsmonitor and transport protocols are disabled. Individual Git commands
have a five-second deadline and 2 MiB output ceiling. Observations allow at most
128 worktrees and 256 local branches. Paths containing newline/NUL are refused;
spaces, including trailing spaces, are preserved. Errors expose bounded codes,
not Git stderr or arbitrary metadata contents.

`initialize(context, folder)` is explicit and separate from enrollment. It
rechecks ancestry, refuses an existing/nested Git or corrupt Git location,
preserves existing files, and uses an empty template. It creates an unborn
`main` with no hooks, commit, remote, push or activation. A Git initialization
and a later database transaction are not one atomic operation: if enrollment
fails, the initialized repository remains and may be enrolled again.

## Persistence, identity and history

`get` returns `{ version, value }` or null. `enroll`,
`refresh(context, { checkout_id, expectedVersion })` and
`associateMove(context, { checkout_id, prior_path, folder, expectedVersion })`
return `{ version, catalog, checkout_id, reused }`.

One versioned `git-enrollment/catalog` row contains opaque repository, checkout,
worktree and ref-incarnation IDs. The same observed common directory selected
through its main or linked worktree reuses the checkout; unchanged rescan and
restart preserve IDs and create no extra version/source row. An explicit second
repository adds a separate membership. Matching remotes, branch names or OIDs
never combine independent clones. Separate authenticated Projects have separate
catalogs even when selecting the same local directory.

Discovery runs outside SQLite. A fresh observation must match immediately before
the synchronous transaction, and caller expected-version CAS is checked inside
it, including unchanged rescans. Each changed version atomically appends an
immutable `enrollment-change` source with ID `catalog-v<version>`, containing
its complete catalog and Git observation. For example, callers with store read
permission may retrieve `store.getSource(context, 'git-enrollment', 'catalog-v1')`.
Historical branch/head/path/ID bindings remain readable after later updates.
Stale CAS or source-write failure rolls back the record and source together.
External Git writers are not locked by SQLite; the observation check narrows the
race window but cannot certify an atomic snapshot across Git and the database.

Observed removed worktrees and deleted refs retain tombstones. Observed
unavailability records a gap; return allocates a new worktree identity. Ref
rename is old-ref deletion plus a new incarnation, not inferred continuity.
An unchanged worktree switching branches keeps its worktree ID. Reappearing
branch names after an observed deletion get a new ref ID.

A path move is never silently repaired. `associateMove` requires the old selected
path, checkout ID, expected catalog version and a current matching common-dir
physical identity; it records the actor and prior/current references as
`operator_declared_move`. That declaration can preserve IDs for the observed
moved instance, but is not independently proven Git history. Cross-filesystem
copies with changed physical identity are enrolled as a new instance.

All operational mappings carry `assurance: observed` and
`historical_continuity: uncertified_between_observations`. Equal path, stat,
branch name or OID is not proof that a branch was never deleted and recreated
between scans. The system explicitly retains that limitation without blocking
ordinary unchanged use. It does not rewrite historical events or exploration
bases to invent continuity.

## Core integration and bounds

`identityCatalog(context)` returns a validated current core identity catalog for
active repositories and available worktrees, with explicit Project memberships
and one local installation. It creates no Sessions or execution records.
Historical identity catalogs already held by core branch-scope state stay
immutable; consumers must create deliberate successor projections, retaining
prior referenced identities. This adapter does not mutate a Working Graph,
adopt exploration context, merge Git branches or activate a plugin.

The persisted catalog is version 1, with at most 64 checkouts, 256 retained
worktrees, 512 refs and 512 gap/move history entries per checkout; DomainStore's
1 MiB/16-level/50,000-node JSON limits also apply to each record/source. Reaching
a bound fails the update without truncating history. Catalog migration and
archival beyond those bounds require a later explicit versioned transition.
If the selected feature worktree disappears, refresh can use an already enrolled
surviving worktree only after rechecking its common/admin physical identity; it
retains the removed origin and records the changed selection. If none remains,
the checkout is unavailable. The module does not search a user's disk for a
replacement. A moved checkout still requires an explicit declaration.

`node --test test/sources/git-projects.test.mjs` exercises real temporary repositories
and SQLite, including restart, clone isolation, observed and unobserved ref
recreation, worktree disappearance, explicit moves, symlinks/spaces, auth
failures, CAS races, immutable snapshots and initialization preservation.
No private repository contents, credentials, model calls or remotes are used.
