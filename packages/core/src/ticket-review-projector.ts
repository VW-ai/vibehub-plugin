import crypto from "node:crypto";
import { z, type ZodType } from "zod";
import {
  TICKET_REVIEW_DEFAULT_PAGE_SIZE,
  TICKET_REVIEW_MAX_PAGE_SIZE,
  TICKET_REVIEW_MAX_RELATIONS,
  TICKET_REVIEW_MAX_TICKETS,
  TICKET_REVIEW_MAX_TRACE_RECORDS,
  TICKET_REVIEW_PROJECTOR_VERSION,
  TICKET_REVIEW_RELATION_CAPABILITIES,
  TICKET_REVIEW_SCHEMA_VERSION,
  TICKET_REVIEW_SNAPSHOT_CAPABILITIES,
  TICKET_REVIEW_TICKET_CAPABILITIES,
  type TicketGraphSnapshotPageV0,
  type TicketGraphSnapshotRequestV0,
  type TicketReviewCapabilitySlotV0,
  type TicketReviewCapabilitySummaryV0,
  type TicketReviewRelationProjectionV0,
  type TicketReviewSourceMetadataV0,
  type TicketReviewSubjectRefV0,
  type TicketReviewTicketProjectionV0,
  type TicketReviewTraceRecordV0,
  type TicketSubjectInspectionV0,
  type TicketTraceListPageV0,
  type TicketTraceListRequestV0,
} from "./contract/ticket-review.js";
import {
  ticketGraphSnapshotPageV0Schema,
  ticketGraphSnapshotRequestV0Schema,
  ticketSubjectInspectionV0Schema,
  ticketSubjectInspectRequestV0Schema,
  ticketTraceListPageV0Schema,
  ticketTraceListRequestV0Schema,
} from "./contract/ticket-review-schemas.js";
import {
  TICKET_REVIEW_MAX_CURRENT_CAPABILITY_PROJECTIONS,
  ticketReviewProjectionSourceV0Schema,
  type TicketReviewCurrentCapabilityProjectionV0,
  type TicketReviewProjectionSourceV0,
} from "./ticket-review-source.js";

export type TicketReviewProjectionErrorCode =
  | "validation_error"
  | "not_found"
  | "invalid_snapshot"
  | "snapshot_expired"
  | "projection_too_large"
  | "projection_invariant_failed";

export type TicketReviewProjectionInvariantCause =
  | "duplicate_ticket_id"
  | "duplicate_relation_ref"
  | "duplicate_direct_unlock"
  | "duplicate_capability_projection_ref"
  | "duplicate_trace_record_ref"
  | "duplicate_projection_set_member"
  | "unknown_relation_endpoint"
  | "self_relation"
  | "direct_unlock_cycle"
  | "unknown_trace_ticket"
  | "trace_ticket_revision_mismatch"
  | "unknown_trace_relation"
  | "trace_relation_binding_mismatch"
  | "capability_projection_boundary_mismatch"
  | "unknown_capability_ticket"
  | "capability_ticket_revision_mismatch"
  | "unknown_capability_relation"
  | "capability_relation_binding_mismatch"
  | "duplicate_current_capability"
  | "source_contract_violation"
  | "source_provider_contract_violation"
  | "output_contract_violation";

export class TicketReviewProjectionError extends Error {
  constructor(
    readonly code: TicketReviewProjectionErrorCode,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "TicketReviewProjectionError";
  }
}

interface ProjectionHeader {
  schemaVersion: typeof TICKET_REVIEW_SCHEMA_VERSION;
  projectorVersion: string;
  snapshotId: string;
  snapshotRevision: string;
  projectionWatermark: string;
  topologyDigest: string;
  source: TicketReviewSourceMetadataV0;
}

interface FullProjection {
  header: ProjectionHeader;
  summary: TicketGraphSnapshotPageV0["summary"];
  tickets: TicketReviewTicketProjectionV0[];
  relations: TicketReviewRelationProjectionV0[];
  lenses: TicketReviewCapabilitySlotV0;
  traceRecords: TicketReviewTraceRecordV0[];
  definitionsById: Map<
    string,
    TicketReviewProjectionSourceV0["ticketDefinitions"][number]
  >;
}

const unavailable = (): TicketReviewCapabilitySlotV0 => ({
  availability: "unavailable",
});
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compare(left, right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

const digest = (value: unknown): string => crypto
  .createHash("sha256")
  .update(JSON.stringify(canonicalize(value)))
  .digest("hex");

function parse<T>(schema: ZodType<T>, value: unknown, scope: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new TicketReviewProjectionError("validation_error", `invalid ${scope}`, {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String),
      code: issue.code,
      message: issue.message,
    })),
  });
}

