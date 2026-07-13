---
name: vibehub-query
description: Retrieve and synthesize governed VibeHub project context for a task, file path, design question, implementation decision, or "why" question. Use when an agent needs repository knowledge before non-trivial work, when a hook requests a context pull, or when initial context is incomplete, stale, or conflicting.
---

# VibeHub Query

Own the semantic retrieval strategy. `kb_retrieve` is only one deterministic ranked pass; this skill decides the passes, follows useful threads, resolves version chains, and stops when the context is sufficient.

## Workflow

1. Frame the need as one sentence: the task, affected paths, and the decision the context must support.
2. Run `kb_retrieve` with repo-relative paths when files are known and a short topic query when intent is known. Use both when available.
3. Inspect results for:
   - active decisions, contracts, and constraints that govern the work;
   - stale or superseded facts whose newer version must be followed;
   - conflicts, missing rationale, or adjacent features that materially change the answer.
4. If a material gap remains, make a narrower follow-up pass. Change one dimension at a time: path, concept, named feature, or missing rationale.
5. Stop when another pass is unlikely to change the planned action. Do not retrieve broadly for reassurance.
6. Return a compact context packet:
   - the governing facts and their spec IDs;
   - conflicts or uncertainty;
   - concrete implications for the current task;
   - any unresolved question that truly blocks action.

## Judgment Rules

- Prefer active, path-bound facts over generic topical matches.
- Treat stale and superseded entries as history, not current authority.
- Preserve disagreement instead of silently choosing a convenient fact.
- Distinguish retrieved fact from your inference.
- Do not write knowledge during query. Route durable new evidence to `vibehub-ingest`.
- Do not inspect or write VibeHub SQLite directly.
