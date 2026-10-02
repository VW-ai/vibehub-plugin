---
name: vibehub-core
description: Shared helper script, schemas, and templates that every other VibeHub Skill calls through a relative path. Nothing here is invoked directly; it ships as a skill folder only so installers that copy skill folders one by one (skills.sh) carry it alongside the Skills that need it.
---

# VibeHub Core

Use VibeHub when the user chooses it. Ordinary work needs no Ticket or
prescribed response format. Record validation applies to explicit record
writes and never restricts the conversation.

This folder provides helpers for `vibehub-ticket`, `vibehub-review`, and the
other VibeHub Skills. It is never invoked directly. The helpers store and read
task memory and Context. The user's chosen skills own development methods.

- `contracts/session-entry.md` — automatic dashboard entry for opted-in work.
- `scripts/vh-start.mjs` — start or reuse the built-in unified dashboard.
- `scripts/vh.mjs` — dependency-free helper for Ticket, Evidence, Outcome,
  Context, Room, and project-format operations.
- `scripts/revision-contract.mjs` — canonical serialization, identity, initial
  materialization, and append-only Acceptance/Contract mutation helpers.
- `contracts/ticket-state.md` describes task status, updates, and optional history.
- `contracts/revision-identity.md` — human-readable semantic identity contract.
- `scripts/vh-ui.mjs` — read-only loopback host for the local graph UI
  (assets live in `../vibehub-review/assets`).
- `contracts/planning-hierarchy.md` — Goal, Epic, and Ticket semantics, ownership,
  PRD planning, helper operations, and progress boundaries.
- `scripts/session-store.mjs` and `scripts/vh-session.mjs` — local worktree
  session reporting and the foreground command wrapper.
- `contracts/agent-session.md` — Ticket versus session state and reporter integration.
- `contracts/` — JSON Schemas and written contracts the Skills cite.
- `templates/github/` — files `vibehub-setup` offers to copy into a project
  once, when the user opts into mirroring Tickets to GitHub Issues.

Install every VibeHub skill together. A partial install that omits
`vibehub-core` leaves the other Skills without their helper.
