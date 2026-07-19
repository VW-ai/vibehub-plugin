/**
 * Browser-safe receipt projection for applied injection interventions.
 *
 * This lives in the contract layer (not workflow-receipt-projectors.ts)
 * because the App consumes the SAME projection as Node surfaces — the
 * receipt is the one semantic source of truth and no surface may
 * re-derive its own result vocabulary (decision-workbench-016). It
 * imports types only from sibling contracts and runtime only from the
 * dependency-free workflow-receipt module.
 */
import type { AppliedIntervention, WorkbenchIntervention } from "./workbench-bridge.js";
import type { WorkflowReceiptV1 } from "./workflow-receipt.js";
import { validateWorkflowReceiptStructure } from "./workflow-receipt.js";

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
  const receipt: WorkflowReceiptV1 = {
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
  };
  const validation = validateWorkflowReceiptStructure(receipt);
  if (!validation.ok) throw new Error(`invalid WorkflowReceiptV1 projection: ${validation.errors.join("; ")}`);
  return receipt;
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
