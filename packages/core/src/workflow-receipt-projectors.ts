import type { ClaimedInjection } from "./activity-store.js";
import type {
  WorkflowActivity,
  WorkflowEffect,
  WorkflowNextActionV1,
  WorkflowReceiptV1,
  WorkflowVisibility,
} from "./contract/workflow-receipt.js";
import {
  CANONICAL_OPERATION_PRESENTATION,
  validateWorkflowReceiptStructure,
} from "./contract/workflow-receipt.js";
import type { WorkbenchIntervention, AppliedIntervention } from "./contract/workbench-bridge.js";
import type { OperationName } from "./operation-contracts.js";
import type { OperationMeta, OperationResult } from "./operation-dispatcher.js";
import type { DoctorRuntimeResult, InitRuntimeResult } from "./runtime-lifecycle.js";

type OperationPresentation = {
  activity: Extract<WorkflowActivity, "query" | "review" | "ingest" | "update" | "distill">;
  effect: Extract<WorkflowEffect, "read" | "write">;
};

export const OPERATION_PRESENTATION: typeof CANONICAL_OPERATION_PRESENTATION =
  CANONICAL_OPERATION_PRESENTATION satisfies Record<OperationName, OperationPresentation>;

interface CommonInput {
  trigger: string;
  nextAction?: WorkflowNextActionV1 | null;
  visibility?: WorkflowVisibility;
}

export interface OperationReceiptInput extends CommonInput {
  result: OperationResult;
  /** Required for failures because legacy OperationResult errors have no meta. */
  attempt?: OperationMeta;
}

export function projectOperationReceipt(input: OperationReceiptInput): WorkflowReceiptV1 {
  const identity = operationIdentity(input);
  const presentation = presentationFor(identity.operation);
  const outcome = input.result.ok
    ? presentation.effect === "read" ? "returned" : "persisted"
    : "failed";
  const counts = input.result.ok && presentation.effect === "read"
    ? returnedCounts(input.result.data)
    : {};
  const nextAction = input.result.ok
    ? input.nextAction ?? null
    : {
        required: true,
        instruction: bounded(
          input.result.error.nextSafeActions[0]
            ?? `Inspect ${input.result.error.code} and retry the operation safely.`,
        ),
      };
  return checked({
    schemaVersion: 1,
    activity: presentation.activity,
    phase: "complete",
    outcome,
    visibility: input.result.ok ? input.visibility ?? "brief" : "expanded",
    trigger: bounded(input.trigger),
    evidence: [{
      source: "operation_result",
      operation: identity.operation,
      repoId: identity.repoId,
      requestId: identity.requestId,
      ok: input.result.ok,
      effect: presentation.effect,
      outcome,
      subject: `${identity.operation} request ${identity.requestId}`,
      ...(!input.result.ok
        ? { detail: bounded(`${input.result.error.code}: ${input.result.error.message}`) }
        : {}),
      ...counts,
    }],
    nextAction,
    at: identity.at,
  });
}

export interface InitReceiptInput {
  trigger: string;
  result: InitRuntimeResult;
  at: string;
}

export function projectInitReceipt(input: InitReceiptInput): WorkflowReceiptV1 {
  const outcome = input.result.ok ? "persisted" : "waiting";
  return checked({
    schemaVersion: 1,
    activity: "setup",
    phase: "complete",
    outcome,
    visibility: "expanded",
    trigger: bounded(input.trigger),
    evidence: [{
      source: "init_runtime_result",
      effect: "write",
      outcome,
      subject: bounded(input.result.repo.root),
      ok: input.result.ok,
      repoId: input.result.repo.id,
      schemaVersion: input.result.schemaVersion,
      conflictCount: input.result.conflicts.length,
    }],
    nextAction: input.result.ok
      ? null
      : { required: true, instruction: "Review managed asset conflicts before retrying setup." },
    at: input.at,
  });
}

export interface DoctorReceiptInput {
  trigger: string;
  result: DoctorRuntimeResult;
  at: string;
}

export function projectDoctorReceipt(input: DoctorReceiptInput): WorkflowReceiptV1 {
  const computedHealthy = input.result.db.status === "healthy"
    && input.result.nativeDependency.status === "healthy"
    && input.result.repo.status === "healthy"
    && input.result.managedAssets.status === "healthy";
  if (computedHealthy !== input.result.healthy) {
    throw new Error("doctor healthy boolean contradicts component statuses");
  }
  const outcome = computedHealthy ? "verified" : "failed";
  return checked({
    schemaVersion: 1,
    activity: "setup",
    phase: "complete",
    outcome,
    visibility: computedHealthy ? "brief" : "expanded",
    trigger: bounded(input.trigger),
    evidence: [{
      source: "doctor_runtime_result",
      effect: "health_check",
      outcome,
      subject: "VibeHub runtime connectivity",
      computedHealthy,
      dbStatus: input.result.db.status,
      nativeStatus: input.result.nativeDependency.status,
      repoStatus: input.result.repo.status,
      managedAssetsStatus: input.result.managedAssets.status,
    }],
    nextAction: computedHealthy
      ? null
      : { required: true, instruction: "Repair the unhealthy runtime checks before continuing setup." },
    at: input.at,
  });
}

type InjectionIntervention = Extract<
  WorkbenchIntervention,
  { kind: "inject" | "pause" | "inject_both" }
>;

export interface InjectionInterventionReceiptInput {
  trigger: string;
  intervention: InjectionIntervention;
  result: AppliedIntervention;
}

