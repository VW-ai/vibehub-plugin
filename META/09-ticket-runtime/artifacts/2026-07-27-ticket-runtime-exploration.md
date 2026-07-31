# Ticket Runtime exploration — 2026-07-27

> Status: non-normative exploration artifact. This file preserves reasoning,
> distinctions, tensions, and possible directions. Only promoted specs are
> canonical product authority.

## Provenance

- Primary discussion: Codex session
  `019fa1de-8499-7e23-9576-c29db4d0168b`.
- Trigger: a conversation with Victor about planning a project into a complete
  set of human-visible and AI-executable tickets before execution begins.
- Prior synthesis: `MyLibrary/工作记录/July/2026-7-26.md`, section
  `[[Vibehub]]`.
- Current continuation: create a dedicated branch, preserve the valuable
  intermediate reasoning, settle the design one question at a time, and then
  use the resulting model to transform the Plugin.

The full transcript is deliberately not copied into the repository. It remains
cold provenance. This artifact keeps the reusable conceptual content without
making conversational repetition or assistant proposals canonical truth.

## The original insight

VibeHub has spent most of its design effort answering:

> What should an Agent know, and how does that knowledge remain durable?

The Ticket direction adds a second question:

> Given what the system knows and what the user wants, what work should happen
> next, in what order, under what authority, and with what proof of completion?

The strongest version of the idea is not “add Jira to an Agent.” Planning
compiles settled intent and current semantic context into a reviewable work
graph. The runtime consumes ready work units. Humans review objectives,
decisions, graph changes, outcomes, and evidence at the highest reliable
abstraction level.

## Candidate closed loop

```text
Semantic State
Intent / Feature / Decision / Constraint / Contract
        ↓
Planning
        ↓
Plan + Ticket Graph
        ↓
Ready Ticket
        ↓
Run
        ↓
Artifact + Evidence
        ↓
Outcome / Semantic Closeout
        ↓
New Semantic State
```

This is better understood as two connected lifecycles:

- semantic lifecycle: what the system currently recognizes as durable truth;
- operational lifecycle: what work is planned, running, blocked, verified, or
  complete.

Ticket completion must not automatically rewrite semantic truth. It can produce
evidence and a closeout proposal; the existing knowledge lifecycle still
governs promotion.

## Candidate object distinctions

These distinctions were repeatedly useful, but they are not yet a reviewed
ontology:

- Intent: a desired change adopted from the user or other authorized source.
- Planning: the semantic compilation process.
- Plan: one versioned explanation and boundary for a planning result.
- Ticket Graph: the executable dependency structure produced by planning.
- Ticket: a durable, bounded, independently schedulable and verifiable work
  contract.
- Workflow: a reusable method for how a class of work is normally performed
  and verified.
- Run: one attempt to execute a Ticket under a particular context snapshot,
  workflow version, executor, workspace, and authority.
- Session: a host interaction container; not necessarily a Run identity.
- Workspace/branch: an execution substrate used by some Runs; not a universal
  work identity.
- Gate: a specific decision, approval, or action that cannot proceed
  autonomously.
- Artifact: a produced result.
- Evidence: the basis for claiming an acceptance condition is satisfied.
- Outcome: the evaluated result of a Ticket, including follow-up and semantic
  effects.

The largest unresolved naming conflict is the active Task model. Existing META
defines Task as a durable outcome and Run as an execution episode. The proposed
Ticket often occupies almost exactly the same semantic space, but with a much
stricter schema and lifecycle. The design must decide whether Ticket supersedes
Task or whether both have distinct durable roles.

## What “strict Ticket” was intended to mean

The discussion identified three kinds of hardness:

1. Semantic hardness
   - Is the objective clear enough?
   - Is the work split at a meaningful boundary?
   - Do the acceptance conditions prove the intended result?
   - Is human judgment exposed at the correct point?

2. Schema hardness
   - Are identity, objective, context bindings, dependencies, scope,
     constraints, acceptance, execution policy, gates, and verification
     explicit?
   - Do every referenced Spec and revision exist?
   - Is the graph structurally valid?

3. Runtime hardness
   - A blocked Ticket cannot run.
   - A stale writer cannot mutate state after handoff.
   - A human gate cannot be bypassed.
   - A Ticket cannot become done without required evidence.
   - Graph mutation leaves a versioned, reviewable record.

A Ticket is not a prompt. A prompt is a Run-specific projection compiled from:

```text
Ticket + Workflow + current bounded context + runtime policy
```

## Context binding and Feature Room

Feature Room remains the first and currently most mature semantic-state
provider. A Ticket should reference stable Spec identities and revisions rather
than copy large summaries into its body. At Run time, a context compiler can
combine:

- explicit Ticket references;
- affected Features;
- governing active Specs;
- dependency artifacts;
- the current repository snapshot;
- Workflow-specific requirements.

This should produce a bounded context packet. Binding exact revisions makes it
possible to detect drift, explain why a Ticket exists, connect evidence back to
its governing contract, and determine whether replanning is required.

The Ticket schema should eventually allow other providers, but that
generalization must not weaken the first Feature Room integration.

