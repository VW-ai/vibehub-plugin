# 05-01-task-run-authority — Task and Run Authority

This room owns the durable execution model.

## Ontology transition

`decision-workbench-013` is stale as of 2026-07-27 because
`decision-ticket-work-unit-001` replaces Task with Ticket as the sole canonical
work unit. Its remaining Run/worktree authority rules are preserved as design
inputs, not silently discarded:

- Run = one execution episode with explicit context/code authority.
- Context-only Runs need no worktree.
- Code-writing work needs one active writer worktree.
- Workspace ownership and Run-to-writer lease remain distinct.
- A handoff must make stale writers unable to continue.
- Mechanical Runs append operational evidence but cannot redefine semantic truth.

## Current implementation boundary

The runtime already has repo-qualified task identity, sessions, events, scopes,
intervention claims and receipts. That compatibility model must not be presented
as the complete durable Task/Run authority protocol. Writer lease, fencing and
headless Task transitions remain future work.

## Gate

No new state machine should be added until a real dogfood case requires a
deterministic authority primitive that prompt/skill intelligence cannot safely
provide.

## Canonical Specs

- [decision-workbench-013] (stale) Historical Task, Run, worktree and handoff
  authority; Task clauses are invalidated and remaining authority rules await a
  Ticket/Run successor.
- [change-2026-07-13-context-to-action-workflow] (active) Product workflow and
  authority boundary implementation checkpoint.
