/**
 * Menubar-route fixtures (m5, S4) — plain MapSnapshots reached only via
 * `?menubar=` (registry: menubarFixtures in fixtures/index.ts). busy = the
 * shared v8Baseline; these four carry the other approved S1 variants AS DATA:
 *
 *   quiet    — 0 waiting / 0 conflicts / 3 running, synced 18s ago
 *   stale    — v8Baseline content, but last fetch 47m ago (sync.stale)
 *   overload — 12 waiting (top ages 52m/47m/41m) + 5 running, no conflicts
 *   flood    — 143 waiting + 2 conflicts + 31 running (badge 99+ cap,
 *              needs-you 145, "and 142 more…" with a conflict hidden)
 *
 * They reuse v8Baseline's territories verbatim (the menubar reads territory/
 * sub-block NAMES for conflict subjects; geometry is irrelevant here) and
 * leave `occupancy` empty — the map screen never renders these fixtures.
 * Generated tasks are fully deterministic (index-derived ages/titles).
 */
import type { Conflict, MapSnapshot, Task } from "@vibehub/core/contracts";
import { v8Baseline } from "./v8-baseline";

/** Same demo "now" as the map, so every age is deterministic. */
const CAPTURED_AT = "2026-07-12T10:22:00-07:00";
const CAP_MS = Date.parse(CAPTURED_AT);

const minsAgo = (min: number) => new Date(CAP_MS - Math.round(min * 60_000)).toISOString();
const secsAgo = (s: number) => new Date(CAP_MS - s * 1000).toISOString();

/* ── task factories (menubar-relevant fields honest, scopes minimal) ────── */

function waitingTask(
  id: string,
  title: string,
  waitingMin: number,
  statusDetail: string,
): Task {
  return {
    id,
    title,
    state: "waiting",
    signalTier: "hooks",
    conflictIds: [],
    scopes: [],
    git: { branch: `vibehub/${id}` },
    stateSince: minsAgo(waitingMin),
    lastEventAt: minsAgo(waitingMin),
    statusDetail,
  };
}

function runningTask(id: string, title: string, runningMin: number): Task {
  return {
    id,
    title,
    state: "running",
    signalTier: "hooks",
    conflictIds: [],
    scopes: [],
    git: { branch: `vibehub/${id}` },
    stateSince: minsAgo(runningMin),
    lastEventAt: secsAgo(20),
    statusDetail: "Agent actively producing — tool calls and edits flowing.",
  };
}

/* ── quiet: nothing needs you, three sessions running ───────────────────── */

export const menubarQuiet = {
  capturedAt: CAPTURED_AT,
  repo: v8Baseline.repo,
  sync: {
    lastFetchAt: secsAgo(18),
    lastHookEventAt: secsAgo(6),
    stale: false,
  },
  tasks: [
    runningTask("task-webhook-rate-limit", "Add rate limiting to webhook intake", 34),
    runningTask("task-anchor-backfill", "Backfill territory anchors for docs pages", 19),
    runningTask("task-sse-backoff", "Wire SSE reconnect backoff", 7),
  ],
  territories: v8Baseline.territories,
  occupancy: [],
  conflicts: [],
} satisfies MapSnapshot;

/* ── stale: v8 content, repo data 47m old (decision-github-002) ─────────── */

export const menubarStale = {
  ...v8Baseline,
  capturedAt: CAPTURED_AT,
  sync: {
    lastFetchAt: minsAgo(47),
    lastHookEventAt: v8Baseline.sync.lastHookEventAt,
    stale: true,
  },
} satisfies MapSnapshot;

/* ── overload: 12 waiting, 5 running, no conflicts ──────────────────────── */

const OVERLOAD_FILLER: [string, number][] = [
  ["Dedupe retry events in the hook ingest queue", 38],
  ["Add worktree cleanup to the session teardown path", 33],
  ["Port the anchor differ to the new merge-tree output", 29],
  ["Tighten CSP headers on the dashboard routes", 24],
  ["Migrate feature flags to typed config", 20],
  ["Add per-territory anchor counts to the distill report", 16],
  ["Cache gh PR queries between fetch cycles", 12],
  ["Fix flaky SSE reconnect e2e test", 9],
  ["Update onboarding copy for the hooks installer", 5],
];

