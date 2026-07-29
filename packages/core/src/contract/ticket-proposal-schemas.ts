import { z } from "zod";
import {
  TICKET_PROPOSAL_AUTHORITY_SIGNALS,
  TICKET_PROPOSAL_CHANGE_CLASSES,
  TICKET_PROPOSAL_MAX_CHANGES,
  TICKET_PROPOSAL_MAX_DEPENDENCIES_PER_CHANGE,
  TICKET_PROPOSAL_MAX_PAGE_SIZE,
  TICKET_PROPOSAL_SCHEMA_VERSION,
  TICKET_PROPOSAL_VALIDATION_CHECK_CODES,
  TICKET_PROPOSAL_VALIDATION_MAX_EVIDENCE_REFS,
  TICKET_PROPOSAL_VALIDATION_MAX_FINDINGS,
  TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES,
  TICKET_PROPOSAL_VALIDATION_MAX_PAGE_SIZE,
  TICKET_PROPOSAL_VALIDATION_SCHEMA_VERSION,
  isTicketProposalValidationInputWithinBudgetV0,
} from "./ticket-proposal.js";

const boundedString = (maximum: number) => z.string().check(z.custom<string>(
  (value) => typeof value === "string" && [...value].length <= maximum,
  { message: `must contain at most ${maximum} Unicode characters` },
));
const canonicalString = (maximum: number) => boundedString(maximum)
  .min(1)
  .regex(/^(?!\s)[\s\S]*\S$(?![\s\S])/u);
const proposalId = z.string().regex(/^tgp-[0-9a-f]{64}$/u);
const validationReceiptId = z.string().regex(/^tpv-[0-9a-f]{64}$/u);
const scopeRef = z.string().regex(/^tps-[0-9a-f]{64}$/u);
const snapshotId = z.string().regex(/^tgs-[0-9a-f]{64}$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const ticketId = canonicalString(200);
const revision = z.number().int().positive().max(9_999_999_999);
const localRef = canonicalString(200);
const instant = z.iso.datetime({ offset: true }).refine(
  (value) => Number.isFinite(Date.parse(value)),
  { message: "must be a representable instant" },
);
const source = z.object({
  kind: z.enum(["ticket", "run", "plan", "conversation", "other"]),
  ref: canonicalString(300),
}).strict();
const authoritySignals = z.array(z.enum(TICKET_PROPOSAL_AUTHORITY_SIGNALS))
  .max(TICKET_PROPOSAL_AUTHORITY_SIGNALS.length)
  .refine((values) => new Set(values).size === values.length, {
    message: "authority signals must be unique",
  });

const exactSubject = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ticket"),
    ticketId,
    definitionRevision: revision,
  }).strict(),
  z.object({
    kind: z.literal("relation"),
    relationRef: canonicalString(300),
    prerequisiteTicketId: ticketId,
    dependentTicketId: ticketId,
  }).strict(),
]);

const materializedDependency = z.object({
  ticketId,
  rationale: boundedString(20_000).optional(),
}).strict();
const creationProvenance = z.object({
  at: instant,
  by: canonicalString(200),
  reason: canonicalString(2_000),
  source: source.nullable(),
  trust: z.literal("claimed_unverified"),
}).strict();
const materializedDefinition = z.object({
  ticketId,
  definitionRevision: revision,
  created: creationProvenance,
  outcome: canonicalString(20_000),
  parentId: ticketId.nullable(),
  dependsOn: z.array(materializedDependency)
    .max(TICKET_PROPOSAL_MAX_DEPENDENCIES_PER_CHANGE),
  provenanceRefs: z.array(canonicalString(300)).max(20),
}).strict();
const dependencyDelta = z.object({
  addedPrerequisiteTicketIds: z.array(ticketId)
    .max(TICKET_PROPOSAL_MAX_DEPENDENCIES_PER_CHANGE)
    .refine((values) => new Set(values).size === values.length, {
      message: "added prerequisite Ticket IDs must be unique",
    }),
  removedPrerequisiteTicketIds: z.array(ticketId)
    .max(TICKET_PROPOSAL_MAX_DEPENDENCIES_PER_CHANGE)
    .refine((values) => new Set(values).size === values.length, {
      message: "removed prerequisite Ticket IDs must be unique",
    }),
}).strict();
const materializedChange = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create"),
    localRef,
    ticketId,
    dependencyDelta,
    definition: materializedDefinition,
  }).strict(),
  z.object({
    op: z.literal("revise"),
    ticketId,
    expectedDefinitionRevision: revision,
    previousOutcome: canonicalString(20_000),
    previousParentId: ticketId.nullable(),
    dependencyDelta,
    definition: materializedDefinition,
  }).strict(),
]).superRefine((change, context) => {
  const currentDependencies = new Set(
    change.definition.dependsOn.map((dependency) => dependency.ticketId),
  );
  const added = new Set(
    change.dependencyDelta.addedPrerequisiteTicketIds,
  );
  const removed = new Set(
    change.dependencyDelta.removedPrerequisiteTicketIds,
  );
  if (change.op === "create"
    && (added.size !== currentDependencies.size
      || [...currentDependencies].some((ticketId) => !added.has(ticketId))
      || removed.size !== 0)) {
    context.addIssue({
      code: "custom",
      path: ["dependencyDelta"],
      message: "a created Ticket must classify every dependency as added",
    });
  }
  if ([...added].some((ticketId) => !currentDependencies.has(ticketId))) {
    context.addIssue({
      code: "custom",
      path: ["dependencyDelta", "addedPrerequisiteTicketIds"],
      message: "added dependencies must exist in the materialized definition",
    });
  }
  if ([...removed].some((ticketId) => currentDependencies.has(ticketId))) {
    context.addIssue({
      code: "custom",
      path: ["dependencyDelta", "removedPrerequisiteTicketIds"],
      message: "removed dependencies must be absent from the materialized definition",
    });
  }
});
const authorAssessment = z.object({
  changeClass: z.enum(TICKET_PROPOSAL_CHANGE_CLASSES),
  authoritySignals,
  introducesHumanGate: z.boolean(),
  rationale: canonicalString(20_000),
}).strict();