function assertOutput<T>(schema: ZodType<T>, value: unknown, scope: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new TicketReviewProjectionError(
    "projection_invariant_failed",
    `invalid ${scope}`,
    {
      cause: "output_contract_violation",
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String),
        code: issue.code,
        message: issue.message,
      })),
    },
  );
}

function failInvariant(
  cause: TicketReviewProjectionInvariantCause,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new TicketReviewProjectionError(
    "projection_invariant_failed",
    message,
    { cause, ...details },
  );
}

function preflightCapacity(sourceValue: unknown): void {
  if (!isRecord(sourceValue)) return;
  const limits = [
    ["ticketDefinitions", TICKET_REVIEW_MAX_TICKETS],
    ["directUnlocks", TICKET_REVIEW_MAX_RELATIONS],
    [
      "currentCapabilityProjections",
      TICKET_REVIEW_MAX_CURRENT_CAPABILITY_PROJECTIONS,
    ],
    ["traceRecords", TICKET_REVIEW_MAX_TRACE_RECORDS],
  ] as const;
  for (const [field, maximum] of limits) {
    const value = sourceValue[field];
    if (Array.isArray(value) && value.length > maximum) {
      throw new TicketReviewProjectionError(
        "projection_too_large",
        `ticket review source exceeds the v0 ${field} capacity`,
        { field, count: value.length, maximum },
      );
    }
  }
}

function parseProjectionSource(
  sourceValue: unknown,
): TicketReviewProjectionSourceV0 {
  preflightCapacity(sourceValue);
  const result = ticketReviewProjectionSourceV0Schema.safeParse(sourceValue);
  if (result.success) return result.data;
  throw new TicketReviewProjectionError(
    "projection_invariant_failed",
    "invalid resolver-selected Ticket review source",
    {
      cause: "source_contract_violation",
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String),
        code: issue.code,
        message: issue.message,
      })),
    },
  );
}

function assertUnique(
  values: string[],
  cause: TicketReviewProjectionInvariantCause,
  label: string,
  details: Record<string, unknown> = {},
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      failInvariant(cause, `${label} must be unique`, { ...details, value });
    }
    seen.add(value);
  }
}

function normalizeSet(
  values: string[] | undefined,
  label: string,
  details: Record<string, unknown>,
): string[] {
  const normalized = values ?? [];
  assertUnique(
    normalized,
    "duplicate_projection_set_member",
    label,
    details,
  );
  return [...normalized].sort(compare);
}

function normalizeSummary(
  summary: TicketReviewCapabilitySummaryV0,
  details: Record<string, unknown>,
): TicketReviewCapabilitySummaryV0 {
  assertUnique(
    summary.references.map(({ ref }) => ref),
    "duplicate_projection_set_member",
    "capability summary reference",
    details,
  );
  return {
    label: summary.label,
    ...(summary.detail === undefined ? {} : { detail: summary.detail }),
    ...(summary.count === undefined ? {} : { count: summary.count }),
    references: [...summary.references]
      .map((reference) => ({
        ref: reference.ref,
        ...(reference.label === undefined ? {} : { label: reference.label }),
      }))
      .sort((left, right) =>
        compare(left.ref, right.ref)
        || compare(left.label ?? "", right.label ?? "")),
  };
}

