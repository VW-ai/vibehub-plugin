/**
 * Browser-safe Ticket proposal V0 contracts.
 *
 * A proposal is an immutable review contribution. It is not a Ticket state,
 * graph mutation, validation receipt, GateDecision, or authority grant.
 */

export const TICKET_PROPOSAL_SCHEMA_VERSION = 1 as const;
export const TICKET_PROPOSAL_MAX_CHANGES = 200;
export const TICKET_PROPOSAL_MAX_DEPENDENCIES_PER_CHANGE = 200;
export const TICKET_PROPOSAL_MAX_INPUT_BYTES = 4 * 1024 * 1024;
export const TICKET_PROPOSAL_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const TICKET_PROPOSAL_DEFAULT_PAGE_SIZE = 50;
export const TICKET_PROPOSAL_MAX_PAGE_SIZE = 100;

export const TICKET_PROPOSAL_VALIDATION_SCHEMA_VERSION = 1 as const;
export const TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES = 1024 * 1024;
export const TICKET_PROPOSAL_VALIDATION_DEFAULT_PAGE_SIZE = 50;
export const TICKET_PROPOSAL_VALIDATION_MAX_PAGE_SIZE = 100;
export const TICKET_PROPOSAL_VALIDATION_MAX_FINDINGS = 200;
export const TICKET_PROPOSAL_VALIDATION_MAX_EVIDENCE_REFS = 50;

/**
 * These checks freeze the first proposal-specific semantic review handoff.
 * They do not double as Ticket-definition readiness/maturity validation.
 */
export const TICKET_PROPOSAL_VALIDATION_CHECK_CODES = [
  "promise_preservation",
  "containment_truth",
  "dependency_truth",
  "change_classification",
  "delegated_scope",
  "protected_boundaries",
] as const;
export type TicketProposalValidationCheckCodeV0 =
  typeof TICKET_PROPOSAL_VALIDATION_CHECK_CODES[number];

/**
 * Exact JSON UTF-8 budget check without materializing the serialized input.
 *
 * The traversal is iterative and consumes strings code unit by code unit, so
 * it returns as soon as the byte budget is exceeded. Inputs outside JSON's
 * value model, exotic objects, getters that throw, and cycles fail closed.
 */
export function isTicketProposalInputWithinBudgetV0(value: unknown): boolean {
  return isJsonValueWithinByteBudgetV0(value, TICKET_PROPOSAL_MAX_INPUT_BYTES);
}

export function isTicketProposalValidationInputWithinBudgetV0(
  value: unknown,
): boolean {
  return isJsonValueWithinByteBudgetV0(
    value,
    TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES,
  );
}

export function isJsonValueWithinByteBudgetV0(
  value: unknown,
  maximumBytes: number,
): boolean {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return false;
  type Frame =
    | { kind: "value"; value: unknown }
    | { kind: "array"; value: unknown[]; index: number }
    | {
        kind: "object";
        value: Record<string, unknown>;
        keys: IterableIterator<string>;
        wroteProperty: boolean;
      };

  let remaining = maximumBytes;
  const active = new WeakSet<object>();
  const frames: Frame[] = [{ kind: "value", value }];
  const consume = (bytes: number): boolean => {
    remaining -= bytes;
    return remaining >= 0;
  };
  const consumeString = (text: string): boolean => {
    if (!consume(2)) return false;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 0x22 || code === 0x5c) {
        if (!consume(2)) return false;
      } else if (
        code === 0x08
        || code === 0x09
        || code === 0x0a
        || code === 0x0c
        || code === 0x0d
      ) {
        if (!consume(2)) return false;
      } else if (code <= 0x1f) {
        if (!consume(6)) return false;
      } else if (code <= 0x7f) {
        if (!consume(1)) return false;
      } else if (code <= 0x7ff) {
        if (!consume(2)) return false;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          index += 1;
          if (!consume(4)) return false;
        } else if (!consume(6)) {
          return false;
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        if (!consume(6)) return false;
      } else if (!consume(3)) {
        return false;
      }
    }
    return true;
  };

  try {
    while (frames.length > 0) {
      const frame = frames.pop()!;
      if (frame.kind === "array") {
        if (frame.index >= frame.value.length) {
          active.delete(frame.value);
          if (!consume(1)) return false;
          continue;
        }
        if (frame.index > 0 && !consume(1)) return false;
        const item = frame.value[frame.index];
        frames.push({ ...frame, index: frame.index + 1 });
        frames.push({ kind: "value", value: item });
        continue;
      }
      if (frame.kind === "object") {
        let entry = frame.keys.next();
        while (!entry.done && !Object.prototype.propertyIsEnumerable.call(frame.value, entry.value)) {
          entry = frame.keys.next();
        }
        if (entry.done) {
          active.delete(frame.value);
          if (!consume(1)) return false;
          continue;
        }
        if (frame.wroteProperty && !consume(1)) return false;
        if (!consumeString(entry.value) || !consume(1)) return false;
        let child: unknown;
        try {
          child = frame.value[entry.value];
        } catch {
          return false;
        }
        frames.push({ ...frame, wroteProperty: true });
        frames.push({ kind: "value", value: child });
        continue;
      }

      const item = frame.value;
      if (item === null) {
        if (!consume(4)) return false;
      } else if (typeof item === "string") {
        if (!consumeString(item)) return false;
      } else if (typeof item === "boolean") {
        if (!consume(item ? 4 : 5)) return false;
      } else if (typeof item === "number") {
        const encoded = Number.isFinite(item) ? JSON.stringify(item) : "null";
        if (!encoded || !consume(encoded.length)) return false;
      } else if (Array.isArray(item)) {
        if (active.has(item) || !consume(1)) return false;
        active.add(item);
        frames.push({ kind: "array", value: item, index: 0 });
      } else if (typeof item === "object") {
        const prototype = Object.getPrototypeOf(item);
        if (
          (prototype !== Object.prototype && prototype !== null)
          || active.has(item)
          || !consume(1)
        ) {
          return false;
        }
        active.add(item);
        frames.push({
          kind: "object",
          value: item as Record<string, unknown>,
          keys: function* ownEnumerableKeys() {
            for (const key in item) yield key;
          }(),
          wroteProperty: false,
        });
      } else {
        return false;
      }
    }
  } catch {
    return false;
  }
  return true;
}

