import fs from "node:fs";
import type {
  AppliedIntervention,
  ConflictCardSnapshot,
  LiveShellActivationV1,
  LiveShellProjectorInput,
  LiveShellRepoRef,
  LiveShellWorkspaceV1,
  MapSnapshot,
  TaskPanelSnapshot,
  WorkflowReceiptV1,
  WorkbenchIntervention,
  WorkbenchBridgeResult,
  WorkbenchRepoRef,
} from "./contract/index.js";
import { openDb, resolveDbPath, type Db } from "./db.js";
import { GitFacade } from "./git-facade.js";
import { exportTeamMapSnapshot } from "./snapshot-export.js";
import { getRepoByRoot, readSyncState } from "./team-store.js";
import { readConflictDetailModel, readTaskPanelModel } from "./live-read-models.js";
import { applyIntervention as applyInterventionTransaction } from "./intervention-service.js";
import { InterventionIdempotencyConflictError, InterventionTargetNotFoundError } from "./intervention-service.js";
import {
  doctorRuntime,
  initializeRuntime,
  type DoctorRuntimeResult,
  type InitRuntimeResult,
  type ManagedAssetManifest,
} from "./runtime-lifecycle.js";
import {
  readFootprints,
  readTimeline,
  sessionIdentity,
} from "./activity-store.js";
import { readScopePatterns } from "./scope-registry.js";
import {
  applyProjectActivation,
  inspectProjectActivation,
  readProjectActivationStatus,
  type ProjectActivationOptions,
  type ProjectActivationResultV1,
} from "./project-activation.js";
import {
  projectLiveShellSnapshot,
  selectLiveShellCurrentTask,
} from "./live-shell-projector.js";
import {
  projectInjectionInterventionReceipt,
  projectOperationReceipt,
} from "./workflow-receipt-projectors.js";
import type { OperationMeta, OperationResult } from "./operation-dispatcher.js";

export interface RuntimeServiceOptions {
  dbPath?: string;
  openDatabase?: (path: string) => Db;
  now?: () => Date;
  /**
   * Optional real activation evidence configuration. When absent the live
   * shell reports activation as unavailable instead of inferring readiness.
   */
  liveShellActivation?: {
    stateDir: string;
    allowedAssetRoot: string;
    manifest: ManagedAssetManifest;
  };
}

/** Canonicalize an explicitly supplied path; there is deliberately no default. */
export function resolveWorkbenchRepoRef(
  explicitRepoPath: string,
  repoKey?: string,
): WorkbenchRepoRef {
  const repoRoot = GitFacade.resolveRepoRoot(explicitRepoPath);
  return { repoRoot, repoKey: repoKey ?? repoRoot };
}

/** Resolve both stable repository identity and this exact checkout. */
export function resolveLiveShellRepoRef(
  explicitCheckoutPath: string,
  host: string,
  repoKey?: string,
): LiveShellRepoRef {
  const context = GitFacade.sessionContextAt(explicitCheckoutPath);
  return {
    repoKey: repoKey ?? context.repoRoot,
    repoRoot: context.repoRoot,
    checkoutRoot: context.toplevel,
    host,
  };
}

/**
 * Core-owned read boundary used by native and development hosts. It never
 * creates a database on a read: a missing SQLite file is a setup state, not
 * an invitation to manufacture an empty successful workbench.
 */
export class RuntimeService {
  readonly #dbPath: string;
  readonly #openDatabase: (path: string) => Db;
  readonly #now: () => Date;
  readonly #liveShellActivation: RuntimeServiceOptions["liveShellActivation"];

  constructor(options: RuntimeServiceOptions = {}) {
    this.#dbPath = resolveDbPath(options.dbPath);
    this.#openDatabase = options.openDatabase ?? openDb;
    this.#now = options.now ?? (() => new Date());
    this.#liveShellActivation = options.liveShellActivation;
  }

  initialize(
    repoPath: string,
    stateDir: string,
    allowedAssetRoot: string,
    manifest: ManagedAssetManifest,
  ): InitRuntimeResult {
    return initializeRuntime({
      repoPath,
      dbPath: this.#dbPath,
      stateDir,
      allowedAssetRoot,
      manifest,
      now: this.#now,
    });
  }

