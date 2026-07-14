/**
 * panel-just-launched — SCALE-EXTREMES N=0: the panel opened seconds after
 * launch. Zero agent events; the timeline holds ONLY the launch prompt
 * (UserPromptSubmit fires the instant the task starts, so a launched task's
 * timeline can never be truly empty — the founding instruction IS the honest
 * empty state, no fake entries). Transcript tail: empty (nothing emitted).
 * Also exercises the seconds rung of the age rule ("42s").
 */
import type { TaskPanelSnapshot } from "@vibehub/core/contracts";

export const panelJustLaunched = {
  capturedAt: "2026-07-12T11:00:42-07:00",
  task: {
    id: "task-flaky-uploads",
    title: "Fix flaky upload retries",
    state: "running",
    signalTier: "hooks",
    conflictIds: [],
    scopes: [
      { mode: "write", territoryId: "t-store", label: "storage" },
    ],
    git: {
      branch: "fix/flaky-upload-retries",
      worktreePath: "~/dev/worktrees/vibehub-flaky-uploads",
    },
    stateSince: "2026-07-12T11:00:00-07:00",
    lastEventAt: "2026-07-12T11:00:00-07:00",
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
      at: "2026-07-12T11:00:00-07:00",
      prompt:
        "Uploads over 50MB fail about once in five runs. Find the retry bug and fix it.",
    },
  ],
  transcriptTail: [],
} satisfies TaskPanelSnapshot;
