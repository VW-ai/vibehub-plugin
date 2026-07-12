/**
 * Fixture registry for the map screen.
 * - v8Baseline: the frozen approved reference content (default demo data).
 * - extreme*: SCALE-EXTREMES PROTOCOL fixtures (LOOP.md) — these must all
 *   render without breakage before any screen exits S5.
 */
import type { MapFixture } from "../types";
import type { TaskPanelFixture } from "../panel-types";
import { v8Baseline } from "./v8-baseline";
import { extremeEmptyProject } from "./extreme-empty-project";
import { extremeScopeOverload } from "./extreme-scope-overload";
import { extremeFortyTerritories } from "./extreme-forty-territories";
import { panelRefactorAuth } from "./panel-refactor-auth";
import { panelJustLaunched } from "./panel-just-launched";
import { panelMarathon } from "./panel-marathon";
import { panelQuietMilestones } from "./panel-quiet-milestones";

export { v8Baseline, extremeEmptyProject, extremeScopeOverload, extremeFortyTerritories };
export { panelRefactorAuth, panelJustLaunched, panelMarathon, panelQuietMilestones };

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
