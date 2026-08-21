# DSH persistent shell product review

Status: production-shaped interaction and compatibility prototype for owner
review. It does not change the production DSH Bundle, authorize the final
visual system, or claim that its mocked execution state is a live Agent.

Pinned host: `@deepseek-ai/dsh@0.1.0-rc.8`, upstream commit
`141eb6fef83422698aef7a981029e843e8161534`.

## What the current vertical slice proved

The existing packed Profile is a successful technical vertical slice. It
installs through official Bundle/Profile composition, projects the canonical
Task Graph, hands an exact host-owned payload into native Chat, loads the
checked-in Run Skill, writes acceptance-linked Evidence, recovers the
Task-to-Session link after restart, and keeps independent closeout separate.

Those facts remain the implementation baseline. The Graph is not the defect.

## What dogfood exposed

The current `shell.overlay` integration creates four product failures:

1. Opening Tasks obscures the native sidebar instead of adding a destination
   to it.
2. VibeHub carries its own application chrome, so the user crosses between two
   products rather than navigating one product.
3. Native Chat and the Task Graph appear unrelated even though they share a
   Session handoff and one work loop.
4. Selecting a card opens a Workbench Inspector, not yet the full focused Task
   Workspace where execution, attention, Chat steering, Context and Evidence
   belong.

The dogfood Profile also exposed an iframe lifecycle failure: after the
ephemeral Graph host disappeared, DSH retained a bootstrap URL that refused to
connect. Restart restored the host. Production work must either own that child
host for the whole Profile lifecycle or remove the child-host boundary; the
prototype does not hide this behind a visual fallback.

## Recommended information architecture

Use one persistent DSH/Codex-like shell:

```text
Persistent sidebar
  New Chat
  Tasks ───────────────┐
  Rooms                │
  Workspace            │
  Task focus           │  same center column
  Native Chat history  │
  Settings             │
                       ▼
                 Task Graph
                       │ select
                       ▼
                 Task Workspace
                       │ native Chat steering
                       ▼
                 exact Graph return
```

The recommended variant is **Tasks first**: the application lands on Tasks,
Tasks is a stable destination above the Workspace and Chat history, and native
New Chat stays at the top. This is the clearest expression of “do not manage
chat, manage work to completion.”

The bounded alternative is **Chat first**: the same persistent sidebar and
Focus Route remain, but first boot lands on native Chat and Task focus sits
below Chat history. It is less disruptive for DSH users, but makes VibeHub's
durable unit feel secondary.

The prototype contains both variants. It does not offer a third layout style:
the owner decision is about hierarchy and default landing, not visual taste.

## Complete review path

The local prototype supports the complete path required for the next decision:

1. Start on the Task Graph in the Tasks-first variant.
2. Open normal native Chat from the persistent sidebar and return to the same Tasks
   destination without closing a second application.
3. Open `Prototype persistent DSH navigation` from the Graph.
4. Inspect trusted execution-shaped content and use the dominant Recommended
   action.
5. Continue into an exact `Needs you` boundary, discuss it through native Chat,
   or choose one disposable prototype option.
6. Inspect Evidence/Verifying posture without treating Run completion as an
   accepted Outcome.
7. choose `← Tasks`; the prior Graph scroll and selected card regain focus.
8. Switch to the Chat-first variant and compare only the changed hierarchy and
   default landing.
9. Open Review notes for the supported DSH seam and owner questions.

All state is in memory. Refresh resets it. The server binds to loopback,
accepts only `GET` and `HEAD`, and has no repository write route.

## Exact DSH composition

The detailed machine-readable contract is
[`docs/proposals/dsh-persistent-shell/composition-contract.json`](proposals/dsh-persistent-shell/composition-contract.json).

### Keep

- `root`: stock three-column AppFrame and its width/collapse behavior.
- `conversation`: native no-Session hero, Session body, Chat, approvals,
  models, tools and composer.
- `details`: native tool/details column.
- Session, Workspace, Layout and Theme services.

### Shadow deliberately

Shadow the single `sidebar` owner. This is supported DSH composition, not an
upstream patch, but it carries a binding compatibility obligation. The new
owner must recreate all five children currently declared by SidebarRoot:

- `sidebar.brand.mark`
- `sidebar.brand.name`
- `sidebar.workspaces`
- `sidebar.settings`
- `sidebar.footer.action`

It must also preserve native New Session and collapsed-rail behavior. Losing
any child seat is a stop condition.

This is the only production-shaped way found in rc.8 to put Tasks in stable
top-level navigation. `sidebar.footer.action` is additive, but putting the
primary Tasks destination at the foot is the wrong information hierarchy.
Replacing `sidebar.workspaces` would also take over the native browser region
without giving VibeHub a supported way to render the existing single owner
inside it.

### Compose and extend

- The global Graph is a center-column product route, not a synthetic Session
  `conversation.view`.
- Focus Route changes the center column from Graph to one Task Workspace and
  restores the exact prior Graph viewport and card focus on return.
- Chat-side Create Task, Attach Task and Remember proposals later use official
  conversation header, assistant-action, turn-tail and composer slots.
- Theme Runtime makes stock DSH and VibeHub surfaces visually continuous.

### Reject

- `shell.overlay` for ordinary full-page Tasks content. AppFrame documents it
  as a frame-wide floating layer outside scroll containers.
- DOM injection or CSS selectors against stock component internals.
- an upstream DSH fork.
- a synthetic Session merely to host the global Graph.
- Root replacement as a styling technique.
- a second Task database or DSH Agent Team Task coupling.

## Accessibility and native-behavior contract

The review carrier keeps every destination and Task keyboard reachable,
restores focus on Graph return, exposes visible focus, collapses to a native
mobile navigation drawer at `760px`, avoids horizontal page overflow, and
removes motion under `prefers-reduced-motion`. It retains a native-shaped
composer, Workspace identity, Settings, Session history and tool/approval
language. A live pulse appears only in the mocked review scenario and is
explicitly labelled as prototype state; the production contract still
requires a fresh trusted runtime source.

## Owner decision

The recommended product decision is:

- Tasks-first default landing.
- Tasks above the Workspace group in the persistent sidebar.
- Focus Route from Graph card to Task Workspace with exact return.
- native Chat as a first-class route plus Task-scoped steering, not a permanent
  split screen.
- the DSH Root and Conversation owners remain stock; only Sidebar is shadowed
  and its complete child contract is recreated.

The owner may accept that recommendation or record one bounded correction. A
future visual-system review remains separate from this navigation decision.
