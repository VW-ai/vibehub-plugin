# conflict-card — screen notes

Stage: **S1 done** (static HTML at `static/conflict-card-s1.html`).
Variants: `?v=` param or the DEV bar — `""` red W×W diagnosed · `empty` red, diagnosis
not yet run · `yellow` W×R, 12 shared symbols, long task names.

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

## Scale-extremes — preliminary answers (must be closed with evidence by S5)

- N=0: a conflict card cannot exist with zero shared symbols (intersection IS the
  trigger); zero conflicts = no card, entry points don't render. Diagnosis N=0 = the
  dashed empty state (shown, honest).
- N=1: one shared symbol — list renders one row, no toggle; layout holds (rows are
  independent). Needs a fixture case by S3.
- N=many: 12 symbols → 3 + "+9 more" expandable (verified); expanded card grows,
  .cbody is the only scroll region, header/grade/footer pinned. 100 symbols → same
  ladder, body scrolls. Exactly two tasks by type (`taskIds: [string, string]`) —
  the "Between" zone never scales.
- TEXT long: task names (yellow variant, verified), symbol names (61-char name,
  verified), resource names, branch chips — all single-line ellipsis + full-text
  tooltip. Verdict text wraps (never truncates — it's the payload).
- NUMBER huge: symbol count in the h4 is mono raw (12); >999 would abbreviate + exact
  in tooltip — no such fixture yet, decide at S3.
- SPACE tiny: modal is fixed 640px, min viewport 1280 — no degradation ladder needed
  beyond chip truncation; at 1280×800 red-diagnosed body scrolls ~20px (footer pinned,
  verified via geometry probe).
- DYNAMIC: +N expand yields space back on "show less"; pause menu closes on outside
  click/Escape; empty→completed diagnosis is a state swap in one DOM slot.
- SCREENS: 1280×800 + 1440×900 both verified, no overlap/clipping.

## Open questions for S2

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

## S1 verify log

- 5 shots, 3 variants × 2 viewports (subset), zero console errors, zero pageerrors,
  modal-inside-main geometry probe green on all runs.
