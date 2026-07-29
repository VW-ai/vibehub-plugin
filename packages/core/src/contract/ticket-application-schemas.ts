import { z } from "zod";
import {
  TICKET_PROPOSAL_APPLICATION_MAX_INPUT_BYTES,
  TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION,
  TICKET_PROPOSAL_AUTHORITY_MAX_INPUT_BYTES,
  TICKET_PROPOSAL_AUTHORITY_MAX_REASONS,
  TICKET_PROPOSAL_AUTHORITY_MAX_VALIDATIONS,
  TICKET_PROPOSAL_REVIEW_MAX_INPUT_BYTES,
  type TicketProposalApplicationIntentV0,
  type TicketProposalApplicationReceiptV0,
  type TicketProposalAuthorityDecisionReceiptV0,
  type TicketProposalAuthorityProviderRequestV0,
  type TicketProposalAuthorityProviderResultV0,
  type TicketProposalReviewPacketV0,
} from "./ticket-application.js";
import {
  TICKET_PROPOSAL_AUTHORITY_SIGNALS,
  TICKET_PROPOSAL_CHANGE_CLASSES,
  isJsonValueWithinByteBudgetV0,
} from "./ticket-proposal.js";
import {
  ticketProposalV0Schema,
  ticketProposalValidationReceiptV0Schema,
} from "./ticket-proposal-schemas.js";

const boundedString = (maximum: number) => z.string().check(z.custom<string>(
  (value) => typeof value === "string" && [...value].length <= maximum,
  { message: `must contain at most ${maximum} Unicode characters` },
));
const canonicalString = (maximum: number) => boundedString(maximum)
  .min(1)
  .regex(/^(?!\s)[\s\S]*\S$(?![\s\S])/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const proposalId = z.string().regex(/^tgp-[0-9a-f]{64}$/u);
const validationReceiptId = z.string().regex(/^tpv-[0-9a-f]{64}$/u);
const authorityDecisionId = z.string().regex(/^tgd-[0-9a-f]{64}$/u);
const applicationIntentId = z.string().regex(/^tai-[0-9a-f]{64}$/u);
const applicationReceiptId = z.string().regex(/^tar-[0-9a-f]{64}$/u);
const scopeRef = z.string().regex(/^tps-[0-9a-f]{64}$/u);
const snapshotId = z.string().regex(/^tgs-[0-9a-f]{64}$/u);
const storeId = z.string().regex(/^ticket-store-[0-9a-f]{32}$/u);
const safeSequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const instant = z.iso.datetime({ offset: true }).refine(
  (value) => Number.isFinite(Date.parse(value)),
  { message: "must be a representable instant" },
);

function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const authoritySignals = z.array(z.enum(TICKET_PROPOSAL_AUTHORITY_SIGNALS))
  .max(TICKET_PROPOSAL_AUTHORITY_SIGNALS.length)
  .refine(isUnique, { message: "authority signals must be unique" });

const target = z.object({
  kind: z.literal("ticket_graph_change_proposal"),
  proposalId,
  proposalDigest: digest,
  observedSnapshotId: snapshotId.nullable(),
  candidateDigest: digest,
}).strict();

const validationSetBinding = z.object({
  digest,
  throughSequence: safeSequence,
  count: safeSequence,
}).strict().superRefine((value, context) => {
  if ((value.count === 0) !== (value.throughSequence === 0)) {
    context.addIssue({
      code: "custom",
      path: ["throughSequence"],
      message: "an empty validation set must have high-water sequence zero",
    });
  }
});

const acceptedValidation = z.object({
  validationReceiptId,
  validationReceiptDigest: digest,
}).strict();

const acceptedValidations = z.array(acceptedValidation)
  .max(TICKET_PROPOSAL_AUTHORITY_MAX_VALIDATIONS)
  .superRefine((values, context) => {
    if (!isUnique(values.map((value) => value.validationReceiptId))) {
      context.addIssue({
        code: "custom",
        message: "accepted validation receipt IDs must be unique",
      });
    }
  });

const provider = z.object({
  kind: z.literal("trusted_host_authority_provider"),
  id: canonicalString(200),
  version: canonicalString(100),
  artifactDigest: digest,
  trust: z.literal("host_injected"),
}).strict();

const principal = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("human"),
    ref: canonicalString(300),
    authenticationContextDigest: digest,
    trust: z.literal("host_authenticated"),
  }).strict(),
  z.object({
    kind: z.literal("service"),
    ref: canonicalString(300),
    authenticationContextDigest: digest,
    trust: z.literal("host_authenticated"),
  }).strict(),
]);

