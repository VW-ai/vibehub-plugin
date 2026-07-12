/**
 * extreme-empty-project — N=0 everywhere: first run, no distillation yet,
 * no tasks, never fetched. The map must show an honest empty state
 * (no fake data), and the app must be fully functional without territories.
 */
import type { MapFixture } from "../types";

export const extremeEmptyProject = {
  capturedAt: "2026-07-12T10:22:00-07:00",
  repo: {
    slug: "acme/greenfield",
    defaultBranch: "main",
    branchCount: 1,
  },
  sync: {
    lastFetchAt: null,
    lastHookEventAt: null,
    stale: true,
  },
  tasks: [],
  territories: [],
  occupancy: [],
  conflicts: [],
} satisfies MapFixture;
