/**
 * panel-quiet-milestones — two extremes in one:
 *   - header age "2d": the question fired 2026-07-10T09:00, capturedAt
 *     2026-07-12T09:00 → exactly 48h → "2d" (day rung of the relAge rule);
 *     an honest long-forgotten WAITING task, as-is, never dressed up.
 *   - derived milestone tier yields EXACTLY 3 entries: launch (user action)
 *     + commit (anchor) + question (→waiting transition carrier). All the
 *     self-reports / file work between them is All-tier only — this is
 *     023's "三小时的事约 5 行" promise at its sparsest.
 */
import type { TaskPanelFixture } from "../panel-types";

export const panelQuietMilestones = {
  capturedAt: "2026-07-12T09:00:00-07:00",
  task: {
    id: "task-rate-limit-cleanup",
    title: "Consolidate rate-limit middleware",
    state: "waiting",
    signalTier: "hooks",
    conflictIds: [],
    scopes: [
      { mode: "write", territoryId: "t-auth", label: "auth", filesTouched: 4 },
    ],
    git: {
      branch: "chore/rate-limit-consolidation",
      worktreePath: "~/dev/worktrees/vibehub-rate-limit",
    },
    stateSince: "2026-07-10T09:00:00-07:00",
    lastEventAt: "2026-07-10T09:00:00-07:00",
    statusDetail:
      "Asked which of the two throttling policies is canonical. Parked until you answer.",
  },
  session: {
    agent: "Claude Code",
    sessionOrdinal: 1,
    sessionCount: 1,
  },
  timeline: [
    {
      id: "ev-launch",
      type: "launch",
      at: "2026-07-10T08:05:00-07:00",
      prompt:
        "We have three copies of rate-limit middleware. Consolidate them into one, keep the strictest behavior.",
    },
    {
      id: "ev-report-1",
      type: "self_report",
      at: "2026-07-10T08:11:00-07:00",
      kicker: "Started.",
      text: "Diffing the three implementations to find where behavior actually diverges.",
    },
    {
      id: "ev-tests-1",
      type: "test_run",
      at: "2026-07-10T08:19:00-07:00",
      passed: 58,
      failed: 0,
      note: "baseline before edits",
    },
    {
      id: "ev-files-1",
      type: "file_change",
      at: "2026-07-10T08:27:00-07:00",
      files: [
        { path: "src/middleware/rate-limit.ts", offScope: false },
        { path: "src/middleware/throttle-legacy.ts", offScope: false },
      ],
    },
    {
      id: "ev-report-2",
      type: "self_report",
      at: "2026-07-10T08:34:00-07:00",
      kicker: "Update.",
      text: "Two implementations agree; the third silently allows bursts. Consolidating onto the strict one.",
    },
    {
      id: "ev-commit-1",
      type: "commit",
      at: "2026-07-10T08:41:00-07:00",
      sha: "9d41ab2",
      message: "middleware: fold burst-allowing limiter into strict limiter",
      filesChanged: 3,
    },
    {
      id: "ev-reads-1",
      type: "file_read",
      at: "2026-07-10T08:52:00-07:00",
      count: 2,
      territoryName: "Auth & Sessions",
      inDeclaredScope: true,
    },
    {
      id: "ev-ask-1",
      type: "question",
      at: "2026-07-10T09:00:00-07:00",
      text: "The API gateway config declares a different burst window than the code. Which one is canonical?",
      transitionTo: "waiting",
    },
  ],
  transcriptTail: [
    "● Read(gateway.yaml) → 88 lines",
    "● The gateway says burst=20/10s, the code says 10/10s — I need a ruling…",
    "● [waiting for user input]",
  ],
} satisfies TaskPanelFixture;
