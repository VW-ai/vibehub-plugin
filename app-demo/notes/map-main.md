# map-main — screen notes

S1/S2: done externally — frozen baseline is `workbench-refs/reference-screen-v8.html`.

## S3 checklist (this iteration)

- [x] Vite + React + TS scaffold in `workbench/app-demo/` (hand-written; standalone
      pnpm root via local `pnpm-workspace.yaml` so the monorepo lockfile is never touched)
- [x] `src/tokens.css` — v8 `:root` tokens extracted VERBATIM (no value changed)
- [x] `src/types.ts` — Task (five states, conflict as attribute), ScopeDeclaration
      (read/write per territory), Territory (id, name, anchored-file count, sub-blocks),
      TerritoryOccupancy rollups, Conflict (task pair + shared symbols + red/yellow
      grading per decision-project-020), SyncFreshness, RepoInfo, MapFixture root
- [x] Signal discipline: every field annotated with its source (hooks / git / gh /
      distillation / MCP scope registration); no confidence, no progress %, no ETA
- [x] Fixtures match v8 content exactly: 6 tasks, 6 territories, 1 conflict
      (OrderStateMachine double-write, 3 shared symbols)
- [x] Extreme fixtures present (see below)
- [x] Gates: `pnpm install` green (standalone), `tsc --noEmit` clean,
      fixtures type-check via `satisfies MapFixture`; bonus: `vite build` green

### S3 decisions of note

- Fixtures are TS modules (JSON-shaped literals + `satisfies MapFixture`), not .json
  files: raw JSON imports widen `"running"` to `string` and cannot satisfy the
  union types, which would defeat the S3 type-check gate. Logged in DECISIONS-NEEDED.
- `demoLayout` (percent rects) is explicitly a presentation-only hint carrying v8's
  hand-tuned geometry for S4 screenshot-parity — NOT a captured signal. v8's
  sub-block offsets are px; fixture stores approximate percents; S4 must reconcile
  against v8's actual px offsets when chasing parity.
