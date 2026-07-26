import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SUPPORTED_VISUAL_HOST_VERSION,
  VisualService,
  type VisualHostAdapter,
} from "@vibehub/core";
import { main } from "../src/main.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["VIBEHUB_VISUAL_SETTINGS"];
  delete process.env["VIBEHUB_VISUAL_HOST_VERSION"];
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function settingsFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vh-visual-cli-"));
  roots.push(root);
  return path.join(root, "settings.json");
}
const unavailableHost: VisualHostAdapter = {
  inspect: () => ({
    availability: "unavailable",
    installed: null,
    running: null,
    evidence: ["test adapter has no native host"],
  }),
  open: () => ({ outcome: "unavailable", evidence: ["test adapter did not launch"] }),
  quit: () => ({ outcome: "unavailable", evidence: ["test adapter did not launch"] }),
};
function unavailableService(settingsPath: string) {
  return new VisualService({ settingsPath, host: unavailableHost });
}
function invoke(args: string[], settingsPath: string, visualService?: VisualService) {
  process.env["VIBEHUB_VISUAL_SETTINGS"] = settingsPath;
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk); return true;
  }) as typeof process.stdout.write);
  const exit = main(["visual", ...args], visualService ? { visualService } : undefined);
  vi.restoreAllMocks();
  return { exit, value: JSON.parse(output) };
}
describe("vibehub visual CLI", () => {
  it("exposes stable JSON status and idempotent settings operations", () => {
    const settingsPath = settingsFixture();
    const service = unavailableService(settingsPath);
    expect(invoke(["status", "--json"], settingsPath, service)).toMatchObject({ exit: 1, value: { command: "status", status: { lifecycle: "degraded" } } });
    expect(invoke(["status"], settingsPath, service)).toMatchObject({ exit: 2, value: { command: "status", error: { code: "validation_error" } } });
    expect(invoke(["disable", "--json"], settingsPath, service)).toMatchObject({ exit: 0, value: { ok: true, changed: true } });
    expect(invoke(["disable", "--json"], settingsPath, service)).toMatchObject({ exit: 0, value: { ok: true, changed: false } });
    expect(invoke(["snooze", "bad", "--json"], settingsPath, service)).toMatchObject({ exit: 2, value: { error: { code: "invalid_duration" } } });
  });
  it("reports open/quit unavailable instead of launching a GUI", () => {
    const settingsPath = settingsFixture();
    const service = unavailableService(settingsPath);
    expect(invoke(["open", "--json"], settingsPath, service)).toMatchObject({ exit: 1, value: { ok: false, error: { code: "host_unavailable" } } });
    expect(invoke(["quit", "--json"], settingsPath, service)).toMatchObject({ exit: 1, value: { ok: false, error: { code: "host_unavailable" } } });
  });
  it("treats installed-not-running as unhealthy but intentional mute states as healthy", () => {
    const settingsPath = settingsFixture();
    const adapter = (running: boolean): VisualHostAdapter => ({
      inspect: () => ({
        availability: "available",
        installed: true,
        running,
        version: SUPPORTED_VISUAL_HOST_VERSION,
      }),
      open: () => ({ outcome: "unavailable", evidence: [] }),
      quit: () => ({ outcome: "unavailable", evidence: [] }),
    });
    expect(invoke(
      ["status", "--json"],
      settingsPath,
      new VisualService({ settingsPath, host: adapter(false) }),
    )).toMatchObject({ exit: 1, value: { status: { lifecycle: "installed_not_running" } } });
    const running = new VisualService({ settingsPath, host: adapter(true) });
    expect(invoke(["disable", "--json"], settingsPath, running)).toMatchObject({
      exit: 0,
      value: { status: { lifecycle: "running_disabled" } },
    });
    expect(invoke(["enable", "--json"], settingsPath, running)).toMatchObject({
      exit: 0,
      value: { status: { lifecycle: "running_enabled" } },
    });
    expect(invoke(["snooze", "15m", "--json"], settingsPath, running)).toMatchObject({
      exit: 0,
      value: { status: { lifecycle: "running_snoozed" } },
    });
  });

  it.each(["", " \t "])(
    "normalizes a blank CLI host-version environment value to the supported default",
    (environmentVersion) => {
      const settingsPath = settingsFixture();
      process.env["VIBEHUB_VISUAL_HOST_VERSION"] = environmentVersion;
      const adapter: VisualHostAdapter = {
        inspect: () => ({
          availability: "available",
          installed: true,
          running: true,
          version: SUPPORTED_VISUAL_HOST_VERSION,
        }),
        open: () => ({ outcome: "observed_running", evidence: [] }),
        quit: () => ({ outcome: "observed_stopped", evidence: [] }),
      };
      const service = new VisualService({
        settingsPath,
        host: adapter,
        expectedHostVersion: process.env["VIBEHUB_VISUAL_HOST_VERSION"],
      });
      expect(invoke(["status", "--json"], settingsPath, service)).toMatchObject({
        exit: 0,
        value: { status: { lifecycle: "running_enabled" } },
      });
    },
  );
});
