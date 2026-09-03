---
name: vibehub-ticket-review
description: Present or review the checked-in VibeHub Ticket graph through the read-only local graph UI or in the Agent conversation. Use when a Ticket workflow reaches a presentation event or a human explicitly wants to inspect outcomes, dependencies, blockers, Evidence, or current Outcomes.
---

# VibeHub Ticket Review

> If `../vibehub-core/scripts/vh.mjs` is missing, the install was partial. Run
> `npx skills add VW-ai/vibehub-plugin -s vibehub-core` (or rerun it
> for every Skill) before continuing; every VibeHub Skill needs that folder.

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
Resolve every displayed or consumed `context_ref` through the shared engine
operation so current paths and immutable historical refs have one source and
identity contract:

```text
node ../vibehub-core/scripts/vh.mjs context resolve --repo <root> --input <ref.json>
```

`ref.json` is `{"ref":"<Ticket context_ref>"}`. Do not check out a historical
commit or bypass the resolver with ad hoc Git commands. Consume the returned
source and identity when presenting the reference.
When `next_action.action` is `CLOSE_OUT`, present it as independent review work
and route it to `$vibehub-ticket-closeout`; never call Ticket Run again. When a
bounded list is requested, report only `ready_to_closeout` from this exact
repository and scope.

If the user requests an edit, delegate the revised documents to
`$vibehub-ticket-plan`. Browser state and comments are not Decision authority;
all durable changes continue through the checked-in Ticket workflow.
