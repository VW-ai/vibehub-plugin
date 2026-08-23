# Harness-neutral VibeHub core contract

Status: executable architecture contract for the Codex-first product and the
later standalone DeepSeek Harness carrier. It does not install, boot, or run
the future DSH carrier.

## Product statement

VibeHub is one Task and Context product with two independently selectable
harness bases. A Codex installation uses the official local Codex app-server
and should preserve Codex Chat behavior. A DSH installation uses native DSH
Sessions, models, tools, approvals, permissions, Slots, and Theme and must work
without Codex installed.

The word `carrier` only names that packaging choice. It does not mean a thin or
reduced Chat. The selected harness remains the sole owner of its conversation
and execution loop; VibeHub adds durable Task organization and explicit
Chat-to-Task operations around it.

Chat and Task share a conversational interaction substrate but do not share
identity. One continuous Chat may birth zero, one, or many Tasks and then keep
going. Each Task records one immutable origin locator and may have its own
task-scoped conversation. A fork is a harness conversation branch, never an
automatic Subtask. New messages do not silently mutate Task Context; explicit
Create Task, Attach, Quote, Remember, or Update operations govern transfer.

## Ownership matrix

| Truth | VibeHub core | Codex adapter | DSH adapter |
| --- | --- | --- | --- |
| VibeHub Task, Project, Room, Context | Canonical Git-native owner | References ids only | References ids only |
| Acceptance, Evidence, Outcome | Canonical Git-native owner; independent closeout remains required | A completed Turn is not an Outcome | A completed Session run is not an Outcome |
| Chat-to-Task origin and associations | Owns immutable origin and durable Task-to-conversation link | Supplies Thread/Turn ids | Supplies Session/event ids |
| Chat transcript | Never copies or reconciles it | Codex Thread/Turn owns it | DSH Session log owns it |
| Agent lifecycle, model, tools, plan, delegated work | Observes typed capabilities and fresh presence only | Codex app-server owns it | DSH Agent/Session runtime owns it |
| Permissions and approvals | Routes the Human to the exact pending request | Codex server request/response owns it | DSH approval/pending wait owns it |
| Audio and attachments | Exposes truthful capability and host-neutral UI state | Codex Turn inputs own bytes/refs | DSH owns image attachment admission; rc.8 audio is unsupported |
| Live presence | Never persists it as Task state | Fresh Turn events only | Fresh Session summary only |

The core may persist `ticketId + harnessId + conversationId + origin` because
that is VibeHub association truth. It may not persist a duplicate transcript,
translate a native plan into Tasks, mirror DSH Agent Team tasks, or infer an
Outcome from runtime completion.

## Versioned capabilities

[`capabilities.v1.json`](proposals/harness-neutral-core/capabilities.v1.json)
is the machine-readable negotiation contract. It covers Projects, fork,
search, audio, attachments, approvals, tools, plans, delegated work, replay,
interruption, live presence, settings (model and effort catalog, effective
posture, per-Turn overrides), compaction (context usage and compact), and
mentions (file and skill discovery for mention and skill inputs).

Each value is one of:

- `native`: the exact pinned harness exposes the semantic operation;
- `adapted`: a bounded adapter projects an upstream fact without changing its
  owner; or
- `unsupported`: the UI must use the named truthful fallback and must not try
  the other harness.

Notable current differences:

| Capability | Codex 0.147.0 | DSH rc.8 |
| --- | --- | --- |
| Project-like Chat grouping | Unsupported until the dedicated Projects Ticket proves membership mapping | Adapted from native Workspaces; never VibeHub Project truth |
| Fork | Native `thread/fork` | Native `ISessions.fork`, with parent Session lineage |
| Search | Native `thread/list.searchTerm` | Native message-content `ISessions.search` |
| Audio | Native `audio` and `localAudio` Turn inputs | Unsupported: `PromptContentPart` is text or image only |
| Attachments | Native image/localImage inputs | Native image admission and durable attachment refs |
| Delegated work | Native `collabAgentToolCall` item | Native subagent packages and Session lineage; Agent Team tasks stay opaque |
| Replay | Thread list/read/resume | Append-only Session log, pagination, and projections |

Unsupported does not mean a silent no-op. The router throws a typed
`UnsupportedHarnessCapabilityError`; product UI can then explain or hide the
action. In particular, a DSH audio attempt cannot invoke Codex, and a Codex
Project operation cannot invent Project truth from cwd.

## Single-runtime routing

`packages/harness-core/router.mjs` is constructed with exactly one adapter.
Every action is checked against that adapter's immutable capability snapshot
and then dispatched once. A caller-supplied `harnessId` that differs from the
selected carrier fails before any adapter call. The result must echo the same
harness id or the core rejects it.

The two bounded translators are:

- `packages/codex-adapter/harness.mjs`, which maps host-neutral actions to
  app-server requests and preserves exact VibeHub handoff serialization; and
- `packages/dsh-adapter/harness.mjs`, which maps the same actions to injected
  native Session/Workspace ports. It imports no Codex package and is exercised
  only with fixture ports in this contract Ticket.

