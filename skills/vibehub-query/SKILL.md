---
name: vibehub-query
description: Retrieve lightweight Git-native VibeHub Context for a Ticket, file, feature, design question, implementation decision, status, or why question. Use during Ticket planning and execution when checked-in context can answer or constrain the work.
---

# VibeHub Query

> If `../vibehub-core/scripts/vh.mjs` is missing, the install was partial. Run
> `npx skills add VW-ai/vibehub-plugin -s vibehub-core` (or rerun it
> for every Skill) before continuing; every VibeHub Skill needs that folder.

Use the smallest query that can answer the task. The Room tree under
`.vibehub/rooms/` is the source of truth — every Context entry lives inside
the room that owns it, and the architecture boundary
(`../vibehub-setup/references/architecture-boundary.md`) means there is no
database or cache elsewhere to refresh. When reporting answers, distinguish
trust layers per `../vibehub-ingest/references/knowledge-governance.json`.

```text
node ../vibehub-core/scripts/vh.mjs context query --repo <root> --input <query.json>
node ../vibehub-core/scripts/vh.mjs context get --repo <root> --input <id.json>
```

`query.json` may contain `query`, `context_ids`, and `include_inactive`.
Search repository files directly when the answer is implementation evidence
rather than durable Context.

When a Ticket supplies `context_refs`, read each current or historical source
through the same engine resolver used by validation, planning, execution, and
review:

```text
node ../vibehub-core/scripts/vh.mjs context resolve --repo <root> --input <ref.json>
```

`ref.json` is `{"ref":"<Ticket context_ref>"}`. Report the returned source
and identity; never check out a referenced commit or treat a versioned ref as
a working-tree filename.

Return the relevant Context IDs, their claims, source/evidence, and any visible
conflict or gap. An empty result is an honest empty result after `ok:true`; a
failed envelope is unavailable, not empty.
