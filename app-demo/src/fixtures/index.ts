/**
 * Fixture registry for the map screen.
 * - v8Baseline: the frozen approved reference content (default demo data).
 * - extreme*: SCALE-EXTREMES PROTOCOL fixtures (LOOP.md) — these must all
 *   render without breakage before any screen exits S5.
 */
import type { MapFixture, Task } from "../types";
import type { TaskPanelFixture } from "../panel-types";
import type { ConflictCardFixture } from "../conflict-types";
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

export { v8Baseline, extremeEmptyProject, extremeScopeOverload, extremeFortyTerritories };
export { panelRefactorAuth, panelJustLaunched, panelMarathon, panelQuietMilestones };
export {
  conflictOsmRedDiagnosed,
  conflictNoDiagnosis,
  conflictYellowStale,
  conflictExtreme1200Symbols,
  conflictExtremeOneSymbol,
};

export const fixtures: Record<string, MapFixture> = {
  "v8-baseline": v8Baseline,
  "empty-project": extremeEmptyProject,
  "scope-overload": extremeScopeOverload,
  "forty-territories": extremeFortyTerritories,
};

/**
 * Task-panel fixtures (m2, S3). "panel-refactor-auth" = the approved S2
 * static's content, verbatim; the rest are SCALE-EXTREMES fixtures.
 */
export const panelFixtures: Record<string, TaskPanelFixture> = {
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
export const conflictFixtures: Record<string, ConflictCardFixture> = {
  "conflict-osm-red-diagnosed": conflictOsmRedDiagnosed,
  "conflict-no-diagnosis": conflictNoDiagnosis,
  "conflict-yellow-stale": conflictYellowStale,
  "conflict-1200-symbols": conflictExtreme1200Symbols,
  "conflict-one-symbol": conflictExtremeOneSymbol,
};

/** `?conflict=` dev param (S4): accepts the full key or the short tail. */
export function conflictFixtureByName(name: string): ConflictCardFixture | null {
  return conflictFixtures[name] ?? conflictFixtures[`conflict-${name}`] ?? null;
}

/**
 * Map card → panel wiring (S4). Tasks with a hand-authored panel fixture
 * open it; every other card opens a minimal synthetic panel (launch + state
 * transition only — see synthetic-panel.ts for the honesty rules).
 */
const PANEL_BY_TASK_ID: Record<string, TaskPanelFixture> = {
  "task-refactor-auth": panelRefactorAuth,
};

export function panelForTask(task: Task, map: MapFixture): TaskPanelFixture {
  return PANEL_BY_TASK_ID[task.id] ?? syntheticPanel(task, map);
}

/** `?panel=` dev param: accepts "panel-marathon" or the short "marathon". */
export function panelFixtureByName(name: string): TaskPanelFixture | null {
  return panelFixtures[name] ?? panelFixtures[`panel-${name}`] ?? null;
}
