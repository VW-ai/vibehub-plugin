# task-panel — screen notes

S1 artifact: `workbench/app-demo/static/task-panel-s1.html` (self-contained, no
network, opens from `file://`). Screenshots: `notes/shots/task-panel-s1-1280.png`,
`-1440.png`, `-1280-expanded.png` (files entry open + transcript tail shown).
S2 artifact: `workbench/app-demo/static/task-panel-s2.html` (same constraints;
S1 file kept frozen for diffing). Screenshots: `notes/shots/task-panel-s2-*`.

Source structure: `workbench-refs/task-panel.html` (Chinese mock — 3-section
structure approved by Wayne, decision-project-023; styling NOT approved).
Visual system: v8 tokens verbatim (`:root` copied unchanged), tooltip JS verbatim
(260ms intent delay, instant hide, edge-flip).

## S1 checklist

- [x] Rendered in context: simplified v8 map underlay (6 territories, blurred
      1.5px) + scrim rgba(25,27,31,.18); panel 520px docked right, elevation
      shadow, 200ms slide-in (`--t-base`, the screen's ONE entry animation;
      reduced-motion kills all animation/transition)
- [x] Section 1 — identity: WAITING pill + truncating task name (full text in
      tooltip) + mono age; meta row = agent · branch (mono) · worktree (mono,
      truncated, full path in tooltip) · "session 2 of 2"; scope chips
      w auth / r storage / +1; off-scope twist marker in clash tokens
- [x] Section 2 — human timeline, ONE stream: launch prompt (user-tinted),
      2 self-reports, collapsed "5 files changed" (expandable, off-scope files
      called out in clash ink), mid-flight user injection (tinted), agent
      acknowledgment, question that caused WAITING (need-tinted), low-grade
      read/read cross-notice (outline-dot + gray text, deliberately quiet);
      2 mechanical entries (test run, reads) to give the Milestones toggle work
- [x] Milestone toggle: All / Milestones segmented control; functional (hides
      non-`.ms` entries); ships showing All
- [x] Section 3 — intervention deck, pinned (flex column: head flex:none,
      timeline flex:1 overflow:auto, deck flex:none → long timelines can never
      push the deck off-screen; verified tl scrollHeight 475 > clientHeight 434
      at 1280×800, deck bottom == window bottom)
- [x] Actions: Send (solid ink-900 primary), View transcript / Resume /
      Run AI diagnosis / Mark done (fs-2 card buttons), Terminate (text-only
      need-ink, right-isolated by flex gap — distinct, not screaming)
- [x] Transcript tail: hidden dark mono region, toggled by View transcript
      (on-demand, never persistent — mock option C)
