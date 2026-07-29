/**
 * Browser-safe Ticket proposal authority and application V0 contracts.
 *
 * Public inputs bind immutable facts only. Trusted identity, authority, and
 * disposition are resolved by a runtime provider injected into Core; callers
 * cannot serialize that capability into an operation request.
 */

import type {
  TicketGraphChangeProposalV0,
  TicketProposalAuthoritySignalV0,
  TicketProposalChangeClassV0,
  TicketProposalV0,
  TicketProposalValidationReceiptV0,
  TicketProposalValidationSummaryV0,
} from "./ticket-proposal.js";

export const TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION = 1 as const;
export const TICKET_PROPOSAL_REVIEW_MAX_INPUT_BYTES = 4 * 1024;
export const TICKET_PROPOSAL_AUTHORITY_MAX_INPUT_BYTES = 64 * 1024;
export const TICKET_PROPOSAL_APPLICATION_MAX_INPUT_BYTES = 64 * 1024;
export const TICKET_PROPOSAL_AUTHORITY_MAX_VALIDATIONS = 200;
export const TICKET_PROPOSAL_AUTHORITY_MAX_REASONS = 50;

export type TicketProposalAuthorityRequiredPathV0 =
  | "delegated_policy"
  | "human_authority";

export interface TicketProposalReviewInputV0 {
  proposalId: string;
}

export interface TicketProposalValidationSetBindingV0 {
  digest: string;
  throughSequence: number;
  count: number;
}

export interface TicketProposalAcceptedValidationRefV0 {
  validationReceiptId: string;
  validationReceiptDigest: string;
}

export interface TicketProposalAuthorityTargetV0 {
  kind: "ticket_graph_change_proposal";
  proposalId: string;
  proposalDigest: string;
  observedSnapshotId: string | null;
  candidateDigest: string;
}

export interface TicketProposalAuthorityValidationSetV0
extends TicketProposalValidationSetBindingV0 {
  accepted: TicketProposalAcceptedValidationRefV0[];
}

export interface TicketProposalAuthorityProviderDescriptorV0 {
  kind: "trusted_host_authority_provider";
  id: string;
  version: string;
  artifactDigest: string;
  trust: "host_injected";
}

export type TicketProposalTrustedPrincipalV0 =
  | {
      kind: "human";
      ref: string;
      authenticationContextDigest: string;
      trust: "host_authenticated";
    }
  | {
      kind: "service";
      ref: string;
      authenticationContextDigest: string;
      trust: "host_authenticated";
    };

export type TicketProposalAuthorityBasisV0 =
  | {
      kind: "delegation";
      ref: string;
      digest: string;
    }
  | {
      kind: "human_authority";
      ref: string;
      digest: string;
    };

export interface TicketProposalResolvedAssessmentV0 {
  changeClass: TicketProposalChangeClassV0;
  authoritySignals: TicketProposalAuthoritySignalV0[];
}

/**
 * Complete, Core-derived request given only to the injected trusted provider.
 * It is not an operation input and does not grant authority by being serializable.
 */
export interface TicketProposalAuthorityProviderRequestV0 {
  schemaVersion: typeof TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION;
  scopeRef: string;
  target: TicketProposalAuthorityTargetV0;
  proposal: TicketGraphChangeProposalV0;
  validationSet: TicketProposalValidationSetBindingV0 & {
    validations: TicketProposalValidationReceiptV0[];
  };
  requiredPath: TicketProposalAuthorityRequiredPathV0;
}

interface TicketProposalAuthorityProviderResultBaseV0 {
  provider: TicketProposalAuthorityProviderDescriptorV0;
  principal: TicketProposalTrustedPrincipalV0;
  basis: TicketProposalAuthorityBasisV0;
  acceptedValidations: TicketProposalAcceptedValidationRefV0[];
  resolvedAssessment: TicketProposalResolvedAssessmentV0;
  rationale: string;
}

export type TicketProposalAuthorityProviderResultV0 =
  | (TicketProposalAuthorityProviderResultBaseV0 & {
      disposition: "authorized";
    })
  | (TicketProposalAuthorityProviderResultBaseV0 & {
      disposition: "rejected";
    });

export interface TrustedTicketProposalAuthorityProviderV0 {
  decide(
    request: TicketProposalAuthorityProviderRequestV0,
  ): TicketProposalAuthorityProviderResultV0;
}

