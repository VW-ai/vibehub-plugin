# Semantic checkpoint and reusable PR slice

Date: 2026-07-22

Status: implemented, pending stacked technical review.

## User experience

Durable knowledge is committed at a stable semantic boundary without asking
the user to manage knowledge files:

```text
successful knowledge work
  → read-only checkpoint receipt
  → unchanged-receipt CAS
  → path-isolated semantic commit
  → PR review brief
```

The user still sees normal branches, commits, diffs and pull requests. Their
staged code, unstaged files and unrelated work are unchanged. No commit appears
for a no-op. The default branch, `main`, `master`, and any caller-supplied
repository-protected branch are blocked. A detached HEAD, conflict, invalid semantic
tree, changed HEAD, changed digest or changed path set produces a typed blocker
and no commit.

## Checkpoint boundary

`prepareSemanticCheckpoint` validates the current semantic tree and records:

- named branch;
- exact HEAD commit;
- derived semantic digest;
- exact changed semantic paths.

`commitSemanticCheckpoint` recomputes those facts and requires byte-for-byte
receipt equality. It builds a candidate tree through a temporary Git index
seeded from the receipt HEAD, validates the candidate semantic digest, then
advances the branch ref with an old-SHA compare-and-swap. The real index is
updated only for committed semantic paths. This prevents unrelated staged
content from entering the commit.

The commit message carries actor, optional task, request, semantic digest and
checkpoint time trailers. Commit identity remains the user's configured Git
identity.

## Skill boundary

`vibehub-pr` owns collaboration procedure:

- checkpoint at a stable boundary;
- inspect branch/default/remote/PR facts;
- classify semantic versus code changes;
- explain conflict classes;
- run deterministic validators;
- create or update a requested PR with a semantic review brief.

It never grants merge, squash, force-push or branch-deletion authority. Other
domain skills may delegate only their PR phase to it. Domain judgment remains
with the caller.

The entry skills and references do not know the persistence protocol.
`skills/scripts/vh-checkpoint.mjs` is the mechanical adapter, and
`_stdlib/operations.md` defines the stable semantic checkpoint contract. A
future runtime change therefore updates the adapter/core, not every skill.

## Deliberate exclusions

- no large-knowledge-base optimization;
- no protocol schema upgrade;
- no automatic merge or branch deletion;
- no model-tier/subagent routing;
- no checkpoint for read-only queries, failed writes, filler records, or
  operational distillation state.

## Executable evidence

- `packages/core/test/semantic-checkpoint.test.ts`
- `packages/cli/test/kb-cli.test.ts`
- `packages/cli/test/skill-package.test.ts`
- `skills/scripts/validate-artifact.mjs`
