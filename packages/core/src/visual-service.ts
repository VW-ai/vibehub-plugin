import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import type {
  VisualCommand,
  VisualCommandResultV1,
  VisualHostObservation,
  VisualSettingsV1,
  VisualSettingsPatch,
  VisualStatusV1,
} from "./contract/visual.js";
import {
  MacOSVisualHostAdapter,
  normalizeExpectedVisualHostVersion,
  SUPPORTED_VISUAL_HOST_VERSION,
} from "./macos-visual-host.js";

export interface VisualHostActionObservation {
  outcome: "observed_running" | "observed_stopped" | "unavailable" | "failed";
  evidence: string[];
}

export interface VisualHostAdapter {
  inspect(): VisualHostObservation;
  open(): VisualHostActionObservation;
  quit(): VisualHostActionObservation;
}

export interface VisualServiceOptions {
  settingsPath?: string;
  host?: VisualHostAdapter;
  expectedHostVersion?: string;
  now?: () => Date;
  settingsFault?: (
    phase:
      | "lock_contended"
      | "after_lock"
      | "before_rename"
      | "before_directory_fsync"
      | "after_directory_fsync"
      | "before_coordination_commit"
      | "before_coordination_close"
  ) => void;
  lockTimeoutMs?: number;
}

interface VisualSettingsWriteOutcome {
  after: VisualSettingsV1;
  changed: boolean;
}

class VisualSettingsCommittedError extends Error {
  readonly settings: VisualSettingsV1;

  constructor(settings: VisualSettingsV1, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "VisualSettingsCommittedError";
    this.settings = settings;
  }
}

const unavailableHost: VisualHostAdapter = {
  inspect: () => ({
    availability: "unavailable",
    installed: null,
    running: null,
    platform: process.platform,
    arch: process.arch,
    evidence: ["No native visual host adapter is configured."],
  }),
  open: () => ({ outcome: "unavailable", evidence: ["No native visual host adapter is configured."] }),
  quit: () => ({ outcome: "unavailable", evidence: ["No native visual host adapter is configured."] }),
};

export function defaultVisualHostAdapter(
  platform: NodeJS.Platform = process.platform,
  macOSHost?: VisualHostAdapter,
  expectedHostVersion: string = SUPPORTED_VISUAL_HOST_VERSION,
): VisualHostAdapter {
  return platform === "darwin"
    ? macOSHost ?? new MacOSVisualHostAdapter({ expectedHostVersion })
    : unavailableHost;
}

export function defaultVisualSettingsPath(): string {
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "VibeHub", "visual-settings.json")
    : path.join(
        process.env["XDG_STATE_HOME"] ?? path.join(os.homedir(), ".local", "state"),
        "vibehub",
        "visual-settings.json",
      );
}

export class VisualService {
  readonly #settingsPath: string;
  readonly #host: VisualHostAdapter;
  readonly #expectedHostVersion: string;
  readonly #now: () => Date;
  readonly #fault?: VisualServiceOptions["settingsFault"];
  readonly #lockTimeoutMs: number;

  constructor(options: VisualServiceOptions = {}) {
    this.#settingsPath = options.settingsPath ?? defaultVisualSettingsPath();
    this.#expectedHostVersion = normalizeExpectedVisualHostVersion(
      options.expectedHostVersion,
    );
    this.#host = options.host
      ?? defaultVisualHostAdapter(process.platform, undefined, this.#expectedHostVersion);
    this.#now = options.now ?? (() => new Date());
    this.#fault = options.settingsFault;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
  }

  status(): VisualCommandResultV1 {
    try {
      return this.#result("status", true, false, this.#status(), []);
    } catch (error) {
      return this.#error("status", "settings_error", error instanceof Error ? error.message : String(error));
    }
  }

