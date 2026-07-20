/**
 * Fixture registry for the map screen.
 * - v8Baseline: the frozen approved reference content (default demo data).
 * - extreme*: SCALE-EXTREMES PROTOCOL fixtures (LOOP.md) — these must all
 *   render without breakage before any screen exits S5.
 */
import type { MapSnapshot, Task } from "@vibehub/core/contracts";
import type { TaskPanelSnapshot } from "@vibehub/core/contracts";
import type { ConflictCardSnapshot } from "@vibehub/core/contracts";
import type { InstallSnapshot } from "@vibehub/core/contracts";
import { syntheticPanel } from "./synthetic-panel";
import { v8Baseline } from "./v8-baseline";
import { extremeEmptyProject } from "./extreme-empty-project";
import { extremeScopeOverload } from "./extreme-scope-overload";
import { extremeFortyTerritories } from "./extreme-forty-territories";
import { panelRefactorAuth } from "./panel-refactor-auth";
import { panelJustLaunched } from "./panel-just-launched";
import { panelMarathon } from "./panel-marathon";
import { panelQuietMilestones } from "./panel-quiet-milestones";
import { conflictOsmRedDiagnosed, conflictNoDiagnosis } from "./conflict-osm-red";
import { conflictYellowStale } from "./conflict-yellow-stale";
import {
  conflictExtreme1200Symbols,
  conflictExtremeOneSymbol,
} from "./conflict-extremes";
import {
  installConnect,
  installInstalling,
  installFailed,
  installConnected,
  installMapping,
  installFirstTask,
  installTwoTasks,
  installFirstTask200,
} from "./install-first-run";
import { installNineFootprints, installTinyRepo } from "./install-extremes";
import {
  menubarQuiet,
  menubarStale,
  menubarOverload,
  menubarFlood,
} from "./menubar-extremes";

export { v8Baseline, extremeEmptyProject, extremeScopeOverload, extremeFortyTerritories };
export { panelRefactorAuth, panelJustLaunched, panelMarathon, panelQuietMilestones };
export {
  conflictOsmRedDiagnosed,
  conflictNoDiagnosis,
  conflictYellowStale,
  conflictExtreme1200Symbols,
  conflictExtremeOneSymbol,
};
export {
  installConnect,
  installInstalling,
  installFailed,
  installConnected,
  installMapping,
  installFirstTask,
  installTwoTasks,
  installFirstTask200,
  installNineFootprints,
  installTinyRepo,
};

export const fixtures: Record<string, MapSnapshot> = {
  "v8-baseline": v8Baseline,
  "empty-project": extremeEmptyProject,
  "scope-overload": extremeScopeOverload,
  "forty-territories": extremeFortyTerritories,
};

/**
 * Task-panel fixtures (m2, S3). "panel-refactor-auth" = the approved S2
 * static's content, verbatim; the rest are SCALE-EXTREMES fixtures.
 */
export const panelFixtures: Record<string, TaskPanelSnapshot> = {
  "panel-refactor-auth": panelRefactorAuth,
  "panel-just-launched": panelJustLaunched,
  "panel-marathon": panelMarathon,
  "panel-quiet-milestones": panelQuietMilestones,
};

/**
 * Conflict-card fixtures (m3, S3). "conflict-osm-red-diagnosed" +
 * "conflict-yellow-stale" carry the approved S2 static's content verbatim
 * (`?v=` / `?v=yellow`); "conflict-no-diagnosis" = the `?v=empty` variant;
 * the rest are SCALE-EXTREMES fixtures (1200 symbols / N=1).
 */
export const conflictFixtures: Record<string, ConflictCardSnapshot> = {
  "conflict-osm-red-diagnosed": conflictOsmRedDiagnosed,
  "conflict-no-diagnosis": conflictNoDiagnosis,
  "conflict-yellow-stale": conflictYellowStale,
  "conflict-1200-symbols": conflictExtreme1200Symbols,
  "conflict-one-symbol": conflictExtremeOneSymbol,
};

