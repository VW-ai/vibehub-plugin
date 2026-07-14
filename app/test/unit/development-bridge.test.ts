import { describe, expect, it, vi } from "vitest";
import { dispatchWorkbenchEnvelope } from "../../src/development-bridge";

const repo = { repoKey: "repo", repoRoot: "/repo" };
const service = {
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
});
