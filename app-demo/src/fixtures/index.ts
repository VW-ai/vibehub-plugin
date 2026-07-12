/**
 * Fixture registry for the map screen.
 * - v8Baseline: the frozen approved reference content (default demo data).
 * - extreme*: SCALE-EXTREMES PROTOCOL fixtures (LOOP.md) — these must all
 *   render without breakage before any screen exits S5.
 */
import type { MapFixture } from "../types";
import { v8Baseline } from "./v8-baseline";
import { extremeEmptyProject } from "./extreme-empty-project";
import { extremeScopeOverload } from "./extreme-scope-overload";
import { extremeFortyTerritories } from "./extreme-forty-territories";

export { v8Baseline, extremeEmptyProject, extremeScopeOverload, extremeFortyTerritories };

export const fixtures: Record<string, MapFixture> = {
  "v8-baseline": v8Baseline,
  "empty-project": extremeEmptyProject,
  "scope-overload": extremeScopeOverload,
  "forty-territories": extremeFortyTerritories,
};
