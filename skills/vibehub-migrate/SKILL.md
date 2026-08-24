---
name: vibehub-migrate
description: Upgrade a project's checked-in .vibehub data from an older VibeHub format to the current one by explicit agent-driven restructure. Use when validation names a legacy structure (such as a populated flat .vibehub/context/) or the user explicitly asks to upgrade after pulling a new plugin version.
---

# VibeHub Migrate

> If `../vibehub-core/scripts/vh.mjs` is missing, the install was partial. Run
> `npx skills add VW-ai/vibehub-plugin -s vibehub-core` (or reinstall through
> the host marketplace) before continuing; every VibeHub Skill needs that folder.

Upgrading is a restructure, not a compatibility layer. Current project and
document versions live in `../vibehub-core/contracts/versions.json`; the matching upgrade
steps live once in `references/migrations.json`. Their targets must agree
mechanically before a migration is complete; this Skill supplies the judgment.

## Workflow

1. Run the read-only compatibility preflight and inspect the `.vibehub/` tree:

   ```text
   node ../vibehub-core/scripts/vh.mjs project compatibility --repo <root>
   ```

   `CURRENT` stops with no work. For `MIGRATION_REQUIRED`, find the complete
   path in `references/migrations.json`. `UNSUPPORTED_NEWER` needs a newer
   plugin, never a guessed downgrade.
2. Preview the affected checked-in paths and the planned transformations.
   Cross the explicit migration boundary before writing; plugin installation,
   marketplace refresh, validation, query, and UI launch never grant it.
3. Apply the selected steps as ordinary Git changes. Placement judgment follows
   `../vibehub-ingest/references/knowledge-governance.json`; a missing Room
   tree is built with `$vibehub-distill` first. A step that names a migrator
   script (such as `scripts/migrate-proof-bindings.mjs` for format 2 to 3) is
   performed by running that script — dry run first, then `--apply` — never by
   hand-editing proof documents.
4. Prove `project compatibility` is `CURRENT`, `project validate` passes, and
   `room drift` is honest
   about anything the migration could not settle. Leave the diff to normal
   Git review — migration output has no special authority.

## Guardrails

- Act only on a legacy-structure validation error or an explicit upgrade
  request; never convert in the background.
- Restructure in place on the same history — no shims, no dual formats, no
  copies (`../vibehub-setup/references/architecture-boundary.md`).
