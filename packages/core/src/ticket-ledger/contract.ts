import { z } from "zod";

export const TICKET_LEDGER_SCHEMA_VERSION = 1 as const;
export const TICKET_LEDGER_FORMAT = "vibehub.ticket-ledger" as const;
export const TICKET_LEDGER_RELATIVE_PATH = ".vibehub/tickets" as const;

export const TICKET_LEDGER_PROTOCOL_MAX_BYTES = 16 * 1024;
export const TICKET_LEDGER_TICKET_MAX_BYTES = 256 * 1024;
export const TICKET_LEDGER_REVIEW_MAX_BYTES = 384 * 1024;
export const TICKET_LEDGER_DECISION_MAX_BYTES = 64 * 1024;
export const TICKET_LEDGER_ATTESTATION_MAX_BYTES = 128 * 1024;
export const TICKET_LEDGER_MAX_BYTES = 8 * 1024 * 1024;
export const TICKET_LEDGER_MAX_TICKETS = 1_000;
export const TICKET_LEDGER_MAX_REVIEWS = 5_000;
export const TICKET_LEDGER_MAX_DECISIONS = 2_000;
export const TICKET_LEDGER_MAX_ATTESTATIONS = 2_000;
export const TICKET_LEDGER_MAX_RELATIONS = 5_000;
export const TICKET_LEDGER_MAX_PATCH_CHANGES = 1_000;
export const TICKET_LEDGER_MAX_DIRTY_PATHS = 128;
export const TICKET_LEDGER_STABLE_READ_ATTEMPTS = 3;

const identifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
    "must be a readable lowercase path-safe identifier",
  );

const boundedText = (max: number) =>
  z
    .string()
    .check(z.custom<string>(
      (value) =>
        typeof value === "string"
        && [...value].length <= max,
      { message: `must contain at most ${max} Unicode characters` },
    ))
    .meta({ maxLength: max })
    .regex(/^(?=[\s\S]*\S)[\s\S]*$/u, "must not be blank");

const sha256DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40,64}$/u);
const relationRefSchema = z.string().regex(/^trl-[0-9a-f]{64}$/u);
const reviewIdSchema = z.string().regex(/^trv-[0-9a-f]{64}$/u);
const decisionIdSchema = z.string().regex(/^tdc-[0-9a-f]{64}$/u);
const attestationIdSchema = z.string().regex(/^tda-[0-9a-f]{64}$/u);
const instantSchema = z.iso.datetime({ offset: true }).refine(
  (value) => Number.isFinite(Date.parse(value)),
  { message: "must be a representable ISO datetime" },
).refine(
  (value) => {
    const fraction = value.match(/\.(\d+)/u);
    return fraction === null || fraction[1]!.length <= 3;
  },
  { message: "must use no more than millisecond precision" },
);

export const ticketLedgerProtocolSchema = z
  .object({
    schema_version: z.literal(TICKET_LEDGER_SCHEMA_VERSION),
    kind: z.literal("ticket_protocol"),
    format: z.literal(TICKET_LEDGER_FORMAT),
  })
  .strict();

export const ticketAcceptanceSchema = z
  .object({
    acceptance_id: identifierSchema,
    criterion: boundedText(8_192),
  })
  .strict();

export const ticketContextRefSchema = z
  .object({
    ref: boundedText(4_096),
    purpose: boundedText(4_096),
  })
  .strict();

export const ticketRelationSchema = z
  .object({
    type: z.literal("depends_on"),
    target_ticket_id: identifierSchema,
    rationale: boundedText(4_096).optional(),
  })
  .strict();

export const ticketDocumentSchema = z
  .object({
    schema_version: z.literal(TICKET_LEDGER_SCHEMA_VERSION),
    kind: z.literal("ticket"),
    ticket_id: identifierSchema,
    outcome: boundedText(16_384),
    context: boundedText(65_536),
    acceptance: z.array(ticketAcceptanceSchema).max(128),
    constraints: z.array(boundedText(8_192)).max(128),
    context_refs: z.array(ticketContextRefSchema).max(128),
    relations: z.array(ticketRelationSchema).max(256),
    provenance_refs: z.array(boundedText(4_096)).max(128),
  })
  .strict();

