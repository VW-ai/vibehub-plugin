# VibeHub Harness product logic

Status: low-fidelity product authority for the next prototype. It defines what
the application is and how its main objects behave. It does not authorize a
production backend or settle high-fidelity visual design.

## Product thesis

VibeHub Harness is where a person turns an intention into bounded work, lets an
Agent carry most of that work, and regains attention only when judgment or
authority is actually needed.

The application starts from the familiar Codex desktop interaction model:
normal Chat, capable models, tools, progress, approvals, and a persistent
Composer. VibeHub changes the product semantics around that foundation:

- **Ticket is the durable work contract.** It survives changes of conversation,
  Agent, model, repository, and Run.
- **Run is where most work happens.** It carries trusted progress, tool use,
  artifacts, failures, interruption, and Evidence.
- **Chat is the thinking and control surface.** It is unconstrained before a
  Ticket exists and remains available to steer, question, or interrupt a Run.
- **Attention is scarce.** The application is organized around what needs the
  person, not around every event the Agent emits.
- **Context is activated, not ambiently harvested.** A small inspectable packet
  may inform a turn or Ticket; transcripts and Outcomes do not silently become
  durable truth.

In one sentence: **Ticket Graph outside; Ticket throughout; Chat before and
around; Run during.**

## The two-level application

The first frame is the **Ticket Graph**, not a conversation, inbox, project
dashboard, or one Ticket's execution state. It presents the current causal
system of work: every visible Ticket, direct dependency, blocker, unlock,
operational state, human-attention signal, and trusted Active-Run presence.

Selecting a Ticket enters its **Ticket Workspace**. That second level contains
the phase-specific Explore, Ready, Running, Needs you, Review, and Done surfaces
defined below. Returning from any of them restores the same graph focus.

```text
Ticket Graph
  ├─ Ticket A Workspace → Explore / Ready / Run / Attention / Review / Done
  ├─ Ticket B Workspace → Explore / Ready / Run / Attention / Review / Done
  └─ Ticket C Workspace → Explore / Ready / Run / Attention / Review / Done
```

The Graph therefore explains the system of work; the Ticket Workspace explains
and controls one bounded unit of work.

## Product objects

| Object | Product meaning | Authority |
| --- | --- | --- |
| Workspace | The selected V1 Git project and its local VibeHub Context | Git and local project configuration |
| Conversation | A normal Agent interaction stream | DSH Session log |
| Branch | An explicit fork from a closed conversation boundary | DSH parent/child Session identity plus VibeHub labels |
| Context | Durable claims explicitly activated for a turn or Ticket | VibeHub Room tree |
| Reference | A pointer to source reality: conversation node, file, document, Workspace, or external system | Referenced source |
| Ticket | One bounded desired outcome with acceptance, constraints, dependencies, and References | Canonical VibeHub Ticket |
| Run | One resumable execution attempt by a replaceable Agent | Trusted executor events projected through DSH |
| Attention request | An exact question, approval, missing input, failure, or decision owned by one Run step | Run event; never inferred from Ticket status |
| Evidence | Acceptance-linked proof produced or observed during execution | Canonical VibeHub Evidence |
| Outcome | Independently adjudicated completion record | Canonical VibeHub Outcome |

These objects are related but not collapsed. A Ready Ticket is not a running
process. A completed Run is not an accepted Outcome. An Agent statement is not
Evidence. Context activation is not automatic writeback.

## Two ways work begins

### Think first

1. Start a normal Chat with no workflow constraint.
2. Explicitly fork a useful assistant turn when parallel exploration is useful.
3. Enter either Branch, Compare siblings, or Bring Back a synthesis as a new
   turn while preserving both sources.
4. Optionally activate a small Workspace Context packet for the next turn.
5. Preview a Ticket from the current branch and its References.
6. Keep chatting if the outcome is still ambiguous; create the Ticket only
   when it is bounded.

### Act first

1. Describe the desired outcome directly from New task or capture.
2. The Agent asks only for boundaries that materially affect execution.
3. Optionally activate scoped Workspace Context.
4. Preview the proposed Ticket, inspect readiness, then create it.

Both paths converge on the same Ticket and execution loop. “Act first” is not a
second workflow engine; it is a shorter way to reach a bounded contract.

## The complete loop

```text
Explore → Draft Ticket → Ready → Start → Queued / Running
                                      ↘ Needs you ↗
                                      ↘ Failed / Retry
                              → Review → Done
                                         ↘ Reopen / Follow-up
```

Ticket lifecycle and Run lifecycle remain separate:

