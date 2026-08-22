# Codex-native Search and Task attention

Status: source-backed interaction study and real-runtime low-fidelity prototype.
It is not final visual approval or production notification infrastructure.

## Product correction

VibeHub opens on ordinary Codex Chat. Chat is a Human-led Thread; a VibeHub
Task is a durable Agent-led execution Context with an explicit Outcome and
stopping contract. They may link to each other, but they are never the same
object and never share an ambiguous label.

Task Graph remains the global work posture. It no longer needs to be the first
screen because Search and quiet Task attention can return the Human to exact
work when it matters.

## First-party patterns

| Source | Reusable interaction | Failure mode to avoid | Exact VibeHub use |
| --- | --- | --- | --- |
| [OpenAI Developers](https://developers.openai.com/) | The familiar Chat experience is the front door while Codex supplies execution power. | Making every conversation enter a managed workflow. | Default to Chat; add explicit Task affordances rather than replacing Chat. |
| [Linear Inbox](https://linear.app/docs/inbox) | One keyboard-friendly inbox brings together work that needs attention, with search and triage. | Turning the main navigation into a noisy activity feed. | One bell opens Task attention; the Sidebar shows only a bounded Needs You subset. |
| [GitHub notifications](https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications) | Every notification has a reason and supports read/done-style triage. | A colored dot with no explanation or owning object. | Every row names `Needs you`, `Successful Outcome`, or exception and opens the exact Task. |
| [Cursor Background Agents](https://docs.cursor.com/background-agent) | Agent work remains searchable in a Sidebar and can be reopened or taken over. | Treating runtime presence as durable work state. | Running is a quiet live fact; durable Task state remains in Git. |
| [Raycast Manual](https://manual.raycast.com/) | Global keyboard search is both navigation and command entry. | One flat result list that collapses unlike objects. | `⌘K` groups Chats, Tasks, and Context and preserves exact source identity. |

## Recommended composition

1. **Chat is the default.** `New chat` and `Recent chats` belong to Codex
   Threads. The top-level `Tasks` destination belongs to VibeHub.
2. **Search is the bridge.** A compact top-bar trigger and `⌘K` open grouped,
   typed results. Selecting a Chat reads a Codex Thread; selecting a Task opens
   the Task Workspace; selecting Context opens the durable Room claim.
3. **The bell is a route, not a database.** `Needs you` derives from canonical
   `NEEDS_HUMAN`. Completion derives from a successful Outcome and `closed_at`.
   The running client may mark a newly observed completion unread in memory,
   but initial repository history is never fabricated as unread.
4. **Sidebar attention is deliberately small.** At most three current
   `Needs you` Tasks appear above Recent chats. Completion history stays in the
   Inbox rather than pushing Chat history down the Sidebar.
5. **Running stays quiet.** Trusted, unexpired runtime presence may show that an
   Agent is live. It neither increments the bell nor rewrites Task state.

The executable form of these semantics is checked in at
`docs/proposals/codex-native-attention/interaction-contract.json`.

## Prototype review path

Run `npm run shell:codex`, then verify:

1. first load lands on the Chat welcome and the Composer remains available;
2. Sidebar labels are `Needs you` and `Recent chats`, never two different lists
   both called Tasks;
3. `⌘K` or Search shows separate Chats, Tasks, and Context groups;
4. each result opens its exact original object and Escape restores focus;
5. the bell shows current Human boundaries and successful Outcome history;
6. opening the Inbox clears only session-local unread completion treatment;
   it never changes canonical Task or Outcome state;
7. wide and 390×844 layouts have no horizontal overflow, keyboard focus is
   visible, and reduced motion removes nonessential transitions.

## Bounded alternatives

- A full activity stream was rejected for V1 because it competes with Recent
  chats and encourages notification noise.
- Full Task cards in the Sidebar were rejected because the Task Graph and Task
  Workspace already own that density.
- A single flat search list was rejected because object semantics become
  ambiguous even when the destinations happen to look similar.
- Persisted read/dismiss state is deferred until there is a production event
  identity and synchronization contract; browser storage is not source truth.

## Downstream boundary

Owner review chooses exact placement, density, iconography, notification tone,
Task focus transition, Composer/voice posture, and narrow behavior. Production
implementation then owns a durable event contract if cross-device unread state
is desired. DSH remains a later compatibility carrier and does not gate this
Codex-first decision.
