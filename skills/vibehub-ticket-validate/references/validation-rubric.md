# Ticket semantic validation rubric

Validate the complete prospective graph. One schema-valid Ticket can still be
the wrong work unit or make the graph misleading.

## Source and candidate binding

- Confirm the candidate is tied to one current worktree source, graph digest,
  semantic-ledger digest, and exact target revisions.
- Treat source drift as a new planning fact, not a token-replacement exercise.
- Confirm creates target absent IDs and replacements preserve the observed
  full document unless the candidate intentionally changes a field.
- Load projected graph, Ticket, relation, Review, and Decision facts from one
  exact snapshot. A stale subject, expired snapshot, missing referenced Review
  document, or failed trace page makes the source inconclusive rather than
  silently complete.

## Review-driven candidate truth

- Treat a comment as non-mutating input. It may identify a defect but cannot
  itself require a field change, grant authority, or prove that a candidate is
  valid.
- For a current `ticket_edit`, compare its complete proposed replacement with
  the current Ticket and the newly authored candidate. Confirm that Planning
  reconciled fresh graph facts rather than copying the proposal mechanically.
- Require a Review-driven replacement Ticket to preserve the exact Review
  `recordRef` in provenance. Confirm that the candidate source was captured
  after the Review write; a pre-Review source token or semantic-ledger digest
  is stale.
- Validate the unchanged fresh candidate independently. The Review author,
  replacement body, or host-attested attribution is not a semantic verdict.
- Historical Review facts remain causal context only. Do not transplant a
  proposal from an old Ticket revision onto the current Ticket.

## Outcome promise

- Require one stable, independently meaningful, observable result per Ticket.
- Reject activity lists, vague aspirations, and nodes that exist only to mirror
  an implementation step.
- For a replacement, confirm the original promise remains the same. Require a
  new identity when the promised result materially changes.
- Confirm the outcome contributes to an accepted deliverable or bounded
  follow-up through real dependency paths.

## Executable handoff

Ask whether a fresh Agent with repository access but no planning conversation
can act correctly after prerequisites resolve:

- Does context preserve product intent, current facts, scope, non-goals, and
  binding approach decisions?
- Are ordinary discoverable implementation facts omitted rather than copied
  wholesale?
- Are important context references present, readable, and explained?
- Are constraints true boundaries rather than preferences disguised as rules?

A Ticket may represent a stable frontier behind a blocker. It must say what
fact will enable refinement and must not pretend unresolved implementation is
known.

## Acceptance

- Require proof of the outcome, not a restatement or a step checklist.
- Prefer observable behavior, tests, rendered experience, integration proof, or
  durable state with a clear pass/fail interpretation.
- Cover the material promise without requiring every implementation detail.
- Reject criteria that can pass while the outcome is false or fail because an
  arbitrary implementation choice differs.

## Dependency truth

The dependent Ticket authors a `depends_on` edge to a direct prerequisite.
For every edge ask:

1. Would the dependent outcome be invalid or non-executable if the target were
   absent?
2. Is the target direct, or is necessity already carried through another path?
3. Does the edge create false serialization between work that can be parallel?
4. Are all real joins present without convenience dependencies?

Reject cycles, missing endpoints, duplicate edges, redundant transitive edges,
and rationale that describes adjacency instead of necessity.

## Granularity and graph shape

- Require an independent scheduling, blocking, retry, authority, or
  verification boundary for every node.
- Fold small steps and implementation notes back into context.
- Split a node when distinct outcomes can proceed, fail, retry, or be verified
  independently.
- Reject orphan work, dead ends, duplicate outcomes, and graph branches that
  never reach an accepted deliverable.
- Keep scenario groupings derived; do not require hierarchy or one Ticket per
  human-readable scenario.

## Authority and uncertainty

Confirm that the candidate does not silently define or alter:

- user experience, core product behavior, or visual/product direction;
- accepted architecture or design principles;
- permission, external side effects, security, policy, or material risk;
- authorized scope or a material deliverable promise.

A coherent blocker Ticket may preserve such a question without answering it.
Objectively adjudicable internal engineering choices remain delegated.

Recognize human authority only from a projected current `gate_decision` whose
producer is an `authority_receipt`:

- Read the complete durable Decision document at the trace's typed
  `repo_path` target. Require its `decision_id`, exact subject, authority
  principal, decision type, and disposition to agree with the current trace
  and snapshot. Treat `delegated_boundaries`, `boundary`, `selection`, and
  `resolution_refs` as usable only from that verified document; summary text
  is never an authority scope.
- `plan_review` binds one exact graph digest. `approve_execution` covers that
  graph; `delegate_within_boundaries` covers only the recorded boundaries;
  `request_changes` requires a new candidate and does not authorize execution.
- `protected_boundary` binds one exact Ticket revision and recorded question.
  `resolve` supplies only its recorded selection; `decline` leaves the answer
  unresolved.
- Historical Decision artifacts remain inspectable but non-authoritative.
  Claimed or host-attested Review attribution is not a Decision, and a
  Decision for another graph, revision, boundary, or scope grants nothing.

Require honest Planning Fog when a blocker or discovery must resolve before
downstream detail is knowable. Allow a coarse downstream Ticket only when its
outcome is already stable and its context explicitly requires later
refinement.

## Finding threshold

Use `failed` only for defects that can change what executes, whether the
handoff succeeds, whether the graph represents real dependency, or whether
authority is crossed. Keep cosmetic phrasing and optional enrichment as
non-blocking notes. A clean report contains no invented findings.