- Ticket: `draft → ready → blocked → in review → done / reopened`
- Run: `queued → running → waiting for human → failed / cancelled / completed`
- Attention: `none → requested → answered / dismissed`

The interface may summarize these axes into human language, but the underlying
state must remain honest.

## Default surface by phase

The application keeps one frame and changes the dominant center surface. The
Composer never disappears.

| Phase | Dominant center surface | Primary human action | Composer role |
| --- | --- | --- | --- |
| Explore | Normal Chat and explicit branch lineage | Ask, fork, compare, bring back, activate Context, craft Ticket | Full conversation |
| Ready | Ticket contract: outcome, acceptance, constraints, References, readiness | Refine or Start | Ask or refine the contract |
| Running | Trusted Run: current step, recent work, tools, files, tests, artifacts | Observe, steer, pause, interrupt | Steer the Agent or ask for status |
| Needs you | Exact request at its owning Run step, with consequence and bounded choices | Decide, approve, provide input, or cancel | Discuss the request without losing the Run |
| Review | Result, change summary, acceptance-linked Evidence, unresolved gaps | Accept closeout or request revision | Ask about the result or request changes |
| Done | Outcome, Evidence trail, Context proposals, follow-up paths | Reopen, create follow-up, govern writeback | Start the next bounded action |

Chat history is still reachable in every phase, but it is not forced to occupy
the dominant surface while the Agent is doing substantial work.

## Graph, navigation, and attention

The Ticket Graph is the primary navigation for committed work. It uses the
existing VibeHub causal Workbench grammar:

- left-to-right causal rank by default;
- direct dependency edges and explicit fork/join geometry;
- operational state on every Ticket card;
- human attention as an orthogonal card signal, never as another lifecycle;
- trusted Active-Run presence only when a Run source exists;
- current work by default, with history, Room, search, focus, and causal-cone
  filters available progressively;
- selection and entry preserve graph context instead of replacing it with an
  unrelated chat route.

`Needs you`, `Active`, `Ready`, `Review`, `Exploring`, and `Done` remain useful
summary counts and filters. They must not replace the graph with six isolated
lists, because lists hide why work is blocked and what completion unlocks.

The sidebar holds stable product destinations such as Tickets, Chats, Rooms,
Automations, Skills, and engine settings. Recent Chat may appear there, but
committed Tickets are found and understood primarily through the graph.

Every Run, approval, conversation, or Evidence item is entered through its
owning Ticket rather than becoming an unrelated inbox object.

## Interaction laws

1. **No compulsory workflow in Chat.** Skills and protocols can be invoked by
   explicit controls; the user does not need to know their names.
2. **Ticket becomes primary after commitment.** Once created, it remains the
   stable identity through Start, execution, attention, review, and closeout.
3. **Execution earns screen space.** Running work shows the current step and
   meaningful changes, not a decorative spinner or an undifferentiated log.
4. **Attention is exact.** “Needs you” names what is blocked, why, the available
   choices, and what each choice changes.
5. **Evidence is acceptance-shaped.** Proof appears beside the criterion it
   supports and never auto-closes the Ticket.
6. **Context is visible and reversible.** Activation is scoped; writeback is a
   proposal with provenance and governance.
7. **Replaceable intelligence.** DSH supplies the extensible Harness; Codex or
   another capable Agent may execute. VibeHub owns the work contract and loop.
8. **Codex is the interaction baseline, not a skin target.** V1 retains its
   quiet desktop grammar while validating VibeHub semantics. High-fidelity
   visual identity is a later owner-reviewed pass.

## V1 boundary

V1 is a local browser application for one selected Workspace. It may use mocked
state while the product loop is reviewed. It does not include cross-repository
coordination, cloud accounts, collaboration, an automatic personal knowledge
graph, a native wrapper, or a second canonical database.

The DSH integration must preserve Sessions, models, tools, permissions,
approvals, commands, plugins, and user overrides. VibeHub may replace visible
shell ownership only when it deliberately recreates the required extension
seats.

## Longer-term direction

After the single-Workspace loop earns daily use, the same attention model can
span many Workspaces and project-independent Tickets. A personal Context layer
may resolve relevant knowledge across work and life, while each project keeps
its own specialized Room ontology. Organization systems remain References or
sync sources; the person's Ticket remains distinct because personal priority,
Context, executor choice, and attention boundaries differ.

The future product is therefore not “one larger project dashboard.” It is a
person-centered action and attention system whose first credible slice is an
excellent single-Workspace Agent Harness.
