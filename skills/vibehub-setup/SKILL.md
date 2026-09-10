---
name: vibehub-setup
description: Set up the lightweight Skill-first VibeHub folders and project instructions in an exact repository, while detecting existing documentation or memory systems before writing. Use for installation, onboarding, or setup repair.
---

# VibeHub Setup

## Optional workflow and unrestricted responses

Use this Skill when the user requests its VibeHub operation or has already
chosen VibeHub for the current work. Installation alone does not opt a user
into ticketing. Ordinary chat, exploration, and implementation can continue
without a Ticket, a special phrase, or a prescribed response format. Users can
leave the workflow at any time; do not block their work for missing VibeHub
records. Never truncate, rewrite, suppress, or withhold a model response to
satisfy VibeHub. Schema and lifecycle checks govern explicit VibeHub record
writes only, not the model's answer or the user's ability to work.



## Automatic dashboard entry

Before the first user-facing operation in an opted-in VibeHub session, follow
`../vibehub-core/contracts/session-entry.md`: run the bundled `vh-start.mjs`
entry helper, reuse the session's existing dashboard when available, then
continue this Skill. Do not ask the user to start a separate dashboard.
Subagents reuse the parent's entry; a user request to keep it closed wins.

> If `../vibehub-core/scripts/vh.mjs` is missing, the install was partial. Run
> `npx skills add VW-ai/vibehub-plugin -s vibehub-core` (or rerun it
> for every Skill) before continuing; every VibeHub Skill needs that folder.

VibeHub installs as Skills plus local YAML records by default, inside the product
boundary defined once in `references/architecture-boundary.md`.
When Ticket Plan invokes Setup for the canonical “Start this with VibeHub.”
entry, return to Ticket Plan after successful validation so the current
deliverable continues without another user command.

## Workflow

1. Inspect the exact checkout for existing `AGENTS.md`, `CLAUDE.md`, `docs/`,
   `.github/copilot-instructions.md`, project-local skills, memory/context
   folders, and similarly named capture commands.

   In the same pass, ask the helper whether any installed Skill folder carries
   a name the plugin has retired:

   ```text
   node ../vibehub-core/scripts/vh.mjs skills retired --repo <root>
   ```

   `npx skills add` copies Skill folders and never prunes one that disappeared
   upstream, so a rename can leave the old folder installed beside its
   replacement and present the Agent two Skills for the same job. The names
   come from the packaged skill-graph contract that ships next to the helper,
   never from this prose, so the answer stays true after any later rename. The
   command reads the install locations it reports under `scanned` and writes
   nothing.

   When `retired` is empty — including in a project that never installed
   through skills.sh, where `scanned` is empty too — say nothing about it and
   continue. For each entry, report its exact `path` and its `replacement`,
   and say that deleting the folder is the user's action: setup never deletes,
   moves, or rewrites anything inside an agent Skill directory.
2. If an existing durable-memory system may overlap, show the detected paths
   and ask the user to choose:
   - dual-write: preserve the existing system and teach its command to write
     both stores; or
   - VibeHub-only: stop writing the old store after an explicitly reviewed
     one-time conversion.

   Do not assume permission to replace or duplicate user knowledge.
3. After the choice, initialize the project-format marker and direct data
   folders. Initialization excludes new records from normal Git staging using
   `.vibehub/.gitignore`; this does not untrack existing shared records. Read
   the returned sharing notice. Local records still support planning, execution,
   evidence, closeout, and Context without a GitHub account or remote:

   ```text
   node ../vibehub-core/scripts/vh.mjs project init --repo <root>
   ```

4. Keep managed instructions inside the ignored `.vibehub/AGENTS.md` by default.
   Do not modify tracked root `AGENTS.md`, `CLAUDE.md`, or host instructions
   unless the user explicitly requests a shared project installation.
   Add a small managed instruction block stating that VibeHub is optional.
   Use Ticket Skills when the user chooses VibeHub or names an existing Ticket;
   do not automatically route all development through Tickets. State that
   record validation never restricts model responses or ordinary work.
   State that choosing VibeHub automatically starts its built-in dashboard
   through the session-entry contract, reusing a live host without another
   user command. Dashboard failure does not block work.
   Query Context when useful; explicit requests to remember project knowledge
   may invoke `$vibehub-ingest`. Preserve unrelated project instructions.
5. Run `project compatibility` and require `CURRENT`, then run `project
   validate`. Prove setup by reading the files from a fresh
   process. Installation is complete when Skills and folders are available;
   no host handshake or background activation state exists.
6. GitHub is off by default. Do not inspect a remote or ask a GitHub setup
   question just because a remote exists. Only when the user explicitly requests
   GitHub mirroring, explain which records will be shared, copy these six files,
   and enable the repository Actions variable `VIBEHUB_GITHUB_SYNC=true` with
   the user's authorization. Nothing for an Agent to run or check during
   ordinary VibeHub work. Record the authorized setup as Evidence:

   ```text
   ../vibehub-core/templates/github/sync-issues.yml        → .github/workflows/sync-issues.yml
   ../vibehub-core/templates/github/sync-github-issues.mjs → scripts/vibehub/sync-github-issues.mjs
   ../vibehub-core/scripts/vh.mjs                          → scripts/vibehub/scripts/vh.mjs
   ../vibehub-core/scripts/revision-contract.mjs           → scripts/vibehub/scripts/revision-contract.mjs
   ../vibehub-core/contracts/versions.json                 → scripts/vibehub/contracts/versions.json
   ../vibehub-core/contracts/dependency-hygiene.json       → scripts/vibehub/contracts/dependency-hygiene.json
   ```

   The copy is self-contained so the workflow runs in a clean Actions
   checkout without the plugin. Do not add any instruction, hook, or Skill
   text that asks an Agent to run the sync; Git stays the source of truth and
   the Issues are a read-only projection. Copying the files alone leaves the
   job disabled. The workflow uses explicit `--publish` only after the repository
   variable is enabled. Sharing records is a separate deliberate step: review
   and stage only the chosen records; never force-add the entire local store.
