# 05-02-scope-conflict-intervention — Scope, Conflict and Intervention

This room owns declared scope, observed read/write footprints, conflict evidence,
intervention delivery and honest receipts.

## Current contract

- Scope declaration and file matching are deterministic.
- Conflicts are evidence about concurrent work, not a replacement for Task state.
- Queued, claimed, delivered, persisted, skipped and failed are distinct outcomes.
- Normal continuation is silent; low-risk bookkeeping may auto-apply and inform.
- Task split, delegation, worktree creation and handoff are recommendations that
  require confirmation.
- Only ownership/isolation violations justify a hard block.

## Open outcome

After an intervention, VibeHub should show whether the pair was resolved and
eventually make that value visible over time. The implementation must not claim
success merely because an instruction was queued.
# Canonical Specs

- [decision-workbench-002] (active) Conflict resolution returns user-visible
  evidence and supports later outcome analysis.
