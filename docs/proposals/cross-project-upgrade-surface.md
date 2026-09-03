# Proposal: explicit cross-project upgrade surface

Ticket: `ticket-decide-cross-project-upgrade-surface` · 2026-09-02

## Decision

Ship one dependency-free, npm-layout `vibehub-upgrade.tgz` as an asset of each
existing GitHub Release. It contains only one `vibehub-upgrade` bin plus the
same `vh.mjs`, contracts, and migration reference as that release's Skill
artifact. It is a one-shot outside-project entry, not an npm-registry package,
general VibeHub CLI, or package installed on `PATH`.

The supported release upgrade is a release-paired two-command recipe. The user
chooses one immutable `<release-tag>` and uses that exact tag for both the Skill
source and the data upgrader:

```bash
npx skills add https://github.com/VW-ai/vibehub-plugin/tree/<release-tag> -a <host> -s '*' -y
npx --yes https://github.com/VW-ai/vibehub-plugin/releases/download/<release-tag>/vibehub-upgrade.tgz \
  --root <bounded-root> [--root <another-root>]
```

The user must provide at least one root. There is no implicit home-directory or
whole-machine scan.

`<host>` is `codex`, `claude-code`, or another skills.sh host target. The direct
tagged repository URL is intentionally used instead of `npx skills update`:
the latter may resolve the default branch tip, which can be newer than the
latest GitHub Release. A floating `releases/latest` upgrade URL is likewise not
part of this contract. First install and later release update use the same
tag-paired recipe; re-adding the tagged Skills is the skills.sh-owned code step,
and the second command is VibeHub's explicit checked-in-data step. VibeHub does
not hook or wrap the third-party installer. The upgrader prints the embedded
tag and commit before discovery, and refuses an asset whose package version,
embedded release tag, engine version, or migration-registry version disagree.
It is a no-op when every discovered project is already current.

## Invocation shapes compared

| Concern | One-shot GitHub Release package — selected | Installed `vibehub-core` entry — rejected |
| --- | --- | --- |
| First install | One immutable release tag is repeated in the tagged Skill install and the data command; no installed-path lookup | Default skills.sh installation is project-local, so the entry exists only under whichever `./.agents` or `./.claude` directory received it |
| Subsequent update | Re-add the chosen tagged release, then run its identically tagged data command; neither half floats to a different source revision | The user must remember which project-local copy was updated and launch from or point into that project |
| Cross-host | Identical on Codex, Claude Code, and any shell with Node/npm | Host and install scope change the path; global `-g` would be a new mandatory installation rule for existing users |
| Version identity | Both commands name one immutable release tag. The dedicated tarball contains and self-checks that tag's coordinator, engine, contracts, and migration reference, then prints its tag and commit. `skills update` plus `releases/latest` is explicitly unsupported because those sources can resolve different revisions | Local copies can legitimately differ by project and host; choosing one as machine-wide authority is ambiguous |
| Network/cache | GitHub fetch plus npm's disposable cache; failure before execution writes no project | No network after update, but location discovery becomes a new implicit machine scan or manual parameter |
| Permission scope | npm cache plus repeated explicit roots and registered worktrees of repositories found there | Project data authority is the same, but finding the executable adds unrelated project-directory authority |
| Failure recovery | One process holds fixed release bytes; its report includes the immutable versioned asset URL for exact retry | Stable only after the user identifies the exact local copy; another local installation may implement a different format |
| Release boundary | One extra allowlisted asset on the existing GitHub Release, with no npm publication, registry secret, global install, or fetched development repo | No asset, but making a project-local Skill copy the machine-wide entry creates an undocumented install-location contract |
| Smallest complete change | Add one coordinator, a minimal package manifest, deterministic tarball/checksum build, tests, and docs | Add a global-install requirement or an executable-locator protocol, migration from existing local installs, ambiguity checks, tests, and docs |