function normalizeSource(
  source: TicketReviewProjectionSourceV0,
): TicketReviewProjectionSourceV0 {
  const ticketDefinitions = source.ticketDefinitions
    .map((definition) => ({
      ...definition,
      acceptance: [...definition.acceptance]
        .map((item) => ({ ...item }))
        .sort((left, right) =>
          compare(left.acceptanceId, right.acceptanceId)),
      contextRefs: [...definition.contextRefs]
        .map((item) => ({ ...item }))
        .sort((left, right) => compare(left.ref, right.ref)),
      provenanceRefs: normalizeSet(
        definition.provenanceRefs,
        "Ticket provenance reference",
        { ticketId: definition.ticketId },
      ),
    }))
    .sort((left, right) => compare(left.ticketId, right.ticketId));
  for (const definition of ticketDefinitions) {
    assertUnique(
      definition.acceptance.map((item) => item.acceptanceId),
      "duplicate_projection_set_member",
      "Ticket acceptance ID",
      { ticketId: definition.ticketId },
    );
    assertUnique(
      definition.contextRefs.map((item) => item.ref),
      "duplicate_projection_set_member",
      "Ticket context reference",
      { ticketId: definition.ticketId },
    );
  }
  const directUnlocks = source.directUnlocks
    .map((relation) => ({
      ...relation,
      provenanceRefs: normalizeSet(
        relation.provenanceRefs,
        "relation provenance reference",
        { relationRef: relation.relationRef },
      ),
    }))
    .sort((left, right) =>
      compare(left.prerequisiteTicketId, right.prerequisiteTicketId)
      || compare(left.dependentTicketId, right.dependentTicketId)
      || compare(left.relationRef, right.relationRef));
  const currentCapabilityProjections = source.currentCapabilityProjections
    .map((projection) => ({
      ...projection,
      summary: normalizeSummary(projection.summary, {
        producerReceiptRef: projection.producerReceiptRef,
      }),
    }))
    .sort((left, right) =>
      compare(left.producerReceiptRef, right.producerReceiptRef));
  const traceRecords = source.traceRecords
    .map((trace) => {
      assertUnique(
        trace.targets.map((target) =>
          JSON.stringify([target.kind, target.label, target.target])),
        "duplicate_projection_set_member",
        "trace target",
        { recordRef: trace.recordRef },
      );
      return {
        ...trace,
        crossReferences: normalizeSet(
          trace.crossReferences,
          "trace cross-reference",
          { recordRef: trace.recordRef },
        ),
        targets: [...trace.targets].sort((left, right) =>
          compare(left.kind, right.kind)
          || compare(left.label, right.label)
          || compare(left.target, right.target)),
      };
    })
    .sort((left, right) =>
      Date.parse(right.occurredAt) - Date.parse(left.occurredAt)
      || compare(right.recordRef, left.recordRef));

  return {
    schemaVersion: source.schemaVersion,
    snapshotRevision: source.snapshotRevision,
    projectionWatermark: source.projectionWatermark,
    source: source.source.mode === "worktree"
      ? {
          ...source.source,
          dirtyPaths: [...source.source.dirtyPaths].sort(compare),
        }
      : source.source,
    ticketDefinitions,
    directUnlocks,
    currentCapabilityProjections,
    traceRecords,
  };
}

const cursorBaseShape = {
  version: z.literal(1),
  snapshotId: z.string().min(1).max(300),
  offset: z.number().int().min(0),
};
const cursorSchema = z.discriminatedUnion("kind", [
  z.object({
    ...cursorBaseShape,
    kind: z.literal("graph"),
  }).strict(),
  z.object({
    ...cursorBaseShape,
    kind: z.literal("trace"),
    scopeDigest: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
]);
type Cursor = z.infer<typeof cursorSchema>;

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor<K extends Cursor["kind"]>(
  value: string,
  expectedKind: K,
): Extract<Cursor, { kind: K }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new TicketReviewProjectionError(
      "validation_error",
      "invalid cursor encoding",
    );
  }
  const cursor = parse(cursorSchema, parsed, "cursor");
  if (cursor.kind !== expectedKind) {
    throw new TicketReviewProjectionError(
      "validation_error",
      "cursor kind does not match the read operation",
    );
  }
  return cursor as Extract<Cursor, { kind: K }>;
}

/**
 * Read the snapshot selector from a validated graph request without exposing
 * cursor encoding as a storage or transport contract.
 *
 * The read service uses this before source resolution so a later page is
 * reconstructed from its bound snapshot instead of being compared with the
 * latest graph.
 */
export function readTicketGraphCursorSnapshotIdV0(
  request: TicketGraphSnapshotRequestV0,
): string | null {
  return request.cursor
    ? decodeCursor(request.cursor, "graph").snapshotId
    : null;
}

function ticketTraceScopeDigest(request: TicketTraceListRequestV0): string {
  return digest({
    subject: request.subject,
    kinds: request.kinds ? [...request.kinds].sort(compare) : null,
  });
}

/**
 * Validate every trace-cursor selector before a read service touches its
 * source provider. A cursor is bound to the explicit snapshot, subject, and
 * kind filter carried by the request.
 */
function decodeTicketTraceCursorV0(
  request: TicketTraceListRequestV0,
): Extract<Cursor, { kind: "trace" }> | null {
  if (!request.cursor) return null;
  const cursor = decodeCursor(request.cursor, "trace");
  if (cursor.snapshotId !== request.snapshotId) {
    throw new TicketReviewProjectionError(
      "validation_error",
      "trace cursor does not match the requested snapshot",
    );
  }
  if (cursor.scopeDigest !== ticketTraceScopeDigest(request)) {
    throw new TicketReviewProjectionError(
      "validation_error",
      "trace cursor does not match the requested subject and kinds",
    );
  }
  return cursor;
}

