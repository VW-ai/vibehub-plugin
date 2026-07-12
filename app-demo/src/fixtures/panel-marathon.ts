/**
 * panel-marathon — SCALE-EXTREMES N=many, all at once:
 *   - 60 timeline events (launch + 59), generated programmatically but
 *     DETERMINISTICALLY (pure index arithmetic — no Date.now, no random);
 *   - session 12 of 12 (meta-row stress);
 *   - a very long launch prompt (TEXT-long: bodies wrap, never truncate —
 *     the founding instruction is the human record);
 *   - header age "3h" (running since the 08:07 stalled→running transition,
 *     capturedAt 11:00 → 173m → rounds to 3h per the relAge rule);
 *   - includes commit + state_transition members, so the derived milestone
 *     tier has real anchors here (launch, 2 transitions, 1 injection,
 *     10 commits = 14 milestone entries out of 60).
 */
import type { TaskPanelFixture, TimelineEvent } from "../panel-types";

/** Minutes-of-day → fixed-day ISO string (deterministic, zero Date math). */
function at(minOfDay: number): string {
  const h = String(Math.floor(minOfDay / 60)).padStart(2, "0");
  const m = String(minOfDay % 60).padStart(2, "0");
  return `2026-07-12T${h}:${m}:00-07:00`;
}

const AREAS = ["ledger", "invoices", "refunds", "webhooks", "payouts"];
const FILES = [
  "src/payments/ledger.ts",
  "src/payments/invoice-builder.ts",
  "src/payments/refund-flow.ts",
  "src/payments/webhook-router.ts",
  "src/payments/payout-batch.ts",
  "src/queue/legacy-adapter.ts",
];

/** launch at 07:55, then 59 events every 3 minutes from 07:58 (i = 0…58). */
function buildTimeline(): TimelineEvent[] {
  const events: TimelineEvent[] = [
    {
      id: "ev-launch",
      type: "launch",
      at: at(475), // 07:55
      prompt:
        "Migrate the whole payments module off the legacy queue and onto the event bus. Constraints: keep the ledger append-only invariant intact at every intermediate commit; the legacy queue and the bus must run dual-write until the reconciliation job has seen seven consecutive clean days; every consumer you touch gets a contract test before you change its shape; refunds and payouts are money-moving paths, so behind a feature flag from the first commit; do not rename public exports — downstream repos import them; and keep each commit small enough that a human can actually review it. Work top-down from the webhook router, and write up anything that smells like undocumented behavior instead of silently preserving it.",
    },
  ];
  for (let i = 0; i < 59; i++) {
    const t = at(478 + 3 * i); // 07:58 + 3m steps → last at 10:52
    const id = `ev-gen-${String(i).padStart(2, "0")}`;
    const area = AREAS[i % AREAS.length]!;
    if (i === 1) {
      events.push({
        id,
        type: "state_transition",
        at: t,
        from: "running",
        to: "stalled",
        cause: "No tool calls or output for 6 minutes.",
      });
    } else if (i === 3) {
      events.push({
        id,
        type: "state_transition",
        at: t,
        from: "stalled",
        to: "running",
        cause: "Tool calls resumed.",
      });
    } else if (i === 30) {
      events.push({
        id,
        type: "user_injection",
        at: t,
        mode: "inject",
        text: "Skip the payouts consumer for now — finance wants to review it first.",
      });
    } else if (i === 32) {
      events.push({
        id,
        type: "agent_ack",
        at: t,
        kicker: "Adjusted.",
        text: "Parking the payouts consumer; continuing with refunds.",
        ackOfEventId: "ev-gen-30",
      });
    } else {
      switch (i % 6) {
        case 0:
          events.push({
            id,
            type: "self_report",
            at: t,
            kicker: i === 0 ? "Started." : "Update.",
            text: `Porting the ${area} consumer to the event bus; dual-write stays on.`,
          });
          break;
        case 1:
          events.push({
            id,
            type: "file_change",
            at: t,
            files: [
              { path: FILES[i % FILES.length]!, offScope: false },
              { path: FILES[(i + 1) % FILES.length]!, offScope: false },
            ],
          });
          break;
        case 2:
          events.push({
            id,
            type: "test_run",
            at: t,
            passed: 80 + i,
            failed: i % 4 === 2 ? 1 : 0,
          });
          break;
        case 3:
          events.push({
            id,
            type: "file_read",
            at: t,
            count: (i % 4) + 1,
            territoryName: "Payments & Orders",
            inDeclaredScope: true,
          });
          break;
        case 4:
          events.push({
            id,
            type: "commit",
            at: t,
            sha: `a${String(1000 + i)}fc`,
            message: `payments: port ${area} consumer to event bus`,
            filesChanged: (i % 3) + 2,
          });
          break;
        default:
          events.push({
            id,
            type: "self_report",
            at: t,
            kicker: "Update.",
            text: `Contract tests in place for the ${area} consumer.`,
          });
      }
    }
  }
  return events;
}

export const panelMarathon = {
  capturedAt: at(660), // 11:00
  task: {
    id: "task-payments-migration",
    title: "Migrate payments off the legacy queue",
    state: "running",
    signalTier: "hooks",
    conflictIds: [],
    scopes: [
      { mode: "write", territoryId: "t-pay", label: "payments", filesTouched: 14 },
      { mode: "read", territoryId: "t-notify", label: "notify" },
      { mode: "read", territoryId: "t-ci", label: "ci" },
    ],
    git: {
      branch: "feat/payments-event-bus",
      worktreePath: "~/dev/worktrees/vibehub-payments-bus",
    },
    stateSince: at(487), // 08:07 — the stalled→running transition (ev-gen-03)
    lastEventAt: at(652), // 10:52 — the last generated event
  },
  session: {
    agent: "Claude Code",
    sessionOrdinal: 12,
    sessionCount: 12,
    previousEndedAt: at(472), // 07:52
    previousEndReason: "context_limit",
  },
  timeline: buildTimeline(),
  transcriptTail: [
    "● Edit(refund-flow.ts) → applied",
    "● Bash(pnpm test payments) → 137 passing",
    "● Porting the refunds consumer next…",
  ],
} satisfies TaskPanelFixture;
