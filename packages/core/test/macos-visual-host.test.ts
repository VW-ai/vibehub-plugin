import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INTERNAL_VISUAL_HOST_QUIT_ARG,
  INTERNAL_VISUAL_HOST_SHOW_ARG,
  MacOSVisualHostAdapter,
  normalizeExpectedVisualHostVersion,
  normalizeMacOSVisualHostOptions,
  type MacOSVisualHostOps,
} from "../src/macos-visual-host.js";
import {
  defaultVisualHostAdapter,
  type VisualHostAdapter,
} from "../src/visual-service.js";

const HOME_APP = "/Users/tester/Applications/VibeHub.app";
const SYSTEM_APP = "/Applications/VibeHub.app";
const EXECUTABLE = path.join(HOME_APP, "Contents", "MacOS", "vibehub-visual-host");
const SYSTEM_EXECUTABLE = path.join(SYSTEM_APP, "Contents", "MacOS", "vibehub-visual-host");
const INFO_PLIST = path.join(HOME_APP, "Contents", "Info.plist");
const SYSTEM_INFO_PLIST = path.join(SYSTEM_APP, "Contents", "Info.plist");

function plist(
  version = "0.1.0",
  identifier = "ai.vibehub.visual",
  executable = "vibehub-visual-host",
): string {
  return `<?xml version="1.0"?><plist><dict>
    <key>CFBundleIdentifier</key><string>${identifier}</string>
    <key>CFBundleExecutable</key><string>${executable}</string>
    <key>CFBundleShortVersionString</key><string>${version}</string>
  </dict></plist>`;
}

function plistField(contents: string, key: string): string {
  const match = contents.match(
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "u"),
  );
  return match?.[1] ?? "";
}

function fakeOps(overrides: Partial<MacOSVisualHostOps> = {}): MacOSVisualHostOps {
  return {
    platform: "darwin",
    arch: "arm64",
    env: {},
    homeDirectory: "/Users/tester",
    pathKind: (candidate) => {
      if (candidate === HOME_APP) return "directory";
      if (candidate === EXECUTABLE || candidate === INFO_PLIST) return "file";
      return null;
    },
    readPlistValue: (_candidate, key) => plistField(plist(), key),
    runProcess: (executable) => executable === "/bin/ps"
      ? { status: 0, stdout: `${EXECUTABLE}\n`, stderr: "" }
      : { status: 0, stdout: "", stderr: "" },
    sleep: () => {},
    now: () => 0,
    ...overrides,
  };
}