export const TICKET_PROPOSAL_CHANGE_CLASSES = [
  "elaboration",
  "decomposition",
  "expansion",
] as const;
export type TicketProposalChangeClassV0 =
  typeof TICKET_PROPOSAL_CHANGE_CLASSES[number];

/**
 * Protected-boundary signals are deliberately few and product-facing.
 * Technical difficulty alone is not an authority signal.
 */
export const TICKET_PROPOSAL_AUTHORITY_SIGNALS = [
  "initial_plan_authority",
  "experience_product",
  "principle_deviation",
  "permission_side_effect",
  "risk_policy",
] as const;
export type TicketProposalAuthoritySignalV0 =
  typeof TICKET_PROPOSAL_AUTHORITY_SIGNALS[number];

export type TicketProposalSourceV0 = {
  kind: "ticket" | "run" | "plan" | "conversation" | "other";
  ref: string;
};

export type TicketProposalExactSubjectV0 =
  | {
      kind: "ticket";
      ticketId: string;
      definitionRevision: number;
    }
  | {
      kind: "relation";
      relationRef: string;
      prerequisiteTicketId: string;
      dependentTicketId: string;
    };

export type TicketProposalDefinitionRefV0 =
  | {
      kind: "ticket";
      ticketId: string;
    }
  | {
      kind: "local";
      localRef: string;
    };

export interface TicketProposalDependencyInputV0 {
  target: TicketProposalDefinitionRefV0;
  rationale?: string;
}

export interface TicketProposalDefinitionBodyInputV0 {
  outcome: string;
  parent: TicketProposalDefinitionRefV0 | null;
  dependsOn: TicketProposalDependencyInputV0[];
}

export type TicketProposalGraphChangeInputV0 =
  | {
      op: "create";
      localRef: string;
      definition: TicketProposalDefinitionBodyInputV0;
    }
  | {
      op: "revise";
      ticketId: string;
      expectedDefinitionRevision: number;
      replacement: TicketProposalDefinitionBodyInputV0;
    };

export interface TicketProposalAuthorAssessmentV0 {
  changeClass: TicketProposalChangeClassV0;
  authoritySignals: TicketProposalAuthoritySignalV0[];
  introducesHumanGate: boolean;
  rationale: string;
}

export type TicketProposalSubmitInputV0 =
  | {
      schemaVersion: typeof TICKET_PROPOSAL_SCHEMA_VERSION;
      kind: "comment";
      observedSnapshotId: string;
      subject: TicketProposalExactSubjectV0;
      body: string;
    }
  | {
      schemaVersion: typeof TICKET_PROPOSAL_SCHEMA_VERSION;
      kind: "graph_change";
      observedSnapshotId: string | null;
      reason: string;
      source?: TicketProposalSourceV0;
      authorAssessment: TicketProposalAuthorAssessmentV0;
      changes: TicketProposalGraphChangeInputV0[];
    };

