import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SUPPORTED_VISUAL_HOST_VERSION,
  VisualService,
  type VisualHostAdapter,
  type VisualRefreshResultV1,
} from "@vibehub/core";
import { main } from "../src/main.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function capture(run: () => number): { exit: number; value: Record<string, unknown> } {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  const exit = run();
  return { exit, value: JSON.parse(output) as Record<string, unknown> };
}

function successfulRefresh(repoPath = "/repo"): VisualRefreshResultV1 {
  const copiedAt = "2026-07-25T12:00:00.000Z";
  return {
    schemaVersion: 1,
    command: "refresh",
    ok: true,
    changed: true,
    copied: true,
    projectionPath: "/projection/corner-signal-v1.json",
    evidence: ["Copied projection."],
    snapshot: {
      schemaVersion: 1,
      generation: "generation-test",
      selectionMode: "last_writer_selected",
      copiedAt,
      staleAfter: "2026-07-25T12:05:00.000Z",
      availability: "available",
      freshness: "live",
      recovery: [],
      identity: {
        availability: "available",
        freshness: "live",
        data: {
          repoRoot: repoPath,
          checkoutRoot: repoPath,
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
    },
  };
}

describe("visual refresh CLI boundary", () => {
  it("requires typed repo/host/json flags and forwards exactly one Core refresh", () => {
    const calls: Array<{ repoPath: string; host: string }> = [];
    const projection = {
      refresh: (input: { repoPath: string; host: "claude-code" | "codex" }) => {
        calls.push(input);
        return successfulRefresh(input.repoPath);
      },
    };
    expect(capture(() => main([
      "visual",
      "refresh",
      "--repo",
      "/repo",
      "--host",
      "codex",
      "--json",
    ], { visualProjectionService: projection }))).toMatchObject({
      exit: 0,
      value: { command: "refresh", ok: true, copied: true },
    });
    expect(calls).toEqual([{ repoPath: "/repo", host: "codex" }]);

    for (const args of [
      ["visual", "refresh", "--repo", "/repo", "--json"],
      ["visual", "refresh", "--repo", "/repo", "--host", "other", "--json"],
      ["visual", "refresh", "--repo", "--host", "codex", "--json"],
      ["visual", "refresh", "--repo", "/repo", "--host", "codex"],
    ]) {
      expect(capture(() => main(args, { visualProjectionService: projection }))).toMatchObject({
        exit: 2,
        value: { ok: false, error: { code: "validation_error" } },
      });
    }
    expect(calls).toHaveLength(1);
  });

  it("refreshes before open and keeps projection copy separate from lifecycle success", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-visual-main-"));
    roots.push(root);
    const order: string[] = [];
    let running = false;
    const host: VisualHostAdapter = {
      inspect: () => ({
        availability: "available",
        installed: true,
        running,
        version: SUPPORTED_VISUAL_HOST_VERSION,
      }),
      open: () => {
        order.push("open");
        running = true;
        return { outcome: "observed_running", evidence: ["opened"] };
      },
      quit: () => ({ outcome: "unavailable", evidence: [] }),
    };
    const service = new VisualService({
      settingsPath: path.join(root, "settings.json"),
      host,
    });
    const projection = {
      refresh: () => {
        order.push("refresh");
        return successfulRefresh("/repo");
      },
    };
    expect(capture(() => main([
      "visual",
      "open",
      "--repo",
      "/repo",
      "--host",
      "codex",
      "--json",
    ], {
      visualService: service,
      visualProjectionService: projection,
    }))).toMatchObject({
      exit: 0,
      value: {
        command: "open",
        ok: true,
        lifecycle: "attempted",
        projectionSelection: {
          mode: "last_writer_selected",
          requestedGeneration: "generation-test",
          identity: { checkoutRoot: "/repo" },
        },
        refresh: { command: "refresh", copied: true },
        open: { command: "open", ok: true },
      },
    });
    expect(order).toEqual(["refresh", "open"]);
  });

  it("does not open when the projection copy fails", () => {
    let opened = false;
    const projection = {
      refresh: (): VisualRefreshResultV1 => ({
        schemaVersion: 1,
        command: "refresh",
        ok: false,
        changed: false,
        copied: false,
        projectionPath: "/projection/corner-signal-v1.json",
        evidence: [],
        error: {
          code: "projection_write_failed",
          message: "disk denied",
        },
      }),
    };
    const host: VisualHostAdapter = {
      inspect: () => ({
        availability: "available",
        installed: true,
        running: false,
        version: SUPPORTED_VISUAL_HOST_VERSION,
      }),
      open: () => {
        opened = true;
        return { outcome: "observed_running", evidence: [] };
      },
      quit: () => ({ outcome: "unavailable", evidence: [] }),
    };
    expect(capture(() => main([
      "visual",
      "open",
      "--repo",
      "/repo",
      "--host",
      "codex",
    ], {
      visualService: new VisualService({ host }),
      visualProjectionService: projection,
    }))).toMatchObject({
      exit: 1,
      value: {
        command: "open",
        ok: false,
        lifecycle: "not_attempted",
        refresh: {
          command: "refresh",
          error: { code: "projection_write_failed" },
        },
        error: { code: "refresh_failed" },
      },
    });
    expect(opened).toBe(false);
  });
});
