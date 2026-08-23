# Final browser and Codex runtime review

This review exercises the corrected carrier at application commit `fac258a`. It
is browser and runtime proof for the conformance matrix, not a claim that the
research carrier has production visual polish or complete Codex Desktop parity.

## Deterministic real-DOM guard

The final opt-in mixed fixture ran through the actual shell DOM and reported:

- `PASS browser interaction guard · 25/25`, with every individual check visible
  as PASS and zero browser warnings or errors;
- a 390x844 run before the final viewport-independent terminal assertion passed
  24/24 with `clientWidth = scrollWidth = 390`;
- the final 25-check run added authoritative active-to-terminal reconciliation:
  an interrupted Turn returns the Composer to idle and refreshes Fork from
  disabled to enabled without a page reload;
- narrow Sidebar open, inert background, focus entry, Close, scrim, Escape and
  trigger-focus return all passed;
- Search modal inert posture, input focus, combobox/listbox identity, keyboard
  movement, Escape and focus return passed;
- a multi-question request-user-input card preserved question ids, radio and
  Other text, secret/blocking posture, draft value and focus through keyed
  reconciliation;
- Quote created a Thread-owned source-bearing draft, switching to another
  Thread did not leak it, and returning restored it;
- the active fixture exposed exact `currentTurnId`, visible Stop and Steer rather
  than a second Turn start; the terminal fixture exposed Send, hid Stop and made
  no false live claim;
- the real Fork action returned a new Thread with source lineage and opened it;
  reduced-motion posture, Dark overlay tokens and responsive overflow also
  passed.

The fixture is deterministic but not fixture-only proof: its guard clicks and
types through the actual application controls and inspects the resulting DOM and
host-action payloads. Node regressions independently exercise the reducer,
renderer, request registry, event window and Composer draft store.

## Wide Light and Dark review

At 1280 CSS pixels, the mixed fixture was reviewed in both Light and Dark. Agent
Markdown, long code, aggregate diff, pinned plan, command/tool activity, approval,
MCP progress, delegated work, citation identity and image/audio/skill/mention
attachments were readable and remained subordinate to the conversation. The
terminal posture showed Send with Stop hidden and no live indicator.

Both themes had `clientWidth = scrollWidth = 1280` and zero console errors. Dark
mode measured the body at `rgb(24, 24, 24)` and modal overlay at
`rgb(28, 28, 28)`; faint explanatory text remained readable. This review checks
hierarchy and truth, not screenshot identity with proprietary Codex Desktop.

## Bounded authenticated Codex runtime

A disposable real Codex Thread and one real Turn exercised the runtime path:

- source Thread: `01a026d1-75ec-7c50-9a87-bfb46b74f1ba`;
- active Turn: `01a026d1-c9ab-7e60-a8c0-a81368f898b9`;
- while that Turn was active, the Composer labelled submission as Steer and Stop
  was visible; submission kept the same `currentTurnId`, cleared the input and
  did not create a second Turn surface;
- Stop produced one authoritative interrupted boundary while retaining partial
  Agent history, then returned to idle Send with Stop hidden and no current Turn;
- after the terminal-state control resync fix, Fork became enabled without
  reload and created Thread `01a026d3-c763-7571-a8a8-96c632586963`;
- the created Thread opened with exact header lineage
  `Fork of 01a026d1-75ec-7c50-9a87-bfb46b74f1ba` and preserved the interrupted
  source history.

The deterministic browser guard captures that the running submit dispatches
`turn/steer` with the exact expected Turn id and never dispatches `turn/start`.
The separate real-runtime observation proves that the active Turn identity stayed
the same and no second Turn appeared. This is deliberately stated as two
complementary observations because the first bounded live run predated the
redacted client-action diagnostic added at `fac258a`; no message text or secret
was logged.

Both disposable Threads were recoverably archived through pinned
`thread/archive`. A fresh `thread/list` bootstrap reported
`sourcePresent: false` and `forkPresent: false`; archived `thread/read` retained
the single interrupted Turn and partial Agent message. Nothing was deleted.

## Verification

- `npm test`: 187 tests, 185 passed, 0 failed, 2 intentional environment skips;
- `npm run probe:codex`: PASS against Codex `0.147.0`, protocol SHA-256
  `f3dec1e031d99a420b137b903f02196d4325eece57620c925bb7130b25f168d2`,
  including pinned `thread/fork`, `thread/archive`, `turn/steer` and required
  notifications/requests;
