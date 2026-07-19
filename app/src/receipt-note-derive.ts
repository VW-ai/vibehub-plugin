import {
  projectInjectionInterventionReceipt,
  type AppliedIntervention,
  type AppliedInterventionEvidenceV1,
  type WorkbenchIntervention,
} from "@vibehub/core/contracts";

/**
 * View model for an applied-intervention receipt line. `receiptOutcome`
 * carries the shared workflow-receipt outcome (queued/skipped/failed) only
 * when the browser-safe projection accepted the evidence; null means the
 * evidence was weak or the intervention kind is outside the injection
 * projection, and the raw bridge outcome is rendered verbatim instead.
 * The App never re-derives its own result vocabulary
 * (decision-workbench-016) — this module only consumes the contract
 * projection or falls back to the raw fact.
 */
export interface InterventionReceiptNote {
  result: AppliedIntervention;
  receiptOutcome: AppliedInterventionEvidenceV1["outcome"] | null;
}

export const WORKBENCH_INTERVENTION_TRIGGER =
  "A workbench intervention was requested through the bridge.";

export function deriveInterventionNote(
  intervention: WorkbenchIntervention,
  result: AppliedIntervention,
): InterventionReceiptNote {
  if (
    intervention.kind === "inject" ||
    intervention.kind === "pause" ||
    intervention.kind === "inject_both"
  ) {
    try {
      const receipt = projectInjectionInterventionReceipt({
        trigger: WORKBENCH_INTERVENTION_TRIGGER,
        intervention,
        result,
      });
      const outcome = receipt.outcome;
      return {
        result,
        receiptOutcome:
          outcome === "queued" || outcome === "skipped" || outcome === "failed" ? outcome : null,
      };
    } catch {
      // Weak evidence (e.g. a success outcome without persisted injection
      // ids) must never be upgraded to a queued claim.
      return { result, receiptOutcome: null };
    }
  }
  return { result, receiptOutcome: null };
}