export function validateTicketTraceCursorSelectorsV0(
  request: TicketTraceListRequestV0,
): void {
  decodeTicketTraceCursorV0(request);
}

function assertAcyclic(
  ticketIds: string[],
  relations: TicketReviewProjectionSourceV0["directUnlocks"],
): void {
  const indegree = new Map(ticketIds.map((ticketId) => [ticketId, 0]));
  const dependents = new Map(
    ticketIds.map((ticketId) => [ticketId, [] as string[]]),
  );
  for (const relation of relations) {
    indegree.set(
      relation.dependentTicketId,
      (indegree.get(relation.dependentTicketId) ?? 0) + 1,
    );
    dependents.get(relation.prerequisiteTicketId)!
      .push(relation.dependentTicketId);
  }
  const ready = ticketIds
    .filter((ticketId) => indegree.get(ticketId) === 0);
  let readyIndex = 0;
  let visited = 0;
  while (readyIndex < ready.length) {
    const ticketId = ready[readyIndex]!;
    readyIndex += 1;
    visited += 1;
    for (const dependent of dependents.get(ticketId)!) {
      const next = indegree.get(dependent)! - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
      }
    }
  }
  if (visited !== ticketIds.length) {
    failInvariant(
      "direct_unlock_cycle",
      "direct-unlock projection contains a cycle",
    );
  }
}

function matchesSubject(
  trace: TicketReviewTraceRecordV0,
  subject: TicketReviewSubjectRefV0,
): boolean {
  const traceSubject = trace.subject;
  if (subject.kind === "graph") {
    return traceSubject.kind === "graph";
  }
  if (subject.kind === "ticket") {
    return traceSubject.kind === "ticket"
      && traceSubject.ticketId === subject.ticketId;
  }
  return traceSubject.kind === "relation"
    && traceSubject.relationRef === subject.relationRef;
}

function slotKey(
  projection: TicketReviewCurrentCapabilityProjectionV0,
): string {
  if (projection.subject.kind === "ticket") {
    return JSON.stringify([
      "ticket",
      projection.subject.ticketId,
      projection.capability,
    ]);
  }
  if (projection.subject.kind === "relation") {
    return JSON.stringify([
      "relation",
      projection.subject.relationRef,
      projection.capability,
    ]);
  }
  return JSON.stringify(["snapshot", projection.capability]);
}

