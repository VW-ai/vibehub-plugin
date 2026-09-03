---
name: vibehub-core
description: Shared helper script, schemas, and templates that every other VibeHub Skill calls through a relative path. Nothing here is invoked directly; it ships as a skill folder only so installers that copy skill folders one by one (skills.sh) carry it alongside the Skills that need it.
---

# VibeHub Core

This folder is infrastructure for the VibeHub Skills, not a workflow. Do not
invoke it. The Skills that drive work are `vibehub-ticket-plan`,
`vibehub-ticket-run`, `vibehub-ticket-closeout`, `vibehub-ticket-review`,
`vibehub-ingest`, and the rest of the `vibehub-*` set; each one references
the files below as `../vibehub-core/...`.

- `scripts/vh.mjs` — dependency-free helper for Ticket, Evidence, Outcome,
  Context, Room, and project-format operations.
- `scripts/vh-ui.mjs` — read-only loopback host for the local graph UI
  (assets live in `../vibehub-ticket-review/assets`).
- `contracts/` — JSON Schemas and written contracts the Skills cite.
- `templates/github/` — files `vibehub-setup` offers to copy into a project
  once, when the user opts into mirroring Tickets to GitHub Issues.

Install every VibeHub skill together. A partial install that omits
`vibehub-core` leaves the other Skills without their helper.
