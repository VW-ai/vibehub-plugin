import { describe, expect, it } from "vitest";
import { nextState, type HookEventName } from "../src/state-machine.js";

describe("StateMachine collect-only hooks", () => {
  it.each([
    "SubagentStart",
    "SubagentStop",
    "PostToolUseFailure",
    "StopFailure",
  ] as const)("%s preserves the parent task state", (hook) => {
    expect(nextState("running", hook as HookEventName)).toBe("running");
    expect(nextState("waiting", hook as HookEventName)).toBe("waiting");
  });
});
