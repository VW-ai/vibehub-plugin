import { z } from "zod";
import {
  TICKET_REVIEW_MAX_RELATIONS,
  TICKET_REVIEW_MAX_TICKETS,
  TICKET_REVIEW_MAX_TRACE_RECORDS,
  TICKET_REVIEW_SCHEMA_VERSION,
} from "./contract/ticket-review.js";
import {
  ticketReviewCapabilitySummaryV0Schema,
  ticketReviewInstantV0Schema,
  ticketReviewSourceMetadataV0Schema,
  ticketReviewTraceRecordV0Schema,
} from "./contract/ticket-review-schemas.js";

const boundedString = (maxLength: number) => z.string()
  .check(z.custom<string>(
    (value) => typeof value === "string" && [...value].length <= maxLength,
    { message: `must contain at most ${maxLength} Unicode characters` },
  ));
const canonicalString = (maxLength: number) => boundedString(maxLength)
  .min(1)
  .refine((value) => !/^\s|\s$/u.test(value), {
    message: "must not start or end with whitespace",
  });
const opaqueRef = canonicalString(300);
const ticketId = canonicalString(200);
const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const provenanceRefs = z.array(canonicalString(4_096)).max(200);

export const TICKET_REVIEW_MAX_CURRENT_CAPABILITY_PROJECTIONS = 25_000;

export const ticketReviewDefinitionFactV0Schema = z.object({
  ticketId,
  ticketRevision: sha256Digest,
  outcome: canonicalString(20_000),
  context: boundedString(65_536),
  acceptance: z.array(z.object({
    acceptanceId: canonicalString(200),
    criterion: canonicalString(8_192),
  }).strict()).max(200),
  constraints: z.array(canonicalString(8_192)).max(200),
  contextRefs: z.array(z.object({
    ref: canonicalString(4_096),
    purpose: canonicalString(4_096),
  }).strict()).max(200),
  provenanceRefs: provenanceRefs.optional(),
}).strict();

export const ticketReviewDirectUnlockFactV0Schema = z.object({
  relationRef: opaqueRef,
  prerequisiteTicketId: ticketId,
  dependentTicketId: ticketId,
  rationale: boundedString(20_000).optional(),
  provenanceRefs: provenanceRefs.optional(),
}).strict();

const receiptBaseShape = {
  producerReceiptRef: opaqueRef,
  producedAt: ticketReviewInstantV0Schema,
  snapshotRevision: opaqueRef,
  projectionWatermark: opaqueRef,
  summary: ticketReviewCapabilitySummaryV0Schema,
};

const skillOrValidatorProducer = z.object({
  kind: z.enum(["skill", "validator"]),
  id: canonicalString(200),
  version: canonicalString(100),
}).strict();

const validatorProducer = z.object({
  kind: z.literal("validator"),
  id: canonicalString(200),
  version: canonicalString(100),
}).strict();

const runtimeProducer = z.object({
  kind: z.literal("runtime"),
  id: canonicalString(200),
  version: canonicalString(100),
}).strict();

const ticketSubject = z.object({
  kind: z.literal("ticket"),
  ticketId,
  ticketRevision: sha256Digest,
}).strict();

const relationSubject = z.object({
  kind: z.literal("relation"),
  relationRef: opaqueRef,
  prerequisiteTicketId: ticketId,
  dependentTicketId: ticketId,
}).strict();

const snapshotSubject = z.object({
  kind: z.literal("snapshot"),
}).strict();

const ticketSemanticCapability = z.enum([
  "display",
  "context",
  "attention",
  "lens_membership",
]);

const ticketValidatorCapability = z.enum([
  "maturity",
  "blockers",
  "validation",
  "acceptance",
]);

const ticketRuntimeCapability = z.enum([
  "operational",
  "active_run",
]);

export const ticketReviewCurrentCapabilityProjectionV0Schema = z.union([
  z.object({
    ...receiptBaseShape,
    producer: skillOrValidatorProducer,
    subject: ticketSubject,
    capability: ticketSemanticCapability,
  }).strict(),
  z.object({
    ...receiptBaseShape,
    producer: validatorProducer,
    subject: ticketSubject,
    capability: ticketValidatorCapability,
  }).strict(),
  z.object({
    ...receiptBaseShape,
    producer: runtimeProducer,
    subject: ticketSubject,
    capability: ticketRuntimeCapability,
  }).strict(),
  z.object({
    ...receiptBaseShape,
    producer: skillOrValidatorProducer,
    subject: relationSubject,
    capability: z.literal("attention"),
  }).strict(),
  z.object({
    ...receiptBaseShape,
    producer: runtimeProducer,
    subject: relationSubject,
    capability: z.literal("active_spine"),
  }).strict(),
  z.object({
    ...receiptBaseShape,
    producer: skillOrValidatorProducer,
    subject: snapshotSubject,
    capability: z.literal("lenses"),
  }).strict(),
  z.object({
    ...receiptBaseShape,
    producer: validatorProducer,
    subject: snapshotSubject,
    capability: z.literal("needs_actor"),
  }).strict(),
  z.object({
    ...receiptBaseShape,
    producer: runtimeProducer,
    subject: snapshotSubject,
    capability: z.literal("active_runs"),
  }).strict(),
]);

export const ticketReviewProjectionSourceV0Schema = z.object({
  schemaVersion: z.literal(TICKET_REVIEW_SCHEMA_VERSION),
  snapshotRevision: opaqueRef,
  projectionWatermark: opaqueRef,
  source: ticketReviewSourceMetadataV0Schema,
  ticketDefinitions: z.array(ticketReviewDefinitionFactV0Schema)
    .max(TICKET_REVIEW_MAX_TICKETS),
  directUnlocks: z.array(ticketReviewDirectUnlockFactV0Schema)
    .max(TICKET_REVIEW_MAX_RELATIONS),
  currentCapabilityProjections: z.array(ticketReviewCurrentCapabilityProjectionV0Schema)
    .max(TICKET_REVIEW_MAX_CURRENT_CAPABILITY_PROJECTIONS),
  traceRecords: z.array(ticketReviewTraceRecordV0Schema)
    .max(TICKET_REVIEW_MAX_TRACE_RECORDS),
}).strict();

export type TicketReviewDefinitionFactV0 =
  z.infer<typeof ticketReviewDefinitionFactV0Schema>;
export type TicketReviewDirectUnlockFactV0 =
  z.infer<typeof ticketReviewDirectUnlockFactV0Schema>;
export type TicketReviewCurrentCapabilityProjectionV0 =
  z.infer<typeof ticketReviewCurrentCapabilityProjectionV0Schema>;
export type TicketReviewProjectionSourceV0 =
  z.infer<typeof ticketReviewProjectionSourceV0Schema>;
