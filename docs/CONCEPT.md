# VibeHub product concept

## One unit: the development cycle

VibeHub turns a concrete development request into a Git-native Ticket cycle.
The Ticket carries the desired outcome, acceptance criteria, constraints,
governing Context, and direct dependencies. Execution adds acceptance-linked
Evidence. A separate Agent writes the Outcome. Only a successful Outcome
unlocks direct dependents.

The user's single entry is:

> Start this with VibeHub.

The existing Ticket Plan Skill owns that entry. If the repository has not been
set up, it first uses VibeHub Setup, respects any existing documentation or
memory system, and then resumes planning the current deliverable. Users do not
need to select a Skill or remember a graph command.

## Ticket drives; Context survives

A Ticket exists when there is executable work. Context exists only when a
decision, intent, constraint, contract, convention, or reusable explanation
must survive beyond the current task.

Some Context is golden truth rather than a claim about it: a game's rule set
or asset contracts, a system's architecture graph, an interface schema. That
is `type: authority`. It names the territory it governs, the canonical
artifacts that are the source of truth, the ordered update rules an Agent
follows before changing one, and the validation checks that keep
implementation consistent. Planning attaches governing authority to a Ticket
automatically; execution reads it before touching that territory; a change
to a canonical artifact is recorded as a `change` Context, and closeout is
refused while that record is missing. No approval service exists: the
discipline is the rules, and a person decides only when the authority itself
says `approval: human`.

“Record this”, “remember this”, and “沉淀一下” normally create Context, not a
Ticket. If one conversation contains both durable meaning and work, VibeHub
captures one Context item and creates a Ticket that references it. It does not
turn every conversation into memory.

## One lifecycle behind the entry

- Planning presents **Execution**: the new Ticket and its dependency path.
- Routine execution stays quiet.
- A protected human boundary presents **Contract** and waits for the exact
  decision.
- Independent closeout presents **Log**: Evidence, Outcome, and what unlocked.
- PR or explicit review presents the current graph.

Presentation never becomes approval authority. The checked-in documents remain
truth, and the same facts can fall back to the Agent conversation.

Acceptance authority defaults to the Agent. One criterion may explicitly use
`authority: human` when product direction or another acceptance judgment is
reserved to a person. Host permission to perform an already-authorized action
does not by itself change the decision owner. A human-authority criterion needs
referenced Evidence with `origin: human` before successful closeout; Agent
advice cannot substitute for the decision. These fields are lightweight Git
provenance, not an identity or approval service, and they never change
dependency status.

## Goals, Epics, and Tickets

A **Goal** records the intended benefit and success criteria. An **Epic** groups
a coherent capability under exactly one Goal. A **Ticket** is independently
executable and verifiable, optionally owned by one Epic. A Ticket's Goal is
derived through that Epic; standalone Tickets remain valid.

A PRD can produce several Goals and Epics. Containment describes scope, while
`depends_on` remains a separate execution prerequisite. Parent progress counts
completed Tickets without declaring the Goal achieved. See the
[planning hierarchy contract](../skills/vibehub-core/contracts/planning-hierarchy.md).

## Durable documents

```text
.vibehub/
  goals/<goal-id>.yaml
  epics/<epic-id>.yaml
  rooms/<room-path>/room.yaml
  rooms/<room-path>/<context-id>.yaml
  tickets/<ticket-id>.yaml
  evidence/<ticket-id>/<evidence-id>.yaml
  outcomes/<ticket-id>/<outcome-id>.yaml
```

They use a deterministic JSON-compatible YAML 1.2 subset and shared schemas.
Agents make semantic decisions; dependency-free scripts validate documents and
project the read-only graph. Git owns branches, history, rollback, conflicts,
and review.

## Intentionally lightweight

VibeHub has no required Core package, global CLI, MCP server, SQLite database,
native module, daemon, hook cadence, Run lease, compiled Context copy,
attestation service, persistent digest cache, or background conversation
capture. The local graph uses a narrow foreground loopback launcher and exposes
no write endpoint.

That boundary is deliberate: memory products preserve conversation; VibeHub
preserves the development cycle. Missing capabilities are rebuilt only when
real use demonstrates a gap.

## Ticket state and Agent sessions

Ticket state answers whether work is ready, blocked, awaiting review, or done.
Local Agent sessions independently show who is associated with a Ticket, their
reported state, and last report/activity time. Explicit reports and a
foreground process wrapper provide observations; expired reports become
disconnected. Process completion does not close Tickets. Sessions stay in
worktree-specific Git metadata and do not travel with the repository.

See the [session integration contract](../skills/vibehub-core/contracts/agent-session.md)
for reporter and command-wrapper usage. Native host sessions must explicitly
integrate; the Workbench does not automatically discover them.
