---
name: vibehub-ingest
description: Distill discussions, reviews, handoffs, notes, and implementation evidence into governed VibeHub knowledge. Use when durable project intent, decisions, constraints, conventions, contracts, context, or changes should be captured, deduplicated, related to existing knowledge, and submitted for review.
---

# VibeHub Ingest

Turn evidence into small, reviewable project facts. This skill owns semantic decomposition and relationship judgment; `kb_record` only validates and persists one prepared fact.

## Workflow

1. Identify durable evidence. Ignore acknowledgements, speculation without consequence, and transient execution chatter.
2. Query existing knowledge with `kb_retrieve` using the topic and any affected repo-relative paths.
3. Split the evidence into atomic facts. Choose exactly one type for each:
   - `intent`: desired outcome or product direction;
   - `decision`: a chosen option;
   - `constraint`: a required or forbidden condition;
   - `convention`: a repeatable team practice;
   - `contract`: an interface or behavioral promise;
   - `context`: durable background needed to interpret work;
   - `change`: a meaningful implemented or planned transition.
4. For every candidate, decide whether it is new, duplicate, refinement, contradiction, replacement, or staleness evidence. Prefer precision over recall.
5. Call `kb_record` once per new atomic fact. Use `supersedes` only when the new fact explicitly replaces an existing one. Use `marksStale` only when evidence proves an existing fact is no longer reliable.
6. Inspect duplicate candidates and write results. Never claim successful capture when the capability rejected a fact.
7. Report what was recorded as draft, what was skipped as duplicate, and what still needs human judgment.

## Quality Bar

- Summary states one testable fact in project language; detail carries rationale and nuance.
- Preserve provenance in the wording when confidence or source identity matters.
- Do not invent feature IDs, replacement chains, or certainty.
- Do not combine unrelated must/must-not rules in one record.
- Do not turn every conversation sentence into knowledge.
- Do not write SQLite or graph tables directly.
