# Independent audit: execution, tools and approvals

## Audit identity and verdict

- Reviewer: `/root/run_harness_core_contract` (independent specialized subagent)
- Audited commit: `350f0aa916dc0e96b196ab9b8917e0db8dbcd9da`
- Scope: plans and progress; command, diff, MCP and dynamic-tool activity;
  approvals and human input; delegated-agent activity; retry, error,
  interruption and completion; live/replay recovery; disclosure persistence;
  unknown fallback; and execution-surface accessibility
- Verdict: **FAIL — correction required before execution/tool/approval
  conformance can be recorded**

The carrier has a useful hierarchy: conversational answers stay primary, contiguous
execution items are grouped under one Turn disclosure, command output is bounded,
MCP progress is visible, exact command/file approval response ids round-trip, and
VibeHub Task state is not inferred from Agent activity. Those are real improvements.
They do not satisfy the accepted contract yet. Required pinned notifications are
silently ignored, transient lifecycle state can outlive or cross its owning Turn and
Thread, and pending server requests are treated as one generic approval shape even
when the host cannot answer them. The current matrix's `pass` entries for execution
progress, approvals, user input, retry and disclosure persistence are therefore too
strong.

## Sources and review method

The binding local baseline was:

- [`chat-ui-contract.json`](../../codex-native-chat/chat-ui-contract.json), the
  accepted native-Chat Outcome and research inventory;
- [`conformance-matrix.json`](../conformance-matrix.json) and both deterministic
  Chat fixtures;
- the browser implementation, reducer, loopback host and focused tests at the exact
  commit above; and
- [`upstream-lock.json`](../../../../packages/codex-adapter/upstream-lock.json),
  which pins `@openai/codex` `0.147.0`, upstream commit
  `be6e8eac029b183056b7e4402879f15d2c85f61b` and v2 generated-schema SHA-256
  `f3dec1e031d99a420b137b903f02196d4325eece57620c925bb7130b25f168d2`.

