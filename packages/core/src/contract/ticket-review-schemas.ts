import { z } from "zod";
import {
  TICKET_REVIEW_MAX_PAGE_SIZE,
  TICKET_REVIEW_MAX_RELATIONS,
  TICKET_REVIEW_MAX_TICKETS,
  TICKET_REVIEW_MAX_TRACE_RECORDS,
  TICKET_REVIEW_MAX_TRACE_RECORDS_PER_PAGE,
  TICKET_REVIEW_RELATION_CAPABILITIES,
  TICKET_REVIEW_SCHEMA_VERSION,
  TICKET_REVIEW_TICKET_CAPABILITIES,
  TICKET_REVIEW_TRACE_KINDS,
  type TicketGraphSnapshotPageV0,
  type TicketGraphSnapshotRequestV0,
  type TicketReviewCapabilitySlotV0,
  type TicketReviewCapabilitySummaryV0,
  type TicketReviewPageV0,
  type TicketReviewProjectionHeaderV0,
  type TicketReviewRelationProjectionV0,
  type TicketReviewSnapshotSummaryV0,
  type TicketReviewSubjectRefV0,
  type TicketReviewTicketProjectionV0,
  type TicketReviewTraceRecordV0,
  type TicketReviewTraceSubjectV0,
  type TicketReviewTraceTargetV0,
  type TicketSubjectInspectionV0,
  type TicketSubjectInspectRequestV0,
  type TicketTraceListPageV0,
  type TicketTraceListRequestV0,
} from "./ticket-review.js";

const boundedString = (maxLength: number) => z.string().refine(
  (value) => [...value].length <= maxLength,
  { message: `must contain at most ${maxLength} Unicode characters` },
);

const canonicalString = (maxLength: number) => boundedString(maxLength).refine(
  (value) => value.length > 0 && value.trim() === value,
  { message: "must be non-empty without leading or trailing whitespace" },
);

const opaqueRef = canonicalString(300);
const ticketId = canonicalString(200);
const positiveRevision = z.number().int().positive();
const nonnegativeInteger = z.number().int().nonnegative();
const longText = boundedString(20_000);
export const ticketReviewInstantV0Schema = z.iso.datetime({ offset: true }).refine(
  (value) => Number.isFinite(Date.parse(value)),
  { message: "must be an ISO datetime representable as an instant" },
).refine(
  (value) => {
    const fraction = value.match(/\.(\d+)/u);
    return fraction === null || fraction[1]!.length <= 3;
  },
  { message: "must use no more than millisecond precision" },
);

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isSafeHttpUrl(value: string): boolean {
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.hostname.length > 0
      && url.username.length === 0
      && url.password.length === 0;
  } catch {
    return false;
  }
}

function isCanonicalRepoPath(value: string): boolean {
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || value.includes("\\")
    || value.startsWith("/")) {
    return false;
  }
  const segments = value.split("/");
  return segments.length > 0
    && segments.every((segment) =>
      segment.length > 0 && segment !== "." && segment !== "..");
}

function isOpaqueNonNavigationRef(value: string): boolean {
  return !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && !value.includes("/")
    && !value.includes("\\")
    && !value.startsWith("#")
    && !value.startsWith("?")
    && !/^(?:https?|ftp|file|mailto|tel|javascript|data|blob):/i.test(value);
}

export const ticketReviewSubjectRefV0Schema: z.ZodType<TicketReviewSubjectRefV0> =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ticket"),
      ticketId,
    }).strict(),
    z.object({
      kind: z.literal("relation"),
      relationRef: opaqueRef,
    }).strict(),
  ]);

const ticketReviewCapabilityReferenceV0Schema = z.object({
  ref: opaqueRef,
  label: canonicalString(200).optional(),
}).strict();

