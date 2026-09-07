---
name: vibehub-migrate
description: Upgrade a project's checked-in .vibehub data from an older VibeHub format to the current one by explicit agent-driven restructure. Use when validation names a legacy structure (such as a populated flat .vibehub/context/) or the user explicitly asks to upgrade after pulling a new plugin version.
---

# VibeHub Migrate

> If `../vibehub-core/scripts/vh.mjs` is missing, the install was partial. Run
> `npx skills add VW-ai/vibehub-plugin -s vibehub-core` (or rerun it
> for every Skill) before continuing; every VibeHub Skill needs that folder.

Upgrading is a restructure, not a compatibility layer. Current project and
document versions live in `../vibehub-core/contracts/versions.json`; the matching
mechanical actions and semantic authoring guidance live once in
`references/migrations.json`. The engine performs only the declared mechanical
actions. This Skill supplies only the judgment named by declared semantic steps.

## Workflow

1. Run the read-only compatibility preflight and inspect the `.vibehub/` tree:

   ```text
   node ../vibehub-core/scripts/vh.mjs project compatibility --repo <root>
   ```

   `CURRENT` means the structure is writable, but does not prove that deferred
   semantic work is complete; continue to the engine check below so a later
   session sees any durable pending markers. For `MIGRATION_REQUIRED`, find the
   complete path in `references/migrations.json`. `UNSUPPORTED_NEWER` needs a
   newer plugin, never a guessed downgrade.
2. Read the applicable entries' `mechanical.declared_paths` and
   `semantic.steps`. Preview that exact checked-in scope and cross the explicit
   migration boundary before writing; installing or updating Skills,
   validation, query, and UI launch never grant it.
3. Run the mechanical half through the engine for this exact worktree:

   ```text
   node ../vibehub-core/scripts/vh.mjs project migrate-mechanical --repo <root>
   ```

   Review `changed_paths`, `applied_migrations`, and any
   `pending_semantic_steps`. A fresh invocation on a `CURRENT` project returns
   `current_with_semantic_pending` plus the same complete guidance whenever
   durable pending refs remain; only `current` with no pending steps is a
   no-work result. The operation neither discovers other projects or
   worktrees nor commits or pushes; a separate upgrade coordinator may invoke
   it once per safe registered worktree. When the current session follows that
   explicit upgrade, read its report or exact Git history and tell the user the
   40-hex local migration commit for this worktree before doing semantic work;
   do not infer a commit from branch position or claim that one commit updated
   sibling worktrees.
4. Spend Agent reasoning only on each returned semantic step, following its
   `purpose`, `derives_from`, `good_value`, `forbidden_shortcuts`, and
   `instructions`. Placement judgment follows
   `../vibehub-ingest/references/knowledge-governance.json`; use
   `$vibehub-distill` when the declared guidance calls for a Room tree. Remove
   a pending marker only when its semantic audit is actually complete, then
   rerun the mechanical operation if the migration path had paused for that
   judgment.
   For `reconstruct-proof-revisions`, run the declared engine operation in the
   opened worktree after reviewing its current-HEAD-only Git-history boundary:

   ```text
   node ../vibehub-core/scripts/vh.mjs project migrate-proof-revisions --repo <root>
   ```

   Review its exact bound and `legacy-unresolved` report. It reconstructs; it
   does not guess, push, or mutate another worktree.
5. Prove `project compatibility` is `CURRENT`, `project validate` passes, and
   `room drift` is honest
   about anything the migration could not settle. Leave the diff to normal
   Git review — migration output has no special authority.

## Guardrails

- Act only on a legacy-structure validation error or an explicit upgrade
  request; never convert in the background.
- Treat the exact `--repo` as the entire mechanical write boundary. Do not scan
  sibling worktrees here and do not stash, reset, commit, or push.
- Restructure in place on the same history — no shims, no dual formats, no
  copies (`../vibehub-setup/references/architecture-boundary.md`).
