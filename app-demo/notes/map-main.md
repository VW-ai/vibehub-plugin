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

## Next stage: S4 (dynamize)

- Build React map component + rail from `v8-baseline`, screenshot-parity vs v8.
- Will need `@types/react` + `@types/react-dom` (see DECISIONS-NEEDED entry).
- Reconcile sub-block px offsets with v8.
