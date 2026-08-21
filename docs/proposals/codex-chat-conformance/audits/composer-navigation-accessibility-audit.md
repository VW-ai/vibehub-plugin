# Independent audit: Composer, navigation and accessibility

## Audit identity and verdict

- Reviewer: `/root/audit_chat_composer_accessibility` (independent specialized
  subagent)
- Audited commit: `5a00cb77e1c708e38895571a29bd209e3f684540`
- Scope: Composer text growth, attachments and ordinary audio; selection, Quote
  and Add to chat; model/mode posture; Send, Stop, Escape, retry and fork;
  Search, Sidebar and Thread navigation; streaming/reconciliation focus;
  request-user-input and approval focus; disclosures, labels, live regions,
  Light/Dark, wide and 390x844 narrow layouts, reduced motion, overflow and
  browser-state/DOM bounds
- Verdict: **FAIL — correction and a repeat browser audit are required before
  Composer/navigation/accessibility conformance can be recorded**

There is a real usable core. The textarea grows and scrolls at its cap,
`Shift+Enter` preserves a newline, whole-response Quote preserves exact
Thread/Turn/item identity, ordinary audio is truthfully separate from unsupported
realtime conversation, the fixed Agent/Codex labels do not impersonate pickers,
the transcript has a bounded mounted tail, real interruption preserves its partial
history, and neither the 1280x720 nor the 390x844 exercise produced page-level
horizontal overflow. Search and Inbox also return focus when dismissed directly.

Those positives do not make the current carrier safe for daily Chat. While a real
Turn runs, both Send and Stop remain enabled; Composer drafts and quoted source
context cross into another Thread; the narrow Sidebar cannot be dismissed by its
visible control; the reducer's in-memory streaming state is unbounded even though
rendered HTML is truncated; and the current Thread action has no implementation or
fork path. Keyboard focus also falls to `BODY` after ordinary Thread and Search
navigation. These are observable interaction defects, not token or screenshot
differences.

## Sources and review method

The binding local baseline was:

- [`chat-ui-contract.json`](../../codex-native-chat/chat-ui-contract.json), the
  accepted native-Chat contract and its Composer/keyboard/security bounds;
- [`conformance-matrix.json`](../conformance-matrix.json), both Chat fixtures,
  `app.js`, `app.css`, `index.html`, the reducer/renderer/request registry, the
  loopback host and the exact current tests;
- [`upstream-lock.json`](../../../../packages/codex-adapter/upstream-lock.json),
  pinning `@openai/codex` `0.147.0`, commit
  `be6e8eac029b183056b7e4402879f15d2c85f61b`, and v2 schema SHA-256
  `f3dec1e031d99a420b137b903f02196d4325eece57620c925bb7130b25f168d2`;
  and
- the accepted research inventory, used as a baseline rather than recreated.

A fresh `codex app-server generate-json-schema` matched the pinned SHA-256. Its
`ToolRequestUserInputParams` requires exact Thread, Turn, item, questions and
`isBlocking` identity and defines `isSecret`, `isOther`, nullable options and exact
answer-id mapping. No proprietary Codex Desktop code, private API, asset or icon was
inspected or copied.

