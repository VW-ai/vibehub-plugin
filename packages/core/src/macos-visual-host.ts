import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type {
  VisualHostActionObservation,
  VisualHostAdapter,
} from "./visual-service.js";
import type { VisualHostObservation } from "./contract/visual.js";

export const INTERNAL_VISUAL_HOST_SHOW_ARG = "--vibehub-internal-show-v1";
export const INTERNAL_VISUAL_HOST_QUIT_ARG = "--vibehub-internal-quit-v1";
export const SUPPORTED_VISUAL_HOST_VERSION = "0.1.0";

const APP_NAME = "VibeHub.app";
const BUNDLE_IDENTIFIER = "ai.vibehub.visual";
const EXECUTABLE_NAME = "vibehub-visual-host";
const OPEN_EXECUTABLE = "/usr/bin/open";
const PS_EXECUTABLE = "/bin/ps";

export interface ProcessRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface MacOSVisualHostOps {
  platform: string;
  arch: string;
  env: Readonly<Record<string, string | undefined>>;
  homeDirectory: string;
  pathKind(candidate: string, timeoutMs: number): "file" | "directory" | null;
  readPlistValue(candidate: string, key: string, timeoutMs: number): string;
  runProcess(executable: string, args: readonly string[], timeoutMs: number): ProcessRunResult;
  sleep(milliseconds: number): void;
  now(): number;
}

export interface MacOSVisualHostAdapterOptions {
  ops?: MacOSVisualHostOps;
  pollAttempts?: number;
  pollIntervalMs?: number;
  processTimeoutMs?: number;
  actionDeadlineMs?: number;
  expectedHostVersion?: string;
}

export interface NormalizedMacOSVisualHostOptions {
  pollAttempts: number;
  pollIntervalMs: number;
  processTimeoutMs: number;
  actionDeadlineMs: number;
}

interface InstallationObservation {
  installed: boolean | null;
  appPath?: string;
  executablePath?: string;
  candidateExecutables: string[];
  observedInstallations: Array<{
    appPath: string;
    executablePath: string;
    version?: string;
  }>;
  version?: string;
  degraded: boolean;
  evidence: string[];
}

const defaultOps: MacOSVisualHostOps = {
  platform: process.platform,
  arch: process.arch,
  env: process.env,
  homeDirectory: os.homedir(),
  pathKind: (candidate, timeoutMs) => {
    const result = runNativeProcess(
      "/usr/bin/stat",
      ["-f", "%HT", candidate],
      timeoutMs,
    );
    if (result.status !== 0) {
      if (/no such file or directory/iu.test(result.stderr)) return null;
      throw new Error(result.stderr.trim() || `stat exited with status ${String(result.status)}`);
    }
    const kind = result.stdout.trim();
    if (kind === "Directory") return "directory";
    if (kind === "Regular File") return "file";
    throw new Error(`stat observed unsupported path kind ${kind || "unknown"}`);
  },
  readPlistValue: (candidate, key, timeoutMs) => {
    const result = runNativeProcess(
      "/usr/bin/plutil",
      ["-extract", key, "raw", "-o", "-", candidate],
      timeoutMs,
    );
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || `plutil exited with status ${String(result.status)}`);
    }
    return result.stdout.trim();
  },
  runProcess: runNativeProcess,
  sleep: (milliseconds) => {
    if (milliseconds <= 0) return;
    const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    Atomics.wait(signal, 0, 0, milliseconds);
  },
  now: () => performance.now(),
};

export class MacOSVisualHostAdapter implements VisualHostAdapter {
  readonly #ops: MacOSVisualHostOps;
  readonly #pollAttempts: number;
  readonly #pollIntervalMs: number;
  readonly #processTimeoutMs: number;
  readonly #actionDeadlineMs: number;
  readonly #expectedHostVersion: string;

