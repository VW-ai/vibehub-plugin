---
name: vibehub-setup
description: Set up the lightweight Skill-first VibeHub folders and project instructions in an exact repository, while detecting existing documentation or memory systems before writing. Use for installation, onboarding, or setup repair.
---

# VibeHub Setup

> If `../vibehub-core/scripts/vh.mjs` is missing, the install was partial. Run
> `npx skills add VW-ai/vibehub-plugin -s vibehub-core` (or rerun it
> for every Skill) before continuing; every VibeHub Skill needs that folder.

VibeHub installs as Skills plus checked-in Git YAML, inside the product
boundary defined once in `references/architecture-boundary.md`.
When Ticket Plan invokes Setup for the canonical “Start this with VibeHub.”
entry, return to Ticket Plan after successful validation so the current
deliverable continues without another user command.

## Workflow

1. Inspect the exact checkout for existing `AGENTS.md`, `CLAUDE.md`, `docs/`,
   `.github/copilot-instructions.md`, project-local skills, memory/context
   folders, and similarly named capture commands.
2. If an existing durable-memory system may overlap, show the detected paths
   and ask the user to choose:
   - dual-write: preserve the existing system and teach its command to write
     both stores; or
   - VibeHub-only: stop writing the old store after an explicitly reviewed
     one-time conversion.

   Do not assume permission to replace or duplicate user knowledge.
3. After the choice, initialize the project-format marker and direct data
   folders:

   ```text
   node ../vibehub-core/scripts/vh.mjs project init --repo <root>
   ```

4. Add a small managed instruction block: development starts from Tickets;
   query Context when planning/execution needs it; explicit phrases such as
   “记录一下” or “remember this” invoke `$vibehub-ingest`.
5. Run `project compatibility` and require `CURRENT`, then run `project
   validate`. Prove setup by reading the files from a fresh
   process. Installation is complete when Skills and folders are available;
   no host handshake or background activation state exists.
6. Optional, asked once: if `git remote get-url origin` points at
   `github.com`, ask the user whether to mirror Tickets to GitHub Issues
   (one workflow plus a small script; runs only in GitHub Actions on push to
   `main`; nothing for an Agent to run or check). On yes, copy these five
   files and nothing else, then record the copy as setup Evidence:

   ```text
   ../vibehub-core/templates/github/sync-issues.yml        → .github/workflows/sync-issues.yml
   ../vibehub-core/templates/github/sync-github-issues.mjs → scripts/vibehub/sync-github-issues.mjs
   ../vibehub-core/scripts/vh.mjs                          → scripts/vibehub/scripts/vh.mjs
   ../vibehub-core/contracts/versions.json                 → scripts/vibehub/contracts/versions.json
   ../vibehub-core/contracts/dependency-hygiene.json       → scripts/vibehub/contracts/dependency-hygiene.json
   ```

   The copy is self-contained so the workflow runs in a clean Actions
   checkout without the plugin. Do not add any instruction, hook, or Skill
   text that asks an Agent to run the sync; Git stays the source of truth and
   the Issues are a read-only projection. On no, skip without recording
   anything; the user can ask for it later.