## Human-visible and execution-visible granularity

The discussion distinguished:

- outcome-level work that a person can review and accept;
- bounded execution work that an Agent can independently run, retry, and
  verify;
- internal steps and traces that normally stay inside a Run.

An internal step should become a child or follow-up Ticket only when it needs
independent scheduling, context, authorization, retry, verification, a
different executor, or when it blocks other work. The exact representation of
these levels remains open.

## Product-surface direction

The proposed default human surface moved away from Feature Map navigation:

```text
Objective
Ticket Graph
Ready / Running / Waiting for You / Blocked / Done
Artifacts
Evidence
Graph changes
```

Feature Mapping and Canonical Specs remain internal context infrastructure and
an optional inspector. A Ticket-specific explanation should still show why the
work exists, which Specs govern it, what it affects, and what requires human
attention.

The discussion also identified a naming overlap: Feature Mapping’s `intent`
field is a non-canonical capability-purpose summary, while Canonical Intent
Specs have identity, revision, evidence, provenance, and lifecycle. Renaming
the mapping field to `purpose_summary` was supported, but is not changed by
this artifact.

## Physical architecture explored

The strategic candidate was:

```text
App
  human control and intervention surface
        ↓
Local Runtime / shared domain core
  Ticket graph, state machines, run supervision, verification,
  workspaces, artifacts, authority, single writer
        ↓
Host adapters
  Codex app-server / Claude SDK or CLI / future executors
        ↕
Agent Pack / Plugin
  skills, semantic planning methods, context tools, execution methods,
  host-originated entry points
```

The tactical path was different: implement the minimum Ticket loop in the
existing Plugin repository first, keep the domain boundary extractable, and use
that loop to develop and test its future product form.

These statements expose a real design question rather than a contradiction to
paper over: what is the first canonical writer, and which parts can be
implemented in Plugin/Core now without re-creating a second state machine
later?

## Existing implementation patterns reviewed in the source discussion

The earlier session inspected these patterns:

- Vibe Kanban: local server and web UI, with Task → Workspace → Session →
  ExecutionProcess separation, worktree management, executor adapters, SQLite
  structured state, and file-based logs.
- Crystal/Nimbalyst: Electron main process as controller, SQLite/worktrees, and
  PTY/JSON CLI adapters.
- Codex app-server: structured thread/turn/item protocol, approvals,
  interruption, resume, and streamed events for rich clients.
- Linear: issue and coordination control plane delegating execution to an
  external Agent runtime.

These findings should be re-verified before they become current market claims.
Their architectural use here is narrower: Plugin does not need to be the
transport or process supervisor, and Ticket, Workspace, Session, and process
should not collapse into one object.

## Product boundary explored

VibeHub should not win by rebuilding:

- sprint and roadmap management;
- team backlog and capacity;
- a general label/comment/notification system;
- worktree, terminal, diff, or PR tooling as the primary differentiator.

The proposed differentiator is the semantic-to-operational loop:

```text
durable intent and Specs
→ strict Ticket compilation
→ bounded context and authority
→ Agent execution
→ verification and evidence
→ semantic closeout
```

Linear, Jira, GitHub, Notion, MyLibrary, and conversations can eventually be
upstream demand or context sources. Codex and Claude can be downstream
execution systems.

## Tensions with current active META

No new proposal should silently overwrite these current authorities:

- `intent-project-001`: plugin-first local runtime, optional App.
- `intent-context-to-action-001`: host Agent surfaces remain primary; VibeHub
  augments rather than becomes a development control plane.
- `decision-workbench-011`: headless Plugin/Runtime is independently usable;
  App is an optional reader/intervention client.
- `decision-workbench-013`: Task is the durable outcome; Run owns execution
  authority; branch/session/process are evidence rather than identity.
- `decision-project-028` and `decision-project-029`: durable semantic authority
  belongs to reviewed Git/YAML; SQLite retains operational authority and
  projections.

The Ticket Runtime may preserve, refine, or supersede parts of these decisions.
Each effect requires an explicit reviewed spec relation.

## Recommended artifact placement

The project needs more than a single summary document:

1. Raw source
   - Keep session/transcript as cold provenance.
   - Do not make it a normal context input or duplicate it into Git.

2. Exploration artifacts
   - Keep high-fidelity synthesis in this room’s `artifacts/`.
   - Preserve options, contradictions, examples, and discarded paths.
   - Mark every artifact non-normative.

3. Canonical specs
   - Split independently reviewable claims into `specs/`.
   - Ingest and Wayfind outputs stay draft.
   - Only explicit user review promotes a decision or contract.

4. Execution ledger
   - Use `progress.yaml` only after decisions are clear enough to build.
   - Record milestones and evidence, not open design questions.

This separation lets loop engineering alternate safely:

```text
explore → synthesize → decide → specify → build → observe → revise
```

without losing the exploration or confusing it with authority.

## Immediate next step

Work the decision map one frontier ticket at a time. The first decision should
freeze the durable work-unit vocabulary: whether Ticket replaces Task or sits
at a distinct level. That answer will reshape the contract, lifecycle,
context-binding, storage, and migration questions that follow.
