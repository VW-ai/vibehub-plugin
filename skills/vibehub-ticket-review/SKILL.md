---
name: vibehub-ticket-review
description: Open or review the checked-in VibeHub Ticket graph through the read-only local graph UI or in the Agent conversation. Use when a human wants to inspect outcomes, dependencies, blockers, Evidence, or current Outcomes.
---

# VibeHub Ticket Review

## Local graph UI

Open the exact checkout in the dependency-free local UI:

```text
node ../scripts/vh-ui.mjs --repo <root>
```

The launcher binds an ephemeral loopback port, creates a short-lived bearer
URL, and opens the browser. Use `--no-open` to print the URL without opening it,
`--port <port>` only when a stable local port is useful, and `--json` for an
Agent-readable launch envelope. Stop the foreground process to close the host.

The graph, Ticket inspector, Evidence, and Outcome trace are projected fresh
from `.vibehub/` on every refresh. The UI is read-only and has no database,
persistent cache, daemon, review write route, or Decision authority.
The four canonical schemas and repository validation are the complete handoff:
do not repair, infer, or translate invalid Agent output inside the UI.

## Conversation review

When a browser is unavailable, read the same graph directly:

```text
node ../scripts/vh.mjs ticket graph --repo <root>
node ../scripts/vh.mjs ticket get --repo <root> --input <id.json>
```

Present outcomes, READY/BLOCKED/DONE/DEVIATED state, direct dependencies,
acceptance, Evidence, and Outcome in the conversation.

If the user requests an edit, delegate the revised documents to
`$vibehub-ticket-plan`. Browser state and comments are not Decision authority;
all durable changes continue through the checked-in Ticket workflow.