Accessibility judgments also use the W3C [modal dialog
pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [editable
combobox/listbox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) and
[WCAG focus-order guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html).
In particular, a surface marked `aria-modal="true"` must actually contain the tab
sequence and make the rest of the application inert, and a text input that keeps
DOM focus while arrows change a listbox option needs the corresponding composite
focus relationship.

## Conformance results

| Area | Result | Severity | Exact finding |
| --- | --- | --- | --- |
| Textarea and keyboard editing | **Pass with minor mismatch** | Low | Real browser exercise grew a 12-line Composer to its CSS cap, preserved scrolling, and `Shift+Enter` appended a newline. JS requests a 220px height while CSS caps at 190px; the result is usable but has two competing constants. |
| Send and Stop while running | **Fail** | Highest | A real Turn showed Stop **and** Send simultaneously with Send enabled and the input enabled. Normal Chat submission always calls `startTurn`; unlike Task mode it neither steers nor blocks a second submission. |
| Quote and Thread-scoped draft | **Fail** | Highest | Quote carries exact source identity in the active browser session, but `newThread()` and `openThread()` do not clear or key textarea, attachments or `composerQuote`. A quote from fixture Thread A remained mounted and sendable after `Meta+N` created real Thread B. Source identity is also discarded when the message is serialized as Markdown. |
| Selection during streaming | **Partial** | Medium | Keyed entry patching is materially better and retains unchanged nodes/disclosures. An active selection merely delays repaint for at most 1.2s; a changed selected entry can still be replaced afterward. There is no executable selection or keyboard Add-to-chat test. |
| Attachments and ordinary audio | **Partial** | Medium | Image/audio attachment and MediaRecorder paths are truthful, limited to three submitted items and removable. File data is fully read before host validation; recording has no duration/size bound or live-region announcement, so long recordings can consume unbounded browser memory before the 12MiB host rejects them. |
| Model, mode and realtime posture | **Pass** | Low | Fixed `Agent` and `Codex` are non-interactive labels, and realtime voice remains absent while the probe says unsupported. No false picker or realtime capability is exposed. |
| Retry and interruption | **Partial** | Highest | A real Stop produced one authoritative `Turn interrupted` boundary with partial history. Retry restores prior text and says the next send is a new Turn. The running Composer defect still permits a conflicting new `turn/start`, and the exact Escape/Stop path has no browser regression. |
| Fork and Thread actions | **Fail** | Highest | `forkedFromId` is projected by the host, but the current Chat UI has no fork/branch action. The visible `Thread actions` button has no handler at all. A structural button is not behavior parity. |
| Narrow Sidebar | **Fail** | Highest | At 390x844, the closed Sidebar is moved offscreen by `transform` but remains interactive/focusable. Opening adds `sidebar-open`; the visible `Collapse sidebar` button only toggles `sidebar-collapsed`, leaving `sidebar-open` and transform 0. There is no Escape, outside-click or Sidebar scrim dismissal. |
| Search navigation | **Partial** | Medium | Filtering and Arrow/Enter selection work and direct Escape returns focus to the Search trigger. Search-to-Task left focus on `BODY`. The searchbox has neither `aria-controls` nor `aria-activedescendant` while JavaScript moves visual `aria-selected`, and modal background content is not inert or focus-trapped. |
| Sidebar and Thread navigation | **Fail** | Medium | Clicking the real Recent Thread opened it successfully but focus fell to `BODY`. `updateSidebar()` replaces every Thread button with `innerHTML`, including periodic refreshes, so Sidebar focus can also disappear during background reconciliation. |
| Inbox and Review overlays | **Partial** | Medium | Inbox moved focus to Close and returned it to the bell. Inbox and Review are visually modal side panels but have no `dialog` role or modal semantics, no focus containment and no inert background. Search declares itself modal without implementing those modal guarantees. |
| Request-user-input | **Partial, unproved** | Highest | Source handles all questions, blocking/non-blocking posture, password freeform secrets, radio options and exact answer ids, and keyed unchanged entries can retain DOM values during unrelated streaming. There is no current mixed fixture or executable browser test. Drafts disappear on route changes, and `Other` nests both a radio and text input in one label; text can be entered without selecting Other, then submission rejects it. Newly blocking focus uses `preventScroll`, which can focus a request outside the sighted user's viewport. |
| Approval focus | **Partial** | Medium | Newly observed blocking requests receive focus and a bounded status announcement; resolution returns to Composer. Exact return posture is not retained across a route/reconcile boundary, and fixture approvals are disabled `alertdialog` regions with no focusable decision. |
| Disclosures and live regions | **Partial** | Medium | Native `details`, explicit disclosure identity and the dedicated `streamStatus` region are sound. Stream status is rewritten on every patched paint, recording status is not live, and neither form values nor disclosure/focus behavior is browser-tested under concurrent deltas. |
| Light and Dark | **Fail** | Medium | The shell switches to the correct Codex colors, but theme variables are scoped to `#appShell`; Search, Inbox, Review, toast and selection UI are sibling nodes. In real Dark mode the shell was `rgb(24,24,24)` while Search stayed white with light tokens. Theme choice is also not persisted. |
| Visual accessibility | **Partial** | Medium | Controls have a general visible focus ring and most state is textual. `--faint` small text is only about 3.11:1 on Light and 3.97:1 on Dark backgrounds, below 4.5:1 for the many 9px labels that carry meaningful status. |
| Responsive overflow | **Pass** | Highest | Browser measurement found zero body/surface overflow at 1280x720 and 390x844; the Composer stayed within 8..382px at narrow width. Local code/output scrolling remains contained. |
| Reduced motion | **Partial, structural only** | Medium | A correct `prefers-reduced-motion` rule zeros animation, transition and smooth-scroll duration. The current suite and audit carrier cannot emulate and assert the reduced-motion state, so this is not behavioral proof. |
| DOM and browser memory bounds | **Fail** | Highest | Mounted timeline, text and media are bounded, but `liveItems`, plan/diff/error Maps and all streamed delta strings/changes grow without the contract's stated `liveItemLimit=64`. Truncation occurs only during rendering, so a long Turn can still exhaust browser state before completion. |
| Executable interaction coverage | **Fail** | Highest | Current UI tests search source strings. The real-runtime test checks bootstrap/assets but performs no Turn, Composer, request, focus, theme, reduced-motion or narrow interaction. This allowed all of the browser-reproduced defects above to coexist with a green 182-pass suite. |

## Reproducible highest-severity findings

### 1. Running Chat does not have one authoritative primary action

In the real authenticated shell, a normal Chat Turn was started with a long text
response and inspected after 250ms:

```json
{
  "stopVisible": true,
  "sendVisible": true,
  "sendDisabled": false,
  "inputDisabled": false
}
```

`submitTurn()` always dispatches `{ action: "startTurn" }` in ordinary Chat. It
uses `steerTaskTurn` only in Task mode. The current CSS/HTML also never hides or
disables Send when Stop is exposed. Required correction is an explicit running
Composer state machine: one primary Stop action, a deliberate queued/steer policy,
and tests that a second Enter cannot issue an accidental `turn/start`.

### 2. Composer ownership is global instead of Thread-scoped

The fixture answer was quoted, then `Meta+N` created real Thread
`01a026b9-eef6-7523-9af5-62de2e9c075f`. The new Thread still showed the prior
quote with source:

```text
Thread fixture-chat-parity · Turn fixture-turn-1 · Item fixture-agent
```

The disposable audit Thread was interrupted and archived after the exercise. The
same deterministic state path applies to textarea value and attachments: neither
`newThread()` nor `openThread()` saves, restores or clears them. Required correction
is a draft store keyed by Thread (and an explicit new-Thread empty draft), including
text, attachments and quoted source identity. Cross-Thread Quote should be a
deliberate labeled operation, never an accidental carry-over.

### 3. The mobile Sidebar opens but does not close

At 390x844, activating `Open navigation` adds `sidebar-open`. Activating the
visible `Collapse sidebar` then produced:

```text
class = "app-shell sidebar-open sidebar-collapsed"
transform = matrix(1, 0, 0, 1, 0, 0)
```

The Sidebar remained onscreen. When closed, it is only translated to x=-306 and
its buttons remain in the document tab order. Required correction is one narrow
drawer state with correct Open/Close labels, Escape and outside dismissal, focus
entry/return, inert offscreen content and a scrim whose lifecycle matches the
drawer.

### 4. Mounted-output bounds do not bound streaming state

`canonicalTimeline(...).slice(-240)`, shared render budgets and escaped/truncated
output keep mounted HTML finite. The reducer still appends every agent,
reasoning, command, file and tool delta into unbounded strings/arrays and retains
every live item until authoritative Turn completion. No code enforces the accepted
`liveItemLimit: 64`. A noisy or long-running Turn can therefore use unbounded memory
without producing a large DOM. Bound reducer state or spill/reconcile against
authoritative Thread history; add >64-item and multi-megabyte delta tests that
measure state as well as markup.

### 5. Required Thread behavior is represented by a dead affordance

The accepted inventory includes fork and branch provenance. The host exposes
`forkedFromId`, but `app.js` contains no fork action, and `Thread actions` has no
listener. Required correction is an exact app-server fork path with source Thread
identity, focus on the created fork, and explicit error posture. If another Ticket
will supply this during branch integration, this exact commit must remain failing
until that implementation is actually present and re-audited.

### 6. Interaction claims have no executable browser guard

`test/codex-chat-conformance.test.mjs` executes reducer and renderer helpers but
asserts Composer/Quote/request/focus behavior by source regular expressions.
`test/codex-first-shell-prototype.test.mjs` boots the real runtime and checks HTTP
shape, not a real Turn. There is no request-user-input fixture at all. The green
suite therefore cannot fail if Send and Stop are simultaneous, a quote crosses
Threads, Search loses focus, Dark overlays stay light, or the narrow drawer traps
the user.

## Relevant maintained open-source comparison

Repository, license, maintenance, dependency and security facts were rechecked on
2026-08-21 from the projects' GitHub repositories. No source or asset was copied.

| Candidate | Relevant facts | Decision boundary |
| --- | --- | --- |
| [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) | MIT, actively maintained, with composable Thread, Composer, attachment, dictation, branch/action, keyboard and accessibility primitives plus a security policy. Its current Composer examples make Send and Cancel mutually exclusive and model attachment/dictation state explicitly. It brings React plus Base UI/Radix, state/runtime adapters, Markdown and optional cloud services. | Selectively adapt its Composer state machine, draft/attachment ownership, action-bar and focus primitives below the Codex adapter. Do not let its generic runtime, cloud storage or transcript model become app-server truth. |
| [yunhaoli24/codex-gateway](https://github.com/yunhaoli24/codex-gateway) | MIT, current app-server-specific project with real SSH/Codex Playwright E2E covering Thread restore, mobile layout, dynamic requests, notifications and sub-agents. It also owns auth, encrypted SQLite config, SSH credentials/channels, remote preview origins and a materially larger Nuxt gateway/security surface. | Reimplement its real-runtime navigation, mobile and request E2E cases. Do not adopt the SSH/SQLite/remote-host product or a second persistence authority. |
| [lezi-fun/codex-webui](https://github.com/lezi-fun/codex-webui) | MIT source with a security policy and unit/browser/integration/E2E suites for real app-server streaming, approvals, mobile and Composer behavior. Its Bun/WebSocket/PTY, filesystem, git-apply, marked/DOMPurify, KaTeX and xterm surfaces are much broader. The repository explicitly says extracted Codex-style visual assets are **not** covered by MIT. | Reference its real interaction test cases and local-security boundaries. Do not import its server/runtime or any Codex-derived visual asset. |

The convergence is unchanged: keep the pinned Codex adapter as authority, and use
maintained UI primitives or test ideas only below it. The current hand-written
prototype needs a real interaction test layer before more behavior is added.

## Focused verification

From the exact audited commit:

- `npm test` with local app-server/loopback permission passed **182**, failed
  **0**, skipped **2** (the two documented DSH source-availability skips).
- The focused Chat and shell run passed 21 checks inside the restricted sandbox
  and failed only the app-server spawn. Re-running the shell suite with authorized
  local runtime access passed **7/7**.
- Fresh generated schema SHA-256 was exactly
  `f3dec1e031d99a420b137b903f02196d4325eece57620c925bb7130b25f168d2`.
- Real browser/runtime exercises covered 1280x720 and 390x844, Light/Dark,
  textarea growth/newline, Quote, Search, Inbox, Thread navigation, a real
  `turn/start`, Stop/interruption, focus targets and overflow measurements.
- The exact browser observations included: Search-to-Task focus=`BODY`; real
  Thread-open focus=`BODY`; shell Dark background=`rgb(24,24,24)` while the open
  Search dialog remained `rgb(255,255,255)`; narrow body/surface overflow=`0`;
  and whole-response Quote source identity remained exact.

The full green test result is evidence of repository stability, not evidence that
the interaction matrix passes. The browser-reproduced failures are outside the
suite's assertion surface.

## Prioritized recommendation and matrix correction

1. **P0 — running Composer:** make Send/Stop mutually exclusive and define exact
   queue/steer semantics; prevent accidental second `turn/start`.
2. **P0 — Thread-owned drafts:** key text, quote identity and attachments by
   Thread; new Thread begins empty; test switching, forking and reconciliation.
3. **P0 — mobile navigation:** implement a dismissible inert drawer with correct
   focus entry/return, Escape, outside click and one Open/Close control.
4. **P0 — real bounds:** enforce live-item and delta memory limits, not merely DOM
   truncation; reconcile overflow from authoritative Thread history.
5. **P0 — Thread actions and tests:** implement fork or integrate the separately
   proved fork carrier, remove dead actions, add real app-server/browser tests for
   Turn, request-user-input, focus, Dark, reduced motion and narrow behavior.
6. **P1 — focus and overlays:** restore logical destination focus after Search and
   Thread navigation; use truthful modal/drawer semantics and composite Search
   accessibility.
7. **P1 — media/request polish:** bound recording and file reads, announce recording,
   make Other selection unambiguous, preserve request drafts across navigation and
   scroll blocking attention visibly into view.
8. **P1 — visual accessibility:** theme all overlay siblings, persist user theme,
   raise meaningful faint-text contrast and execute reduced-motion assertions.

Before canonical Evidence is recorded, change `composer-inputs`,
`composer-keyboard-stop`, `focus-and-overlays`, `wide-narrow-theme-motion` and the
performance/virtualization posture from pass/deferred to fail or partial as
specified above. Add explicit failing matrix rows for Thread-scoped drafts,
fork/actions, narrow Sidebar, theme-overlay composition and in-memory streaming
bounds. Keep model/mode and realtime voice as truthful deferrals, and keep
responsive overflow as a pass.
