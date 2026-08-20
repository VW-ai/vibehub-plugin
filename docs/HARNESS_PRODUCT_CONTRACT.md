# VibeHub Harness product contract

Status: whole-application product-direction proposal for human review. The
first additive-slot Spike proved DSH compatibility but its UI is rejected as a
product direction. This document and the replacement prototype do not
authorize production backend architecture.

## Product promise

VibeHub Harness is the place where a person turns thought into bounded work and
stays oriented while an Agent executes it. Normal Agent Chat remains capable
and unconstrained. VibeHub contributes explicit branch navigation, scoped
Context, Ticket craft, execution presence, attention return, and Evidence.

The stable product object is the Ticket. Conversations, branches, models,
Agents, repositories, and runtimes can change around it.

## Product identity: DSH is the engine, not the application

The user should not experience VibeHub as several panels installed into the
stock DeepSeek Harness interface. DSH supplies the runtime, plugin graph,
Sessions, tools, permissions, models, and host lifecycle underneath. VibeHub
owns the complete visible application:

- global navigation and information architecture;
- Workspace, Session, Ticket, and Run entry points;
- Chat header, transcript chrome, composer, branch navigation, and inspectors;
- empty states, onboarding, settings, plugin and model presentation;
- typography, motion, density, visual hierarchy, and responsive behavior;
- the transitions between thinking, committing work, executing, returning for
  attention, and accepting Evidence.

The initial technical Spike's additive controls remain disposable test
fixtures. The target composition takes the DSH `root` layout and deliberately
recreates the child slot structure VibeHub still wants third-party plugins to
extend. A user opening the result should perceive a completely different
application, not a themed DSH distribution.

## Whole-application information architecture

The application has one stable frame rather than a collection of product
pages:

- **Command / capture layer** starts a thought, finds a Ticket or Session, or
  jumps to work without first choosing a subsystem.
- **Work navigation** exposes the current Workspace, conversations, Tickets,
  and trusted Runs as related views of work rather than separate tools.
- **Primary stage** hosts normal Chat, branch Graph, Ticket focus, Compare, and
  Run focus with shared navigation and continuity.
- **Contextual inspector** appears only for the selected Branch, Context,
  Reference, Ticket, Run step, or Evidence item; it is not a permanent form.
- **Execution presence** stays visible across the application when trusted Run
  activity exists and disappears when it does not.
- **Engine settings** contain models, providers, permissions, plugins, and raw
  DSH diagnostics without making those implementation concepts the product's
  main navigation.

## Near-term scenario: one Workspace

The first product operates inside one selected Git Workspace that already owns
its VibeHub Rooms and canonical documents.

### Think first

1. Open the Workspace and start a normal Agent Chat.
2. Fork any useful thought without changing the parent conversation.
3. Enter branches from a visible conversation graph.
4. Compare sibling branches and bring a chosen synthesis back as a new turn.
5. Explicitly turn on a minimal, inspectable Workspace Context packet when it
   should inform the next turn.
6. Preview a Ticket from the current branch and its References.
7. Craft the Ticket only when its outcome is bounded; otherwise keep chatting.
8. Start a Ready Ticket with a replaceable Agent.
9. Follow trusted Run activity, answer exact attention requests, and inspect
   Evidence before independent closeout.

### Act first

1. Describe the desired work directly.
2. Let the Agent ask only for genuinely missing boundaries.
3. Optionally activate scoped Workspace Context.
4. Preview readiness and craft the Ticket.
5. Start and follow the same execution loop.

## Interaction grammar

Chat is the primary thinking surface. VibeHub objects appear around it as
compact, inspectable attachments:

- **Branch** identifies the exact conversation lineage. It is created only by
  an explicit fork and never inferred from semantic similarity.
- **Context** identifies durable claims selected for a model turn. Turning it
  on is visible, scoped, and reversible. A transcript is never captured merely
  because Context was active.
- **Reference** points to source reality such as the current Workspace, a file,
  a document, or the source conversation node.
- **Ticket** previews the bounded desired action, acceptance, constraints,
  dependencies, readiness, and attached References before durable creation.
- **Run** is a trusted activity projection from the chosen executor. It does
  not change or impersonate Ticket state.
- **Evidence** is attached to Acceptance during execution and remains distinct
  from chat prose or an Agent's completion claim.

## Execution presence

Execution must feel present without becoming a wall of logs.

- A quiet persistent dock answers whether anything is really running, the
  current step, and whether the user is needed.
- A dedicated Run surface exposes queued, running, waiting-for-human, failed,
  evidence-producing, and completed events in chronological order.
- An attention request appears at the exact step that owns it and names the
  requested choice or permission.
- Ready does not mean running. Done does not prove a live process completed.
  Without trusted Run events, the UI makes no execution claim.
- Completion remains subject to acceptance-linked Evidence and independent
  closeout.

## Initial product shell

V1 is a local browser application optimized for Safari and normal desktop
browsers. It should feel like an application through stable navigation,
focused work surfaces, keyboard reachability, responsive layout, and a narrow
local lifecycle. A later desktop wrapper may own window and launch behavior,
but it must reuse the same product surface and state contracts.

"Application-like" means whole-shell ownership, not Safari styling around the
stock DSH page. V1 may reuse internal DSH primitives and extension services,
but no major stock shell, sidebar, conversation chrome, onboarding, or settings
surface is accepted merely because it already works.

## V1 non-goals

- Cross-repository Project or Ticket federation
- A personal automatic knowledge graph
- Cloud sync, accounts, or multi-user collaboration
- A native desktop wrapper
- A second durable database or hidden UI authority
- A new general-purpose Agent runtime
- Automatic transcript sedimentation
- Perfect parity across every model or executor

## Longer-term direction

After the single-Workspace loop earns daily use, VibeHub may add a Workspace
catalog, project-independent personal Tickets, cross-repository dependencies,
additional Context providers, a broader personal Knowledge Park, executor
routing, hosted synchronization, collaboration, and a desktop or mobile shell.
These extend the same loop; they do not redefine the V1 product.

## Development gate

Permanent implementation begins only after:

1. the owner uses the product prototype and records the chosen interaction
   direction;
2. source-level DeepSeek Harness spikes establish the usable extension seams;
3. the draft vertical-slice Ticket is refined from those two Outcomes.
