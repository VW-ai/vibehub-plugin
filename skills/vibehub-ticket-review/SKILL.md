---
name: vibehub-ticket-review
description: Review the checked-in lightweight VibeHub Ticket graph in the Agent conversation. Use when a human wants to inspect outcomes, dependencies, blockers, evidence, or proposed edits without launching a local server.
---

# VibeHub Ticket Review

Read the graph directly:

```text
node ../scripts/vh.mjs ticket graph --repo <root>
node ../scripts/vh.mjs ticket get --repo <root> --input <id.json>
```

Present outcomes, READY/BLOCKED/DONE state, direct dependencies, acceptance,
Evidence, and Outcome in the conversation. GitHub branch/PR/comments are the
durable human review surface.

If the user requests an edit, delegate the revised documents to
`$vibehub-ticket-plan`. Do not start a writable local host or treat a comment as
Decision authority.
