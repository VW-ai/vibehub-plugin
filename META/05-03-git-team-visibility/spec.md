# 05-03-git-team-visibility — Git Team Visibility

This room owns the local-first projection of branches, PR facts, touched files
and merge conflicts into the Workbench read model.

## Semantics

- Remote teammates visible only through Git are a weaker signal tier.
- Unmerged branches with no PR or an open PR are active conflict candidates.
- Closed/merged work is not treated as a concurrent writer.
- Pure Git evidence may report ahead/merged/stale; it must not synthesize
  waiting/running state.
- Before semantic mapping exists, files remain honestly uncategorized.

The feature is implemented, but its product value and noise budget must be
validated through real usage.
# Canonical Specs

- [decision-workbench-004] (active) Project only honest Git facts and restrict
  conflicts to active unmerged work.
- [change-2026-07-12-team-visibility-slice] (active) Git/GitHub → SQLite →
  Workbench visibility vertical slice.