- the renderer suite covers compound identity, authoritative replacement,
  interruption, unknown items, escape-first Markdown, media/citation fallbacks,
  aggregate DOM bounds and bounded live reducer state.

## Production shell conformance closure

This section records the run that upgraded `selection-during-stream`,
`quote-add-to-chat`, `markdown-rich-content`, `request-user-input`,
`composer-inputs` and `current-thread-url-recovery` to pass in the production
shell (`apps/codex-first-shell/`) at application commit `30dc40f`.

- `npm test`: 216 tests, 213 passed, 0 failed, 3 intentional environment skips
  (206 / 203 / 0 / 3 before the closure).
- The opt-in guard ran through the production host
  (`scripts/vh-codex-first-shell.mjs`) in a fresh headless Chrome driven over
  the DevTools protocol with a visible document state, so
  `requestAnimationFrame` and `selectionchange` behave as in a foreground tab:
  - `?chatFixture=mixed&interactionGuard=1` at 1280x800:
    `PASS browser interaction guard · 35/35`, zero console errors or uncaught
    exceptions, `clientWidth = scrollWidth = 1280`, stable across five runs;
  - `…&reviewFrame=narrow` inside a 1280x800 window: `PASS 36/36`;
  - `…&reviewFrame=narrow` at a 390x844 viewport: `PASS 36/36`,
    `clientWidth = scrollWidth = 390`.
  - The sidebar checks branch on layout: the narrow frame exercises the
    drawer's inert, focus-entry and focus-return lifecycle; the wide layout
    verifies the persistent, never-inert sidebar and its collapse toggle.
- The app-server behind the host was the pinned-protocol fixture
  (`test/fixtures/codex-app-server-fixture.mjs` with
  `CODEX_FIXTURE_VERSION=0.147.0`), because the locally installed Codex 0.144.1
  predates the pinned 0.147.0 baseline and its bootstrap fails truthfully on
  `threadSection/list`. The bounded authenticated runtime review above is not
  repeated and still stands at `fac258a`; this closure changes no adapter
  behavior.

The new real-DOM checks proved, through the actual controls: a request draft
(chosen Other option, its text and the secret answer) surviving a Tasks round
trip through the real navigation; a selection held across a streamed update,
with the selected entry keeping its node while the command output streamed,
then reconciling once the selection was released; Quote submitting a
`turn/start` input whose quoted block closes with the exact source Thread, Turn
and item line, and a replayed human message rendering that identity chip; the
Composer stopping at the 190px CSS ceiling with quote context removable; Fork
navigation rewriting `?thread=` to the opened Thread; a 300-item Thread
mounting 240 entries behind a visible "60 earlier items" disclosure; and no
model, mode or realtime control anywhere in the shell.

## Lifecycle restart recovery closure

This section records the run that turned `transport-gap-runtime-recovery`
from a host signal into a proven restart path (acceptance
`lifecycle-restart-recovery-is-proven` of
`ticket-implement-codex-first-vibehub-shell`).

- `npm test`: 235 tests, 232 passed, 0 failed, 3 intentional environment skips
  (225 / 222 / 0 / 3 before this closure).
- `npm run guard:codex` (`scripts/vh-codex-first-shell-guard.mjs`, a fresh
  headless Chrome over the DevTools protocol against the production host on
  the pinned-protocol fixture app-server with `CODEX_FIXTURE_STATE` and
  `CODEX_FIXTURE_PIDFILE`):
  - `?chatFixture=mixed&interactionGuard=1` at 1280x800:
    `PASS browser interaction guard · 57/57`, zero console errors,
    `clientWidth = scrollWidth = 1280`, stable across three runs;
  - `…&reviewFrame=narrow` inside a 1280x800 window: `PASS 58/58`;
  - `…&reviewFrame=narrow` at a 390x844 viewport: `PASS 58/58`,
    `clientWidth = scrollWidth = 390`;
  - the real-DOM lifecycle walk (`PASS runtime lifecycle walk · 6/6`): a
    Chat with a live Turn in the production UI, the app-server killed with
    SIGKILL under it, the composer dropping to idle with the
    "Runtime exited during this Turn" boundary, the approval cards voided
    and the presence dots off; the restart re-reading the same Thread with no
    live claim; a browser reload recovering the same `?thread=`; and a reload
    into `?task=` recovering the Task-linked Thread from the Codex Thread
    name alone.
