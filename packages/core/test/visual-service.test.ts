import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import * as ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { VisualService, type VisualHostAdapter } from "../src/visual-service.js";
import { SUPPORTED_VISUAL_HOST_VERSION } from "../src/macos-visual-host.js";

const roots: string[] = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-visual-"));
  roots.push(root);
  return path.join(root, "visual-settings.json");
};
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const host = (observation: ReturnType<VisualHostAdapter["inspect"]>): VisualHostAdapter => ({
  inspect: () => ({
    ...observation,
    ...(observation.installed === true && observation.version === undefined
      ? { version: SUPPORTED_VISUAL_HOST_VERSION }
      : {}),
  }),
  open: () => ({ outcome: "unavailable", evidence: ["native host is not bundled"] }),
  quit: () => ({ outcome: "unavailable", evidence: ["native host is not bundled"] }),
});

function waitForWorkerMessage(worker: Worker, kind: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: Record<string, unknown>) => {
      if (message["kind"] !== kind) return;
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
}

describe("VisualService", () => {
  it.each([
    ["undefined", undefined, SUPPORTED_VISUAL_HOST_VERSION],
    ["empty", "", SUPPORTED_VISUAL_HOST_VERSION],
    ["whitespace", " \t ", SUPPORTED_VISUAL_HOST_VERSION],
    ["trimmed", " 1.2.3 ", "1.2.3"],
  ])("normalizes the %s expected host version once for lifecycle derivation", (
    _label,
    expectedHostVersion,
    observedVersion,
  ) => {
    const service = new VisualService({
      settingsPath: fixture(),
      expectedHostVersion,
      host: host({
        availability: "available",
        installed: true,
        running: true,
        version: observedVersion,
      }),
    });
    expect(service.status()).toMatchObject({
      ok: true,
      status: { lifecycle: "running_enabled" },
    });
  });

  it("derives every truthful lifecycle and typed recovery", () => {
    const settingsPath = fixture();
    const service = (adapter: VisualHostAdapter) => new VisualService({
      settingsPath, host: adapter, expectedHostVersion: "1.2.0",
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    expect(service(host({ availability: "available", installed: false, running: false })).status().status.lifecycle).toBe("not_installed");
    expect(service(host({ availability: "available", installed: true, running: false, version: "1.2.0" })).status().status.lifecycle).toBe("installed_not_running");
    expect(service(host({ availability: "available", installed: true, running: true, version: "0.9.0" })).status().status.lifecycle).toBe("version_mismatch");
    expect(service(host({ availability: "degraded", installed: true, running: false, evidence: ["probe failed"] })).status().status.lifecycle).toBe("degraded");

    const running = service(host({ availability: "available", installed: true, running: true, version: "1.2.0" }));
    expect(running.status().status.lifecycle).toBe("running_enabled");
    expect(running.snooze("30m").status.lifecycle).toBe("running_snoozed");
    expect(running.disable().status.lifecycle).toBe("running_disabled");
    expect(running.enable().status.lifecycle).toBe("running_enabled");
  });

  it("degrades unknown host facts instead of coercing them into negative evidence", () => {
    const settingsPath = fixture();
    const service = (adapter: VisualHostAdapter) => new VisualService({
      settingsPath,
      host: adapter,
      expectedHostVersion: "1.2.0",
    });
    expect(service(host({
      availability: "available",
      installed: null,
      running: null,
    })).status().status.lifecycle).toBe("degraded");
    expect(service(host({
      availability: "available",
      installed: true,
      running: null,
      version: "1.2.0",
    })).status().status.lifecycle).toBe("degraded");
    expect(service({
      ...host({ availability: "available", installed: true, running: true }),
      inspect: () => ({ availability: "available", installed: true, running: true }),
    }).status().status.lifecycle).toBe("degraded");
    expect(service(host({
      availability: "available",
      installed: false,
      running: true,
    })).status().status.lifecycle).toBe("degraded");
    expect(service(host({
      availability: "available",
      installed: false,
      running: false,
      version: "1.2.0",
    })).status().status.lifecycle).toBe("degraded");
  });

  it("persists settings, migrates legacy JSON, and preserves the prior file on atomic failure", () => {
    const settingsPath = fixture();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      enabled: false, importantOnly: true, launchAtLogin: true,
      positions: { "display-1": { x: 12, y: 34 } },
    }));
    const service = new VisualService({ settingsPath, host: host({ availability: "available", installed: true, running: true }) });
    expect(service.status().status.settings).toMatchObject({
      schemaVersion: 1, signalsEnabled: false, importantOnly: true,
      launchAtLogin: true, displayPositions: { "display-1": { x: 12, y: 34 } },
    });
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).schemaVersion).toBeUndefined();
    expect(service.configure({})).toMatchObject({ ok: true, changed: true });
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).schemaVersion).toBe(1);
    expect(service.configure({
      importantOnly: false,
      launchAtLogin: false,
      displayPositions: { "display-2": { x: 56, y: 78 } },
    }).status.settings).toMatchObject({
      importantOnly: false,
      launchAtLogin: false,
      displayPositions: { "display-2": { x: 56, y: 78 } },
    });

    const before = fs.readFileSync(settingsPath, "utf8");
    const failing = new VisualService({
      settingsPath,
      host: host({ availability: "available", installed: true, running: true }),
      settingsFault: (phase) => { if (phase === "before_rename") throw new Error("fault"); },
    });
    expect(failing.enable().ok).toBe(false);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);

    const committed = new VisualService({
      settingsPath,
      host: host({ availability: "available", installed: true, running: true }),
      settingsFault: (phase) => {
        if (phase === "before_directory_fsync") throw new Error("directory sync failed");
      },
    }).configure({ launchAtLogin: true });
    expect(committed).toMatchObject({
      ok: false,
      changed: true,
      error: { code: "settings_error", message: "directory sync failed" },
      status: { settings: { launchAtLogin: true } },
    });
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).launchAtLogin).toBe(true);
  });

  it("preserves authoritative JSON changes across coordination commit and close failures", () => {
    const commitPath = fixture();
    const commitFailure = new VisualService({
      settingsPath: commitPath,
      host: host({ availability: "available", installed: true, running: true }),
      settingsFault: (phase) => {
        if (phase === "before_coordination_commit") throw new Error("coordination commit failed");
      },
    });
    expect(commitFailure.configure({ importantOnly: true })).toMatchObject({
      ok: false,
      changed: true,
      evidence: ["Visual settings were committed before a later persistence or coordination step failed."],
      error: { code: "settings_error", message: "coordination commit failed" },
      status: { settings: { importantOnly: true } },
    });
    expect(JSON.parse(fs.readFileSync(commitPath, "utf8")).importantOnly).toBe(true);

    const closePath = fixture();
    const closeFailure = new VisualService({
      settingsPath: closePath,
      host: host({ availability: "available", installed: true, running: true }),
      settingsFault: (phase) => {
        if (phase === "before_coordination_close") throw new Error("coordination close failed");
      },
    });
    expect(closeFailure.configure({ launchAtLogin: true })).toMatchObject({
      ok: false,
      changed: true,
      error: { code: "settings_error", message: "coordination close failed" },
      status: { settings: { launchAtLogin: true } },
    });
    expect(JSON.parse(fs.readFileSync(closePath, "utf8")).launchAtLogin).toBe(true);

    const unchangedPath = fixture();
    const unchanged = new VisualService({
      settingsPath: unchangedPath,
      host: host({ availability: "available", installed: true, running: true }),
      settingsFault: (phase) => {
        if (phase === "before_coordination_commit") throw new Error("unchanged commit failed");
      },
    });
    expect(unchanged.enable()).toMatchObject({
      ok: false,
      changed: false,
      error: { code: "settings_error", message: "unchanged commit failed" },
    });
    expect(fs.existsSync(unchangedPath)).toBe(false);

    const unchangedClosePath = fixture();
    const unchangedClose = new VisualService({
      settingsPath: unchangedClosePath,
      host: host({ availability: "available", installed: true, running: true }),
      settingsFault: (phase) => {
        if (phase === "before_coordination_close") throw new Error("unchanged close failed");
      },
    });
    expect(unchangedClose.enable()).toMatchObject({
      ok: false,
      changed: false,
      error: { code: "settings_error", message: "unchanged close failed" },
    });
    expect(fs.existsSync(unchangedClosePath)).toBe(false);
  });

  it("validates snooze and keeps enable/disable idempotent", () => {
    let now = new Date("2026-07-25T12:00:00.000Z");
    const service = new VisualService({
      settingsPath: fixture(),
      host: host({ availability: "available", installed: true, running: true }),
      now: () => now,
    });
    expect(service.enable()).toMatchObject({ ok: true, changed: false });
    expect(service.disable()).toMatchObject({ ok: true, changed: true });
    expect(service.disable()).toMatchObject({ ok: true, changed: false });
    expect(service.snooze("15m")).toMatchObject({
      ok: true,
      status: { lifecycle: "running_disabled", settings: { signalsEnabled: false } },
    });
    now = new Date("2026-07-25T12:16:00.000Z");
    expect(service.status()).toMatchObject({
      ok: true,
      status: { lifecycle: "running_disabled", settings: { signalsEnabled: false } },
    });
    expect(service.snooze("0m")).toMatchObject({ ok: false, error: { code: "invalid_duration" } });
    expect(service.snooze("tomorrow")).toMatchObject({ ok: false, error: { code: "invalid_duration" } });
  });

  it("serializes two writers, reports bounded lock failure, and preserves unrelated updates", () => {
    const settingsPath = fixture();
    let nested: ReturnType<VisualService["disable"]> | undefined;
    const competing = new VisualService({
      settingsPath,
      host: host({ availability: "available", installed: true, running: true }),
      lockTimeoutMs: 10,
    });
    const first = new VisualService({
      settingsPath,
      host: host({ availability: "available", installed: true, running: true }),
      settingsFault: (phase) => {
        if (phase === "after_lock") nested = competing.disable();
      },
    });
    expect(first.configure({ importantOnly: true })).toMatchObject({ ok: true, changed: true });
    expect(nested).toMatchObject({ ok: false, error: { code: "settings_error" } });
    expect(competing.disable()).toMatchObject({ ok: true, changed: true });
    expect(first.status().status.settings).toMatchObject({
      importantOnly: true,
      signalsEnabled: false,
    });

  });

  it("allows two genuinely overlapping writers to succeed serially without lost updates", async () => {
    const settingsPath = fixture();
    const modulePath = path.join(path.dirname(settingsPath), "visual-service-worker.mjs");
    const sourcePath = path.resolve(import.meta.dirname, "../src/visual-service.ts");
    const adapterSourcePath = path.resolve(import.meta.dirname, "../src/macos-visual-host.ts");
    const adapterModulePath = path.join(path.dirname(settingsPath), "macos-visual-host.js");
    fs.writeFileSync(adapterModulePath, ts.transpileModule(
      fs.readFileSync(adapterSourcePath, "utf8"),
      {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      },
    ).outputText);
    const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText.replace(
      '"better-sqlite3"',
      JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("better-sqlite3")).href),
    );
    fs.writeFileSync(modulePath, transpiled);
    const moduleUrl = pathToFileURL(modulePath).href;
    const gate = new SharedArrayBuffer(4);
    const workerSource = `
      import { parentPort, workerData } from "node:worker_threads";
      import { VisualService } from ${JSON.stringify(moduleUrl)};
      const gate = new Int32Array(workerData.gate);
      const service = new VisualService({
        settingsPath: workerData.settingsPath,
        lockTimeoutMs: 1000,
        settingsFault: (phase) => {
          if (workerData.role !== "second" && phase === "after_lock") {
            parentPort.postMessage({ kind: "locked" });
            Atomics.wait(gate, 0, 0);
          }
          if (workerData.role === "second" && phase === "lock_contended") {
            parentPort.postMessage({ kind: "contended" });
          }
        },
      });
      const result = workerData.role === "first"
        ? service.configure({ importantOnly: true })
        : service.disable();
      parentPort.postMessage({ kind: "result", result });
    `;
    const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(workerSource)}`);
    const first = new Worker(workerUrl, { workerData: { gate, settingsPath, role: "first" } });
    const firstLocked = waitForWorkerMessage(first, "locked");
    const firstResult = waitForWorkerMessage(first, "result");
    await firstLocked;
    const second = new Worker(workerUrl, { workerData: { gate, settingsPath, role: "second" } });
    const secondContended = waitForWorkerMessage(second, "contended");
    const secondResult = waitForWorkerMessage(second, "result");
    await secondContended;
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    expect((await firstResult)["result"]).toMatchObject({ ok: true, changed: true });
    expect((await secondResult)["result"]).toMatchObject({ ok: true, changed: true });
    await Promise.all([first.terminate(), second.terminate()]);
    expect(new VisualService({ settingsPath }).status().status.settings).toMatchObject({
      importantOnly: true,
      signalsEnabled: false,
    });

    Atomics.store(new Int32Array(gate), 0, 0);
    const crasher = new Worker(workerUrl, { workerData: { gate, settingsPath, role: "crash" } });
    await waitForWorkerMessage(crasher, "locked");
    await crasher.terminate();
    expect(new VisualService({
      settingsPath,
      lockTimeoutMs: 100,
    }).configure({ launchAtLogin: true })).toMatchObject({ ok: true, changed: true });
  });

  it("only migrates the recognized complete legacy shape", () => {
    const validPath = fixture();
    fs.writeFileSync(validPath, JSON.stringify({
      enabled: false,
      importantOnly: true,
      launchAtLogin: false,
      positions: {},
    }));
    expect(new VisualService({ settingsPath: validPath }).status()).toMatchObject({
      ok: true,
      status: { settings: { signalsEnabled: false } },
    });

    for (const ambiguous of [
      { importantOnly: true },
      { enabled: false },
      { enabled: false, importantOnly: true, launchAtLogin: false },
      { enabled: false, importantOnly: true, launchAtLogin: false, positions: {}, mystery: true },
    ]) {
      const settingsPath = fixture();
      fs.writeFileSync(settingsPath, JSON.stringify(ambiguous));
      const before = fs.readFileSync(settingsPath, "utf8");
      expect(new VisualService({ settingsPath }).status()).toMatchObject({
        ok: false,
        error: { code: "settings_error" },
      });
      expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
    }
  });

  it("rejects malformed snooze timestamps and treats valid expired timestamps as enabled", () => {
    for (const snoozedUntil of ["tomorrow", "2026-07-25", "2026-07-25T12:00:00Z"]) {
      const settingsPath = fixture();
      fs.writeFileSync(settingsPath, JSON.stringify({
        schemaVersion: 1,
        signalsEnabled: true,
        importantOnly: false,
        snoozedUntil,
        launchAtLogin: false,
        displayPositions: {},
      }));
      expect(new VisualService({ settingsPath }).status()).toMatchObject({
        ok: false,
        error: { code: "settings_error" },
      });
    }
    const expiredPath = fixture();
    fs.writeFileSync(expiredPath, JSON.stringify({
      schemaVersion: 1,
      signalsEnabled: true,
      importantOnly: false,
      snoozedUntil: "2026-07-25T11:59:59.000Z",
      launchAtLogin: false,
      displayPositions: {},
    }));
    expect(new VisualService({
      settingsPath: expiredPath,
      host: host({ availability: "available", installed: true, running: true }),
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    }).status()).toMatchObject({
      ok: true,
      status: {
        lifecycle: "running_enabled",
        settings: { snoozedUntil: "2026-07-25T11:59:59.000Z" },
      },
    });
  });

  it("never claims open or quit without observed host evidence", () => {
    const service = new VisualService({
      settingsPath: fixture(),
      host: host({ availability: "available", installed: true, running: false }),
    });
    expect(service.open()).toMatchObject({ ok: false, command: "open", error: { code: "host_unavailable" } });
    expect(service.quit()).toMatchObject({ ok: false, command: "quit", error: { code: "host_unavailable" } });
  });

  it("compatibility-gates open, confirms the final version, and permits mismatched quit recovery", () => {
    let openCalls = 0;
    const mismatched = new VisualService({
      settingsPath: fixture(),
      host: {
        inspect: () => ({
          availability: "available",
          installed: true,
          running: true,
          version: "0.0.1",
        }),
        open: () => {
          openCalls += 1;
          return { outcome: "observed_running", evidence: [] };
        },
        quit: () => ({ outcome: "observed_stopped", evidence: [] }),
      },
    });
    expect(mismatched.open()).toMatchObject({
      ok: false,
      status: { lifecycle: "version_mismatch" },
      error: { code: "host_unavailable" },
    });
    expect(openCalls).toBe(0);

    let inspections = 0;
    const changedAfterLaunch = new VisualService({
      settingsPath: fixture(),
      host: {
        inspect: () => ({
          availability: "available",
          installed: true,
          running: inspections++ === 0 ? false : true,
          version: inspections === 1 ? SUPPORTED_VISUAL_HOST_VERSION : "0.0.1",
        }),
        open: () => ({ outcome: "observed_running", evidence: ["launch requested"] }),
        quit: () => ({ outcome: "observed_stopped", evidence: [] }),
      },
    });
    expect(changedAfterLaunch.open()).toMatchObject({
      ok: false,
      changed: false,
      status: { lifecycle: "version_mismatch" },
      error: { code: "host_unavailable" },
    });

    let running = true;
    let quitCalls = 0;
    const recoverMismatch = new VisualService({
      settingsPath: fixture(),
      host: {
        inspect: () => ({
          availability: "available",
          installed: true,
          running,
          version: "0.0.1",
        }),
        open: () => ({ outcome: "observed_running", evidence: [] }),
        quit: () => {
          quitCalls += 1;
          running = false;
          return { outcome: "observed_stopped", evidence: ["stopped mismatched host"] };
        },
      },
    });
    expect(recoverMismatch.quit()).toMatchObject({
      ok: true,
      changed: true,
      status: { lifecycle: "version_mismatch", host: { running: false } },
    });
    expect(quitCalls).toBe(1);
  });

  it("derives host-operation changed from the observed before/after transition", () => {
    let running = true;
    const adapter: VisualHostAdapter = {
      inspect: () => ({
        availability: "available",
        installed: true,
        running,
        version: SUPPORTED_VISUAL_HOST_VERSION,
      }),
      open: () => {
        const wasRunning = running;
        running = true;
        return { outcome: "observed_running", evidence: [wasRunning ? "already running" : "started"] };
      },
      quit: () => {
        const wasRunning = running;
        running = false;
        return { outcome: "observed_stopped", evidence: [wasRunning ? "stopped" : "already stopped"] };
      },
    };
    const service = new VisualService({ settingsPath: fixture(), host: adapter });
    expect(service.open()).toMatchObject({ ok: true, changed: false });
    expect(service.quit()).toMatchObject({ ok: true, changed: true });
    expect(service.quit()).toMatchObject({ ok: true, changed: false });
    expect(service.open()).toMatchObject({ ok: true, changed: true });
  });

  it("does not confirm quit or claim transitions from nullable running facts", () => {
    let inspections = 0;
    const unknownAfterQuit = new VisualService({
      settingsPath: fixture(),
      host: {
        inspect: () => {
          inspections += 1;
          return {
            availability: "available",
            installed: true,
            running: inspections === 1 ? true : null,
          };
        },
        open: () => ({ outcome: "observed_running", evidence: [] }),
        quit: () => ({ outcome: "observed_stopped", evidence: ["quit requested"] }),
      },
    });
    expect(unknownAfterQuit.quit()).toMatchObject({
      ok: false,
      changed: false,
      error: { code: "host_unavailable" },
      status: { lifecycle: "degraded", host: { running: null } },
    });

    inspections = 0;
    const unknownBeforeOpen = new VisualService({
      settingsPath: fixture(),
      host: {
        inspect: () => {
          inspections += 1;
          return {
            availability: "available",
            installed: true,
            running: inspections === 1 ? null : true,
          };
        },
        open: () => ({ outcome: "observed_running", evidence: ["open requested"] }),
        quit: () => ({ outcome: "observed_stopped", evidence: [] }),
      },
    });
    expect(unknownBeforeOpen.open()).toMatchObject({
      ok: false,
      changed: false,
      error: { code: "host_unavailable" },
      status: { lifecycle: "degraded" },
    });
  });

  it("does not confirm open from a contradictory uninstalled running observation", () => {
    let inspections = 0;
    const service = new VisualService({
      settingsPath: fixture(),
      host: {
        inspect: () => {
          inspections += 1;
          return inspections === 1
            ? { availability: "available", installed: false, running: false }
            : { availability: "available", installed: false, running: true };
        },
        open: () => ({ outcome: "observed_running", evidence: ["running observed"] }),
        quit: () => ({ outcome: "observed_stopped", evidence: [] }),
      },
    });
    expect(service.open()).toMatchObject({
      ok: false,
      changed: false,
      error: { code: "host_unavailable" },
      status: { lifecycle: "not_installed" },
    });
  });

  it("merges display updates without implicitly deleting other displays", () => {
    const service = new VisualService({
      settingsPath: fixture(),
      host: host({ availability: "available", installed: true, running: true }),
    });
    service.configure({
      displayPositions: {
        builtIn: { x: 1, y: 2 },
        external: { x: 3, y: 4 },
      },
    });
    const updated = service.configure({
      displayPositions: { external: { x: 30, y: 40 } },
    });
    expect(updated.status.settings.displayPositions).toEqual({
      builtIn: { x: 1, y: 2 },
      external: { x: 30, y: 40 },
    });
  });

  it("normalizes adapter action and inspection exceptions to host_unavailable", () => {
    const actionFailure = new VisualService({
      settingsPath: fixture(),
      host: {
        inspect: () => ({
          availability: "available",
          installed: true,
          running: false,
          version: SUPPORTED_VISUAL_HOST_VERSION,
        }),
        open: () => { throw new Error("launch failed"); },
        quit: () => ({ outcome: "observed_stopped", evidence: [] }),
      },
    });
    expect(actionFailure.open()).toMatchObject({
      ok: false,
      error: { code: "host_unavailable", message: "launch failed" },
      status: {
        lifecycle: "degraded",
        host: { availability: "degraded", installed: true, running: false },
      },
    });

    let inspections = 0;
    const inspectFailure = new VisualService({
      settingsPath: fixture(),
      host: {
        inspect: () => {
          inspections += 1;
          if (inspections === 1) {
            return { availability: "available", installed: true, running: true, version: "1.2.0", evidence: ["running"] };
          }
          throw new Error("probe failed");
        },
        open: () => ({ outcome: "observed_running", evidence: [] }),
        quit: () => ({ outcome: "observed_stopped", evidence: [] }),
      },
    });
    expect(inspectFailure.quit()).toMatchObject({
      ok: false,
      error: { code: "host_unavailable", message: "probe failed" },
      status: {
        lifecycle: "degraded",
        host: {
          availability: "degraded",
          installed: true,
          running: true,
          version: "1.2.0",
          evidence: ["running", "Visual host quit failed: probe failed"],
        },
      },
    });

    const noObservation = new VisualService({
      settingsPath: fixture(),
      host: {
        inspect: () => { throw new Error("probe failed immediately"); },
        open: () => ({ outcome: "observed_running", evidence: [] }),
        quit: () => ({ outcome: "observed_stopped", evidence: [] }),
      },
    });
    expect(noObservation.open()).toMatchObject({
      status: { host: { availability: "degraded", installed: null, running: null } },
    });
  });

  it("creates private settings paths, preserves existing directory modes, and reaches directory fsync", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-visual-mode-"));
    roots.push(root);
    const privateDirectory = path.join(root, "new", "nested");
    const settingsPath = path.join(privateDirectory, "settings.json");
    let directorySynced = false;
    const service = new VisualService({
      settingsPath,
      host: host({ availability: "available", installed: true, running: true }),
      settingsFault: (phase) => {
        if (phase === "after_directory_fsync") directorySynced = true;
      },
    });
    expect(service.disable().ok).toBe(true);
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(privateDirectory).mode & 0o777).toBe(0o700);
    expect(directorySynced).toBe(true);

    const existingDirectory = path.join(root, "existing");
    fs.mkdirSync(existingDirectory, { mode: 0o755 });
    const existingMode = fs.statSync(existingDirectory).mode & 0o777;
    const existing = new VisualService({
      settingsPath: path.join(existingDirectory, "settings.json"),
      host: host({ availability: "available", installed: true, running: true }),
    });
    expect(existing.disable().ok).toBe(true);
    expect(fs.statSync(existingDirectory).mode & 0o777).toBe(existingMode);
  });

  it("returns typed settings errors for oversized and symlinked JSON", () => {
    const oversized = fixture();
    fs.writeFileSync(oversized, Buffer.alloc(1_048_577, 0x20), { mode: 0o600 });
    expect(new VisualService({
      settingsPath: oversized,
      host: host({ availability: "available", installed: true, running: true }),
    }).status()).toMatchObject({
      ok: false,
      error: { code: "settings_error" },
      status: { lifecycle: "degraded" },
    });

    const link = fixture();
    const target = `${link}.target`;
    fs.writeFileSync(target, JSON.stringify({
      schemaVersion: 1,
      signalsEnabled: true,
      importantOnly: false,
      snoozedUntil: null,
      launchAtLogin: false,
      displayPositions: {},
    }), { mode: 0o600 });
    fs.symlinkSync(target, link);
    expect(new VisualService({
      settingsPath: link,
      host: host({ availability: "available", installed: true, running: true }),
    }).status()).toMatchObject({
      ok: false,
      error: { code: "settings_error" },
    });
  });
});