function buildProjection(sourceValue: unknown): FullProjection {
  const parsedSource = parseProjectionSource(sourceValue);
  const source = normalizeSource(parsedSource);

  assertUnique(
    source.ticketDefinitions.map((ticket) => ticket.ticketId),
    "duplicate_ticket_id",
    "ticketId",
  );
  assertUnique(
    source.directUnlocks.map((relation) => relation.relationRef),
    "duplicate_relation_ref",
    "relationRef",
  );
  assertUnique(
    source.currentCapabilityProjections.map(
      (projection) => projection.producerReceiptRef,
    ),
    "duplicate_capability_projection_ref",
    "producerReceiptRef",
  );
  assertUnique(
    source.traceRecords.map((trace) => trace.recordRef),
    "duplicate_trace_record_ref",
    "recordRef",
  );

  const definitions = source.ticketDefinitions;
  const definitionById = new Map(
    definitions.map((definition) => [definition.ticketId, definition]),
  );
  const relations = source.directUnlocks;
  const relationByRef = new Map(
    relations.map((relation) => [relation.relationRef, relation]),
  );
  assertUnique(
    relations.map((relation) =>
      JSON.stringify([
        relation.prerequisiteTicketId,
        relation.dependentTicketId,
      ])),
    "duplicate_direct_unlock",
    "direct-unlock endpoint pair",
  );

  const prerequisiteCounts = new Map(
    definitions.map((definition) => [definition.ticketId, 0]),
  );
  const dependentCounts = new Map(
    definitions.map((definition) => [definition.ticketId, 0]),
  );
  for (const relation of relations) {
    if (!definitionById.has(relation.prerequisiteTicketId)
      || !definitionById.has(relation.dependentTicketId)) {
      failInvariant(
        "unknown_relation_endpoint",
        "direct-unlock relation references an unknown Ticket",
        {
          relationRef: relation.relationRef,
          prerequisiteTicketId: relation.prerequisiteTicketId,
          dependentTicketId: relation.dependentTicketId,
        },
      );
    }
    if (relation.prerequisiteTicketId === relation.dependentTicketId) {
      failInvariant(
        "self_relation",
        "direct-unlock relation cannot reference the same Ticket twice",
        { relationRef: relation.relationRef },
      );
    }
    dependentCounts.set(
      relation.prerequisiteTicketId,
      dependentCounts.get(relation.prerequisiteTicketId)! + 1,
    );
    prerequisiteCounts.set(
      relation.dependentTicketId,
      prerequisiteCounts.get(relation.dependentTicketId)! + 1,
    );
  }
  assertAcyclic(
    definitions.map((definition) => definition.ticketId),
    relations,
  );

  const ticketTraceCounts = new Map(
    definitions.map((definition) => [definition.ticketId, 0]),
  );
  const relationTraceCounts = new Map(
    relations.map((relation) => [relation.relationRef, 0]),
  );
  const traceRecords = source.traceRecords;
  for (const trace of traceRecords) {
    const traceSubject = trace.subject;
    if (traceSubject.kind === "graph") continue;
    if (traceSubject.kind === "ticket") {
      const definition = definitionById.get(traceSubject.ticketId);
      if (!definition) {
        failInvariant(
          "unknown_trace_ticket",
          "trace references an unknown Ticket",
          { recordRef: trace.recordRef, ticketId: traceSubject.ticketId },
        );
      }
      if (traceSubject.boundTicketRevision
        !== definition.ticketRevision) {
        failInvariant(
          "trace_ticket_revision_mismatch",
          "trace is not bound to the visible Ticket revision",
          {
            recordRef: trace.recordRef,
            ticketId: traceSubject.ticketId,
            boundTicketRevision:
              traceSubject.boundTicketRevision,
            visibleTicketRevision: definition.ticketRevision,
          },
        );
      }
      ticketTraceCounts.set(
        definition.ticketId,
        ticketTraceCounts.get(definition.ticketId)! + 1,
      );
      continue;
    }

    const relation = relationByRef.get(traceSubject.relationRef);
    if (!relation) {
      failInvariant(
        "unknown_trace_relation",
        "trace references an unknown snapshot relation",
        {
          recordRef: trace.recordRef,
          relationRef: traceSubject.relationRef,
        },
      );
    }
    if ((traceSubject.sourceRevision !== undefined
      && traceSubject.sourceRevision !== source.snapshotRevision)
      || traceSubject.prerequisiteTicketId
        !== relation.prerequisiteTicketId
      || traceSubject.dependentTicketId !== relation.dependentTicketId) {
      failInvariant(
        "trace_relation_binding_mismatch",
        "trace relation binding does not match the visible snapshot relation",
        {
          recordRef: trace.recordRef,
          relationRef: traceSubject.relationRef,
        },
      );
    }
    relationTraceCounts.set(
      relation.relationRef,
      relationTraceCounts.get(relation.relationRef)! + 1,
    );
  }

  const ticketCapabilities = new Map<string, Record<
    typeof TICKET_REVIEW_TICKET_CAPABILITIES[number],
    TicketReviewCapabilitySlotV0
  >>();
  for (const definition of definitions) {
    ticketCapabilities.set(
      definition.ticketId,
      Object.fromEntries(
        TICKET_REVIEW_TICKET_CAPABILITIES.map(
          (capability) => [capability, unavailable()],
        ),
      ) as Record<
        typeof TICKET_REVIEW_TICKET_CAPABILITIES[number],
        TicketReviewCapabilitySlotV0
      >,
    );
  }
  const relationCapabilities = new Map<string, Record<
    typeof TICKET_REVIEW_RELATION_CAPABILITIES[number],
    TicketReviewCapabilitySlotV0
  >>();
  for (const relation of relations) {
    relationCapabilities.set(
      relation.relationRef,
      Object.fromEntries(
        TICKET_REVIEW_RELATION_CAPABILITIES.map(
          (capability) => [capability, unavailable()],
        ),
      ) as Record<
        typeof TICKET_REVIEW_RELATION_CAPABILITIES[number],
        TicketReviewCapabilitySlotV0
      >,
    );
  }
  const snapshotCapabilities = Object.fromEntries(
    TICKET_REVIEW_SNAPSHOT_CAPABILITIES.map(
      (capability) => [capability, unavailable()],
    ),
  ) as Record<
    typeof TICKET_REVIEW_SNAPSHOT_CAPABILITIES[number],
    TicketReviewCapabilitySlotV0
  >;
  const appliedCapabilityKeys = new Set<string>();

  for (const projection of source.currentCapabilityProjections) {
    if (projection.snapshotRevision !== source.snapshotRevision
      || projection.projectionWatermark
        !== source.projectionWatermark) {
      failInvariant(
        "capability_projection_boundary_mismatch",
        "current capability projection is not bound to the visible projection boundary",
        {
          producerReceiptRef: projection.producerReceiptRef,
          snapshotRevision: projection.snapshotRevision,
          projectionWatermark: projection.projectionWatermark,
        },
      );
    }

    const key = slotKey(projection);
    if (appliedCapabilityKeys.has(key)) {
      failInvariant(
        "duplicate_current_capability",
        "multiple current projections provide the same capability",
        { key },
      );
    }

    const slot: TicketReviewCapabilitySlotV0 = {
      availability: "available",
      producerReceiptRef: projection.producerReceiptRef,
      summary: projection.summary,
    };
    if (projection.subject.kind === "ticket") {
      const definition = definitionById.get(projection.subject.ticketId);
      if (!definition) {
        failInvariant(
          "unknown_capability_ticket",
          "current capability projection references an unknown Ticket",
          {
            producerReceiptRef: projection.producerReceiptRef,
            ticketId: projection.subject.ticketId,
          },
        );
      }
      if (definition.ticketRevision
        !== projection.subject.ticketRevision) {
        failInvariant(
          "capability_ticket_revision_mismatch",
          "current capability projection does not match the visible Ticket definition revision",
          {
            producerReceiptRef: projection.producerReceiptRef,
            ticketId: definition.ticketId,
            boundTicketRevision:
              projection.subject.ticketRevision,
            visibleTicketRevision: definition.ticketRevision,
          },
        );
      }
      const capability =
        projection.capability as typeof TICKET_REVIEW_TICKET_CAPABILITIES[number];
      ticketCapabilities.get(definition.ticketId)![capability] = slot;
    } else if (projection.subject.kind === "relation") {
      const relation = relationByRef.get(projection.subject.relationRef);
      if (!relation) {
        failInvariant(
          "unknown_capability_relation",
          "current capability projection references an unknown snapshot relation",
          {
            producerReceiptRef: projection.producerReceiptRef,
            relationRef: projection.subject.relationRef,
          },
        );
      }
      if (projection.subject.prerequisiteTicketId
          !== relation.prerequisiteTicketId
        || projection.subject.dependentTicketId
          !== relation.dependentTicketId) {
        failInvariant(
          "capability_relation_binding_mismatch",
          "current capability projection does not match the visible relation endpoints",
          {
            producerReceiptRef: projection.producerReceiptRef,
            relationRef: relation.relationRef,
          },
        );
      }
      const capability =
        projection.capability as typeof TICKET_REVIEW_RELATION_CAPABILITIES[number];
      relationCapabilities.get(relation.relationRef)![capability] = slot;
    } else {
      const capability =
        projection.capability as typeof TICKET_REVIEW_SNAPSHOT_CAPABILITIES[number];
      snapshotCapabilities[capability] = slot;
    }
    appliedCapabilityKeys.add(key);
  }

  const ticketProjections = definitions.map(
    (definition): TicketReviewTicketProjectionV0 => ({
      ticketId: definition.ticketId,
      ticketRevision: definition.ticketRevision,
      outcome: definition.outcome,
      provenanceRefs: definition.provenanceRefs ?? [],
      capabilities: ticketCapabilities.get(definition.ticketId)!,
      relationCounts: {
        prerequisites: prerequisiteCounts.get(definition.ticketId)!,
        dependents: dependentCounts.get(definition.ticketId)!,
      },
      traceCount: ticketTraceCounts.get(definition.ticketId)!,
    }),
  );
  const relationProjections = relations.map(
    (relation): TicketReviewRelationProjectionV0 => ({
      relationRef: relation.relationRef,
      prerequisiteTicketId: relation.prerequisiteTicketId,
      dependentTicketId: relation.dependentTicketId,
      ...(relation.rationale === undefined
        ? {}
        : { rationale: relation.rationale }),
      provenanceRefs: relation.provenanceRefs ?? [],
      capabilities: relationCapabilities.get(relation.relationRef)!,
      traceCount: relationTraceCounts.get(relation.relationRef)!,
    }),
  );

  const topologyDigest = `sha256:${digest({
    ticketIds: definitions.map(({ ticketId }) => ticketId),
    directUnlockPairs: relations.map(
      ({ prerequisiteTicketId, dependentTicketId }) => ({
        prerequisiteTicketId,
        dependentTicketId,
      }),
    ),
  })}`;
  const snapshotId = `tgs-${digest({
    projectorVersion: TICKET_REVIEW_PROJECTOR_VERSION,
    sourceToken: source.source.sourceToken,
    source: {
      schemaVersion: source.schemaVersion,
      snapshotRevision: source.snapshotRevision,
      projectionWatermark: source.projectionWatermark,
      ticketDefinitions: source.ticketDefinitions,
      directUnlocks: source.directUnlocks,
      currentCapabilityProjections: source.currentCapabilityProjections,
      traceRecords: source.traceRecords,
    },
  })}`;
  const header: ProjectionHeader = {
    schemaVersion: TICKET_REVIEW_SCHEMA_VERSION,
    projectorVersion: TICKET_REVIEW_PROJECTOR_VERSION,
    snapshotId,
    snapshotRevision: source.snapshotRevision,
    projectionWatermark: source.projectionWatermark,
    topologyDigest,
    source: source.source,
  };
  return {
    header,
    summary: {
      ticketCount: definitions.length,
      directUnlockCount: relations.length,
      activeRuns: snapshotCapabilities.active_runs,
      needsActor: snapshotCapabilities.needs_actor,
    },
    tickets: ticketProjections,
    relations: relationProjections,
    lenses: snapshotCapabilities.lenses,
    traceRecords,
    definitionsById: definitionById,
  };
}

