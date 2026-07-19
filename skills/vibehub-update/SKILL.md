---
name: vibehub-update
description: Incrementally update VibeHub's repository mapping after code changes. Use when commits modified, added, renamed, or deleted files; when anchor hashes drift; when asking which features/specs are affected; or when an existing map needs a scoped refresh without rerunning a generic cold start.
---

# VibeHub Update

Turn a deterministic Git delta into a bounded incremental distillation run. Do
not mutate human-authored truth from code drift.

## Prerequisites

1. Read `../_stdlib/orchestration.md`, `../_stdlib/db-operations.md`,
   `../_stdlib/quality-gates.md`, and `../_stdlib/reporting.md`.
2. Read `../_stdlib/lifecycle.md` when deleted/changed anchors may make a
   canonical spec stale.
3. Read `../_stdlib/provenance.md` before writing incremental candidates.
4. Reuse `../contracts/distillation-scope.schema.json` and
   `../contracts/distillation-result.schema.json`.

## Workflow

1. Call `distill.baseline.get` to resolve the active version, base commit and
   anchors, then resolve the target commit. If baseline reports unsupported,
   stop and require cold/refresh; never guess a commit. Use deterministic
   Git name-status with rename detection plus current file hashes. Classify
   added, modified, renamed and deleted paths; keep old/new rename pairs.
   `distill.baseline.get` supplies active/version mapping anchors. It does not
   verify governed canonical spec anchors; use `kb.anchors` for those.
2. Query `kb.anchors` in reverse for every old and new path. Derive affected
   features/specs from actual anchors and parent/relations, not directory guesses.
3. Start `distill.run.start` with `mode: incremental`, target commit and stable
   skill/config hashes. Generate the whole denominator with
   `node ../scripts/inventory.mjs --run-id <run> --base-commit <baseline> --target-commit <target>`.
   Its stdout is directly consumable by `distill.inventory.put` and contains
   exactly `{runId,rows}`. If commit diagnostics are needed, add
   `--diagnostics`; diagnostics are written only to stderr.
   The helper reads both committed trees, not the working directory. Without an
   explicit target it accepts only a clean worktree and binds the result to
   `HEAD`. Added/modified/renamed paths are included when analyzable;
   unchanged/deleted paths remain explicit excluded rows with hashes/reasons.
   The exact reasons are `incremental_unchanged` and `incremental_deleted`.
   Semantic uncertainty in an analyzable changed path remains included and is
   carried explicitly unresolved; it is never converted into a mechanical
   exclusion.
   Put and seal it; core rejects any missing, invented, mistyped or wrong-hash
   row before work starts. `distill.inventory.diff` compares only
   a run's persisted rows; it is not a substitute for the baseline Git delta.
4. Plan leaf scopes for every included affected/new/renamed path plus the minimum related
   boundary files needed for interpretation. Persist rename/delete context in
   evidence. Never fall back to a whole-repo cold rerun.
5. Claim scopes and write `upsert` candidates for the replacement semantics.
   Sealed modified/deleted paths and rename `previousPath` values mechanically
   prune every old anchor on those paths, so correctness never depends on an
   agent remembering removal candidates. Use an explicit `remove` only for an
   exact baseline feature/anchor target; typos are rejected. Removing a feature
   removes its anchors but is blocked while any child feature survives.
   Finalization carries only unaffected active projections forward; inspect
   `distill.version.get` for the named version and `distill.version.diff` for
   its changes. Those are mapping-version anchors/content, not canonical
   current-revision truth. Reconcile,
   selectively correct, validate and finalize exactly as `vibehub-distill`.
6. Send deleted anchors, uncertain semantic drift, conflicts and human-authored
   active specs to `vibehub-review`. A code deletion is evidence for review, not
   permission to auto-stale or deprecate canonical truth.
7. Activate only the reviewed finalized mapping with expected-current CAS.
   Report carry-over and unresolved paths with the expanded five-section
   block from the reporting contract; incremental update runs are expanded
   like distillation.

Use `node ../scripts/vh-kb.mjs ...` and
`node ../scripts/vh-distill.mjs ...`; inspect every dispatcher envelope.