npm documents the two mechanics used by the selected option: npx can fetch a
remote tarball package and infers its command from one unambiguous `bin`.
Git-source package specs are deliberately not used: the development repository
contains unrelated source and its own `.vibehub`, whereas the release tarball
has a strict allowlist. See
[npx](https://docs.npmjs.com/cli/v11/commands/npx/) and
[package specs](https://docs.npmjs.com/cli/v10/using-npm/package-spec/).

The one-shot release entry is therefore the smallest shape that gives existing
project-local installers one truthful command without inventing a global Skill
location or reopening npm-registry distribution.

## Exact replacement architecture boundary

After this Ticket closes successfully, replace the complete body of
`skills/vibehub-setup/references/architecture-boundary.md` with exactly:

> # VibeHub Architecture Boundary
>
> VibeHub is Skills plus checked-in Git-native YAML documents. The product
> ships no general-purpose or globally installed CLI, MCP server, database,
> daemon, hook cadence, native runtime, local web service, background capture,
> or hidden state. Git and GitHub own history, concurrency, rollback, and
> review. Deterministic validation and migration live in bundled
> dependency-free scripts; semantic judgment lives in Skills.
>
> One narrow exception is the explicitly invoked `vibehub-upgrade` one-shot
> entry shipped as a dependency-free npm-layout tarball on the same GitHub
> Release as the Skill artifact. It may run outside one project and
> may only: accept bounded discovery roots; identify Git repositories beneath
> those roots; enumerate their registered existing worktrees; invoke the
> shared migration engine and migration reference separately for each safe
> worktree; create one local reviewable migration commit per successfully
> migrated worktree; and report every no-op, success, unsupported state, or
> pending reason. Discovering one repository authorizes traversal only to the
> worktrees registered by that same repository, including a registered sibling
> whose path lies outside the discovery root; it never authorizes another
> filesystem scan.
>
> The upgrade entry owns no migration semantics and no durable project index.
> No Skill depends on it for ordinary project work. Nothing invokes it in the
> background, at install time, or from a hook, daemon, service, scheduled job,
> or UI. It must not add compatibility shims, telemetry, network reporting,
> authoritative state outside Git, automatic stash or reset behavior, or any
> push operation. All remaining semantic migration stays in a later Agent
> session in the affected worktree. Anything beyond this boundary is a defect,
> not a feature.

### Mechanical assertions for that boundary

Implementation is not complete unless tests prove all of the following:

1. The release workflow builds the one-shot package from an explicit allowlist,
   gives it exactly one `bin`, embeds the exact release's shared engine,
   contracts, and migration reference, emits a checksum and immutable
   tag-addressed asset URL (a convenience `latest` alias may exist but is never
   documented as an upgrade contract), and adds no registry publish, global installer, install lifecycle
   script, dependency, daemon, hook, scheduler, service, database, or telemetry
   client.
2. No Skill, project instruction, UI launcher, package lifecycle, or workflow
   invokes the entry; missing explicit `--root` is rejected before discovery.
3. Discovery does not follow symlinks, writes no index, stays beneath each
   realpath-normalized root until a Git repository is identified, and expands
   outside it only through that repository's `git worktree list --porcelain`
   records. Repositories are deduplicated by their common Git directory.
4. The coordinator calls its packaged sibling `vh.mjs` mechanical operation
   and reads the packaged sibling migration reference. Tests fail if it contains a second action
   table, schema rewrite, placement rule, or semantic prompt.
5. A fake-Git behavioral suite records every subprocess and rejects branch
   enumeration, stash, reset, checkout, clean, `git commit`, push, fetch, pull,
   or remote mutation. The only commit path is explicit plumbing through a
   temporary index, unsigned `commit-tree`, and one compare-and-swap
   `update-ref`. Hostile configured hooks and signing helpers write sentinel
   files if invoked. The terminal ref CAS must run with `-c
   core.hooksPath=<new-controlled-empty-dir>`; tests include a hostile
   `reference-transaction` hook and prove that neither hooks nor signing
   helpers are ever started.
6. Multi-worktree fixtures prove one independently validated commit per safe
   worktree, zero commits for every other state, no branch outside a registered
   worktree, and an exhaustive report whose paths, old/new HEADs, commit IDs,
   formats, and reasons match Git afterward.
7. Failure injection at every preview, worktree-write, real-index-update, and
   pre-ref/CAS boundary proves that a non-success result has the original HEAD,
   index, status, and user-file bytes. The CAS ref update is the terminal
   success boundary: no later verification may turn the migrated worktree into
   a non-success. A result is not reported as safely pending unless restoration
   before that boundary is proven.
8. Source inspection and subprocess tests prove there is no push, network,
   telemetry, background, or persistent-index path; repeat execution is
   idempotent.

## Deterministic safety state machine

The coordinator processes one repository at a time and one registered
worktree at a time. It may parallelize read-only discovery, but writes and
commits are serialized per repository.

### 1. Bounded discovery

- Require one or more explicit `--root` values. Resolve each to an existing,
  readable directory without following directory symlinks.
- Search only below those roots for a `.vibehub/` directory; never descend
  into `.git/` or `.vibehub/` itself. A candidate must resolve through
  `git rev-parse` to a working tree and common Git directory.
- Deduplicate candidates by real common-Git-directory identity. For each one,
  `git worktree list --porcelain` is the only fan-out authority. Every
  registered record is reported, including missing, prunable, non-VibeHub, and
  outside-root sibling paths; unregistered branches are never enumerated or
  changed.
- Root authorization includes only the discovered repository and its own
  registered worktree records. It does not permit scanning around an
  outside-root sibling.

### 2. Read-only preflight for one worktree

Capture a baseline containing the canonical worktree path, common Git
directory, named branch ref, 40-hex HEAD, complete porcelain status bytes,
index checksum, and checksums plus existence/type for every path a migration
may declare.

Automatic migration is eligible only when all are true:

- the worktree record is registered, not prunable, and its directory and Git
  administrative files are reachable and writable;
- `.vibehub/` is present in that worktree;
- it is attached to `refs/heads/...`, HEAD exists, and the branch is neither
  detached nor unborn;
- none of `MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`,
  `REVERT_HEAD`, or `BISECT_LOG` exists through `git rev-parse --git-path`;
- `git status --porcelain=v1 -z --untracked-files=all` is byte-empty, covering
  staged, unstaged, and untracked changes;
- `project compatibility` reports a recognized older format and the migration
  reference contains a complete acyclic chain to the current format;
- every step needed to reach a writable current structure has executable
  mechanical actions. A semantic-first transition is pending, not eligible.

No preflight command may alter files, index entries, refs, configuration, or
hooks.

### 3. Same-HEAD deterministic preview

- Run the shared engine's preview against an isolated disposable copy of the
  exact baseline bytes. The copy is derived state, never authority, and is
  deleted after the result is recorded in memory.
- The preview must finish `CURRENT`, pass `project validate`, report only paths
  declared by the traversed migration entries, and leave every semantic step
  represented by its declared durable pending marker.
- Record the preview's ordered migration IDs, declared path set, target format,
  resulting file digests, pending refs, and original HEAD. Run it twice; the
  two results must be byte-identical.
- Re-read HEAD and the full porcelain status before touching the real
  worktree. Any difference from baseline is pending `concurrent-change` with
  no write.

### 4. Prove, materialize, and atomically commit

- Treat the second identical disposable engine run as the result-byte source;
  do not ask a second implementation of migration semantics to rewrite the
  real worktree. Require its copy to report `CURRENT`, pass `project validate`,
  contain explicit pending markers, and change only declared paths.
- Recheck the real worktree's HEAD, branch, complete status, index checksum,
  and every declared-path preimage immediately before materialization. A
  mismatch is pending with no write.
- Build the exact future tree and commit with Git plumbing before changing any
  user-visible state: use a temporary `GIT_INDEX_FILE` seeded from baseline
  HEAD, hash the preview result blobs, update only declared entries in that
  temporary index, write the tree, and create an unsigned commit with
  `commit-tree` and a stable VibeHub migration subject. Do not invoke `git
  commit`, hooks, signing helpers, or another ref.
- Inspect that commit object before ref movement: its sole parent is baseline
  HEAD, its tree differs on exactly the preview paths, and every blob digest
  equals preview. A failure here has not touched the real worktree, index, or
  refs; unreachable temporary Git objects are not project state and may be
  pruned by ordinary Git maintenance.
- Retain exact original bytes, file types, and real-index entries for the
  declared paths. Atomically install the preview bytes in the worktree and the
  already-proven entries in the real index. Immediately before CAS, recheck the
  named branch and baseline HEAD; require every declared path's bytes and type
  to equal preview; require `git write-tree` from the real index to equal the
  prepared tree; and require porcelain status to be exactly the expected
  staged-only declared path set, with no unstaged or undeclared change. Any
  mismatch is a pre-CAS failure and must restore the retained preimage.
- Create a new empty temporary hooks directory and make `git -c
  core.hooksPath=<that-empty-dir> update-ref <named-branch> <prepared-commit>
  <baseline-head>` the single compare-and-swap and terminal success boundary.
  Never use the repository's configured hooks path. If any earlier write,
  index update, recheck, or the CAS itself fails, the branch has not moved;
  restore the retained worktree bytes and exact real-index entries, then prove
  the baseline. If CAS succeeds, the prepared commit, index, and worktree are
  already the same tree and the result is `migrated`; a later output/read error
  cannot relabel it as pending or attempt to move the branch back.
- Git's ref-update path can normally invoke a `reference-transaction` hook, so
  the controlled empty `core.hooksPath` override is mandatory, not optional.
  The path requests no signature, changes only the named worktree branch, and
  never pushes.

### 5. Outcomes and failure rules

- `current`: valid current structure; no write and no commit. Existing semantic
  pending refs are reported for the next in-worktree Agent session.
- `unaffected`: registered worktree has no VibeHub data; no write.
- `unsupported`: malformed marker/data or a newer project format; no write.
- `pending`: missing/prunable/unwritable, detached/unborn, Git operation in
  progress, dirty status, incomplete/unknown/semantic-first chain,
  nondeterministic or out-of-scope preview, validation failure, concurrent
  change, materialization mismatch, or pre-ref/CAS failure. The exact stable reason and
  diagnostic are reported.
- `migrated`: and only this state has one new local commit and its 40-hex ID.

Before materialization, every non-success leaves user-visible state untouched.
After materialization begins but before the terminal CAS succeeds, retain the
exact clean preimage and original index entries for declared paths. On any
software-visible failure, restore those bytes and index entries without stash,
reset, checkout, clean, `git commit`, hooks, signing, or branch movement; then
prove baseline HEAD, index checksum, porcelain status, and file digests match.
If restoration cannot be proven, abort the entire command with
`recovery_failed`; do not misreport that worktree as safely pending and do not
continue to another write. After a successful CAS there is no failing
verification state: the preverified commit is already authoritative local Git
history, and report output is best-effort reconstruction of that success.
Failure-injection tests must cover every edge on the non-success side of CAS.

The final report is exhaustive and disposable: it is printed in human-readable
form plus a JSON envelope and is not saved as project authority. Re-running the
same command after complete success reports `current`; rerunning after a
restored pending failure starts from the same baseline.
