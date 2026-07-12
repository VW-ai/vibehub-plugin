/**
 * synthetic-panel — generate a MINIMAL TaskPanelFixture from a map Task for
 * cards that have no hand-authored panel fixture (S4 map↔panel wiring).
 *
 * HONESTY RULE (guideline 4): only what the map fixture mechanically knows —
 * launch + the transition into the current state. NO invented self-reports,
 * commits, test runs or transcript lines: a thin history is rendered thin.
 *
 * Two acknowledged stand-ins (fork logged in DECISIONS-NEEDED iter-7):
 *   - the launch prompt: map fixtures don't carry it, so the task TITLE
 *     stands in (in a real capture UserPromptSubmit holds the verbatim
 *     prompt; the title is the closest user-authored text we hold).
 *   - the launch time: no launch timestamp exists on Task, so the earliest
 *     known signal (min of stateSince / lastEventAt) stands in.
 * Queued tasks get an EMPTY timeline — no session has started, and faking a
 * launch event for an unlaunched task would be a lie.
 */
import type { Task, MapFixture } from "../types";
import type { TaskPanelFixture, TimelineEvent } from "../panel-types";

export function syntheticPanel(task: Task, map: MapFixture): TaskPanelFixture {
  const timeline: TimelineEvent[] = [];
  if (task.state !== "queued") {
    const launchAt =
      Date.parse(task.lastEventAt) < Date.parse(task.stateSince)
        ? task.lastEventAt
        : task.stateSince;
    timeline.push({
      id: `syn-launch-${task.id}`,
      type: "launch",
      at: launchAt,
      prompt: task.title,
    });
    // The transition into the current state — mechanically true (stateSince
    // is exactly when it happened; cause is the verbatim statusDetail).
    // Running tasks need no transition row: launch already reads as the
    // start of running, and inventing what preceded a resume would be a lie.
    if (task.state !== "running") {
      timeline.push({
        id: `syn-state-${task.id}`,
        type: "state_transition",
        at: task.stateSince,
        from: "running",
        to: task.state,
        ...(task.statusDetail !== undefined ? { cause: task.statusDetail } : {}),
      });
    }
  }
  return {
    capturedAt: map.capturedAt,
    task,
    session: { agent: "Claude Code", sessionOrdinal: 1, sessionCount: 1 },
    timeline,
    transcriptTail: [], // nothing captured — honest, not fabricated
  };
}
