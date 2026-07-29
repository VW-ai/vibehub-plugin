/**
 * Browser-safe Ticket Review v0 wire contracts.
 *
 * Keep this module dependency-free. Runtime validation is intentionally exposed
 * through the opt-in `./contracts/ticket-review-schemas` package subpath.
 */

export const TICKET_REVIEW_SCHEMA_VERSION = 2 as const;
export const TICKET_REVIEW_PROJECTOR_VERSION = "ticket-review-v1" as const;
export const TICKET_REVIEW_DEFAULT_PAGE_SIZE = 200;
export const TICKET_REVIEW_MAX_PAGE_SIZE = 200;
export const TICKET_REVIEW_MAX_TICKETS = 1_000;
export const TICKET_REVIEW_MAX_RELATIONS = 5_000;
export const TICKET_REVIEW_MAX_TRACE_RECORDS = 20_000;
export const TICKET_REVIEW_MAX_TRACE_RECORDS_PER_PAGE = 200;

export const TICKET_REVIEW_TICKET_CAPABILITIES = [
  "display",
  "maturity",
  "operational",
  "blockers",
  "validation",
  "context",
  "active_run",
  "acceptance",
  "attention",
  "lens_membership",
] as const;

export const TICKET_REVIEW_RELATION_CAPABILITIES = [
  "active_spine",
  "attention",
] as const;

export const TICKET_REVIEW_SNAPSHOT_CAPABILITIES = [
  "active_runs",
  "needs_actor",
  "lenses",
] as const;

export const TICKET_REVIEW_TRACE_KINDS = [
  "validation",
  "gate_decision",
  "run",
  "outcome",
  "evidence",
  "artifact",
  "mutation_receipt",
  "context_binding",
] as const;

export type TicketReviewTicketCapabilityV0 =
  typeof TICKET_REVIEW_TICKET_CAPABILITIES[number];
export type TicketReviewRelationCapabilityV0 =
  typeof TICKET_REVIEW_RELATION_CAPABILITIES[number];
export type TicketReviewSnapshotCapabilityV0 =
  typeof TICKET_REVIEW_SNAPSHOT_CAPABILITIES[number];
export type TicketReviewTraceKindV0 =
  typeof TICKET_REVIEW_TRACE_KINDS[number];

export interface TicketReviewAcceptanceV0 {
  acceptanceId: string;
  criterion: string;
}

export interface TicketReviewContextRefV0 {
  ref: string;
  purpose: string;
}

export interface TicketReviewDependsOnRelationV0 {
  relationRef: string;
  type: "depends_on";
  targetTicketId: string;
  rationale?: string;
}

export interface TicketReviewExecutableContextV0 {
  outcome: string;
  context: string;
  acceptance: TicketReviewAcceptanceV0[];
  constraints: string[];
  contextRefs: TicketReviewContextRefV0[];
  relations: TicketReviewDependsOnRelationV0[];
  provenanceRefs: string[];
}

interface TicketReviewSourceMetadataBaseV0 {
  repositoryRoot: string;
  repositoryIncarnation: string;
  resolvedCommit: string;
  graphDigest: string;
  sourceToken: string;
}

export type TicketReviewSourceMetadataV0 =
  | TicketReviewSourceMetadataBaseV0 & {
      mode: "worktree";
      worktreeIdentity: string;
      worktreeRoot: string;
      branch: string | null;
      committedGraphDigest: string | null;
      semanticDirty: boolean;
      dirtyPaths: string[];
      dirtyPathsTruncated: boolean;
    }
  | TicketReviewSourceMetadataBaseV0 & {
      mode: "ref";
      resolvedCommit: string;
      requestedRef: string;
    };

export type TicketReviewSubjectRefV0 =
  | {
      kind: "ticket";
      ticketId: string;
    }
  | {
      kind: "relation";
      relationRef: string;
    };

export interface TicketReviewCapabilityReferenceV0 {
  ref: string;
  label?: string;
}

export interface TicketReviewCapabilitySummaryV0 {
  label: string;
  detail?: string;
  count?: number;
  references: TicketReviewCapabilityReferenceV0[];
}

export type TicketReviewCapabilitySlotV0 =
  | {
      availability: "unavailable";
    }
  | {
      availability: "available";
      producerReceiptRef: string;
      summary: TicketReviewCapabilitySummaryV0;
    };

export type TicketReviewTicketCapabilitiesV0 = Record<
  TicketReviewTicketCapabilityV0,
  TicketReviewCapabilitySlotV0
