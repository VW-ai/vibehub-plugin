# Harness prototype review

Status: rejected as product UI; retained only as an interaction inventory and
technical fixture. The next prototype must replace the complete DSH-visible
application shell.

Run `npm run prototype:harness:safari`, then use the interface rather than
reading this document first. The prototype is intentionally local, mocked, and
non-durable. It must not be used as the visual or structural baseline for
implementation.

## Suggested walkthrough

1. In **Chat**, fork both “Ticket craft” and “Execution presence.”
2. Open **Branches**, enter each node, and return to the graph.
3. Open **Compare branches** and use **Bring back to Main**.
4. Turn **Context on**, inspect the three selected claims, then send a turn.
5. Use **Make Ticket**, inspect its source and Context preview, and create it.
6. Open the Ticket and press **Start Ticket**.
7. Advance the demo Run through Running and Needs you, then approve once.
8. Use **Preview execution states** to inspect Failed, Evidence, and Complete.
9. Narrow the Safari window and repeat the primary navigation.

## Product questions for the owner

The next product-direction decision should answer these questions explicitly:

1. Does this feel primarily like a strong Chat for doing work, rather than a
   workflow tool wrapped around a chatbot?
2. Is the conversation graph useful and quiet enough? Is returning from a fork
   and comparing sibling branches understandable?
3. Is Context sufficiently explicit without becoming friction or constraining
   the model?
4. Does Ticket craft happen at the right moment, with the right amount of
   structure and reversibility?
5. Do Ticket, Context, Reference, Branch, Run, and Evidence feel related but
   semantically distinct?
6. Does the persistent activity dock create the desired sense that execution
   is happening? Is the full Run surface detailed enough without becoming logs?
7. Are exact attention requests and failure recovery trustworthy?
8. Does the local browser shell feel sufficient for V1, before a desktop app?

## Replacement review requirement

The next review starts from the whole application, not from VibeHub-specific
feature panels. It must answer:

1. Does the first frame feel like a distinct VibeHub application before any
   Ticket, Context, or Graph feature is opened?
2. Can a person move from capture or Chat into a branch, Ticket, Run, and back
   without feeling that separate plugins were stitched together?
3. Are Workspace, Session, Ticket, and active Run hierarchy understandable
   without exposing DSH's internal package architecture?
4. Do onboarding, empty, failure, settings, and narrow-screen states belong to
   the same visual and interaction system?
5. Which DSH extension seats remain available inside the replacement shell,
   and which stock owners are intentionally removed?

Review must compare the replacement directly with both stock DSH and the
rejected additive-slot Spike. Merely making the Spike prettier does not satisfy
this revision.

Record accepted directions and bounded revisions in the product-direction
decision Ticket. Prototype comments alone are not durable authority.