const basis = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("delegation"),
    ref: canonicalString(500),
    digest,
  }).strict(),
  z.object({
    kind: z.literal("human_authority"),
    ref: canonicalString(500),
    digest,
  }).strict(),
]);

const resolvedAssessment = z.object({
  changeClass: z.enum(TICKET_PROPOSAL_CHANGE_CLASSES),
  authoritySignals,
}).strict();

const requiredPath = z.enum(["delegated_policy", "human_authority"]);

const providerResultBase = {
  provider,
  principal,
  basis,
  acceptedValidations,
  resolvedAssessment,
  rationale: canonicalString(20_000),
} satisfies z.ZodRawShape;

export const ticketProposalAuthorityProviderResultV0Schema:
z.ZodType<TicketProposalAuthorityProviderResultV0> = z.discriminatedUnion(
  "disposition",
  [
    z.object({
      disposition: z.literal("authorized"),
      ...providerResultBase,
    }).strict(),
    z.object({
      disposition: z.literal("rejected"),
      ...providerResultBase,
    }).strict(),
  ],
);

const graphChangeProposal = ticketProposalV0Schema.refine(
  (value) => value.kind === "graph_change",
  { message: "authority resolution requires a graph-change proposal" },
);

export const ticketProposalAuthorityProviderRequestV0Schema:
z.ZodType<TicketProposalAuthorityProviderRequestV0> = z.object({
  schemaVersion: z.literal(TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION),
  scopeRef,
  target,
  proposal: graphChangeProposal,
  validationSet: validationSetBinding.safeExtend({
    validations: z.array(ticketProposalValidationReceiptV0Schema)
      .max(TICKET_PROPOSAL_AUTHORITY_MAX_VALIDATIONS),
  }).strict(),
  requiredPath,
}).strict().superRefine((value, context) => {
  if (value.proposal.kind !== "graph_change") return;
  if (value.target.proposalId !== value.proposal.proposalId
    || value.target.proposalDigest !== value.proposal.proposalDigest
    || value.target.observedSnapshotId !== value.proposal.observedSnapshotId
    || value.target.candidateDigest
      !== value.proposal.mechanicalReview.candidateDigest) {
    context.addIssue({
      code: "custom",
      path: ["target"],
      message: "target must exactly bind the supplied graph-change proposal",
    });
  }
  if (value.validationSet.count
    !== value.validationSet.validations.length) {
    context.addIssue({
      code: "custom",
      path: ["validationSet", "count"],
      message: "validation count must match the complete supplied set",
    });
  }
  value.validationSet.validations.forEach((validation, index) => {
    if (validation.target.proposalId !== value.target.proposalId
      || validation.target.proposalDigest !== value.target.proposalDigest
      || validation.target.candidateDigest !== value.target.candidateDigest) {
      context.addIssue({
        code: "custom",
        path: ["validationSet", "validations", index, "target"],
        message: "every validation must bind the exact authority target",
      });
    }
  });
});

export const ticketProposalReviewInputV0Schema = z.object({
  proposalId,
}).strict().refine(
  (value) => isJsonValueWithinByteBudgetV0(
    value,
    TICKET_PROPOSAL_REVIEW_MAX_INPUT_BYTES,
  ),
  { message: "proposal review input exceeds its JSON byte budget" },
);

export const ticketProposalAuthorityDecideInputV0Schema = z.object({
  schemaVersion: z.literal(TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION),
  proposalId,
  expectedProposalDigest: digest,
  expectedCandidateDigest: digest,
  expectedValidationSetDigest: digest,
}).strict().refine(
  (value) => isJsonValueWithinByteBudgetV0(
    value,
    TICKET_PROPOSAL_AUTHORITY_MAX_INPUT_BYTES,
  ),
  { message: "proposal authority input exceeds its JSON byte budget" },
);

const decisionBase = {
  schemaVersion: z.literal(TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION),
  kind: z.literal("ticket_proposal_authority_decision"),
  authorityDecisionId,
  authorityDecisionDigest: digest,
  scopeRef,
  target,
  validationSet: validationSetBinding.safeExtend({
    accepted: acceptedValidations,
  }).strict(),
  requiredPath,
  decidedAt: instant,
  provider,
  principal,
  basis,
  resolvedAssessment,
  rationale: canonicalString(20_000),
  effect: z.literal("authority_decision_only"),
  maturityEffect: z.literal("none"),
  graphMutationApplied: z.literal(false),
} satisfies z.ZodRawShape;

