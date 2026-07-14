/**
 * extreme-forty-territories — N=many on the canvas: 40 territories in an
 * 8×5 grid. Forces the map's density strategy (zoom levels / label
 * degradation ladder: full → abbreviated → icon+count → dot only).
 * Small rects with long names also exercise the SPACE-tiny rung.
 * Includes one task in each of the five states so the state grouping in the
 * rail renders fully populated at this density.
 */
import type { MapSnapshot, Task, Territory, TerritoryOccupancy } from "@vibehub/core/contracts";

const NAMES = [
  "Auth & Sessions", "Payments & Orders", "Storage Layer", "Notifications",
  "Build & CI", "Web UI", "Search Indexing", "Feature Flags",
  "Rate Limiting", "Audit Log", "Email Templates", "Webhooks",
  "GraphQL Gateway", "Mobile Bridge", "Analytics Pipeline", "A/B Experiments",
  "Internationalization & Locale Negotiation", "Media Transcoding", "PDF Rendering", "Import / Export",
  "Permissions & Roles", "Organization Billing", "Usage Metering", "Realtime Presence",
  "Cache Invalidation", "Background Jobs", "Scheduler", "Secrets Management",
  "Observability", "Error Tracking", "Design Tokens", "Component Library",
  "Legacy Admin Panel Compatibility Layer", "Data Warehouse Sync", "Customer Support Tools", "Onboarding Flows",
  "API Versioning", "SDK Codegen", "Documentation Site", "Infra & Deploy",
];

const COLS = 8; // 8 cols × 5 rows = 40

const territories: Territory[] = NAMES.map((name, i) => {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  return {
    id: `g-${i}`,
    name,
    anchoredFileCount: 3 + ((i * 7) % 60),
    subBlocks: [],
    layout: {
      left: 1.5 + col * 12.2,
      top: 2 + row * 19.4,
      width: 11.4,
      height: 17.8,
    },
  };
});

const tasks: Task[] = [
  {
    id: "g-task-queued",
    title: "Add SDK codegen for Ruby",
    state: "queued",
    signalTier: "hooks",
    conflictIds: [],
    scopes: [{ mode: "write", territoryId: "g-37", label: "sdk-codegen" }],
    git: { branch: "vibehub/sdk-codegen-ruby" },
    stateSince: "2026-07-12T10:00:00-07:00",
    lastEventAt: "2026-07-12T10:00:00-07:00",
  },
  {
    id: "g-task-running",
    title: "Backfill usage metering events",
    state: "running",
    signalTier: "hooks",
    conflictIds: [],
    scopes: [
      { mode: "write", territoryId: "g-22", label: "metering", filesTouched: 4 },
      { mode: "read", territoryId: "g-34", label: "warehouse" },
    ],
    git: { branch: "vibehub/backfill-usage-metering" },
    stateSince: "2026-07-12T09:48:00-07:00",
    lastEventAt: "2026-07-12T10:21:30-07:00",
    statusDetail: "Agent actively producing — tool calls and edits flowing.",
  },
  {
    id: "g-task-waiting",
    title: "Rotate webhook signing secrets",
    state: "waiting",
    signalTier: "hooks",
    conflictIds: [],
    scopes: [
      { mode: "write", territoryId: "g-11", label: "webhooks", filesTouched: 2 },
      { mode: "read", territoryId: "g-27", label: "secrets" },
    ],
    git: { branch: "vibehub/rotate-webhook-secrets" },
    stateSince: "2026-07-12T10:07:00-07:00",
    lastEventAt: "2026-07-12T10:07:00-07:00",
    statusDetail: "Asked whether to revoke the old secrets immediately.",
  },
  {
    id: "g-task-stalled",
    title: "Speed up cache invalidation fanout",
    state: "stalled",
    signalTier: "basic",
    conflictIds: [],
    scopes: [{ mode: "write", territoryId: "g-24", label: "cache" }],
    git: { branch: "vibehub/cache-fanout-perf" },
    stateSince: "2026-07-12T10:11:00-07:00",
    lastEventAt: "2026-07-12T10:11:00-07:00",
  },
  {
    id: "g-task-done",
    title: "Fix locale fallback chain",
    state: "done",
    signalTier: "hooks",
    conflictIds: [],
    scopes: [{ mode: "write", territoryId: "g-16", label: "i18n" }],
    git: {
      branch: "vibehub/fix-locale-fallback",
      prNumber: 812,
      prState: "merged",
    },
    stateSince: "2026-07-12T08:55:00-07:00",
    lastEventAt: "2026-07-12T08:55:00-07:00",
    statusDetail: "PR #812 merged 08:55 — auto-closed.",
  },
];

const occupied: Record<string, Partial<TerritoryOccupancy>> = {
  "g-37": { writingTaskIds: ["g-task-queued"] },
  "g-22": { writingTaskIds: ["g-task-running"] },
  "g-34": { readingTaskIds: ["g-task-running"] },
  "g-11": { writingTaskIds: ["g-task-waiting"] },
  "g-27": { readingTaskIds: ["g-task-waiting"] },
  "g-24": { writingTaskIds: ["g-task-stalled"] },
  "g-16": { doneTodayTaskIds: ["g-task-done"] },
};

const occupancy: TerritoryOccupancy[] = territories.map((t) => ({
  territoryId: t.id,
  writingTaskIds: occupied[t.id]?.writingTaskIds ?? [],
  readingTaskIds: occupied[t.id]?.readingTaskIds ?? [],
  doneTodayTaskIds: occupied[t.id]?.doneTodayTaskIds ?? [],
}));

export const extremeFortyTerritories = {
  capturedAt: "2026-07-12T10:22:00-07:00",
  repo: {
    slug: "acme/everything-app",
    defaultBranch: "main",
    branchCount: 58,
  },
  sync: {
    lastFetchAt: "2026-07-12T10:19:00-07:00",
    lastHookEventAt: "2026-07-12T10:21:30-07:00",
    stale: false,
  },
  tasks,
  territories,
  occupancy,
  conflicts: [],
} satisfies MapSnapshot;

// grid sanity: the whole point of this fixture is exactly 40 territories
if (territories.length !== 40) {
  throw new Error(`extreme-forty-territories: expected 40, got ${territories.length}`);
}
