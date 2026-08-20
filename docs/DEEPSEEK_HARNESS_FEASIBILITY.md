# DeepSeek Harness feasibility for VibeHub

Status: pinned foundation Spike, not a production architecture commitment.

## Baseline

- Official repository: <https://github.com/deepseek-ai/deepseek-harness>
- Commit: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- Published CLI: `@deepseek-ai/dsh@0.1.0-rc.7`
- Runtime: Node `^22.19.0 || >=24.0.0`, pnpm `11.7.0`
- Product status: developer preview with compatibility-breaking changes

All source links below are pinned to the exact commit rather than `master`.

## Executed boot proof

The local Bundle in `spikes/deepseek-harness/bundle/` was installed through
the pinned published CLI into an isolated `$DSH_HOME` Web Profile. The generated
profile contained this exact ordered composition:

```text
@deepseek-ai/dsh-base
@deepseek-ai/dsh-web-app
dsh-vibehub-foundation-spike
```

`--dump-config` attributed the inserted `vibehub-foundation-spike` row to the
VibeHub Bundle after both official layers. The Profile then booted on
`127.0.0.1:31807`; an HTTP request returned the real DSH Web application and
its complete client-plugin roster with status 200. `SIGINT` disposed the
profile, and the same port immediately refused a new connection. No upstream
checkout was edited and the isolated Profile stayed outside this repository.

## Executed client-slot proof

The same out-of-tree Bundle now exports a real DSH browser module rather than
only a host plugin. The official Web manifest discovered it as
`dsh-vibehub-foundation-spike`, ordered after runtime, layout, conversation,
and workspace client packages. In the running official UI, the Spike exercised:

- `conversation.input.left`: a live `Context on/off` control inside the native composer;
- `conversation.view`: native `Graph` and `Run` tabs beside Chat and Trajectory;
- `shell.overlay`: an execution card that remains visible when the Run view starts;
- `conversation.chat.assistant-actions`: a `Fork` button on a finalized assistant fixture.

The Fork button called `ctx.sessions.fork({ sessionId, increaseTitle: true })`;
the official sidebar created and selected the child Session while preserving the
source transcript. A no-model command fixture made the action testable without
storing an API credential. The Graph and Run views rendered through DSH's own
view ring, not a standalone page or iframe.

One compatibility failure was deliberately observed and corrected: an unknown
`vibehub/run` event appended without event registration or `ignorable: true`
caused a restart to reject that Session history with
`SessionFormatUnsupportedError`. Therefore production Run events must be
registered with their durable schema and renderer before writing, with
`ignorable` reserved for forward-compatible transitional records. A custom
event append alone is not a valid replay contract.

## Seam matrix

| Product-critical seam | Result | Source-level finding | VibeHub posture |
|---|---|---|---|
| Bundle/Profile distribution | Proven | A Bundle is an npm package with a `dsh.bundle.patch`; a Profile is an ordered bundle composition. Local checkout installation is an official path. | Ship a VibeHub Bundle layered after `dsh-base` and `dsh-web-app`; keep user overrides above it. |
| Local browser lifecycle | Proven | The Web bundle uses the ordinary host Web server and defaults to `127.0.0.1:3080`; profile shutdown disposes the plugin tree. | Browser-first is a first-class V1 form. A future wrapper should own only launch/window lifecycle. |
| Whole product shell | Conditional | `ui-layout` occupies the built-in root slot and declares single-owner sidebar, conversation, and details slots plus an additive shell overlay. Replacing these is supported, but replacement also owns every child slot it declares. | Prefer incremental seats first. Replace the root or conversation only when the approved UI cannot be expressed compositionally. |
| Chat actions and extra views | Proven | The conversation package exposes additive session-header actions, assistant-message actions, whole conversation views, command renderers, turn tails, input controls, and docks. | Fork, Context, Ticket craft, Run presence, and Graph can begin as separate client registrations. |
| Custom durable Chat nodes | Proven with replay constraint | `ConversationNodeDefinition` is merge-extensible; the shipped workflow-run plugin registers a durable definition plus a keyed renderer. A live Spike showed that an unknown non-ignorable event makes restored history unsupported. | Register the event schema/definition before writing production records. Use `ignorable` only for explicitly forward-compatible transitional events. |
| Session fork/resume identity | Proven with constraint | `ctx.sessions.fork(source, boundary?, childId?)` copies a stable prefix, records `parentSession` and `seedLength`, and rejects a boundary inside an open turn. | A conversation branch is a real child Session. VibeHub owns the branch graph index and labels; forks occur only at closed boundaries. |
| Compare | Product-owned | DSH supplies durable parent/child logs and transcript projections but no product-level compare/merge primitive. | Compare creates a new model turn that receives explicit branch excerpts or summaries; it never mutates either branch. |
| Bring Back | Product-owned | Session fork is one-way prefix inheritance. There is no built-in branch merge. | Bring Back appends a new explicit source-linked turn to the chosen target branch. Preserve both source Session ids and boundaries. |
| Human command without model turn | Proven | `ctx.commands` records `command/run` and `command/done` directly and invokes the handler without opening a model turn. | UI buttons call typed VibeHub commands; command handlers invoke the canonical VibeHub write path. |
| Execution projection | Proven as an extension, not supplied semantics | Session events are append-only durable facts and `session/event` is the live feed. Event maps and conversation definitions are plugin-extensible. | Define one VibeHub Run event vocabulary and project it into the activity dock, Run view, and Chat nodes. Do not infer it from Ticket status. |
| Existing Codex integration | Insufficient for the product loop | The shipped optional Codex subagent starts `codex app-server --stdio`, but is one fresh process/thread/turn and returns final text only. Its own documentation excludes continuation, resume, progress stream, human approval, and product-session persistence. | Reuse its app-server protocol research, not its product contract. Build a VibeHub executor adapter that preserves progress, approvals, requests, Evidence, cancellation, and resume. |
| Upgrade stability | Unstable | DSH explicitly promises breaking changes during developer preview, and client Slot contracts are package-level TypeScript APIs. | Pin the complete DSH release, isolate imports behind `packages/dsh-adapter`, and run source-contract plus boot smoke tests before every upgrade. |

