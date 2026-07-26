import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import type {
  Conflict,
  ConflictCardSnapshot,
  CornerSignalAvailability,
  CornerSignalConflictDecisionV1,
  CornerSignalDecisionV1,
  CornerSignalFreshness,
  CornerSignalRecoveryAction,
  CornerSignalSection,
  CornerSignalSnapshotV1,
  LiveShellRepoRef,
  LiveShellSnapshotV1,
  Task,
  VisualProjectionHost,
  VisualRefreshResultV1,
  WorkbenchBridgeResult,
  WorkbenchRepoRef,
} from "./contract/index.js";
import { GitFacade } from "./git-facade.js";
import { RuntimeService } from "./runtime-service.js";

const PROJECTION_MAX_AGE_MS = 5 * 60 * 1_000;
const PROJECTION_FILE_NAME = "corner-signal-v1.json";
const MAX_VISUAL_JSON_BYTES = 1_048_576;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;

export interface VisualProjectionRuntime {
  readLiveShell(
    repo: LiveShellRepoRef,
  ): WorkbenchBridgeResult<LiveShellSnapshotV1>;
  readConflictDetail(
    repo: WorkbenchRepoRef,
    conflictId: string,
  ): WorkbenchBridgeResult<ConflictCardSnapshot>;
}

export interface VisualProjectionServiceOptions {
  runtime?: VisualProjectionRuntime;
  dbPath?: string;
  projectionPath?: string;
  platform?: string;
  now?: () => Date;
  generation?: () => string;
  writeFault?: (
    phase: "before_rename" | "after_rename" | "before_directory_fsync",
  ) => void;
  lockTimeoutMs?: number;
}

export interface VisualRefreshInput {
  repoPath: string;
  host: VisualProjectionHost;
}

export function defaultCornerSignalProjectionPath(
  homeDirectory: string = os.userInfo().homedir,
): string {
  return path.join(
    homeDirectory,
    "Library",
    "Application Support",
    "VibeHub",
    PROJECTION_FILE_NAME,
  );
}

/** Exact checkout evidence only; no hooks-tier fallback crosses worktrees. */
export function selectExactCheckoutTask(
  tasks: readonly Task[],
  checkoutRoot: string,
): Task | null {
  return [...tasks]
    .filter((task) => task.git.worktreePath === checkoutRoot)
    .sort((left, right) =>
      right.lastEventAt.localeCompare(left.lastEventAt)
      || left.id.localeCompare(right.id)
    )[0] ?? null;
}

/**
 * Deterministic contract priority: checkout-related conflicts first, then
 * red before yellow, then newest evidence, then the stable conflict id.
 */
export function selectCornerSignalConflict(
  conflicts: readonly Conflict[],
  currentTaskId: string | null,
): Conflict | null {
  return [...conflicts].sort((left, right) => {
    const leftCurrent = currentTaskId && left.taskIds.includes(currentTaskId) ? 0 : 1;
    const rightCurrent = currentTaskId && right.taskIds.includes(currentTaskId) ? 0 : 1;
    return leftCurrent - rightCurrent
      || severityRank(left) - severityRank(right)
      || right.detectedAt.localeCompare(left.detectedAt)
      || left.id.localeCompare(right.id);
  })[0] ?? null;
}

/** Prompt bytes are deterministic evidence projection, not a queued action. */
export function coordinationPromptFor(
  conflict: Conflict,
  tasks: readonly [Task, Task],
): string {
  const resources = conflict.sharedSymbols.length > 0
    ? conflict.sharedSymbols.map((resource) => `- ${resource}`).join("\n")
    : "- No shared resource names were available in the conflict read model.";
  return [
    `Coordinate the observed ${conflict.severity} conflict ${conflict.id}.`,
    "",
    `Task A: ${tasks[0].title} [${tasks[0].git.branch}]`,
    `Task B: ${tasks[1].title} [${tasks[1].git.branch}]`,
    "",
    "Shared evidence:",
    resources,
    "",
    "Before either task edits the shared resources again, agree on ownership and sequencing.",
    "Reply with the owner for each shared resource and the handoff point for the other task.",
  ].join("\n");
}

export class VisualProjectionService {
  readonly #runtime: VisualProjectionRuntime;
  readonly #projectionPath: string;
  readonly #platform: string;
  readonly #now: () => Date;
  readonly #generation: () => string;
  readonly #writeFault?: VisualProjectionServiceOptions["writeFault"];
  readonly #lockTimeoutMs: number;

