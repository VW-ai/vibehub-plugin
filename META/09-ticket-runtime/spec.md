# 09-ticket-runtime — Ticket Runtime

> Provisional destination: turn durable intent and semantic context into a
> machine-validated, executable Ticket Graph, then dogfood the smallest
> trustworthy loop inside the existing Plugin before committing to the final
> App/Runtime product shape.

- **Intent**:
  [`specs/intent-ticket-runtime-001.yaml`](specs/intent-ticket-runtime-001.yaml)
- **Exploration artifact**:
  [`artifacts/2026-07-27-ticket-runtime-exploration.md`](artifacts/2026-07-27-ticket-runtime-exploration.md)
- **Artifact policy**:
  [`specs/convention-ticket-runtime-artifacts-001.yaml`](specs/convention-ticket-runtime-artifacts-001.yaml)

## What lives here

This room is the planning and authority boundary for the proposed Ticket
Runtime. It preserves the reasoning that led from context management to an
executable work graph, charts the unresolved product and domain decisions, and
will eventually hold the canonical Ticket/Plan/Run/Gate/Outcome contracts.

It does not silently rewrite the active Task/Run, plugin-first, App, or storage
decisions in older rooms. A new decision changes those authorities only after
its required authority gate is resolved and an active Spec explicitly relates
to or supersedes the existing Spec.

## Material policy

| Layer | Location | Authority |
|---|---|---|
| Raw conversation and tool trace | Codex session / external work log | Cold provenance; not checked into META |
| Exploration synthesis | `artifacts/` | High-fidelity but non-normative |
| Intent, decision, constraint, contract | `specs/` | Canonical and active after machine validation; uncertainty and human gates are explicit |
| Execution milestones and evidence | `progress.yaml` and linked artifacts | Added only after the relevant design decisions are clear |

`active` means that a Spec is part of the live knowledge layer. It does not mean
that every question mentioned by the Spec is resolved or that a human approved
the text. Temporary authoring drafts are non-canonical; unresolved choices
belong in active Decision Tickets explicitly tagged `open`.

## Decisions so far

- [decision-ticket-work-unit-001] (active) Ticket is the only canonical durable
  work unit; outcome and execution granularity use the same Ticket contract
  family, while `task` remains ordinary or compatibility vocabulary.
- [decision-ticket-contract-001] (active) Ticket Contract v0 binds a stable
  outcome to one versioned Ticket definition, progresses through three
  intelligence handoffs under independent validation, uses flat verifiable
  acceptance, and derives maturity and operational state from linked facts.
- [decision-ticket-runtime-boundary-001] (active) Core owns the one canonical
  Ticket implementation; composable Skills own semantic intelligence, CLI/MCP
  are thin peers, the first slice is in-process, and App/daemon remain clients
  or hosts of the same Core.
- [decision-ticket-intelligence-loop-001] (active) Human-understandable
  scenarios constrain and review one typed Ticket Graph without becoming a
  second entity or hierarchy; the Agent composes intelligence by scene,
  proceeds under delegated authority, and escalates experience/principle
  changes or deviations.
- [decision-ticket-review-surface-001] (active) The project review surface is
  one complete direct-unlock Ticket Graph with stable pan/zoom layout, scenario
  review lenses, in-situ authority/deviation/proof signals, and a docked
  progressive Inspector whose comments and edits remain Core proposals.

## Planning conventions

- [convention-ticket-backchain-forward-normalize-001] Ticket shaping
  backchains necessary proof paths from observable outcomes, then normalizes
  forward from current facts to remove orphan, duplicate, redundant, and
  falsely serialized work before proposing the graph.

## Frontier

These questions are currently unblocked:

- [decision-ticket-context-binding-001] How does a Ticket declare and bind
  semantic context without freezing a giant Run prompt?
- [decision-ticket-graph-lifecycle-001] How may planning and execution
  elaborate, decompose, propose, and tend the Ticket Graph?
- [decision-ticket-workflow-role-001] Is Workflow a reusable method, a
  versioned intelligence asset, or part of the graph?

## Blocked

- Closeout remains blocked on context binding and graph lifecycle.
- Graph lifecycle must also decide how human planning gates allow a partial
  graph with directional fog beyond blocker Tickets, rather than fabricated
  downstream Tickets.
- Storage topology remains blocked on closeout semantics.
- The first implementation slice depends on the preceding contracts; it must
  not become the place where unresolved ontology is accidentally decided in
  code.

## Not yet specified (wayfind)

- How non-coding semantic providers such as MyLibrary should satisfy the same
  context-binding contract.
- How planning quality will be evaluated by comparing the initial graph with
  the execution graph.

## Out of scope (wayfind)

- Rebranding, domain selection, and packaging of the future closed-source App
  are not required to prove the first Ticket loop.
- Sprint, roadmap, team capacity, labels, and general project-management
  features belong to upstream systems.
- Full Linear/Jira/GitHub bidirectional synchronization is deferred.
- Unattended scheduling, remote workers, and the Server/Team control plane are
  deferred until the local manual-control loop is proven.
- [decision-ticket-runtime-boundary-001] A separately packaged Local Runtime
  daemon is deferred until concurrency, subscriptions, background work, or
  multi-client coordination justify it.