const proposalBase = {
  schemaVersion: z.literal(TICKET_PROPOSAL_SCHEMA_VERSION),
  proposalId,
  proposalDigest: digest,
  scopeRef,
  observedSnapshotId: snapshotId.nullable(),
  submittedAt: instant,
  proposer: z.object({
    kind: z.literal("claimed_actor"),
    ref: canonicalString(200),
  }).strict(),
  effect: z.literal("review_contribution_only"),
  graphMutationApplied: z.literal(false),
};

const commentProposal = z.object({
  ...proposalBase,
  kind: z.literal("comment"),
  observedSnapshotId: snapshotId,
  subject: exactSubject,
  body: canonicalString(20_000),
  reviewRequirement: z.object({
    independentMachineValidation: z.literal("not_applicable"),
    authorityStatus: z.literal("not_granted"),
    routeHint: z.literal("comment_only"),
    indicatedAuthoritySignals: z.tuple([]),
  }).strict(),
}).strict();

const graphChangeProposal = z.object({
  ...proposalBase,
  kind: z.literal("graph_change"),
  reason: canonicalString(2_000),
  source: source.nullable(),
  authorAssessment,
  changes: z.array(materializedChange).min(1).max(TICKET_PROPOSAL_MAX_CHANGES),
  mechanicalReview: z.object({
    status: z.literal("passed"),
    baseTicketCount: z.number().int().nonnegative(),
    candidateTicketCount: z.number().int().positive(),
    createdTicketIds: z.array(ticketId).max(TICKET_PROPOSAL_MAX_CHANGES),
    revisedTicketIds: z.array(ticketId).max(TICKET_PROPOSAL_MAX_CHANGES),
    candidateDigest: digest,
  }).strict(),
  reviewRequirement: z.object({
    independentMachineValidation: z.literal("required"),
    authorityStatus: z.literal("not_granted"),
    routeHint: z.enum([
      "delegated_application_candidate",
      "human_authority_indicated",
    ]),
    indicatedAuthoritySignals: authoritySignals,
  }).strict(),
}).strict();

export const ticketProposalV0Schema = z.discriminatedUnion("kind", [
  commentProposal,
  graphChangeProposal,
]);

export const ticketProposalInspectInputV0Schema = z.object({
  proposalId,
}).strict();

export const ticketProposalListInputV0Schema = z.object({
  kind: z.enum(["comment", "graph_change"]).optional(),
  observedSnapshotId: snapshotId.nullable().optional(),
  cursor: canonicalString(2_000).optional(),
  limit: z.number().int().min(1).max(TICKET_PROPOSAL_MAX_PAGE_SIZE).optional(),
}).strict();

const validationSubject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("proposal") }).strict(),
  z.object({
    kind: z.literal("ticket_change"),
    ticketId,
    definitionRevision: revision,
  }).strict(),
  z.object({
    kind: z.literal("dependency_change"),
    change: z.enum(["added", "removed"]),
    prerequisiteTicketId: ticketId,
    dependentTicketId: ticketId,
  }).strict(),
]);
const evidenceRefs = z.array(canonicalString(2_000)).min(1)
  .max(TICKET_PROPOSAL_VALIDATION_MAX_EVIDENCE_REFS)
  .refine((values) => new Set(values).size === values.length, {
    message: "evidence refs must be unique",
  });
