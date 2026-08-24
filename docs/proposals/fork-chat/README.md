# Fork Chat: interaction directions

Fork today is one header button that copies the whole Thread and opens it;
lineage renders as a raw `Fork of <uuid>` line and nothing else in the product
shows branch relationships. This proposal establishes the protocol facts from
the pinned 0.149.0 baseline and upstream source, grounds fork in real daily
scenarios, makes three interaction directions reviewable in the real shell
against fixtures, and hands the owner the exact decisions. Nothing here ships
product behavior: every review surface is gated behind `?forkFixture=…`, runs
on fixture data, refuses sends, and spends no model.

**Run the review surfaces (one command, no model spend):**

```
npm run review:fork-chat                 # boots the shell on the fixture app-server and prints the five review URLs
npm run review:fork-chat -- --captures   # regenerates docs/proposals/fork-chat/captures/*.png headlessly
```

Machine-readable companion: [fork-interaction-contract.json](./fork-interaction-contract.json).

---

## 1 · Facts: what the protocol and the desktop actually offer

Baseline: `@openai/codex` 0.149.0, release `rust-v0.149.0`, commit
`758ef40f50c1a458425c7cfbf1eb12cbc07af0b0`. For this proposal
`codex app-server generate-json-schema` was run read-only on the installed
0.149.0 binary; the emitted v2 schema is byte-identical to the pinned
`protocolSchemaSha256` (`9b3de71a…`) in `packages/codex-adapter/upstream-lock.json`.
Upstream rust references below are at that commit.

### 1.1 Fork from a point: yes, at Turn granularity, stable

`thread/fork` (`ThreadForkParams`, required: `threadId`) carries **`lastTurnId`**,
stable in 0.149.0: *"Optional last turn id to fork through, inclusive. When
specified, turns after `last_turn_id` are omitted from the fork. The referenced
turn cannot be in progress."* Fork boundaries are **Turns**; no item-level fork
exists anywhere in the params.

- Stable params: `threadId`, `lastTurnId`, `model`, `modelProvider`,
  `serviceTier`, `cwd`, `approvalPolicy`, `approvalsReviewer`, `sandbox`,
  `config`, `baseInstructions`, `developerInstructions`, `ephemeral`,
  `threadSource`.
  — generated v2 schema, definition `ThreadForkParams`.
- Experimental (present in rust, stripped from the pinned generated schema):
  `beforeTurnId` (exclusive boundary, rejected when combined with
  `lastTurnId`), `path`, `permissions`, `runtimeWorkspaceRoots`,
  `excludeTurns`, `deferGoalContinuation`.
  — `codex-rs/app-server-protocol/src/protocol/v2/thread.rs` (`#[experimental(…)]` attributes).
- Server-side truncation: legacy path `truncate_rollout_after_turn_id` /
  `truncate_rollout_before_turn_id`; paginated path
  `thread_store.prepare_fork` with `ForkBoundary::ThroughTurn / BeforeTurn / Latest`.
  — `codex-rs/app-server/src/request_processors/thread_processor.rs`, `thread_fork_inner`.
- Upstream tests cover the prefix cut and live-turn edges:
  `thread_fork_at_last_turn_id_keeps_only_terminal_prefix`,
  `thread_fork_can_cut_before_unfinished_stored_turn`,
  freeze-active-turn cases.
  — `codex-rs/app-server/tests/suite/v2/thread_fork.rs`.

**Already plumbed in this repository:** the shell host action `forkThread`
accepts `payload.lastTurnId` (`scripts/vh-codex-first-shell.mjs`) and the
adapter forwards it (`packages/codex-adapter/projects.mjs forkThread`). Only
the browser affordance is missing.

### 1.2 Lineage fields and restart survival

- The fork response is `ThreadForkResponse { thread, model, modelProvider,
  serviceTier, cwd, instructionSources, approvalPolicy, approvalsReviewer,
  sandbox, … }` with `thread.forkedFromId` naming the source, and a
  `thread/started` notification announces the fork.
  — generated v2 schema; `thread_processor.rs` (`thread_started_notification`);
  upstream test `thread_fork_creates_new_thread_and_emits_started`.
- `forkedFromId` is **persisted in the rollout's `SessionMeta`**
  (`codex-rs/protocol/src/protocol.rs`, `SessionMeta.forked_from_id`), so
  `thread/read` and `thread/list` rebuild it from disk after any restart;
  `thread/list` rows carry it (`Thread.forkedFromId` in the v2 `Thread`
  definition), so the Sidebar needs no extra reads. Our live probe already
  proved fork lineage recovery across an app-server restart
  (`packages/codex-adapter/probe-projects-live.mjs`).
