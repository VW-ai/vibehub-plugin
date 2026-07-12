# empty-install — screen notes

## S1 (iter-14) — static first-run experience

File: `static/empty-install-s1.html` (self-contained, v8 tokens verbatim, no network).
Five dev variants (`?v=` or dev bar): `connect` / `installing` / `connected` /
`first-task` / `first-task-200`.

### The three moments

**A — fresh install, repo not connected** (`connect`)
- Titlebar: no repo chip; quiet ink-400 "No repo connected" (hover-explainable).
  No stats, no fresh indicator — nothing is being watched, nothing is claimed.
- Rail: dashed true-empty placeholder ("No tasks yet · Connect a repo to start.").
  No launch button — connect is the screen's ONE primary action (fork logged).
- Canvas: bare grid + centered 420px connect card:
  - "Connect this Mac to your repo" + one subline.
  - Primary CTA (solid ink-900): "Choose repo folder" — clicking it demos the
    installing state (in the app: system folder picker).
  - Three checklist rows (circle icons pre-install) = exactly decision-project-025's
    install: installs hooks for Claude Code / registers the MCP server / creates a
    local database. Each row's tooltip says precisely what is touched.
  - Quiet closing line: "All local — no account, no API key."

**A′ — post-click installing state** (`installing`)
- CTA replaced by the picked repo path: mono, leading-ellipsis truncation
  (direction:rtl + bdi) so the folder tail stays visible; full path in tooltip.
  Fixture path is 92 chars → truncation exercised at both viewports (probe-verified
  `scrollWidth > clientWidth`).
- Rows become mid-install: row 1 check (alive) + mono "done", row 2 pulsing dot +
  "now" — the screen's ONE persistent animation (breathe keyframe) — row 3 pending
  circle at ink-400.
- "Usually a few seconds — all local."

**B — connected, nothing has happened yet** (`connected`)
- Titlebar: repo chip `acme/greenfield main · 1 branch` + "Synced just now".
  Zero-count stats are hidden, not rendered as "0 waiting" noise (fork logged).
- Rail: three group headers collapsed to quiet ink-300 with mono `0`; launch
  button present (per brief).
- Map: ONE full-bleed `.terr.quiet` gray — label `UNCATEGORIZED`, foot
  "this repo hasn't been mapped yet". Centered inside: one guidance sentence
  (ink-500, no lecturing) — "Work normally in your terminal — sessions appear
  here as they happen." — and the quiet secondary "Map this repo" with the
  cost-honesty tooltip (one `claude -p` pass, ~10 min on a big repo, your
  machine/account, nothing blocked while it runs). This is decision-025's ONLY
  user-initiated knowledge action.
- No legend: with a single uncategorized territory the four filters would filter
  nothing (fork logged — legend appears with the first real territories).

**C — first task alive, still unmapped** (`first-task`)
- Rail: "Running 1" + one RUNNING card (4m, w chip + branch chip); other groups
  stay collapsed at 0. Titlebar gains `1 running` + "Synced 12s ago".
- Map: the uncategorized gray stays; a generic soft-green block (fill = write,
  v8 `.terr.w` gradient at sub-block radius) lights the sub-region: task title
  kicker + honest foot "3 files · not yet mapped to features"; tooltip names the
  3 files and the promise (they attach to features once mapped). Perception
  demonstrably precedes distillation — app not gated (025).
- "Map this repo" remains reachable as a compact top-right corner button (fork).

**C at scale** (`first-task-200`)
- A 200-file first session ("Migrate codebase to strict TypeScript", 18m):
  footprint grows to claim most of the gray; foot "200 files · not yet mapped to
  features" renders plain — the app-wide NUMBER-huge rule abbreviates at ≥1000
  ("1.2k" + exact in tooltip), and 200 is below it; the tooltip states the exact
  count and the rule (fork logged).

### Verification (headless, chromium)
- 5 variants × 1280×800 + 1440×900: zero console errors, zero page errors.
- Probes: no horizontal/vertical page overflow; visible `[data-show]` node count
  matches variant; installing path truncation active; footprint fully inside its
  territory (both C variants, both sizes).
- Shots: `notes/shots/empty-install-s1-{connect,installing,connected,first-task,first-task-200}-{1280x800,1440x900}.png`.

### Scale-extremes prelims (full protocol closes by S5)
- **N=0**: this WHOLE screen is the N=0 rung — A/B are the honest empty states;
  nothing fake anywhere (no sample tasks, no placeholder territories).
