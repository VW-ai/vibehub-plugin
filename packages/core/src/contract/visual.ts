import type { ConflictCardSnapshot } from "./conflict-types.js";
import type { Conflict, Task } from "./map-types.js";

export const VISUAL_LIFECYCLES = [
  "not_installed",
  "installed_not_running",
  "running_enabled",
  "running_snoozed",
  "running_disabled",
  "degraded",
  "version_mismatch",
] as const;
export type VisualLifecycle = typeof VISUAL_LIFECYCLES[number];

export interface VisualDisplayPosition {
  x: number;
  y: number;
}

/** Device-local preferences. This contract is never semantic Git authority. */
export interface VisualSettingsV1 {
  schemaVersion: 1;
  signalsEnabled: boolean;
  importantOnly: boolean;
  snoozedUntil: string | null;
  launchAtLogin: boolean;
  displayPositions: Record<string, VisualDisplayPosition>;
}

export type VisualRecoveryCode =
  | "install_visual_host"
  | "start_visual_host"
  | "repair_visual_host"
  | "upgrade_visual_host"
  | "retry_host_observation";

export interface VisualRecoveryAction {
  code: VisualRecoveryCode;
  instruction: string;
}

export interface VisualHostObservation {
  availability: "available" | "unavailable" | "degraded";
  /** null means the adapter could not observe this fact. */
  installed: boolean | null;
  /** null means the adapter could not observe this fact. */
  running: boolean | null;
  version?: string;
  platform?: string;
  arch?: string;
  evidence?: string[];
}

export interface VisualStatusV1 {
  schemaVersion: 1;
  lifecycle: VisualLifecycle;
  settings: VisualSettingsV1;
  host: VisualHostObservation;
  observedAt: string;
  recovery: VisualRecoveryAction[];
}

export interface VisualSettingsPatch {
  importantOnly?: boolean;
  launchAtLogin?: boolean;
  displayPositions?: Record<string, VisualDisplayPosition>;
}

export type VisualCommand = "status" | "open" | "enable" | "disable" | "snooze" | "quit" | "configure";
export type VisualErrorCode = "invalid_duration" | "host_unavailable" | "settings_error";

export interface VisualCommandResultV1 {
  schemaVersion: 1;
  command: VisualCommand;
  ok: boolean;
  changed: boolean;
  status: VisualStatusV1;
  evidence: string[];
  error?: { code: VisualErrorCode; message: string };
}

export type CornerSignalAvailability = "available" | "partial" | "unavailable";
export type CornerSignalFreshness = "live" | "stale" | "unknown";

export type CornerSignalRecoveryCode =
  | "initialize_runtime"
  | "sync_repository"
  | "refresh_projection"
  | "retry_read"
  | "inspect_conflict_evidence";

/**
 * Recovery remains descriptive wire data. The native host never executes a
 * Core command or mutates runtime authority on behalf of this projection.
 */
export interface CornerSignalRecoveryAction {
  code: CornerSignalRecoveryCode;
  instruction: string;
}

export interface CornerSignalSection<T> {
  availability: CornerSignalAvailability;
  freshness: CornerSignalFreshness;
  data: T | null;
  recovery: CornerSignalRecoveryAction[];
}

/** Exact checkout identity. Branch is a displayable Git fact; no hash is sent. */
export interface CornerSignalIdentityV1 {
  repoRoot: string;
  checkoutRoot: string;
  host: "claude-code" | "codex";
  branch: string | null;
}

export interface CornerSignalConflictDecisionV1 {
  state: "conflict";
  conflict: Conflict;
  /** Always aligned with conflict.taskIds; no task or branch is synthesized. */
  tasks: [Task, Task];
  /**
   * Rich canonical detail when the read model has two-sided evidence. Basic
   * branch conflicts remain visible through conflict.sharedSymbols and degrade
   * this section instead of manufacturing symbol touches.
   */
  detail: CornerSignalSection<ConflictCardSnapshot>;
  coordinationPrompt: string;
}

export interface CornerSignalClearDecisionV1 {
  state: "clear";
  evidence: string[];
}

export type CornerSignalDecisionV1 =
  | CornerSignalConflictDecisionV1
  | CornerSignalClearDecisionV1;

/**
 * Browser-safe, file-backed copy for the native visual host. This is a
 * projection only: copiedAt/capturedAt are observation times, never receipts
 * for a durable semantic mutation.
 */
export interface CornerSignalSnapshotV1 {
  schemaVersion: 1;
  /** Unique copy generation; the native host honestly selects the last writer. */
  generation: string;
  selectionMode: "last_writer_selected";
  copiedAt: string;
  staleAfter: string;
  availability: CornerSignalAvailability;
  freshness: CornerSignalFreshness;
  recovery: CornerSignalRecoveryAction[];
  identity: CornerSignalSection<CornerSignalIdentityV1>;
  signal: CornerSignalSection<CornerSignalDecisionV1>;
}

export type VisualProjectionHost = CornerSignalIdentityV1["host"];
export type VisualProjectionErrorCode =
  | "invalid_repo"
  | "invalid_host"
  | "unsupported_platform"
  | "source_read_failed"
  | "projection_write_failed";

export interface VisualRefreshResultV1 {
  schemaVersion: 1;
  command: "refresh";
  ok: boolean;
  changed: boolean;
  copied: boolean;
  projectionPath: string;
  snapshot?: CornerSignalSnapshotV1;
  evidence: string[];
  warnings?: Array<{
    code: "durability_warning";
    message: string;
  }>;
  error?: { code: VisualProjectionErrorCode; message: string };
}

export interface VisualOpenWithRefreshResultV1 {
  schemaVersion: 1;
  command: "open";
  ok: boolean;
  lifecycle: "attempted" | "not_attempted";
  refresh: VisualRefreshResultV1;
  /**
   * The host reads the stable projection after launch. Concurrent refreshes
   * are serialized, but the last completed writer is selected at read time.
   */
  projectionSelection: {
    mode: "last_writer_selected";
    requestedGeneration: string | null;
    identity: CornerSignalIdentityV1 | null;
  };
  open?: VisualCommandResultV1;
  evidence: string[];
  error?: {
    code: "refresh_failed" | "host_open_failed";
    message: string;
  };
}