- Chains nest: a fork of a fork names the middle Thread (upstream test asserts
  `nested_thread.forked_from_id == forked_thread_id`).
- Name inheritance: an **explicitly set** source name is inherited
  (`thread_fork_inherits_explicit_source_name_from_session_index`); an unnamed
  source's fork stays `name: null` (asserted in
  `thread_fork_creates_new_thread_and_emits_started`).
- **The fork point is not persisted.** `SessionMeta` records only
  `forked_from_id`. "Cut at Turn N" is derivable — `thread/fork` replays the
  source's Turns with their ids, so the shared Turn-id prefix of the two
  transcripts is exactly what the fork inherited — but the derivation needs
  both transcripts read (two `thread/read`). Every divergence claim in the
  review surfaces is derived this way, never invented.
- Distinct concept, never conflated: `Thread.parentThreadId` is set only for
  AgentControl subagents and is not fork lineage (v2 `Thread` definition).

### 1.3 ThreadSection placement and the race

`thread_fork_inner` never touches `Thread.section`: **a fork inherits no
section**. In 0.149.0 it does inherit the server-owned `projectId`
(`inherited_project_id = source_thread.project_id`, staged via
`stage_pending_project_metadata(..., "thread/fork")`), but no ClientRequest
assigns `projectId`, so `Thread.section` stays the membership authority this
adapter consumes (`packages/codex-adapter/upstream-lock.json`,
`baselineDiff.addedToPinnedShapes`). Hence the shipped behavior
(`packages/codex-adapter/projects.mjs`,
`docs/proposals/codex-projects/project-object-contract.json`): the adapter
moves the fork into the source's section after creation; if the section
disappears in that race the fork remains a valid unsectioned Chat in Recents
and the response reports `placement.applied=false`. That report is transient;
the durable truth is the two `Thread.section` values — which is what the
review chip's placement note derives from.

### 1.4 What Codex desktop exposes for forks

Observed by reading strings from the installed
`/Applications/ChatGPT.app/Contents/Resources/app.asar` (bundle dated
2026-07-17). **Honesty:** the bundled codex version is not stated in the
strings and that build's protocol surface differs from pinned 0.149.0 (it also
carries `thread/turns/list`, `thread/metadata/update`), so these are
bundle-observed claims, not 0.149.0 claims; absence of a string is reported as
"not found", never as proof of absence.

- The fork affordance is **per assistant message**: a hover button with
  tooltip **"Continue in new chat"** (`assistantMessageContent.forkTooltip`),
  plus an app-scope command/shortcut `forkThread` titled "Continue in new
  chat" / "Create a new chat from the current chat".
- Fork-from-a-point in that build is a **head `thread/fork` followed by
  `thread/rollback { threadId, numTurns }`** cutting the trailing Turns
  ("Target turn not found" path). `thread/rollback numTurns: 1` also powers
  edit-most-recent-message ("Only the most recent message can be edited").
  In pinned 0.149.0, `ThreadRollbackParams` is documented **"DEPRECATED:
  `thread/rollback` will be removed soon"** — so `lastTurnId`, not
  fork+rollback, is the go-forward point-fork seam.
- Fork naming: the desktop walks the `forkedFromId` chain to the root, reuses
  the root's base title, and dedupes as **"Title (N)"** (regex
  `^(.*) \((\d+)\)$`). The fixture family mirrors this shape.
- `forkedFromId` also drives cross-host **git-worktree reuse** on handoff.
- **No lineage-navigation UI found**: no "forked from" user-facing copy, no
  source chip, no fork list or tree in the bundle's strings. The observed
  consumers of `forkedFromId` are title dedup and worktree reuse. (Unverified
  beyond strings.)

---

## 2 · Daily scenarios, and what fork is not for

Every affordance below is judged against these concrete scenarios (drawn from
the daily-use research in `docs/CODEX_PROJECTS_RECENTS_PARITY_RESEARCH.md`,
`docs/HARNESS_PRODUCT_LOGIC.md` and the fork parity work), not abstract
completeness. The review fixture family renders exactly these.