  constructor(options: MacOSVisualHostAdapterOptions = {}) {
    this.#ops = options.ops ?? defaultOps;
    const normalized = normalizeMacOSVisualHostOptions(options);
    this.#pollAttempts = normalized.pollAttempts;
    this.#pollIntervalMs = normalized.pollIntervalMs;
    this.#processTimeoutMs = normalized.processTimeoutMs;
    this.#actionDeadlineMs = normalized.actionDeadlineMs;
    this.#expectedHostVersion = normalizeExpectedVisualHostVersion(
      options.expectedHostVersion ?? this.#ops.env["VIBEHUB_VISUAL_HOST_VERSION"],
    );
  }

  inspect(): VisualHostObservation {
    return this.#inspect();
  }

  #inspect(deadline?: number): VisualHostObservation {
    if (this.#ops.platform !== "darwin" || this.#ops.arch !== "arm64") {
      return {
        availability: "unavailable",
        installed: null,
        running: null,
        platform: this.#ops.platform,
        arch: this.#ops.arch,
        evidence: [
          `Adapter runtime observed platform ${this.#ops.platform} and architecture ${this.#ops.arch}.`,
          "The macOS visual host adapter is unavailable on this platform.",
        ],
      };
    }

    const installation = this.#inspectInstallation(deadline);
    let running: boolean | null = null;
    let processDegraded = false;
    const evidence = [
      `Adapter runtime observed platform ${this.#ops.platform} and architecture ${this.#ops.arch}.`,
      ...installation.evidence,
    ];
    try {
      if (deadline !== undefined && this.#remaining(deadline) <= 0) {
        throw new Error("action deadline expired before process observation");
      }
      const result = this.#ops.runProcess(
        PS_EXECUTABLE,
        ["-axo", "comm="],
        this.#subprocessTimeout(deadline),
      );
      if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `ps exited with status ${String(result.status)}`);
      }
      const observedExecutables = result.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
      const observedPaths = new Set(observedExecutables.map((candidate) => path.resolve(candidate)));
      const candidatePaths = new Set(
        installation.candidateExecutables.map((candidate) => path.resolve(candidate)),
      );
      const runningCandidates = installation.candidateExecutables.filter((candidate) =>
        observedPaths.has(path.resolve(candidate))
      );
      const ambiguousAliases = observedExecutables.filter((candidate) =>
        path.basename(candidate) === EXECUTABLE_NAME
        && !candidatePaths.has(path.resolve(candidate))
      );
      if (ambiguousAliases.length > 0) {
        processDegraded = true;
        evidence.push(
          `Observed ambiguous visual host executable path(s): ${ambiguousAliases.join(", ")}.`,
        );
      }
      if (installation.executablePath) {
        const selectedRunning = runningCandidates.some((candidate) =>
          this.#sameExecutable(installation.executablePath!, candidate)
        );
        const conflicting = runningCandidates.filter((candidate) =>
          !this.#sameExecutable(installation.executablePath!, candidate)
        );
        if (!selectedRunning && conflicting.length > 0) {
          running = null;
          processDegraded = true;
          evidence.push(this.#conflictingInstallEvidence(
            conflicting,
            installation,
            `while selected executable ${installation.executablePath} was not running`,
          ));
        } else {
          running = selectedRunning;
          evidence.push(selectedRunning
            ? `Exact selected visual host executable process observed at ${installation.executablePath}.`
            : `No exact selected visual host executable process was observed at ${installation.executablePath}.`);
          if (conflicting.length > 0) {
            processDegraded = true;
            evidence.push(this.#conflictingInstallEvidence(
              conflicting,
              installation,
              `alongside selected executable ${installation.executablePath}`,
            ));
          }
        }
      } else if (runningCandidates.length > 0) {
        running = null;
        processDegraded = true;
        evidence.push(
          `Observed conflicting visual host executable without a selected installed bundle: ${runningCandidates.join(", ")}.`,
        );
      } else {
        running = installation.installed === false ? false : null;
        evidence.push("No exact selected visual host executable process was observed.");
      }
    } catch (error) {
      processDegraded = true;
      evidence.push(`Exact process observation failed: ${errorMessage(error)}`);
    }

    const degraded = installation.degraded
      || processDegraded
      || installation.installed === null
      || (installation.installed === true && installation.version === undefined)
      || (installation.installed === false && running === true);
    return {
      availability: degraded ? "degraded" : "available",
      installed: installation.installed,
      running,
      ...(installation.version ? { version: installation.version } : {}),
      platform: this.#ops.platform,
      arch: this.#ops.arch,
      evidence,
    };
  }

  open(): VisualHostActionObservation {
    if (this.#ops.platform !== "darwin" || this.#ops.arch !== "arm64") {
      return {
        outcome: "unavailable",
        evidence: ["The macOS visual host adapter cannot launch on this platform."],
      };
    }
    const deadline = this.#ops.now() + this.#actionDeadlineMs;
      const installation = this.#inspectInstallation(deadline);
    if (
      installation.installed !== true
      || installation.degraded
      || !installation.appPath
      || installation.version !== this.#expectedHostVersion
    ) {
      return {
        outcome: "unavailable",
        evidence: [
          ...installation.evidence,
          installation.version && installation.version !== this.#expectedHostVersion
            ? `Visual host version ${installation.version} is incompatible with supported version ${this.#expectedHostVersion}.`
            : "No trusted, unambiguous, compatible visual host app was observed.",
        ],
      };
    }
    const launch = this.#launch(installation.appPath, INTERNAL_VISUAL_HOST_SHOW_ARG, deadline);
    if (launch) return launch;
    return this.#pollFor(
      true,
      "observed_running",
      `Show request launched for exact app ${installation.appPath}.`,
      deadline,
    );
  }

  quit(): VisualHostActionObservation {
    if (this.#ops.platform !== "darwin" || this.#ops.arch !== "arm64") {
      return {
        outcome: "unavailable",
        evidence: ["The macOS visual host adapter cannot quit on this platform."],
      };
    }
    const deadline = this.#ops.now() + this.#actionDeadlineMs;
    const before = this.#inspect(deadline);
    if (before.running === false) {
      return {
        outcome: "observed_stopped",
        evidence: [...(before.evidence ?? []), "Exact visual host process was already absent."],
      };
    }
    if (before.running !== true) {
      return {
        outcome: "failed",
        evidence: [...(before.evidence ?? []), "Quit was not sent because running state is unknown."],
      };
    }
    const installation = this.#inspectInstallation(deadline);
    if (installation.installed !== true || installation.degraded || !installation.appPath) {
      return {
        outcome: "unavailable",
        evidence: [...installation.evidence, "No exact app was available to relay quit."],
      };
    }
    const launch = this.#launch(installation.appPath, INTERNAL_VISUAL_HOST_QUIT_ARG, deadline);
    if (launch) return launch;
    return this.#pollFor(
      false,
      "observed_stopped",
      `Quit request launched through a forced instance of exact app ${installation.appPath}.`,
      deadline,
    );
  }

  #pollFor(
    expectedRunning: boolean,
    outcome: "observed_running" | "observed_stopped",
    launchEvidence: string,
    deadline: number,
  ): VisualHostActionObservation {
    let last: VisualHostObservation | undefined;
    for (let attempt = 0; attempt < this.#pollAttempts; attempt += 1) {
      if (this.#remaining(deadline) <= 0) break;
      last = this.#inspect(deadline);
      if (last.availability !== "unavailable" && last.running === expectedRunning) {
        return { outcome, evidence: [launchEvidence, ...(last.evidence ?? [])] };
      }
      if (
        last.availability !== "available"
        || last.running === null
        || attempt + 1 >= this.#pollAttempts
      ) break;
      const sleepFor = Math.min(this.#pollIntervalMs, this.#remaining(deadline));
      if (sleepFor <= 0) break;
      this.#ops.sleep(sleepFor);
    }
    return {
      outcome: "failed",
      evidence: [
        launchEvidence,
        ...(last?.evidence ?? []),
        `Timed out without observing visual host ${expectedRunning ? "running" : "stopped"}.`,
      ],
    };
  }

  #launch(
    appPath: string,
    internalArg: string,
    deadline: number,
  ): VisualHostActionObservation | undefined {
    if (this.#remaining(deadline) <= 0) {
      return { outcome: "failed", evidence: ["Visual host action deadline expired before launch."] };
    }
    const result = this.#ops.runProcess(
      OPEN_EXECUTABLE,
      ["-n", appPath, "--args", internalArg],
      this.#subprocessTimeout(deadline),
    );
    if (result.status === 0) return undefined;
    return {
      outcome: "failed",
      evidence: [
        `Exact app launch failed with status ${String(result.status)}: ${result.stderr.trim() || "no stderr"}`,
      ],
    };
  }

  #inspectInstallation(deadline?: number): InstallationObservation {
    const candidates = this.#candidateAppPaths();
    const candidateExecutables = candidates.map((candidate) =>
      path.join(candidate, "Contents", "MacOS", EXECUTABLE_NAME)
    );
    const evidence: string[] = [];
    const observedInstallations: InstallationObservation["observedInstallations"] = [];
    let unknown = false;
    let malformedBundle = false;
    for (const [index, appPath] of candidates.entries()) {
      if (deadline !== undefined && this.#remaining(deadline) <= 0) {
        unknown = true;
        evidence.push("Visual host identity observation deadline expired.");
        break;
      }
      try {
        if (this.#ops.pathKind(appPath, this.#subprocessTimeout(deadline)) !== "directory") continue;
        const executablePath = candidateExecutables[index]!;
        if (deadline !== undefined && this.#remaining(deadline) <= 0) {
          throw new Error("identity observation deadline expired");
        }
        if (
          this.#ops.pathKind(executablePath, this.#subprocessTimeout(deadline))
          !== "file"
        ) {
          malformedBundle = true;
          evidence.push(`Visual host bundle at ${appPath} has no exact ${EXECUTABLE_NAME} executable.`);
          continue;
        }
        evidence.push(`Visual host bundle and exact executable observed at ${appPath}.`);
        let version: string | undefined;
        try {
          const infoPath = path.join(appPath, "Contents", "Info.plist");
          const declaredIdentifier = this.#readPlistValue(
            infoPath,
            "CFBundleIdentifier",
            deadline,
          );
          if (declaredIdentifier !== BUNDLE_IDENTIFIER) {
            throw new Error(`CFBundleIdentifier is ${declaredIdentifier ?? "unknown"}`);
          }
          const declaredExecutable = this.#readPlistValue(
            infoPath,
            "CFBundleExecutable",
            deadline,
          );
          if (declaredExecutable !== EXECUTABLE_NAME) {
            throw new Error(`CFBundleExecutable is ${declaredExecutable ?? "unknown"}`);
          }
          version = this.#readPlistValue(
            infoPath,
            "CFBundleShortVersionString",
            deadline,
          );
          if (!version) throw new Error("CFBundleShortVersionString is unavailable");
          evidence.push(`Info.plist version observed as ${version}.`);
        } catch (error) {
          malformedBundle = true;
          evidence.push(`Info.plist observation failed: ${errorMessage(error)}`);
          continue;
        }
        observedInstallations.push({
          appPath,
          executablePath,
          ...(version ? { version } : {}),
        });
      } catch (error) {
        unknown = true;
        evidence.push(`Install observation failed for ${appPath}: ${errorMessage(error)}`);
      }
    }
    const selected = observedInstallations[0];
    if (selected) {
      return {
        installed: true,
        appPath: selected.appPath,
        executablePath: selected.executablePath,
        candidateExecutables,
        observedInstallations,
        ...(selected.version ? { version: selected.version } : {}),
        degraded: selected.version === undefined || unknown || malformedBundle,
        evidence,
      };
    }
    if (unknown || malformedBundle) {
      return {
        installed: null,
        candidateExecutables,
        observedInstallations,
        degraded: true,
        evidence,
      };
    }
    return {
      installed: false,
      candidateExecutables,
      observedInstallations,
      degraded: false,
      evidence: [...evidence, `No visual host bundle was observed at ${candidates.join(", ")}.`],
    };
  }

  #candidateAppPaths(): string[] {
    const candidates = [
      this.#ops.env["VIBEHUB_VISUAL_APP_PATH"],
      path.join(this.#ops.homeDirectory, "Applications", APP_NAME),
      path.join("/Applications", APP_NAME),
    ].filter((candidate): candidate is string => Boolean(candidate));
    return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
  }

  #sameExecutable(expected: string, observed: string): boolean {
    return path.resolve(expected) === path.resolve(observed);
  }

  #readPlistValue(candidate: string, key: string, deadline?: number): string {
    if (deadline !== undefined && this.#remaining(deadline) <= 0) {
      throw new Error("identity observation deadline expired");
    }
    return this.#ops.readPlistValue(
      candidate,
      key,
      this.#subprocessTimeout(deadline),
    ).trim();
  }

  #remaining(deadline: number): number {
    return Math.max(0, deadline - this.#ops.now());
  }

  #subprocessTimeout(deadline?: number): number {
    if (deadline === undefined) return this.#processTimeoutMs;
    return Math.max(1, Math.min(this.#processTimeoutMs, Math.floor(this.#remaining(deadline))));
  }

  #conflictingInstallEvidence(
    executablePaths: string[],
    installation: InstallationObservation,
    suffix: string,
  ): string {
    const identities = executablePaths.map((executablePath) => {
      const observed = installation.observedInstallations.find((candidate) =>
        this.#sameExecutable(candidate.executablePath, executablePath)
      );
      return observed?.version
        ? `${executablePath} (Info.plist version ${observed.version})`
        : executablePath;
    });
    return `Observed conflicting installed visual host executable ${identities.join(", ")} ${suffix}.`;
  }
}

export function normalizeMacOSVisualHostOptions(
  options: Pick<
    MacOSVisualHostAdapterOptions,
    "pollAttempts" | "pollIntervalMs" | "processTimeoutMs"
      | "actionDeadlineMs"
  >,
): NormalizedMacOSVisualHostOptions {
  return {
    pollAttempts: normalizeBound(options.pollAttempts, 20, 1, 50),
    pollIntervalMs: normalizeBound(options.pollIntervalMs, 100, 0, 500),
    processTimeoutMs: normalizeBound(options.processTimeoutMs, 1_000, 50, 2_000),
    actionDeadlineMs: normalizeBound(options.actionDeadlineMs, 5_000, 100, 15_000),
  };
}

function normalizeBound(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  if (value === Number.POSITIVE_INFINITY) return maximum;
  if (value === Number.NEGATIVE_INFINITY) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

export function normalizeExpectedVisualHostVersion(
  value: string | undefined,
): string {
  const normalized = value?.trim();
  return normalized || SUPPORTED_VISUAL_HOST_VERSION;
}

function runNativeProcess(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): ProcessRunResult {
  const result = spawnSync(executable, [...args], {
    encoding: "utf8",
    shell: false,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.error?.message ?? result.stderr ?? "",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
