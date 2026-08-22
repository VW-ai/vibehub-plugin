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

## Remaining non-highest gaps

All highest-severity findings from the three independent audits are corrected.
The following remain explicit medium or low production work:

- mature CommonMark breadth and a production virtualized conversation list;
- durable Quote-source serialization and a product policy/test for selection
  held longer than the bounded streaming deferral;
- request-user-input draft persistence across intentional route changes;
- convergence of the small CSS/JavaScript Composer-height constant mismatch;
- current-Thread URL recovery after in-app Fork navigation (today a stale
  `?thread=` review link reloads the source Thread);
- model/mode pickers, realtime voice when the runtime exposes it, final visual
  system work and theme-preference persistence.

Ordinary Chat still creates no VibeHub Task, Evidence or Outcome. No proprietary
Codex Desktop implementation, assets, icons or private API were copied.