Protocol claims were checked against the [official app-server README at the pinned
commit](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server/README.md),
the [pinned app-server protocol
source](https://github.com/openai/codex/tree/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server-protocol),
and a fresh local schema generation from the installed `codex-cli 0.147.0`. The
generated v2 bundle matched the pinned SHA-256 exactly. No proprietary Codex
Desktop implementation, assets, icons or private APIs were inspected or copied.

## Conformance results

| Area | Result | Severity | Exact finding |
| --- | --- | --- | --- |
| Plans and progress | **Fail** | Highest | The pinned `turn/plan/updated` structured notification is not handled. Only experimental `item/plan/delta` mutates the reducer, so a supported current plan can remain invisible until or unless a completed `plan` item appears. |
| Commands | **Partial** | Highest | `item/commandExecution/outputDelta` folds and completed items replace it, but identity is keyed by bare item id and can cross Threads. Command metadata such as parsed actions, source and plugin identity is dropped, and the fixture proves only one short successful command. |
| File changes and diffs | **Fail** | Highest | The required pinned `turn/diff/updated` and `item/fileChange/outputDelta` notifications return `false` from the reducer. The implementation instead handles `item/fileChange/patchUpdated`, which is not the only pinned path. Live aggregate diff/output can therefore disappear. |
| MCP and dynamic tools | **Partial** | Highest | MCP text progress folds. Non-text MCP result content and dynamic-tool image/audio output are silently reduced to empty strings; result truncation has no omission notice. The required `item/tool/call` server request is collected as pending but the host cannot resolve it. |
| Command/file approvals | **Fail** | Highest | Known base decisions carry the exact JSON-RPC request id, but the card omits material decision context (cwd, item identity, parsed command actions, grant root, network/permission amendments), exposes no distinct Cancel-and-interrupt action, and renders any unsupported request as “Approve command?” before the host rejects it. |
| Human input | **Fail** | Highest | The response shape maps exact question ids correctly, but `header`, `isBlocking`, `autoResolutionMs` and `isSecret` are ignored. A non-blocking request falsely says “Turn paused”; secret input is plain text; `isOther` changes all options to checkboxes instead of offering a free-form Other path; and any streamed repaint destroys typed answers and focus. |
| Delegated/sub-agent activity | **Partial** | Highest | Completed `collabAgentToolCall` state is inspectable, but the fixture's `subAgentActivity.kind: "completed"` is invalid against the pinned enum (`started`, `interacted`, `interrupted`). There is consequently no schema-valid executable proof of the delegated timeline, and truncated thread ids have no inspect/copy affordance. |
| Retry, error, interruption and completion | **Fail** | Highest | Retry and terminal cards exist, but transient `turnErrors` are never retired. A retry notification remains visible after authoritative successful completion; a terminal error plus a failed replayed Turn renders both an error card and a failed boundary. This violates the one authoritative terminal-boundary contract. |
| Live versus replay and reconnect | **Fail** | Highest | Live items are global and keyed only by `itemId`; replay dedupe also uses bare ids. Execution from another Thread can enter the active timeline. The 500-event host window has no oldest-cursor/gap signal, the browser does not reconcile after a gap or reconnect, and `runtimeExit` is ignored, so stale live/connected posture can persist. |
| Disclosure persistence | **Fail** | Highest | Open disclosures are sampled, but an explicitly closed running/failed disclosure is reopened on every paint because rendering supplies `open` again. Group identity also changes as items arrive. More importantly, full-surface `innerHTML` replacement destroys pending-form values and focused controls. |
| Unknown fallback | **Partial** | Highest | Unknown completed Thread items are escaped, bounded and do not invent success; unknown deltas are non-mutating and remain in the bounded host event log. Unknown or unsupported **server requests**, however, are presented as actionable command approvals and left blocking instead of receiving an immediate truthful unsupported response/fallback. |
| Accessibility | **Fail** | Highest | Native `details`, `fieldset`, labels and buttons are a sound base. Pending human attention is not focus-managed or labelled as an alert/dialog, focus is destroyed by streaming repaint, the whole surface is one `aria-live` region, and CSS gives no explicit `:focus-visible` treatment to `summary` or option inputs. Secret and non-blocking semantics are not exposed accessibly. |

## Highest-severity findings

### 1. The reducer does not cover the pinned execution protocol

[`chat-model.mjs`](../../../../apps/codex-first-shell-prototype/chat-model.mjs)
handles item text/plan/command deltas, `item/fileChange/patchUpdated`, MCP progress,
completion and error. It has no case for the lock's required
`turn/plan/updated`, `turn/diff/updated` or `item/fileChange/outputDelta` events.
A direct reducer probe at the audited commit returned `false` for all three.

This is not harmless redundancy. `turn/plan/updated` carries structured
`{ step, status }` progress, while `turn/diff/updated` carries the authoritative
latest aggregated Turn diff. The accepted inventory explicitly requires both.
The current fixture also uses an impossible delegated event (`subAgentActivity`
kind `completed`), so the green test is not a protocol-valid substitute.

Required correction:

1. Generate a checked-in event census from the pinned v2 schema and require every
   supported notification to map to `render`, `reconcile`, `diagnostic-only` or a
   deliberate truthful deferral.
2. Store structured Turn plan and aggregate diff state under exact Thread/Turn
   identity; completed replay remains authoritative.
3. Handle the pinned file-change output path or explicitly prove it is redundant
   before discarding it.
4. Schema-validate all conformance fixtures, including delegated-agent enums.

### 2. Transient execution state is not owned by Thread and Turn

`liveItems` is a single browser `Map` keyed by bare `itemId`, and
`canonicalTimeline()` dedupes replay by bare id. A direct probe starting the same
command id in Threads A and B caused Thread A's timeline to display Thread B's
command. The same defect was independently observed for message state; for this
audit it also invalidates command, tool, file and delegated activity isolation.

Error ownership has a second defect. `turnErrors` is keyed by Turn but never cleared
or reconciled on `turn/completed`. Direct probes produced:

- a successful completed Turn that still displayed `Codex is retrying`; and
- one failed authoritative Turn rendered as both `boundary-<turn>` and
  `error-<turn>`.

Required correction:

1. Key every transient item and error by exact `(threadId, turnId, itemId/kind)`.
2. Scope `canonicalTimeline()` to the requested Thread and reconcile transient
   error state with the authoritative completed Turn.
3. Add collision tests across two simultaneous Threads and two Turns for command,
   tool and delegated activity, not only Agent text.
4. Add retry-success and retry-terminal fixtures asserting zero stale retry cards
   and exactly one terminal boundary.

### 3. Recovery can silently lose execution events

The host truncates its event array to 500 entries. `/api/events` returns only
entries newer than the browser cursor plus the latest cursor; it does not return
the oldest retained cursor or a `gap` flag. The browser then advances its cursor
without detecting loss and only calls `thread/read` when it happens to observe
`turn/completed`. A temporary disconnect or a busy Turn can therefore drop item
completion, plan, diff, approval-resolution or Turn completion and leave stale
running state.

The host records `runtimeExit`, but `pollEvents()` skips every non-notification
except pending-request refresh. The loopback process can remain responsive while
the child app-server is dead, leaving the visible runtime posture and controls
false. This contradicts the accepted reconnect rule: resume from a cursor, detect
loss, then reconcile through `thread/read` before claiming settled state.

Required correction:

1. Return `oldestCursor`, current cursor and an explicit gap/runtime generation.
2. On gap, transport recovery, app-server restart or runtime exit, disable live
   actions, reconcile the active Thread, then restore a truthful posture.
3. Reconcile unresolved requests using the official `serverRequest/resolved`
   notification; do not leave cards that another client already answered.
4. Add deterministic >500-event and child-exit recovery tests.

### 4. Server requests need a discriminated registry, not one approval template

The host stores every app-server request in `pendingRequests`. The browser decides
the title using substring checks; anything other than file change or
`requestUserInput` becomes “Approve command?”. The host can actually answer only
command approval, file approval and request-user-input. Even the lock's required
`item/tool/call` reaches an actionable-looking dead end. The exact generated
0.147.0 server-request schema also contains permission approval and MCP elicitation
shapes that this experimental client can observe; these must never be silently
treated as command approval.

Known approval cards are not sufficiently reviewable either. A command request can
carry cwd, parsed actions, reason and proposed exec/network-policy amendments; a
file request can carry reason and grant root. The current card chooses only one
short string. It also hides the official semantic distinction between `decline`
(continue the Turn) and `cancel` (deny and immediately interrupt the Turn).

Required correction:

1. Define a versioned discriminated server-request registry with an exact renderer,
   response validator and supported-decision set per method.
2. Never render an unsupported request as an approval. Show an inspectable disabled
   fallback and immediately return a protocol error or other exact supported
   response so the Agent does not wait forever.
3. Render all material approval context, link it to the exact execution item, and
   expose Cancel-and-interrupt separately from Decline.
4. Consume `serverRequest/resolved` so multi-client resolution removes stale UI.

### 5. Human-input and disclosure state cannot survive normal streaming

`requestUserInput` is rendered as semantic fieldsets, but every execution repaint
replaces the entire surface using `innerHTML`. Typed textarea content, radio state
and focus are not stored. A concurrent MCP progress delta can erase the user's
unfinished answers. Disclosure restoration only remembers open ids; it cannot
remember that the user deliberately closed a disclosure which the renderer marks
open because it is running or failed. As a group receives another item its
concatenated identity also changes.

The request renderer additionally ignores protocol semantics that affect safety:
`isSecret` must not become visible plain text, and `isBlocking: false` must not say
the Turn is paused. `isOther` is not a multi-select flag and cannot justify changing
every option from radio to checkbox.

Required correction:

1. Keep pending response drafts and explicit disclosure posture in keyed UI state,
   or patch stable DOM nodes rather than replacing the whole surface.
2. Render blocking, secret, header, option and Other behavior from the exact schema;
   validate required answer posture before response.
3. Move focus to newly blocking human input, announce it in a bounded live region,
   and return focus after resolve, decline or cancellation.
4. Add browser tests that type partial answers, stream progress, switch disclosures,
   resolve from another client and assert values/focus remain correct.

### 6. Tool and delegated output has silent supported-content loss

The renderer extracts only `.text` from MCP content and text-like entries from
dynamic-tool output. Official dynamic output also admits image and audio entries;
MCP results can carry structured and non-text content. Those entries currently
vanish instead of appearing through a typed renderer or inspectable unsupported
part. Tool result text is sliced before Markdown rendering but does not show the
omitted-character notice used by command and diff disclosures.

Delegated work has readable high-level status, but full receiver identity, sender
identity, per-agent messages and schema-valid sub-agent transitions are not
exercised. Until that proof exists, the grouped “Worked on this Turn” label is only
a visual summary, not conformance evidence.

## Relevant maintained open-source comparison

Repository, license, maintenance and security/dependency facts were rechecked on
2026-08-21. No source was copied during this audit.

| Candidate | Relevant facts | Decision boundary |
| --- | --- | --- |
| [yunhaoli24/codex-gateway](https://github.com/yunhaoli24/codex-gateway) | MIT; active app-server-specific project with 267 commits shown at review. Its documented UI covers plans, command/file/tool activity, dynamic requests, sub-agents, reconnect/state repair and real app-server Playwright E2E. Its Nuxt server also owns SSH, SQLite, remote credentials, terminals, preview proxying and a broad dependency/security surface. | Reimplement its typed dynamic-request registry, runtime generation/reconnect discipline and real approval/sub-agent E2E patterns. Do not adopt its SSH, persistence, remote gateway or second cache as VibeHub transcript truth. |
| [lezi-fun/codex-webui](https://github.com/lezi-fun/codex-webui) | MIT source with security policy and unit/browser/integration/E2E suites. It documents command, file, network and permission approvals, approval scopes, real notification-driven tool states and a real approval E2E. It carries Bun/WebSocket/PTY/git-apply/Markdown/KaTeX/xterm surfaces. Its README also says extracted Codex-style assets are **not** covered by MIT. | Reference its approval view-model and real approval E2E cases. Do not import its server/runtime or any Codex-derived visual assets. |
| [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) | MIT, actively maintained production React primitives with Base UI/Radix composition and an optional cloud/runtime layer. It is generic Chat UI, not Codex protocol authority, and brings React plus its state/accessibility/runtime dependency surface. | Selectively adapt stable form, disclosure, focus and message-part primitives after the Codex reducer is correct. Do not use its runtime or persistence to reinterpret app-server lifecycle. |

These comparisons converge on the accepted architecture: retain one small,
versioned Codex adapter as truth; use mature UI primitives only below that adapter;
and test real server requests and recovery instead of inferring them from DOM text.

## Focused verification

The following checks were run from the exact audited commit:

- `node --test test/codex-chat-conformance.test.mjs test/codex-first-shell-prototype.test.mjs test/codex-adapter.test.mjs`
  passed **17/17** with authorized local runtime/loopback access. The first
  sandbox-only attempt failed only because `codex app-server` exited under the
  restricted environment; no product conclusion was drawn from that attempt.
- `node packages/codex-adapter/probe-schema.mjs` passed every pinned request,
  server-request, notification, audio-input and schema-hash check.
- Direct reducer probes proved the three required notification omissions, the
  cross-Thread execution collision, stale retry-after-success and duplicate
  failed-Turn terminal surfaces described above.
- Source inspection confirmed that existing tests execute reducer helpers but use
  string-pattern assertions for the approval forms, disclosure persistence and
  host routing. There is no browser-level execution/request-state regression test.

Green focused tests therefore prove that the current implementation matches its
limited fixture, not that the fixture covers the pinned execution protocol.

## Prioritized recommendation and matrix correction

1. **P0 — protocol census and identity:** implement every required plan/diff/file
   event under composite Thread/Turn/item identity and schema-validate fixtures.
2. **P0 — authoritative lifecycle/recovery:** retire transient errors on
   reconciliation, guarantee one terminal boundary, detect event-window gaps and
   app-server generation changes, and reconcile before restoring live claims.
3. **P0 — typed server requests:** add exact method registries, known payload and
   decision validators, external-resolution handling and truthful unsupported
   fallback. Never present a request the host cannot answer as an approval.
4. **P0 — durable human interaction:** preserve form values, secret posture,
   explicit disclosure state and focus across streaming; add real browser tests.
5. **P1 — tool/delegation truth:** render or explicitly fall back for non-text tool
   content, expose truncation, and add schema-valid delegated-agent cases.
6. **P1 — informed approvals and accessibility:** show full decision context,
   distinguish Decline from Cancel-and-interrupt, bound announcements, and verify
   keyboard/focus return at wide and 390x844 layouts.

Before canonical Evidence is recorded, change matrix entries
`execution-tool-progress`, `approvals`, `request-user-input`, `retry` and the
execution portion of `thread-replay-identity` from `pass` to `fail` or `partial`.
Keep `unknown-items` as a pass only for completed **Thread items** and add a separate
failing server-request fallback check. `interruption-recovery` can remain accepted
for the previously proved manual interruption path, but terminal failure and retry
reconciliation need their own failing check; the broader lifecycle is not yet a
pass.
