import { describe, expect, it, vi } from "vitest";
import type { CornerSignalSnapshotV1 } from "@vibehub/core/contracts";
import {
  committedExpandedState,
  cornerSignalView,
  effectiveFreshness,
  scheduleStaleTransition,
} from "../src/corner-signal.js";

function snapshot(): CornerSignalSnapshotV1 {
  return {
    schemaVersion: 1,
    generation: "generation-test",
    selectionMode: "last_writer_selected",
    copiedAt: "2026-07-25T12:00:00.000Z",
    staleAfter: "2026-07-25T12:05:00.000Z",
    availability: "available",
    freshness: "live",
    recovery: [],
    identity: {
      availability: "available",
      freshness: "live",
      data: {
        repoRoot: "/repo/vibehub",
        checkoutRoot: "/repo/vibehub-worktree",
        host: "codex",
        branch: "feat/corner",
      },
      recovery: [],
    },
    signal: {
      availability: "available",
      freshness: "live",
      data: {
        state: "clear",
        evidence: ["No active conflicts were present in the canonical map."],
      },
      recovery: [],
    },
  };
}

describe("Corner Signal view projection", () => {
  it("shows only repository and branch identity, never a commit hash", () => {
    expect(cornerSignalView(snapshot(), new Date("2026-07-25T12:01:00.000Z")))
      .toMatchObject({
        title: "No shared conflict observed",
        repository: "vibehub",
        branch: "feat/corner",
        availability: "available",
        availabilityLabel: "Canonical evidence",
        freshness: "live",
        repoRoot: "/repo/vibehub",
        checkoutRoot: "/repo/vibehub-worktree",
        host: "codex",
      });
  });

  it("degrades an old file-backed copy to stale without rewriting authority", () => {
    expect(effectiveFreshness(
      snapshot(),
      new Date("2026-07-25T12:06:00.000Z"),
    )).toBe("stale");
    expect(cornerSignalView(
      snapshot(),
      new Date("2026-07-25T12:06:00.000Z"),
    ).recovery).toContain(
      "Run vibehub visual refresh for this checkout before relying on the displayed conflict evidence.",
    );
  });

  it("recomputes stale presentation when staleAfter elapses without a new file", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:04:59.999Z"));
    const callback = vi.fn();
    const cancel = scheduleStaleTransition(snapshot(), callback);
    vi.advanceTimersByTime(2);
    expect(callback).toHaveBeenCalledOnce();
    expect(cornerSignalView(snapshot(), new Date()).title).toBe(
      "Conflict evidence may be stale",
    );
    cancel();
    vi.useRealTimers();
  });

  it("never presents a partial clear projection as an all-clear", () => {
    const partial = {
      ...snapshot(),
      availability: "partial" as const,
      recovery: [{ code: "retry_read" as const, instruction: "Retry." }],
    };
    expect(cornerSignalView(partial, new Date("2026-07-25T12:01:00.000Z")).title)
      .toBe("Conflict evidence is incomplete");
  });

  it("commits expanded state only after the native resize succeeds", () => {
    expect(committedExpandedState(false, true, false)).toBe(false);
    expect(committedExpandedState(false, true, true)).toBe(true);
    expect(committedExpandedState(true, false, false)).toBe(true);
  });
});
