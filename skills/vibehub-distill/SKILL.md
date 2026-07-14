---
name: vibehub-distill
description: Cold-start or explicitly refresh a repository's VibeHub feature map and evidence-backed draft knowledge. Use for repository onboarding, resumable repository-to-feature/spec distillation, selective recovery of unresolved scopes, finalization and reviewed CAS activation; not for routine per-task scans.
---

# VibeHub Distill

Build an immutable candidate version from a sealed repository inventory. Skills
interpret semantics; core owns leases, accounting, validation and transactions.

## Prerequisites

1. Read `../_stdlib/ontology.md`, `../_stdlib/provenance.md`,
   `../_stdlib/orchestration.md`, and `../_stdlib/db-operations.md`.
2. Read `../_stdlib/quality-gates.md` before reconcile/retry/validate.
3. Read `../_stdlib/relations.md` only when extracting or reconciling relations.
4. Read `../_stdlib/lifecycle.md` before review/carry-over/activation.
5. Use `../contracts/distillation-scope.schema.json` for worker results and
   `../contracts/distillation-result.schema.json` for the bounded run report.
6. Read `references/feature-hypotheses.md` before orientation produces feature
   candidates. Read `references/cross-scope-reconciliation.md` only at the
   reconcile/review stages.

## Protocol

1. **Preflight.** Resolve a real 40-character commit, project guidance, current
   active mapping and existing run. Resume DB state first:
   `distill.run.status` / `distill.run.resume`. Never recover from chat or temp
   artifacts.
2. **Start.** Call `distill.run.start` with mode, base commit, skill/config
   hashes and stable task/request IDs.
3. **Inventory.** Generate deterministic rows:

   ```text
   node ../scripts/inventory.mjs --repo <root> --run-id <run> > inventory.json
   node ../scripts/vh-distill.mjs inventory.put --repo <root> --actor <id> --task <task> --request <id> --input inventory.json
   ```

   The helper's stdout is exactly the `distill.inventory.put` input
   `{ "runId": "...", "rows": [...] }`. Add `--diagnostics` only when commit
   diagnostics are needed; it writes those diagnostics to stderr, never into
   the JSON operation input.

   Inspect exclusions, then `distill.inventory.seal`. The sealed inventory is
   the completeness denominator. Mechanical exclusion uses only the closed
   taxonomy in quality gates. Analyzable source uncertainty remains included:
   keep it explicitly unresolved, never mechanically excluded.
4. **Orient.** Apply the feature-hypothesis method while reading manifests, authoritative docs, entry points, module/package
   boundaries and representative tests. Produce bounded, source-anchored
   orientation; do not infer the map from directory names alone. Configuration,
   bootstrap, migration, and support files may remain explicitly unresolved;
   use no fake feature or arbitrary anchor to make coverage look complete.
5. **Plan scopes.** Create analysis scopes with no files and disjoint leaf
   scopes whose union is exactly included inventory. Call
   `distill.scopes.plan`; do not impose ShadowRepo's historical numeric sizes.
6. **Extract.** Claim durable leases. A distillation-scope artifact is not an
   operation input: submit each evidence-backed feature/spec/anchor/relation
   candidate through `distill.candidates.put`, then translate its partition to
   one `distill.scopes.complete` or `.fail`. Independent workers read their files. Honest
   context/WHAT is valid; label inferred WHY and never fabricate rationale.
7. **Reconcile.** Load the cross-scope reconciliation method, use one writer and call `distill.reconcile`. Core recomputes
   coverage/lost files/endpoints/collisions. Do not trust worker self-reported
   totals.
8. **Correct selectively.** For persisted hard/retryable findings, call
   `distill.scopes.correct` or `.retry` only on implicated scopes, reclaim them,
   supersede corrected candidate revisions, then reconcile again. Retry budget
   is contextual; no fixed round count.
9. **Validate/finalize.** Call `distill.validate`; hard findings block. Review
   semantic findings and experimental metrics without turning metrics into
   gates. Call `distill.finalize` to freeze projections/checksums.
10. **Review/carry-over.** Read the finalized content with
    `distill.candidates.list/get` selected by version and inspect
    `distill.version.get/diff`; then invoke `vibehub-review`. Activation never
    promotes candidates or overwrites canonical human-authored specs.
11. **Activate.** After explicit review, call `distill.activate` with the shown
    finalized version and `expectedCurrentVersion`. On CAS conflict, re-read
    status; never force. Rollback uses the same guarded operation.
12. Read `../_stdlib/reporting.md`, validate the result artifact and report
    unresolved/excluded/review items honestly.

All operations use `node ../scripts/vh-distill.mjs <suffix> ...`. Never use SQL,
filesystem checkpoints, additive whole-manifest writes, or automatic canonical
promotion.