export const ticketReviewCapabilitySummaryV0Schema:
z.ZodType<TicketReviewCapabilitySummaryV0> = z.object({
  label: canonicalString(200),
  detail: boundedString(1_000).optional(),
  count: nonnegativeInteger.optional(),
  references: z.array(ticketReviewCapabilityReferenceV0Schema).max(100),
}).strict().superRefine((value, context) => {
  if (!hasUniqueValues(value.references.map((reference) => reference.ref))) {
    context.addIssue({
      code: "custom",
      path: ["references"],
      message: "capability reference refs must be unique",
    });
  }
});

export const ticketReviewCapabilitySlotV0Schema:
z.ZodType<TicketReviewCapabilitySlotV0> = z.discriminatedUnion("availability", [
  z.object({
    availability: z.literal("unavailable"),
  }).strict(),
  z.object({
    availability: z.literal("available"),
    producerReceiptRef: opaqueRef,
    summary: ticketReviewCapabilitySummaryV0Schema,
  }).strict(),
]);

const ticketCapabilitiesSchema = z.object(
  Object.fromEntries(
    TICKET_REVIEW_TICKET_CAPABILITIES.map((capability) => [
      capability,
      ticketReviewCapabilitySlotV0Schema,
    ]),
  ) as Record<
    typeof TICKET_REVIEW_TICKET_CAPABILITIES[number],
    typeof ticketReviewCapabilitySlotV0Schema
  >,
).strict();

const relationCapabilitiesSchema = z.object(
  Object.fromEntries(
    TICKET_REVIEW_RELATION_CAPABILITIES.map((capability) => [
      capability,
      ticketReviewCapabilitySlotV0Schema,
    ]),
  ) as Record<
    typeof TICKET_REVIEW_RELATION_CAPABILITIES[number],
    typeof ticketReviewCapabilitySlotV0Schema
  >,
).strict();

export const ticketReviewTicketProjectionV0Schema:
z.ZodType<TicketReviewTicketProjectionV0> = z.object({
  ticketId,
  definitionRevision: positiveRevision,
  outcome: canonicalString(20_000),
  provenanceRefs: z.array(opaqueRef).max(20),
  capabilities: ticketCapabilitiesSchema,
  relationCounts: z.object({
    prerequisites: nonnegativeInteger,
    dependents: nonnegativeInteger,
  }).strict(),
  traceCount: nonnegativeInteger.max(TICKET_REVIEW_MAX_TRACE_RECORDS),
}).strict();

export const ticketReviewRelationProjectionV0Schema:
z.ZodType<TicketReviewRelationProjectionV0> = z.object({
  relationRef: opaqueRef,
  prerequisiteTicketId: ticketId,
  dependentTicketId: ticketId,
  rationale: longText.optional(),
  provenanceRefs: z.array(opaqueRef).max(20),
  capabilities: relationCapabilitiesSchema,
  traceCount: nonnegativeInteger.max(TICKET_REVIEW_MAX_TRACE_RECORDS),
}).strict();

const ticketReviewSnapshotSummaryV0Schema:
z.ZodType<TicketReviewSnapshotSummaryV0> = z.object({
  ticketCount: nonnegativeInteger.max(TICKET_REVIEW_MAX_TICKETS),
  directUnlockCount: nonnegativeInteger.max(TICKET_REVIEW_MAX_RELATIONS),
  activeRuns: ticketReviewCapabilitySlotV0Schema,
  needsActor: ticketReviewCapabilitySlotV0Schema,
}).strict();

const ticketReviewPageV0Schema: z.ZodType<TicketReviewPageV0> = z.object({
  offset: nonnegativeInteger,
  count: nonnegativeInteger,
  totalItems: nonnegativeInteger,
}).strict();

const projectionHeaderShape = {
  schemaVersion: z.literal(TICKET_REVIEW_SCHEMA_VERSION),
  projectorVersion: canonicalString(200),
  snapshotId: opaqueRef,
  snapshotRevision: opaqueRef,
  projectionWatermark: opaqueRef,
  topologyDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
} satisfies z.ZodRawShape;

