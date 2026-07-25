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

## Draft direction

- [decision-intervention-sheet-001] Make one small, complete decision sheet the
  near-term intervention surface. Normal work stays in the host-agent stream;
  VibeHub surfaces one typed boundary at a time, carries evidence through the
  user's decision and later outcome, and does not require a standalone App.

## Implemented first slice

- Existing, canonically projected conflicts now enter through a draggable
  Corner Signal, expand into the evidence-backed conflict decision surface,
  collapse independently from dismissal, and contract into a receipt only
  after the bridge returns strong queued evidence.
- A generic “scope may be changing” trigger remains deliberately unavailable.
  It requires a canonical trigger, governing authority and observed-behavior
  receipt before the UI can make that claim honestly.

# Canonical Specs

- [decision-workbench-002] (active) Conflict resolution returns user-visible
  evidence and supports later outcome analysis.
