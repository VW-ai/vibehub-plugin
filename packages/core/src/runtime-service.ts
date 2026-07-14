import fs from "node:fs";
import type {
  AppliedIntervention,
  ConflictCardSnapshot,
  MapSnapshot,
  TaskPanelSnapshot,
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

export interface RuntimeServiceOptions {
  dbPath?: string;
  openDatabase?: (path: string) => Db;
  now?: () => Date;
}

/** Canonicalize an explicitly supplied path; there is deliberately no default. */
export function resolveWorkbenchRepoRef(
  explicitRepoPath: string,
  repoKey?: string,
): WorkbenchRepoRef {
  const repoRoot = GitFacade.resolveRepoRoot(explicitRepoPath);
  return { repoRoot, repoKey: repoKey ?? repoRoot };
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

  constructor(options: RuntimeServiceOptions = {}) {
    this.#dbPath = resolveDbPath(options.dbPath);
    this.#openDatabase = options.openDatabase ?? openDb;
    this.#now = options.now ?? (() => new Date());
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
}