  enable(): VisualCommandResultV1 {
    return this.#update("enable", (settings) => ({
      ...settings, signalsEnabled: true, snoozedUntil: null,
    }));
  }

  disable(): VisualCommandResultV1 {
    return this.#update("disable", (settings) => ({
      ...settings, signalsEnabled: false, snoozedUntil: null,
    }));
  }

  /** Core-owned write boundary used by a future native settings projection. */
  configure(settingsPatch: VisualSettingsPatch): VisualCommandResultV1 {
    return this.#update("configure", (settings) =>
      validateSettings({
        ...settings,
        ...settingsPatch,
        displayPositions: settingsPatch.displayPositions
          ? { ...settings.displayPositions, ...settingsPatch.displayPositions }
          : settings.displayPositions,
      }));
  }

  snooze(duration: string): VisualCommandResultV1 {
    const milliseconds = parseDuration(duration);
    if (milliseconds === null) {
      return this.#error("snooze", "invalid_duration", "Duration must be a positive value such as 15m, 2h, or 1d.");
    }
    return this.#update("snooze", (settings) => ({
      ...settings,
      snoozedUntil: new Date(this.#now().getTime() + milliseconds).toISOString(),
    }));
  }

  open(): VisualCommandResultV1 {
    return this.#hostOperation("open");
  }

  quit(): VisualCommandResultV1 {
    return this.#hostOperation("quit");
  }

  #hostOperation(command: "open" | "quit"): VisualCommandResultV1 {
    let settings: VisualSettingsV1;
    try {
      settings = this.#readSettings();
    } catch (error) {
      return this.#error(command, "settings_error", error instanceof Error ? error.message : String(error));
    }
    let lastHost: VisualHostObservation | undefined;
    try {
      const before = this.#host.inspect();
      lastHost = before;
      const beforeStatus = this.#statusWith(settings, before);
      if (
        command === "open"
        && ["degraded", "version_mismatch", "not_installed"].includes(beforeStatus.lifecycle)
      ) {
        return this.#result(command, false, false, beforeStatus, before.evidence ?? [], {
          code: "host_unavailable",
          message: `Visual host open is blocked while lifecycle is ${beforeStatus.lifecycle}.`,
        });
      }
      const action = command === "open" ? this.#host.open() : this.#host.quit();
      const after = this.#host.inspect();
      lastHost = after;
      const status = this.#statusWith(settings, after);
      const required: VisualHostActionObservation["outcome"] =
        command === "open" ? "observed_running" : "observed_stopped";
      if (action.outcome !== required) {
        return this.#result(command, false, false, status, action.evidence, {
          code: "host_unavailable",
          message: `Visual host ${command} was not observed.`,
        });
      }
      const compatibleRunning = [
        "running_enabled",
        "running_disabled",
        "running_snoozed",
      ].includes(status.lifecycle);
      const confirmed = command === "open"
        ? after.availability === "available"
          && after.installed === true
          && after.running === true
          && compatibleRunning
        : after.availability === "available" && after.running === false;
      const changed = typeof before.running === "boolean"
        && typeof after.running === "boolean"
        && before.running !== after.running;
      return confirmed
        ? this.#result(command, true, changed, status, action.evidence)
        : this.#result(command, false, false, status, action.evidence, {
            code: "host_unavailable",
            message: `Visual host ${command} outcome could not be confirmed by inspection.`,
          });
    } catch (error) {
      return this.#hostError(command, settings, lastHost, error instanceof Error ? error.message : String(error));
    }
  }

  #hostError(
    command: "open" | "quit",
    settings: VisualSettingsV1,
    lastHost: VisualHostObservation | undefined,
    message: string,
  ): VisualCommandResultV1 {
    const evidence = [`Visual host ${command} failed: ${message}`];
    const status = this.#statusWith(settings, {
      ...lastHost,
      availability: "degraded",
      installed: lastHost?.installed ?? null,
      running: lastHost?.running ?? null,
      platform: lastHost?.platform ?? process.platform,
      arch: lastHost?.arch ?? process.arch,
      evidence: [...(lastHost?.evidence ?? []), ...evidence],
    });
    return this.#result(command, false, false, status, evidence, {
      code: "host_unavailable",
      message,
    });
  }

  #update(
    command: Extract<VisualCommand, "enable" | "disable" | "snooze" | "configure">,
    mutate: (settings: VisualSettingsV1) => VisualSettingsV1,
  ): VisualCommandResultV1 {
    try {
      const { after, changed } = this.#withSettingsLock(() => {
        const current = this.#readSettingsUnlocked();
        const after = mutate(current.settings);
        const changed = current.legacy || JSON.stringify(current.settings) !== JSON.stringify(after);
        if (changed) this.#writeSettings(after);
        return { after, changed };
      });
      return this.#result(command, true, changed, this.#statusWith(after), []);
    } catch (error) {
      if (error instanceof VisualSettingsCommittedError) {
        return this.#committedSettingsError(command, error);
      }
      return this.#error(command, "settings_error", error instanceof Error ? error.message : String(error));
    }
  }

  #error(command: VisualCommand, code: "invalid_duration" | "settings_error", message: string): VisualCommandResultV1 {
    let status: VisualStatusV1;
    try { status = this.#status(); }
    catch {
      status = this.#statusWith(defaultSettings(), {
        availability: "degraded", installed: null, running: null,
        evidence: ["Visual settings could not be read."],
      });
    }
    return this.#result(command, false, false, status, [], { code, message });
  }

  #status(): VisualStatusV1 {
    return this.#statusWith(this.#readSettings());
  }

  #statusWith(settings: VisualSettingsV1, suppliedHost?: VisualHostObservation): VisualStatusV1 {
    const host = suppliedHost ?? this.#host.inspect();
    const now = this.#now();
    let lifecycle: VisualStatusV1["lifecycle"];
    if (host.availability !== "available") lifecycle = "degraded";
    else if (host.installed === null) lifecycle = "degraded";
    else if (host.installed === false && (host.running === true || host.version !== undefined)) lifecycle = "degraded";
    else if (host.installed === false) lifecycle = "not_installed";
    else if (this.#expectedHostVersion && host.version === undefined) lifecycle = "degraded";
    else if (this.#expectedHostVersion && host.version !== this.#expectedHostVersion) lifecycle = "version_mismatch";
    else if (host.running === null) lifecycle = "degraded";
    else if (host.running === false) lifecycle = "installed_not_running";
    else if (!settings.signalsEnabled) lifecycle = "running_disabled";
    else if (settings.snoozedUntil && Date.parse(settings.snoozedUntil) > now.getTime()) lifecycle = "running_snoozed";
    else lifecycle = "running_enabled";
    const recovery = lifecycle === "not_installed"
      ? [{ code: "install_visual_host" as const, instruction: "Install the compatible visual host." }]
      : lifecycle === "installed_not_running"
        ? [{ code: "start_visual_host" as const, instruction: "Start the installed visual host." }]
        : lifecycle === "version_mismatch"
          ? [{ code: "upgrade_visual_host" as const, instruction: "Install the visual host version compatible with this CLI." }]
          : lifecycle === "degraded"
            ? [{ code: "repair_visual_host" as const, instruction: "Repair host observation before relying on visual lifecycle state." }]
            : [];
    return { schemaVersion: 1, lifecycle, settings, host, observedAt: now.toISOString(), recovery };
  }

  #readSettings(): VisualSettingsV1 {
    return this.#readSettingsUnlocked().settings;
  }

  #readSettingsUnlocked(): { settings: VisualSettingsV1; legacy: boolean } {
    const contents = readBoundedSettingsFile(this.#settingsPath);
    if (contents === null) return { settings: defaultSettings(), legacy: false };
    const parsed = JSON.parse(contents) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid visual settings file.");
    }
    const raw = parsed as Record<string, unknown>;
    if (raw["schemaVersion"] === 1) return { settings: validateSettings(raw), legacy: false };
    if (raw["schemaVersion"] !== undefined) throw new Error("Unsupported visual settings schema version.");
    const required = ["enabled", "importantOnly", "launchAtLogin", "positions"];
    const allowed = new Set([...required, "snoozedUntil"]);
    if (!required.every((key) => Object.hasOwn(raw, key))
      || Object.keys(raw).some((key) => !allowed.has(key))) {
      throw new Error("Unrecognized legacy visual settings file.");
    }
    return {
      legacy: true,
      settings: validateSettings({
        schemaVersion: 1,
        signalsEnabled: raw["enabled"],
        importantOnly: raw["importantOnly"],
        snoozedUntil: raw["snoozedUntil"] ?? null,
        launchAtLogin: raw["launchAtLogin"],
        displayPositions: raw["positions"],
      }),
    };
  }

  #writeSettings(settings: VisualSettingsV1): void {
    const directory = path.dirname(this.#settingsPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = `${this.#settingsPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let renamed = false;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      const fd = fs.openSync(temp, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.#fault?.("before_rename");
      fs.renameSync(temp, this.#settingsPath);
      renamed = true;
      this.#fault?.("before_directory_fsync");
      syncDirectory(directory);
      this.#fault?.("after_directory_fsync");
    } catch (error) {
      if (renamed) throw new VisualSettingsCommittedError(settings, error);
      throw error;
    } finally {
      try { fs.rmSync(temp, { force: true }); } catch { /* preserve original error */ }
    }
  }

  #withSettingsLock(operation: () => VisualSettingsWriteOutcome): VisualSettingsWriteOutcome {
    const directory = path.dirname(this.#settingsPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    // This adjacent database is only an OS-backed cross-process mutex. It stores
    // no settings, UI DTOs, receipts, or semantic authority.
    const lockPath = `${this.#settingsPath}.coordination.sqlite`;
    const existed = fs.existsSync(lockPath);
    const db = new Database(lockPath);
    if (!existed && process.platform !== "win32") fs.chmodSync(lockPath, 0o600);
    let transactionOpen = false;
    let outcome: VisualSettingsWriteOutcome | undefined;
    let failure: unknown;
    try {
      db.pragma("busy_timeout = 0");
      try {
        db.exec("BEGIN IMMEDIATE");
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        this.#fault?.("lock_contended");
        db.pragma(`busy_timeout = ${boundedSqliteTimeout(this.#lockTimeoutMs)}`);
        db.exec("BEGIN IMMEDIATE");
      }
      transactionOpen = true;
      this.#fault?.("after_lock");
      outcome = operation();
      this.#fault?.("before_coordination_commit");
      db.exec("COMMIT");
      transactionOpen = false;
    } catch (error) {
      failure = error;
      if (transactionOpen) {
        try { db.exec("ROLLBACK"); } catch { /* preserve operation/commit error */ }
      }
    }
    let closeFailure: unknown;
    try {
      this.#fault?.("before_coordination_close");
    } catch (error) {
      closeFailure = error;
    }
    try {
      db.close();
    } catch (error) {
      closeFailure ??= error;
    }
    const terminalError = failure ?? closeFailure;
    if (terminalError !== undefined) {
      if (terminalError instanceof VisualSettingsCommittedError) throw terminalError;
      if (outcome?.changed) throw new VisualSettingsCommittedError(outcome.after, terminalError);
      throw terminalError;
    }
    if (!outcome) throw new Error("Visual settings coordination completed without an operation result.");
    return outcome;
  }

  #committedSettingsError(
    command: Extract<VisualCommand, "enable" | "disable" | "snooze" | "configure">,
    error: VisualSettingsCommittedError,
  ): VisualCommandResultV1 {
    let status: VisualStatusV1;
    try {
      status = this.#statusWith(error.settings);
    } catch {
      status = this.#statusWith(error.settings, {
        availability: "degraded",
        installed: null,
        running: null,
        evidence: ["Host observation failed after visual settings were committed."],
      });
    }
    return this.#result(
      command,
      false,
      true,
      status,
      ["Visual settings were committed before a later persistence or coordination step failed."],
      { code: "settings_error", message: error.message },
    );
  }

  #result(
    command: VisualCommand,
    ok: boolean,
    changed: boolean,
    status: VisualStatusV1,
    evidence: string[],
    error?: VisualCommandResultV1["error"],
  ): VisualCommandResultV1 {
    return { schemaVersion: 1, command, ok, changed, status, evidence, ...(error ? { error } : {}) };
  }
}

