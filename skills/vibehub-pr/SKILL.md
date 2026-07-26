---
name: vibehub-pr
description: Prepare, review, create, or update a VibeHub-aware pull request. Use when a branch containing code and/or durable knowledge is ready for technical review, when concurrent spec edits need semantic conflict handling, when another workflow skill delegates its PR phase, or when a semantic checkpoint should be committed without capturing unrelated user changes.
---

# VibeHub PR

Turn a completed branch into a reviewable proposal while keeping semantic
decisions explicit and merge authority human-governed.

## Prerequisites

1. Read `../_stdlib/operations.md`, `../_stdlib/quality-gates.md`, and
   `../_stdlib/reporting.md`.
2. Read `references/review-procedure.md` before preparing, creating, updating,
   rebasing, or resolving a PR.
3. Treat an invocation from another skill as a delegated PR phase. Return its
   result to the calling workflow instead of repeating domain analysis.

## Workflow

1. Inspect the current branch, HEAD, worktree/index, default branch, remote
   state, existing PR, and branch diff. Never infer clean, current, or
   mergeable from conversation memory.
2. At a stable semantic boundary, run the packaged checkpoint adapter in two
   phases:

   ```text
   node ../scripts/vh-checkpoint.mjs prepare --repo <root> [--protect <branch>]
   node ../scripts/vh-checkpoint.mjs commit --repo <root> --actor <id> --task <id> --request <id> --input <receipt.json> [--protect <branch>]
   ```

   Commit only an unchanged prepare receipt. A no-op is silent. On a stale
   receipt, protected branch, detached HEAD, conflict, or failed validation,
   stop without manufacturing a commit and report the blocker.
3. Compare against the fetched default branch. Classify code changes,
   semantic changes, tests, migrations, deferred work, and reviewer decisions
   separately. Resolve no semantic conflict by choosing whichever side is
   newer.
4. Run repository-required build, typecheck, tests, validators, and focused
   semantic checks. Record exact commands and outcomes; do not call a partial
   suite “all tests.”
5. Create or update a PR only when the user requested that external action.
   Write the title and body from observed facts, include a bounded semantic
   review brief, and disclose stacked-base dependencies.
6. Report with the five-section protocol. Never merge, squash, force-push,
   delete a branch, dismiss review, or bypass required checks without separate
   explicit authorization.

Other skills may nest this procedure by delegating only their PR phase to
`$vibehub-pr`; the stable workflow contract is the checkpoint receipt and
review brief, not any persistence mechanism.
