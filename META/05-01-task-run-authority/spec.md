# 05-01-task-run-authority — Task and Run Authority

This room owns the durable execution model.

## Decision

`decision-workbench-013` remains active:

- Task = independent outcome and success criteria.
- Run = one execution episode with explicit context/code authority.
- Context-only Runs need no worktree.
- A code-writing Task has at most one active writer worktree.
- Task-to-workspace ownership and Run-to-writer lease are distinct.
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

- [decision-workbench-013] (active) Task, Run, worktree and handoff authority.
- [change-2026-07-13-context-to-action-workflow] (active) Product workflow and
  authority boundary implementation checkpoint.
