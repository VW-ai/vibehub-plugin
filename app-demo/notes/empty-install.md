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