export const ticketReviewSubjectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("graph"),
    graph_digest: sha256DigestSchema,
  }).strict(),
  z.object({
    kind: z.literal("ticket"),
    ticket_id: identifierSchema,
    ticket_revision: sha256DigestSchema,
  }).strict(),
  z.object({
    kind: z.literal("relation"),
    relation_ref: relationRefSchema,
    prerequisite_ticket_id: identifierSchema,
    dependent_ticket_id: identifierSchema,
    dependent_ticket_revision: sha256DigestSchema,
  }).strict(),
]);

const ticketReviewObservedSchema = z.object({
  resolved_commit: gitCommitSchema,
  graph_digest: sha256DigestSchema,
}).strict();

const ticketReviewAuthorSchema = z.object({
  actor_id: boundedText(512),
  actor_kind: z.enum(["human", "agent"]),
  attribution: z.enum(["claimed", "host_attested"]),
}).strict();

const ticketReviewCommonShape = {
  schema_version: z.literal(TICKET_LEDGER_SCHEMA_VERSION),
  kind: z.literal("ticket_review"),
  review_id: reviewIdSchema,
  subject: ticketReviewSubjectSchema,
  observed: ticketReviewObservedSchema,
  author: ticketReviewAuthorSchema,
  body: boundedText(20_000),
  occurred_at: instantSchema,
} satisfies z.ZodRawShape;

export const ticketReviewDocumentSchema = z.discriminatedUnion("review_type", [
  z.object({
    ...ticketReviewCommonShape,
    review_type: z.literal("comment"),
  }).strict(),
  z.object({
    ...ticketReviewCommonShape,
    review_type: z.literal("ticket_edit"),
    expected_ticket_revision: sha256DigestSchema,
    replacement_ticket: ticketDocumentSchema,
    rationale: boundedText(20_000),
  }).strict(),
]).superRefine((value, context) => {
  if (
    value.subject.kind === "graph"
    && value.subject.graph_digest !== value.observed.graph_digest
  ) {
    context.addIssue({
      code: "custom",
      path: ["subject", "graph_digest"],
      message: "must equal observed.graph_digest",
    });
  }
  if (value.review_type !== "ticket_edit") return;
  if (value.subject.kind !== "ticket") {
    context.addIssue({
      code: "custom",
      path: ["subject", "kind"],
      message: "ticket_edit must bind an exact Ticket subject",
    });
    return;
  }
  if (value.expected_ticket_revision !== value.subject.ticket_revision) {
    context.addIssue({
      code: "custom",
      path: ["expected_ticket_revision"],
      message: "must equal subject.ticket_revision",
    });
  }
  if (value.replacement_ticket.ticket_id !== value.subject.ticket_id) {
    context.addIssue({
      code: "custom",
      path: ["replacement_ticket", "ticket_id"],
      message: "must equal subject.ticket_id",
    });
  }
});

const ticketDecisionAuthoritySchema = z.object({
  principal_id: boundedText(512),
  principal_kind: z.literal("human"),
  basis: z.enum(["repository_owner", "designated_human"]),
  basis_ref: boundedText(2_048),
  attestation: z.literal("host_bound_local"),
}).strict();

const ticketDecisionCommonShape = {
  schema_version: z.literal(TICKET_LEDGER_SCHEMA_VERSION),
  kind: z.literal("ticket_decision"),
  decision_id: decisionIdSchema,
  rationale: boundedText(20_000),
  resolution_refs: z.array(boundedText(4_096)).max(128),
  authority: ticketDecisionAuthoritySchema,
  decided_at: instantSchema,
} satisfies z.ZodRawShape;