- The three new guard checks (`runtime exit clears the running posture and
  marks the dead Turn`, `runtime halt raises a persistent stop that names the
  condition and disables adapter actions`, `restoring the runtime posture
  withdraws the stop`) feed host event windows through the same
  `applyEventWindow` path `pollEvents` takes.
- Host proofs (`test/codex-first-shell.test.mjs`): kill mid-Turn → `runtimeExit`,
  every pending request `requestResolved runtime_exited`, `runtimeRestarted`
  generation 2 with identical Thread identities and the Task link, the
  orphaned Turn replayed `inProgress` on a `notLoaded` Thread and never live,
  `503 runtime_restarting` inside the window; a launcher restart over the same
  persisted Codex state; and the halts for a lost identity, restart exhaustion,
  an unreadable `account/read`, and a `-32601` on a pinned request, each a
  single visible `409 runtime_halted` naming its `upstream-lock.json` stop
  condition.
- Still needing the real pinned binary (local Codex is 0.144.1, the lock pins
  0.147.0): `generated-protocol-hash-changed` and `audio-input-removed` stay
  `unverified` on the fixture because it cannot emit `generate-json-schema`;
  `npm run probe:codex` against 0.147.0 turns them into observed results at
  boot, and the exact status a real app-server reports for a Turn that was in
  progress when it died (the fixture keeps the persisted `inProgress`, the
  strictest case) is still to be read from that binary.

## 0.149.0 real-runtime run (2026-08-22)

This section records the run that moved the Codex pin from 0.147.0 to the
installed 0.149.0 by evidence (`ticket-repin-codex-baseline-to-0-149-0`) and
exercised the production shell, the browser guard and the lifecycle walk on
the real binary for the first time. Application commits `5d0af1b` (lock),
`89e1482` (fixture and live proofs) and the commit carrying this section
(guard driver); the binary is `codex-cli 0.149.0` from
`/opt/homebrew/bin/codex`, the npm launcher around the native app-server.

### Pin moved by evidence

- `npm run probe:codex` before the move: `ok: false` with exactly one failing
  check, `schema protocol-sha256` (the binary's generated v2 schema hashes to
  `9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9`, the
  lock pinned `f3dec1e0…`); every pinned request, server request,
  notification, capability item and audio Turn input was already present.
- Tag and commit read from `git ls-remote --tags https://github.com/openai/codex`:
  `rust-v0.149.0` is tag object `a4e15bf371341b067c8278d3b70b1a8c7b3d793e`,
  peeled commit `758ef40f50c1a458425c7cfbf1eb12cbc07af0b0`; the retired
  0.147.0 entries in the lock reproduce from the same listing.
- Corroboration: upstream's checked-in
  `codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json`
  hashes to the retired `f3dec1e0…` at `rust-v0.147.0` and to `9b3de71a…` at
  `rust-v0.149.0`, byte-identical to what the installed binary generates.
- `npm run probe:codex` after the move: `ok: true`, 52/52 checks proven.
- Seam diff between the two generated schemas, recorded in the lock under
  `codex.baselineDiff`: nothing removed or renamed (`removedOrRenamedSeams:
  []`, no definition removed); the ClientRequest method set (95) and the
  ServerRequest bytes are unchanged; `TurnStatus`, `ThreadStatus` and the
  `UserInput` variants (`text`, `image`, `localImage`, `audio`, `localAudio`,
  `skill`, `mention`) are identical. Additive only: five notifications
  (`autoApprovalReview/strictReviewRequired`, `project/changed`,
  `thread/project/updated`, `thread/queue/changed`, `thread/reverted`),
  a required nullable `Thread.projectId` owned by the app-server with no
  ClientRequest that assigns it, optional `ThreadSection.appearance`
  (color/icon) on the section object and its create/update params, optional
  `agentMessage.delivery` and `imageGeneration.failure` on ThreadItem, and a
  nullable params object on the unpinned `account/usage/read`. The
  `projects` capability now states that `Thread.section` stays the sole
  membership authority and `projectId` is observed, never read as membership;
  the event census classifies the new notifications as unpinned and ignored
  (`applyChatEvent` returns false for them and `thread/read` replay stays
  authoritative). No capability became unavailable.