  constructor(options: VisualProjectionServiceOptions = {}) {
    this.#runtime = options.runtime ?? new RuntimeService({ dbPath: options.dbPath });
    this.#projectionPath = options.projectionPath
      ?? defaultCornerSignalProjectionPath();
    this.#platform = options.platform ?? process.platform;
    this.#now = options.now ?? (() => new Date());
    this.#generation = options.generation ?? (() => crypto.randomUUID());
    this.#writeFault = options.writeFault;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  refresh(input: VisualRefreshInput): VisualRefreshResultV1 {
    if (!isVisualProjectionHost(input.host)) {
      return this.#error(
        "invalid_host",
        `Unsupported visual host ${String(input.host)}. Expected claude-code or codex.`,
      );
    }
    if (this.#platform !== "darwin" && this.#projectionPath === defaultCornerSignalProjectionPath()) {
      return this.#error(
        "unsupported_platform",
        `Corner Signal projection is available on macOS; observed ${this.#platform}.`,
      );
    }

    let context: ReturnType<typeof GitFacade.sessionContextAt>;
    try {
      context = GitFacade.sessionContextAt(input.repoPath);
    } catch (error) {
      return this.#error(
        "invalid_repo",
        `Could not resolve an exact Git checkout at ${input.repoPath}: ${errorMessage(error)}`,
      );
    }

    const now = this.#now();
    const identity = {
      repoRoot: context.repoRoot,
      checkoutRoot: context.toplevel,
      host: input.host,
      branch: context.branch,
    } satisfies CornerSignalSnapshotV1["identity"]["data"];
    const liveRepo: LiveShellRepoRef = {
      repoKey: context.repoRoot,
      repoRoot: context.repoRoot,
      checkoutRoot: context.toplevel,
      host: input.host,
    };
    const live = this.#runtime.readLiveShell(liveRepo);
    if (live.status !== "ok") {
      return this.#error(
        "source_read_failed",
        `Could not read the canonical live shell: ${live.message}`,
      );
    }

    const identitySection: CornerSignalSnapshotV1["identity"] = {
      availability: "available",
      freshness: "live",
      data: identity,
      recovery: [],
    };
    const signal = this.#projectSignal(live.data, liveRepo);
    const copiedAt = now.toISOString();
    const recovery = dedupeRecovery([
      ...identitySection.recovery,
      ...signal.recovery,
    ]);
    const availability = combineAvailability(
      identitySection.availability,
      signal.availability,
    );
    const snapshot: CornerSignalSnapshotV1 = {
      schemaVersion: 1,
      generation: this.#generation(),
      selectionMode: "last_writer_selected",
      copiedAt,
      staleAfter: new Date(now.getTime() + PROJECTION_MAX_AGE_MS).toISOString(),
      availability,
      freshness: signal.freshness,
      recovery,
      identity: identitySection,
      signal,
    };

    try {
      prepareVisualDirectory(path.dirname(this.#projectionPath));
      const write = withProjectionLock(
        this.#projectionPath,
        this.#lockTimeoutMs,
        () => writeProjectionAtomically(
          this.#projectionPath,
          snapshot,
          this.#writeFault,
        ),
      );
      const warnings = write.warnings.map((message) => ({
        code: "durability_warning" as const,
        message,
      }));
      return {
        schemaVersion: 1,
        command: "refresh",
        ok: true,
        changed: write.changed,
        copied: true,
        projectionPath: this.#projectionPath,
        snapshot,
        evidence: [
          `Copied Corner Signal projection from canonical RuntimeService read models at ${copiedAt}.`,
          `Projection generation ${snapshot.generation} uses last-writer-selected semantics.`,
          write.changed
            ? "Projection bytes changed."
            : "Projection bytes already matched the canonical read.",
          ...warnings.map((warning) => warning.message),
        ],
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (error) {
      return this.#error(
        "projection_write_failed",
        `Could not atomically copy Corner Signal projection: ${errorMessage(error)}`,
      );
    }
  }

  #projectSignal(
    live: LiveShellSnapshotV1,
    repo: LiveShellRepoRef,
  ): CornerSignalSection<CornerSignalDecisionV1> {
    const workspace = live.workspace;
    const map = workspace.data?.map;
    const workspaceRecovery = mapLiveRecovery(workspace.recovery);
    if (!map) {
      return {
        availability: "unavailable",
        freshness: workspace.freshness,
        data: null,
        recovery: workspaceRecovery,
      };
    }

    const exactTask = selectExactCheckoutTask(map.tasks, repo.checkoutRoot);
    const conflict = selectCornerSignalConflict(
      map.conflicts,
      exactTask?.id ?? null,
    );
    if (!conflict) {
      return {
        availability: combineAvailability(workspace.availability, "available"),
        freshness: workspace.freshness,
        data: {
          state: "clear",
          evidence: [
            `No active conflicts were present in the canonical map captured at ${map.capturedAt}.`,
          ],
        },
        recovery: dedupeRecovery([
          ...workspaceRecovery,
          ...(workspace.freshness === "stale" ? [{
              code: "sync_repository",
              instruction: "Sync the repository, then refresh Corner Signal before relying on this absence.",
            } as const] : []),
        ]),
      };
    }

    const first = map.tasks.find((task) => task.id === conflict.taskIds[0]);
    const second = map.tasks.find((task) => task.id === conflict.taskIds[1]);
    if (!first || !second) {
      return {
        availability: "partial",
        freshness: workspace.freshness,
        data: null,
        recovery: dedupeRecovery([
          ...workspaceRecovery,
          {
            code: "retry_read",
            instruction: `Conflict ${conflict.id} is missing one or both canonical task rows; refresh after the next runtime read.`,
          },
        ]),
      };
    }

    const detailRead = this.#runtime.readConflictDetail(
      { repoKey: repo.repoKey, repoRoot: repo.repoRoot },
      conflict.id,
    );
    const detail = detailSection(detailRead, workspace.freshness);
    const decision: CornerSignalConflictDecisionV1 = {
      state: "conflict",
      conflict,
      tasks: [first, second],
      detail,
      coordinationPrompt: coordinationPromptFor(conflict, [first, second]),
    };
    return {
      availability: combineAvailability(
        workspace.availability,
        detail.availability === "available" ? "available" : "partial",
      ),
      freshness: workspace.freshness,
      data: decision,
      recovery: dedupeRecovery([
        ...workspaceRecovery,
        ...detail.recovery,
        ...(workspace.freshness === "stale"
          ? [{
              code: "sync_repository" as const,
              instruction: "Sync the repository and refresh Corner Signal to update conflict evidence.",
            }]
          : []),
      ]),
    };
  }

  #error(
    code: NonNullable<VisualRefreshResultV1["error"]>["code"],
    message: string,
  ): VisualRefreshResultV1 {
    return {
      schemaVersion: 1,
      command: "refresh",
      ok: false,
      changed: false,
      copied: false,
      projectionPath: this.#projectionPath,
      evidence: [],
      error: { code, message },
    };
  }
}