export const ticketDecisionDocumentSchema = z.discriminatedUnion(
  "decision_type",
  [
    z.object({
      ...ticketDecisionCommonShape,
      decision_type: z.literal("plan_review"),
      subject: ticketReviewSubjectSchema.options[0],
      disposition: z.enum([
        "approve_execution",
        "delegate_within_boundaries",
        "request_changes",
      ]),
      delegated_boundaries: z.array(boundedText(8_192)).max(128).optional(),
    }).strict(),
    z.object({
      ...ticketDecisionCommonShape,
      decision_type: z.literal("protected_boundary"),
      subject: ticketReviewSubjectSchema.options[1],
      boundary: boundedText(20_000),
      disposition: z.enum(["resolve", "decline"]),
      selection: boundedText(20_000).optional(),
    }).strict(),
  ],
).superRefine((value, context) => {
  if (value.decision_type === "plan_review") {
    const boundaries = value.delegated_boundaries;
    if (
      value.disposition === "delegate_within_boundaries"
      && (boundaries === undefined || boundaries.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["delegated_boundaries"],
        message: "must be non-empty for delegated execution",
      });
    }
    if (
      value.disposition !== "delegate_within_boundaries"
      && boundaries !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["delegated_boundaries"],
        message: "is only allowed for delegated execution",
      });
    }
    return;
  }
  if (value.disposition === "resolve" && value.selection === undefined) {
    context.addIssue({
      code: "custom",
      path: ["selection"],
      message: "must be present for a resolved protected boundary",
    });
  }
  if (value.disposition === "decline" && value.selection !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["selection"],
      message: "is not allowed for a declined protected boundary",
    });
  }
});

const base64UrlSchema = (
  maximumCharacters: number,
  minimumBytes = 1,
) => z.string()
  .min(1)
  .max(maximumCharacters)
  .regex(
    /^[A-Za-z0-9_-]+$/u,
    "must be unpadded base64url",
  )
  .refine((value) => {
    try {
      const bytes = Buffer.from(value, "base64url");
      return bytes.byteLength >= minimumBytes
        && bytes.toString("base64url") === value;
    } catch {
      return false;
    }
  }, {
    message:
      `must be canonical base64url encoding at least ${minimumBytes} bytes`,
  });

const ticketDecisionAttestationAuthoritySchema = z.object({
  principal_id: boundedText(512),
  principal_kind: z.literal("human"),
  basis: z.enum(["repository_owner", "designated_human"]),
  basis_ref: boundedText(2_048),
}).strict();

const ticketDecisionAttestationCheckoutSchema = z.object({
  mode: z.literal("branch"),
  branch: boundedText(1_024),
}).strict();

const ticketDecisionAttestationScopeSchema = z.discriminatedUnion(
  "scope_type",
  [
    z.object({
      scope_type: z.literal("plan_review"),
      graph_digest: sha256DigestSchema,
      disposition: z.enum([
        "approve_execution",
        "delegate_within_boundaries",
        "request_changes",
      ]),
      delegated_boundaries: z.array(boundedText(8_192)).max(128).optional(),
    }).strict(),
    z.object({
      scope_type: z.literal("protected_boundary"),
      ticket_id: identifierSchema,
      ticket_revision: sha256DigestSchema,
      boundary: boundedText(20_000),
      disposition: z.enum(["resolve", "decline"]),
      selection: boundedText(20_000).optional(),
    }).strict(),
  ],
).superRefine((value, context) => {
  if (value.scope_type === "plan_review") {
    const boundaries = value.delegated_boundaries;
    if (
      value.disposition === "delegate_within_boundaries"
      && (boundaries === undefined || boundaries.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["delegated_boundaries"],
        message: "must be non-empty for delegated execution",
      });
    }
    if (
      value.disposition !== "delegate_within_boundaries"
      && boundaries !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["delegated_boundaries"],
        message: "is only allowed for delegated execution",
      });
    }
    return;
  }
  if (value.disposition === "resolve" && value.selection === undefined) {
    context.addIssue({
      code: "custom",
      path: ["selection"],
      message: "must be present for a resolved protected boundary",
    });
  }
  if (value.disposition === "decline" && value.selection !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["selection"],
      message: "is not allowed for a declined protected boundary",
    });
  }
});

const ticketDecisionAttestationDecisionSchema = z.object({
  decision_id: decisionIdSchema,
  document_path: boundedText(4_096),
  document_digest: sha256DigestSchema,
}).strict();

