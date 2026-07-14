import type {
  AppliedIntervention,
  WorkbenchIntervention,
} from "./contract/workbench-bridge.js";
import type { UserInterventionEvent } from "./contract/panel-types.js";
import type { Db } from "./db.js";
import { appendEvent, enqueueInjection, readTask } from "./activity-store.js";
import {
  isConflictPairIgnored,
  persistIgnoredConflictPair,
  resolveConflictPair,
} from "./conflict-ignore.js";
import crypto from "node:crypto";

export interface ApplyInterventionInput {
  requestId: string;
  intervention: WorkbenchIntervention;
}

export class InterventionTargetNotFoundError extends Error {}
export class InterventionIdempotencyConflictError extends Error {}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function interventionHash(intervention: WorkbenchIntervention): string {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(intervention))).digest("hex");
}

type ConflictRow = {
  id: string;
  repoId: number;
  taskA: string;
  taskB: string;
  resolvedAt: string | null;
  ignored: number;
};

function conflictRow(db: Db, repoId: number, id: string): ConflictRow | null {
  return (db.prepare(
    `SELECT id, repo_id AS repoId, task_a AS taskA, task_b AS taskB,
            resolved_at AS resolvedAt, ignored
     FROM conflicts WHERE repo_id = ? AND id = ?`,
  ).get(repoId, id) as ConflictRow | undefined) ?? null;
}

/**
 * The single write boundary for App interventions. `immediate` obtains the
 * SQLite writer lock before inspecting request_id, so two processes racing
 * the same request cannot both enqueue. Every queue/conflict mutation, its
 * receipt, and one history event per affected task commit or roll back as a
 * unit (including inject-both).
 */
export function applyIntervention(
  db: Db,
  repoId: number,
  input: ApplyInterventionInput,
  now: string,
): AppliedIntervention {
  if (input.requestId.trim() === "") throw new Error("requestId is required");
  const inputHash = interventionHash(input.intervention);

  const run = db.transaction((): AppliedIntervention => {
    const prior = db.prepare(
      `SELECT input_hash AS inputHash, result FROM intervention_requests WHERE repo_id = ? AND request_id = ?`,
    ).get(repoId, input.requestId) as { inputHash: string; result: string } | undefined;
    if (prior) {
      if (prior.inputHash !== inputHash) {
        throw new InterventionIdempotencyConflictError("requestId was reused with a different intervention action, target, text, or behavior-affecting field");
      }
      const receipt = JSON.parse(prior.result) as AppliedIntervention;
      return { ...receipt, outcome: "already_applied" };
    }

    const base = {
      requestId: input.requestId,
      acceptedAt: now,
      injectionIds: [] as number[],
      affectedTaskIds: [] as string[],
    };
    let receipt: AppliedIntervention;
    const intervention = input.intervention;

    if (intervention.kind === "generate_diagnosis") {
      if (!resolveConflictPair(db, repoId, intervention.conflictId)) {
        throw new InterventionTargetNotFoundError("conflict not found in repository");
      }
      receipt = {
        ...base,
        outcome: "unsupported",
        message: "Diagnosis generation is not supported without separate external-model approval.",
      };
    } else if (intervention.kind === "inject" || intervention.kind === "pause") {
      const task = readTask(db, intervention.taskId);
      if (!task || task.repoId !== repoId) throw new InterventionTargetNotFoundError("task not found in repository");
      if (task.state === "done") {
        receipt = { ...base, outcome: "stale", message: "Task is already done." };
      } else if (intervention.kind === "pause" && task.state === "waiting") {
        receipt = {
          ...base,
          outcome: "no_op",
          affectedTaskIds: [task.id],
          message: "Task is already waiting.",
        };
      } else {
        const injectionId = enqueueInjection(
          db, repoId, task.id, intervention.kind, intervention.text, now,
          intervention.contextLocus,
        );
        appendHistory(db, repoId, task.id, intervention.kind, intervention.text, now, input.requestId);
        receipt = {
          ...base,
          outcome: "applied",
          injectionIds: [injectionId],
          affectedTaskIds: [task.id],
        };
      }
    } else {
      const pair = resolveConflictPair(db, repoId, intervention.conflictId);
      if (!pair) throw new InterventionTargetNotFoundError("conflict not found in repository");
      if (intervention.kind === "ignore_pair") {
        if (isConflictPairIgnored(db, repoId, pair.taskIds)) {
          receipt = {
            ...base, outcome: "stale", affectedTaskIds: pair.taskIds,
            message: "Conflict pair is already ignored.",
          };
        } else {
          persistIgnoredConflictPair(db, repoId, pair.taskIds, now);
          db.prepare(`UPDATE conflicts SET ignored = 1 WHERE repo_id = ? AND id = ?`)
            .run(repoId, intervention.conflictId);
          for (const taskId of pair.taskIds) {
            const task = readTask(db, taskId);
            if (task?.repoId === repoId) {
              appendHistory(db, repoId, taskId, "ignore", "Ignored this conflict pair.", now, input.requestId);
            }
          }
          receipt = { ...base, outcome: "applied", affectedTaskIds: pair.taskIds };
        }
      } else {
      const conflict = conflictRow(db, repoId, intervention.conflictId);
      if (!conflict) throw new InterventionTargetNotFoundError("rich conflict not found in repository");
      const taskIds = [conflict.taskA, conflict.taskB];
      const tasks = taskIds.map((id) => readTask(db, id));
      if (tasks.some((task) => !task || task.repoId !== repoId)) {
        throw new InterventionTargetNotFoundError("conflict references a task outside the repository");
      }
      if (conflict.resolvedAt || conflict.ignored) {
        receipt = {
          ...base,
          outcome: "stale",
          affectedTaskIds: taskIds,
          message: "Conflict is already resolved or ignored.",
        };
      } else {
        if (tasks.some((task) => task!.state === "done")) {
          receipt = {
            ...base,
            outcome: "stale",
            affectedTaskIds: taskIds,
            message: "One or both conflict tasks are already done.",
          };
        } else {
          const injectionIds = taskIds.map((taskId) =>
            enqueueInjection(db, repoId, taskId, "inject", intervention.text, now, intervention.contextLocus),
          );
          for (const taskId of taskIds) {
            appendHistory(db, repoId, taskId, "inject", intervention.text, now, input.requestId);
          }
          receipt = { ...base, outcome: "applied", injectionIds, affectedTaskIds: taskIds };
        }
      }
      }
    }

    db.prepare(
      `INSERT INTO intervention_requests (request_id, repo_id, input_hash, result, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.requestId, repoId, inputHash, JSON.stringify(receipt), now);
    return receipt;
  });
  return run.immediate();
}

function appendHistory(
  db: Db,
  repoId: number,
  taskId: string,
  action: UserInterventionEvent["action"],
  text: string,
  at: string,
  requestId: string,
): void {
  appendEvent(db, repoId, taskId, null, {
    id: `intervention:${requestId}:${taskId}`,
    at,
    type: "user_intervention",
    action,
    text,
    requestId,
  });
}