- **N=1**: Moment C is N=1 by construction; the single card + single footprint
  earn the space (footprint sized by files touched).
- **N=many**: 200-file footprint = the many rung for an unmapped repo; many
  TASKS pre-mapping → multiple footprint blocks in the gray — layout rule needed
  by S3 (open question below).
- **TEXT long**: repo path (leading ellipsis + tooltip); task titles (v8 ellipsis
  rule); footprint kicker + foot both ellipsize; chips clip at v8's 110px + tooltip.
- **NUMBER huge**: file counts follow the one app rule (≥1000 → abbreviate,
  exact in tooltip).
- **SPACE tiny**: footprint foot degrades full → ellipsis (+tooltip); rungs below
  (icon+count, dot) deferred to S2/S4 with the real layout.
- **DYNAMIC**: variants only via dev bar at S1; installing is reachable through
  the real CTA click.
- **SCREEN**: verified 1280×800 + 1440×900, no overlap/clipping.

### Open questions for S2
1. Multiple pre-mapping footprints: how do 2+ session blocks pack inside the
   uncategorized gray (grid? size ∝ files?) — needs a rule before S3 types.
2. Should Moment B's guidance disappear after some time/first event, or only
   when the first footprint replaces it (current design: replaced by C)?
3. Installing → connected transition: does the connect card morph into the map
   (200ms) or hard-swap? S2 should storyboard it.
4. "Map this repo" while a mapping pass runs: what does the button become
   (progress honesty without a persistent spinner — one animation budget)?
5. Does Moment A deserve a keyboard path (autofocus the CTA)? Likely yes at S4.

## S2 (iter-15) — visual polish + open-question resolutions

File: `static/empty-install-s2.html` (S1 frozen for diff). Variants grew 5 → 8:
`connect / installing / install-failed / connected / mapping / first-task /
two-tasks / first-task-200` (dev bar or `?v=`; `?dev=0` hides the dev bar for shots).

### Self-review convergence log
- **Round 1** (16 shots: 8 variants × 1280×800 + 1440×900): **1 defect** —
  the autofocused CTA (Q5 resolution) rendered the browser-default blue focus
  ring; off-system chrome (taste profile: Linear finish; nothing default-styled).
  Fix: the app's own focus language ported from `src/app.css` —
  `button:focus-visible{outline:2px solid rgba(25,27,31,.35);outline-offset:1px}`,
  `:focus:not(:focus-visible){outline:none}` — mouse use stays ring-free.
- **Round 2** (16 shots): **0 new defects**. Converged in 2 rounds.
- **Final** canonical shots re-taken after convergence.
- Every round: zero console/page errors, probes green (no page overflow,
  per-variant `[data-show]` visibility counts, 150-char path truncation active
  (`scrollWidth > clientWidth`), footprints fully inside the territory, no
  footprint overlap, card-centering geometry captured).

### Kernel note adjudicated: connect-card centering (canvas vs full window)
Probe numbers at 1280: card center x = 790 = canvas center; window center = 640
(the card sits 150px right of window center — the "right-heavy" observation is
real). **Chosen: canvas centering.** The balance argument: optical centering is
judged against the *bounded field* the element sits in, and the canvas is a
strongly bounded field — rail border seam on the left, its own grid background,
its own radial highlight. Window-centering would put the card at x=640, i.e.
asymmetric 150px/450px gutters *inside the visible grid field*, which reads as a
mistake against the field even though it "fixes" the window math. The rail is
not blank mass either — it carries the dashed "No tasks yet" placeholder, so the
window's left side has real content weight. Precedent: the conflict card centers
over `.main` because it scrims/blurs the WHOLE main (rail included) into one
uniform underlay first; Moment A's rail is live and unscrimmed, so the same
trick doesn't apply. Fork logged (veto = window centering).

