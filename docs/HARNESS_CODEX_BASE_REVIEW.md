# VibeHub Harness low-fidelity review

Status: product-logic prototype for owner review. It deliberately uses the
Codex interaction baseline and does not claim high-fidelity visual parity or a
finished VibeHub visual identity. The earlier dark custom shell and additive
DSH Spike remain rejected as product UI.

The authority for this pass is [HARNESS_PRODUCT_LOGIC.md](HARNESS_PRODUCT_LOGIC.md).

## What this version is testing

The prototype tests one two-level relationship:

> Ticket Graph outside; Ticket throughout; Chat before and around; Run during.

- The application opens on the causal Ticket Graph.
- Clicking a Ticket enters that Ticket's phase-specific Workspace.
- `← Tickets` returns to the graph rather than to a chat-history list.

- Before commitment, normal Agent Chat is the dominant surface.
- After commitment, Ticket becomes the stable identity.
- While work is active, trusted Run activity gets most of the center surface.
- Chat remains available below to steer, question, or interrupt.
- Attention returns only for a specific decision, permission, failure, or
  missing input owned by one Run step.
- Review is acceptance- and Evidence-shaped; a completed Run does not
  auto-close the Ticket.
- Done exposes the Outcome and governed Context writeback proposals.

## Information architecture

The Ticket Graph is the home surface for committed work. It keeps dependencies,
blockers, unlocks, Ticket states, human attention, and trusted Runs visible in
one causal picture. `Needs you`, `Active`, `Ready`, `Review`, and `Done` are
graph signals and filters—not separate lists that destroy causality.

The left sidebar provides stable destinations (`Tickets`, `Chats`, `Rooms`) and
recent uncommitted conversations. It no longer presents committed Tickets as a
flat attention queue.

The low-fi phase strip under the header is a prototype-only control. It lets a
reviewer inspect every phase without waiting for mocked execution. It is not a
proposal for permanent navigation.

Within one owning Ticket, the center surface changes by phase:

- `Explore`: normal Chat, Fork, Branches, Compare, Bring Back, Context, and
  Ticket craft.
- `Ready`: desired outcome, acceptance, readiness, References, and Start.
- `Running`: current step, meaningful recent work, tools, files, tests, and
  Run controls.
- `Needs you`: the exact question, why it blocks progress, bounded choices,
  and the owning step.
- `Review`: result, acceptance-linked Evidence, request revision, and closeout.
- `Done`: accepted Outcome, Evidence history, governed Context proposals,
  reopen, and follow-up.

## Walkthrough

The prototype opens on the `Ticket Graph`. It establishes the system of work
before entering one Ticket.

1. Inspect dependencies, forks, joins, blockers, attention, and Active Run on
   the graph. Open the Active `Define the Harness product loop` Ticket.
2. Confirm that the Run owns the main surface while
   the Composer remains available for steering.
3. Choose `Continue demo` to enter `Needs you`. Judge whether the request says
   exactly what is blocked, why, and what each choice changes.
4. Choose either answer. The mock proceeds to `Review`; inspect the distinction
   between Run completion, Evidence, and Ticket closeout.
5. Choose `Accept closeout`. In `Done`, approve or dismiss individual Context
   proposals; Outcome history remains unchanged.
6. Return with `← Tickets`, then open the Ready Ticket. Confirm that Start is a
   real boundary and no running presence is claimed before it.
7. Use `New task` to open `Explore`. Fork the assistant turn, inspect Branches, Compare, Bring
   Back, attach scoped Context, and create a Ticket.
8. Send a message from each phase and confirm the Composer changes role without
   disappearing or rewriting the Ticket contract implicitly.

## Decisions to make from this demo

- Does the graph make Tickets—not chats or activity lists—the primary product?
- Does it explain why work is blocked and what completion unlocks?
- Is the Ticket identity strong enough after entering one Workspace?
- Does Run receive enough space and specificity to feel like the place where
  the Agent is actually working?
- Does Chat remain natural enough in Explore and useful enough during Run?
- Is the sidebar ordered around the person's attention rather than system
  activity?
- Are Ready, Running, Needs you, Review, and Done honestly distinct?
- Should the first DSH vertical slice use additive slots or replace the root
  shell after the interaction model is accepted?

All state is disposable and in memory. This prototype does not authorize a
production DSH adapter, backend persistence, cross-Workspace coordination, or
high-fidelity visual implementation.
