# 09-ticket-runtime — Ticket Runtime

> Provisional destination: turn durable intent and semantic context into a
> reviewable, executable Ticket Graph, then dogfood the smallest trustworthy
> loop inside the existing Plugin before committing to the final App/Runtime
> product shape.

- **Intent**:
  [`specs/intent-ticket-runtime-001.yaml`](specs/intent-ticket-runtime-001.yaml)
- **Exploration artifact**:
  [`artifacts/2026-07-27-ticket-runtime-exploration.md`](artifacts/2026-07-27-ticket-runtime-exploration.md)
- **Artifact policy draft**:
  [`specs/convention-ticket-runtime-artifacts-001.yaml`](specs/convention-ticket-runtime-artifacts-001.yaml)

## What lives here

This room is the planning and authority boundary for the proposed Ticket
Runtime. It preserves the reasoning that led from context management to an
executable work graph, charts the unresolved product and domain decisions, and
will eventually hold the reviewed Ticket/Plan/Run/Gate/Outcome contracts.

It does not silently rewrite the active Task/Run, plugin-first, App, or storage
decisions in older rooms. A new decision changes those authorities only after
it is reviewed, promoted, and explicitly related to or used to supersede the
existing spec.

## Material policy

| Layer | Location | Authority |
|---|---|---|
| Raw conversation and tool trace | Codex session / external work log | Cold provenance; not checked into META |
| Exploration synthesis | `artifacts/` | High-fidelity but non-normative |
| Intent, decision, constraint, contract | `specs/` | Draft until explicitly promoted |
| Execution milestones and evidence | `progress.yaml` and linked artifacts | Added only after the relevant design decisions are clear |

## Decisions so far

No Ticket Runtime design decision has been promoted yet. Existing active specs
remain authoritative while this map is worked.

## Frontier

These questions are currently unblocked:

- [decision-ticket-work-unit-001] Does Ticket replace the formal Task
  primitive, or do Task and Ticket represent different durable levels?
- [decision-ticket-runtime-boundary-001] Which responsibilities and canonical
  writes belong to Plugin, shared Core/Local Runtime, and App in the first
  dogfood slice?

## Blocked

- Ticket contract is blocked by the Ticket/Task work-unit decision.
- Context binding, graph lifecycle, Workflow role, and closeout depend on a
  stable Ticket contract.
- Storage topology depends on both the runtime ownership boundary and the
  durable/operational meaning of Ticket records.
- The first implementation slice depends on the preceding contracts; it must
  not become the place where unresolved ontology is accidentally decided in
  code.

## Not yet specified (wayfind)

- How the future user-facing Ticket Graph should project or replace the current
  territory/task Workbench UX.
- How non-coding semantic providers such as MyLibrary should satisfy the same
  context-binding contract.
- When the Local Runtime becomes a separately packaged process rather than a
  library boundary inside this repository.
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