/**
 * Compute the public snapshot identity through the same validated projection
 * path used by every read. Providers and future publishers must never
 * reimplement this hash algorithm.
 */
export function deriveTicketReviewSnapshotIdV0(
  sourceValue: unknown,
): string {
  return buildProjection(sourceValue).header.snapshotId;
}

function assertSnapshot(full: FullProjection, snapshotId: string): void {
  if (full.header.snapshotId !== snapshotId) {
    throw new TicketReviewProjectionError(
      "invalid_snapshot",
      "the requested snapshot does not match the current reconstructible source",
      {
        requestedSnapshotId: snapshotId,
        currentSnapshotId: full.header.snapshotId,
      },
    );
  }
}

export function projectTicketGraphSnapshotV0(
  sourceValue: unknown,
  requestValue: unknown = {},
): TicketGraphSnapshotPageV0 {
  const request = parse(
    ticketGraphSnapshotRequestV0Schema,
    requestValue,
    "ticket.graph.snapshot input",
  );
  const full = buildProjection(sourceValue);
  const cursor = request.cursor
    ? decodeCursor(request.cursor, "graph")
    : null;
  if (cursor) assertSnapshot(full, cursor.snapshotId);
  const offset = cursor?.offset ?? 0;
  const pageSize =
    request.pageSize ?? TICKET_REVIEW_DEFAULT_PAGE_SIZE;
  const items = [
    ...full.tickets.map((ticket) => ({
      kind: "ticket" as const,
      ticket,
    })),
    ...full.relations.map((relation) => ({
      kind: "relation" as const,
      relation,
    })),
  ];
  if (offset > items.length) {
    throw new TicketReviewProjectionError(
      "validation_error",
      "cursor offset exceeds the snapshot item count",
      { offset, totalItems: items.length },
    );
  }
  const pageItems = items.slice(offset, offset + pageSize);
  const nextOffset = offset + pageItems.length;
  return assertOutput(ticketGraphSnapshotPageV0Schema, {
    ...full.header,
    summary: full.summary,
    tickets: pageItems.flatMap((item) =>
      item.kind === "ticket" ? [item.ticket] : []),
    relations: pageItems.flatMap((item) =>
      item.kind === "relation" ? [item.relation] : []),
    lenses: full.lenses,
    page: {
      offset,
      count: pageItems.length,
      totalItems: items.length,
    },
    nextCursor: nextOffset < items.length
      ? encodeCursor({
        version: 1,
        kind: "graph",
        snapshotId: full.header.snapshotId,
        offset: nextOffset,
      })
      : null,
  }, "ticket.graph.snapshot output");
}