export function projectInjectionInterventionReceipt(
  input: InjectionInterventionReceiptInput,
): WorkflowReceiptV1 {
  const canQueue = input.result.outcome === "applied" || input.result.outcome === "already_applied";
  if (canQueue && !validIds(input.result.injectionIds, true)) {
    throw new Error("queued intervention requires non-empty unique positive safe injection ids");
  }
  const expectedIds = input.intervention.kind === "inject_both" ? 2 : 1;
  if (canQueue && input.result.injectionIds.length !== expectedIds) {
    throw new Error(`${input.intervention.kind} requires exactly ${expectedIds} persisted injection ids`);
  }
  if (!canQueue && !validIds(input.result.injectionIds, false)) {
    throw new Error("intervention result contains invalid injection ids");
  }
  const outcome = canQueue
    ? "queued"
    : input.result.outcome === "unsupported"
      ? "failed"
      : "skipped";
  return checked({
    schemaVersion: 1,
    activity: "inject",
    phase: "complete",
    outcome,
    visibility: outcome === "failed" ? "expanded" : "brief",
    trigger: bounded(input.trigger),
    evidence: [{
      source: "applied_intervention",
      effect: "injection",
      outcome,
      subject: input.intervention.kind === "inject_both"
        ? `${input.intervention.kind} conflict ${input.intervention.conflictId}`
        : `${input.intervention.kind} task ${input.intervention.taskId}`,
      requestId: bounded(input.result.requestId),
      originalKind: input.intervention.kind,
      resultOutcome: input.result.outcome,
      ...(input.result.replayed === undefined ? {} : { replayed: input.result.replayed }),
      injectionIds: [...input.result.injectionIds],
      ...(input.result.message ? { detail: bounded(input.result.message) } : {}),
    }],
    nextAction: outcome === "failed"
      ? { required: true, instruction: bounded(input.result.message ?? "Use a supported injection intervention and retry.") }
      : null,
    at: input.result.acceptedAt,
  });
}

export interface InjectionClaimReceiptInput {
  trigger: string;
  taskId: string;
  claimed: readonly ClaimedInjection[];
  hookEvent: string;
  at: string;
}

export function projectInjectionClaimReceipt(input: InjectionClaimReceiptInput): WorkflowReceiptV1 {
  if (!validClaimed(input.claimed)) {
    throw new Error("claimed injections require complete mechanical results with unique positive safe injection ids");
  }
  return checked({
    schemaVersion: 1,
    activity: "inject",
    phase: "complete",
    outcome: "claimed",
    visibility: "brief",
    trigger: bounded(input.trigger),
    evidence: [{
      source: "hook_evidence",
      effect: "injection",
      outcome: "claimed",
      subject: `injection claim for task ${bounded(input.taskId)}`,
      hookEvent: bounded(input.hookEvent),
      injectionIds: input.claimed.map((item) => item.id),
      injectionModes: input.claimed.map((item) => item.mode),
    }],
    nextAction: null,
    at: input.at,
  });
}

function operationIdentity(input: OperationReceiptInput): OperationMeta {
  if (input.result.ok) {
    if (input.attempt && (
      input.attempt.operation !== input.result.meta.operation
      || input.attempt.repoId !== input.result.meta.repoId
      || input.attempt.requestId !== input.result.meta.requestId
    )) {
      throw new Error("operation attempt identity does not match successful result meta");
    }
    return input.result.meta;
  }
  if (!input.attempt) throw new Error("failed operation projection requires attempt identity");
  return input.attempt;
}

function presentationFor(operation: string): OperationPresentation {
  if (!Object.prototype.hasOwnProperty.call(OPERATION_PRESENTATION, operation)) {
    throw new Error(`unknown canonical operation: ${operation}`);
  }
  return OPERATION_PRESENTATION[operation as OperationName];
}

function returnedCounts(data: unknown): { returnedCount?: number; totalCount?: number } {
  if (Array.isArray(data)) return { returnedCount: data.length, totalCount: data.length };
  if (!isRecord(data)) return {};
  let returnedCount: number | undefined;
  for (const key of ["items", "matches", "results", "rows", "features", "specs"]) {
    const value = data[key];
    if (Array.isArray(value)) {
      returnedCount = value.length;
      break;
    }
  }
  let totalCount: number | undefined;
  for (const key of ["total", "count"]) {
    const value = data[key];
    if (Number.isSafeInteger(value) && Number(value) >= 0) {
      totalCount = Number(value);
      break;
    }
  }
  if (returnedCount !== undefined && totalCount === undefined) totalCount = returnedCount;
  return {
    ...(returnedCount === undefined ? {} : { returnedCount }),
    ...(totalCount === undefined ? {} : { totalCount }),
  };
}

function checked(receipt: WorkflowReceiptV1): WorkflowReceiptV1 {
  const validation = validateWorkflowReceiptStructure(receipt);
  if (!validation.ok) throw new Error(`invalid WorkflowReceiptV1 projection: ${validation.errors.join("; ")}`);
  return receipt;
}

function validClaimed(value: readonly ClaimedInjection[]): boolean {
  return value.length > 0
    && validIds(value.map((item) => item.id), true)
    && value.every((item) =>
      (item.mode === "inject" || item.mode === "pause")
      && typeof item.text === "string"
      && (item.context === null || typeof item.context === "string")
      && typeof item.createdAt === "string"
      && item.createdAt.length > 0);
}

function validIds(value: readonly number[], nonEmpty: boolean): boolean {
  return (!nonEmpty || value.length > 0)
    && value.every((id) => Number.isSafeInteger(id) && id > 0)
    && new Set(value).size === value.length;
}

function bounded(value: string): string {
  const chars = [...value];
  return chars.length <= 20_000 ? value : `${chars.slice(0, 19_999).join("")}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