describe("MacOSVisualHostAdapter", () => {
  it("normalizes absent and blank expected versions to the shared supported version", () => {
    expect(normalizeExpectedVisualHostVersion(undefined)).toBe("0.1.0");
    expect(normalizeExpectedVisualHostVersion("")).toBe("0.1.0");
    expect(normalizeExpectedVisualHostVersion(" \t ")).toBe("0.1.0");
    expect(normalizeExpectedVisualHostVersion(" 1.2.3 ")).toBe("1.2.3");
  });

  it("selects the macOS adapter only for the darwin production default", () => {
    const marker: VisualHostAdapter = {
      inspect: () => ({ availability: "available", installed: false, running: false }),
      open: () => ({ outcome: "unavailable", evidence: [] }),
      quit: () => ({ outcome: "unavailable", evidence: [] }),
    };
    expect(defaultVisualHostAdapter("darwin", marker)).toBe(marker);
    expect(defaultVisualHostAdapter("linux", marker).inspect()).toMatchObject({
      availability: "unavailable",
      installed: null,
      running: null,
    });
    expect(new MacOSVisualHostAdapter({
      ops: fakeOps({ platform: "linux" }),
    }).open()).toMatchObject({ outcome: "unavailable" });
    expect(new MacOSVisualHostAdapter({
      ops: fakeOps({ platform: "linux" }),
    }).quit()).toMatchObject({ outcome: "unavailable" });
    expect(new MacOSVisualHostAdapter({
      ops: fakeOps({ arch: "x64" }),
    }).inspect()).toMatchObject({ availability: "unavailable", running: null });
  });

  it("uses exact candidate order and reports bundle, plist version, platform, arch, and exact process evidence", () => {
    const override = "/Volumes/Preview/VibeHub.app";
    const visited: string[] = [];
    const adapter = new MacOSVisualHostAdapter({
      ops: fakeOps({
        env: { VIBEHUB_VISUAL_APP_PATH: override },
        pathKind: (candidate) => {
          visited.push(candidate);
          if (candidate === HOME_APP) return "directory";
          if (candidate === EXECUTABLE || candidate === INFO_PLIST) return "file";
          return null;
        },
      }),
    });

    expect(adapter.inspect()).toMatchObject({
      availability: "available",
      installed: true,
      running: true,
      version: "0.1.0",
      platform: "darwin",
      arch: "arm64",
    });
    expect(visited[0]).toBe(override);
    expect(visited).toContain(HOME_APP);
    expect(visited).toContain(SYSTEM_APP);
    expect(visited.filter((candidate) => candidate.endsWith("VibeHub.app"))).toEqual([
      override,
      HOME_APP,
      SYSTEM_APP,
    ]);
  });

  it("does not confuse a substring process match with the exact bundle executable", () => {
    const adapter = new MacOSVisualHostAdapter({
      ops: fakeOps({
        runProcess: (executable) => executable === "/bin/ps"
          ? { status: 0, stdout: `${EXECUTABLE}-helper\n/tmp${EXECUTABLE}\n`, stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
      }),
    });
    expect(adapter.inspect()).toMatchObject({ installed: true, running: false });
  });

  it("never merges the selected bundle version with another installed app process", () => {
    const adapter = new MacOSVisualHostAdapter({
      ops: fakeOps({
        pathKind: (candidate) => {
          if (candidate === HOME_APP || candidate === SYSTEM_APP) return "directory";
          if ([
            EXECUTABLE,
            SYSTEM_EXECUTABLE,
            INFO_PLIST,
            SYSTEM_INFO_PLIST,
          ].includes(candidate)) return "file";
          return null;
        },
        readPlistValue: (candidate, key) => plistField(
          candidate === INFO_PLIST ? plist("1.2.3") : plist("9.9.9"),
          key,
        ),
        runProcess: (executable) => executable === "/bin/ps"
          ? { status: 0, stdout: `${SYSTEM_EXECUTABLE}\n`, stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
      }),
    });

    const observation = adapter.inspect();
    expect(observation).toMatchObject({
      availability: "degraded",
      installed: true,
      version: "1.2.3",
      running: null,
    });
    expect(observation.evidence?.join("\n")).toContain("conflicting installed visual host");
    expect(observation.evidence?.join("\n")).toContain(SYSTEM_EXECUTABLE);
    expect(observation.evidence?.join("\n")).toContain("Info.plist version 9.9.9");
  });

  it("binds selected running evidence to the selected exact executable", () => {
    const adapter = new MacOSVisualHostAdapter({
      ops: fakeOps({
        pathKind: (candidate) => {
          if (candidate === HOME_APP || candidate === SYSTEM_APP) return "directory";
          if ([
            EXECUTABLE,
            SYSTEM_EXECUTABLE,
            INFO_PLIST,
            SYSTEM_INFO_PLIST,
          ].includes(candidate)) return "file";
          return null;
        },
        readPlistValue: (candidate, key) => plistField(
          candidate === INFO_PLIST ? plist("1.2.3") : plist("9.9.9"),
          key,
        ),
        runProcess: (executable) => executable === "/bin/ps"
          ? { status: 0, stdout: `${EXECUTABLE}\n`, stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
      }),
    });
    expect(adapter.inspect()).toMatchObject({
      availability: "available",
      installed: true,
      version: "1.2.3",
      running: true,
    });
  });

  it("degrades unknown installation, version, and process observations instead of inventing false", () => {
    const unknownInstall = new MacOSVisualHostAdapter({
      ops: fakeOps({
        pathKind: () => { throw new Error("stat denied"); },
        runProcess: () => ({ status: null, stdout: "", stderr: "ps denied" }),
      }),
    }).inspect();
    expect(unknownInstall).toMatchObject({
      availability: "degraded",
      installed: null,
      running: null,
    });

    const unknownVersionAndProcess = new MacOSVisualHostAdapter({
      ops: fakeOps({
        readPlistValue: () => { throw new Error("plist denied"); },
        runProcess: () => ({ status: null, stdout: "", stderr: "ps denied" }),
      }),
    }).inspect();
    expect(unknownVersionAndProcess).toMatchObject({
      availability: "degraded",
      installed: null,
      running: null,
    });
    expect(unknownVersionAndProcess.version).toBeUndefined();
  });

  it.each([
    ["wrong identifier", plist("0.1.0", "com.example.other", "vibehub-visual-host")],
    ["wrong executable", plist("0.1.0", "ai.vibehub.visual", "other-host")],
    ["missing version", plist("", "ai.vibehub.visual", "vibehub-visual-host")],
  ])("never launches a bundle with %s", (_label, contents) => {
    let launches = 0;
    const adapter = new MacOSVisualHostAdapter({
      ops: fakeOps({
        readPlistValue: (_candidate, key) => plistField(contents, key),
        runProcess: (executable) => {
          if (executable === "/usr/bin/open") launches += 1;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    });
    expect(adapter.inspect()).toMatchObject({ availability: "degraded", installed: null });
    expect(adapter.open()).toMatchObject({ outcome: "unavailable" });
    expect(launches).toBe(0);
  });

  it("blocks version-mismatched and identity-ambiguous launches before /usr/bin/open", () => {
    let launches = 0;
    const mismatch = new MacOSVisualHostAdapter({
      ops: fakeOps({
        readPlistValue: (_candidate, key) => plistField(plist("9.9.9"), key),
        runProcess: (executable) => {
          if (executable === "/usr/bin/open") launches += 1;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    });
    expect(mismatch.open()).toMatchObject({ outcome: "unavailable" });

    const override = "/Unreadable/VibeHub.app";
    const ambiguous = new MacOSVisualHostAdapter({
      ops: fakeOps({
        env: { VIBEHUB_VISUAL_APP_PATH: override },
        pathKind: (candidate) => {
          if (candidate === override) throw new Error("override denied");
          if (candidate === HOME_APP) return "directory";
          if (candidate === EXECUTABLE || candidate === INFO_PLIST) return "file";
          return null;
        },
        runProcess: (executable) => {
          if (executable === "/usr/bin/open") launches += 1;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    });
    expect(ambiguous.inspect()).toMatchObject({
      availability: "degraded",
      installed: true,
      version: "0.1.0",
    });
    expect(ambiguous.open()).toMatchObject({ outcome: "unavailable" });
    expect(launches).toBe(0);
  });

  it.each([
    ["empty environment", "", undefined, "0.1.0"],
    ["whitespace environment", " \t ", undefined, "0.1.0"],
    ["blank explicit option", "9.9.9", " ", "0.1.0"],
    ["trimmed explicit option", undefined, " 1.2.3 ", "1.2.3"],
  ])("uses one normalized version for %s", (_label, environment, option, bundleVersion) => {
    let launches = 0;
    const adapter = new MacOSVisualHostAdapter({
      ...(option === undefined ? {} : { expectedHostVersion: option }),
      ops: fakeOps({
        env: environment === undefined
          ? {}
          : { VIBEHUB_VISUAL_HOST_VERSION: environment },
        readPlistValue: (_candidate, key) => plistField(plist(bundleVersion), key),
        runProcess: (executable) => {
          if (executable === "/usr/bin/open") launches += 1;
          return executable === "/bin/ps"
            ? { status: 0, stdout: `${EXECUTABLE}\n`, stderr: "" }
            : { status: 0, stdout: "", stderr: "" };
        },
      }),
    });
    expect(adapter.open()).toMatchObject({ outcome: "observed_running" });
    expect(launches).toBe(1);
  });

  it("opens the exact app with only the typed show arg and waits for observed running", () => {
    const launches: Array<{ executable: string; args: string[] }> = [];
    let probes = 0;
    const adapter = new MacOSVisualHostAdapter({
      pollAttempts: 3,
      pollIntervalMs: 5,
      ops: fakeOps({
        runProcess: (executable, args) => {
          if (executable === "/bin/ps") {
            probes += 1;
            return {
              status: 0,
              stdout: probes >= 3 ? `${EXECUTABLE}\n` : "",
              stderr: "",
            };
          }
          launches.push({ executable, args: [...args] });
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    });

    expect(adapter.open()).toMatchObject({ outcome: "observed_running" });
    expect(launches).toEqual([{
      executable: "/usr/bin/open",
      args: ["-n", HOME_APP, "--args", INTERNAL_VISUAL_HOST_SHOW_ARG],
    }]);
  });

  it("times out without claiming observed running", () => {
    const sleeps: number[] = [];
    const adapter = new MacOSVisualHostAdapter({
      pollAttempts: 2,
      pollIntervalMs: 7,
      ops: fakeOps({
        runProcess: (executable) => executable === "/bin/ps"
          ? { status: 0, stdout: "", stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
        sleep: (milliseconds) => sleeps.push(milliseconds),
      }),
    });
    const result = adapter.open();
    expect(result).toMatchObject({ outcome: "failed" });
    expect(result.evidence.filter((line) =>
      line.includes("Timed out without observing visual host running")
    )).toHaveLength(1);
    expect(sleeps).toEqual([7]);
  });

  it("normalizes every polling and subprocess bound to finite min/max values", () => {
    expect(normalizeMacOSVisualHostOptions({
      pollAttempts: Number.NaN,
      pollIntervalMs: Number.NaN,
      processTimeoutMs: Number.NaN,
      actionDeadlineMs: Number.NaN,
    })).toEqual({
      pollAttempts: 20,
      pollIntervalMs: 100,
      processTimeoutMs: 1_000,
      actionDeadlineMs: 5_000,
    });
    expect(normalizeMacOSVisualHostOptions({
      pollAttempts: -10,
      pollIntervalMs: -10,
      processTimeoutMs: -10,
      actionDeadlineMs: -10,
    })).toEqual({
      pollAttempts: 1,
      pollIntervalMs: 0,
      processTimeoutMs: 50,
      actionDeadlineMs: 100,
    });
    expect(normalizeMacOSVisualHostOptions({
      pollAttempts: Number.POSITIVE_INFINITY,
      pollIntervalMs: Number.POSITIVE_INFINITY,
      processTimeoutMs: Number.POSITIVE_INFINITY,
      actionDeadlineMs: Number.POSITIVE_INFINITY,
    })).toEqual({
      pollAttempts: 50,
      pollIntervalMs: 500,
      processTimeoutMs: 2_000,
      actionDeadlineMs: 15_000,
    });
    expect(normalizeMacOSVisualHostOptions({
      pollAttempts: 1_000_000,
      pollIntervalMs: 1_000_000,
      processTimeoutMs: 1_000_000,
      actionDeadlineMs: 1_000_000,
    })).toEqual({
      pollAttempts: 50,
      pollIntervalMs: 500,
      processTimeoutMs: 2_000,
      actionDeadlineMs: 15_000,
    });
  });

  it("caps the entire synchronous action and exits immediately on degraded polling", () => {
    let now = 0;
    const calls: Array<{ executable: string; timeoutMs: number }> = [];
    const sleeps: number[] = [];
    const adapter = new MacOSVisualHostAdapter({
      actionDeadlineMs: 5_000,
      processTimeoutMs: 2_000,
      pollAttempts: 50,
      ops: fakeOps({
        now: () => now,
        sleep: (milliseconds) => {
          sleeps.push(milliseconds);
          now += milliseconds;
        },
        runProcess: (executable, _args, timeoutMs) => {
          calls.push({ executable, timeoutMs });
          if (executable === "/usr/bin/open") {
            now = 4_500;
            return { status: 0, stdout: "", stderr: "" };
          }
          now = 5_000;
          return { status: null, stdout: "", stderr: "ETIMEDOUT" };
        },
      }),
    });
    expect(adapter.open()).toMatchObject({ outcome: "failed" });
    expect(calls).toEqual([
      { executable: "/usr/bin/open", timeoutMs: 2_000 },
      { executable: "/bin/ps", timeoutMs: 500 },
    ]);
    expect(sleeps).toEqual([]);
    expect(now).toBeLessThanOrEqual(5_000);
  });

  it("bounds filesystem identity observations and schedules nothing after the action deadline", () => {
    let now = 0;
    const identityCalls: Array<{ kind: string; timeoutMs: number }> = [];
    let launches = 0;
    const statTimeout = new MacOSVisualHostAdapter({
      actionDeadlineMs: 100,
      processTimeoutMs: 2_000,
      ops: fakeOps({
        now: () => now,
        pathKind: (_candidate, timeoutMs) => {
          identityCalls.push({ kind: "stat", timeoutMs });
          now += timeoutMs;
          throw new Error("stat ETIMEDOUT");
        },
        runProcess: (executable) => {
          if (executable === "/usr/bin/open") launches += 1;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    });
    expect(statTimeout.open()).toMatchObject({ outcome: "unavailable" });
    expect(identityCalls).toEqual([{ kind: "stat", timeoutMs: 100 }]);
    expect(launches).toBe(0);
    expect(now).toBe(100);

    now = 0;
    identityCalls.length = 0;
    const plistTimeout = new MacOSVisualHostAdapter({
      actionDeadlineMs: 100,
      processTimeoutMs: 2_000,
      ops: fakeOps({
        now: () => now,
        pathKind: (_candidate, timeoutMs) => {
          identityCalls.push({ kind: "stat", timeoutMs });
          return identityCalls.length === 1 ? "directory" : "file";
        },
        readPlistValue: (_candidate, _key, timeoutMs) => {
          identityCalls.push({ kind: "plist", timeoutMs });
          now += timeoutMs;
          throw new Error("plutil ETIMEDOUT");
        },
        runProcess: (executable) => {
          if (executable === "/usr/bin/open") launches += 1;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    });
    expect(plistTimeout.open()).toMatchObject({ outcome: "unavailable" });
    expect(identityCalls).toEqual([
      { kind: "stat", timeoutMs: 100 },
      { kind: "stat", timeoutMs: 100 },
      { kind: "plist", timeoutMs: 100 },
    ]);
    expect(launches).toBe(0);
    expect(now).toBe(100);
  });

  it("keeps process matching linear and degrades alias-like paths without realpath probes", () => {
    let pathObservations = 0;
    const unrelated = Array.from(
      { length: 10_000 },
      (_, index) => `/tmp/process-${index}`,
    );
    const adapter = new MacOSVisualHostAdapter({
      ops: fakeOps({
        pathKind: (candidate) => {
          pathObservations += 1;
          if (candidate === HOME_APP) return "directory";
          if (candidate === EXECUTABLE) return "file";
          return null;
        },
        runProcess: (executable) => executable === "/bin/ps"
          ? {
              status: 0,
              stdout: [...unrelated, "/tmp/alias/vibehub-visual-host"].join("\n"),
              stderr: "",
            }
          : { status: 0, stdout: "", stderr: "" },
      }),
    });
    expect(adapter.inspect()).toMatchObject({
      availability: "degraded",
      installed: true,
      running: false,
    });
    expect(pathObservations).toBe(3);
  });

  it("passes the normalized finite timeout to every ps and open subprocess", () => {
    const calls: Array<{ executable: string; timeoutMs: number | undefined }> = [];
    const adapter = new MacOSVisualHostAdapter({
      pollAttempts: -1,
      processTimeoutMs: Number.POSITIVE_INFINITY,
      ops: fakeOps({
        runProcess: (executable, _args, timeoutMs) => {
          calls.push({ executable, timeoutMs });
          return { status: executable === "/usr/bin/open" ? 0 : 0, stdout: "", stderr: "" };
        },
      }),
    });
    expect(adapter.open()).toMatchObject({ outcome: "failed" });
    expect(calls).toEqual([
      { executable: "/usr/bin/open", timeoutMs: 2_000 },
      { executable: "/bin/ps", timeoutMs: 2_000 },
    ]);
  });

  it("treats subprocess timeout/error results as degraded or failed, never observed success", () => {
    const timedOutInspect = new MacOSVisualHostAdapter({
      ops: fakeOps({
        runProcess: () => ({ status: null, stdout: `${EXECUTABLE}\n`, stderr: "ETIMEDOUT" }),
      }),
    }).inspect();
    expect(timedOutInspect).toMatchObject({ availability: "degraded", running: null });

    const timedOutOpen = new MacOSVisualHostAdapter({
      ops: fakeOps({
        runProcess: (executable) => executable === "/usr/bin/open"
          ? { status: null, stdout: "", stderr: "ETIMEDOUT" }
          : { status: 0, stdout: `${EXECUTABLE}\n`, stderr: "" },
      }),
    }).open();
    expect(timedOutOpen).toMatchObject({ outcome: "failed" });
    expect(timedOutOpen.evidence.join("\n")).toContain("ETIMEDOUT");
  });

  it("returns observed stopped without launching when the exact process is already absent", () => {
    let launches = 0;
    const adapter = new MacOSVisualHostAdapter({
      ops: fakeOps({
        runProcess: (executable) => {
          if (executable === "/usr/bin/open") launches += 1;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    });
    expect(adapter.quit()).toMatchObject({ outcome: "observed_stopped" });
    expect(launches).toBe(0);
  });

  it("quits through a forced exact second instance and waits for observed stopped", () => {
    const launches: Array<{ executable: string; args: string[] }> = [];
    let running = true;
    const adapter = new MacOSVisualHostAdapter({
      pollAttempts: 2,
      ops: fakeOps({
        runProcess: (executable, args) => {
          if (executable === "/bin/ps") {
            return { status: 0, stdout: running ? `${EXECUTABLE}\n` : "", stderr: "" };
          }
          launches.push({ executable, args: [...args] });
          running = false;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    });

    expect(adapter.quit()).toMatchObject({ outcome: "observed_stopped" });
    expect(launches).toEqual([{
      executable: "/usr/bin/open",
      args: ["-n", HOME_APP, "--args", INTERNAL_VISUAL_HOST_QUIT_ARG],
    }]);
  });
});