export function inspectTicketReviewSubjectV0(
  sourceValue: unknown,
  requestValue: unknown,
): TicketSubjectInspectionV0 {
  const request = parse(
    ticketSubjectInspectRequestV0Schema,
    requestValue,
    "ticket.subject.inspect input",
  );
  const full = buildProjection(sourceValue);
  assertSnapshot(full, request.snapshotId);
  if (request.subject.kind === "graph") {
    return assertOutput(ticketSubjectInspectionV0Schema, {
      ...full.header,
      subject: {
        kind: "graph",
        summary: full.summary,
        traceCount: full.traceRecords.filter((trace) =>
          trace.subject.kind === "graph").length,
      },
    }, "ticket.subject.inspect output");
  }
  if (request.subject.kind === "ticket") {
    const ticketId = request.subject.ticketId;
    const ticket = full.tickets.find(
      (item) => item.ticketId === ticketId,
    );
    if (!ticket) {
      throw new TicketReviewProjectionError(
        "not_found",
        "Ticket is not present in the bound snapshot",
        { ticketId },
      );
    }
    return assertOutput(ticketSubjectInspectionV0Schema, {
      ...full.header,
      subject: {
        kind: "ticket",
        ticket,
        contextPackage: {
          outcome: ticket.outcome,
          context: full.definitionsById.get(ticketId)!.context,
          acceptance: full.definitionsById.get(ticketId)!.acceptance,
          constraints: full.definitionsById.get(ticketId)!.constraints,
          contextRefs: full.definitionsById.get(ticketId)!.contextRefs,
          relations: full.relations
            .filter((relation) =>
              relation.dependentTicketId === ticket.ticketId)
            .map((relation) => ({
              relationRef: relation.relationRef,
              type: "depends_on" as const,
              targetTicketId: relation.prerequisiteTicketId,
              ...(relation.rationale === undefined
                ? {}
                : { rationale: relation.rationale }),
            })),
          provenanceRefs: ticket.provenanceRefs,
        },
        prerequisiteRelationRefs: full.relations
          .filter((relation) =>
            relation.dependentTicketId === ticket.ticketId)
          .map((relation) => relation.relationRef),
        dependentRelationRefs: full.relations
          .filter((relation) =>
            relation.prerequisiteTicketId === ticket.ticketId)
          .map((relation) => relation.relationRef),
      },
    }, "ticket.subject.inspect output");
  }

  const relationRef = request.subject.relationRef;
  const relation = full.relations.find(
    (item) => item.relationRef === relationRef,
  );
  if (!relation) {
    throw new TicketReviewProjectionError(
      "not_found",
      "relation is not present in the bound snapshot",
      { relationRef },
    );
  }
  return assertOutput(ticketSubjectInspectionV0Schema, {
    ...full.header,
    subject: { kind: "relation", relation },
  }, "ticket.subject.inspect output");
}