export interface TicketProposalCreationProvenanceV0 {
  at: string;
  by: string;
  reason: string;
  source: TicketProposalSourceV0 | null;
  trust: "claimed_unverified";
}

export interface TicketProposalMaterializedDependencyV0 {
  ticketId: string;
  rationale?: string;
}

export interface TicketProposalMaterializedDefinitionV0 {
  ticketId: string;
  definitionRevision: number;
  created: TicketProposalCreationProvenanceV0;
  outcome: string;
  parentId: string | null;
  dependsOn: TicketProposalMaterializedDependencyV0[];
  provenanceRefs: string[];
}

export interface TicketProposalDependencyDeltaV0 {
  addedPrerequisiteTicketIds: string[];
  removedPrerequisiteTicketIds: string[];
}

export type TicketProposalMaterializedChangeV0 =
  | {
      op: "create";
      localRef: string;
      ticketId: string;
      dependencyDelta: TicketProposalDependencyDeltaV0;
      definition: TicketProposalMaterializedDefinitionV0;
    }
  | {
      op: "revise";
      ticketId: string;
      expectedDefinitionRevision: number;
      previousOutcome: string;
      previousParentId: string | null;
      dependencyDelta: TicketProposalDependencyDeltaV0;
      definition: TicketProposalMaterializedDefinitionV0;
    };

export interface TicketProposalMechanicalReviewV0 {
  status: "passed";
  baseTicketCount: number;
  candidateTicketCount: number;
  createdTicketIds: string[];
  revisedTicketIds: string[];
  candidateDigest: string;
}

export interface TicketProposalReviewRequirementV0 {
  independentMachineValidation: "required" | "not_applicable";
  authorityStatus: "not_granted";
  routeHint:
    | "comment_only"
    | "delegated_application_candidate"
    | "human_authority_indicated";
  indicatedAuthoritySignals: TicketProposalAuthoritySignalV0[];
}

interface TicketProposalBaseV0 {
  schemaVersion: typeof TICKET_PROPOSAL_SCHEMA_VERSION;
  proposalId: string;
  proposalDigest: string;
  scopeRef: string;
  observedSnapshotId: string | null;
  submittedAt: string;
  proposer: {
    kind: "claimed_actor";
    ref: string;
  };
  effect: "review_contribution_only";
  graphMutationApplied: false;
  reviewRequirement: TicketProposalReviewRequirementV0;
}

export interface TicketCommentProposalV0 extends TicketProposalBaseV0 {
  kind: "comment";
  observedSnapshotId: string;
  subject: TicketProposalExactSubjectV0;
  body: string;
}

export interface TicketGraphChangeProposalV0 extends TicketProposalBaseV0 {
  kind: "graph_change";
  reason: string;
  source: TicketProposalSourceV0 | null;
  authorAssessment: TicketProposalAuthorAssessmentV0;
  changes: TicketProposalMaterializedChangeV0[];
  mechanicalReview: TicketProposalMechanicalReviewV0;
}

export type TicketProposalV0 =
  | TicketCommentProposalV0
  | TicketGraphChangeProposalV0;

export interface TicketProposalInspectInputV0 {
  proposalId: string;
}

export interface TicketProposalListInputV0 {
  kind?: TicketProposalV0["kind"];
  /**
   * Omitted lists every proposal in the verified scope. `null` selects only
   * bootstrap graph proposals; a snapshot ID selects that exact observed base.
   */
  observedSnapshotId?: string | null;
  cursor?: string;
  limit?: number;
}

export interface TicketProposalSummaryV0 {
  proposalId: string;
  proposalDigest: string;
  kind: TicketProposalV0["kind"];
  observedSnapshotId: string | null;
  submittedAt: string;
  proposer: {
    kind: "claimed_actor";
    ref: string;
  };
}

export interface TicketProposalLedgerPageV0 {
  scopeRef: string;
  items: TicketProposalSummaryV0[];
  page: {
    count: number;
    totalItems: number;
  };
  nextCursor: string | null;
}

export type TicketProposalValidationCheckOutcomeV0 =
  | "passed"
  | "failed"
  | "inconclusive";

export type TicketProposalValidationConclusionV0 =
  TicketProposalValidationCheckOutcomeV0;

