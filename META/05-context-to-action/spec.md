# 05-context-to-action — Context to Action

VibeHub is a context-to-action layer inside Claude Code and Codex, not a
development control plane. It helps the host agent retrieve and settle durable
context, define a Task, select an execution topology, and leave inspectable
evidence.

## Active model

- A **Task** is a durable outcome with success criteria.
- A **Run** is an execution episode with explicit context and code authority.
- Context-only work does not require a worktree.
- Code-writing work claims one canonical writer worktree and must prevent stale
  writers from continuing after handoff.
- Skills make semantic workflow decisions; hooks, MCP and core only capture
  evidence and execute deterministic primitives.
- The App is an optional observability and intervention surface.

## Rooms

- `05-01-task-run-authority`: Task, Run, worktree, lease and handoff authority.
- `05-02-scope-conflict-intervention`: declared scope, conflict evidence and
  intervention receipts.
- `05-03-git-team-visibility`: local-first branch and PR visibility.

## Constraints

- Do not turn branch names, sessions or agent processes into Task identity.
- Do not require the App to complete a context-only or non-PR Task.
- Do not move semantic judgment into a hook state machine.

## Historical provenance

The authoritative model was first recorded in legacy Room 21. Its active
decision and implementation checkpoint are migrated into
`05-01-task-run-authority` with their original spec IDs.

## Canonical Specs

- [intent-context-to-action-001] (active) Context should drive action without
  turning VibeHub into a development control plane.
- [contract-intent-task-genesis-001] (active) User-authored or user-adopted
  durable intent becomes a new Task or an explicit current-Task scope update.
