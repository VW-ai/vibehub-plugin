import { describe, expect, it, vi } from "vitest";
import { dispatchWorkbenchEnvelope } from "../../src/development-bridge";
import { liveShellBaseline } from "../fixtures";

const repo = { repoKey: "repo", repoRoot: "/repo", checkoutRoot: "/repo/worktrees/live", host: "codex" };
const service = {
  readLiveShell: vi.fn(),
  readWorkbenchSnapshot: vi.fn(() => ({ status: "db_missing", message: "missing" })),
  readTaskPanel: vi.fn(),
  readConflictDetail: vi.fn(),
  applyIntervention: vi.fn(),
};

describe("development bridge dispatcher", () => {
  it("rejects malformed method-specific wire requests before dispatch", () => {
    expect(() => dispatchWorkbenchEnvelope({ method: "getTaskPanel", request: repo }, repo, service))
      .toThrow(/invalid method-specific/);
    expect(service.readTaskPanel).not.toHaveBeenCalled();
  });

  it("dispatches and validates a typed result", () => {
    expect(dispatchWorkbenchEnvelope({ method: "getSnapshot", request: repo }, repo, service))
      .toEqual({ status: "db_missing", message: "missing" });
    expect(service.readWorkbenchSnapshot).toHaveBeenCalledWith(repo);
  });

  it("dispatches getLiveShell with the exact checkout and validates its result", () => {
    service.readLiveShell.mockReturnValueOnce({ status: "ok", data: liveShellBaseline });
    expect(dispatchWorkbenchEnvelope({ method: "getLiveShell", request: repo }, repo, service))
      .toEqual({ status: "ok", data: liveShellBaseline });
    expect(service.readLiveShell).toHaveBeenCalledWith(repo);
    expect(() => dispatchWorkbenchEnvelope({ method: "getLiveShell", request: { ...repo, checkoutRoot: "/other" } }, repo, service))
      .toThrow(/repository mismatch/);
  });

  it("rejects unknown methods without falling through to intervention", () => {
    expect(() => dispatchWorkbenchEnvelope({ method: "futureMethod", request: repo }, repo, service))
      .toThrow(/invalid method-specific/);
    expect(service.applyIntervention).not.toHaveBeenCalled();
  });
});