type ProjectionHeaderShapeOutput = z.infer<z.ZodObject<typeof projectionHeaderShape>>;
type Assert<T extends true> = T;
type _ProjectionHeaderMatchesManualType = Assert<
  ProjectionHeaderShapeOutput extends TicketReviewProjectionHeaderV0 ? true : false
>;

function pageCursorIsCoherent(
  page: TicketReviewPageV0,
  nextCursor: string | null,
): boolean {
  if (page.offset > page.totalItems || page.offset + page.count > page.totalItems) {
    return false;
  }
  if (page.offset < page.totalItems && page.count === 0) {
    return false;
  }
  return (page.offset + page.count < page.totalItems) === (nextCursor !== null);
}

export const ticketGraphSnapshotRequestV0Schema:
z.ZodType<TicketGraphSnapshotRequestV0> = z.object({
  cursor: canonicalString(2_000).optional(),
  pageSize: z.number().int().min(1).max(TICKET_REVIEW_MAX_PAGE_SIZE).optional(),
}).strict();

export const ticketGraphSnapshotPageV0Schema:
z.ZodType<TicketGraphSnapshotPageV0> = z.object({
  ...projectionHeaderShape,
  summary: ticketReviewSnapshotSummaryV0Schema,
  tickets: z.array(ticketReviewTicketProjectionV0Schema)
    .max(TICKET_REVIEW_MAX_PAGE_SIZE),
  relations: z.array(ticketReviewRelationProjectionV0Schema)
    .max(TICKET_REVIEW_MAX_PAGE_SIZE),
  lenses: ticketReviewCapabilitySlotV0Schema,
  page: ticketReviewPageV0Schema,
  nextCursor: canonicalString(2_000).nullable(),
}).strict().superRefine((value, context) => {
  const emittedCount = value.tickets.length + value.relations.length;
  if (value.page.count !== emittedCount) {
    context.addIssue({
      code: "custom",
      path: ["page", "count"],
      message: "must equal the number of emitted tickets and relations",
    });
  }
  if (emittedCount > TICKET_REVIEW_MAX_PAGE_SIZE) {
    context.addIssue({
      code: "custom",
      path: ["page", "count"],
      message: `must not exceed ${TICKET_REVIEW_MAX_PAGE_SIZE}`,
    });
  }
  const expectedTotal = value.summary.ticketCount + value.summary.directUnlockCount;
  if (value.page.totalItems !== expectedTotal) {
    context.addIssue({
      code: "custom",
      path: ["page", "totalItems"],
      message: "must equal the snapshot ticket and direct-unlock total",
    });
  }
  if (!pageCursorIsCoherent(value.page, value.nextCursor)) {
    context.addIssue({
      code: "custom",
      path: ["nextCursor"],
      message: "must agree with the page bounds and remaining item count",
    });
  }
  if (!hasUniqueValues(value.tickets.map((ticket) => ticket.ticketId))) {
    context.addIssue({
      code: "custom",
      path: ["tickets"],
      message: "ticketId values must be unique within the page",
    });
  }
  if (!hasUniqueValues(value.relations.map((relation) => relation.relationRef))) {
    context.addIssue({
      code: "custom",
      path: ["relations"],
      message: "relationRef values must be unique within the page",
    });
  }
});

export const ticketSubjectInspectRequestV0Schema:
z.ZodType<TicketSubjectInspectRequestV0> = z.object({
  snapshotId: opaqueRef,
  subject: ticketReviewSubjectRefV0Schema,
}).strict();