export const ticketProposalAuthorityDecisionReceiptV0Schema:
z.ZodType<TicketProposalAuthorityDecisionReceiptV0> = z.discriminatedUnion(
  "disposition",
  [
    z.object({
      ...decisionBase,
      disposition: z.literal("authorized"),
      authorityGranted: z.literal(true),
      applicationAuthorized: z.literal(true),
    }).strict(),
    z.object({
      ...decisionBase,
      disposition: z.literal("rejected"),
      authorityGranted: z.literal(false),
      applicationAuthorized: z.literal(false),
    }).strict(),
  ],
).superRefine((value, context) => {
  if (value.requiredPath === "delegated_policy"
    && value.basis.kind !== "delegation") {
    context.addIssue({
      code: "custom",
      path: ["basis"],
      message: "delegated policy requires a trusted delegation basis",
    });
  }
  if (value.requiredPath === "human_authority"
    && value.basis.kind !== "human_authority") {
    context.addIssue({
      code: "custom",
      path: ["basis"],
      message: "human authority requires a trusted human-authority basis",
    });
  }
  if (value.disposition === "authorized"
    && value.validationSet.accepted.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["validationSet", "accepted"],
      message: "authorization requires at least one accepted passed validation",
    });
  }
  if (value.validationSet.accepted.length > value.validationSet.count) {
    context.addIssue({
      code: "custom",
      path: ["validationSet", "accepted"],
      message: "accepted validations must be members of the bound validation set",
    });
  }
  if (value.requiredPath === "human_authority"
    && value.principal.kind !== "human") {
    context.addIssue({
      code: "custom",
      path: ["principal"],
      message: "a human-authority decision requires a host-authenticated human",
    });
  }
});

export const ticketProposalApplyInputV0Schema = z.object({
  schemaVersion: z.literal(TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION),
  proposalId,
  expectedProposalDigest: digest,
  expectedCandidateDigest: digest,
  authorityDecisionId,
  expectedAuthorityDecisionDigest: digest,
}).strict().refine(
  (value) => isJsonValueWithinByteBudgetV0(
    value,
    TICKET_PROPOSAL_APPLICATION_MAX_INPUT_BYTES,
  ),
  { message: "proposal application input exceeds its JSON byte budget" },
);

const authorityDecisionBinding = z.object({
  authorityDecisionId,
  authorityDecisionDigest: digest,
}).strict();

export const ticketProposalApplicationIntentV0Schema:
z.ZodType<TicketProposalApplicationIntentV0> = z.object({
  schemaVersion: z.literal(TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION),
  kind: z.literal("ticket_proposal_application_intent"),
  applicationIntentId,
  applicationIntentDigest: digest,
  scopeRef,
  preparedAt: instant,
  target,
  authorityDecision: authorityDecisionBinding,
  publication: z.object({
    baseSnapshotId: snapshotId.nullable(),
    storeId,
    candidateSnapshotId: snapshotId,
    candidateDigest: digest,
    ticketCount: safeSequence,
    directUnlockCount: safeSequence,
  }).strict(),
  effect: z.literal("pending_canonical_graph_publication"),
  maturityEffect: z.literal("none"),
  graphMutationApplied: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.publication.baseSnapshotId !== value.target.observedSnapshotId
    || value.publication.candidateDigest !== value.target.candidateDigest) {
    context.addIssue({
      code: "custom",
      path: ["publication"],
      message: "publication must exactly bind the proposal base and candidate",
    });
  }
});

export const ticketProposalApplicationReceiptV0Schema:
z.ZodType<TicketProposalApplicationReceiptV0> = z.object({
  schemaVersion: z.literal(TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION),
  kind: z.literal("ticket_proposal_application_receipt"),
  applicationReceiptId,
  applicationReceiptDigest: digest,
  applicationIntentId,
  applicationIntentDigest: digest,
  scopeRef,
  recordedAt: instant,
  target,
  authorityDecision: authorityDecisionBinding,
  publication: z.object({
    status: z.enum(["published", "reconciled"]),
    previousSnapshotId: snapshotId.nullable(),
    snapshotId,
    ticketCount: safeSequence,
    directUnlockCount: safeSequence,
  }).strict(),
  effect: z.literal("ticket_graph_publication"),
  maturityEffect: z.literal("none"),
  graphMutationApplied: z.literal(true),
}).strict().superRefine((value, context) => {
  if (value.publication.previousSnapshotId !== value.target.observedSnapshotId) {
    context.addIssue({
      code: "custom",
      path: ["publication", "previousSnapshotId"],
      message: "application result must bind the proposal's exact base snapshot",
    });
  }
});

