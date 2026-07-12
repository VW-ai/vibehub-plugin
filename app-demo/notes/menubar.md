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

### Open questions for S3-S5

1. Types/fixtures: counts + top items should be a pure rollup over the existing
   `MapFixture` task states — reuse, don't mint a menubar fixture shape.
2. Dynamize as a separate demo route (`?screen=menubar` or route): the dropdown
   open/close (click item, Escape, outside click), badge ↔ fixture waiting
   count, stale derivation from `lastFetchAt`.
3. Interaction tests: open/close paths + focus return to the item; row click →
   (demo) main-window intent; variant-driven badge presence/cap.
4. Ordering rule inside "Needs you" when waiting and conflict ages interleave —
   oldest-first across kinds is chosen here; encode it in the rollup.