const inspectedTicketSubjectSchema = z.object({
  kind: z.literal("ticket"),
  ticket: ticketReviewTicketProjectionV0Schema,
  prerequisiteRelationRefs: z.array(opaqueRef).max(TICKET_REVIEW_MAX_RELATIONS),
  dependentRelationRefs: z.array(opaqueRef).max(TICKET_REVIEW_MAX_RELATIONS),
}).strict().superRefine((value, context) => {
  if (value.prerequisiteRelationRefs.length !== value.ticket.relationCounts.prerequisites) {
    context.addIssue({
      code: "custom",
      path: ["prerequisiteRelationRefs"],
      message: "length must match ticket.relationCounts.prerequisites",
    });
  }
  if (value.dependentRelationRefs.length !== value.ticket.relationCounts.dependents) {
    context.addIssue({
      code: "custom",
      path: ["dependentRelationRefs"],
      message: "length must match ticket.relationCounts.dependents",
    });
  }
  if (!hasUniqueValues(value.prerequisiteRelationRefs)) {
    context.addIssue({
      code: "custom",
      path: ["prerequisiteRelationRefs"],
      message: "relation refs must be unique",
    });
  }
  if (!hasUniqueValues(value.dependentRelationRefs)) {
    context.addIssue({
      code: "custom",
      path: ["dependentRelationRefs"],
      message: "relation refs must be unique",
    });
  }
  const allRelationRefs = [
    ...value.prerequisiteRelationRefs,
    ...value.dependentRelationRefs,
  ];
  if (allRelationRefs.length > TICKET_REVIEW_MAX_RELATIONS
    || !hasUniqueValues(allRelationRefs)) {
    context.addIssue({
      code: "custom",
      path: [],
      message: "all incident relation refs must be unique and within the relation limit",
    });
  }
});

const inspectedRelationSubjectSchema = z.object({
  kind: z.literal("relation"),
  relation: ticketReviewRelationProjectionV0Schema,
}).strict();

export const ticketSubjectInspectionV0Schema:
z.ZodType<TicketSubjectInspectionV0> = z.object({
  ...projectionHeaderShape,
  subject: z.union([
    inspectedTicketSubjectSchema,
    inspectedRelationSubjectSchema,
  ]),
}).strict();

export const ticketReviewTraceSubjectV0Schema:
z.ZodType<TicketReviewTraceSubjectV0> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ticket"),
    ticketId,
    boundDefinitionRevision: positiveRevision,
  }).strict(),
  z.object({
    kind: z.literal("relation"),
    sourceRevision: opaqueRef,
    relationRef: opaqueRef,
    prerequisiteTicketId: ticketId,
    dependentTicketId: ticketId,
  }).strict(),
]);

const httpTargetSchema = z.object({
  kind: z.literal("url"),
  label: canonicalString(200),
  target: canonicalString(2_000).refine(isSafeHttpUrl, {
    message: "must be an http(s) URL without credentials",
  }),
}).strict();

const repoPathTargetSchema = z.object({
  kind: z.literal("repo_path"),
  label: canonicalString(200),
  target: canonicalString(2_000).refine(isCanonicalRepoPath, {
    message: "must be a canonical repo-relative POSIX path",
  }),
}).strict();

const opaqueTargetSchema = z.object({
  kind: z.literal("opaque"),
  label: canonicalString(200),
  target: canonicalString(2_000).refine(isOpaqueNonNavigationRef, {
    message: "must be an opaque non-navigation reference",
  }),
}).strict();

export const ticketReviewTraceTargetV0Schema:
z.ZodType<TicketReviewTraceTargetV0> = z.discriminatedUnion("kind", [
  httpTargetSchema,
  repoPathTargetSchema,
  opaqueTargetSchema,
]);

