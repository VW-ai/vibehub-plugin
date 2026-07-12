/**
 * conflict-osm-red-diagnosed — the EXACT content of the approved S2 static's
 * red variant (static/conflict-card-s2.html, `?v=`): W × W on "Order state
 * machine", detected 11:07 (8m), Auto-retry running 31m × Cancel running 9m,
 * 3 shared symbols, diagnosis at 11:12 with stalenessEditsSince 0 — 11:12 IS
 * the last shared-symbol edit (Cancel on ORDER_STATES), so the verdict still
 * matches reality and the provenance dot stays green.
 *
 * conflict-no-diagnosis — the same card without `diagnosis` (the S2 `?v=empty`
 * variant is literally the red card with zone b in its dashed empty state, so
 * the two fixtures share every const; only the diagnosis field differs).
 *
 * NOTE (fork, DECISIONS-NEEDED iter-11): ids reuse the v8 map's records
 * (conflict-osm / task-auto-retry-payments / task-cancel-orders / t-pay /
 * s-osm) so S4 can open this card from the map's own conflict, but the
 * CONTENT is the S2 card verbatim, which diverges from v8-baseline.ts
 * (different symbol names + times). v8-baseline stays frozen; S4 reconciles.
 */
import type {
  ConflictCardFixture,
  ConflictDiagnosis,
  ResourceCrumb,
  SharedSymbolEvidence,
} from "../conflict-types";
import type { Conflict, Task } from "../types";

const CAPTURED_AT = "2026-07-12T11:15:00-07:00";

const conflict = {
  id: "conflict-osm",
  taskIds: ["task-auto-retry-payments", "task-cancel-orders"],
  territoryId: "t-pay",
  subBlockId: "s-osm",
  sharedSymbols: [
    "OrderStateMachine.transition",
    "OrderStateMachine.guards",
    "ORDER_STATES",
  ],
  severity: "red",
  detectedAt: "2026-07-12T11:07:00-07:00", // capturedAt 11:15 → "8m"
} satisfies Conflict;

const tasks = [
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
        filesTouched: 4, // S2 chip tooltip: "4 files touched here so far"
      },
    ],
    git: {
      branch: "vibehub/auto-retry-failed-payments",
      worktreePath: "~/dev/worktrees/auto-retry",
    },
    stateSince: "2026-07-12T10:44:00-07:00", // pause menu: "running 31m"
    lastEventAt: "2026-07-12T11:14:30-07:00",
    statusDetail:
      "Writing the same symbols as 'Cancel orders on timeout' (Order state machine).",
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
        filesTouched: 2, // S2 chip tooltip: "2 files touched here so far"
      },
    ],
    git: {
      branch: "vibehub/cancel-orders-on-timeout",
      worktreePath: "~/dev/worktrees/cancel-orders",
    },
    stateSince: "2026-07-12T11:06:00-07:00", // pause menu: "running 9m"
    lastEventAt: "2026-07-12T11:14:10-07:00",
    statusDetail:
      "Other side of the same conflict — either card opens the same adjudication.",
  },
] satisfies [Task, Task];

const crumb = {
  resourceName: "Order state machine",
  territoryName: "Payments & Orders",
  subBlockName: "Order state machine",
  anchorFile: "src/orders/state-machine.ts",
} satisfies ResourceCrumb;

/** Times verbatim from the S2 per-row tooltips ("Edited by Auto-retry at
 *  11:04 and by Cancel-on-timeout at 11:07", …). Both sides edit ⇒ each row
 *  derives "both edited". */
const symbols = [
  {
    name: "OrderStateMachine.transition",
    file: "src/orders/state-machine.ts",
    touches: [
      { taskId: "task-auto-retry-payments", action: "edit", at: "2026-07-12T11:04:00-07:00" },
      { taskId: "task-cancel-orders", action: "edit", at: "2026-07-12T11:07:00-07:00" },
    ],
  },
  {
    name: "OrderStateMachine.guards",
    file: "src/orders/state-machine.ts",
    touches: [
      { taskId: "task-auto-retry-payments", action: "edit", at: "2026-07-12T11:05:00-07:00" },
      { taskId: "task-cancel-orders", action: "edit", at: "2026-07-12T11:09:00-07:00" },
    ],
  },
  {
    name: "ORDER_STATES",
    file: "src/orders/state-machine.ts",
    touches: [
      { taskId: "task-auto-retry-payments", action: "edit", at: "2026-07-12T11:06:00-07:00" },
      { taskId: "task-cancel-orders", action: "edit", at: "2026-07-12T11:12:00-07:00" },
    ],
  },
] satisfies SharedSymbolEvidence[];

/** Verbatim from the S2 static's red diagnosis block. Backtick-quoted code
 *  tokens are exactly as the model emitted them (the S2 mono spans). */
const diagnosis = {
  verdict: "Real conflict — same transition table, incompatible edits.",
  sides: [
    {
      taskId: "task-auto-retry-payments",
      label: "Auto-retry",
      doing: "Adding a `RETRYING` state and re-entry transitions to `ORDER_STATES`.",
    },
    {
      taskId: "task-cancel-orders",
      label: "Cancel",
      doing: "Adding timeout-driven `CANCELLED` transitions to the same switch blocks.",
    },
  ],
  suggested:
    "Land Cancel's transition-table change first and have Auto-retry rebase on it — or inject a shared note that retries must honor timeout cancellation. Neither side currently handles an order cancelled mid-retry.",
  provenance: {
    diagnosedAt: "2026-07-12T11:12:00-07:00",
    engine: "claude-p-local",
  },
  // The 11:12 ORDER_STATES edit is not AFTER 11:12 — nothing has landed
  // since the pass ran, so the dot stays green (S2: "No edits have landed
  // on these symbols since").
  stalenessEditsSince: 0,
} satisfies ConflictDiagnosis;

export const conflictOsmRedDiagnosed = {
  capturedAt: CAPTURED_AT,
  conflict,
  tasks,
  crumb,
  symbols,
  diagnosis,
} satisfies ConflictCardFixture;

/** The S2 `?v=empty` variant: identical evidence, diagnosis not yet run —
 *  zone b renders the dashed empty state; the inject placeholder loses its
 *  send-the-Suggested-line default (nothing to default to). */
export const conflictNoDiagnosis = {
  capturedAt: CAPTURED_AT,
  conflict,
  tasks,
  crumb,
  symbols,
} satisfies ConflictCardFixture;