export type TicketProposalValidationSubjectV0 =
  | {
      kind: "proposal";
    }
  | {
      kind: "ticket_change";
      ticketId: string;
      definitionRevision: number;
    }
  | {
      kind: "dependency_change";
      change: "added" | "removed";
      prerequisiteTicketId: string;
      dependentTicketId: string;
    };

export interface TicketProposalValidationProducerInputV0 {
  id: string;
  version: string;
  artifactDigest: string;
}

export interface TicketProposalValidationPolicyInputV0 {
  id: string;
  version: string;
  artifactDigest: string;
}

export interface TicketProposalValidationCheckInputV0 {
  localRef: string;
  code: TicketProposalValidationCheckCodeV0;
  subject: TicketProposalValidationSubjectV0;
  outcome: TicketProposalValidationCheckOutcomeV0;
  summary: string;
  evidenceRefs: string[];
}

export interface TicketProposalValidationFindingInputV0 {
  localRef: string;
  checkLocalRef: string;
  subject: TicketProposalValidationSubjectV0;
  impact: "blocking" | "advisory";
  code: string;
  summary: string;
  detail?: string;
  evidenceRefs: string[];
  suggestedAction?: string;
}

export interface TicketProposalValidationRecordInputV0 {
  schemaVersion: typeof TICKET_PROPOSAL_VALIDATION_SCHEMA_VERSION;
  proposalId: string;
  expectedProposalDigest: string;
  expectedCandidateDigest: string;
  validator: TicketProposalValidationProducerInputV0;
  policy: TicketProposalValidationPolicyInputV0;
  checks: TicketProposalValidationCheckInputV0[];
  findings: TicketProposalValidationFindingInputV0[];
  indicatedAuthoritySignals: TicketProposalAuthoritySignalV0[];
}

export interface TicketProposalValidationInspectInputV0 {
  validationReceiptId: string;
}

export interface TicketProposalValidationListInputV0 {
  proposalId: string;
  cursor?: string;
  limit?: number;
}

export interface TicketProposalValidationCheckV0
extends TicketProposalValidationCheckInputV0 {
  checkId: string;
}

export interface TicketProposalValidationFindingV0
extends TicketProposalValidationFindingInputV0 {
  findingId: string;
}

export interface TicketProposalValidationReceiptV0 {
  schemaVersion: typeof TICKET_PROPOSAL_VALIDATION_SCHEMA_VERSION;
  kind: "ticket_proposal_validation_receipt";
  validationReceiptId: string;
  validationReceiptDigest: string;
  scopeRef: string;
  target: {
    kind: "ticket_graph_change_proposal";
    proposalId: string;
    proposalDigest: string;
    observedSnapshotId: string | null;
    candidateDigest: string;
  };
  recordedAt: string;
  producer: {
    kind: "claimed_machine_validator";
    id: string;
    version: string;
    artifactDigest: string;
    trust: "claimed_unverified";
    invokedBy: {
      kind: "claimed_actor";
      ref: string;
    };
  };
  policy: {
    id: string;
    version: string;
    artifactDigest: string;
    trust: "claimed_unverified";
  };
  conclusion: TicketProposalValidationConclusionV0;
  checks: TicketProposalValidationCheckV0[];
  findings: TicketProposalValidationFindingV0[];
  indicatedAuthoritySignals: TicketProposalAuthoritySignalV0[];
  effect: "validation_evidence_only";
  maturityEffect: "none";
  authorityGranted: false;
  applicationAuthorized: false;
  graphMutationApplied: false;
}

export interface TicketProposalValidationSummaryV0 {
  validationReceiptId: string;
  validationReceiptDigest: string;
  proposalId: string;
  proposalDigest: string;
  candidateDigest: string;
  recordedAt: string;
  validator: {
    kind: "claimed_machine_validator";
    id: string;
    version: string;
    artifactDigest: string;
    trust: "claimed_unverified";
  };
  policy: {
    id: string;
    version: string;
    artifactDigest: string;
    trust: "claimed_unverified";
  };
  conclusion: TicketProposalValidationConclusionV0;
  checkCount: number;
  findingCount: number;
  blockingFindingCount: number;
  advisoryFindingCount: number;
  authoritySignalCount: number;
  effect: "validation_evidence_only";
  maturityEffect: "none";
  authorityGranted: false;
  applicationAuthorized: false;
  graphMutationApplied: false;
}

export interface TicketProposalValidationLedgerPageV0 {
  scopeRef: string;
  proposalId: string;
  items: TicketProposalValidationSummaryV0[];
  page: {
    count: number;
    totalItems: number;
  };
  nextCursor: string | null;
}