const validatorDescriptor = z.object({
  id: canonicalString(200),
  version: canonicalString(100),
  artifactDigest: digest,
}).strict();
const policyDescriptor = z.object({
  id: canonicalString(200),
  version: canonicalString(100),
  artifactDigest: digest,
}).strict();
const validationCheckInput = z.object({
  localRef,
  code: z.enum(TICKET_PROPOSAL_VALIDATION_CHECK_CODES),
  subject: validationSubject,
  outcome: z.enum(["passed", "failed", "inconclusive"]),
  summary: canonicalString(500),
  evidenceRefs,
}).strict();
const validationFindingInput = z.object({
  localRef,
  checkLocalRef: localRef,
  subject: validationSubject,
  impact: z.enum(["blocking", "advisory"]),
  code: canonicalString(100),
  summary: canonicalString(500),
  detail: boundedString(20_000).optional(),
  evidenceRefs,
  suggestedAction: canonicalString(2_000).optional(),
}).strict();

export const ticketProposalValidationRecordInputV0Schema = z.object({
  schemaVersion: z.literal(TICKET_PROPOSAL_VALIDATION_SCHEMA_VERSION),
  proposalId,
  expectedProposalDigest: digest,
  expectedCandidateDigest: digest,
  validator: validatorDescriptor,
  policy: policyDescriptor,
  checks: z.array(validationCheckInput)
    .length(TICKET_PROPOSAL_VALIDATION_CHECK_CODES.length),
  findings: z.array(validationFindingInput)
    .max(TICKET_PROPOSAL_VALIDATION_MAX_FINDINGS),
  indicatedAuthoritySignals: authoritySignals,
}).strict().superRefine((value, context) => {
  if (new Set(value.checks.map((check) => check.localRef)).size
    !== value.checks.length) {
    context.addIssue({
      code: "custom",
      path: ["checks"],
      message: "check localRef values must be unique",
    });
  }
  const codes = new Set(value.checks.map((check) => check.code));
  if (codes.size !== TICKET_PROPOSAL_VALIDATION_CHECK_CODES.length
    || TICKET_PROPOSAL_VALIDATION_CHECK_CODES.some((code) => !codes.has(code))) {
    context.addIssue({
      code: "custom",
      path: ["checks"],
      message: "checks must contain every frozen proposal validation code once",
    });
  }
  if (new Set(value.findings.map((finding) => finding.localRef)).size
    !== value.findings.length) {
    context.addIssue({
      code: "custom",
      path: ["findings"],
      message: "finding localRef values must be unique",
    });
  }
  const checks = new Map(value.checks.map((check) => [
    check.localRef,
    check,
  ]));
  const blockingByCheck = new Map<string, number>();
  value.findings.forEach((finding, index) => {
    const check = checks.get(finding.checkLocalRef);
    if (check === undefined) {
      context.addIssue({
        code: "custom",
        path: ["findings", index, "checkLocalRef"],
        message: "must reference a validation check in the same receipt",
      });
      return;
    }
    if (finding.impact === "blocking") {
      blockingByCheck.set(
        finding.checkLocalRef,
        (blockingByCheck.get(finding.checkLocalRef) ?? 0) + 1,
      );
      if (check.outcome === "passed") {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "impact"],
          message: "a passed check cannot carry a blocking finding",
        });
      }
    }
  });
  value.checks.forEach((check, index) => {
    if (check.outcome !== "passed"
      && (blockingByCheck.get(check.localRef) ?? 0) === 0) {
      context.addIssue({
        code: "custom",
        path: ["checks", index, "outcome"],
        message: "failed or inconclusive checks require a blocking finding",
      });
    }
  });
}).refine(isTicketProposalValidationInputWithinBudgetV0, {
  message:
    `proposal validation input must not exceed ${
      TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES
    } JSON bytes`,
});

export const ticketProposalValidationInspectInputV0Schema = z.object({
  validationReceiptId,
}).strict();

export const ticketProposalValidationListInputV0Schema = z.object({
  proposalId,
  cursor: canonicalString(2_000).optional(),
  limit: z.number().int().min(1)
    .max(TICKET_PROPOSAL_VALIDATION_MAX_PAGE_SIZE).optional(),
}).strict();

