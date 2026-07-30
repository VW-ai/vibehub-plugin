# Ticket semantic validation rubric

Validate the complete prospective graph. One schema-valid Ticket can still be
the wrong work unit or make the graph misleading.

## Source and candidate binding

- Confirm the candidate is tied to one current worktree source, graph digest,
  and exact target revisions.
- Treat source drift as a new planning fact, not a token-replacement exercise.
- Confirm creates target absent IDs and replacements preserve the observed
  full document unless the candidate intentionally changes a field.

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

Require honest Planning Fog when a blocker or discovery must resolve before
downstream detail is knowable. Allow a coarse downstream Ticket only when its
outcome is already stable and its context explicitly requires later
refinement.

## Finding threshold

Use `failed` only for defects that can change what executes, whether the
handoff succeeds, whether the graph represents real dependency, or whether
authority is crossed. Keep cosmetic phrasing and optional enrichment as
non-blocking notes. A clean report contains no invented findings.
