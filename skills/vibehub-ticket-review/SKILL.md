---
name: vibehub-ticket-review
description: Present or review the checked-in VibeHub Ticket graph through the read-only local graph UI or in the Agent conversation. Use when a Ticket workflow reaches a presentation event or a human explicitly wants to inspect outcomes, dependencies, blockers, Evidence, or current Outcomes.
---

# VibeHub Ticket Review

Read `references/ticket-lifecycle.json` before acting. This Skill owns
`explicit-review` and is the sole presenter for every event whose
`presentation` is `review`; semantic transition ownership remains with the
calling Ticket Skill.
Read `../contracts/ticket-next-action.md`. Present the host-derived next action
beside operational state and human attention; never infer it again from UI
copy, Evidence counts, or browser state.

## Local graph UI

Open the exact checkout in the dependency-free local UI:

```text
node ../scripts/vh-ui.mjs --repo <root>
node ../scripts/vh-ui.mjs --repo <root> --ticket <ticket-id> --view <execution|contract|log>
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

## Conversation review

When a browser is unavailable, read the same graph directly:

```text
node ../scripts/vh.mjs ticket graph --repo <root>
node ../scripts/vh.mjs ticket graph --repo <root> --scope all
node ../scripts/vh.mjs ticket graph --repo <root> --delivery <canonical-ref> --room <room-slug>
node ../scripts/vh.mjs ticket get --repo <root> --input <id.json>
```

Present outcomes, READY/BLOCKED/DONE/DEVIATED state, derived next action,
direct dependencies, acceptance, Evidence, and Outcome in the conversation.

If the user requests an edit, delegate the revised documents to
`$vibehub-ticket-plan`. Browser state and comments are not Decision authority;
all durable changes continue through the checked-in Ticket workflow.
