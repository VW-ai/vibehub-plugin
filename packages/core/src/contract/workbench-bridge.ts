import type { ConflictCardSnapshot } from "./conflict-types.js";
import type { MapSnapshot } from "./map-types.js";
import type { TaskPanelSnapshot } from "./panel-types.js";

/** Explicit repository identity; bridge calls never depend on process cwd. */
export interface WorkbenchRepoRef {
  /** Stable repository key in the workbench store. */
  repoKey: string;
  /** Canonical absolute root used by git and worktree resolution. */
  repoRoot: string;
}

export type WorkbenchBridgeErrorStatus =
  | "db_missing"
  | "repo_uninitialized"
  | "unsynced"
  | "not_found"
  | "evidence_unavailable"
  | "idempotency_conflict"
  | "bridge_unavailable"
  | "internal_error";

export interface WorkbenchReadWarning {
  code: "git_unavailable" | "transcript_unavailable";
  message: string;
}

export type WorkbenchBridgeResult<T> =
  | { status: "ok"; data: T; warnings?: WorkbenchReadWarning[] }
  | { status: WorkbenchBridgeErrorStatus; message: string };

export type WorkbenchIntervention =
  | { kind: "inject"; taskId: string; text: string; contextLocus?: string }
  | { kind: "pause"; taskId: string; text: string; contextLocus?: string }
  | { kind: "inject_both"; conflictId: string; text: string; contextLocus?: string }
  | { kind: "ignore_pair"; conflictId: string }
  | { kind: "generate_diagnosis"; conflictId: string };

export interface AppliedIntervention {
  requestId: string;
  outcome: "applied" | "already_applied" | "no_op" | "stale" | "unsupported";
  injectionIds: number[];
  affectedTaskIds: string[];
  acceptedAt: string;
  message?: string;
}

/** Wire contract only. Native/development implementations are later tasks. */
export interface WorkbenchBridge {
  getSnapshot(
    repo: WorkbenchRepoRef,
  ): Promise<WorkbenchBridgeResult<MapSnapshot>>;
  getTaskPanel(
    request: WorkbenchRepoRef & { taskId: string },
  ): Promise<WorkbenchBridgeResult<TaskPanelSnapshot>>;
  getConflictDetail(
    request: WorkbenchRepoRef & { conflictId: string },
  ): Promise<WorkbenchBridgeResult<ConflictCardSnapshot>>;
  applyIntervention(
    request: WorkbenchRepoRef & { requestId: string; intervention: WorkbenchIntervention },
  ): Promise<WorkbenchBridgeResult<AppliedIntervention>>;
}