- [x] Taste: English only; zero emoji (3 inline SVGs: repo mark, close ×,
      bolt, chevron); type 10/11/12/13 only; spacing 4/8/12/16/24 only; radii
      6/10/16 (+ v8's own pill half-height radii 9/11 and window 14, carried
      from baseline); shadows not borders (textarea uses inset shadow ring like
      v8's read chips); EVERY pill/chip/entry/button/timestamp has a real
      data-tip explanation
- [x] Renders standalone, no console errors, no external requests
- [x] 1280×800 and 1440×900: no overlap, no clipping; action row exactly fits
      (488/488) after nowrap + fs-2 secondaries + sp-1 gaps

## Structure decisions (S1)

1. **Panel = flex column with a single scroll region.** Identity and deck are
   `flex:none`; only the timeline scrolls. The deck is a peer of the timeline,
   not its child, so no timeline length can displace it.
2. **User authorship channel = tinted body + colored dot + "YOU · …" kicker.**
   One visual channel per job (guideline 6): the dot color says who (green
   agent / blue you / red ask), the tint says "human-authored block", the
   kicker labels the intervention kind (launched / injected, no interrupt).
3. **Question entry reuses need tokens, cross-read stays gray.** The waiting
   cause is the panel's loudest timeline element (it's why you're here); the
   read/read notice is the quietest (outline dot, fs-2 gray) — honesty without
   alarm.
4. **Off-scope evidence appears twice, linked:** header twist marker (clash
   pill) and the expanded file list's amber line; tooltips cross-reference the
   10:20 self-report so the marker reads as evidence, not accusation.
5. **Milestone definition:** launch prompt, self-reports, aggregated
   file-change bursts, user interventions, agent questions = milestones;
   tool-level noise (test runs, reads) and cross-read notices = All-only.

## Scale-extremes at S1 (partial — full protocol due by S5)

- N=many timeline → the scroll region + pinned deck is the strategy (proven at
  this fixture: content already overflows at 1280×800).
- N=many files in a burst → collapsed "+n files changed" entry, expand on click.
- N=many scopes → +N chip (shown: +1) per v8's rail pattern.
- TEXT long → task name, branch, worktree all truncate with full text in
  tooltip; timeline bodies wrap (never truncate — it's the human record).
- Remaining for S2–S5: N=0 timeline (task just launched — show only the launch
  prompt, no fake entries), huge session counts ("session 12 of 12"), very long
  launch prompts (clamp? scroll?), waiting age > hours (12m → 3h → 2d display).

## Open questions for S2 — RESOLVED at S2 (see review log below)

1. Panel top seam → **paper-tint band** rgba(252,252,251,.8) on `.phead` (same
   family as the deck; precedent = v8 rail bg rgba(252,252,251,.7)). Hairline
   kept (on-system, v8 titlebar). Identity + deck now bookend the white
   timeline well symmetrically.
2. WAITING pill placement → **keep before title** (matches rail cards). Verified
   with a 2-line-worthy title: pill stays put, title single-line ellipsizes,
   age + close never move; full title lives in the h2 tooltip. Rule: task
   titles are ALWAYS single-line ellipsis, tooltip carries full text.
3. Ask-entry inline "Answer" affordance → **no inline button, deck-only.**
   The panel now opens scrolled to the newest event, so the WAITING question
   sits directly above the deck; an inline button would duplicate the primary
   affordance (guideline 3: new concepts default to cut).
4. Cross-read outline dot → **keep.** Reads deliberately quieter than filled
   dots without inventing a color — outline=read is already the system's
   language (v8 read territories are outlined).
5. Scrim → **.22** (was .18). At .18 the white territories glared at panel-left;
   .22 settles the map without hiding it.
6. Mode toggle copy → **left as-is**, revisit only if a third mode appears.

## S2 review log (kernel-style self-review, screenshots at 1280×800 + 1440×900)

Artifact: `static/task-panel-s2.html`. Shots: `notes/shots/task-panel-s2-*`
(final = round 3; `-r1`/`-r2` = earlier rounds; scenarios: base / expanded
(files+transcript open) / stress (long title + 40 extra entries + 10-line
textarea)). Zero console errors in every round, every size, every scenario.

**Round 1 — 8 defects:**
1. Header seam flat white + hairline only, asymmetric with the tinted deck →
   phead paper-tint band (resolves open Q1).
2. Scrim .18 too weak against white territories → .22 (Q5).
3. The WAITING question — the reason the panel is open — was below the fold at
   1280 (tlScroll 475 > client 434, scrollTop 0) → open scrolled to newest.
4. Terminate "isolation" gap measured **15px** at 520px panel width — reads as
   part of the button cluster, defeating S1's stated intent → shortened
   "Run AI diagnosis" → "AI diagnosis" (tooltip keeps the full verb); gap now
   **39px**, Terminate visually isolated again.
5. Ask-entry affordance decided: deck-only, no inline button (Q3).
6. Textarea fixed at 52px hid a 10-line answer with no growth or cue →
   autogrow on input, 52px floor → 124px ceiling (6 lines of fs-3 × 1.5 + 2×8
   padding), internal scroll beyond; deck grows, timeline flexes down, deck
   bottom stays == window bottom (verified 776/776, 860/860).
7. "View transcript" had no pressed state while the tail was open → `.quiet.on`
   inset ring (ink-300) + ink-900 text, toggled with the tail.
8. `.tl`/`.tail` had default scrollbars → thin 8px thumb (ink-200 on white,
   #4a4d53 on the dark tail), transparent track, padding-box inset.
   (Checked, not defects: 5/6px micro-spacing — v8 itself uses gap:5/6px;
   timeline dot column alignment dotCy==tCy ±1px across entry kinds.)

**Round 2 — 1 new defect:**
9. With open-at-newest, clipped mid-line text collided visually with the
   TIMELINE header/seg — no cue that content continues above → scroll-aware
   shadow seam on `.tlbar` (0 1px 2px rgba(20,22,26,.08), shadows-not-borders),
   on only when scrollTop>0, so the 1440 base view (timeline fits exactly)
   stays shadow-free. Transition uses --t-fast; killed by reduced-motion.

**Round 3 — 0 new defects.** Converged (8 → 1 → 0).

## S2 stress-test outcomes

- **2-line-worthy title:** single-line ellipsis rule holds; pill/age/close
  fixed in place; full title in tooltip (rule recorded at Q2 above).
- **40+ entry timeline:** deck stays pinned (deckBottom==winBottom at both
  sizes), timeline scrolls under the seam shadow with the styled scrollbar;
  native overflow scroll — no jank at this order of magnitude.
- **10-line textarea:** grows 52→124px then scrolls internally; the half-clipped
  7th line at the ceiling doubles as the scroll cue; the timeline yields the
  space and takes it back when the text shrinks (autogrow recomputes per input).

## S3 checklist (types + fixtures on the signal inventory)

Artifacts: `src/panel-types.ts` (new file importing from `src/types.ts` —
extends the map's types, zero duplication: Task/TaskState/scopes/git reused
as-is), `src/panel-derive.ts` (derivations), 4 fixtures in `src/fixtures/`
(`panel-refactor-auth`, `panel-just-launched`, `panel-marathon`,
`panel-quiet-milestones`), registered as `panelFixtures` in
`src/fixtures/index.ts`. `relAge` in `src/derive.ts` gained the day rung.

- [x] `TimelineEvent` discriminated union covers every S2 row; each member's
      doc comment names its source signal (table below)
- [x] Milestone tier DERIVED, never stored — `isMilestone()` in
      panel-derive.ts, mechanical 023 whitelist, zero LLM (fork logged:
      derived tier is coarser than the S2 static's hand-tagged `.ms` set)
- [x] Session identity (`SessionIdentity`): agent kind + sessionOrdinal/
      sessionCount + previous-session end fact; branch/worktree stay on
      `Task.git` (not duplicated)
- [x] Twist evidence (`TwistEvidence`): observed off-scope files only —
      declared side already lives in `Task.scopes`, so the diff is a join;
      `acknowledgedByEventId` links the corroborating self-report
- [x] No sentiment / confidence / progress-% fields anywhere
- [x] Fixtures are TS literals + `satisfies TaskPanelFixture` (iter-1
      precedent); marathon's 60 events generated by pure index arithmetic —
      no Date.now, no Math.random, fixed ISO day
- [x] Gate: `npx tsc --noEmit` clean (strict + exactOptionalPropertyTypes)
- [x] Gate: `pnpm build` green (map bundle unaffected)
- [x] Runtime invariants verified (esbuild-bundled spot check):
      refactor-auth 10 events / 3 milestones / 12m · just-launched 1 / 1 /
      42s · marathon 60 / 14 / 3h · quiet-milestones 8 / 3 / 2d; all
      timelines ascending, all ids unique

### Type-mapping table: event type → source signal

| Event type          | Source hook / fact                                            | Tier (derived)          |
|---------------------|---------------------------------------------------------------|-------------------------|
| `launch`            | UserPromptSubmit (first prompt of session 1)                  | milestone (user action) |
| `self_report`       | Stop → transcript_path (agent's own turn text, verbatim)      | All-only                |
| `file_change`       | PostToolUse (Edit/Write/MultiEdit) grouped per burst + git status | All-only            |
| `file_read`         | PostToolUse (Read) grouped per burst + anchor map             | All-only (mech)         |
| `test_run`          | PostToolUse (Bash test command; counts from tool result)      | All-only (mech)         |
| `user_injection`    | panel Send → UserPromptSubmit at next turn boundary           | milestone (user action) |
| `agent_ack`         | Stop → transcript_path (first report after injection)         | All-only                |
| `question`          | Notification (awaiting input) + Stop                          | milestone (→waiting transition carrier) |
| `cross_read_notice` | PostToolUse Read × concurrent session, path intersection      | All-only (quietest)     |
| `commit`            | PostToolUse (Bash git commit) confirmed by git log            | milestone (anchor)      |
| `state_transition`  | 021 hook mapping: Notification/Stop/heartbeat/tool resumption | milestone (转折为节)     |

### Age formatting rule (defined at S3, shared map + panel)

`relAge()` in src/derive.ts: `<60s → "Ns"`, `<60m → "Nm"`, `<24h → "Nh"`,
`≥24h → "Nd"`; single unit, rounded to nearest; exact moment always in the
tooltip. Sub-day behavior byte-identical to the frozen v8 parity values
(which never exceed hours), so map parity is untouched.

### Scale-extremes progress at S3 (fixture side now exists)

- N=0 → `panel-just-launched`: launch-only timeline (a launched task can
  never have a truly empty history — the founding instruction IS the honest
  empty state), empty transcript tail.
- N=many → `panel-marathon`: 60 events, session 12 of 12, ~700-char launch
  prompt.
- Ages → 42s / 12m / 3h / 2d all covered across the four fixtures.
- Sparse milestones → `panel-quiet-milestones` (exactly 3) and
  `panel-refactor-auth` (also 3 under the 023 derivation — no commits yet,
  honest sparseness per 023's known boundary).

## S4 checklist (dynamize + map integration)

Artifacts: `src/components/TaskPanel.tsx` + `PanelIdentity.tsx` +
`Timeline.tsx` + `TimelineEntry.tsx` + `TranscriptTail.tsx` +
`InterventionDeck.tsx`; view helpers added to `src/panel-derive.ts`
(timeTip / panelScopeChips / sessionMeta / twistView / deckPlaceholder);
`src/fixtures/synthetic-panel.ts` + `panelForTask` / `panelFixtureByName`
in `src/fixtures/index.ts`; panel CSS appended to `src/app.css` (S2 values
verbatim, panel-scoped where selectors would collide with map styles);
capture spec `tests/panel-parity.spec.ts`. Shots: `notes/shots/task-panel-s4-*`.

- [x] Zero hardcoded content: every prompt/report/file/count/sha/time comes
      from the panel fixture through panel-types; templates in components
      are chrome that explains semantics (same license as derive.ts)
- [x] Click a rail card → panel slides in 200ms (`--t-base`) over the map;
      canvas blurred 1.5px (S2) + scrim rgba(25,27,31,.22) over the whole
      .main; close via X, Escape, scrim click; fixture switch closes too
- [x] Keyboard parity: cards open on Enter/Space (they were already
      focusable); panel affordances get :focus-visible rings
- [x] Milestones toggle renders the DERIVED tier (isMilestone, 023
      whitelist) — see "Derived-tier visual difference" below
- [x] S2 behaviors preserved and verified live: open-at-newest (scrollTop
      45/45 at 1280, seam shadow on at open, off at top), file_change
      expandable with off-scope amber line, transcript tail toggle with
      pressed state, textarea autogrow 52→124px cap (deck bottom == window
      bottom 776/776 with 10-line input), mode toggle placeholder narration,
      global 260ms tooltip reused (map's Tooltip, document delegation)
- [x] Map ↔ panel wiring: v8-baseline "Refactor auth flow" opens
      panel-refactor-auth (hand-authored, S2 content verbatim); every other
      card opens a synthetic panel (launch + state transition only — honesty
      rules in synthetic-panel.ts; queued → honest ".tl-empty" note, no fake
      launch); `?panel=marathon|just-launched|quiet-milestones|refactor-auth`
      dev param reaches the extremes (verified: 60/14 rows, session 12 of 12,
      3h · 1/1, 42s · 8/3, 2d)
- [x] Gates: `npx tsc --noEmit` clean; `pnpm build` green; Playwright
      40/40 = existing map suite 35/35 untouched + 5 new capture tests
      (tests/panel-parity.spec.ts); zero console errors across all flows

### S4 parity deltas vs static/task-panel-s2.html (panel region ≈ identical)

1. **Underlay**: the real v8-baseline map + left rail sit under the scrim
   (S2 static had a simplified 6-territory canvas and NO rail). Titlebar
   shows the map fixture's derived stats + Synced pill (same values as S2's
   hardcoded ones: 1 waiting / 1 conflict / 3 running).
2. **Age tooltip**: derived template "In WAITING since 10:31" replaces S2's
   hand-written "Stopped to ask you a question 12 minutes ago (10:31)" —
   the generated form works for every state/fixture.
3. **`.sub` → `.subnote`**: S2's corroboration-line class collided with the
   MAP's `.sub` (absolute sub-block chips) and was yanked out of flow —
   renamed in the React port, pixel-identical rendering. (Caught by shot
   review: the sub overlapped the 10:24 injection before the fix.)
4. **Milestones seg tooltip copy** updated to describe the 023 derived tier
   (S2's described its hand-tagged set — superseded, DECISIONS iter-6/7).
5. Scroll offset at open differs by a few px (content heights differ
   sub-pixel between engines); same "clipped line above" cue at 1280, same
   everything-fits view at 1440.

### Derived-tier visual difference (023 supersedes S2's hand-tagged .ms)

On the auth timeline, Milestones now keeps 3 of 10 entries (launch 09:58 →
injection 10:24 → question 10:31) where the S2 static kept 8. The tier
reads as "founding instruction → my intervention → what it needs now" — a
pure user-action/transition spine with zero agent narration; it no longer
scrolls at 1280 (seam off). Self-reports and file bursts remain All-only,
which the S2 "All" view already showed — so All is byte-identical to S2.

### Integration decisions (S4)

- The panel is owned by App (open/close state), remounted per task via
  `key={task.id}` so tier/tail/scroll/textarea state never leaks across
  tasks. Correlate-hover state is cleared on open; the scrim intercepts all
  map/rail pointer events while open.
- Scrim covers rail + canvas (S2 precedent covers only what existed there);
  clicking a different card therefore requires closing first — deliberate,
  logged as a fork (iter-7).
- Territory names for scope-chip tooltips resolve against the CURRENT map
  fixture (panel prop `map`), falling back to the scope's own label when
  the territory id is unknown (e.g. marathon's payments ids over
  v8-baseline).

## S5 checklist (interactions + states — stage exit)

Artifact: `tests/panel-interactions.spec.ts` (19 tests). Full suite
59/59 green (map 35 + panel-parity 5 + panel-interactions 19); `tsc --noEmit`
clean; `pnpm build` green.

- [x] Open paths: card click / Enter / Space (keyboard parity); panel is a
      `role=dialog` labeled with the task title
- [x] Close paths: X / Escape / scrim click — ALL return focus to the
      opening card (implemented this iteration in App.tsx `closePanel` +
      `openerTaskId` ref; Escape rerouted through the same path). Recorded
      keyboard-parity principle satisfied; side effect logged as a fork.
- [x] Open-at-newest verified mechanically (scrollTop == scrollHeight −
      clientHeight at 1280); tlbar seam shadow on at open, off at top,
      returns on scroll-down
- [x] Milestones toggle: auth timeline 10 → 3 derived entries (2 user-voice
      + 1 ask; first = launch, last = question), back to 10 under All
- [x] file_change expand/collapse; off-scope files rendered in EXACTLY the
      --clash-ink token (computed-color probe), distinct from the list color
- [x] Transcript tail toggle + `.quiet.on` pressed state, both directions
- [x] Textarea autogrow: floor 52 → cap 124 exactly, scrollHeight > 124
      (internal scroll), deck bottom == panel bottom at cap; height returns
      to 52 when cleared
- [x] Mode toggle: placeholder narration swaps between the inject and pause
      contracts (exact copy asserted), `.on` follows the selection
- [x] Tooltips on panel anchors: not shown at 80ms, shown after 260ms+;
      real content asserted (age → "In WAITING since 10:31", Terminate →
      non-destructive reality, Milestones seg → derived-tier description)
- [x] Synthetic honesty: queued (g-task-queued) → 0 rows + "Not launched
      yet" note + "(nothing emitted yet…)" tail; running (g-task-running) →
      exactly 1 row (launch, title stand-in), no transition/report/commit
- [x] ?panel=marathon: 60 rows, session 12 of 12, scroll range > 500px,
      seam shadow tracks, deck pinned, Milestones = 14, zero console errors
- [x] Geometry @1280×800 + 1440×900, busiest state (files burst + tail
      open): sections stack strictly (phead → tlbar → tl → tail → deck), no
      positive-area overlap, everything inside the panel, panel inside the
      window, deck pinned to the panel's bottom edge, every action button
      unclipped, Terminate isolation gap > 24px (S2 measured 39px)

## SCALE-EXTREMES PROTOCOL — closure table (per component, with evidence)

| Component | Rung | Answer | Evidence |
|---|---|---|---|
| **Identity row** | N=0 scopes | chips row renders empty, twist absent (`twistView` returns null without off-scope files) — no fake chips | panel-derive.ts `twistView` (early return); synthetic panels carry only declared scopes |
| | N=many scopes | ≤2 chips + `+N` fold, tooltip enumerates every hidden scope grouped write/read | panel-derive.ts `panelScopeChips` (MAX_PANEL_SCOPE_CHIPS=2); map +N test precedent (interactions.spec "+N chip") |
| | TEXT long | title = single-line ellipsis, full text in tooltip (S2 rule Q2); branch/worktree `.trunc` + full path in tooltip (worktree maxWidth 130) | PanelIdentity.tsx h2 `data-tip={task.title}` + app.css `.phead h2` ellipsis; S2 stress shot (2-line title) |
| | NUMBER huge | session count is the row's only free-running number — "session 12 of 12" verified at marathon; ages ≥24h collapse to "Nd" with the exact moment in the tooltip | panel-interactions "marathon" test (`session 12 of 12`); derive.ts `relAge` day rung + panel-quiet-milestones (2d) |
| | SPACE tiny | fixed 520px panel — the row never gets narrower; within it the flex order (pill/age/close `flex:none`, h2 `flex:1 min-width:0`) makes the TITLE the only shrinking element | app.css `.phead .row1`; geometry test (all sections inside panel at both viewports) |
| | DYNAMIC | twist marker + every chip is hover-explainable; tooltip yields on leave (instant hide) | panel tooltips test (260ms delay, instant-hide precedent in map suite) |
| **Timeline (region)** | N=0 | honest empty state: "Not launched yet — no session, no history." — no fabricated rows | Timeline.tsx `.tl-empty` branch; synthetic-queued test |
| | N=1 | launch-only timeline: the founding instruction IS the history (panel-just-launched, 42s; synthetic running = same shape) | fixtures/panel-just-launched.ts; synthetic-running test (exactly 1 row) |
| | N=many | scroll region + pinned deck (deck is a flex peer, can never be displaced); open-at-newest so the fresh end is where you land; seam shadow says "history continues above" | marathon test (60 rows, range>500, deck pinned); TaskPanel.tsx flex column |
| | DYNAMIC | Milestones tier folds 60→14 / 10→3 mechanically (isMilestone, 023) and gives the space back on All | milestones test + marathon test |
| | SCREEN sizes | 1280: overflows → opens scrolled + shadow; 1440 base: fits, shadow off; geometry test covers both | open-at-newest test; geometry tests |
| **Timeline entries** | N=0 files in a burst | cannot render: `file_change` requires a non-empty `files` list by construction (a burst with no edits is not an event) — fixtures/synthetic never emit one | panel-types.ts `file_change.files`; synthetic-panel.ts emits no file events |
| | N=many files | collapsed "N files changed" + expand-on-click; off-scope subset flagged in clash ink inside the expansion | expand/collapse test (5 files, 2 off-scope) |
| | TEXT long | bodies WRAP, never truncate (the human record is sacred — S1 rule); marathon's ~700-char launch prompt renders in full | app.css `.ev .body` (no ellipsis); marathon shot task-panel-s4-marathon-1280.png |
| | NUMBER huge | test counts / file counts render verbatim from fixture (no abbreviation inside the record — honesty beats fit; entries wrap) | TimelineEntry.tsx test_run/file_change templates |
| | SPACE tiny | fixed 520px: entry grid (time col 44px mono + dot + body) is constant; long mono paths in `.files` wrap at line level | app.css `.ev` grid + `.files` line-height 1.9 |
| | DYNAMIC | every row's timestamp + body is hover-explainable (timeTip per type); expansion yields space back on collapse | expand/collapse test; timeTip in panel-derive.ts |
| **Intervention deck** | N=0 input | placeholder narrates the selected mode's contract — never empty chrome | mode-toggle test (exact copy both modes) |
| | N=many input (huge text) | autogrow 52→124 cap then INTERNAL scroll; deck grows, timeline flexes down, deck bottom == panel bottom; space returns on clear | autogrow test (12 lines: offset 124, scrollHeight>124, pinned, back to 52) |
| | TEXT long (labels) | action row is fixed copy sized to fit 520px with the Terminate gap intact (S2: 39px after the "AI diagnosis" rename); asserted >24px at both sizes | geometry test (gap + every button inside panel) |
| | SPACE tiny | deck is `flex:none` — it never shrinks; the timeline is the sacrificial region (autogrow verified this budget) | TaskPanel.tsx structure; autogrow test |
| | DYNAMIC | every button/mode/textarea carries a contract tooltip (260ms) | deck-anchors tooltip test |
| **Transcript tail** | N=0 lines | "(nothing emitted yet — the session just started)" — honest, shown for just-launched + synthetic panels | TranscriptTail.tsx fallback; synthetic-queued test |
| | N=many lines | max-height 120px + internal scroll (dark scrollbar); on-demand only (mock option C), so it costs nothing when closed | app.css `.tail` max-height/overflow; marathon fixture tail |
| | TEXT long | `white-space:pre-wrap` — raw lines wrap, nothing clipped horizontally | app.css `.tail` |
| | DYNAMIC | toggled by View transcript with a pressed state; yields its space back on second click (display:none, timeline reflows) | tail-toggle test both directions |

Cross-cutting SCREEN-sizes rung: the geometry tests run the BUSIEST panel
state (burst expanded + tail open) at 1280×800 and 1440×900 and assert
strict section stacking, zero positive-area overlap, zero clipping.

### S5 fixes / changes to source

1. **Focus return on close (App.tsx)** — was missing (S4 left focus stranded
   on the removed panel). `openerTaskId` ref records the card that opened
   the panel; `closePanel` refocuses it via rAF after unmount; the Escape
   handler now routes through `closePanel` instead of raw `setPanel(null)`
   so all three close paths behave identically. `?panel=` dev-param opens
   have no opener and skip the refocus.