const validationSummary = z.object({
  validationReceiptId,
  validationReceiptDigest: digest,
  proposalId,
  proposalDigest: digest,
  candidateDigest: digest,
  recordedAt: instant,
  validator: z.object({
    kind: z.literal("claimed_machine_validator"),
    id: canonicalString(200),
    version: canonicalString(100),
    artifactDigest: digest,
    trust: z.literal("claimed_unverified"),
  }).strict(),
  policy: z.object({
    id: canonicalString(200),
    version: canonicalString(100),
    artifactDigest: digest,
    trust: z.literal("claimed_unverified"),
  }).strict(),
  conclusion: z.enum(["passed", "failed", "inconclusive"]),
  checkCount: safeSequence,
  findingCount: safeSequence,
  blockingFindingCount: safeSequence,
  advisoryFindingCount: safeSequence,
  authoritySignalCount: safeSequence,
  effect: z.literal("validation_evidence_only"),
  maturityEffect: z.literal("none"),
  authorityGranted: z.literal(false),
  applicationAuthorized: z.literal(false),
  graphMutationApplied: z.literal(false),
}).strict();

export const ticketProposalReviewPacketV0Schema:
z.ZodType<TicketProposalReviewPacketV0> = z.object({
  schemaVersion: z.literal(TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION),
  scopeRef,
  proposal: ticketProposalV0Schema,
  validations: z.array(validationSummary)
    .max(TICKET_PROPOSAL_AUTHORITY_MAX_VALIDATIONS),
  validationSet: validationSetBinding,
  decision: ticketProposalAuthorityDecisionReceiptV0Schema.nullable(),
  application: ticketProposalApplicationReceiptV0Schema.nullable(),
  eligibility: z.object({
    status: z.enum([
      "comment_only",
      "validation_required",
      "authority_required",
      "application_ready",
      "rejected",
      "applied",
      "stale",
    ]),
    reasons: z.array(canonicalString(2_000))
      .max(TICKET_PROPOSAL_AUTHORITY_MAX_REASONS),
  }).strict(),
  nextAction: z.enum([
    "none",
    "record_validation",
    "request_authority_decision",
    "apply_proposal",
    "inspect_application",
  ]),
}).strict().superRefine((value, context) => {
  if (value.validationSet.count !== value.validations.length) {
    context.addIssue({
      code: "custom",
      path: ["validationSet", "count"],
      message: "validation count must match the complete review validation set",
    });
  }
  if (!isUnique(value.validations.map((item) => item.validationReceiptId))) {
    context.addIssue({
      code: "custom",
      path: ["validations"],
      message: "review validation receipt IDs must be unique",
    });
  }
  value.validations.forEach((validation, index) => {
    if (validation.proposalId !== value.proposal.proposalId
      || validation.proposalDigest !== value.proposal.proposalDigest
      || (value.proposal.kind === "graph_change"
        && validation.candidateDigest
          !== value.proposal.mechanicalReview.candidateDigest)) {
      context.addIssue({
        code: "custom",
        path: ["validations", index],
        message: "review validation must bind the exact proposal candidate",
      });
    }
  });
  if (value.decision !== null
    && (value.decision.target.proposalId !== value.proposal.proposalId
      || value.decision.target.proposalDigest !== value.proposal.proposalDigest
      || value.decision.target.observedSnapshotId
        !== value.proposal.observedSnapshotId
      || (value.proposal.kind === "graph_change"
        && value.decision.target.candidateDigest
          !== value.proposal.mechanicalReview.candidateDigest))) {
    context.addIssue({
      code: "custom",
      path: ["decision"],
      message: "review decision must bind the exact proposal candidate",
    });
  }
  if (value.application !== null
    && (value.application.target.proposalId !== value.proposal.proposalId
      || value.application.target.proposalDigest
        !== value.proposal.proposalDigest
      || value.application.target.observedSnapshotId
        !== value.proposal.observedSnapshotId
      || (value.proposal.kind === "graph_change"
        && value.application.target.candidateDigest
          !== value.proposal.mechanicalReview.candidateDigest))) {
    context.addIssue({
      code: "custom",
      path: ["application"],
      message: "review application must bind the exact proposal candidate",
    });
  }
  if (value.application !== null
    && (value.decision === null
      || value.decision.disposition !== "authorized"
      || value.application.authorityDecision.authorityDecisionId
        !== value.decision.authorityDecisionId
      || value.application.authorityDecision.authorityDecisionDigest
        !== value.decision.authorityDecisionDigest)) {
    context.addIssue({
      code: "custom",
      path: ["application", "authorityDecision"],
      message: "review application requires its exact authorized decision",
    });
  }
});