export const ticketReviewTraceRecordV0Schema:
z.ZodType<TicketReviewTraceRecordV0> = z.object({
  recordRef: opaqueRef,
  kind: z.enum(TICKET_REVIEW_TRACE_KINDS),
  subkind: canonicalString(100).optional(),
  subject: ticketReviewTraceSubjectV0Schema,
  producer: z.object({
    kind: z.enum(["claimed_actor", "receipt", "authority_receipt", "system"]),
    ref: opaqueRef,
  }).strict(),
  occurredAt: ticketReviewInstantV0Schema,
  summary: canonicalString(500),
  body: longText.optional(),
  status: canonicalString(100).optional(),
  crossReferences: z.array(opaqueRef).max(50),
  targets: z.array(ticketReviewTraceTargetV0Schema).max(20),
  availability: z.enum(["available", "unavailable"]),
}).strict().superRefine((value, context) => {
  if (value.producer.kind === "claimed_actor"
    && value.kind !== "proposal"
    && value.kind !== "artifact") {
    context.addIssue({
      code: "custom",
      path: ["producer", "kind"],
      message: "claimed_actor may only produce proposal or artifact trace records",
    });
  }
  if (value.kind === "gate_decision" && value.producer.kind !== "authority_receipt") {
    context.addIssue({
      code: "custom",
      path: ["producer", "kind"],
      message: "gate_decision trace records require an authority_receipt producer",
    });
  }
  if ((value.kind === "validation" || value.kind === "mutation_receipt")
    && value.producer.kind !== "receipt") {
    context.addIssue({
      code: "custom",
      path: ["producer", "kind"],
      message: `${value.kind} trace records require a receipt producer`,
    });
  }
});

export const ticketTraceListRequestV0Schema:
z.ZodType<TicketTraceListRequestV0> = z.object({
  snapshotId: opaqueRef,
  subject: ticketReviewSubjectRefV0Schema,
  kinds: z.array(z.enum(TICKET_REVIEW_TRACE_KINDS))
    .max(TICKET_REVIEW_TRACE_KINDS.length)
    .refine((kinds) => new Set(kinds).size === kinds.length, {
      message: "trace kinds must be unique",
    })
    .optional(),
  cursor: canonicalString(2_000).optional(),
  limit: z.number().int().min(1)
    .max(TICKET_REVIEW_MAX_TRACE_RECORDS_PER_PAGE)
    .optional(),
}).strict();

function traceMatchesSubject(
  trace: TicketReviewTraceRecordV0,
  subject: TicketReviewSubjectRefV0,
): boolean {
  if (subject.kind === "ticket") {
    return trace.subject.kind === "ticket"
      && trace.subject.ticketId === subject.ticketId;
  }
  return trace.subject.kind === "relation"
    && trace.subject.relationRef === subject.relationRef;
}

export const ticketTraceListPageV0Schema:
z.ZodType<TicketTraceListPageV0> = z.object({
  ...projectionHeaderShape,
  subject: ticketReviewSubjectRefV0Schema,
  records: z.array(ticketReviewTraceRecordV0Schema)
    .max(TICKET_REVIEW_MAX_TRACE_RECORDS_PER_PAGE),
  page: ticketReviewPageV0Schema,
  nextCursor: canonicalString(2_000).nullable(),
}).strict().superRefine((value, context) => {
  if (value.page.count !== value.records.length) {
    context.addIssue({
      code: "custom",
      path: ["page", "count"],
      message: "must equal the number of emitted trace records",
    });
  }
  if (value.page.totalItems > TICKET_REVIEW_MAX_TRACE_RECORDS) {
    context.addIssue({
      code: "custom",
      path: ["page", "totalItems"],
      message: `must not exceed ${TICKET_REVIEW_MAX_TRACE_RECORDS}`,
    });
  }
  if (!pageCursorIsCoherent(value.page, value.nextCursor)) {
    context.addIssue({
      code: "custom",
      path: ["nextCursor"],
      message: "must agree with the page bounds and remaining record count",
    });
  }
  if (!hasUniqueValues(value.records.map((record) => record.recordRef))) {
    context.addIssue({
      code: "custom",
      path: ["records"],
      message: "recordRef values must be unique within the page",
    });
  }
  value.records.forEach((record, index) => {
    if (!traceMatchesSubject(record, value.subject)) {
      context.addIssue({
        code: "custom",
        path: ["records", index, "subject"],
        message: "must match the selected trace subject",
      });
    }
    if (record.subject.kind === "relation"
      && record.subject.sourceRevision !== value.snapshotRevision) {
      context.addIssue({
        code: "custom",
        path: ["records", index, "subject", "sourceRevision"],
        message: "must match the trace page snapshotRevision",
      });
    }
  });
});