### The 5 S1 open questions — resolved
1. **Multi-footprint packing rule** (needed by S3) — decided + demoed in
   `two-tasks`:
   - `repoFiles` = `git ls-files | wc -l`, a mechanical git fact known the
     moment the repo connects (DB-creation scan). No invented denominator.
   - Footprint **area fraction = clamp(filesTouched / repoFiles, floor, cap)**;
     floor = the S1 N=1 block (24%×26% ≈ 6% of the gray — the smallest block
     whose kicker + foot stay legible at 1280, measured); cap = 60% (the gray
     must visibly remain "the whole repo" while unmapped). Between the rungs the
     block scales from the floor block by sqrt(area ratio) in both dimensions
     (size is a redundant channel — the count TEXT in the foot is the first
     channel, per guideline 6, so sqrt damping is honest).
   - **Shelf packing**: bottom-left origin, launch order (oldest first),
     left→right with 3% gutters, blocks bottom-aligned per shelf; wrap upward to
     a new shelf when the row is full. Overflow ladder (N=many): all blocks
     shrink proportionally down to the floor (temporary shrink of others), and
     once at floor the OLDEST collapse into a "+N earlier sessions" chip pinned
     bottom-right of the gray (collapse-to-+N) — both sanctioned strategies.
   - `two-tasks` fixture: health-check (3 files, floor block, position identical
     to S1's N=1 — the rule degenerates to S1 at N=1) + request tracing
     (120 of ~640 files → sqrt-damped ~18.5% area, 42%×44%, bottom-aligned on
     the same shelf). Probes assert inside-territory + no overlap at both sizes.
2. **Moment B guidance lifetime**: stays until the first footprint replaces it —
   no timer, no first-event heuristic (a timer is a new invisible concept;
   guideline 3). Confirmed as designed in S1.
3. **Installing → connected transition** — storyboarded, no morph:
   - t=0: third row's check lands (mono "done", alive ink) — the user must SEE
     the final state before it leaves;
   - t=400ms (2 × `--t-base`, derived from the motion tokens, not a new magic
     number): card exits via reverse `cardIn` (fade + 8px down, 200ms);
   - t=600ms: connected chrome enters with the existing 200ms entry language —
     repo chip + "Synced just now" (titlebar), rail zero-groups + launch button,
     gray territory + guidance. Single stagger step, both durations from tokens.
   - Morphing the 420px card into the full-bleed territory was rejected:
     spectacle without information (chill/tasteful), and it would smear the one
     moment the checklist must read as "done". Implemented at S4; fork logged.
4. **"Map this repo" while mapping runs** — `mapping` variant: the button yields
   in place to an honest status chip `● Mapping this repo · 2m` (breathe dot =
   that state's ONE persistent animation — motion means something is happening,
   which is literally true; nothing else on B moves). Tooltip: local claude
   reading the repo, started 2m ago, ~10min total, nothing blocked, click stops
   the pass. Click = stop (no dead pixels). Elapsed time in mono, not a spinner,
   not a fake percent — we have no honest progress fraction, so we show the one
   honest number we do have (elapsed).
5. **Moment A keyboard path**: resolved NOW, not deferred — CTA autofocuses, so
   first-run is Enter-to-connect; ring only on `:focus-visible` (the round-1
   defect + fix above). S4 keeps the autofocus on mount.

### Stress additions (this iteration's brief)
- **Two concurrent first tasks** → `two-tasks` (packing rule above); rail shows
  Running 2, titlebar "2 running".
- **150-char repo path** (was 92): `/Users/mirabelle/…/deployment-pipelines-and-
  observability-stack` = exactly 150 chars; leading-ellipsis truncation probe
  green at both sizes; full path in tooltip. Used in `installing` AND
  `install-failed`.
- **Install with one step failed** → `install-failed`, the honest error row:
  - Failure model: steps are independent, so the install DOESN'T stop — hooks
    failed, MCP + DB completed and show "done". Honest partial success, no
    all-or-nothing pretense.
  - The failed row: ✗ icon in `--need` + mono **failed** in `--need-ink` (text
    pill first, color reinforces); label stays ink-700.
  - Reason row beneath (indented to the label): `~/.claude/settings.json` as a
    mono code chip + "isn't writable" + **Retry** button right-aligned into the
    status column. Retry tooltip: reruns ONLY the hooks step, done steps stay
    done. Reason tooltip carries the actual fix (`chmod u+w …`).
  - Footer = consequence honesty: "2 of 3 done. Sessions won't report until
    hooks install." (what the failure MEANS, not just that it happened).
  - No red banner, no modal: the card itself is the surface; one need-ink word
    carries the state.

### Scale-extremes updates (delta over S1 prelims)
- **N=many (tasks pre-mapping)**: rule now defined (shelf → shrink-to-floor →
  +N collapse); `two-tasks` renders the 2-case; the +N rung lands with S3
  fixtures/S5 states.
- **TEXT long**: path stress raised 92 → 150 chars, probe-verified both sizes.
- **DYNAMIC**: mapping state reachable via dev bar/`?v=`; A→A′ still via the
  real CTA click; failed state honest and recoverable (Retry).
- **SPACE tiny**: floor block (24%×26%) IS the defined minimum — below it the
  rule refuses to shrink and collapses to +N instead (rung ladder explicit now).

### Shots
`notes/shots/empty-install-s2-{connect,installing,install-failed,connected,mapping,first-task,two-tasks,first-task-200}-{1280x800,1440x900}.png`
(final; `-r1`/`-r2` review rounds kept alongside — 48 files total).

### Open questions for S3
1. `repoFiles` for the packing denominator: confirm the DB-creation scan stores
   the `git ls-files` count as a first-class fact (types need a field for it).
2. The "+N earlier sessions" chip: exact threshold falls out of the floor rule
   (when shelves can't fit all floors), but the chip's click behavior (expand?
   focus rail?) is an S5 interaction question.
3. `install-failed` for the MCP/DB steps: same row language should generalize —
   S3 types should carry per-step status (`pending|now|done|failed`) + an
   optional failure reason string, not a bespoke hooks-only shape.

## S3 (iter-16) — types + fixtures + packing engine

Files: `src/install-types.ts` (types), `src/install-derive.ts` (packing +
view helpers), `src/fixtures/install-first-run.ts` (the 8 S2 variants as
data), `src/fixtures/install-extremes.ts` (2 extremes), registry
`installFixtures` / `installFixtureByName` in `src/fixtures/index.ts`,
unit tests `src/install-derive.test.ts` (11 — the loop's first pure-logic
vitest surface; vite.config.ts now scopes vitest to `src/**/*.test.ts` so
it never swallows the Playwright specs in `tests/`).

### Checklist
- [x] Types extend `src/types.ts` — Task / ScopeDeclaration / TaskGit /
      RepoInfo / SyncFreshness reused verbatim, zero duplication.
- [x] `RepoConnection` = none | connecting{repoPath, steps} |
      connected{repoPath, repoFiles, mappedAt?: never} — the `never`
      encodes "never-yet mapped" at the type level; widen to `string`
      when distillation ships.
- [x] `InstallStep` is GENERAL (iter-15 note): {id, label, status:
      pending|now|done|failed, failure?:{reason, codeRef, fix?}} — the
      same row language renders a failed MCP or DB step unchanged.
- [x] `UncategorizedFootprint` stores FACTS only (taskId, filesTouched,
      firstSeenAt, sampleFiles?); areaFrac / shelf position / collapse are
      derived by `packFootprints`, never stored.
- [x] `MappingRun` = none | running{startedAt} | done{startedAt,
      finishedAt} — elapsed time is the only number we hold (no progress
      fraction exists, so none is typed).
- [x] Packing engine pure + deterministic; overflow ladder implemented as
      written (shrink-all-together via largest-fitting-g binary search on
      floor↔natural interpolation, never below floor; then collapse OLDEST
      one at a time to the "+N earlier sessions" chip).
- [x] Fixtures: 8 S2 variants byte-faithful on content (same repo, paths,
      titles, ages; capturedAt 2026-07-12T10:22:00-07:00 like the map
      fixtures) + nine-footprints (collapse path: 6 visible + 3 collapsed)
      + tiny-repo (repoFiles=12: cap + near-floor + shrink ladder).
- [x] Gates: tsc --noEmit clean; pnpm build green; Playwright 85/85
      untouched; vitest 11/11 green (first run).

### Type → signal table
| Field | Signal |
|---|---|
| InstallStep.status | installer CLI exit codes (0 ⇒ done, non-zero ⇒ failed) + process liveness (now/pending) |
| InstallStep.failure.reason / codeRef / fix | installer stderr, verbatim — never synthesized |
| RepoConnectionConnecting.repoPath | system folder picker result |
| RepoConnectionConnected.repoFiles | `git ls-files \| wc -l` at connect (DB-creation scan stores it — closes S2 open question 1) |
| RepoConnectionConnected.mappedAt | absent by type (`?: never`) — no mapping pass has ever completed on this screen |
| MappingRun.startedAt / finishedAt | local `claude -p` process start/exit facts |
| UncategorizedFootprint.filesTouched | count of distinct PostToolUse Edit/Write paths matching NO distillation anchor |
| UncategorizedFootprint.firstSeenAt | first such hook event's timestamp |
| UncategorizedFootprint.sampleFiles | first-N of those paths (tooltip detail) |
| Task.* / scopes / git | unchanged from types.ts (hooks, git, gh, MCP declarations) |
| footprint geometry | NOT a signal — pure function of (footprints, repoFiles, insets), install-derive.ts |

### Packing engine (install-derive.ts)
- `footprintDims`: areaFrac = clamp(files/repoFiles, 6.24% floor, 60% cap),
  dims = floor block × sqrt(areaFrac/floorFrac) both axes. Worked example
  reproduced in tests: 120/640 → 41.6% × 45.1% (~18.75% area).
- `packFootprints`: sort oldest-first (firstSeenAt, taskId tiebreak),
  shelf-pack bottom-left origin / 3% gutters / bottom-aligned / wrap up;
  insets measured from S2 (left 6, right 6, top 12, bottom 16 — the S1
  block's left 6 / bottom 84 reproduced exactly; presentation constants,
  tunable at S4). N=1 degenerates to S1's rect exactly (6, 58, 24, 26).
- Helpers: `footprintFootText` (reuses formatCount — ONE number rule),
  `footprintExactFiles`, `collapsedChipText`.

### Deltas vs the S2 hand-drawn statics (S4 must diff/document)
1. **two-tasks x-order**: S2 drew health-check (newer, 4m) at the origin;
   the WRITTEN oldest-first rule puts request-tracing (11m) there. Dims
   match S2 (~42×45 vs drawn 42×44; floor 24×26 exact); the two blocks
   swap x-positions. Rule wins over the hand demo (fork logged).
2. **first-task-200**: derived 53.7×58.2 (200/640 = 31.25% area) vs S2's
   hand-drawn 58×58 (33.6%). Same "claims most of the gray" read.

### Open questions for S4
1. The "+N earlier sessions" chip: reserve space in the packing region or
   overlay bottom-right of the gray? (Overlay risks covering a block's
   foot on full shelves.) Chip click behavior is the S5 question already
   logged at S2.
2. Should the connect card's pre-click checklist render from
   PRISTINE_INSTALL_STEPS (data) or stay chrome copy? (S3 exports the
   constant; S4 decides the wiring.)
3. Greedy shelf fit is not strictly monotone in the shrink factor g
   (wrap decisions flip); binary search converges on a fitting g but not
   provably THE largest. Invariants (bounds, no overlap, ≥floor) hold by
   construction — revisit only if a real layout ever looks starved.

## S4 (iter-17) — first-run states dynamized

Files: `src/components/InstallScreen.tsx` (the App's connection-state layer:
titlebar/rail/canvas per RepoConnection state + the demo transition machine),
`src/components/ConnectCard.tsx` (Moments A/A′/A″ card),
`src/components/InstallChecklist.tsx` (step rows from InstallStep[], incl.
failed + Retry), `src/components/App.tsx` (+`initialInstall`, early-return
install layer ABOVE the map render path — map path untouched), `src/main.tsx`
(+`?install=`), `src/app.css` (install section, S2 values verbatim),
`tests/install-parity.spec.ts` (16 parity shots + 10 smoke + probes +
transition + retry + fall-through).

### Checklist
- [x] Connection-state layer above the map: `?install=<name>` (all 10
      fixtures) renders `InstallScreen` INSTEAD of the map; unknown names
      fall through to the map (probe-tested). State routing is data-implied:
      none → ConnectCard; connecting → ConnectCard + InstallChecklist
      (statuses/failure verbatim from the fixture); connected → titlebar repo
      chip + zero-groups rail + launch + full-bleed UNCATEGORIZED gray.
- [x] Footprints via `packFootprints` (never hand-placed); kicker = task
      title, foot = `footprintFootText`, tooltip = exact count + sampleFiles.
      `+N earlier sessions` chip renders on the nine-footprints extreme.
- [x] MappingRun chip: `mapping` fixture renders `● Mapping this repo · 2m`
      (elapsed = relAge(startedAt, capturedAt), mono, no percent); "Map this
      repo" click yields to the chip via a LOCAL MappingRun override; chip
      click stops the pass (both directions probe-tested). Corner variants on
      Moment C.
- [x] Storyboarded hard swap behind the demo CTA path ONLY (direct
      `?install=` loads stay static for shots): CTA/Enter → `installing`
      fixture → steps advance (900ms demo pacing, tunable, non-product) →
      last check lands → hold 400ms (2×--t-base) → card exits (reverse
      cardIn, 200ms) → swap → connected chrome enters (chromeIn 200ms,
      one stagger step, `.first-run.enter` scoped so shots are unaffected).
      Retry runs ONLY the failed step (done rows stay done, probe-asserted),
      then completes into the same storyboard.
- [x] Moment A keyboard path: CTA autofocuses; Enter-to-connect asserted.
- [x] Components consume fixtures via install-types only; TaskCard reused
      verbatim (minimal MapFixture join, territories deliberately empty);
      Tooltip + tokens reused; global [hidden] guard already app-wide.
- [x] Gates: tsc clean · build green · Playwright FULL 103/103 (85 + 18 new)
      · vitest 11/11.

### Parity vs S2 static (16 shots: 8 variants × 1280×800 + 1440×900)
Shots `notes/shots/empty-install-s4-*-{1280x800,1440x900}.png` next to the S2
canonicals. connect / installing / install-failed / connected / mapping /
first-task read pixel-equivalent (same tokens, same geometry; first-task's
floor block reproduces S1/S2's 6/58/24/26 EXACTLY — asserted on the style
attr). The two KNOWN S3 deltas are asserted in the spec, not just tolerated:
1. **two-tasks x-order** — request-tracing (11m, older) at the bottom-left
   origin, health-check to its right; the WRITTEN oldest-first rule outvotes
   the S2 hand placement (iter-16 fork). Dims match (~41.6×45.1 vs drawn
   42×44; floor exact).
2. **first-task-200 dims** — derived 53.7×58.2 (200/640 = 31.25% area,
   sqrt-damped) vs hand-drawn 58×58. Same "claims most of the gray" read.

Other (minor, text/behavior-level) deltas, each deliberate:
- "Synced just now": derive.ts's freshness would say "Synced 0s ago";
  the install screen keeps S2's copy with a local <1s rung (map derive
  untouched — v8 parity values never hit 0s).
- Tooltip wording is now COMPOSED from fixture data (step tips keyed by
  id×status; footprint tips from sampleFiles; failure tips from
  reason/codeRef/fix) — a few clauses differ from S2's hand-written prose
  (e.g. the 200-file tooltip states the exact count without the abbreviation
  lecture; scope-chip tips say "· 3 files touched" instead of "not yet mapped
  to a feature"). Visual surfaces are byte-matched; tooltips are not shots.
- The install screen mounts with the app's standard entry language (winIn,
  terrIn, rise) where the static appeared instantly — invisible in settled
  shots.

### Defect found + fixed during parity review (the collision bug class again)
The task panel owns bare `.files{display:none; font-family:var(--mono)}`
(collapsed file-change entry) — it swallowed the footprint foot entirely,
then rendered it mono once display was restored. Fix: `.fp .files` carries
explicit `display:block; font-family:var(--sans)` with a load-bearing
comment; spec asserts `toBeVisible()` (hidden text still satisfies
`toHaveText` — that's how it slipped). Same class as the `.sub`/`.subnote`
collisions; `@keyframes breathe` renamed `breathe-soft` for the install dots
(map's clash counter owns `breathe` at .82 amplitude; S2's install dots are
.4) — collision avoided at authoring time.

### S4 open questions → resolved this iteration
1. **+N chip placement**: overlaid bottom-right of the gray, pinned ABOVE the
   territory foot line (right sp-4 / bottom sp-6) — reserving packing space
   would shrink live blocks for metadata. Fork logged; click behavior stays
   the S5 question.
2. **Pristine checklist source**: renders from `PRISTINE_INSTALL_STEPS`
   (data) — one row component serves every status. Fork logged.
3. Binary-search monotonicity caveat: unchanged, no layout looked starved.

### Open items for S5 (interactions + states)
- Rail card click → task panel on the first-run screen (no-op today; cards
  are hover-explainable). Correlate-hover card↔footprint.
- `+N earlier sessions` chip click (expand? focus rail?) — logged at S2.
- Footprint keyboard focusability (tab → tooltip parity).
- Local mapping override's elapsed time is frozen at "0s" (capturedAt is the
  demo clock); decide whether the demo ticks.
- Scale-extremes protocol: close the full per-component evidence table.
