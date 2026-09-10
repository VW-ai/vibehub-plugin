---
name: vibehub-core
description: Shared helper script, schemas, and templates that every other VibeHub Skill calls through a relative path. Nothing here is invoked directly; it ships as a skill folder only so installers that copy skill folders one by one (skills.sh) carry it alongside the Skills that need it.
---

# VibeHub Core

## Optional workflow and unrestricted responses

Use this Skill when the user requests its VibeHub operation or has already
chosen VibeHub for the current work. Installation alone does not opt a user
into ticketing. Ordinary chat, exploration, and implementation can continue
without a Ticket, a special phrase, or a prescribed response format. Users can
leave the workflow at any time; do not block their work for missing VibeHub
records. Never truncate, rewrite, suppress, or withhold a model response to
satisfy VibeHub. Schema and lifecycle checks govern explicit VibeHub record
writes only, not the model's answer or the user's ability to work.


This folder is infrastructure for the VibeHub Skills, not a workflow. Do not
invoke it. The Skills that drive work are `vibehub-ticket-plan`,
`vibehub-ticket-run`, `vibehub-ticket-closeout`, `vibehub-review`,
`vibehub-ingest`, and the rest of the `vibehub-*` set; each one references
the files below as `../vibehub-core/...`.

- `contracts/session-entry.md` — automatic dashboard entry for opted-in work.
- `scripts/vh-start.mjs` — start or reuse the built-in unified dashboard.
- `scripts/vh.mjs` — dependency-free helper for Ticket, Evidence, Outcome,
  Context, Room, and project-format operations.
- `scripts/revision-contract.mjs` — canonical serialization, identity, initial
  materialization, and append-only Acceptance/Contract mutation helpers.
- `contracts/revision-identity.md` — human-readable semantic identity contract.
- `scripts/vh-ui.mjs` — read-only loopback host for the local graph UI
  (assets live in `../vibehub-review/assets`).
- `contracts/` — JSON Schemas and written contracts the Skills cite.
- `templates/github/` — files `vibehub-setup` offers to copy into a project
  once, when the user opts into mirroring Tickets to GitHub Issues.

Install every VibeHub skill together. A partial install that omits
`vibehub-core` leaves the other Skills without their helper.
