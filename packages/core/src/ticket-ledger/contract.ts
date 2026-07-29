import { z } from "zod";

export const TICKET_LEDGER_SCHEMA_VERSION = 1 as const;
export const TICKET_LEDGER_FORMAT = "vibehub.ticket-ledger" as const;
export const TICKET_LEDGER_RELATIVE_PATH = ".vibehub/tickets" as const;

export const TICKET_LEDGER_PROTOCOL_MAX_BYTES = 16 * 1024;
export const TICKET_LEDGER_TICKET_MAX_BYTES = 256 * 1024;
export const TICKET_LEDGER_MAX_BYTES = 8 * 1024 * 1024;
export const TICKET_LEDGER_MAX_TICKETS = 1_000;
export const TICKET_LEDGER_MAX_RELATIONS = 5_000;
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
    .max(max)
    .refine((value) => value.trim().length > 0, "must not be blank");

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

export type TicketLedgerProtocol = z.infer<typeof ticketLedgerProtocolSchema>;
export type TicketAcceptance = z.infer<typeof ticketAcceptanceSchema>;
export type TicketContextRef = z.infer<typeof ticketContextRefSchema>;
export type TicketRelation = z.infer<typeof ticketRelationSchema>;
export type TicketDocument = z.infer<typeof ticketDocumentSchema>;

export interface TicketLedgerDocumentCandidate {
  documentPath: string;
  document: unknown;
}

export interface TicketLedgerCandidate {
  protocol: unknown;
  tickets: readonly TicketLedgerDocumentCandidate[];
}

export interface TicketLedgerTicket {
  documentPath: string;
  ticketRevision: string;
  document: TicketDocument;
}

export interface TicketLedgerContent {
  protocol: TicketLedgerProtocol;
  tickets: readonly TicketLedgerTicket[];
  graphDigest: string;
}

interface TicketLedgerSourceBase {
  repositoryRoot: string;
  repositoryIncarnation: string;
  resolvedCommit: string;
  graphDigest: string;
  sourceToken: string;
}

export interface TicketLedgerWorktreeSource extends TicketLedgerSourceBase {
  mode: "worktree";
  worktreeIdentity: string;
  worktreeRoot: string;
  branch: string | null;
  committedGraphDigest: string | null;
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