1. **Risky-instruction sandbox** (`fork-risky-cleanup`): try a destructive or
   speculative instruction — drop a legacy table, rewrite a migration — in a
   fork so the main stream's context stays clean; discard the fork on failure,
   bring one result home on success. Needs: know where I came from (chip),
   cut before the noisy tail (point-fork), return the one result (Bring Back).
2. **Prompt A/B** (`fork-prompt-variant`): same problem, different framing;
   fork at the shared prefix, compare answers, carry the winning fragment
   back. Needs: fork-from-turn, lineage visibility (which variant is which),
   Bring Back.
3. **Alternative-approach exploration** (`fork-nested-refine`): pursue
   approach B without losing approach A's stream; refinements may nest. Needs:
   find the family later (sidebar tree), honest chain rendering (depth cap).
4. **Placement-race recovery** (`fork-prompt-variant` sits in Recents while
   its source sits in a group): after a lost placement race the fork must
   still show its lineage and say where it landed. Needs: chip + derived
   placement note.

**Anti-scenarios, with the decision that excludes each:**

- *Fork as Subtask, Task or dependency* — excluded by
  `.vibehub/rooms/product/decision-chat-streams-birth-and-associate-independent-tasks.yaml`
  and the invariant in `project-object-contract.json`: a Chat fork is a Thread
  lineage edge, never a work-graph edge. No fork appears in the Task graph.
- *Fork as Task origin* — Task origin is one immutable provenance locator;
  forking, moving or renaming the Chat never moves or rewrites a Task
  (`project-object-contract.json`, `taskOrigin.mutationRule`).
- *Fork as file checkpoint* — fork copies conversation history only; it never
  snapshots or reverts working-tree state (the same truth
  `ThreadRollbackParams` documents for rollback). No affordance may imply file
  rollback.
- *Fork as agent fan-out* — subagents are `parentThreadId`, a different edge;
  fork stays a human thought-stream branch.
- *Auto-fork on risky commands* — fork remains an explicit human act; VibeHub
  creates no background captures (native-chat additive-actions decision).

---

## 3 · Lineage directions, reviewable in the real shell

All three run in the production shell against `fork-fixtures.json` behind the
`?forkFixture` gate: the header says "Review fixture · not runtime history",
the fixture action sink serves reads only, and a send is refused with an
honest notice. Wide (1280×800) and narrow (390×844), Light and Dark, keyboard
paths and empty states are captured under [captures/](./captures/).

### Direction A — navigable source chip (replaces the raw UUID line)

`?forkFixture=chip` · `chip-source` · `chip-missing`

The raw ` · Fork of <uuid>` line becomes, under the Chat heading:

- on a fork: **`⑂ Forked from <source title>`** — a button that opens the
  source — with a derived sub-line `Lineage from Thread.forkedFromId · shares
  1 of 2 source Turns, then diverges`, and, when memberships differ, the
  placement note `This fork lives in Recents; its source lives in the Auth
  hardening group.`
- on a source: **`⑂ N forks of this chat`** — a disclosure listing each fork
  with title, preview and group, each row opening that fork.
- honest empty state: a fork whose source no list carries renders a
  non-navigable dashed chip — *"Forked from a chat not listed in this
  folder"* — naming the truncated source id and why nothing opens.

| State | Capture |
| --- | --- |
| Fork side, wide Light / Dark | [chip--wide-light](./captures/chip--wide-light.png) · [chip--wide-dark](./captures/chip--wide-dark.png) |
| Fork side, narrow Light / Dark | [chip--narrow-light](./captures/chip--narrow-light.png) · [chip--narrow-dark](./captures/chip--narrow-dark.png) |
| Keyboard focus on the chip | [chip--keyboard-focus](./captures/chip--keyboard-focus--wide-light.png) |
| Source side with fork list (+ keyboard) | [chip-source--wide-light](./captures/chip-source--wide-light.png) · [chip-source--wide-dark](./captures/chip-source--wide-dark.png) · [chip-source--keyboard-focus](./captures/chip-source--keyboard-focus--wide-light.png) |
| Missing source, honest empty state | [chip-missing--wide-light](./captures/chip-missing--wide-light.png) · [chip-missing--wide-dark](./captures/chip-missing--wide-dark.png) |

**Canonical data:** `forkedFromId` of the open Chat; the folder's listed rows
(titles, `forkedFromId`, `section`) — all already in bootstrap; the shared
Turn-prefix derivation needs both transcripts. **Host projection:** none new;
production would add one lazy `thread/read` of the source if the divergence
sub-line is wanted. **Keyboard:** chip and rows are ordinary buttons; opening
moves focus to the opened Chat's title.