function readBoundedSettingsFile(target: string): string | null {
  const noFollow = (fs.constants as unknown as Record<string, number>)["O_NOFOLLOW"] ?? 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (
      error && typeof error === "object" && "code" in error
      && (error as { code?: string }).code === "ENOENT"
    ) return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Visual settings source must be a regular file.");
    const maximum = 1_048_576;
    const bytes = Buffer.alloc(maximum + 1);
    let total = 0;
    while (total < bytes.length) {
      const count = fs.readSync(descriptor, bytes, total, bytes.length - total, null);
      if (count === 0) break;
      total += count;
    }
    if (total > maximum) throw new Error(`Visual settings exceed ${maximum} bytes.`);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total));
  } finally {
    fs.closeSync(descriptor);
  }
}

function defaultSettings(): VisualSettingsV1 {
  return {
    schemaVersion: 1,
    signalsEnabled: true,
    importantOnly: false,
    snoozedUntil: null,
    launchAtLogin: false,
    displayPositions: {},
  };
}

function validateSettings(value: Record<string, unknown>): VisualSettingsV1 {
  const positions = value["displayPositions"];
  const snoozedUntil = value["snoozedUntil"];
  if (typeof value["signalsEnabled"] !== "boolean"
    || typeof value["importantOnly"] !== "boolean"
    || typeof value["launchAtLogin"] !== "boolean"
    || !(snoozedUntil === null || isCanonicalIsoTimestamp(snoozedUntil))
    || !positions || typeof positions !== "object" || Array.isArray(positions)) {
    throw new Error("Invalid visual settings file.");
  }
  for (const position of Object.values(positions)) {
    if (!position || typeof position !== "object"
      || !Number.isFinite((position as { x?: unknown }).x)
      || !Number.isFinite((position as { y?: unknown }).y)) {
      throw new Error("Invalid visual display position.");
    }
  }
  return value as unknown as VisualSettingsV1;
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  try {
    return new Date(milliseconds).toISOString() === value;
  } catch {
    return false;
  }
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBADF", "EPERM", "EISDIR"].includes(String(error.code));
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "SQLITE_BUSY" || error.code === "SQLITE_BUSY_TIMEOUT");
}

function boundedSqliteTimeout(milliseconds: number): number {
  if (!Number.isFinite(milliseconds)) return 2_000;
  return Math.max(0, Math.min(2_147_483_647, Math.floor(milliseconds)));
}

function parseDuration(value: string): number | null {
  const match = /^([1-9]\d*)(m|h|d)$/.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  const total = amount * unit;
  return Number.isSafeInteger(total) && total <= 30 * 86_400_000 ? total : null;
}
