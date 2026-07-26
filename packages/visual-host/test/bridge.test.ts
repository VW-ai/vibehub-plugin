import { afterEach, describe, expect, it, vi } from "vitest";
import { isCornerSignalSnapshot, readCornerSignal } from "../src/bridge.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const snapshot = {
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
      repoRoot: "/repo",
      checkoutRoot: "/repo/worktree",
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
      evidence: ["No active conflicts."],
    },
    recovery: [],
  },
} as const;

describe("narrow native Corner Signal reader", () => {
  it("accepts the browser-safe v1 projection and rejects malformed identity", () => {
    expect(isCornerSignalSnapshot(snapshot)).toBe(true);
    expect(isCornerSignalSnapshot({
      ...snapshot,
      identity: { ...snapshot.identity, data: { repoRoot: "/repo" } },
    })).toBe(false);
    expect(isCornerSignalSnapshot({
      ...snapshot,
      availability: "partial",
    })).toBe(false);
    expect(isCornerSignalSnapshot({
      ...snapshot,
      signal: { ...snapshot.signal, availability: "unavailable", data: null, recovery: [] },
    })).toBe(false);
    expect(isCornerSignalSnapshot({
      ...snapshot,
      recovery: [{ code: "invented", instruction: "No." }],
    })).toBe(false);
  });

  it("does not fall back to fixture content when the native command is absent", async () => {
    await expect(readCornerSignal(undefined)).resolves.toEqual({
      availability: "unavailable",
      reason: "The native Corner Signal reader is unavailable in this window.",
    });
  });

  it("parses only bytes returned by the stable native projection command", async () => {
    const invoke = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      availability: "available",
      contents: JSON.stringify(snapshot),
      reason: null,
    });
    await expect(readCornerSignal({ invoke })).resolves.toEqual({
      availability: "available",
      snapshot,
    });
    expect(invoke).toHaveBeenCalledWith("read_corner_signal");
  });

  it("fails closed before the UI can dereference a malformed conflict decision", () => {
    expect(isCornerSignalSnapshot({
      ...snapshot,
      signal: {
        ...snapshot.signal,
        data: {
          state: "conflict",
          conflict: { id: "missing-required-fields" },
          tasks: [],
          detail: { availability: "available", freshness: "live", data: {}, recovery: [] },
          coordinationPrompt: "coordinate",
        },
      },
    })).toBe(false);
  });
});