- `signalTier: "basic"` tasks never carry `state: "waiting"` or `statusDetail`
  (weak tier can't infer them — decision-project-021 honesty constraint). The
  long-title extreme task doubles as the reduced-perception rendering case.
- `capturedAt` in every fixture pins "now" so relative ages ("12m", "42s ago")
  are deterministic in demos and tests.

## SCALE-EXTREMES coverage (fixture side; rendering answers due by S5)

| Protocol case | Fixture | What it exercises |
|---|---|---|
| N=0 (empty) | `extreme-empty-project` | no tasks, no territories, never fetched (`lastFetchAt: null`, `stale: true`) — honest first-run empty state |
| N=1 (sparse) | `extreme-empty-project` → `v8-baseline` low-density groups (1 done-today) | groups with a single card; quiet territory earning its space |
| N=many (chips) | `extreme-scope-overload` task with 9 scope declarations | rail card chip row must collapse to +N, single line |
| N=many (canvas) | `extreme-forty-territories` (40 territories, 8×5; all five task states present) | zoom/label degradation ladder; rail grouping at density |
| TEXT long | `extreme-scope-overload` long-title task; "Vendored Monolith Compatibility Shims" / "Internationalization & Locale Negotiation" territory names | truncation + hover-full-text on titles, labels, foots |
| NUMBER huge | `extreme-scope-overload` `x-core` with `anchoredFileCount: 100000` | abbreviate (100k) + exact tooltip |
| SPACE tiny | `extreme-forty-territories` 11.4%×17.8% rects with long names | degradation ladder full → abbrev → icon+count → dot |
| DYNAMIC | all fixtures (tooltips/correlate-hover data present in model: statusDetail, conflict evidence) | hidden info reachable by hover/click, space returned |
| SCREEN sizes | n/a at S3 (data layer) | verify at S4/S5: 1280×800 and 1440×900 |

## S4 checklist (done)

- [x] Ratified deps added: `@types/react` + `@types/react-dom` (devDeps,
      type-only). Nothing else; no @vitejs/plugin-react (esbuild JSX suffices).
- [x] Components: `App / Titlebar / TaskRail / TaskCard / MapCanvas /
      TerritoryBlock / Legend / Tooltip` under `src/components/`, all view
      models computed in `src/derive.ts` (pure functions over MapFixture).
      ZERO hardcoded content in JSX — only UI copy explaining state semantics
      (pill words, legend words, empty-state guidance) is literal.
- [x] Styling: `src/app.css` = v8 CSS carried over verbatim (tokens.css vars
      only); additions marked `S4:` (stale dot, fixture switcher, empty
      states, compact rung, reduced-motion). No runtime styling libs.
- [x] Behaviors preserved (Playwright smoke-verified):
      correlate-hover (dim .14 + 2px ring + scale 1.012 + label darken),
      legend filter syncing canvas AND rail, tooltip 260ms intent delay +
      flip positioning + instant hide, staggered entry animations,
      breathing conflict pill (exactly ONE persistent animation).
- [x] Dev fixture switcher: `?fixture=empty-project|scope-overload|
      forty-territories` + small mono `<select>` in the titlebar;
      `?switcher=0` hides it (used for parity shots).
- [x] Gates: `tsc --noEmit` clean · `pnpm build` green ·
      `npx playwright test` 6/6 (screenshot capture) · no dep beyond ratified.

### S4 derivation rules (fixture → pixels; these are now product rules)

- **Rail grouping**: "Needs you" = waiting tasks + `conflict.taskIds[0]`
  (a conflict demands attention exactly once; the pair's other side stays in
  its state group — matches v8's two CONFLICT cards). Then Running (running +
  stalled), Queued, Done today; empty groups hidden.
- **Pill**: conflictIds non-empty overrides state → CONFLICT pill; else
  state-mapped (WAITING/RUNNING/STALLED/QUEUED/DONE). Tooltip = statusDetail
  verbatim when present, else generic state copy; basic tier appends an
  honest "reduced perception" sentence.
- **Chips**: scope chips + branch chip; >3 collapses to first 2 + `+N` whose
  tooltip spells out branch + hidden writes/reads (v8 "+3" behavior). Done +
  merged PR → single `PR #N merged` chip.
- **Territory classes**: `w` if any writer; `r` if any reader **who is not
  also a writer there** (v8: t-pay stays green although its writer also reads
  Reconciliation); `quiet` if neither.
- **Foot**: `{n} writing[(stalled if all)] · [waiting on you] · {n} reading ·
  [{n} done today]`, "quiet" when unoccupied; need-ink color when a writer
  waits. Ages "12m"/"42s"/"09:40" derive from stateSince/lastFetchAt vs
  capturedAt (done tasks show wall-clock from the ISO string, TZ-free).
- **Correlate-hover**: task → lit = its scope territories + sub-blocks +
  conflict territories; legend kind → lit = territories matching occupancy,
  hot = tasks with any scope in a lit territory (v8 filt() semantics).

### S4 parity deltas vs static v8 (1280×800, both shots in notes/shots/)

Structure, spacing, colors, type match. Known deltas, all explained:

1. **Build & CI foot: "2 reading" vs v8 "1 reading".** The fixture occupancy
   (mechanical join of scopes) has two readers (Migrate SQLite, Auto-retry);
   v8's hand-written "1 reading" contradicts v8's own "+3" chip tooltip
   ("reads Reconciliation, Build & CI"). Kept the mechanical truth
   (honesty > pretty). Logged in DECISIONS-NEEDED.
2. **Territory entry stagger**: uniform .08+.06s·i vs v8's hand-eased tail
   (.26/.30/.34); max divergence .04s, timing-only, invisible in stills.
3. **Tooltip prose**: composed from fixture data, so a few tooltips differ
   in wording from v8's hand-written strings (e.g. full task titles instead
   of v8's abbreviated "Migrate SQLite"). Hover-only; not in screenshots.
4. **Sub-block offsets**: now exact — demoSubLayout switched from S3's
   percent approximation to v8's literal px offsets (left/top/right/bottom),
   reconciling the S3 note. Type changed accordingly (DemoSubOffset).
5. Dev fixture switcher exists in the titlebar but is hidden via
   `?switcher=0` in the parity shot.

### S4 scale-extremes handling (what actually rendered)

- **N=0 (`empty-project`)**: honest empty rail line + dashed-outline canvas
  placeholder ("No map yet…", the ONLY sanctioned dashed outline), zero-count
  titlebar stats hidden, "Never synced" + gray stale dot. Fully functional.
- **9 scopes (`scope-overload`)**: chip row collapses to `w core · w api ·
  +8` on one line; +8 tooltip enumerates branch + writes/reads.
- **100k files**: anchoredFileCount ≥1000 renders abbreviated ("100k"/"8.4k")
  with exact value in parens in the territory tooltip (v8 shows counts only
  in tooltips, so no on-canvas surface needed).
- **Long title / long territory names**: CSS ellipsis + full text via
  data-tip on task h3 and territory label (label got nowrap+ellipsis, an
  S4 addition v8 didn't need).
- **40 territories (`forty-territories`)**: all 40 render; compact rung
  (rect <14%w or <22%h) switches foot to mono abbreviation ("1w · 2r",
  "1 done") with full text in tooltip. NEW: entry-stagger window capped at
  0.6s total (v8's fixed .06s step would delay the 40th territory 2.4s —
  rows were literally missing); cap inactive at v8's N=6, parity untouched.
- **Screen sizes**: 1280×800 and 1440×900 shots captured; no overlap/clip in
  baseline. Known S5 item: at forty-territories density the floating legend
  overlays the bottom-left territory's foot (v8 inherits this; needs a
  density-aware legend position or canvas bottom inset).

## S5 checklist (done)

- [x] Interaction suite `tests/interactions.spec.ts` (29 tests) + S4 parity
      capture (6) = 35 green. Coverage: correlate-hover per rail card (exact
      footprint lit, others at .14, rail dims, full reset on leave), reverse
      correlate, legend filters ×4 (territory set AND rail cards asserted
      exactly), tooltip (260ms intent delay + instant hide, bottom-edge flip,
      exact value behind "100k"), +N chip expansion tooltip, fixture switcher
      live-swap, zero console errors on all 4 fixtures, five state pills at
      density, keyboard-focus correlate, and overlap/clipping at 1280×800 +
      1440×900 on v8-baseline AND forty-territories.
- [x] **Reverse correlate implemented** (v8 promised bidirectional): hovering
      or keyboard-focusing a territory highlights every task touching it in
      the rail (union of occupancy writers/readers/done-today + scope
      declarations), the territory stays lit, everything else dims. Symmetric
      with card-hover; `highlightForTerritory` in derive.ts.
- [x] **Legend/density overlap FIXED**: the territory field reserves a 48px
      legend band (12 offset + 30 legend + 6 clearance) at the bottom, but
      ONLY when a fixture's deepest rect exceeds v8's own 92.5% max bottom
      (t-store/t-fe), which is the deepest extent known to clear the legend.
      v8-baseline stays pixel-identical; forty-territories compresses ~5%
      vertically instead of hiding its bottom row's feet under the legend.
      (Chosen over icon-collapse: no new visual mode, one rule, honest.)
- [x] **Entry-animation fill bug FIXED** (found by the suite): `fill: both`
      on winIn/rise/terrIn pinned elements at their terminal keyframe forever
      — `.window` kept an identity transform (becoming the containing block
      for the fixed #tip → tooltip offset by the body padding) and .terr/.task
      were pinned at opacity:1, silently defeating the correlate dim after
      entry. Fill is now `backwards`: identical entry visuals, cascade works
      after. (The static v8 file keeps its own copy of the bug; the frozen
      reference is not edited.)
- [x] Keyboard parity: task cards, territories, legend entries are focusable
      (tabIndex) and focus mirrors hover (correlate reachable without a
      mouse); ring on :focus-visible only.
- [x] Test hooks: `data-task` / `data-territory` / `data-kind` attributes
      (inert metadata, no styling use).
- [x] Gates: `tsc --noEmit` clean · `pnpm build` green · `npx playwright
      test` 35/35 green.

## SCALE-EXTREMES PROTOCOL — closure (written answers per component)

Each row cites the implementing code and/or the test that pins it.

| Case | Component | Answer | Evidence |
|---|---|---|---|
| N=0 | rail | Honest one-liner "No tasks yet…", launch CTA still present — app fully usable | `TaskRail.tsx` rail-empty; test "empty-project renders clean" + switcher test |
| N=0 | canvas | Dashed placeholder box (the ONLY sanctioned dashed outline) with guidance; no legend, no fake territories | `MapCanvas.tsx` canvas-empty; switcher test asserts `.canvas-empty` visible, 0 `.terr` |
| N=0 | titlebar | Zero-count stats simply absent; "Never synced" + gray stale dot | `derive.ts` titlebarStats/freshness (counts >0 only) |
| N=1 | rail groups | Empty groups hidden; a 1-card group renders header+count honestly | `derive.ts` groupTasks `.filter(g→len>0)`; v8-baseline "Done today 1" |
| N=1 | canvas | A single quiet territory earns its space via label + "quiet" foot + file count in tooltip | `derive.ts` footFor/territoryView (quiet path) |
| N=many | chips (9 scopes) | One line, never wraps; collapse to first 2 + `+N`; +N tooltip enumerates branch + every hidden write/read | `derive.ts` taskChips MAX_CHIPS; test "+N chip: hover enumerates…" |
| N=many | canvas (40 terr) | All 40 render; entry-stagger window capped at 0.6s; compact foot rung; density legend band | `TerritoryBlock.tsx` STAGGER_WINDOW_S; `MapCanvas.tsx` needsLegendBand; overlap tests @2 viewports |
| N=many | rail (5 states) | Grouping stays 4 groups max; all five pills present | test "all five state pills render in forty-territories" |
| TEXT long | task title | CSS ellipsis + full text via tooltip on h3 | `TaskCard.tsx` data-tip={task.title}; app.css .task h3 |
| TEXT long | territory label/foot | nowrap+ellipsis; territory tooltip carries full name; compact foot's tooltip carries full foot text | app.css .terr .label/.foot; `derive.ts` footFor compact tip |
| TEXT long | chips | max-width 110px + ellipsis; chip tooltip spells the scope out | app.css .chip; `derive.ts` scopeChip tip |
| NUMBER huge | file counts | ≥1000 abbreviates ("100k"/"8.4k"); exact value "(100,000 exactly)" in tooltip | `derive.ts` formatCount/exactCount; test "abbreviated 100k…" |
| SPACE tiny | territory | Degradation ladder: full foot → compact mono "1w · 2r" (rect <14%w/<22%h) → label ellipsis; every rung's full text lives in the tooltip | `derive.ts` COMPACT_* + footFor(compact); forty-territories fixture |
| DYNAMIC | tooltips/correlate | All hidden info reachable by hover AND keyboard focus; tooltip hides instantly, dim/lit resets on leave/blur — space always returned | `Tooltip.tsx`; App state; tests "hover ends → focus fully resets", "keyboard focus…" |
| SCREEN sizes | whole screen | 1280×800 + 1440×900: legend clears every territory, territories inside canvas, window inside viewport — asserted on baseline AND 40-territory density | tests "no overlap / no clipping" ×4 |

## Next: m2-task-panel S1 (map-main complete through S5)
