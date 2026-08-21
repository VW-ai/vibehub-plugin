# Codex-first Task Workspace research

## Decision

A focused VibeHub Task is a bounded Context Space, not a static inspector and not
another Chat object. Its upper region explains durable Task truth and the next
action; its lower region embeds the same Codex Thread/Turn renderer and Composer
used by ordinary Chat. Codex owns conversation, streaming, tools, approvals and
execution. VibeHub owns Task identity, Project scope, governed Context, Acceptance,
Evidence and independent Outcome.

The executable contracts are
[`task-workspace-contract.json`](proposals/codex-task-workspace/task-workspace-contract.json)
and [`packages/codex-adapter/task-context.mjs`](../packages/codex-adapter/task-context.mjs).
The browser submits a Task ID, a Human message, attachments and selected eligible
Context IDs. The local host validates those IDs and assembles the complete packet;
browser code never rebuilds or persists the prompt.

## Interaction hierarchy

1. **Identity and posture:** Task, owning Project or Standalone, Outcome/intent,
   DRAFT/READY/RUNNING/DONE and one bounded substate.
2. **Recommended action:** the most prominent focused control. It starts the first
   linked Thread, focuses the existing Composer, requests Human input, or preserves
   independent closeout rather than pretending a Run is an Outcome.
3. **Context Space:** short Task context, collapsed Acceptance and constraints,
   dependency/reference provenance, Evidence and Outcome posture.
4. **Context for the next Turn:** direct Task Context is always explicit; a Human
   may add or remove additional eligible project Context for one Turn. Each item
   names its Room, type, source and inclusion reason. Rooms are disclosures, not a
   second navigation graph and never a prerequisite for Task creation.
5. **Task conversation:** one persisted Codex Thread by default, with the accepted
   native renderer and Composer. Additional Threads are explicit forks/exploration,
   not Subtasks. Human messages may start a Turn, steer an active ordinary Turn,
   answer a server request, approve, interrupt or redefine future Task work.

The upper contract changes by lifecycle without becoming a form: DRAFT foregrounds
definition; READY foregrounds Start; trusted active execution foregrounds the live
conversation; NEEDS YOU foregrounds the exact Human boundary; CLOSE_OUT remains a
RUNNING/verifying stage with independent adjudication; REPLAN returns to DRAFT with
the deviation inspectable; successful Outcome is DONE. A completed Codex Turn only
means the Turn completed.

## Context packet

The host packet orders direct Ticket Context references first, then lexical,
de-duplicated Human selections. It includes at most 12 Context items and 2,400
characters of each detail; any overflow, truncation or unavailable canonical
reference is explicit. It records:

- exact Task contract, authority and source commit;
- zero-or-one Project ownership (or an explicit Standalone scope);
- expanded Context with Room/source/inclusion reason and no writeback authority;
- external References as read-only facts;
- selected Thread/Run provenance and the Human message for this operation;
- current Evidence and Outcome when they exist, plus each direct prerequisite's
  successful Outcome and the exact acceptance-linked Evidence it cited;
- source citations, empty-or-explicit conflict facts, and governed-writeback rules.

Reading another Project can only enter as an explicit read-only Reference. It never
adds writeback authority. Personal Rooms, automatic cross-Project writeback, team
scope and a global personal knowledge graph remain later contracts.

## Codex lifecycle boundary

The official app-server lifecycle is sufficient without a second Agent loop:

- `thread/start` creates the first persistent Task conversation; the first
  `thread/name/set` records a small visible Task linkage that survives even when
  the full packet exceeds Thread preview length, then `turn/start` receives the packet.
- `thread/read` renders stored history without inventing liveness;
  `thread/resume` is the explicit live subscription boundary after restart.
- after refresh/restart the host calls `thread/resume` before a new `turn/start`;
  while a regular Turn is active,
  `turn/steer` uses the exact expected Turn ID; approvals remain exact server
  requests; `turn/interrupt` yields authoritative `interrupted` state.
- an additional explicit exploration stream uses `thread/fork` or another
  packet-linked Thread. It remains a Thread, never a canonical Child Task.
- refresh/restart recovers Task linkage from the first persisted packet preview;
  Codex history never becomes the Task database.

Sources: [official Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md),
[official app-server protocol](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol),
and the pinned local 0.147.0 adapter probe.

## Review matrix and deferrals

`task-fixtures.json` provides DRAFT, READY, trusted RUNNING, NEEDS YOU, VERIFYING,
DEVIATED, DONE and Standalone carriers through the same Task Workspace DOM. Real
runtime review must additionally cover Graph focus/return, one linked Thread,
streaming/tool activity, approval/interruption, refresh/recovery, Light/Dark,
390x844, keyboard/focus, reduced motion and zero horizontal overflow.

This research does not publish the final application, approve final visuals,
create personal Rooms, invent Task containment, automatically harvest Chat into
Context, or let one Codex Turn close a VibeHub Task.
