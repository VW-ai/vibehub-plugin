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
