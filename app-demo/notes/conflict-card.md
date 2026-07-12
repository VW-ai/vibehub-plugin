# conflict-card — screen notes

Stage: **S5 done — screen complete** (interaction/state suite in
tests/conflict-interactions.spec.ts + adjudication demo-stub feedback +
scale-extremes closure below; S4 React card + 3 open paths; S3 types/fixtures;
S2 polish at `static/conflict-card-s2.html`; S1 frozen for diff).
React variants: `?conflict=` dev param — `osm-red-diagnosed` · `no-diagnosis` ·
`yellow-stale` · `1200-symbols` · `one-symbol` (short tails accepted).
Static variants: `?v=` param or the DEV bar — `""` red W×W diagnosed · `empty` ·
`yellow`.

## S5 checklist

- [x] **Adjudication feedback (demo stub, optimistic UI)** — S4 left the three
      footer actions static; S5 defines what clicking DOES in the demo (design
      fork, iter-13):
      - Clicking an action swaps the footer (textarea + actions) for a
        **feedback band** (`.fdbk`): text pill first (state's first channel),
        one plain sentence, a visible mono `demo` marker whose tooltip is the
        honesty disclosure ("Demo — this card renders a fixture; no live
        session received this…"), and a quiet **Close card** button that gets
        focus (the outcome is one keystroke from done; closing returns focus
        to the exact opener via the normal close path).
      - **Inject to both** → `SENT` (done tokens): typed note ⇒ "Coordination
        note queued to both tasks — delivered at their next turn boundary."
        Empty note **with** a diagnosis ⇒ the send-time default (iter-10
        fork #3): "The Suggested line above is queued…, marked as
        AI-suggested." Empty note with **no** diagnosis ⇒ nothing is sent —
        the button hands focus to the textarea (nothing to default to; an
        empty send would be an empty message — fork).
      - **Pause one side** (real side) → `PAUSING` (idle tokens): names the
        parked task, promises the turn boundary (never claims it already
        stopped), says the other side keeps running. The waiting side stays
        the S2 honest no-op: menu closes, NO feedback.
      - **Ignore this pair** → one modest **inline confirm** in the actions
        row (never a browser dialog): "Silence this pair permanently?" +
        "Ignore permanently" (clash-ink quiet) + "Keep" — focus lands on
        Keep (the safe option; Enter must not destroy). Confirmed ⇒
        `IGNORED` (idle tokens), sentence scoped to THIS pair on the
        resource; the card stays open so the evidence remains readable.
      - Feedback pills use the neutral family only (done/idle) — feedback is
        not a task state; the three semantic colors stay reserved.
      - Band is `role="status" aria-live="polite"`, `data-kind` carries the
        emitted `AdjudicationAction["kind"]` (the S3 union is now actually
        constructed by the footer). Terminal within the card instance — no
        undo (the confirm is the gate); the card remounts per conflict id, so
        close/reopen resets (fixture demo).
- [x] **Run / Re-run diagnosis stub**: the demo cannot run `claude -p`, and
      inventing a verdict or a fake progress state would be fabrication — so
      both buttons TOGGLE an honest inline note (`.stubnote`, aria-pressed):
      "Demo — nothing ran. In the app this is one `claude -p` pass on your
      machine, and the verdict above refreshes in place / the diagnosis fills
      in here." Backticks render mono via the same codeSpans; the verdict and
      stale marker never change; the note yields its space back on re-click.
- [x] **Escape priority ladder**: pause menu → ignore confirm → card (each
      swallows one Escape). Pause menu and ignore confirm displace each other
      (one open decision at a time).
- [x] **tests/conflict-interactions.spec.ts — 14 tests**, formalizing S4's
      ad-hoc coverage + the gaps:
      1. fixture × zone-state MATRIX: all 5 fixtures × zone a (grade class +
         kicker, 2 side rows + pills, symbol rows shown, toggle label
         "+9 more"/"+1,197 more"/none, h4 count 3/12/1.2k/1), zone b
         (fresh/stale/empty, "· 3 edits since"), zone c (placeholder
         contract, 2 menu rows, noop count) — zero console/page errors;
      2. inject typed → SENT band (data-kind, role=status, demo tip,
         textarea+actions gone, evidence still visible), keyboard-driven
         end-to-end, Close focused, Enter closes + focus returns to the rail
         pill opener;
      3. inject empty + diagnosis → AI-suggested variant; seam booleans
         re-agree with real scroll metrics after the footer swap;
      4. inject empty + no diagnosis → no band, textarea focused;
      5. pause via keyboard (Enter opens menu, Tab, Enter) → PAUSING band;
      6. noop row → no feedback (S4 regression);
      7. ignore confirm: Keep focused + Enter cancels; Escape ladder
         confirm→card;
      8. ignore confirmed → IGNORED band, card stays open, Close focused;
      9. menu ↔ confirm mutual displacement;
      10. Re-run stub toggle (mono `claude -p`, verdict/stale untouched,
          space yielded back);
      11. Run-diagnosis stub in the dashed empty state;
      12. 1200-symbol expand under a 3s smoke ceiling (broken-detector, not a
          perf benchmark — tunable) + scroll sweep bottom/middle/top with
          seam-vs-metrics agreement + collapse + SENT still works;
      13-14. geometry @1280×800 + @1440×900 in the busiest states: stress
          (12 expanded + textarea at 124px cap + menu open): modal-in-main,
          strict head/grade/body/foot stacking, foot pinned, .cbody the only
          scroll region, no page scroll, menu in viewport; then the feedback
          state: band inside the footer, footer still pinned, no x-overflow.
- [x] Gates: `tsc --noEmit` clean; `pnpm build` green; Playwright **85/85**
      (71 existing untouched + 14 new), all first-run green.

## SCALE-EXTREMES PROTOCOL — closure table (per zone, with evidence)

| Zone / component | Rung | Answer | Evidence |
|---|---|---|---|
| **Card as a whole** | N=0 conflicts | no card — the entry points (sub chip, rail pill, titlebar stat) don't render without a conflict; a card cannot exist with zero shared symbols (the intersection IS the trigger) | derive.ts SubView.conflictId only set from fixture.conflicts; interactions.spec "titlebar stat absent on conflict-free fixtures" precedent (map S5) |
| | unauthored conflict | falls back to the task panel — evidence can't be honestly synthesized from a MapFixture | App.tsx `openConflict` fallback (iter-12 fork); fixtures/index.ts comment |
| **Header / crumb (a)** | TEXT long | h2 single-line ellipsis + full-text tooltip (`titleTip`); crumb segs ellipsize, anchor file mono | conflict-derive.ts titleTip; app.css `.chead h2`; yellow fixture's long titles render in matrix test |
| | NUMBER (age) | relAge rungs s/m/h/d — `one-symbol` exercises the 45s seconds rung; exact time + long age in the tooltip | conflict-extremes.ts (detected 45s); matrix test renders it; derive.ts relAge tests (map S5) |
| **Grading strip (a)** | states | exactly two grades ever (red W×W / yellow W×R) — same-file-different-symbols never makes a conflict record, so N/A here by construction | conflict-derive.ts gradeView (two-branch, exhaustive on severity); matrix asserts kicker per fixture |
| **"Between" rows (a1)** | N=many | never scales — `tasks: [Task, Task]` by type; a third concurrent task = another pair record | conflict-types.ts tuple; matrix asserts `.side` count 2 on all 5 fixtures |
| | TEXT long | task titles single-line ellipsis + tooltip; branch chips inline-block ellipsis ("auto-retry-fail…") | app.css `.side h3`, `.modal .chip` (S2 R1 fix #1); yellow's 2 long titles in matrix |
| **Shared symbols (a2)** | N=1 | one row, NO toggle, layout holds | `conflict-one-symbol`; matrix asserts symsShown 1 + toggle count 0 |
| | N=many | 3 + "+N more" ladder; expanded body is the only scroll region, header/grade/foot pinned | matrix: yellow "+9 more", 1200 "+1,197 more"; perf test expands to exactly 1200 rows; geometry probes |
| | NUMBER huge | h4 count reuses the map's rule: "1.2k" surface + "1,200" exact in tooltip (iter-11 fork) | conflict-derive.ts symbolCount; matrix + parity test assert "1.2k" |
| | TEXT long | symbol names ellipsize + full text in row tooltip (61-char and ~90-char names in fixtures) | app.css `.sym .name`; yellow + 1200 fixtures; matrix renders both |
| | scroll perf | 1200-row expand < 3s smoke ceiling; seam booleans track scroll metrics at bottom/middle/top; collapse yields space back | conflict-interactions.spec test 12 |
| **Diagnosis (b)** | N=0 (empty) | dashed true-empty state + Run button (cost-honesty tooltip); never auto-fake | matrix on `no-diagnosis`/`one-symbol`; Run-stub test asserts no verdict appears |
| | stale | neutral dot + "· N edits since" + mechanical tooltip; fresh = green dot, no marker | matrix fresh/stale split; parity spec stale assertions |
| | TEXT long | verdict/suggested WRAP, never truncate (payload); 3-line Suggested verified at S2, re-rendered in matrix | S2 stress log; app.css `.verdict` (no ellipsis) |
| **Adjudication (c)** | states | footer has exactly 2 states: actions (with ≤1 open decision: menu XOR confirm) / feedback band (3 variants under one visual pattern) | ConflictCard.tsx feedback/menuOpen/confirmIgnore; displacement test 9 |
| | TEXT long (note) | textarea autogrow 52→124 cap then internal scroll, footer stays pinned; feedback sentence wraps inside the band (flex p, no overflow) | geometry tests 13-14 (cap = 124 asserted; band no-x-overflow) |
| | DYNAMIC | menu/confirm/stub-note/expand all yield space back on dismiss; seams recompute on every footer/body resize (ResizeObserver + layout effect deps) | tests 3, 9, 10, 11; ConflictCard.tsx recalcSeams deps |
| **SPACE tiny** | — | modal fixed 640px, min viewport 1280 — degradation ladder not needed beyond chip/name ellipsis (decided S1, unchanged) | geometry tests: modal-in-main at both viewports in the busiest state |
| **SCREENS** | 1280×800 / 1440×900 | busiest pre- and post-decision states probed: stacking, pinning, single scroll region, no page scroll, menu in viewport, band in footer | conflict-interactions.spec tests 13-14 |

## S4 checklist

- [x] `src/components/ConflictCard.tsx` (zones a/b/c in one dialog component) +
      `src/conflict-derive.ts` (pure view derivations) — consuming ONLY
      `conflictFixtures`; zero hardcoded content in JSX (chrome copy lives in
      conflict-derive, S2-verbatim where the S2 text was generic).
- [x] Three open paths wired, all with keyboard parity (focusable opener,
      Enter/Space, focus RETURNS to the exact opener on close via rAF —
      the app's one focus rule):
      1. map sub-block clash chip ("2 writing") — `SubView.conflictId` added in
         derive.ts, chip gets role=button/tabIndex, stopPropagation so the
         territory hover/handlers don't swallow it;
      2. rail CONFLICT pill — the pill is its own affordance ("Click to
         adjudicate", its v8 tooltip); the REST of the card still opens the
         task panel (fork logged iter-12);
      3. titlebar "1 conflict" stat.
      Close paths: X / Escape / scrim — one contract. Escape with the pause
      menu open closes the MENU first (S2 behavior), second Escape closes the
      card (mechanically tested).
- [x] Reconcile (iter-11 fork → kernel brief): `v8-baseline.ts` conflict-osm
      `sharedSymbols` now equals the card fixture's names
      (transition/guards/ORDER_STATES — conflict-osm-red.ts is the single
      source of truth). The map only surfaces the COUNT (3, unchanged) so v8
      render parity holds; map suite stayed green with NO test edits (no test
      asserted the names). Timestamps deliberately NOT reconciled — the two
      fixtures are different snapshots (map capturedAt 10:22, card 11:15);
      fork logged iter-12.
- [x] Global `[hidden]{display:none!important}` in app.css (the iter-10
      3rd-occurrence bug class); no per-selector guards ported from the
      statics (the statics keep theirs — frozen artifacts).
- [x] All S2 behaviors, mechanically verified in tests/conflict-parity.spec.ts:
      scroll-aware seam shadows (grade down / footer up, off when it fits;
      recomputed on scroll + ResizeObserver + expand), symbol 3+"+N more"
      expand/collapse (yields space back), pause split-menu with the honest
      no-op row (enabled, secondary ink, "waiting 5m"), inject textarea
      autogrow 52→124→52, empty-note placeholder contract (diagnosed = the
      send-time default surfaced; no-diagnosis = generic), staleness marker
      (neutral dot + "· 3 edits since" from the fixture's own touch times),
      Re-run fresh/stale tooltips, diagnosis empty↔done from `diagnosis`
      presence.
- [x] Backtick tokens in diagnosis text render mono (iter-11 fork #4):
      `codeSpans()` splits the verbatim model text; `.verdict .code` =
      --mono/fs-2. Asserted: yellow renders exactly 2 mono `resolve()` spans
      in ui-monospace.
- [x] Modal exclusivity: conflict card ↔ task panel — opening either closes
      the other (fork logged iter-12). Side rows ("Between") deliver the S2
      tooltip promise: click/Enter opens that task's panel (map task record
      preferred by id; the card's standalone copy backs ?conflict= fixtures
      not on the map → synthetic panel per m2 honesty rules).
- [x] Gates: `tsc --noEmit` clean; `pnpm build` green; Playwright **71/71**
      (59 existing untouched + 12 new in conflict-parity.spec.ts: 6 parity
      captures + static-ref capture + 3-path/focus-return + exclusivity +
      menu-Escape + S2-behaviors + 5-fixture zero-error sweep incl. 1200-symbol
      expand to exactly 1200 rows and "1.2k" h4).

### S4 parity deltas (React vs static/conflict-card-s2.html)

Shots: `conflict-card-s4-{red,yellow,empty}-{1280x800,1440x900}.png` (full page)
+ `conflict-card-s4-modal-{red,yellow,empty}-1280.png` vs
`conflict-card-s4-static-modal-*-1280.png` (element shots, like-for-like).

1. **Modal element shots: no visible delta** — red/yellow/empty side-by-side
   are pixel-equivalent (geometry, type, colors, seams, chip ellipsis,
   dashed empty state, mono spans).
2. **Underlay (expected)**: the app renders the real map (rail + territories
   + subs + feet + legend, blurred 1.5px) under the scrim; the static used a
   hand-simplified rail-less canvas. Titlebar adds the app's freshness
   element ("Synced 42s ago") and dev switcher (hidden via ?switcher=0 in
   shots). Stats identical (1 waiting / 1 conflict / 3 running).
3. **Tooltip copy (invisible in shots)**: S2's hand-written prose tooltips
   are now mechanical derivations — e.g. "Edited by Auto-retry at 11:04 and
   by Cancel-on-timeout at 11:07" → "Edited by 'Auto-retry failed payments'
   at 11:04 and by 'Cancel orders on timeout' at 11:07"; "The batching
   rewrite edited 3 shared symbols after this diagnosis ran (11:03 → 11:08)"
   → "3 shared-symbol edits — by 'Rewrite the notification batching…' —
   landed after this diagnosis ran (11:03 → 11:08)"; the read-chip's "it
   consumes the registry API, no writes declared" → "no writes declared".
   Fork logged iter-12.
4. **Dev bar not ported** — the `?conflict=` param + titlebar fixture
   switcher replace it; the bar was never product UI.
5. **"Run AI diagnosis" / "Re-run" / "Inject to both" / pause rows / "Ignore
   this pair" are static affordances at S4** (tooltips state their
   contracts; real actions are S5+ scope — same precedent as the panel deck
   at its S4).

## S3 checklist

- [x] `src/conflict-types.ts` EXTENDS `src/types.ts` — Conflict / Task / scopes /
      git facts imported, zero duplication. Per-field source annotations in the
      panel-types.ts style; signal-inventory header lists the card's one
      non-mechanical source (`claude -p` output, quoted verbatim + provenance-labeled,
      confined to zone b).
- [x] `ConflictDiagnosis`: verdict line + `sides: [DiagnosisSide, DiagnosisSide]`
      (per-side "doing" rows, taskIds order) + `suggested` (also the empty-note
      send-time default, iter-10 fork #3) + `provenance {diagnosedAt,
      engine:"claude-p-local"}` + `stalenessEditsSince` (PostToolUse EDIT count after
      diagnosedAt; reads never count — the verdict goes stale when code changes, not
      when someone looks). Stored, not derived: `SymbolTouch` keeps only the LATEST
      touch per side per symbol, so the true edit count is not recoverable from
      `symbols` (fork logged iter-11).
- [x] `AdjudicationAction` union: `inject_note {note?}` (empty ⇒ suggested verbatim,
      marked AI-suggested) | `pause_side {taskId}` | `ignore_pair`. User inputs we
      forward — signal class 5.
- [x] `ConflictCardFixture`: capturedAt + conflict (map type unchanged) +
      `tasks: [Task, Task]` (denormalized, taskIds order — "Between" never scales) +
      `ResourceCrumb` (denormalized names, CrossReadNotice precedent) +
      `SharedSymbolEvidence[]` (1:1 with conflict.sharedSymbols, per-symbol
      `[SymbolTouch, SymbolTouch]` edit/read provenance; "both edited" / "w × r"
      DERIVED from the two actions, never stored) + `diagnosis?` (absent = dashed
      empty state).
- [x] S1 leftover DECIDED: >999 symbol count follows the map's NUMBER-huge rule —
      reuse `formatCount`/`exactCount` from derive.ts ("1.2k" on the h4, exact
      "1,200" in the tooltip). Fork logged iter-11.
- [x] Fixtures (TS literals + `satisfies`, registry `conflictFixtures` +
      `conflictFixtureByName` in fixtures/index.ts):
      - `conflict-osm-red-diagnosed` — S2 red verbatim (detected 8m, running 31m/9m,
        3 symbols with S2 tooltip times, diagnosis 11:12, staleness 0 — 11:12 IS the
        last edit).
      - `conflict-no-diagnosis` — the `?v=empty` variant: same consts, no `diagnosis`.
      - `conflict-yellow-stale` — S2 yellow verbatim: W×R, 12 symbols (61-char name),
        long task titles, waiting no-op side (asked 11:10, 5m), diagnosis 11:02 with
        stalenessEditsSince 3 — and the fixture's OWN touch times prove it
        (11:03/11:05/11:08 edits after 11:02).
      - `conflict-1200-symbols` — NUMBER-huge/N=many extreme: 1,200 deterministic
        generated symbols (codegen-sweep story), ~90-char names every 97th row,
        staleness COMPUTED from the generated touches (cannot lie; lands ≫100).
      - `conflict-one-symbol` — N=1 (S1 notes' explicit S3 obligation): single
        symbol, detected 45s ago (seconds rung), no diagnosis.
- [x] Gates: `npx tsc --noEmit` clean (strict + exactOptionalPropertyTypes);
      `pnpm build` green; Playwright suite still 59/59. Runtime invariants
      spot-checked via throwaway vitest (6 tests, deleted after): name/order
      alignment symbols↔sharedSymbols and touches/sides↔taskIds, symbol-name
      uniqueness, S2 age reproduction (8m/31m/9m · 31m/1h/5m · 45s),
      staleness counters equal the touch-derived counts, 1.2k/1,200 formatting.

### Type → signal table (S3)

| Type / field | Signal source |
|---|---|
| `SymbolTouch.action/at` | PostToolUse hook: Edit/Write ⇒ "edit", Read ⇒ "read" (timestamps from the hook payload); teammate branches via `git merge-tree` / diff-hunk→anchor (github-002) |
| `SharedSymbolEvidence.name/file` | distillation anchor map (github-001) |
| `ResourceCrumb.*` | distillation output (territory/sub-block/resource names, anchoring file), denormalized for standalone render |
| `ConflictDiagnosis.verdict/sides/suggested` | `claude -p` output, VERBATIM (backtick code tokens kept as emitted; UI renders them mono) |
| `DiagnosisProvenance.diagnosedAt/engine` | the local `claude -p` process (exit time; engine literal) |
| `ConflictDiagnosis.stalenessEditsSince` | count of PostToolUse Edit/Write events on shared symbols with timestamp > diagnosedAt |
| `AdjudicationAction` | user's own card actions — inputs we forward (class 5) |
| `ConflictCardFixture.tasks/conflict` | map types unchanged (hook state machine + declarations + git facts, see types.ts) |
| header age "8m" / menu "running 31m" | `relAge(detectedAt/stateSince, capturedAt)` — derived, derive.ts |
| "both edited" / "w × r" row annotation | DERIVED from the two touches' actions, never stored |
| h4 count "1.2k" (+ exact tooltip) | DERIVED via `formatCount`/`exactCount` (map's NUMBER-huge rule) |

## S1 checklist

- [x] Centered 640px modal over dimmed map — same underlay language as the task panel
      (canvas blur 1.5px + scrim rgba(25,27,31,.22), click-to-close tooltip on scrim).
- [x] Zone a — static evidence, always present:
  - [x] Header = CONFLICT pill (clash) + resource name + first-detected age (mono,
        tooltip has exact time + "repeat hits merge here, no re-alerts" = notification
        budget honesty) + close.
  - [x] Crumb = territory › sub-block › anchoring file (mono).
  - [x] Grading strip: soft fill, NO stripes, text first ("W × W" / "W × R" mono
        kicker + one plain sentence). RED borrows --need tokens (push-eligible grade),
        YELLOW stays --clash. See DECISIONS-NEEDED (iter-9).
  - [x] Two task rows ("Between"): state pill (their REAL state — RUNNING/WAITING,
        conflict stays an attribute per 020/021) + name (single-line ellipsis +
        full-text tooltip) + declared w/r chip on this resource + branch mono chip.
  - [x] Shared symbols: mono list, per-row tooltip (file · who edited when), right
        annotation "both edited" / "w × r". Overflow: 3 shown + "+N more" expandable
        (yellow variant: 12 → 3 + 9).
- [x] Zone b — AI diagnosis, on-demand:
  - [x] Completed state: bold verdict line, per-side "what it's doing" rows, Suggested
        row (tooltip: suggestion ≠ action), provenance line "diagnosed by your local
        claude · HH:MM" + Re-run (tooltip: costs one local model call).
  - [x] Empty state: dashed placeholder (true empty state → dashed allowed),
        primary-quiet "Run AI diagnosis" with cost-honesty tooltip (`claude -p`,
        your machine, your account, no extra API key). Reachable via dev toggle
        AND ?v=empty.
- [x] Zone c — adjudication actions:
  - [x] Primary = Inject: inline coordination-note textarea (deck language, autogrow
        52→124px) + solid ink-900 "Inject to both".
  - [x] Pause one side = quiet split-button; menu lists BOTH tasks (name + state/age),
        no side pre-picked; closes on outside click / Escape. Yellow variant shows the
        honest no-op case (pausing an already-waiting task).
  - [x] Ignore this pair = quiet gray text button, isolated right (flex gap), tooltip
        spells out permanence + "THIS pair only".
- [x] v8 tokens verbatim; type 10/11/12/13; spacing 4/8/12/16/24; radii 6/10/16;
      tooltip JS verbatim (260ms); English; no emoji; inline SVG only;
      prefers-reduced-motion kill-switch; no persistent animation in the modal.
- [x] Headless verify: 1280×800 + 1440×900 × 3 variants (incl. 12-symbol expanded),
      zero console errors, modal always inside .main (geometry probe).
      Shots: `notes/shots/conflict-card-s1-{red,empty,yellow}-*.png`.
- Bug found & fixed during verify: `.center{display:flex}` (author style) silently
  defeats the `hidden` attribute → both variants rendered stacked. Fixed with
  `.center[hidden]{display:none}`.

## Scale-extremes — preliminary answers (S1; CLOSED by the S5 table above)

- N=0: a conflict card cannot exist with zero shared symbols (intersection IS the
  trigger); zero conflicts = no card, entry points don't render. Diagnosis N=0 = the
  dashed empty state (shown, honest).
- N=1: one shared symbol — list renders one row, no toggle; layout holds (rows are
  independent). Fixture case CLOSED at S3: `conflict-one-symbol`.
- N=many: 12 symbols → 3 + "+9 more" expandable (verified); expanded card grows,
  .cbody is the only scroll region, header/grade/footer pinned. 100 symbols → same
  ladder, body scrolls. Exactly two tasks by type (`taskIds: [string, string]`) —
  the "Between" zone never scales.
- TEXT long: task names (yellow variant, verified), symbol names (61-char name,
  verified), resource names, branch chips — all single-line ellipsis + full-text
  tooltip. Verdict text wraps (never truncates — it's the payload).
- NUMBER huge: symbol count in the h4 is mono raw (12); >999 abbreviates + exact in
  tooltip — DECIDED at S3: reuse the map's formatCount/exactCount ("1.2k" / "1,200");
  fixture `conflict-1200-symbols` exercises the path (render evidence due S4/S5).
- SPACE tiny: modal is fixed 640px, min viewport 1280 — no degradation ladder needed
  beyond chip truncation; at 1280×800 red-diagnosed body scrolls ~20px (footer pinned,
  verified via geometry probe).
- DYNAMIC: +N expand yields space back on "show less"; pause menu closes on outside
  click/Escape; empty→completed diagnosis is a state swap in one DOM slot.
- SCREENS: 1280×800 + 1440×900 both verified, no overlap/clipping.

## Open questions for S2 — RESOLVED at S2 (see review log below)

1. Diagnosis staleness: both sessions keep working after a diagnosis — should the
   provenance line get an explicit stale marker ("2 edits since") instead of relying
   on the Re-run tooltip? (Honesty guideline pulls yes.)
2. Red grading borrows --need tokens (fork logged iter-9) — Wayne may veto to
   all-clash; S2 must re-shoot the grade strip if so.
3. "Inject to both" with an EMPTY note: tooltip promises the diagnosis suggestion as
   a starting point — is that prefill (textarea) or send-time default? S2 should pick
   a visible behavior.
4. Task rows claim click-opens-panel (tooltip) — S4 wiring; S2 should decide whether
   the rows get hover translateY like rail cards (currently shadow-only).
5. The v8 sub-block chip has a breathing "2 writing" count; the card itself has no
   persistent animation. Should the RED grade strip get the (one allowed) persistent
   breathe? Current answer: no — the map already breathes; a modal you opened doesn't
   need to wave at you.
6. Yellow pause-menu shows a waiting task as a pausable row with a "no-op" tooltip —
   S2 could gray it out (disabled) instead. Disabled-but-explained vs enabled-no-op.
7. Dev bar is visible in screenshots; fine for S1, but S2 polish shots should pass
   `?v=` and hide the bar (add `?dev=0`?).

## S2 review log (kernel-style self-review, screenshots at 1280×800 + 1440×900)

Artifact: `static/conflict-card-s2.html` (S1 copied, only the s2 file edited).
Shots: `notes/shots/conflict-card-s2-{red,empty,yellow,yellow-expanded,stress}-{1280x800,1440x900}.png`
(final = round 3; `-r1`/`-r2` = earlier rounds). `stress` = 12 symbols expanded +
10-line textarea at the 124px cap + pause menu open, all at once. Every round, every
scenario, both sizes: zero console errors, zero pageerrors, modal-inside-main +
footer-pinned + dev-bar-hidden geometry probes green.

### Open-question resolutions (implemented; forks logged to DECISIONS-NEEDED iter-10)

1. **Diagnosis staleness → explicit marker.** `.prov` gains a `stale` state: the green
   dot goes neutral (ink-300 — green only while the verdict matches reality) and an
   honest "· N edits since" marker (ink-500, tooltip = which side edited what, when,
   "the verdict may no longer hold"). Yellow variant renders stale (3 edits after its
   11:02 diagnosis — its own symbol fixture says so); red renders fresh (diagnosed
   11:12 = the last edit). Re-run tooltips updated to match each state.
2. **Red grade = need tokens** — ratified with iter-9 defaults; unchanged, no re-shoot.
3. **Empty-note contract → send-time default, surfaced in the placeholder.** Diagnosed
   cards: placeholder "leave empty to send the Suggested line above, verbatim…" +
   tooltip "sent, marked as AI-suggested". No-diagnosis card keeps the generic
   placeholder (nothing to default to); setVariant swaps both. Prefill REJECTED:
   prefilled AI text reads as user-authored (dishonest) and inflates the deck.
4. **Task rows get the rail-card hover** — translateY(-1px) + sh-2, exactly v8's
   `.task:hover`: same affordance (click opens the task panel), same language.
5. **No persistent breathe on the RED grade strip** — confirmed no. The map already
   breathes; a modal you deliberately opened doesn't need to wave at you. Zero
   persistent animation in the modal.
6. **Waiting task in pause menu = enabled no-op, visually secondary.** Kept clickable
   with the honest tooltip (iter-9 ratified; disabled = dead pixels, guideline:
   everything hover-explainable), but `.noop` drops the name to ink-500/500-weight so
   the row visibly isn't the point of the menu.
7. **Dev bar → `?dev=0` hides it**; all S2 shots pass it. Needed its own
   `.dev[hidden]{display:none}` guard — `.dev{display:flex}` would have silently
   defeated the hidden attribute (same bug class as S1's `.center` fix).

### Round 1 — 3 defects:

1. **Chips hard-cut instead of ellipsizing** — `.chip` was `inline-flex`; a flex
   container cannot apply `text-overflow` to its anonymous text child, so branch
   chips sliced mid-character ("cancel-orders-on-"). → `display:inline-block`
   (blockified to `block` as a flex item — ellipsis works), text centered by
   line-height:16px = height. Visible fix: "auto-retry-fail…".
2. **Red hero state scrolled 7px at 1280×800** — a scroll affordance hiding nothing
   meaningful (cognitive-load: implies hidden content). → `.diag` margin-top
   sp-4→sp-3, `.prov` margin-top sp-2→sp-1 (token-compliant). Red/empty now fit
   both sizes with bodyScroll 0.
3. **No scroll cue when `.cbody` clips** — yellow@1280 hid the entire provenance row
   (stale marker + Re-run) below a clean cut; user cannot know it exists (honesty +
   task-panel S2 precedent, same defect class as its round-2 #9). → scroll-aware
   seam shadows, task-panel language (0 1px 2px rgba(20,22,26,.08), --t-fast,
   killed by reduced-motion): grade casts down once scrolled past the top, footer
   casts up while content hides below; both off when the body fits. Re-checked on
   scroll, ResizeObserver (textarea autogrow), click (symbol expand), variant switch.

### Round 2 — 0 new defects.

Fix verification + detail pass (clip shots): pmenu no-op row secondary ink, stale
tooltip content/position, symtoggle chevron rotation + "show less", red fresh prov
(green dot), side-row hover lift, footer seam @1280. All clean.

### Round 3 — 0 new defects. Converged (3 → 0 → 0). Final shots captured.

### S2 stress outcomes

- **12-symbol expanded**: modal holds 660/708 @1280 (728/776 @1440); `.cbody` is the
  only scroll region (209px range @1280), header/grade/footer pinned (probe green).
- **Verdict at 3 lines**: yellow "Suggested" wraps to 3 lines at 640px — wraps, never
  truncates (it's the payload).
- **Textarea at cap**: grows 52→124 then scrolls internally; footer stays pinned to
  the modal bottom; cbody yields (281px scroll range @1280) and the footer seam stays on.
- **All three at once** (`stress` scenario): no overlap, no clipping, pause menu
  overlays the textarea as a normal popover and closes on Escape/outside click.

## S1 verify log

- 5 shots, 3 variants × 2 viewports (subset), zero console errors, zero pageerrors,
  modal-inside-main geometry probe green on all runs.
