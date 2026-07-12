# menubar — screen notes

## S1+S2 merged (iter-19, per the kernel small-surface amendment)

File: `static/menubar-s1.html` (self-contained, v8 tokens verbatim, no network).
Five dev variants (`?v=` or dev bar, `?dev=0` hides dev chrome):
`busy` (default, v8-baseline data) / `quiet` / `stale` / `overload` (×12) /
`flood` (99+ badge cap).

### Context scaffolding (not product UI)

A generic desktop: wallpaper = layered muted gradients (no image), menubar strip
25px with system-ish stand-ins (leaf-shape OS glyph, "Shell" + File/Edit/View/
Window/Help, battery/wifi/sliders shapes, clock). No trademarks anywhere; every
stand-in is hover-explainable ("decorative stand-in in this demo").

### The Vibehub menubar item

- Glyph: 3 rounded territory blocks (the map's identity at 15px).
- Waiting badge top-right: mono count on `--need`, white keyline against the
  strip. THE one persistent animation on this screen (breathe 2.8s, v8 curve).
  Absent when nothing waits (quiet). Gray (`--ink-400`) and static when repo
  data is stale — a stale count must not claim live urgency.
- Item shows the macOS "menu open" darkened state; its tooltip re-states what
  the badge knows per variant (exact counts when the badge caps).

### Dropdown (340px, anchored under the item, right-aligned macOS-style)

1. **Repo line** — repo glyph + `VW-ai/Vibehub` + freshness (`● Synced 42s ago`,
   v8 titlebar language). Stale variant: gray dot + `Synced 47m ago`.
2. **Stale honesty line** (stale only, per decision-github-002): "Showing last
   known repo state — sessions still report via hooks. Open Vibehub to sync."
   Tooltip separates the two channels honestly: hook events arrive live even
   with the app closed; branch/teammate/PR data needs a foreground git fetch.
3. **Counts** — the v8 titlebar stat pills verbatim (`1 waiting · 1 conflict ·
   3 running`). Zero counts hidden, not rendered (iter-14 precedent). Pills are
   buttons; each tooltip says what clicking opens.
4. **All-quiet line** (quiet only): check glyph + "All quiet — 3 running,
   nothing needs you." — no fake urgency, no empty Needs-you header.
5. **Needs you** — v8 group-header language + mono total; then max 3 one-line
   items (pill + ellipsized title + mono age), oldest first. The conflict pair
   is ONE row labeled by its contested subject ("Order state machine — 2
   writing", v8's own `.sub.clash` copy); both task titles live in the tooltip
   (fork logged; follows iter-2 "a conflict demands attention exactly once").
   Overflow: quiet text line "and 9 more waiting…" / "and 142 more…" (exact
   remainder, opens the full list — tooltip says so).
6. **Footer** — "Open Vibehub" compact solid ink-900 (the dropdown's primary,
   quiet at 28px) + "Start a task" ring secondary.

Everything in the dropdown is a button or hover-explainable; all rows/pills
carry the "opens the main window at …" demo tooltips.

### Verification (headless chromium, per round)

5 variants × 1280×800 + busy @2x (retina check): zero console errors, zero page
errors. Probes: dropdown fully in viewport and horizontally anchored under the
item (item center within dropdown x-range — anchored by JS, resize-safe); no
horizontal page overflow; visible `[data-show]` nodes match variant exactly;
overflowing titles have ellipsis; badge count = 1 visible except quiet = 0;
every text leaf inside the dropdown sits under a `[data-tip]` ancestor.
Shots: `notes/shots/menubar-s1-{busy,quiet,stale,overload,flood}-1280x800.png`
(+`-r1`/`-r2` review rounds, `@2x` retina, `clip-*` 2x detail crops).

### Self-review defect log (S2 discipline)

**Round 1 — 2 defects** (+1 caught by probe pre-shot):

0. (probe) Dropdown hardcoded `right:150px` missed the item at 1280 — anchored
   to `#vh` via JS (`innerWidth - rect.right - 2`), recomputed on resize.
1. **Stat pills rendered with default `<button>` borders** — v8's `.stat` was
   authored as a div; making pills clickable buttons picked up the UA border →
   heavy dark outlines off the token ramp. → `border:0` in `.stat`.
2. **Conflict row copy truncated its informative tail** — "Order state machine
   — 2 tasks writing" clipped to "2 tasks…" at 340px. v8's own conflict count
   copy is "2 writing" → shortened; fits untruncated in busy/stale, and in
   flood (wider mono age "1h12m") the ellipsis lands after "2 wri…" with the
   full pair in the tooltip.

**Round 2 — 0 new defects.** Converged (2 → 0). Fix verification across all 5
clips + @2x: pill fills clean on ramp, conflict row full text, stale gray
dot/badge/note, overload top-3 + remainder line, 99+ badge cap, footer seam.

### Scale-extremes protocol (S1-scope answers; full closure at S3-S5)

- **N=0 (nothing needs you)**: `quiet` variant — no badge, no Needs-you header,
  one honest line + counts that exist. Nothing fake, no empty section chrome.
- **N=1 (sparse)**: busy is near-minimal (2 items); the dropdown shrinks to
  content height — no filler, the fixed 340px width is earned by the repo line.
- **N=many**: `overload` (12 waiting → top-3 + "and 9 more waiting…") and
  `flood` (145 needing you → top-3 + "and 142 more…"). Strategy = collapse to
  +N; list never scrolls (a menubar dropdown must stay glanceable — the full
  list is the main window's job).
- **TEXT long**: item titles ellipsize (one line, tooltip has the full title +
  the question being asked); repo name ellipsizes; overflow copy is text-first.
- **NUMBER huge**: badge caps at 99+ (fork logged) with exact count in the item
  tooltip; pills show exact counts (app-wide ≥1000 abbreviation rule would kick
  in beyond — 143 renders plain per the iter-14 threshold decision).
- **SPACE tiny**: the menubar item itself is the tiny rung — glyph + badge
  only (icon+count, the degradation ladder's third rung, chosen deliberately:
  the strip owns ~21px). The dropdown is the recovery surface.
- **DYNAMIC**: variants via dev bar/?v= at this stage; hidden info (full
  titles, exact counts, pair identities) reachable via tooltips; dropdown
  space handling is static HTML here — open/close is S3-S5.
- **SCREEN sizes**: dropdown (340×~250 max) trivially fits 1280×800; anchor is
  resize-recomputed. @2x retina checked (hairlines, badge keyline clean).

## S3+S4+S5 merged (iter-20, per the kernel small-surface amendment)

### S3 — the rollup (no menubar fixture shape exists)

Open question 1 answered as posed: `src/menubar-types.ts` + `src/menubar-derive.ts`
are a PURE ROLLUP over `MapFixture` — `deriveMenubar(fx): MenubarSummary`. The
menubar can never disagree with the map because there is nothing to keep in
sync: counts (zeros hidden, iter-14), badge (waiting only, 99+ cap, stale =
gray/static), freshness + stale honesty line (from `sync.lastFetchAt`/`stale`),
the Needs-you list, quiet line, item tooltip, and even the desk clock
(`deskClock(capturedAt)`) all derive from the one fixture. No new captured
fields; `relAge`/`clockTime` reused from derive.ts.

**Ordering (open question 4, encoded):** waiting tasks and conflict PAIRS
interleave into one list, OLDEST FIRST. Age basis: waiting = `stateSince`;
conflict = `detectedAt` — when the pair started needing adjudication, NOT the
older writer's runtime (fork logged iter-20; the S1 static hand-wrote "31m"
which was the writer's age — under detectedAt the same row reads "8m" and the
busy row order survives). Conflict = ONE row `"<subject> — 2 writing"`
(sub-block name, territory-name fallback), both titles in the tooltip.
Overflow: `and N more waiting…` when everything hidden is waiting, generic
`and N more…` when a conflict is among the hidden (flood).

Unit tests: `src/menubar-derive.test.ts`, vitest **16/16** (suite 27/27) —
busy=v8Baseline counts/rows/ages, oldest-first interleave with a conflict
older than a waiting task, conflict-only state (no badge, never quiet, clash
stat + adjudication item tip), subject fallback, quiet + true-N=0 quiet,
stale badge/note/never-fetched, overload top-3 + "9 more waiting", flood
99+/exact-143/145-total/generic-more/one-unit ages, cap boundary 99 vs 100,
registry id-uniqueness + shared capturedAt, deskClock timezone-free.

### S4 — dynamized (`?menubar=` route)

`src/components/MenubarScreen.tsx` — a separate render path like
InstallScreen (App.tsx early-return above the install layer; main.tsx parses
`?menubar=`). `?menubar=busy|quiet|stale|overload|flood` (or bare `?menubar=1`
→ busy); unknown names fall through to the map (tested). `busy` IS v8Baseline;
quiet/stale/overload/flood are plain MapFixtures in
`src/fixtures/menubar-extremes.ts` (registry `menubarFixtures`) — stale is
v8Baseline with a 47m-old fetch, overload/flood carry the S1 head items
verbatim as data plus deterministic index-generated filler (143 waiting /
2 conflicts / 31 running for flood). Dev switcher = the shared
`.fixture-switch` select (`?switcher=0` hides it).

CSS ported into app.css under `.mbdesk` (static's `.div/.foot/.spacer`
renamed `.mb-div/.mb-foot/.mb-spacer` to dodge app collisions; `.stat`,
`.pill`, `.fresh` reused ON PURPOSE — same v8 vocabulary; `.drop .stat`
gets the static's `border:0` button fix). Badge reuses the map's `breathe`
keyframes (identical .82→1 / 2.8s). Anchor = layout-effect + resize listener
(`innerWidth - rect.right - 2`, min 8), same math as the static's JS.

**Parity (busy/quiet/stale × 1280×800, `menubar-s4-*` vs `menubar-s1-*`):**
pixel-equivalent — same strip, item, badge, dropdown geometry, pills, rows,
footer. Deliberate data-rule deltas, each ASSERTED in
tests/menubar-parity.spec.ts:
1. busy/stale conflict row age **"8m"** (detectedAt basis) vs static "31m";
2. flood ages **"2h"/"1h"** per derive.ts's one-unit rule vs static's
   hand-written compound "1h44m"/"1h12m";
3. flood **"2 conflicts"** pluralized (static's "2 conflict" treated as a
   typo — v8 titlebar language pluralizes);
4. clock **"Sun Jul 12  10:22"** derived from capturedAt (consistent with
   every age in the dropdown) vs the static's decorative "Fri Jul 11 09:41";
5. tooltips composed from data (iter-17 precedent) — same intent, mechanical
   phrasing.

### S5 — interactions

tests/menubar-interactions.spec.ts (**14**) + menubar-parity.spec.ts (**20**):
- item click closes/reopens (aria-expanded + .open tracked); dropdown starts
  OPEN on the demo route (the dropdown is the subject; real app starts
  closed — fork);
- Escape + outside-click (desktop) close WITH focus return to the item
  (rAF, keyboard-parity principle); clicks inside non-buttons don't close;
- selection semantics: rows / stat pills / overflow line / both footer
  buttons close the menu like a real menubar selection, focus back on the
  item — the "opens the main window at …" intent lives in each tooltip
  (demo has no main window; fork);
- badge matrix: busy "1" breathing (computed animationName = breathe) /
  quiet absent / stale gray + animationName none / overload "12" / flood
  "99+" with exact 143 in badge + item tips;
- needs-you rows carry click-intent tooltips on all 4 row-bearing variants;
  conflict row tooltip names BOTH tasks;
- tooltip 260ms intent delay (nothing at 80ms, on at ~400ms, real content,
  instant hide); every dropdown text leaf under a [data-tip] ancestor ×5
  variants;
- keyboard: Tab from the item walks stats → rows → more → footer in DOM
  order; Enter on a row selects (closes + focus return); Escape-close then
  Enter-reopen re-anchors under the item;
- geometry @1280×800 + 1440×900: item center inside the dropdown's x-range,
  dropdown fully in viewport, zero page overflow both axes.

### Scale-extremes closure (S3-S5 scope — S1 answers above still hold)

- **N=0**: quiet fixture (badge absent, alive-only stat, honest line) AND the
  true zero (no sessions at all) → "All quiet — nothing running, nothing
  needs you.", zero stat pills (unit-tested).
- **N=1/small**: busy (2 rows) — dropdown shrinks to content, tested.
- **N=many**: overload/flood as DATA now (12/145 needs-you) → top-3 + exact
  remainder line; list never scrolls (unit + e2e).
- **TEXT long**: 64-char overload title probed `scrollWidth > clientWidth`
  (real ellipsis) with the full story in the tooltip.
- **NUMBER huge**: 99+ badge cap with exact counts in tips (boundary
  unit-tested 99/100); pills render exact counts (143 < the app-wide ≥1000
  abbreviation threshold).
- **SPACE tiny**: the item = icon+count rung; recovery surface = dropdown
  (unchanged from S1; now reachable by click).
- **DYNAMIC**: open/close/Escape/outside/selection all yield space back and
  return focus; hidden info (full titles, exact counts, pair identities)
  reachable via tooltips; variants via fixtures through one rollup.
- **SCREENS**: 1280×800 + 1440×900 anchored/in-viewport/no-overflow tested.

### Gates (iter-20)

tsc --noEmit clean · pnpm build green · Playwright FULL **156/156**
(122 existing untouched + 34 new) · vitest **27/27** (11 + 16 new).

### Open questions for S3-S5 (S1-era — all answered above)

1. Types/fixtures: counts + top items should be a pure rollup over the existing
   `MapFixture` task states — reuse, don't mint a menubar fixture shape.
2. Dynamize as a separate demo route (`?screen=menubar` or route): the dropdown
   open/close (click item, Escape, outside click), badge ↔ fixture waiting
   count, stale derivation from `lastFetchAt`.
3. Interaction tests: open/close paths + focus return to the item; row click →
   (demo) main-window intent; variant-driven badge presence/cap.
4. Ordering rule inside "Needs you" when waiting and conflict ages interleave —
   oldest-first across kinds is chosen here; encode it in the rollup.