function detailSection(
  result: WorkbenchBridgeResult<ConflictCardSnapshot>,
  freshness: CornerSignalFreshness,
): CornerSignalSection<ConflictCardSnapshot> {
  if (result.status === "ok") {
    return {
      availability: "available",
      freshness,
      data: result.data,
      recovery: [],
    };
  }
  return {
    availability: result.status === "evidence_unavailable" ? "partial" : "unavailable",
    freshness,
    data: null,
    recovery: [{
      code: "inspect_conflict_evidence",
      instruction: result.message,
    }],
  };
}

function mapLiveRecovery(
  recovery: LiveShellSnapshotV1["workspace"]["recovery"],
): CornerSignalRecoveryAction[] {
  return recovery.map((action) => ({
    code: action.code === "initialize_runtime"
      ? "initialize_runtime"
      : action.code === "sync_repository"
        ? "sync_repository"
        : "retry_read",
    instruction: action.instruction,
  }));
}

function severityRank(conflict: Conflict): number {
  return conflict.severity === "red" ? 0 : 1;
}

function combineAvailability(
  left: CornerSignalAvailability,
  right: CornerSignalAvailability,
): CornerSignalAvailability {
  if (left === "unavailable" && right === "unavailable") return "unavailable";
  if (left === "available" && right === "available") return "available";
  return "partial";
}