## Exact source proofs

- [Architecture and extension map](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/docs/architecture.md)
- [Bundle and Profile installation](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/docs/user/develop/basic/publish.md)
- [Root layout and shell slots](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/client/ui-layout/src/client/index.ts)
- [Conversation extension slots](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/client/ui-conversation/src/client/contract/slots.ts)
- [Session fork implementation](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/core/session/src/index.ts)
- [Human-command lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/interaction/commands/src/index.ts)
- [Custom workflow Conversation node](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/client/ui-workflow-run/src/client/index.ts)
- [Existing Codex provider and limitations](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/subagent/subagent-codex/README.md)

## Proposed V1 composition

```text
@deepseek-ai/dsh-base
  → @deepseek-ai/dsh-web-app
  → dsh-vibehub
      host: VibeHub commands + canonical Git adapter + Run events
      client: Chat actions + Context attachments + Ticket craft
              Conversation Graph + Compare/Bring Back + execution dock
  → profile cordis.patch.yml
  → user home cordis.patch.yml
```

The first VibeHub layer should use existing additive Slots:

- `conversation.chat.assistant-actions`: Fork from an exact assistant message
- `conversation.session.header.actions`: open Graph and session lineage
- `conversation.view`: Graph, Compare, Ticket, and Run full surfaces
- `conversation.input.left` or `.dock`: explicit Context attachment
- `conversation.chat.commandview`: durable Ticket/Run command rows
- `shell.overlay`: compact global execution presence

Replacing `root`, `sidebar`, or `conversation` remains a later option. This
lets us prove the product loop while inheriting DSH's native Chat, composer,
approval, tools, workspace, settings, and responsive behavior.

## VibeHub-owned durable events

DSH's event log is the transport and replay substrate; it should not define
VibeHub's product meaning. The compatibility adapter should initially own a
small event family:

- `vibehub/ticket-linked`
- `vibehub/run-queued`
- `vibehub/run-started`
- `vibehub/run-progress`
- `vibehub/run-tool`
- `vibehub/run-attention`
- `vibehub/run-failed`
- `vibehub/evidence-linked`
- `vibehub/run-completed`

Every event carries a stable Ticket id and executor-run id. Events are a UI and
resume projection; canonical Ticket, Context, Evidence, and Outcome files stay
the VibeHub source of truth.

## Codex executor boundary

Do not route the primary product execution through the shipped one-shot
`subagent-codex` provider. A VibeHub adapter should own one Codex App Server
connection per resumable executor run and translate:

| Codex-side fact | VibeHub Run projection |
|---|---|
| thread/turn accepted | queued → started |
| commentary and item updates | progress |
| command/tool request and completion | tool |
| approval or user-input request | attention |
| workspace result or acceptance observation | Evidence proposal |
| interruption or error | failed or cancelled |
| final answer and terminal state | completed, still awaiting closeout |

The adapter must preserve product ids, stream updates, approvals, cancellation,
and restart recovery. DSH remains the shell/event runtime; Codex remains a
replaceable executor.

## Initial repository shape

Keep development in this repository:

```text
apps/harness-prototype/       current UI/UX authority prototype
packages/dsh-bundle/          future installable Bundle
packages/dsh-adapter/         pinned DSH imports and event compatibility
packages/dsh-ui/              client Slot registrations
packages/executor-codex/      Codex App Server adapter
skills/                       current VibeHub Skill product
spikes/deepseek-harness/      disposable pinned proofs
```

Do not create these production packages until the owner accepts the UI/UX
direction. The current Spike stays isolated.

## Smoke tests required before implementation and upgrades

1. Exact upstream version and commit contract probe
2. Bundle installation into an isolated Web Profile
3. `--dump-config` proves layer order and VibeHub rows
4. Web boot and graceful shutdown on loopback
5. Human command appends paired lifecycle and no model turn
6. Closed-turn fork preserves parent and boundary metadata
7. Every used client Slot can register without replacing an unintended owner
8. Custom Run event replays into the same UI projection after restart
9. Codex stream, approval, cancellation, and resume fixture compatibility
10. Existing Git-native Skill and Workbench verification remains green

## Stop conditions

Pause permanent DSH implementation if any of these becomes true:

- a required additive Slot cannot be installed without replacing native Chat;
- custom durable events cannot replay consistently after restart;
- a Bundle cannot boot from an isolated Profile without upstream patches;
- DSH upgrade requires VibeHub product code to import broad internal modules
  outside the compatibility adapter;
- Codex approvals or progress cannot be recovered without hidden state;
- DSH's local persistence would become a competing canonical Ticket store.