### Direction B — sidebar fork tree

`?forkFixture=sidebar`

Within each Sidebar list, a fork indents one step under its source row with a
branch glyph and an sr-only "Fork · " prefix; chains nest to a capped depth of
3; a fork whose source is not in the same list stays flat — no placeholder
parent is invented. DOM order equals reading order, so the Tab path is
unchanged.

| State | Capture |
| --- | --- |
| Wide Light / Dark | [sidebar--wide-light](./captures/sidebar--wide-light.png) · [sidebar--wide-dark](./captures/sidebar--wide-dark.png) |
| Narrow Light / Dark (drawer) | [sidebar--narrow-light](./captures/sidebar--narrow-light.png) · [sidebar--narrow-dark](./captures/sidebar--narrow-dark.png) |
| Keyboard focus on a nested row | [sidebar--keyboard-focus](./captures/sidebar--keyboard-focus--wide-light.png) |

**Canonical data:** `forkedFromId` on every listed row — already projected
into bootstrap by `publicCodexThread`. **Host projection:** none; nesting is a
pure browser projection over one list's rows. **Named cost:** nesting reorders
a recency-sorted list — a fork touched yesterday renders under a source
touched last week. The capture shows this honestly; it is the direction's real
trade-off, and the reason A-without-B is a coherent outcome.

### Direction C — Bring Back (built on quote/origin/text_elements)

`?forkFixture=bringback`

Selecting a finalized passage in a fork whose source is listed adds **"Bring
back to source"** to the existing selection sheet. The action opens the source
Chat and places the passage in its composer as a quote whose identity names
the **fork's** Thread, Turn and item; the tray labels it *"Brought back from
fork `<id>` · Turn `<id>`"*. Nothing is sent: the explicit send stays with the
human (and the review fixture refuses it). On send, the shipped
`quote-source.mjs` machinery serializes that exact identity into the Turn
input — durable in Codex history, replayable in any client — and `buildOrigin`
already carries `forked_from_id` if the passage later becomes a Task or
Context through the explicit bridge.

| State | Capture |
| --- | --- |
| Fork open, wide Light / Dark | [bringback--wide-light](./captures/bringback--wide-light.png) · [bringback--wide-dark](./captures/bringback--wide-dark.png) |
| Selection sheet with the action | [bringback--selection--wide-light](./captures/bringback--selection--wide-light.png) · [bringback--selection--wide-dark](./captures/bringback--selection--wide-dark.png) |
| Landed in the source composer | [bringback--landed--wide-light](./captures/bringback--landed--wide-light.png) · [bringback--landed--wide-dark](./captures/bringback--landed--wide-dark.png) |
| Narrow Light / Dark | [bringback--narrow-light](./captures/bringback--narrow-light.png) · [bringback--narrow-dark](./captures/bringback--narrow-dark.png) |

**Canonical data:** the selection's finalized item identity (existing
machinery), `forkedFromId` for the target, the quote serialization already in
the send path. **Host projection:** none — the composer quote already supports
cross-Thread identity. **Empty states:** the action is simply absent on an
orphan fork or a non-finalized selection — never a dead button.

### Direction D — "Fork from here" (defined, not built)

The desktop's own affordance shape — "Continue in new chat" on each assistant
message — on the **stable** 0.149.0 seam: a per-message control calling
`thread/fork` with `lastTurnId` = that Turn, instead of the deprecated
fork+rollback. Host and adapter already accept `lastTurnId`; the open cost is
one control per finalized Turn (a visual-weight decision) plus the existing
placement and lineage behavior. Named here for the decision list; no review
surface was built because the interaction is the already-reviewed fork flow
with a different entry point.

---

## 4 · Compare and Bring Back, scoped honestly

The pre-Codex spike validated Fork, Compare and Bring Back as product-owned
projections and deliberately kept them out of the harness
(`.vibehub/outcomes/ticket-spike-deepseek-harness-foundations.yaml`). On the
Codex-first architecture they mean the following.

**Bring Back** (built, above): returning one fork result into its source Chat
as an explicit, reviewable, human-sent quote that permanently names the fork
it came from. Cost to productionize: the selection-sheet button, the
target-open step, the tray label — no host change, no new durable record.