### Live proofs on the real app-server

All three checked-in live probes pass on 0.149.0 against an authenticated
ChatGPT Pro account (no credential was entered or persisted):

- `npm run probe:codex:live`: streamed ephemeral Turn
  `01a02bf8-2537-7f13-a539-ed3bf226fc73` completed with the sentinel; the
  stable Thread `01a02bf7-a580-73d1-a53d-a81d5bb37527` was listed again after
  an app-server restart; the exact synthetic handoff Turn
  `01a02bf8-399b-7b03-8047-b7d0af110252` started and was interrupted
  (payload SHA-256 `a6c0c521…`); `thread/realtime/start` still answers that
  the ephemeral Thread does not support realtime conversation, the same
  class the lock records as
  `protocol-present-current-ephemeral-thread-unsupported`.
- `npm run probe:codex:projects`: ThreadSection
  `01a02bf8-756c-75d2-8799-592e3bd0a542` created; Thread
  `01a02bf8-7823-…` moved in, forked (`01a02bf8-8c9d-…` with
  `forkedFromId` and inherited section), moved out, found by native title
  search, archived, listed as archived, recovered with its fork membership
  after a restart, restored without membership change; deleting the section
  returned the fork to Recents.
- `node packages/codex-adapter/probe-task-context-live.mjs`: the Task Context
  packet (SHA-256 `25adb517…`) entered Thread `01a02bf8-ba72-…`, was
  interrupted, survived a restart by Thread name, was resumed before reuse
  and replayed as `interrupted`.

### Status of a Turn that was in progress when the process died

The new `packages/codex-adapter/probe-interrupted-turn-live.mjs` reads the
one status the fixture had only assumed. A persistent read-only Thread ran
`sleep 90` through the shell; once the `commandExecution` item had started
(`thread/read` showed the Thread `active` and the Turn `inProgress`), the
app-server was SIGKILLed; a second process then listed the folder and read the
Thread before and after `thread/resume`. Observed three times (twice killing
the npm launcher, whose native child exits on its own within about 250 ms,
once killing the native app-server directly, after which the launcher exits
with the same signal and the process tree is gone within 10 ms):

- the Thread is listed in its folder with status `notLoaded`;
- `thread/read` reports the orphaned Turn as **`interrupted`**, before and
  after `thread/resume` (after which the Thread is `idle`);
- the items persisted for that Turn are the `userMessage` and the
  `agentMessage` that preceded the command; the in-flight
  `commandExecution` item is not persisted.

The fixture previously kept the persisted `inProgress` as the strictest case.
It now repairs a persisted `inProgress` Turn to `interrupted` on reload, the
restart proofs in `test/codex-first-shell.test.mjs` expect that, and the
shell's own rule (an authoritative terminal Turn hides the transient
"Runtime exited during this Turn" boundary and replay shows "Turn
interrupted") is therefore what a real user sees.

### Production shell on the installed binary

`node scripts/vh-codex-first-shell.mjs --repo <disposable bound repository>
--json` on the real `codex`:

- `runtime.version 0.149.0`, `baselineVersion 0.149.0`, `baselineMatch
  true`, `state alive`, `halt null`, `project.scope bound`, account
  authenticated (`chatgpt`, `pro`).
- Stop conditions at boot: `generated-protocol-hash-changed` pass (the shell
  re-hashed `generate-json-schema` to the pinned `9b3de71a…`),
  `required-request-or-event-missing` pass, `managed-auth-status-unavailable`
  pass, `audio-input-removed` pass, `thread-restart-recovery-unavailable`
  unverified (proven only by an observed restart),
  `approval-cannot-round-trip-without-hidden-state` structural,
  `same-user-action-routes-through-two-agent-loops` structural,
  `dsh-profile-cannot-own-one-idempotent-app-server-process` not-applicable.
  None violated.
- After SIGKILLing the native app-server under the shell during a live Turn:
  host events `runtimeExit` (SIGKILL, generation 1) then `runtimeRestarted`
  (generation 2, 0.149.0, attempt 1) with every known Thread identity and
  Task link resolved from Codex again; the post-restart conditions are five
  pass (now including `thread-restart-recovery-unavailable`), two structural,
  one not-applicable, none violated; the dead Turn replays `interrupted` on
  a `notLoaded` Thread through the host action.
