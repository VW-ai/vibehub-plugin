# task-panel — screen notes

S1 artifact: `workbench/app-demo/static/task-panel-s1.html` (self-contained, no
network, opens from `file://`). Screenshots: `notes/shots/task-panel-s1-1280.png`,
`-1440.png`, `-1280-expanded.png` (files entry open + transcript tail shown).

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

## Open questions for S2

1. Panel top: should identity get a subtle paper-tint band vs. flat white, to
   separate from timeline without a border? (Currently 1px ink-150 line —
   v8 uses hairlines in the titlebar, so it's on-system, but "shadows not
   borders" may want a shadow seam instead.)
2. WAITING pill placement — before the title (current, matches rail cards) or
   after? Long titles push the age right; check with a 2-line-worthy title.
3. Should the "Stopped to ask you" entry carry its own inline "Answer" affordance
   that focuses the textarea, or is the pinned deck affordance enough?
4. Cross-read notice: dot uses read-outline (new dot variant). Keep, or reuse a
   plain gray dot and let the text carry it?
5. Scrim strength .18 — screenshot check against map legibility; maybe .22.
6. Mode toggle copy length ("Inject without interrupting") is near the seg
   control's comfortable max — revisit if a third mode ever appears.
