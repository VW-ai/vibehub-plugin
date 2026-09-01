---
name: vibehub-review
description: Present or review the checked-in VibeHub Ticket graph and the canonical Room tree through the read-only local graph UI or in the Agent conversation. Use when a Ticket workflow reaches a presentation event, when a proposed or existing Room tree needs a human gate, or when a human explicitly wants to inspect outcomes, dependencies, blockers, Evidence, current Outcomes, Room nesting, boundaries, or drift.
---

# VibeHub Review

> If `../vibehub-core/scripts/vh.mjs` is missing, the install was partial. Run
> `npx skills add VW-ai/vibehub-plugin -s vibehub-core` (or reinstall through
> the host marketplace) before continuing; every VibeHub Skill needs that folder.

This Skill is the sole presentation surface for VibeHub. It presents two
things and writes nothing: the **Ticket graph** and the **Room tree**.

Read `references/ticket-lifecycle.json` before acting. This Skill owns
`explicit-review` and is the sole presenter for every event whose
`presentation` is `review`; semantic transition ownership remains with the
calling Ticket Skill.
Read `../vibehub-core/contracts/ticket-next-action.md`. Present the host-derived next action
beside operational state and human attention; never infer it again from UI
copy, Evidence counts, or browser state.

## Local graph UI

Open the exact checkout in the dependency-free local UI:

```text
node ../vibehub-core/scripts/vh-ui.mjs --repo <root>
node ../vibehub-core/scripts/vh-ui.mjs --repo <root> --ticket <ticket-id> --view <execution|contract|log>
```

The launcher binds an ephemeral loopback port, creates a short-lived bearer
URL, and opens the browser. Use `--no-open` to print the URL without opening it,
`--port <port>` only when a stable local port is useful, and `--json` for an
Agent-readable launch envelope. `--ticket` selects one existing canonical
Ticket and `--view` focuses its Execution, Contract, or Log surface. Stop the
foreground process to close the host.
The default browser is the user's normal operating-system browser, not Codex.
The page keeps its short-lived `#` bearer fragment and exposes **Copy link**;
the complete copied URL can be pasted into another local browser while the
launcher is alive. A bare origin without the fragment is intentionally denied.

Within the current Agent task, reuse a still-live host URL and browser tab:
refresh the page, update the optional `ticket` and `view` query values, and
focus the requested surface. Start a new ephemeral host only when no live host
is known. Never create a cross-task registry, daemon, PID file, persistent
cache, or hidden discovery state to find an old host. If the browser cannot be
controlled, opening the focused authorized URL is sufficient.

The graph, Ticket inspector, Evidence, and Outcome trace are projected fresh
from `.vibehub/` on every refresh. The UI is read-only and has no database,
persistent cache, daemon, review write route, or Decision authority.
The four canonical schemas and repository validation are the complete handoff:
do not repair, infer, or translate invalid Agent output inside the UI.

For one Ticket awaiting adjudication, focus its Log directly with `--ticket`
and `--view log`. For a bounded batch review, use the current repository's
Overview **Independent closeout** queue or `ticket frontier`'s
`ready_to_closeout` array. That queue contains only Tickets whose host-derived
action is `CLOSE_OUT`; it never mixes executable READY, REFINE, WAIT, human
authority, or non-success Outcome work, and it never accepts a batch. A
closeout action copies the exact read-only Agent handoff for an independent
closeout Agent; it is not a browser write or a model turn.

## Room tree

Open the exact checkout focused on the canonical Room tree:

```text
node ../vibehub-core/scripts/vh-ui.mjs --repo <root> --rooms
```

That one invocation is the Room tree entry. It opens the same read-only host
with the Rooms surface already open, showing every canonical Room with its
nesting depth, boundary, drift state (`FRESH`, `DRIFTED`, `OLD CHECKOUT`,
`STALE`, `ROOMS NOT INITIALIZED`), per-room Context count, and the Tickets that
consume the Room subtree. Add `--room <room-path>` to open the tree with one
Room already selected; `--room` implies `--rooms`. `--rooms` and `--room` are
Room-tree focus and cannot be combined with `--ticket` or `--view`, which are
Ticket focus. `--no-open`, `--port`, and `--json` behave exactly as they do for
Ticket focus, and the short-lived `#` bearer fragment, port reuse, and
**Copy link** rules are unchanged.

A Room with zero Contexts is a first-class state, not an error. Immediately
after a tree is proposed, every Room is an empty shell: the tree renders with a
`0 Context` count on each Room and the Room detail states that the boundary is
set and no Context has been written yet. That is the exact state the bulk
absorption human gate presents in, and adjusting the tree at that point is
`git mv` plus a boundary edit.

The tree is projected fresh from `.vibehub/` on every refresh, like the graph.
The UI cannot create, move, merge, or rename a Room, and it has no preview mode
for a tree that is not checked in: a proposed tree must be written by
`$vibehub-distill` before it can be shown. Tree changes the human asks for are
delegated back to the calling Skill.

## Conversation review

When a browser is unavailable, read the same graph directly:

```text
node ../vibehub-core/scripts/vh.mjs ticket graph --repo <root>
node ../vibehub-core/scripts/vh.mjs ticket graph --repo <root> --scope all
node ../vibehub-core/scripts/vh.mjs ticket graph --repo <root> --delivery <canonical-ref> --room <room-slug>
node ../vibehub-core/scripts/vh.mjs ticket get --repo <root> --input <id.json>
```

Present outcomes, READY/BLOCKED/DONE/DEVIATED state, derived next action,
direct dependencies, acceptance, Evidence, and Outcome in the conversation.
When `next_action.action` is `CLOSE_OUT`, present it as independent review work
and route it to `$vibehub-ticket-closeout`; never call Ticket Run again. When a
bounded list is requested, report only `ready_to_closeout` from this exact
repository and scope.

When no browser is available, present the same Room tree from `vh.mjs` output:

```text
node ../vibehub-core/scripts/vh.mjs room tree --repo <root>
```

`room tree` is read-only and projects the Room panel of the UI exactly: one
entry per canonical Room in path order, each with its `room` path, `room_id`,
`parent` (`null` at the top), `description`, `boundary`, `drift`, and
`context_count` for that Room's subtree (`0` for an empty shell). Nesting is the
`parent` link, equivalently the `/` depth of `room`. A Room that has never been
aligned reports drift state `COLD_START`, which the UI presents as
`ROOMS NOT INITIALIZED`; the other states are `FRESH`, `DRIFTED`, `WARNING`, and
`STALE`, carrying the same `changed`/`added`/`deleted` or `reason` detail the UI
shows. `cold_start` is `true` when the repository has no Rooms yet. Present
nesting, boundary, drift state, and Context count per Room in the conversation,
in that order.

Use `room drift` when only alignment state is wanted, and
`context query --repo <root> --room <room-path> --input <query.json>` to list
the Context entries behind a count.

If the user requests an edit, delegate the revised documents to
`$vibehub-ticket-plan`. Browser state and comments are not Decision authority;
all durable changes continue through the checked-in Ticket workflow.