/** `?conflict=` dev param (S4): accepts the full key or the short tail. */
export function conflictFixtureByName(name: string): ConflictCardSnapshot | null {
  return conflictFixtures[name] ?? conflictFixtures[`conflict-${name}`] ?? null;
}

/**
 * Map conflict → card wiring (S4). The card fixtures reuse the map's
 * conflict ids ON PURPOSE (iter-11 fork) so all three open paths — sub-block
 * chip, rail CONFLICT pill, titlebar conflict stat — route by id. A conflict
 * with no authored card returns null: the card's symbol evidence (per-side
 * touch times) cannot be honestly synthesized from a MapSnapshot, so the
 * opener falls back to the task panel instead (fork logged iter-12).
 */
const CONFLICT_CARD_BY_CONFLICT_ID: Record<string, ConflictCardSnapshot> = {
  "conflict-osm": conflictOsmRedDiagnosed,
  "conflict-templates": conflictYellowStale,
  "conflict-generated-client": conflictExtreme1200Symbols,
  "conflict-flag-defaults": conflictExtremeOneSymbol,
};

export function conflictCardForConflict(conflictId: string): ConflictCardSnapshot | null {
  return CONFLICT_CARD_BY_CONFLICT_ID[conflictId] ?? null;
}

/**
 * Map card → panel wiring (S4). Tasks with a hand-authored panel fixture
 * open it; every other card opens a minimal synthetic panel (launch + state
 * transition only — see synthetic-panel.ts for the honesty rules).
 */
const PANEL_BY_TASK_ID: Record<string, TaskPanelSnapshot> = {
  "task-refactor-auth": panelRefactorAuth,
};

export function panelForTask(task: Task, map: MapSnapshot): TaskPanelSnapshot {
  return PANEL_BY_TASK_ID[task.id] ?? syntheticPanel(task, map);
}

/** `?panel=` dev param: accepts "panel-marathon" or the short "marathon". */
export function panelFixtureByName(name: string): TaskPanelSnapshot | null {
  return panelFixtures[name] ?? panelFixtures[`panel-${name}`] ?? null;
}

/**
 * First-run fixtures (m4, S3). The 8 keys mirror the S2 static's `?v=`
 * variants exactly; "nine-footprints" + "tiny-repo" are SCALE-EXTREMES
 * fixtures (overflow collapse path / cap + near-floor + shrink ladder).
 */
export const installFixtures: Record<string, InstallSnapshot> = {
  connect: installConnect,
  installing: installInstalling,
  "install-failed": installFailed,
  connected: installConnected,
  mapping: installMapping,
  "first-task": installFirstTask,
  "two-tasks": installTwoTasks,
  "first-task-200": installFirstTask200,
  "nine-footprints": installNineFootprints,
  "tiny-repo": installTinyRepo,
};

/** `?install=` dev param (S4): accepts the S2 variant names verbatim. */
export function installFixtureByName(name: string): InstallSnapshot | null {
  return installFixtures[name] ?? null;
}

export { menubarQuiet, menubarStale, menubarOverload, menubarFlood };
export { identityRecoveryLiveShell, liveShellBaseline, mappedPartialLiveShell, unavailableLiveShell } from "./live-shell";

/**
 * Menubar-route fixtures (m5, S4) — plain MapSnapshots keyed by the approved
 * S1 variant names. `busy` IS the shared v8Baseline (one source of truth for
 * the default demo data); the others live in menubar-extremes.ts. They are
 * NOT in the map `fixtures` registry: the menubar reads counts/names only,
 * so their occupancy/geometry is deliberately not map-grade.
 */
export const menubarFixtures: Record<string, MapSnapshot> = {
  busy: v8Baseline,
  quiet: menubarQuiet,
  stale: menubarStale,
  overload: menubarOverload,
  flood: menubarFlood,
};

/** `?menubar=` dev param: variant name, or the bare flag `1` → busy. */
export function menubarFixtureByName(name: string): MapSnapshot | null {
  if (name === "1") return menubarFixtures["busy"] ?? null;
  return menubarFixtures[name] ?? null;
}