const ticketDecisionAttestationRepositorySchema = z.object({
  repository_incarnation: z.string().regex(/^repo-[0-9a-f]{64}$/u),
  repository_root: boundedText(4_096),
  worktree_identity: z.string().regex(/^worktree-[0-9a-f]{64}$/u),
  worktree_root: boundedText(4_096),
  checkout: ticketDecisionAttestationCheckoutSchema,
}).strict();

const ticketDecisionAttestationSignerSchema = z.object({
  key_id: z.string().regex(/^tdk-[0-9a-f]{64}$/u),
  key_fingerprint: sha256DigestSchema,
  algorithm: z.literal("Ed25519"),
}).strict().superRefine((value, context) => {
  if (value.key_id !== `tdk-${value.key_fingerprint}`) {
    context.addIssue({
      code: "custom",
      path: ["key_id"],
      message: "must be derived from key_fingerprint",
    });
  }
});

const ticketDecisionAttestationConfirmationSchema = z.object({
  method: z.literal("plugin_host_click"),
}).strict();

const ticketDecisionAttestationEnvelopeShape = {
  schema_version: z.literal(TICKET_LEDGER_SCHEMA_VERSION),
  kind: z.literal("ticket_decision_attestation"),
  decision: ticketDecisionAttestationDecisionSchema,
  authority: ticketDecisionAttestationAuthoritySchema,
  repository: ticketDecisionAttestationRepositorySchema,
  scope: ticketDecisionAttestationScopeSchema,
  signer: ticketDecisionAttestationSignerSchema,
  confirmation: ticketDecisionAttestationConfirmationSchema,
  nonce: base64UrlSchema(128, 16),
  issued_at: instantSchema,
} satisfies z.ZodRawShape;

export const ticketDecisionAttestationEnvelopeSchema = z.object(
  ticketDecisionAttestationEnvelopeShape,
).strict();

export const ticketDecisionAttestationDocumentPayloadSchema = z.object({
  ...ticketDecisionAttestationEnvelopeShape,
  signature: base64UrlSchema(256, 64).refine(
    (value) => Buffer.from(value, "base64url").byteLength === 64,
    { message: "must encode one Ed25519 signature" },
  ),
}).strict();

export const ticketDecisionAttestationDocumentSchema =
  ticketDecisionAttestationDocumentPayloadSchema.safeExtend({
    attestation_id: attestationIdSchema,
  });

export type TicketLedgerProtocol = z.infer<typeof ticketLedgerProtocolSchema>;
export type TicketAcceptance = z.infer<typeof ticketAcceptanceSchema>;
export type TicketContextRef = z.infer<typeof ticketContextRefSchema>;
export type TicketRelation = z.infer<typeof ticketRelationSchema>;
export type TicketDocument = z.infer<typeof ticketDocumentSchema>;
export type TicketReviewSubject = z.infer<typeof ticketReviewSubjectSchema>;
export type TicketReviewDocument = z.infer<typeof ticketReviewDocumentSchema>;
export type TicketDecisionDocument = z.infer<typeof ticketDecisionDocumentSchema>;
export type TicketDecisionAttestationDocumentPayload = z.infer<
  typeof ticketDecisionAttestationDocumentPayloadSchema
>;
export type TicketDecisionAttestationDocument = z.infer<
  typeof ticketDecisionAttestationDocumentSchema
>;
export type TicketDecisionAttestationScope =
  TicketDecisionAttestationDocument["scope"];
export type TicketDecisionAttestationEnvelope =
  Omit<TicketDecisionAttestationDocumentPayload, "signature">;
type WithoutField<T, Field extends PropertyKey> =
  T extends unknown ? Omit<T, Field> : never;
export type TicketReviewDocumentPayload =
  WithoutField<TicketReviewDocument, "review_id">;
export type TicketDecisionDocumentPayload =
  WithoutField<TicketDecisionDocument, "decision_id">;

export interface TicketLedgerDocumentCandidate {
  documentPath: string;
  document: unknown;
}

export interface TicketLedgerCandidate {
  protocol: unknown;
  tickets: readonly TicketLedgerDocumentCandidate[];
  reviews?: readonly TicketLedgerDocumentCandidate[];
  decisions?: readonly TicketLedgerDocumentCandidate[];
  attestations?: readonly TicketLedgerDocumentCandidate[];
}

