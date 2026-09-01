---
name: vibehub-distill
description: Internal mechanism that writes Room shape and alignment stamps — building or resuming a repository's Room tree when drift reports COLD_START, and refreshing it on request. Rooms are domain-agnostic bounded workspaces described by room.yaml under .vibehub/rooms/. Invoked by $vibehub-ingest, $vibehub-ticket-plan, and $vibehub-migrate, not called directly by a user.
---

# VibeHub Distill

This Skill's job is Room shape and alignment stamps: boundaries, nesting,
anchors, and the stamp that makes drift computable. It does not extract
Context. A caller that needs a document turned into Context runs
`$vibehub-ingest`, which invokes this Skill for the tree and then writes the
Context itself.

> If `../vibehub-core/scripts/vh.mjs` is missing, the install was partial. Run
> `npx skills add VW-ai/vibehub-plugin -s vibehub-core` (or reinstall through
> the host marketplace) before continuing; every VibeHub Skill needs that folder.

Cold start is the one alignment experience allowed to be perceptible, and it
runs once per project. Everything afterwards is align-on-use at Ticket start.

## Workflow

1. Run `project compatibility` before any Room write. Proceed only for
   `CURRENT`, except when `$vibehub-migrate` invoked this Skill after the
   explicit migration boundary for a registered legacy step.
2. `node ../vibehub-core/scripts/vh.mjs room drift --repo <root>` decides the mode.
   `cold_start:true` means propose a tree. Otherwise distill only rooms
   reporting UNKNOWN: the alignment stamp is the resume marker, so an
   interrupted cold start continues exactly where stamps are missing — there
   is no separate progress state to maintain.
3. Propose the tree by judgment, not enumeration. A room is a bounded
   workspace someone does coherent work in, named by a semantic kebab-case
   slug; nest a sub-room only when the parent genuinely composes it. Split
   under pressure rather than merging under it: a room must split when its
   boundary needs "and" to join two unrelated concerns, or when its topics
   serve visibly different readers (product / engineering / design). Collapsing
   those into one room is how knowledge gets lost — rooms are cheap, and
   splitting is `git mv` plus a boundary edit while they are still empty.
4. Read enough of each room's territory to describe it truthfully, then write
   its `room.yaml` (`../vibehub-core/contracts/room.schema.json`): a description, a
   boundary that also says what the room is not, and anchors as
   segment-boundary path prefixes covering what its knowledge is about. Stamp
   it immediately:

   ```text
   node ../vibehub-core/scripts/vh.mjs room align --repo <root> --room <path>
   ```

5. Distilled output follows the trust and placement rules in
   `../vibehub-ingest/references/knowledge-governance.json`.
6. Report one line per room at most; close with totals (rooms, anchored
   files).

## Guardrails

- Never write a room for territory you have not read.
- Do not introduce progress files, manifests, or a second store; the tree and
  its stamps are the whole state, inside
  `../vibehub-setup/references/architecture-boundary.md`.