The DSH adapter's existence is not evidence that the DSH carrier has been
installed or run. Clean Profile install, boot, native Chat, Task, Context,
Evidence, restart, upgrade, and removal remain acceptance owned by
`ticket-package-dsh-compatibility-plugin`.

## Clean Codex-only route

Run:

```sh
npm run probe:harness:codex-only
```

The dependency-free probe creates a temporary Codex-only core, routes an
ordinary `thread/start` plus `turn/start`, routes one byte-exact
`vibehub_ticket_handoff` through the Codex adapter, persists only the
Task-to-Thread association, restarts the core, recovers the same association,
then removes the temporary state. It also runs package-isolation assertions.
No DSH package is installed, imported, invoked, or used as a fallback.

The probe uses a deterministic app-server fixture so it cannot spend model
tokens or mutate the owner's real Thread corpus. The already accepted live
Codex adapter proof remains the runtime authority for the same request paths.

## Exact DSH source and package seams

The pinned source is official commit
`141eb6fef83422698aef7a981029e843e8161534`, package
`@deepseek-ai/dsh@0.1.0-rc.8`. Run the read-only source probe against that exact
checkout:

```sh
DSH_SOURCE_ROOT=/absolute/path/to/deepseek-harness npm test -- test/dsh-adapter.test.mjs
# or
npm run probe:dsh -- /absolute/path/to/deepseek-harness
```

The 30 checks bind the adapter boundary to:

- published CLI, Node, pnpm, Bundle/Profile, and cleanup contracts;
- Workspace creation/grouping and Session binding/open;
- Session prompt, command, search, fork, cancel, history, projection, and
  fresh running/pending-interaction facts;
- text/image prompt types and the exact absence of an audio prompt type;
- tool dispatch, approval, permission preset, Skill, and delegated-work
  packages;
- `conversation.view`, `shell.overlay`, slot lifecycle, Theme aliases, and
  `ThemeRuntime` operations; and
- base/Web/VibeHub DSH package manifests with no Codex runtime dependency.

This is a source and manifest proof only. It deliberately does not install
packages, start a Profile, open Chat, or execute a DSH Task.

## Package isolation

[`package-boundaries.json`](proposals/harness-neutral-core/package-boundaries.json)
defines five import domains. `npm run probe:harness:isolation` scans source
imports plus dependency, optional-dependency, and peer-dependency declarations.

- Task core, shared UI, and harness core may not import either upstream.
- Codex adapter may not import DSH.
- DSH adapter and Bundle may not import Codex.
- The adapter manifests pin exactly one upstream peer each.

The historical Codex/DSH spike lock under `packages/codex-adapter` is research
metadata, not a shipped dependency. Runtime imports and manifests are the
enforced package boundary.

## Failure, upgrade, and migration policy

1. Pin exact upstream versions and source/schema identities in adapter-owned
   locks. Shared core never switches behavior by detecting an arbitrary
   installed version.
2. Stop on a changed Codex schema hash, missing required request/item, or
   changed DSH source seam. Update the adapter, capability matrix, fixtures,
   and migration note together.
3. An unavailable capability degrades inside the selected carrier only. It
   never dispatches the same action through the other carrier.
4. Association rows are versioned and contain no transcript. On adapter
   migration, preserve `ticketId`, immutable origin, old `harnessId`, and old
   conversation id until the new harness explicitly creates a new association.
   Never relabel a Codex Thread as a DSH Session or vice versa.
5. If restart recovery fails, show the association as unavailable and retain
   its provenance. Do not duplicate the conversation or fabricate live state.
6. Removing a carrier removes its adapter-owned local association cache only
   when the Human requests removal; canonical Tasks, Context, Evidence, and
   Outcomes remain in Git.

## Downstream implementation sequence

1. The Codex Projects/Recents Ticket decides the missing Codex Project
   membership adapter; it updates only the `projects` capability and its own
   migration contract.
2. The Chat conformance Ticket builds the rich renderer and interactions on
   harness-owned events without moving transcript truth into shared core.
3. The production Codex shell consumes this router, Codex adapter, capability
   snapshot, and association schema. DSH is not a prerequisite.
4. Chat-to-Task bridges add explicit origin selection and association UI; one
   Chat may create multiple Tasks and remains a Chat afterward.
5. The later DSH Plugin Ticket replans from this contract, installs and boots
   the pinned or deliberately upgraded DSH package, and proves the complete
   independent DSH product loop. Any failed DSH proof affects that carrier,
   not Codex production readiness.

## Stop conditions

Stop and replan if one action can reach two adapters, shared code imports an
upstream runtime, a carrier needs the other carrier installed, association
recovery requires copying a transcript, DSH integration requires Agent Team
task coupling, a runtime event is promoted to canonical Task state, or an
upstream seam cannot be bound to the pinned source/schema. No stop condition
was observed against the pinned Codex 0.147.0 and DSH rc.8 sources in this
contract pass.