const validationCheck = validationCheckInput.safeExtend({
  checkId: z.string().regex(/^tpc-[0-9a-f]{64}$/u),
}).strict();
const validationFinding = validationFindingInput.safeExtend({
  findingId: z.string().regex(/^tpf-[0-9a-f]{64}$/u),
}).strict();

export const ticketProposalValidationReceiptV0Schema = z.object({
  schemaVersion: z.literal(TICKET_PROPOSAL_VALIDATION_SCHEMA_VERSION),
  kind: z.literal("ticket_proposal_validation_receipt"),
  validationReceiptId,
  validationReceiptDigest: digest,
  scopeRef,
  target: z.object({
    kind: z.literal("ticket_graph_change_proposal"),
    proposalId,
    proposalDigest: digest,
    observedSnapshotId: snapshotId.nullable(),
    candidateDigest: digest,
  }).strict(),
  recordedAt: instant,
  producer: z.object({
    kind: z.literal("claimed_machine_validator"),
    ...validatorDescriptor.shape,
    trust: z.literal("claimed_unverified"),
    invokedBy: z.object({
      kind: z.literal("claimed_actor"),
      ref: canonicalString(200),
    }).strict(),
  }).strict(),
  policy: z.object({
    ...policyDescriptor.shape,
    trust: z.literal("claimed_unverified"),
  }).strict(),
  conclusion: z.enum(["passed", "failed", "inconclusive"]),
  checks: z.array(validationCheck)
    .length(TICKET_PROPOSAL_VALIDATION_CHECK_CODES.length),
  findings: z.array(validationFinding)
    .max(TICKET_PROPOSAL_VALIDATION_MAX_FINDINGS),
  indicatedAuthoritySignals: authoritySignals,
  effect: z.literal("validation_evidence_only"),
  maturityEffect: z.literal("none"),
  authorityGranted: z.literal(false),
  applicationAuthorized: z.literal(false),
  graphMutationApplied: z.literal(false),
}).strict().superRefine((value, context) => {
  const checksByLocalRef = new Map(value.checks.map((check) => [
    check.localRef,
    check,
  ]));
  if (checksByLocalRef.size !== value.checks.length) {
    context.addIssue({
      code: "custom",
      path: ["checks"],
      message: "check localRef values must be unique",
    });
  }
  if (new Set(value.checks.map((check) => check.checkId)).size
    !== value.checks.length) {
    context.addIssue({
      code: "custom",
      path: ["checks"],
      message: "check IDs must be unique",
    });
  }
  const codes = new Set(value.checks.map((check) => check.code));
  if (codes.size !== TICKET_PROPOSAL_VALIDATION_CHECK_CODES.length
    || TICKET_PROPOSAL_VALIDATION_CHECK_CODES.some((code) =>
      !codes.has(code))) {
    context.addIssue({
      code: "custom",
      path: ["checks"],
      message: "checks must contain every frozen proposal validation code once",
    });
  }
  if (new Set(value.findings.map((finding) => finding.localRef)).size
    !== value.findings.length
    || new Set(value.findings.map((finding) => finding.findingId)).size
      !== value.findings.length) {
    context.addIssue({
      code: "custom",
      path: ["findings"],
      message: "finding local refs and IDs must each be unique",
    });
  }
  const blockingByCheck = new Map<string, number>();
  value.findings.forEach((finding, index) => {
    const check = checksByLocalRef.get(finding.checkLocalRef);
    if (check === undefined) {
      context.addIssue({
        code: "custom",
        path: ["findings", index, "checkLocalRef"],
        message: "must reference a validation check in the same receipt",
      });
      return;
    }
    if (finding.impact === "blocking") {
      blockingByCheck.set(
        finding.checkLocalRef,
        (blockingByCheck.get(finding.checkLocalRef) ?? 0) + 1,
      );
      if (check.outcome === "passed") {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "impact"],
          message: "a passed check cannot carry a blocking finding",
        });
      }
    }
  });
  value.checks.forEach((check, index) => {
    if (check.outcome !== "passed"
      && (blockingByCheck.get(check.localRef) ?? 0) === 0) {
      context.addIssue({
        code: "custom",
        path: ["checks", index, "outcome"],
        message: "failed or inconclusive checks require a blocking finding",
      });
    }
  });
  const conclusion = value.checks.some((check) => check.outcome === "failed")
    ? "failed"
    : value.checks.some((check) => check.outcome === "inconclusive")
    ? "inconclusive"
    : "passed";
  if (value.conclusion !== conclusion) {
    context.addIssue({
      code: "custom",
      path: ["conclusion"],
      message: "conclusion must be mechanically derived from check outcomes",
    });
  }
});