export function listTicketReviewTraceV0(
  sourceValue: unknown,
  requestValue: unknown,
): TicketTraceListPageV0 {
  const request = parse(
    ticketTraceListRequestV0Schema,
    requestValue,
    "ticket.trace.list input",
  );
  const cursor = decodeTicketTraceCursorV0(request);
  const scopeDigest = ticketTraceScopeDigest(request);
  const full = buildProjection(sourceValue);
  assertSnapshot(full, request.snapshotId);
  if (request.subject.kind === "graph") {
    // The graph locus is always present for a valid bound snapshot.
  } else if (request.subject.kind === "ticket") {
    const ticketId = request.subject.ticketId;
    if (!full.tickets.some(
      (ticket) => ticket.ticketId === ticketId,
    )) {
      throw new TicketReviewProjectionError(
        "not_found",
        "Ticket is not present in the bound snapshot",
        { ticketId },
      );
    }
  } else {
    const relationRef = request.subject.relationRef;
    if (!full.relations.some(
      (relation) => relation.relationRef === relationRef,
    )) {
      throw new TicketReviewProjectionError(
        "not_found",
        "relation is not present in the bound snapshot",
        { relationRef },
      );
    }
  }

  const kinds = request.kinds ? new Set(request.kinds) : null;
  const records = full.traceRecords.filter((trace) =>
    matchesSubject(trace, request.subject)
    && (!kinds || kinds.has(trace.kind)));
  const offset = cursor?.offset ?? 0;
  if (offset > records.length) {
    throw new TicketReviewProjectionError(
      "validation_error",
      "cursor offset exceeds the trace result count",
      { offset, totalItems: records.length },
    );
  }
  const limit = request.limit ?? 50;
  const pageRecords = records.slice(offset, offset + limit);
  const nextOffset = offset + pageRecords.length;
  return assertOutput(ticketTraceListPageV0Schema, {
    ...full.header,
    subject: request.subject,
    records: pageRecords,
    page: {
      offset,
      count: pageRecords.length,
      totalItems: records.length,
    },
    nextCursor: nextOffset < records.length
      ? encodeCursor({
        version: 1,
        kind: "trace",
        snapshotId: full.header.snapshotId,
        offset: nextOffset,
        scopeDigest,
      })
      : null,
  }, "ticket.trace.list output");
}