**Compare** (defined, not built): side-by-side reading of a fork against its
source from their shared prefix. It requires two `thread/read` transcripts,
the derived shared-prefix alignment point, and a **two-pane transcript
layout** the shell does not have: scroll coordination, a narrow-viewport story
(stacked panes or a switcher), and its own wide/narrow/Light/Dark/keyboard
matrix. There is no protocol gap — both transcripts replay — but it is the
largest single cost in this proposal, for a reading act that two browser
windows already approximate at zero cost.

**Recommendation:** Bring Back enters the next implementation, together with
Direction A and Direction D. Compare waits, and returns only if daily use
shows two-window reading failing at the moments that matter (the A/B
scenario's final judgment).

---

## 5 · Recommended composition, exact costs, what stays out

**Recommended composition** (in order):

1. **Direction A** — the chip replaces the raw UUID line; the source side
   lists its forks. This is the smallest change that makes lineage a real
   product object.
2. **Direction C** — Bring Back on the shipped quote machinery; it is what
   makes the sandbox and A/B scenarios complete a round trip.
3. **Direction D** — per-message "Fork from here" via stable `lastTurnId`,
   matching the desktop's mental model on the supported seam.
4. **Direction B** — hold. Ship it only if the owner values family grouping
   over recency truth in the Sidebar; the fork list on the source side
   (Direction A) already answers "where are my forks" without reordering
   lists.

**Exact cost of this review** (all gated, production behavior unchanged):
158 insertions across 6 existing files — `app.js` +137 (fixture bootstrap,
gated markup, three handlers), `app.css` +26, `index.html` +1,
`browser-interaction-guard.mjs` +1 (pointer-target list),
`vh-codex-first-shell.mjs` +2 (serving the two review assets),
`package.json` +1 — plus new files: `fork-review.mjs` (pure projections,
~110 lines), `fork-fixtures.json`, `vh-fork-chat-review.mjs` (driver),
`test/fork-review.test.mjs` (10 tests). Test suite 307→317, all passing;
guard unchanged at 109/110 per frame, lifecycle 6/6, queue 12/12.

**Estimated production cost, if adopted:** Direction A ≈ the review markup
un-gated plus a lazy source `thread/read` for the divergence line (small);
Direction C ≈ the review flow un-gated (small); Direction D ≈ one per-message
control plus passing `lastTurnId` the host already accepts (small-medium,
dominated by visual weight decisions); Direction B ≈ the review projection
un-gated (small) but with the recency trade-off. Compare ≈ a new layout
surface (large).

**What stays out**, by existing decision or this proposal:

- Fork as Subtask/Task/dependency, fork edges in the Task graph, fork as Task
  origin (accepted Chat/Task decision).
- Any durable browser-side record: lineage, placement and divergence render
  from what the protocol persists or what two transcripts derive.
- Recording the fork point in lineage — upstream owns `SessionMeta`; we
  derive, and say so.
- `beforeTurnId`, `thread/fork.path` and the other experimental params —
  nothing is built on unpinned seams.
- `thread/rollback` — deprecated upstream; never adopted here.
- Compare's two-pane surface (waits), auto-fork, background capture.
- Final visual identity — owned by the visual-system Ticket; everything here
  uses the shell's existing tokens and is review-grade, not final.

---

## 6 · Decisions for the owner

1. **Chip (A):** replace the raw `Fork of <uuid>` line in production with the
   navigable source chip? Keep the full source id available anywhere (e.g.
   title attribute), or drop it entirely?
2. **Forks-of listing (A, source side):** adopt the heading disclosure listing
   a Chat's forks? Open by default or closed?
3. **Divergence sub-line (A):** worth the lazy source `thread/read`, or ship
   the chip without the shared-Turns claim?
4. **Bring Back (C):** enters the next implementation Ticket? (Recommended
   yes.)
5. **Fork from here (D):** add the per-message point-fork on `lastTurnId`?
   (Recommended yes.) Header button stays, moves, or both?
6. **Sidebar tree (B):** ship, hold, or drop — is family grouping worth
   breaking recency order in Sidebar lists? (Recommended hold.)
7. **Compare:** wait (recommended), or schedule the two-pane surface now?
8. **Fork naming:** adopt desktop-style root-title "(N)" dedup when the
   source has no explicit name, or keep preview-derived titles as today?

---

*Review surfaces and captures: `npm run review:fork-chat` /
`npm run review:fork-chat -- --captures`. Fixture family:
`apps/codex-first-shell/fork-fixtures.json`. Pure projections and their
tests: `apps/codex-first-shell/fork-review.mjs`,
`test/fork-review.test.mjs`.*
