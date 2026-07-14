import { describe, expect, it, vi } from "vitest";
import type { WorkbenchBridgeResult, MapSnapshot } from "@vibehub/core/contracts";
import { bridgeFromHost, requestInitialSnapshot } from "../../src/workbench-host";

describe("production workbench host", () => {
  it("reports bridge_unavailable when a browser build has no host", async () => {
    await expect(requestInitialSnapshot(undefined)).resolves.toMatchObject({
      status: "bridge_unavailable",
    });
  });

  it.each(["db_missing", "repo_uninitialized", "unsynced", "internal_error"] as const)(
    "preserves the host's typed %s state without a fallback",
    async (status) => {
      const response: WorkbenchBridgeResult<MapSnapshot> = {
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
          repo: { repoKey: "repo", repoRoot: "/explicit/repo" },
        }),
      ).resolves.toEqual(response);
      vi.unstubAllGlobals();
    },
  );

  it("rejects malformed host configuration and method-specific requests before fetch", async () => {
    expect(bridgeFromHost({ endpoint: "", repo: { repoKey: "repo", repoRoot: "/repo" } })).toBeNull();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const connected = bridgeFromHost({ endpoint: "/bridge", repo: { repoKey: "repo", repoRoot: "/repo" } })!;
    await expect(connected.bridge.applyIntervention({
      ...connected.repo,
      requestId: "",
      intervention: { kind: "inject", taskId: "task", text: "hello" },
    })).resolves.toMatchObject({ status: "bridge_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects malformed success and error envelopes from the host", async () => {
    const host = { endpoint: "/bridge", repo: { repoKey: "repo", repoRoot: "/repo" } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "ok", data: { synthetic: true } }) }));
    await expect(requestInitialSnapshot(host)).resolves.toMatchObject({ status: "bridge_unavailable" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "internal_error" }) }));
    await expect(requestInitialSnapshot(host)).resolves.toMatchObject({ status: "bridge_unavailable" });
    vi.unstubAllGlobals();
  });
});
