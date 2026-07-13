---
name: vibehub-distill
description: Build or deliberately refresh VibeHub's semantic map of a repository by inferring features, sub-features, code anchors, and relations from repository evidence. Use for first-run repository onboarding or an explicit remap after substantial structural drift; do not use as a routine per-task scan.
---

# VibeHub Distill

Own repository-to-feature interpretation. Produce one coherent manifest, then let `kb_apply_distillation` validate and apply it atomically.

## Workflow

1. Confirm this is a cold start or an explicit refresh. Do not silently remap an established repository during ordinary task work.
2. Read the repository's authoritative project guidance, package/module boundaries, entry points, and representative tests. Sample strategically; avoid treating directory names alone as semantics.
3. Infer a compact hierarchy:
   - top-level features represent stable user or system capabilities;
   - child features represent meaningful internal sub-capabilities;
   - names describe purpose, not implementation fashion.
4. Bind each feature to repo-relative file anchors and symbols when a symbol is stable. Every feature must have evidence; shared infrastructure may anchor multiple features when justified.
5. Add only relations supported by repository evidence. Keep IDs stable and readable within the manifest.
6. Audit the complete manifest before applying it:
   - every parent and relation endpoint exists;
   - paths are canonical and repo-relative;
   - anchors support the claimed feature;
   - no duplicate feature IDs or accidental orphan features;
   - uncertainty remains visible rather than being converted to false structure.
7. Call `kb_apply_distillation` once with the full manifest. If validation fails, repair the manifest and retry; never partially apply it yourself.
8. Summarize mapped features, uncertain areas, and uncategorized code that remains honestly gray.

## Boundaries

- Do not encode workflow instructions in MCP descriptions or hook prompts.
- Do not create knowledge specs unless separate durable evidence warrants `vibehub-ingest`.
- Do not write SQLite, layout caches, anchors, or edges directly.
- A successful apply proves structural integrity, not semantic truth; report meaningful uncertainty.
