# Ticket planning method

Use this method to supply planning intelligence. The graph mechanics already
enforce document shape, references, and acyclicity; this method decides what
deserves to exist.

## 1. Recognize the scene

Classify the intended change before creating nodes:

- **No durable work**: discussion or execution detail changes no future handoff.
- **Elaboration**: new detail belongs inside an existing Ticket's context,
  acceptance, constraints, or references and has no independent boundary.
- **Decomposition**: several independently schedulable or verifiable outcomes
  are required inside an already authorized deliverable.
- **Expansion**: work changes the authorized deliverable or adds a material
  outcome; require the corresponding authority.
- **Decision blocker**: a preference-bearing answer must exist before a
  dependent outcome can be executed.
- **Deviation**: execution can no longer preserve an accepted experience,
  principle, architecture, permission, risk boundary, or plan.
- **Planning Fog**: downstream detail cannot yet be stated honestly. Preserve
  the known direction and the event that will make replanning possible.

## 2. Read causal review facts

Refresh the canonical Git-backed graph and its projected trace facts before
planning. Keep one snapshot ID and its complete source identity together.
Read the graph trace plus every affected Ticket and relation trace to
completion. A read failure, expired snapshot, or page from another snapshot is
an unresolved source, not permission to continue from memory.

Use facts according to their semantic role:

- A current or historical `comment` can clarify intent, flag risk, or supply
  evidence. It does not mutate the graph and does not authorize a choice.
- A current `ticket_edit` is an attributed proposal against one exact Ticket
  revision. Follow its typed repository-path target to the durable Review
  document, compare the complete proposed replacement with the freshly
  inspected context package and graph, and decide the change semantically.
  Never submit the replacement mechanically.
- When a proposed edit remains truthful and authorized, author a new complete
  Ticket candidate from the fresh source and retain the exact Review
  `recordRef` in `provenance_refs`. The candidate may differ from the proposal
  when fresh facts require it; explain the reconciliation.
- A Decision is authority evidence only while its exact subject is current and
  its projected trace is a `gate_decision` produced by an
  `authority_receipt`. Historical Decision artifacts remain discoverable but
  cannot authorize the current graph or Ticket revision.
- Follow the current Decision trace's typed `repo_path` target and read the
  complete durable Decision document before using it. Confirm its
  `decision_id`, exact subject, authority principal, decision type, and
  disposition against the trace and current snapshot. Use
  `delegated_boundaries`, `boundary`, `selection`, and `resolution_refs` only
  from that verified document. A rendered summary or rationale is not a scope
  grant.
- A current `plan_review` with `approve_execution` covers only the recorded
  graph. `delegate_within_boundaries` covers only its listed boundaries.
  `request_changes` triggers fresh planning and validation; it is not a patch.
- A current `protected_boundary` with `resolve` supplies only its recorded
  selection for that exact boundary and Ticket revision. `decline` supplies no
  answer, so the blocker or honest Planning Fog remains.

Review attribution, including host-attested attribution, is not human
authority. If facts conflict, their subject is stale, the durable Review
document is missing, or the source changes during reconciliation, stop and
surface the uncertainty. Never rebind a Decision or proposal to a newer
revision by replacing hashes or source tokens.

Review facts are optional causal inputs, not mandatory workflow stages.
Agent-owned elaboration and decomposition inside delegated boundaries still
use fresh planning, independent validation, and the public patch directly.

## 3. Backchain

For each observable deliverable, ask:

1. What result or proof must exist immediately before this outcome can be
   established?
2. Which prerequisites can proceed in parallel?
3. Where do paths join?
4. Which choice is human-owned, and which has objective engineering criteria?
5. Where does current evidence already satisfy a presumed prerequisite?

Stop a path at current truth, executable work, a genuine decision blocker, or
honest Planning Fog. A coarse downstream Ticket may follow a blocker when its
outcome is already stable; say that its context must be refined from the
decision before execution. Do not guess its unresolved implementation.

## 4. Forward normalize

Read from current truth toward each deliverable:

- merge duplicate outcomes;
- remove work that reaches no accepted outcome;
- remove dead ends and convenience edges;
- remove transitive dependencies already implied by a direct path;
- keep parallel paths parallel;
- keep a join only where every incoming result is truly necessary;
- move step lists and small implementation details into Ticket context;
- verify every node has an independent boundary.

The authored relation direction is: a dependent Ticket `depends_on` its direct
prerequisite. The execution projection therefore flows from prerequisite to
dependent and answers “what can unlock next?”

## 5. Write an executable context package

For every Ticket:

- **Outcome**: state one stable, observable result rather than an activity list.
- **Context**: state the current facts, scope, relevant approach decisions,
  non-goals, and what a fresh Agent must know to act correctly.
- **Acceptance**: state observable proof of the outcome. Prefer tests,
  inspectable behavior, rendered experience, or durable state over prescribed
  implementation steps.
- **Constraints**: include only binding limits and protected principles.
- **Context refs**: name the smallest sufficient repository or knowledge
  sources and why each matters.
- **Relations**: name direct prerequisites and explain necessity when it is not
  obvious.
- **Provenance refs**: preserve the evidence or authority that caused the
  Ticket to exist. When a current edit proposal caused the revision, include
  its exact Review record reference rather than only paraphrasing its text.

Context must be bounded but sufficient. A fresh Agent may discover ordinary
local implementation facts; it must not need to reconstruct product intent or
the plan from chat history.

## 6. Route authority

Keep technical choices delegated when success can be judged against accepted
criteria. Require human involvement when the plan would define or alter:

- user experience, core product behavior, or visual/product direction;
- an accepted architecture or design principle;
- permission, external side effects, security, policy, or material risk;
- the authorized scope or a material deliverable promise.

Represent a known unresolved choice as a blocking Ticket with an observable
decision outcome. Let downstream work depend on it. Do not encode a preferred
answer as if it were already authorized.

Initial plan review and protected decisions are execution gates. Passing
Ticket definitions enter the current graph directly; there is no ordinary
activation ceremony.

Currentness is exact, not thematic. A graph Decision does not authorize a
later graph digest, and a protected Decision does not authorize a later Ticket
revision or a different boundary. Keep historical facts for explanation while
deriving no current permission from them.