export interface TicketLedgerTicket {
  documentPath: string;
  ticketRevision: string;
  document: TicketDocument;
}

export interface TicketLedgerReview {
  documentPath: string;
  document: TicketReviewDocument;
}

export interface TicketLedgerDecision {
  documentPath: string;
  document: TicketDecisionDocument;
}

export interface TicketLedgerDecisionAttestation {
  documentPath: string;
  document: TicketDecisionAttestationDocument;
}

export interface TicketLedgerContent {
  protocol: TicketLedgerProtocol;
  tickets: readonly TicketLedgerTicket[];
  reviews: readonly TicketLedgerReview[];
  decisions: readonly TicketLedgerDecision[];
  attestations: readonly TicketLedgerDecisionAttestation[];
  graphDigest: string;
  semanticLedgerDigest: string;
}

interface TicketLedgerSourceBase {
  repositoryRoot: string;
  repositoryIncarnation: string;
  resolvedCommit: string;
  graphDigest: string;
  semanticLedgerDigest: string;
  sourceToken: string;
  checkpointInventoryDigest: string;
}

export interface TicketLedgerWorktreeSource extends TicketLedgerSourceBase {
  mode: "worktree";
  worktreeIdentity: string;
  worktreeRoot: string;
  branch: string | null;
  committedGraphDigest: string | null;
  committedSemanticLedgerDigest: string | null;
  semanticDirty: boolean;
  dirtyPaths: readonly string[];
  dirtyPathsTruncated: boolean;
}

export interface TicketLedgerRefSource extends TicketLedgerSourceBase {
  mode: "ref";
  requestedRef: string;
}

export type TicketLedgerSource =
  | TicketLedgerWorktreeSource
  | TicketLedgerRefSource;

export interface TicketLedgerSnapshot extends TicketLedgerContent {
  source: TicketLedgerSource;
}

export interface TicketLedgerPatchExpectedSource {
  sourceToken: string;
  worktreeIdentity: string;
  resolvedCommit: string;
  graphDigest: string;
  semanticLedgerDigest: string;
}

export type TicketLedgerPatchChange =
  | {
      op: "put";
      ticketId: string;
      expectedTicketRevision: string | null;
      document: unknown;
    }
  | {
      op: "delete";
      ticketId: string;
      expectedTicketRevision: string;
    };

export interface TicketLedgerPatchRequest {
  expectedSource: TicketLedgerPatchExpectedSource;
  changes: readonly TicketLedgerPatchChange[];
}

export interface TicketLedgerPatchSource {
  sourceToken: string;
  worktreeIdentity: string;
  resolvedCommit: string;
  graphDigest: string;
  semanticLedgerDigest: string;
}

export interface TicketLedgerPatchTicketResult {
  op: "put" | "delete";
  ticketId: string;
  documentPath: string;
  beforeTicketRevision: string | null;
  afterTicketRevision: string | null;
  changed: boolean;
}

export interface TicketLedgerCheckpointSelection {
  source: TicketLedgerPatchSource;
  changedPaths: readonly string[];
}

export interface TicketLedgerPatchResult {
  status: "applied" | "noop";
  before: TicketLedgerPatchSource;
  after: TicketLedgerPatchSource;
  changedPaths: readonly string[];
  tickets: readonly TicketLedgerPatchTicketResult[];
  checkpointSelection: TicketLedgerCheckpointSelection;
}

export type TicketLedgerErrorCode =
  | "ledger_missing"
  | "invalid_path"
  | "invalid_document"
  | "invalid_graph"
  | "file_too_large"
  | "ledger_too_large"
  | "unsupported_file"
  | "symlink"
  | "unmerged"
  | "source_changed_during_read"
  | "stale_source"
  | "stale_subject"
  | "stale_ticket_revision"
  | "document_conflict"
  | "duplicate_change"
  | "writer_busy"
  | "write_verification_failed"
  | "ref_not_found"
  | "git_error"
  | "io";

export class TicketLedgerError extends Error {
  constructor(
    readonly code: TicketLedgerErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TicketLedgerError";
  }
}