>;

export type TicketReviewRelationCapabilitiesV0 = Record<
  TicketReviewRelationCapabilityV0,
  TicketReviewCapabilitySlotV0
>;

export interface TicketReviewTicketProjectionV0 {
  ticketId: string;
  ticketRevision: string;
  outcome: string;
  provenanceRefs: string[];
  capabilities: TicketReviewTicketCapabilitiesV0;
  relationCounts: {
    prerequisites: number;
    dependents: number;
  };
  traceCount: number;
}

export interface TicketReviewRelationProjectionV0 {
  relationRef: string;
  prerequisiteTicketId: string;
  dependentTicketId: string;
  rationale?: string;
  provenanceRefs: string[];
  capabilities: TicketReviewRelationCapabilitiesV0;
  traceCount: number;
}

export interface TicketReviewSnapshotSummaryV0 {
  ticketCount: number;
  directUnlockCount: number;
  activeRuns: TicketReviewCapabilitySlotV0;
  needsActor: TicketReviewCapabilitySlotV0;
}

export interface TicketReviewPageV0 {
  offset: number;
  count: number;
  totalItems: number;
}

export interface TicketReviewProjectionHeaderV0 {
  schemaVersion: typeof TICKET_REVIEW_SCHEMA_VERSION;
  projectorVersion: string;
  snapshotId: string;
  snapshotRevision: string;
  projectionWatermark: string;
  topologyDigest: string;
  source: TicketReviewSourceMetadataV0;
}

export interface TicketGraphSnapshotRequestV0 {
  cursor?: string;
  pageSize?: number;
}

export interface TicketGraphSnapshotPageV0
  extends TicketReviewProjectionHeaderV0 {
  summary: TicketReviewSnapshotSummaryV0;
  tickets: TicketReviewTicketProjectionV0[];
  relations: TicketReviewRelationProjectionV0[];
  lenses: TicketReviewCapabilitySlotV0;
  page: TicketReviewPageV0;
  nextCursor: string | null;
}

export interface TicketSubjectInspectRequestV0 {
  snapshotId: string;
  subject: TicketReviewSubjectRefV0;
}

export type TicketReviewInspectedSubjectV0 =
  | {
      kind: "ticket";
      ticket: TicketReviewTicketProjectionV0;
      contextPackage: TicketReviewExecutableContextV0;
      prerequisiteRelationRefs: string[];
      dependentRelationRefs: string[];
    }
  | {
      kind: "relation";
      relation: TicketReviewRelationProjectionV0;
    };

export interface TicketSubjectInspectionV0
  extends TicketReviewProjectionHeaderV0 {
  subject: TicketReviewInspectedSubjectV0;
}

export type TicketReviewTraceSubjectV0 =
  | {
      kind: "ticket";
      ticketId: string;
      boundTicketRevision: string;
    }
  | {
      kind: "relation";
      sourceRevision: string;
      relationRef: string;
      prerequisiteTicketId: string;
      dependentTicketId: string;
    };

export type TicketReviewTraceProducerKindV0 =
  | "claimed_actor"
  | "receipt"
  | "authority_receipt"
  | "system";

export interface TicketReviewTraceProducerV0 {
  kind: TicketReviewTraceProducerKindV0;
  ref: string;
}

export type TicketReviewTraceTargetV0 =
  | {
      kind: "url";
      label: string;
      target: string;
    }
  | {
      kind: "repo_path";
      label: string;
      target: string;
    }
  | {
      kind: "opaque";
      label: string;
      target: string;
    };

export interface TicketReviewTraceRecordV0 {
  recordRef: string;
  kind: TicketReviewTraceKindV0;
  subkind?: string;
  subject: TicketReviewTraceSubjectV0;
  producer: TicketReviewTraceProducerV0;
  occurredAt: string;
  summary: string;
  body?: string;
  status?: string;
  crossReferences: string[];
  targets: TicketReviewTraceTargetV0[];
  availability: "available" | "unavailable";
}

export interface TicketTraceListRequestV0 {
  snapshotId: string;
  subject: TicketReviewSubjectRefV0;
  kinds?: TicketReviewTraceKindV0[];
  cursor?: string;
  limit?: number;
}

export interface TicketTraceListPageV0
  extends TicketReviewProjectionHeaderV0 {
  subject: TicketReviewSubjectRefV0;
  records: TicketReviewTraceRecordV0[];
  page: TicketReviewPageV0;
  nextCursor: string | null;
}
