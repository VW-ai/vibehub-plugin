---
name: vibehub-setup
description: Set up the lightweight Skill-first VibeHub folders and project instructions in an exact repository, while detecting existing documentation or memory systems before writing. Use for installation, onboarding, or setup repair.
---

# VibeHub Setup

VibeHub installs as Skills plus checked-in Git YAML. It has no required CLI,
MCP server, hook process, database, daemon, native build, or local web host.
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
3. After the choice, initialize only the direct data folders:

   ```text
   node ../scripts/vh.mjs project init --repo <root>
   ```

4. Add a small managed instruction block: development starts from Tickets;
   query Context when planning/execution needs it; explicit phrases such as
   “记录一下” or “remember this” invoke `$vibehub-ingest`.
5. Run `project validate`. Prove setup by reading the files from a fresh
   process. Installation is complete when Skills and folders are available;
   no host handshake or background activation state exists.
