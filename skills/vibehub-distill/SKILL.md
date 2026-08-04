---
name: vibehub-distill
description: Build or resume a repository's Room tree when drift reports COLD_START, or refresh it on explicit user request. Rooms are domain-agnostic bounded workspaces described by room.yaml under .vibehub/rooms/. Use when a project has no Room tree yet or the user asks for a fresh distillation.
---

# VibeHub Distill

Cold start is the one alignment experience allowed to be perceptible, and it
runs once per project. Everything afterwards is align-on-use at Ticket start.

## Workflow

1. `node ../scripts/vh.mjs room drift --repo <root>` decides the mode.
   `cold_start:true` means propose a tree. Otherwise distill only rooms
   reporting UNKNOWN: the alignment stamp is the resume marker, so an
   interrupted cold start continues exactly where stamps are missing — there
   is no separate progress state to maintain.
2. Propose the tree by judgment, not enumeration. A room is a bounded
   workspace someone does coherent work in, named by a semantic kebab-case
   slug; nest a sub-room only when the parent genuinely composes it. A small
   honest tree beats an exhaustive one — rooms are cheap to split later with
   `git mv`.
3. Read enough of each room's territory to describe it truthfully, then write
   its `room.yaml` (`../contracts/room.schema.json`): a description, a
   boundary that also says what the room is not, and anchors as
   segment-boundary path prefixes covering what its knowledge is about. Stamp
   it immediately:

   ```text
   node ../scripts/vh.mjs room align --repo <root> --room <path>
   ```

4. Distilled output follows the trust and placement rules in
   `../vibehub-ingest/references/knowledge-governance.json`.
5. Report one line per room at most; close with totals (rooms, anchored
   files).

## Guardrails

- Never write a room for territory you have not read.
- Do not introduce progress files, manifests, or a second store; the tree and
  its stamps are the whole state, inside
  `../vibehub-setup/references/architecture-boundary.md`.