export interface TicketProposalAuthorityDecideInputV0 {
  schemaVersion: typeof TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION;
  proposalId: string;
  expectedProposalDigest: string;
  expectedCandidateDigest: string;
  expectedValidationSetDigest: string;
}

interface TicketProposalAuthorityDecisionBaseV0 {
  schemaVersion: typeof TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION;
  kind: "ticket_proposal_authority_decision";
  authorityDecisionId: string;
  authorityDecisionDigest: string;
  scopeRef: string;
  target: TicketProposalAuthorityTargetV0;
  validationSet: TicketProposalAuthorityValidationSetV0;
  requiredPath: TicketProposalAuthorityRequiredPathV0;
  decidedAt: string;
  provider: TicketProposalAuthorityProviderDescriptorV0;
  principal: TicketProposalTrustedPrincipalV0;
  basis: TicketProposalAuthorityBasisV0;
  resolvedAssessment: TicketProposalResolvedAssessmentV0;
  rationale: string;
  effect: "authority_decision_only";
  maturityEffect: "none";
  graphMutationApplied: false;
}

export type TicketProposalAuthorityDecisionReceiptV0 =
  | (TicketProposalAuthorityDecisionBaseV0 & {
      disposition: "authorized";
      authorityGranted: true;
      applicationAuthorized: true;
    })
  | (TicketProposalAuthorityDecisionBaseV0 & {
      disposition: "rejected";
      authorityGranted: false;
      applicationAuthorized: false;
    });

export interface TicketProposalApplyInputV0 {
  schemaVersion: typeof TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION;
  proposalId: string;
  expectedProposalDigest: string;
  expectedCandidateDigest: string;
  authorityDecisionId: string;
  expectedAuthorityDecisionDigest: string;
}

export interface TicketProposalApplicationIntentV0 {
  schemaVersion: typeof TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION;
  kind: "ticket_proposal_application_intent";
  applicationIntentId: string;
  applicationIntentDigest: string;
  scopeRef: string;
  preparedAt: string;
  target: TicketProposalAuthorityTargetV0;
  authorityDecision: {
    authorityDecisionId: string;
    authorityDecisionDigest: string;
  };
  publication: {
    baseSnapshotId: string | null;
    storeId: string;
    candidateSnapshotId: string;
    candidateDigest: string;
    ticketCount: number;
    directUnlockCount: number;
  };
  effect: "pending_canonical_graph_publication";
  maturityEffect: "none";
  graphMutationApplied: false;
}

export interface TicketProposalApplicationReceiptV0 {
  schemaVersion: typeof TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION;
  kind: "ticket_proposal_application_receipt";
  applicationReceiptId: string;
  applicationReceiptDigest: string;
  applicationIntentId: string;
  applicationIntentDigest: string;
  scopeRef: string;
  recordedAt: string;
  target: TicketProposalAuthorityTargetV0;
  authorityDecision: {
    authorityDecisionId: string;
    authorityDecisionDigest: string;
  };
  publication: {
    status: "published" | "reconciled";
    previousSnapshotId: string | null;
    snapshotId: string;
    ticketCount: number;
    directUnlockCount: number;
  };
  effect: "ticket_graph_publication";
  maturityEffect: "none";
  graphMutationApplied: true;
}

export type TicketProposalReviewEligibilityV0 =
  | "comment_only"
  | "validation_required"
  | "authority_required"
  | "application_ready"
  | "rejected"
  | "applied"
  | "stale";

export type TicketProposalReviewNextActionV0 =
  | "none"
  | "record_validation"
  | "request_authority_decision"
  | "apply_proposal"
  | "inspect_application";

export interface TicketProposalReviewPacketV0 {
  schemaVersion: typeof TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION;
  scopeRef: string;
  proposal: TicketProposalV0;
  validations: TicketProposalValidationSummaryV0[];
  validationSet: TicketProposalValidationSetBindingV0;
  decision: TicketProposalAuthorityDecisionReceiptV0 | null;
  application: TicketProposalApplicationReceiptV0 | null;
  eligibility: {
    status: TicketProposalReviewEligibilityV0;
    reasons: string[];
  };
  nextAction: TicketProposalReviewNextActionV0;
}