export const menubarOverload = {
  capturedAt: CAPTURED_AT,
  repo: v8Baseline.repo,
  sync: {
    lastFetchAt: secsAgo(42),
    lastHookEventAt: secsAgo(11),
    stale: false,
  },
  tasks: [
    waitingTask(
      "task-reconcile-ledger",
      "Reconcile invoice line items against the payments ledger export",
      52,
      "Stopped to ask which ledger column is authoritative.",
    ),
    waitingTask(
      "task-rename-osm",
      "Rename OrderStateMachine transitions to match the new lifecycle spec",
      47,
      "Stopped to confirm the deprecation window.",
    ),
    waitingTask(
      "task-refactor-auth",
      "Refactor auth flow",
      41,
      "Asked which session-expiry policy to use. Parked until you answer.",
    ),
    ...OVERLOAD_FILLER.map(([title, min], i) =>
      waitingTask(`task-ov-wait-${i}`, title, min, "Stopped and asked a question."),
    ),
    ...Array.from({ length: 5 }, (_, i) =>
      runningTask(`task-ov-run-${i}`, `Sweep deprecated API usages — batch ${i + 1}`, 25 - i * 4),
    ),
  ],
  territories: v8Baseline.territories,
  occupancy: [],
  conflicts: [],
} satisfies MapSnapshot;

/* ── flood: 143 waiting, 2 conflicts, 31 running — the 99+ cap path ─────── */

const FLOOD_VERBS = [
  "Backfill",
  "Migrate",
  "Refactor",
  "Instrument",
  "Harden",
  "Document",
  "Deflake",
];
const FLOOD_AREAS = [
  "payments reconciliation exports",
  "auth session storage",
  "webhook retry queues",
  "anchor clustering pass",
  "PR status polling",
  "notification digests",
  "worktree bookkeeping",
  "hook event ingestion",
  "territory layout snapshots",
  "CI cache priming",
  "SSE fan-out buffers",
];

/** 141 deterministic filler waiting tasks, ages 56m → ~14m (all < 58m). */
const floodWaitingFiller: Task[] = Array.from({ length: 141 }, (_, i) =>
  waitingTask(
    `task-fl-wait-${i}`,
    `${FLOOD_VERBS[i % FLOOD_VERBS.length]} ${FLOOD_AREAS[i % FLOOD_AREAS.length]} — pass ${Math.floor(i / FLOOD_AREAS.length) + 1}`,
    56 - i * 0.3,
    "Stopped and asked a question.",
  ),
);

const floodConflictTasks: Task[] = [
  {
    ...runningTask("task-fl-retry-payments", "Auto-retry failed payments", 88),
    conflictIds: ["conflict-fl-osm"],
  },
  {
    ...runningTask("task-fl-cancel-orders", "Cancel orders on timeout", 75),
    conflictIds: ["conflict-fl-osm"],
  },
  {
    ...runningTask("task-fl-digest-batch", "Batch notification digests hourly", 44),
    conflictIds: ["conflict-fl-notify"],
  },
  {
    ...runningTask("task-fl-digest-optout", "Add digest opt-out per territory", 39),
    conflictIds: ["conflict-fl-notify"],
  },
];

const floodConflicts: Conflict[] = [
  {
    id: "conflict-fl-osm",
    taskIds: ["task-fl-retry-payments", "task-fl-cancel-orders"],
    territoryId: "t-pay",
    subBlockId: "s-osm",
    sharedSymbols: [
      "OrderStateMachine.transition",
      "OrderStateMachine.guards",
      "ORDER_STATES",
    ],
    severity: "red",
    detectedAt: minsAgo(72),
  },
  {
    // No subBlockId — the subject falls back to the territory name
    // ("Notifications"); hidden below the top-3, forcing the generic
    // "and N more…" overflow copy.
    id: "conflict-fl-notify",
    taskIds: ["task-fl-digest-batch", "task-fl-digest-optout"],
    territoryId: "t-notify",
    sharedSymbols: ["DigestScheduler.enqueue", "DIGEST_WINDOW"],
    severity: "red",
    detectedAt: minsAgo(30),
  },
];

export const menubarFlood = {
  capturedAt: CAPTURED_AT,
  repo: v8Baseline.repo,
  sync: {
    lastFetchAt: secsAgo(42),
    lastHookEventAt: secsAgo(3),
    stale: false,
  },
  tasks: [
    waitingTask(
      "task-fl-audit-retention",
      "Backfill audit-log retention for archived workspaces",
      104,
      "Stopped to ask which retention cutoff applies.",
    ),
    waitingTask(
      "task-fl-notify-worker",
      "Split the notifications worker out of the monolith deploy target",
      58,
      "Stopped to confirm the queue naming scheme.",
    ),
    ...floodWaitingFiller,
    ...floodConflictTasks,
    ...Array.from({ length: 27 }, (_, i) =>
      runningTask(
        `task-fl-run-${i}`,
        `${FLOOD_VERBS[(i + 3) % FLOOD_VERBS.length]} ${FLOOD_AREAS[(i + 5) % FLOOD_AREAS.length]} — worker ${i + 1}`,
        60 - i,
      ),
    ),
  ],
  territories: v8Baseline.territories,
  occupancy: [],
  conflicts: floodConflicts,
} satisfies MapSnapshot;
