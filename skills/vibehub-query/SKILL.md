---
name: vibehub-query
description: Retrieve lightweight Git-native VibeHub Context for a Ticket, file, feature, design question, implementation decision, status, or why question. Use during Ticket planning and execution when checked-in context can answer or constrain the work.
---

# VibeHub Query

Use the smallest query that can answer the task. The Room tree under
`.vibehub/rooms/` is the source of truth — every Context entry lives inside
the room that owns it; there is no database or cache to refresh.

```text
node ../scripts/vh.mjs context query --repo <root> --input <query.json>
node ../scripts/vh.mjs context get --repo <root> --input <id.json>
```

`query.json` may contain `query`, `context_ids`, and `include_inactive`.
Search repository files directly when the answer is implementation evidence
rather than durable Context.

Return the relevant Context IDs, their claims, source/evidence, and any visible
conflict or gap. An empty result is an honest empty result after `ok:true`; a
failed envelope is unavailable, not empty.
