/**
 * v8-baseline — the EXACT content of the frozen approved reference screen
 * (workbench-refs/reference-screen-v8.html): 6 tasks, 6 territories,
 * 1 conflict (double-write on OrderStateMachine).
 *
 * capturedAt is fixed so all relative ages reproduce v8 verbatim:
 *   Refactor auth flow      waiting 12m
 *   Auto-retry payments     conflict 31m
 *   Cancel orders           conflict 9m
 *   Migrate SQLite          running 23m
 *   e2e smoke tests         stalled 8m
 *   Reconnect SSE           done 09:40
 *   Sync                    42s ago
 */
import type { MapFixture } from "../types";

export const v8Baseline = {
  capturedAt: "2026-07-12T10:22:00-07:00",
  repo: {
    slug: "VW-ai/Vibehub",
    defaultBranch: "main",
    branchCount: 6,
  },
  sync: {
    lastFetchAt: "2026-07-12T10:21:18-07:00",
    lastHookEventAt: "2026-07-12T10:21:45-07:00",
    stale: false,
  },
  tasks: [
    {
      id: "task-refactor-auth",
      title: "Refactor auth flow",
      state: "waiting",
      signalTier: "hooks",
      conflictIds: [],
      scopes: [
        { mode: "write", territoryId: "t-auth", label: "auth", filesTouched: 6 },
        { mode: "read", territoryId: "t-store", label: "storage" },
      ],
      git: {
        branch: "vibehub/refactor-auth-flow",
        worktreePath: "~/dev/vibehub",
      },
      stateSince: "2026-07-12T10:10:00-07:00",
      lastEventAt: "2026-07-12T10:10:00-07:00",
      statusDetail:
        "Asked which session-expiry policy to use. Parked until you answer.",
    },
    {
      id: "task-auto-retry-payments",
      title: "Auto-retry failed payments",
      state: "running",
      signalTier: "hooks",
      conflictIds: ["conflict-osm"],
      scopes: [
        {
          mode: "write",
          territoryId: "t-pay",
          subBlockId: "s-osm",
          label: "orders/osm",
        },
        { mode: "read", territoryId: "t-notify", label: "notify" },
        {
          mode: "read",
          territoryId: "t-pay",
          subBlockId: "s-recon",
          label: "reconciliation",
        },
        { mode: "read", territoryId: "t-ci", label: "ci" },
      ],
      git: { branch: "vibehub/auto-retry-failed-payments" },
      stateSince: "2026-07-12T09:51:00-07:00",
      lastEventAt: "2026-07-12T10:21:45-07:00",
      statusDetail:
        "Writing the same symbol as 'Cancel orders on timeout' (OrderStateMachine).",
    },
    {
      id: "task-cancel-orders",
      title: "Cancel orders on timeout",
      state: "running",
      signalTier: "hooks",
      conflictIds: ["conflict-osm"],
      scopes: [
        {
          mode: "write",
          territoryId: "t-pay",
          subBlockId: "s-osm",
          label: "orders/osm",
        },
        { mode: "read", territoryId: "t-store", label: "storage" },
      ],
      git: { branch: "vibehub/cancel-orders-on-timeout" },
      stateSince: "2026-07-12T10:13:00-07:00",
      lastEventAt: "2026-07-12T10:21:10-07:00",
      statusDetail:
        "Other side of the same conflict — either card opens the same adjudication.",
    },
    {
      id: "task-migrate-sqlite",
      title: "Migrate SQLite storage layer to GraphStore interface",
      state: "running",
      signalTier: "hooks",
      conflictIds: [],
      scopes: [
        {
          mode: "write",
          territoryId: "t-store",
          label: "storage",
          filesTouched: 11,
        },
        { mode: "read", territoryId: "t-ci", label: "ci" },
      ],
      git: { branch: "vibehub/migrate-sqlite-graphstore" },
      stateSince: "2026-07-12T09:59:00-07:00",
      lastEventAt: "2026-07-12T10:21:30-07:00",
      statusDetail: "Agent actively producing — tool calls and edits flowing.",
    },
    {
      id: "task-e2e-smoke",
      title: "Write e2e smoke tests",
      state: "stalled",
      signalTier: "hooks",
      conflictIds: [],
      scopes: [{ mode: "write", territoryId: "t-ci", label: "ci" }],
      git: { branch: "vibehub/e2e-smoke-tests" },
      stateSince: "2026-07-12T10:14:00-07:00",
      lastEventAt: "2026-07-12T10:14:00-07:00",
      statusDetail:
        "Process alive, no activity for 8 minutes. Probably stuck — worth a look.",
    },
    {
      id: "task-reconnect-sse",
      title: "Reconnect SSE on drop",
      state: "done",
      signalTier: "hooks",
      conflictIds: [],
      scopes: [{ mode: "write", territoryId: "t-fe", label: "web-ui" }],
      git: {
        branch: "vibehub/reconnect-sse-on-drop",
        prNumber: 740,
        prState: "merged",
      },
      stateSince: "2026-07-12T09:40:00-07:00",
      lastEventAt: "2026-07-12T09:40:00-07:00",
      statusDetail: "PR #740 merged 09:40 — auto-closed.",
    },
  ],
  territories: [
    {
      id: "t-auth",
      name: "Auth & Sessions",
      anchoredFileCount: 14,
      subBlocks: [],
      demoLayout: { left: 3, top: 4.5, width: 27, height: 38 },
    },
    {
      id: "t-pay",
      name: "Payments & Orders",
      anchoredFileCount: 23,
      subBlocks: [
        { id: "s-osm", name: "Order state machine", anchoredFileCount: 5 },
        { id: "s-chan", name: "Payment channels", anchoredFileCount: 8 },
        { id: "s-recon", name: "Reconciliation", anchoredFileCount: 6 },
      ],
      demoLayout: { left: 32.5, top: 4.5, width: 37, height: 55 },
      // px offsets verbatim from v8 (style="left:16px;top:40px" etc.)
      demoSubLayout: {
        "s-osm": { left: 16, top: 40 },
        "s-chan": { left: 16, top: 76 },
        "s-recon": { right: 16, bottom: 40 },
      },
    },
    {
      id: "t-store",
      name: "Storage Layer",
      anchoredFileCount: 18,
      subBlocks: [],
      demoLayout: { left: 3, top: 46.5, width: 27, height: 46 },
    },
    {
      id: "t-notify",
      name: "Notifications",
      anchoredFileCount: 9,
      subBlocks: [],
      demoLayout: { left: 32.5, top: 63.5, width: 17.5, height: 29 },
    },
    {
      id: "t-ci",
      name: "Build & CI",
      anchoredFileCount: 12,
      subBlocks: [],
      demoLayout: { left: 52, top: 63.5, width: 17.5, height: 29 },
    },
    {
      id: "t-fe",
      name: "Web UI",
      anchoredFileCount: 31,
      subBlocks: [],
      demoLayout: { left: 72.5, top: 4.5, width: 24.5, height: 88 },
    },
  ],
  occupancy: [
    {
      territoryId: "t-auth",
      writingTaskIds: ["task-refactor-auth"],
      readingTaskIds: [],
      doneTodayTaskIds: [],
    },
    {
      territoryId: "t-pay",
      writingTaskIds: ["task-auto-retry-payments", "task-cancel-orders"],
      readingTaskIds: ["task-auto-retry-payments"],
      doneTodayTaskIds: [],
    },
    {
      territoryId: "t-store",
      writingTaskIds: ["task-migrate-sqlite"],
      readingTaskIds: ["task-refactor-auth", "task-cancel-orders"],
      doneTodayTaskIds: [],
    },
    {
      territoryId: "t-notify",
      writingTaskIds: [],
      readingTaskIds: ["task-auto-retry-payments"],
      doneTodayTaskIds: [],
    },
    {
      territoryId: "t-ci",
      writingTaskIds: ["task-e2e-smoke"],
      readingTaskIds: ["task-migrate-sqlite", "task-auto-retry-payments"],
      doneTodayTaskIds: [],
    },
    {
      territoryId: "t-fe",
      writingTaskIds: [],
      readingTaskIds: [],
      doneTodayTaskIds: ["task-reconnect-sse"],
    },
  ],
  conflicts: [
    {
      id: "conflict-osm",
      taskIds: ["task-auto-retry-payments", "task-cancel-orders"],
      territoryId: "t-pay",
      subBlockId: "s-osm",
      // Reconciled at m3 S4 (DECISIONS-NEEDED iter-11 fork → iter-12): the
      // conflict-card fixture (conflict-osm-red.ts, S2-verbatim) is the
      // single source of truth for conflict-osm's symbol names; the map only
      // ever surfaces the COUNT (3, unchanged), so v8 render parity holds.
      // (v8's own HTML said transition/retryPolicy/onTimeout — never shown.)
      sharedSymbols: [
        "OrderStateMachine.transition",
        "OrderStateMachine.guards",
        "ORDER_STATES",
      ],
      severity: "red",
      detectedAt: "2026-07-12T10:13:40-07:00",
    },
  ],
} satisfies MapFixture;