  doctor(
    repoPath: string,
    stateDir: string,
    allowedAssetRoot: string,
    manifest: ManagedAssetManifest,
  ): DoctorRuntimeResult {
    return doctorRuntime({
      repoPath,
      dbPath: this.#dbPath,
      stateDir,
      allowedAssetRoot,
      manifest,
      now: this.#now,
    });
  }

  inspectProjectActivation(
    repoPath: string,
    stateDir: string,
    allowedAssetRoot: string,
    manifest: ManagedAssetManifest,
  ): ProjectActivationResultV1 {
    return inspectProjectActivation(this.#activationOptions(repoPath, stateDir, allowedAssetRoot, manifest));
  }

  applyProjectActivation(
    repoPath: string,
    stateDir: string,
    allowedAssetRoot: string,
    manifest: ManagedAssetManifest,
    overrides: Pick<ProjectActivationOptions, "instructionVersion" | "instructionBody" | "instructionFault"> = {},
  ): ProjectActivationResultV1 {
    return applyProjectActivation({
      ...this.#activationOptions(repoPath, stateDir, allowedAssetRoot, manifest),
      ...overrides,
    });
  }

  readProjectActivationStatus(
    repoPath: string,
    stateDir: string,
    allowedAssetRoot: string,
    manifest: ManagedAssetManifest,
  ): ProjectActivationResultV1 {
    return readProjectActivationStatus(this.#activationOptions(repoPath, stateDir, allowedAssetRoot, manifest));
  }

  readWorkbenchSnapshot(
    repo: WorkbenchRepoRef,
  ): WorkbenchBridgeResult<MapSnapshot> {
    if (!fs.existsSync(this.#dbPath)) {
      return {
        status: "db_missing",
        message: `VibeHub database not found at ${this.#dbPath}. Run vibehub init first.`,
      };
    }

    let db: Db | undefined;
    try {
      db = this.#openDatabase(this.#dbPath);
      const storedRepo = getRepoByRoot(db, repo.repoRoot);
      if (!storedRepo) {
        return {
          status: "repo_uninitialized",
          message: `Repository ${repo.repoKey} has not been initialized in VibeHub.`,
        };
      }

      const sync = readSyncState(db, storedRepo.id);
      if (!sync?.lastSyncedAt) {
        return {
          status: "unsynced",
          message: `Repository ${repo.repoKey} has not completed its first sync.`,
        };
      }

      return {
        status: "ok",
        data: exportTeamMapSnapshot(db, repo.repoRoot),
      };
    } catch (error) {
      return {
        status: "internal_error",
        message:
          error instanceof Error
            ? `Could not read the workbench snapshot: ${error.message}`
            : "Could not read the workbench snapshot.",
      };
    } finally {
      db?.close();
    }
  }

  /**
   * Section-degrading live read. Identity remains useful even when SQLite,
   * sync, activation, or current-task evidence is missing.
   */
  readLiveShell(
    repo: LiveShellRepoRef,
  ): WorkbenchBridgeResult<ReturnType<typeof projectLiveShellSnapshot>> {
    let canonical: LiveShellRepoRef;
    try {
      canonical = resolveLiveShellRepoRef(repo.checkoutRoot, repo.host, repo.repoKey);
    } catch (error) {
      return {
        status: "internal_error",
        message: `Invalid live shell checkout identity: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (canonical.repoRoot !== repo.repoRoot || canonical.checkoutRoot !== repo.checkoutRoot) {
      return {
        status: "internal_error",
        message: "Live shell repoRoot/checkoutRoot identity does not match the canonical Git checkout.",
      };
    }
    const capturedAt = this.#now().toISOString();
    const input: LiveShellProjectorInput = {
      capturedAt,
      identity: { data: canonical, freshness: "live" },
      activation: this.#readLiveShellActivation(canonical),
      workspace: this.#readLiveShellWorkspace(canonical, capturedAt),
    };
    return { status: "ok", data: projectLiveShellSnapshot(input) };
  }

  readTaskPanel(
    repo: WorkbenchRepoRef,
    taskId: string,
  ): WorkbenchBridgeResult<TaskPanelSnapshot> {
    return this.#withRepo(repo, (db, repoId) => {
      const model = readTaskPanelModel(
        db, repoId, repo.repoRoot, taskId, this.#now().toISOString(),
      );
      return model
        ? { status: "ok", data: model.data, ...(model.warnings.length ? { warnings: model.warnings } : {}) }
        : { status: "not_found", message: `Task ${taskId} was not found.` };
    }, "read the task panel");
  }

  readConflictDetail(
    repo: WorkbenchRepoRef,
    conflictId: string,
  ): WorkbenchBridgeResult<ConflictCardSnapshot> {
    return this.#withRepo(repo, (db, repoId) => {
      const model = readConflictDetailModel(
        db, repoId, repo.repoRoot, conflictId, this.#now().toISOString(),
      );
      if (model.status === "ok") return { status: "ok", data: model.data };
      if (model.status === "evidence_unavailable") return model;
      return { status: "not_found", message: `Conflict ${conflictId} was not found.` };
    }, "read the conflict detail");
  }

  applyIntervention(
    repo: WorkbenchRepoRef,
    requestId: string,
    intervention: WorkbenchIntervention,
  ): WorkbenchBridgeResult<AppliedIntervention> {
    return this.#withRepo(repo, (db, repoId) => ({
      status: "ok",
      data: applyInterventionTransaction(
        db, repoId, { requestId, intervention }, this.#now().toISOString(),
      ),
    }), "apply the intervention");
  }

  #withRepo<T>(
    repo: WorkbenchRepoRef,
    fn: (db: Db, repoId: number) => WorkbenchBridgeResult<T>,
    operation: string,
  ): WorkbenchBridgeResult<T> {
    if (!fs.existsSync(this.#dbPath)) {
      return { status: "db_missing", message: `VibeHub database not found at ${this.#dbPath}. Run vibehub init first.` };
    }
    let db: Db | undefined;
    try {
      db = this.#openDatabase(this.#dbPath);
      const storedRepo = getRepoByRoot(db, repo.repoRoot);
      if (!storedRepo) return { status: "repo_uninitialized", message: `Repository ${repo.repoKey} has not been initialized in VibeHub.` };
      const sync = readSyncState(db, storedRepo.id);
      if (!sync?.lastSyncedAt) return { status: "unsynced", message: `Repository ${repo.repoKey} has not completed its first sync.` };
      return fn(db, storedRepo.id);
    } catch (error) {
      if (error instanceof InterventionTargetNotFoundError) {
        return { status: "not_found", message: error.message };
      }
      if (error instanceof InterventionIdempotencyConflictError) {
        return { status: "idempotency_conflict", message: error.message };
      }
      return {
        status: "internal_error",
        message: error instanceof Error ? `Could not ${operation}: ${error.message}` : `Could not ${operation}.`,
      };
    } finally {
      db?.close();
    }
  }

  #readLiveShellActivation(
    repo: LiveShellRepoRef,
  ): LiveShellProjectorInput["activation"] {
    const configured = this.#liveShellActivation;
    if (!configured) {
      return {
        data: null,
        freshness: "unknown",
        issue: {
          code: "activation_not_configured",
          instruction: "Configure the managed runtime manifest and activation state roots to inspect activation evidence.",
        },
      };
    }
    try {
      const result = readProjectActivationStatus({
        ...this.#activationOptions(
          repo.checkoutRoot,
          configured.stateDir,
          configured.allowedAssetRoot,
          configured.manifest,
        ),
      });
      const data: LiveShellActivationV1 = {
        installed: result.activation.installed,
        connected: result.activation.connected,
        activated: result.activation.activated,
      };
      const complete = result.errors.length === 0
        && Object.values(data).every((proof) => proof.state === "proven");
      return {
        data,
        freshness: "live",
        ...(!complete
          ? {
              issue: {
                code: "activation_evidence_partial" as const,
                instruction: "Inspect project activation evidence and address the reported not-proven or blocked stages.",
              },
            }
          : {}),
      };
    } catch (error) {
      return {
        data: null,
        freshness: "unknown",
        issue: {
          code: "source_read_failed",
          instruction: `Retry activation inspection after resolving: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  #readLiveShellWorkspace(
    repo: LiveShellRepoRef,
    capturedAt: string,
  ): LiveShellProjectorInput["workspace"] {
    if (!fs.existsSync(this.#dbPath)) {
      return {
        data: null,
        freshness: "unknown",
        issue: {
          code: "database_missing",
          instruction: `Initialize VibeHub to create the database at ${this.#dbPath}.`,
        },
      };
    }
    let db: Db | undefined;
    try {
      db = this.#openDatabase(this.#dbPath);
      const storedRepo = getRepoByRoot(db, repo.repoRoot);
      if (!storedRepo) {
        return {
          data: null,
          freshness: "unknown",
          issue: {
            code: "repository_uninitialized",
            instruction: `Initialize repository ${repo.repoKey} in VibeHub.`,
          },
        };
      }

      const sync = readSyncState(db, storedRepo.id);
      const map = exportTeamMapSnapshot(db, repo.repoRoot, {
        now: () => new Date(capturedAt),
      });
      const currentTask = selectLiveShellCurrentTask(map.tasks, repo.checkoutRoot);
      let currentSession: LiveShellWorkspaceV1["currentSession"] = null;
      const timeline = currentTask ? readTimeline(db, currentTask.id) : [];
      const declaredScope = currentTask ? readScopePatterns(db, currentTask.id) : [];
      const observedFootprint = currentTask
        ? readFootprints(db, currentTask.id).map((footprint) => ({
            path: footprint.path,
            access: footprint.action === "edit" ? "write" as const : "read" as const,
            observedAt: footprint.at,
          }))
        : [];
      if (currentTask) {
        const latest = db.prepare(
          `SELECT id, started_at AS startedAt, ended_at AS endedAt, end_reason AS endReason
           FROM sessions WHERE repo_id = ? AND task_id = ?
           ORDER BY started_at DESC, id DESC LIMIT 1`,
        ).get(storedRepo.id, currentTask.id) as {
          id: string;
          startedAt: string;
          endedAt: string | null;
          endReason: "context_limit" | "user_ended" | "completed" | null;
        } | undefined;
        const identity = latest ? sessionIdentity(db, currentTask.id, latest.id) : null;
        currentSession = latest && identity ? {
          id: latest.id,
          startedAt: latest.startedAt,
          endedAt: latest.endedAt,
          lifecycle: latest.endedAt === null ? "active" : "ended",
          endReason: latest.endReason,
          identity,
        } : null;
      }
      const { receipts, incomplete } = this.#readLiveShellReceipts(db, storedRepo.id);
      const data: LiveShellWorkspaceV1 = {
        authorityModel: "beta_compatibility",
        map,
        currentTask,
        currentSession,
        declaredScope,
        observedFootprint,
        timeline,
        receipts,
        receiptCoverage: this.#receiptCoverage(),
      };
      const issue = !sync?.lastSyncedAt
        ? {
            code: "repository_unsynced" as const,
            instruction: `Sync repository ${repo.repoKey} to refresh branch and map evidence.`,
          }
        : incomplete
          ? {
              code: "source_read_failed" as const,
              instruction: "Some stored operation receipts could not be projected; inspect the receipt source and retry.",
            }
          : !currentTask
            ? {
                code: "task_not_observed" as const,
                instruction: "Start or select a task in this checkout to populate task-scoped evidence.",
              }
            : {
                code: "receipt_source_incomplete" as const,
                instruction: "Intervention claim and checkpoint sources do not provide complete canonical receipt evidence.",
              };
      return {
        data,
        freshness: !sync?.lastSyncedAt || map.sync.stale ? "stale" : "live",
        ...(issue ? { issue } : {}),
      };
    } catch (error) {
      return {
        data: null,
        freshness: "unknown",
        issue: {
          code: "source_read_failed",
          instruction: `Retry the live shell read after resolving: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    } finally {
      db?.close();
    }
  }

  #readLiveShellReceipts(
    db: Db,
    repoId: number,
  ): { receipts: WorkflowReceiptV1[]; incomplete: boolean } {
    const rows = db.prepare(
      `SELECT request_id AS requestId, operation, outcome, created_at AS createdAt
       FROM operation_request_receipts
       WHERE repo_id = ?
       ORDER BY created_at DESC, request_id DESC LIMIT 100`,
    ).all(repoId) as Array<{
      operation: string;
      requestId: string;
      outcome: string;
      createdAt: string;
    }>;
    const receipts: WorkflowReceiptV1[] = [];
    let incomplete = false;
    for (const row of rows.reverse()) {
      try {
        const result = JSON.parse(row.outcome) as OperationResult;
        const attempt: OperationMeta | undefined = result.ok ? undefined : {
          operation: row.operation,
          repoId,
          requestId: row.requestId,
          at: row.createdAt,
        };
        receipts.push(projectOperationReceipt({
          result,
          ...(attempt ? { attempt } : {}),
          trigger: row.operation,
        }));
      } catch {
        incomplete = true;
      }
    }
    const interventions = db.prepare(
      `SELECT request_id AS requestId, result, created_at AS createdAt
       FROM intervention_requests WHERE repo_id = ?
       ORDER BY created_at, request_id`,
    ).all(repoId) as Array<{ requestId: string; result: string; createdAt: string }>;
    for (const row of interventions) {
      try {
        const facts = db.prepare(
          `SELECT task_id AS taskId, payload FROM events
           WHERE repo_id = ? AND type = 'user_intervention'
             AND json_extract(payload, '$.requestId') = ?
           ORDER BY id`,
        ).all(repoId, row.requestId) as Array<{ taskId: string; payload: string }>;
        if (facts.length !== 1) {
          incomplete = true;
          continue;
        }
        const event = JSON.parse(facts[0]!.payload) as {
          action: string;
          text: string;
        };
        if (event.action !== "inject" && event.action !== "pause") {
          incomplete = true;
          continue;
        }
        receipts.push(projectInjectionInterventionReceipt({
          trigger: `intervention:${row.requestId}`,
          intervention: {
            kind: event.action,
            taskId: facts[0]!.taskId,
            text: event.text,
          },
          result: JSON.parse(row.result) as AppliedIntervention,
        }));
      } catch {
        incomplete = true;
      }
    }
    receipts.sort((a, b) => a.at.localeCompare(b.at) || a.trigger.localeCompare(b.trigger));
    return { receipts, incomplete };
  }

  #receiptCoverage(): LiveShellWorkspaceV1["receiptCoverage"] {
    const unavailable = (detail: string) => ({
      availability: "unavailable" as const,
      freshness: "unknown" as const,
      data: { detail },
      recovery: [{
        code: "inspect_receipt_coverage" as const,
        instruction: detail,
      }],
    });
    return {
      operation_request: {
        availability: "available",
        freshness: "live",
        data: { detail: "Canonical operation_request_receipts are projected with WorkflowReceiptV1." },
        recovery: [],
      },
      intervention_queue: {
        availability: "partial",
        freshness: "live",
        data: {
          detail: "Single-task inject/pause queue receipts are projected from transactional result plus matching history; conflict-wide and ignore inputs remain incomplete.",
        },
        recovery: [{
          code: "inspect_receipt_coverage",
          instruction: "Treat unsupported intervention shapes as uncovered rather than reconstructing their original input.",
        }],
      },
      injection_claim: unavailable(
        "Claim rows are not linked to a canonical hook event receipt; do not infer delivery from claimed_at.",
      ),
      checkpoint: unavailable(
        "Checkpoint cadence facts do not persist a canonical WorkflowReceiptV1 source; do not infer checkpoint success.",
      ),
    };
  }

  #activationOptions(
    repoPath: string,
    stateDir: string,
    allowedAssetRoot: string,
    manifest: ManagedAssetManifest,
  ): ProjectActivationOptions {
    return {
      repoPath,
      dbPath: this.#dbPath,
      stateDir,
      allowedAssetRoot,
      manifest,
      now: this.#now,
    };
  }
}