function dedupeRecovery(
  actions: readonly CornerSignalRecoveryAction[],
): CornerSignalRecoveryAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = `${action.code}\0${action.instruction}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isVisualProjectionHost(value: string): value is VisualProjectionHost {
  return value === "claude-code" || value === "codex";
}

interface ProjectionWriteOutcome {
  changed: boolean;
  warnings: string[];
}

function writeProjectionAtomically(
  target: string,
  snapshot: CornerSignalSnapshotV1,
  fault?: VisualProjectionServiceOptions["writeFault"],
): ProjectionWriteOutcome {
  const directory = path.dirname(target);
  prepareVisualDirectory(directory);
  const targetStat = lstatIfExists(target);
  if (targetStat?.isSymbolicLink()) {
    throw new Error(`visual projection target must not be a symbolic link: ${target}`);
  }
  if (targetStat && !targetStat.isFile()) {
    throw new Error(`visual projection target must be a regular file: ${target}`);
  }
  const contents = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAX_VISUAL_JSON_BYTES) {
    throw new Error(`visual projection exceeds ${MAX_VISUAL_JSON_BYTES} bytes`);
  }
  const previous = readSecureVisualFile(target, {
    maxBytes: MAX_VISUAL_JSON_BYTES,
    missing: "null",
    requiredMode: 0o600,
  });
  if (previous === contents) return { changed: false, warnings: [] };

  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.fchmodSync(fileDescriptor, 0o600);
    fs.writeFileSync(fileDescriptor, contents, "utf8");
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fault?.("before_rename");
    fs.renameSync(temporary, target);
    const warnings: string[] = [];
    try {
      fault?.("after_rename");
      fault?.("before_directory_fsync");
      const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch (error) {
      warnings.push(
        `Projection rename committed generation ${snapshot.generation}, but directory durability confirmation failed: ${errorMessage(error)}`,
      );
    }
    return { changed: true, warnings };
  } finally {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

function prepareVisualDirectory(directory: string): void {
  assertNoSymlinkAncestors(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestors(directory);
}

export interface SecureVisualFileReadOptions {
  maxBytes?: number;
  missing?: "throw" | "null";
  requiredMode?: number;
}

/** Bounded, no-follow JSON read shared by projection and visual settings. */
export function readSecureVisualFile(
  target: string,
  options: SecureVisualFileReadOptions = {},
): string | null {
  const maxBytes = options.maxBytes ?? MAX_VISUAL_JSON_BYTES;
  assertNoSymlinkAncestors(path.dirname(target));
  const noFollow = (fs.constants as unknown as Record<string, number>)["O_NOFOLLOW"] ?? 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (options.missing === "null" && isMissing(error)) return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`visual JSON source is not a regular file: ${target}`);
    if (
      options.requiredMode !== undefined
      && (stat.mode & 0o777) !== options.requiredMode
    ) {
      throw new Error(
        `visual JSON source ${target} must have mode ${options.requiredMode.toString(8)}`,
      );
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = fs.readSync(
        descriptor,
        buffer,
        total,
        buffer.length - total,
        null,
      );
      if (count === 0) break;
      total += count;
    }
    if (total > maxBytes) {
      throw new Error(`visual JSON source exceeds ${maxBytes} bytes: ${target}`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
  } finally {
    fs.closeSync(descriptor);
  }
}

function withProjectionLock(
  target: string,
  timeoutMs: number,
  operation: () => ProjectionWriteOutcome,
): ProjectionWriteOutcome {
  const lockPath = `${target}.coordination.sqlite`;
  const boundedTimeout = Number.isFinite(timeoutMs)
    ? Math.max(0, Math.min(10_000, timeoutMs))
    : DEFAULT_LOCK_TIMEOUT_MS;
  const existing = lstatIfExists(lockPath);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(`visual projection coordination path must be a regular file: ${lockPath}`);
  }
  const database = new Database(lockPath);
  fs.chmodSync(lockPath, 0o600);
  let outcome: ProjectionWriteOutcome | undefined;
  let failure: unknown;
  let transactionOpen = false;
  const cleanupWarnings: string[] = [];
  try {
    database.pragma(`busy_timeout = ${Math.trunc(boundedTimeout)}`);
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    outcome = operation();
    try {
      database.exec("COMMIT");
      transactionOpen = false;
    } catch (error) {
      cleanupWarnings.push(`Projection coordination commit failed after the write outcome was known: ${errorMessage(error)}`);
    }
  } catch (error) {
    failure = error;
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
        transactionOpen = false;
      } catch {
        // Preserve the operation error; closing releases the OS-backed lock.
      }
    }
  }
  try {
    database.close();
  } catch (error) {
    if (failure === undefined) cleanupWarnings.push(`Projection coordination close failed after the write outcome was known: ${errorMessage(error)}`);
  }
  if (failure !== undefined) throw failure;
  if (!outcome) throw new Error("visual projection lock completed without a write outcome");
  return {
    ...outcome,
    warnings: [...outcome.warnings, ...cleanupWarnings],
  };
}

function assertNoSymlinkAncestors(target: string): void {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    const stat = lstatIfExists(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      if (isTrustedDarwinSystemAlias(current)) continue;
      throw new Error(`visual path ancestor must not be a symbolic link: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`visual path ancestor must be a directory: ${current}`);
    }
  }
}

function isTrustedDarwinSystemAlias(target: string): boolean {
  if (process.platform !== "darwin") return false;
  const expected = target === "/var"
    ? "/private/var"
    : target === "/tmp"
      ? "/private/tmp"
      : null;
  if (!expected) return false;
  try {
    return fs.realpathSync.native(target) === expected;
  } catch {
    return false;
  }
}

function lstatIfExists(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && (error as { code?: string }).code === code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
