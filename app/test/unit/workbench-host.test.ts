import { describe, expect, it, vi } from "vitest";
import type { WorkbenchBridgeResult, LiveShellSnapshotV1 } from "@vibehub/core/contracts";
import { bridgeFromHost, requestInitialSnapshot } from "../../src/workbench-host";
import { liveShellBaseline } from "../fixtures";

const repo = { repoKey: "repo", repoRoot: "/explicit/repo", checkoutRoot: "/explicit/repo/worktrees/live", host: "codex" };

describe("production workbench host", () => {
  it("reports bridge_unavailable when a browser build has no host", async () => {
    await expect(requestInitialSnapshot(undefined)).resolves.toMatchObject({
      status: "bridge_unavailable",
    });
  });

  it("boots exclusively through a validated getLiveShell envelope", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "ok", data: liveShellBaseline }) });
    vi.stubGlobal("fetch", fetch);
    await expect(requestInitialSnapshot({ endpoint: "/bridge", repo })).resolves.toEqual({ status: "ok", data: liveShellBaseline });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ method: "getLiveShell", request: repo });
    vi.unstubAllGlobals();
  });

  it.each(["db_missing", "repo_uninitialized", "unsynced", "internal_error"] as const)(
    "preserves the host's typed %s state without a fallback",
    async (status) => {
      const response: WorkbenchBridgeResult<LiveShellSnapshotV1> = {
        status,
        message: status,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: async () => response }),
      );
      await expect(
        requestInitialSnapshot({
          endpoint: "/__vibehub/workbench",
          repo,
        }),
      ).resolves.toEqual(response);
      vi.unstubAllGlobals();
    },
  );

  it("rejects malformed host configuration and method-specific requests before fetch", async () => {
    expect(bridgeFromHost({ endpoint: "", repo })).toBeNull();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const connected = bridgeFromHost({ endpoint: "/bridge", repo })!;
    await expect(connected.bridge.applyIntervention({
      ...connected.repo,
      requestId: "",
      intervention: { kind: "inject", taskId: "task", text: "hello" },
    })).resolves.toMatchObject({ status: "bridge_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects malformed success and error envelopes from the host", async () => {
    const host = { endpoint: "/bridge", repo };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "ok", data: { synthetic: true } }) }));
    await expect(requestInitialSnapshot(host)).resolves.toMatchObject({ status: "bridge_unavailable" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "internal_error" }) }));
    await expect(requestInitialSnapshot(host)).resolves.toMatchObject({ status: "bridge_unavailable" });
    vi.unstubAllGlobals();
  });
});