- The real-runtime test in `test/codex-first-shell.test.mjs` now asserts
  `baselineMatch`, `state alive` and the passing protocol-hash condition when
  the installed binary is the pinned one, and a visible
  `generated-protocol-hash-changed` halt when it is newer; the former
  version skip is gone. `npm test` and `npm run verify`: 248 tests, 246
  passed, 0 failed, 2 environment skips (the exact DSH rc.8 source checkout
  is not available locally).

### Browser guard and lifecycle walk on the real runtime

`scripts/vh-codex-first-shell-guard.mjs` gained `--runtime real --repo
<path>` (and `--frames none`, `--codex <command>`): it boots the production
shell on the installed binary against an explicitly named repository, finds
the app-server as the shell's deepest descendant through the npm launcher,
and prints the envelope's version, `baselineMatch`, state and every stop
condition before the walk. The repository must be named on purpose because
the walk hands that repository's first open Ticket to the model.

- Guard frames against a real-runtime shell on this checkout (bound, with
  Rooms and Tickets that match the typed search), through `--url` with the
  lifecycle skipped: `PASS browser interaction guard · 65/65` wide in Light
  and Dark, `66/66` narrow-window and narrow-viewport in Light and Dark,
  `clientWidth = scrollWidth` in every frame, zero console errors, every
  reduced-motion audit passed. The frames' only live host action is the
  read-only `readTask`.
- Lifecycle walk (`--runtime real --repo <disposable bound repository>
  --frames none`): `PASS runtime lifecycle walk · 6/6`. A Chat asked to run
  `sleep 120` reached the running posture with Steer, Stop and "Working…";
  the native app-server was SIGKILLed under it; the composer dropped to idle
  with the "Runtime exited during this Turn" boundary and no live claim; the
  restart re-read the same Thread (`01a02c0a-0abc-7b43-9302-2b32df15f35b`)
  with the authoritative "Turn interrupted" boundary replacing the exit
  boundary and no live Turn minted; a browser reload recovered the same
  `?thread=`; `?task=ticket-repin-proof-walk` recovered the Task-linked
  Thread `01a02c09-ff06-7870-8e4c-7084df7c3599` from the Codex Thread name
  alone; no console errors.
- The default fixture run (`npm run guard:codex`) still passes with the
  driver changes: 65/65 and 66/66 in every frame and scheme, lifecycle 6/6.

Three differences between the fixture and the real runtime surfaced and were
handled without changing shell behavior:

- The Fork check waited 30 frames for the Thread re-read that follows
  `refreshThreads()`; the real `/api/bootstrap` takes 1.4 to 1.9 seconds
  (`thread/list` scans rollouts), so the guard's wait is now 900 frames.
  Fork itself dispatched the exact source Thread and opened the lineage.
- The typed-search check expects `Tasks (VibeHub)` and `Context (Rooms)`
  groups on a bound Project; groups without results carry no label, so the
  check depends on repository content. The real-runtime frames therefore ran
  against this checkout, the lifecycle walk against the disposable repository.
- The real app-server lists a new Thread only once its first user message is
  durable (it is absent right after `thread/start`, listed `active` once the
  `userMessage` item completes). The shell refreshes its sidebar at
  `newThread`, before that point, so a brand-new Chat's first Turn shows no
  sidebar entry or presence dot on the real runtime (the fixture lists
  Threads immediately). No false live claim is made; the walk records the dot
  count in real mode and asserts it only on the fixture. Refreshing the list
  when `turn/started` arrives for an unlisted Thread is follow-up shell work,
  outside this repin.

## Remaining non-highest gaps

All highest-severity findings from the three independent audits are corrected
and the five partial checks plus current-Thread URL recovery now pass. The
following remain explicit medium or low production work:

- full CommonMark breadth (tables, setext headings, indented code fall back to
  literal text) and a production virtualized conversation list behind the
  disclosed 240-item bound;
- model/mode pickers, realtime voice when the runtime exposes it, final visual
  system work and theme-preference persistence.

Ordinary Chat still creates no VibeHub Task, Evidence or Outcome. No proprietary
Codex Desktop implementation, assets, icons or private API were copied.
