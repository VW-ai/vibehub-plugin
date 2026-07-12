/**
 * StateMachine — hook events → the five states (decision-project-021,
 * capped at five forever; decision-project-025 module list).
 *
 * Pure function, strong-tier (Claude Code hooks) mapping:
 * - SessionStart / UserPromptSubmit / PostToolUse → running (output flowing)
 * - Notification → waiting (agent stopped and asked — go handle it)
 * - Stop → waiting (turn ended, agent idle until the human responds)
 * - SessionEnd → done (session ended, success or abandoned)
 *
 * "stalled" is deliberately NOT produced here: it means "alive but silent
 * for a while", which is an OBSERVATION at read time (lastEventAt age vs
 * now), not an event — there is no daemon to fire a timer
 * (decision-project-016), so no stored transition can be trusted to exist.
 * "queued" is only ever the launch-side initial state.
 */
import type { TaskState } from "./contract/map-types.js";

export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PostToolUse"
  | "Notification"
  | "Stop"
  | "SessionEnd";

export function nextState(_current: TaskState, hook: HookEventName): TaskState {
  switch (hook) {
    case "SessionStart":
    case "UserPromptSubmit":
    case "PostToolUse":
      return "running";
    case "Notification":
    case "Stop":
      return "waiting";
    case "SessionEnd":
      return "done";
  }
}
