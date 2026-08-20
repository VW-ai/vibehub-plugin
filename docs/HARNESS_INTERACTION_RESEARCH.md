# Task Workbench interaction research

Status: decision-ready interaction study. This document is not visual authority
and does not authorize production DSH integration. It exists to select the
spatial and navigational model that the next prototype will execute.

## Fixed product premises

- The user enters VibeHub to make, understand, steer, review, or close a Task.
- The Task is durable. A Chat or Agent Session is an execution and exploration
  resource attached to it.
- The Ticket Graph is home for committed work. It must show causality,
  readiness, active execution, and exact human-attention boundaries.
- Once a Task is opened, the surface should give autonomous execution enough
  room to be understood without reducing it to a spinner or a raw log.
- Chat remains a capable, unconstrained model interaction. Fork, Compare, and
  Bring Back are explicit conversation operations, not an inferred knowledge
  graph.
- DSH is the first runtime and distribution host. VibeHub should initially be
  an installable non-invasive Bundle, not an upstream fork.

## Research corpus

The corpus intentionally mixes direct competitors with adjacent products that
solve one interaction problem exceptionally well. We extract behavior, not a
visual collage.

| Product | Pattern worth carrying | Failure to avoid | Official source |
| --- | --- | --- | --- |
| OpenAI Codex app | One thread is a real unit of delegated work; progress, questions, diffs, and review stay inside it while projects organize parallel work. | Treating a flat thread list as sufficient once cross-Task causality matters. | [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/) |
| Linear | Navigation recedes after orientation; dense information earns visual weight according to the user's current task. Header locations and actions remain predictable. | Letting every status, filter, and navigation element compete equally. | [A calmer interface for a product in motion](https://linear.app/now/behind-the-latest-design-refresh) |
| Raycast | A contextual action bar makes the current action and its shortcut visible; Command K exposes the long tail without crowding the primary surface. | Permanent toolbars containing every possible command. | [A fresh look and feel](https://www.raycast.com/blog/a-fresh-look-and-feel) |
| Things | Task is the plain-language unit; a Task can grow into a Project, while checklist lines remain lighter than real Tasks. Quick Entry and Quick Find keep capture and navigation cheap. | Requiring taxonomy before capture or confusing subtasks with checklists. | [Things](https://culturedcode.com/things/index.html), [Headings in Projects](https://culturedcode.com/things/support/articles/2803577/) |
| Notion Projects | Each Task can open into a complete work page with its own context; overview and doing surfaces are different projections of the same object. | Turning the work page into a configurable document builder before the user can act. | [Projects](https://www.notion.com/product/projects) |
| Msty Branch Explorer | Fork is adjacent to the message that creates it; lineage can stay compact until the user asks to compare branches side by side. | Making a full graph the mandatory way to read ordinary Chat. | [Branch Explorer](https://docs.msty.ai/studio/conversations/branch-explorer) |
| Superlist | Notes, discussion, and subtasks can inhabit one Task/List object; a user can switch from thinking material to an action-focused projection. | Blurring freeform content and executable work so much that readiness becomes unknowable. | [Superlist basics](https://help.superlist.com/en/articles/10050-superlist-basics-lists-tasks-sections-meetings-explained) |
| OpenHands Agent Canvas | Keep the interface stable while the execution backend changes; parallel Agents and local/remote environments are a runtime choice, not a new product model. | Exposing backend topology as the primary user workflow. | [Agent Canvas](https://www.openhands.dev/product/canvas) |

## Pattern map across the VibeHub loop

| Moment | Interaction contract | Research influence |
| --- | --- | --- |
| First frame | Show the current Task graph and the smallest honest attention summary. No chat-history landing page and no dashboard of vanity counts. | Linear attention hierarchy, Things focus |
| Fast capture | One command or compact composer creates a standalone or Project-owned Task; structure can be refined after capture. | Things Quick Entry, Raycast command layer |
| Graph scan | Causal relationships are visible. Search, focus, Project, and state narrow the graph without creating alternate truth. | Linear density, VibeHub Workbench |
| Enter Task | Preserve the Task identity and a reversible path back to the exact graph focus. | Notion task page, Codex thread |
| Running | Current intent, meaningful steps, changed artifacts, tool results, and recent decisions dominate. Chat stays reachable but does not consume the screen by default. | Codex execution/review, OpenHands backend neutrality |
| Needs you | The owning step expands in place and states what is blocked, why, choices, and consequences. | Codex remote attention, Linear earned attention |
| Chat steering | A composer is always reachable. Steering appends to the owning Session; editing the Task contract is explicit and separate. | Codex thread, Raycast contextual actions |
| Branch work | Fork lives on the message; lineage is a small local affordance; Compare is a focused side-by-side surface; Bring Back creates a source-linked turn. | Msty Branch Explorer |
| Context | The active packet appears as removable references beside the composer or Task contract. Read access never implies writeback. | Notion page context, VibeHub governance |
| Review | Evidence sits beside each Acceptance criterion. Run completion does not auto-close the Task. | Codex diff review, VibeHub Outcome contract |
| Return | Closing or backing out restores the same graph viewport and causal focus, with unlocked Tasks visibly changed. | Spatial continuity rather than list navigation |

## Candidate interaction architectures

All three candidates share the same objects, lifecycle, and visual restraint.
They differ only in how the Graph and one Task Workspace share space.

### A. Focus Route — recommended

The Graph is a full home surface. Opening a Task transitions to a focused Task
Workspace; the selected node supplies the transition origin and a compact
causal breadcrumb. Back returns to the exact graph viewport. The center changes
by Task phase, while Chat is a persistent composer plus an on-demand thread
drawer.

Why it fits:

- autonomous Runs and Evidence review receive enough horizontal space;
- it is closest to Codex's calm task focus without adopting Chat as the unit;
- graph complexity does not tax every interaction;
- the narrow layout maps cleanly to a normal push navigation stack.

Primary risk: the dependency graph can feel forgotten inside long Task work.
Mitigation: preserve a compact causal breadcrumb, blocker/unlock preview, and
exact back restoration instead of a permanent mini-canvas.

DSH composition: custom Theme; additive sidebar sections, Task/Graph
conversation views, composer and message actions, and shell overlay. A small
VibeHub navigation owner may eventually replace the `conversation` single
slot if a global no-Session Task home cannot be expressed honestly, but Root
replacement is not the default.

### B. Spatial Lens

The Graph never leaves. Opening a Task expands a wide lens over the selected
node while the remaining causal neighborhood recedes behind it. The lens owns
Run, Attention, Chat, and Review. Closing it returns immediately to the canvas.

Strength: strongest spatial continuity and most distinctive expression of
Task causality. It is especially good for brief inspection and intervention.

Risk: long Chat, large diffs, terminal output, and accessibility all fight a
modal/canvas metaphor. The lens can slowly become a full page pretending not
to be one.

DSH composition: easiest as a Graph `conversation.view` plus an additive
overlay or internal lens. It preserves the stock shell but must be careful not
to misuse `shell.overlay` for ordinary scrolling content.

### C. Live Split

The left region keeps a navigable causal graph or focused subgraph; the right
region is the active Task Workspace. Selection switches the right side without
a route transition. The split can collapse to Graph-only or Task-only.

Strength: dependencies and execution remain simultaneously visible, useful
for coordinating several active Tasks.

Risk: it spends screen area before causality has earned it and can feel like an
operations cockpit. Chat and review become cramped; narrow screens must abandon
the defining split.

DSH composition: likely requires replacing the `conversation` owner or Root
layout rather than only adding a view. Because the current DSH single-owner
registrations declare their own child slots, a replacement Bundle must remove
the stock owner row and deliberately recreate every required extension seat.

## Recommendation

Use **A. Focus Route** as the base interaction architecture.

It protects all three product truths simultaneously:

1. the Graph is genuinely home;
2. a Task is the stable unit after commitment;
3. autonomous execution, Chat, and Evidence get a calm full-size workspace.

Carry one element from Spatial Lens: the selected graph node should visibly be
the origin of the Task Workspace transition, and Back must restore its exact
causal focus. Carry one element from Live Split only as an optional future
wide-screen mode, never the default.

The next owner choice is deliberately small: accept Focus Route as the base,
choose Spatial Lens instead, or request one exact change to the transition and
in-Task Chat posture. Visual identity, typography, color, and component polish
remain a later pass.

## DSH rc.8 feasibility note

Current official baseline inspected: `@deepseek-ai/dsh@0.1.0-rc.8`, commit
`141eb6fef83422698aef7a981029e843e8161534`.

- The nine rc.7 structural seams used by the existing Spike remain present:
  Bundle/Profile composition, Root layout, conversation slots, custom Chat
  nodes, Session fork, no-model-turn commands, durable Session events, local
  Web composition, and the deliberately limited one-shot Codex provider.
- The browser Theme Runtime now provides registered themes and composable
  token override layers. The current client tree references approximately 373
  `--dsw-*` variables, including palette and typography families. This makes a
  substantial whole-application reskin an official Plugin operation.
- Root, Sidebar, Conversation, and Details remain shadowable single-owner
  slots. Replacing one is supported composition, but the shipped owner declares
  its child slots; a true replacement must remove that owner row and recreate
  the child extension contract. It is therefore a product-architecture tool,
  not the first styling mechanism.
- The lowest-risk V1 is Theme override plus additive Task surfaces. Replace
  `conversation` only if a Task-graph home outside any Session cannot be
  expressed without a synthetic Session. Do not replace Root merely to alter
  appearance.

The source-level rc.8 probe passes all nine seams. A fresh npm boot was
attempted in an isolated temporary Harness home but did not complete within the
research window, so the prior rc.7 live boot remains the current runtime proof;
rc.8 runtime boot must remain in the technical Spike before closeout.
