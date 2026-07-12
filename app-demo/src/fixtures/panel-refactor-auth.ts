/**
 * panel-refactor-auth — the EXACT content of the approved S2 static
 * (static/task-panel-s2.html): "Refactor auth flow", WAITING 12m, session
 * 2 of 2, 10 timeline entries 09:58 → 10:33, 2 off-scope files.
 *
 * capturedAt is fixed at 10:43 so the header age reproduces S2's "12m"
 * (question at 10:31 flipped the task to waiting).
 *
 * Derived milestone tier (isMilestone, 023 whitelist) keeps 3 entries here:
 * launch 09:58 · injection 10:24 · question 10:31 — coarser than the S2
 * static's hand-tagged set (see DECISIONS-NEEDED iter-6).
 */
import type { TaskPanelFixture } from "../panel-types";

export const panelRefactorAuth = {
  capturedAt: "2026-07-12T10:43:00-07:00",
  task: {
    id: "task-refactor-auth",
    title: "Refactor auth flow",
    state: "waiting",
    signalTier: "hooks",
    conflictIds: [],
    scopes: [
      { mode: "write", territoryId: "t-auth", label: "auth", filesTouched: 6 },
      { mode: "read", territoryId: "t-store", label: "storage" },
      { mode: "read", territoryId: "t-ci", label: "ci" },
    ],
    git: {
      branch: "feat/auth-refactor",
      worktreePath: "~/dev/worktrees/vibehub-auth-refactor",
    },
    stateSince: "2026-07-12T10:31:00-07:00",
    lastEventAt: "2026-07-12T10:33:00-07:00",
    statusDetail:
      "Agent stopped and asked a question. Parked until you answer — nothing runs meanwhile.",
  },
  session: {
    agent: "Claude Code",
    sessionOrdinal: 2,
    sessionCount: 2,
    previousEndedAt: "2026-07-12T09:55:00-07:00",
    previousEndReason: "context_limit",
  },
  twist: {
    offScopeFiles: ["cron/cleanup.ts", "config/redis.ts"],
    acknowledgedByEventId: "ev-report-1020",
  },
  timeline: [
    {
      id: "ev-launch",
      type: "launch",
      at: "2026-07-12T09:58:00-07:00",
      prompt:
        "Move session expiry from polling to event-driven. While you're in there, clean up the duplicated refresh-token logic.",
    },
    {
      id: "ev-report-1002",
      type: "self_report",
      at: "2026-07-12T10:02:00-07:00",
      kicker: "Started.",
      text: "Mapping the existing session lifecycle before touching refresh logic.",
    },
    {
      id: "ev-tests-1009",
      type: "test_run",
      at: "2026-07-12T10:09:00-07:00",
      passed: 42,
      failed: 0,
      note: "baseline before edits",
    },
    {
      id: "ev-files-1014",
      type: "file_change",
      at: "2026-07-12T10:14:00-07:00",
      files: [
        { path: "src/auth/session-store.ts", offScope: false },
        { path: "src/auth/token-refresh.ts", offScope: false },
        { path: "src/auth/auth-middleware.ts", offScope: false },
        { path: "cron/cleanup.ts", offScope: true },
        { path: "config/redis.ts", offScope: true },
      ],
    },
    {
      id: "ev-report-1020",
      type: "self_report",
      at: "2026-07-12T10:20:00-07:00",
      kicker: "Update.",
      text: "Expiry cleanup lives in a cron job — going event-driven means touching it. Scope is bigger than declared.",
      footprintCorroboration: {
        offScopeFiles: ["cron/cleanup.ts", "config/redis.ts"],
      },
    },
    {
      id: "ev-inject-1024",
      type: "user_injection",
      at: "2026-07-12T10:24:00-07:00",
      mode: "inject",
      text: "Don't delete the cron path — run both side by side for a week.",
    },
    {
      id: "ev-ack-1026",
      type: "agent_ack",
      at: "2026-07-12T10:26:00-07:00",
      kicker: "Adjusted.",
      text: "Keeping the cron path, adding the event-driven path in parallel.",
      ackOfEventId: "ev-inject-1024",
    },
    {
      id: "ev-reads-1028",
      type: "file_read",
      at: "2026-07-12T10:28:00-07:00",
      count: 3,
      territoryName: "Storage Layer",
      inDeclaredScope: true,
    },
    {
      id: "ev-ask-1031",
      type: "question",
      at: "2026-07-12T10:31:00-07:00",
      text: "Should session-expiry events also kick online devices off? That changes product behavior — your call.",
      transitionTo: "waiting",
    },
    {
      id: "ev-cross-1033",
      type: "cross_read_notice",
      at: "2026-07-12T10:33:00-07:00",
      file: "session-store.ts",
      otherTaskId: "task-migrate-sqlite",
      otherTaskTitle: "Migrate SQLite storage layer",
    },
  ],
  transcriptTail: [
    "● Read(auth-middleware.ts) → 214 lines",
    "● I need a decision: is kicking online devices the intended product behavior? This touches…",
    "● [waiting for user input]",
  ],
} satisfies TaskPanelFixture;
