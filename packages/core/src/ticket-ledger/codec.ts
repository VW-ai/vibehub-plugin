import crypto from "node:crypto";
import path from "node:path";
import {
  isScalar,
  parseAllDocuments,
  stringify,
  visit,
  type Document,
  type ParsedNode,
} from "yaml";
import {
  TICKET_LEDGER_FORMAT,
  TICKET_LEDGER_MAX_BYTES,
  TICKET_LEDGER_MAX_ATTESTATIONS,
  TICKET_LEDGER_MAX_DECISIONS,
  TICKET_LEDGER_MAX_RELATIONS,
  TICKET_LEDGER_MAX_REVIEWS,
  TICKET_LEDGER_MAX_TICKETS,
  TICKET_LEDGER_DECISION_MAX_BYTES,
  TICKET_LEDGER_ATTESTATION_MAX_BYTES,
  TICKET_LEDGER_PROTOCOL_MAX_BYTES,
  TICKET_LEDGER_RELATIVE_PATH,
  TICKET_LEDGER_REVIEW_MAX_BYTES,
  TICKET_LEDGER_SCHEMA_VERSION,
  TICKET_LEDGER_TICKET_MAX_BYTES,
  TicketLedgerError,
  ticketDecisionDocumentSchema,
  ticketDecisionAttestationDocumentPayloadSchema,
  ticketDecisionAttestationDocumentSchema,
  ticketDecisionAttestationEnvelopeSchema,
  ticketDocumentSchema,
  ticketLedgerProtocolSchema,
  ticketReviewDocumentSchema,
  type TicketAcceptance,
  type TicketContextRef,
  type TicketDecisionDocument,
  type TicketDecisionDocumentPayload,
  type TicketDecisionAttestationDocument,
  type TicketDecisionAttestationDocumentPayload,
  type TicketDecisionAttestationEnvelope,
  type TicketDocument,
  type TicketLedgerCandidate,
  type TicketLedgerContent,
  type TicketLedgerDecision,
  type TicketLedgerDecisionAttestation,
  type TicketLedgerProtocol,
  type TicketLedgerReview,
  type TicketLedgerTicket,
  type TicketRelation,
  type TicketReviewDocument,
  type TicketReviewDocumentPayload,
  type TicketReviewSubject,
} from "./contract.js";

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export interface TicketLedgerFile {
  documentPath: string;
  bytes: Buffer;
}

export interface TicketLedgerPhysicalFile extends TicketLedgerFile {
  mode: number | string;
}

const sha256 = (value: string | Buffer): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const canonicalize = (value: unknown): Json => {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TicketLedgerError(
        "invalid_document",
        "Ticket ledger documents cannot contain non-finite numbers",
      );
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) =>
          Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  throw new TicketLedgerError(
    "invalid_document",
    `Ticket ledger documents cannot contain ${typeof value} values`,
  );
};

export const canonicalTicketLedgerValue = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const compareText = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const YAML_CORE_TAGS = new Set([
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:map",
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:seq",
  "tag:yaml.org,2002:str",
]);

const normalizeText = (value: string): string =>
  value.replace(/\r\n?/gu, "\n").trim();

const uniqueBy = <T>(
  values: readonly T[],
  identity: (value: T) => string,
  label: string,
): void => {
  const seen = new Set<string>();
  for (const value of values) {
    const key = identity(value);
    if (seen.has(key)) {
      throw new TicketLedgerError(
        "invalid_document",
        `${label} contains duplicate identity ${key}`,
        { identity: key },
      );
    }
    seen.add(key);
  }
};

const normalizeAcceptance = (
  values: readonly TicketAcceptance[],
): TicketAcceptance[] => {
  const normalized = values.map((value) => ({
    acceptance_id: value.acceptance_id,
    criterion: normalizeText(value.criterion),
  }));
  uniqueBy(normalized, (value) => value.acceptance_id, "acceptance");
  return normalized.sort((left, right) =>
    compareText(left.acceptance_id, right.acceptance_id));
};

const normalizeContextRefs = (
  values: readonly TicketContextRef[],
): TicketContextRef[] => {
  const normalized = values.map((value) => ({
    ref: normalizeText(value.ref),
    purpose: normalizeText(value.purpose),
  }));
  uniqueBy(normalized, (value) => value.ref, "context_refs");
  return normalized.sort((left, right) => compareText(left.ref, right.ref));
};

const relationIdentityKey = (
  subjectTicketId: string,
  relation: Pick<TicketRelation, "type" | "target_ticket_id">,
): string =>
  `${subjectTicketId}\0${relation.type}\0${relation.target_ticket_id}`;

const normalizeRelations = (
  subjectTicketId: string,
  values: readonly TicketRelation[],
): TicketRelation[] => {
  const normalized = values.map((value) => ({
    type: value.type,
    target_ticket_id: value.target_ticket_id,
    ...(value.rationale === undefined
      ? {}
      : { rationale: normalizeText(value.rationale) }),
  }));
  uniqueBy(
    normalized,
    (value) => relationIdentityKey(subjectTicketId, value),
    "relations",
  );
  return normalized.sort((left, right) =>
    compareText(
      relationIdentityKey(subjectTicketId, left),
      relationIdentityKey(subjectTicketId, right),
    ));
};

const normalizeProvenanceRefs = (values: readonly string[]): string[] => {
  const normalized = values.map(normalizeText);
  uniqueBy(normalized, (value) => value, "provenance_refs");
  return normalized.sort(compareText);
};

const normalizeUniqueText = (
  values: readonly string[],
  label: string,
): string[] => {
  const normalized = values.map(normalizeText);
  uniqueBy(normalized, (value) => value, label);
  return normalized.sort(compareText);
};

const normalizeInstant = (value: string): string =>
  new Date(value).toISOString();

const formatZodIssues = (
  issues: readonly { path: PropertyKey[]; message: string }[],
): string =>
  issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");

export const normalizeTicketDocument = (
  candidate: unknown,
  label = "Ticket document",
): TicketDocument => {
  const parsed = ticketDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label} is invalid: ${formatZodIssues(parsed.error.issues)}`,
      { label },
    );
  }
  const value = parsed.data;
  return {
    schema_version: TICKET_LEDGER_SCHEMA_VERSION,
    kind: "ticket",
    ticket_id: value.ticket_id,
    outcome: normalizeText(value.outcome),
    context: normalizeText(value.context),
    acceptance: normalizeAcceptance(value.acceptance),
    constraints: value.constraints.map(normalizeText),
    context_refs: normalizeContextRefs(value.context_refs),
    relations: normalizeRelations(value.ticket_id, value.relations),
    provenance_refs: normalizeProvenanceRefs(value.provenance_refs),
  };
};

export const normalizeTicketLedgerProtocol = (
  candidate: unknown,
): TicketLedgerProtocol => {
  const parsed = ticketLedgerProtocolSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      `Ticket ledger protocol is invalid: ${formatZodIssues(parsed.error.issues)}`,
      { label: "protocol.yaml" },
    );
  }
  return parsed.data;
};

const normalizeReviewSubject = (
  subject: TicketReviewSubject,
): TicketReviewSubject => {
  if (subject.kind === "graph") return { ...subject };
  if (subject.kind === "ticket") return { ...subject };
  if (subject.prerequisite_ticket_id === subject.dependent_ticket_id) {
    throw new TicketLedgerError(
      "invalid_document",
      "A review relation subject cannot connect a Ticket to itself",
      { ticketId: subject.dependent_ticket_id },
    );
  }
  const expectedRelationRef = ticketRelationId(
    subject.dependent_ticket_id,
    {
      type: "depends_on",
      target_ticket_id: subject.prerequisite_ticket_id,
    },
  );
  if (subject.relation_ref !== expectedRelationRef) {
    throw new TicketLedgerError(
      "invalid_document",
      "Review relation_ref does not match its direct dependency endpoints",
      {
        relationRef: subject.relation_ref,
        expectedRelationRef,
      },
    );
  }
  return { ...subject };
};

export const ticketReviewSubjectDigest = (
  subject: TicketReviewSubject,
): string =>
  sha256(canonicalTicketLedgerValue(normalizeReviewSubject(subject)));

const reviewIdentity = (
  document: TicketReviewDocumentPayload,
): string =>
  `trv-${sha256(canonicalTicketLedgerValue(document))}`;

const normalizeReviewPayload = (
  value: TicketReviewDocument,
  label: string,
): TicketReviewDocumentPayload => {
  const common = {
    schema_version: TICKET_LEDGER_SCHEMA_VERSION,
    kind: "ticket_review" as const,
    subject: normalizeReviewSubject(value.subject),
    observed: { ...value.observed },
    author: {
      actor_id: normalizeText(value.author.actor_id),
      actor_kind: value.author.actor_kind,
      attribution: value.author.attribution,
    },
    body: normalizeText(value.body),
    occurred_at: normalizeInstant(value.occurred_at),
  };
  return (
    value.review_type === "comment"
      ? {
          ...common,
          review_type: "comment",
        }
      : {
          ...common,
          review_type: "ticket_edit",
          expected_ticket_revision: value.expected_ticket_revision,
          replacement_ticket: normalizeTicketDocument(
            value.replacement_ticket,
            `${label}.replacement_ticket`,
          ),
          rationale: normalizeText(value.rationale),
        }
  ) as TicketReviewDocumentPayload;
};

const parseReviewCandidate = (
  candidate: unknown,
  label: string,
): TicketReviewDocument => {
  const parsed = ticketReviewDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label} is invalid: ${formatZodIssues(parsed.error.issues)}`,
      { label },
    );
  }
  return parsed.data;
};

export const createTicketReviewDocument = (
  candidate: TicketReviewDocumentPayload,
  label = "Ticket review payload",
): TicketReviewDocument => {
  const value = parseReviewCandidate({
    ...candidate,
    review_id: `trv-${"0".repeat(64)}`,
  }, label);
  const withoutId = normalizeReviewPayload(value, label);
  const expectedReviewId = reviewIdentity(withoutId);
  return {
    ...withoutId,
    review_id: expectedReviewId,
  } as TicketReviewDocument;
};

export const normalizeTicketReviewDocument = (
  candidate: unknown,
  label = "Ticket review document",
): TicketReviewDocument => {
  const value = parseReviewCandidate(candidate, label);
  const normalized = createTicketReviewDocument(
    Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "review_id"),
    ) as TicketReviewDocumentPayload,
    label,
  );
  const expectedReviewId = normalized.review_id;
  if (value.review_id !== expectedReviewId) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label} review_id does not match its normalized content`,
      {
        label,
        reviewId: value.review_id,
        expectedReviewId,
      },
    );
  }
  return normalized;
};

const decisionIdentityValue = (
  document: Pick<
    TicketDecisionDocument,
    "schema_version" | "kind" | "decision_type" | "subject"
  > & { boundary?: string },
): Record<string, unknown> => ({
  schema_version: document.schema_version,
  kind: document.kind,
  decision_type: document.decision_type,
  subject: document.subject,
  ...(document.decision_type === "protected_boundary"
    ? { boundary: document.boundary }
    : {}),
});

export const ticketDecisionSubjectDigest = (
  document: Pick<
    TicketDecisionDocument,
    "schema_version" | "kind" | "decision_type" | "subject"
  > & { boundary?: string },
): string =>
  sha256(canonicalTicketLedgerValue(decisionIdentityValue(document)));

const normalizeDecisionPayload = (
  value: TicketDecisionDocument,
): TicketDecisionDocumentPayload => {
  const common = {
    schema_version: TICKET_LEDGER_SCHEMA_VERSION,
    kind: "ticket_decision" as const,
    subject: normalizeReviewSubject(value.subject),
    rationale: normalizeText(value.rationale),
    resolution_refs: normalizeUniqueText(
      value.resolution_refs,
      "resolution_refs",
    ),
    authority: {
      principal_id: normalizeText(value.authority.principal_id),
      principal_kind: "human" as const,
      basis: value.authority.basis,
      basis_ref: normalizeText(value.authority.basis_ref),
      attestation: "host_bound_local" as const,
    },
    decided_at: normalizeInstant(value.decided_at),
  };
  return (
    value.decision_type === "plan_review"
      ? {
          ...common,
          decision_type: "plan_review",
          subject: value.subject,
          disposition: value.disposition,
          ...(value.delegated_boundaries === undefined
            ? {}
            : {
                delegated_boundaries: normalizeUniqueText(
                  value.delegated_boundaries,
                  "delegated_boundaries",
                ),
              }),
        }
      : {
          ...common,
          decision_type: "protected_boundary",
          subject: value.subject,
          boundary: normalizeText(value.boundary),
          disposition: value.disposition,
          ...(value.selection === undefined
            ? {}
            : { selection: normalizeText(value.selection) }),
        }
  ) as TicketDecisionDocumentPayload;
};

const parseDecisionCandidate = (
  candidate: unknown,
  label: string,
): TicketDecisionDocument => {
  const parsed = ticketDecisionDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label} is invalid: ${formatZodIssues(parsed.error.issues)}`,
      { label },
    );
  }
  return parsed.data;
};

export const createTicketDecisionDocument = (
  candidate: TicketDecisionDocumentPayload,
  label = "Ticket decision payload",
): TicketDecisionDocument => {
  const value = parseDecisionCandidate({
    ...candidate,
    decision_id: `tdc-${"0".repeat(64)}`,
  }, label);
  const withoutId = normalizeDecisionPayload(value);
  const expectedDecisionId =
    `tdc-${ticketDecisionSubjectDigest(withoutId)}`;
  return {
    ...withoutId,
    decision_id: expectedDecisionId,
  } as TicketDecisionDocument;
};

export const normalizeTicketDecisionDocument = (
  candidate: unknown,
  label = "Ticket decision document",
): TicketDecisionDocument => {
  const value = parseDecisionCandidate(candidate, label);
  const normalized = createTicketDecisionDocument(
    Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "decision_id"),
    ) as TicketDecisionDocumentPayload,
    label,
  );
  const expectedDecisionId = normalized.decision_id;
  if (value.decision_id !== expectedDecisionId) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label} decision_id does not match its exact subject`,
      {
        label,
        decisionId: value.decision_id,
        expectedDecisionId,
      },
    );
  }
  return normalized;
};

export const ticketDecisionDocumentDigest = (
  candidate: unknown,
): string =>
  sha256(canonicalTicketLedgerValue(
    normalizeTicketDecisionDocument(candidate),
  ));

const attestationEnvelopeCandidate = (
  candidate:
    | TicketDecisionAttestationEnvelope
    | TicketDecisionAttestationDocumentPayload
    | TicketDecisionAttestationDocument,
): unknown => ({
  schema_version: candidate.schema_version,
  kind: candidate.kind,
  decision: candidate.decision,
  authority: candidate.authority,
  repository: candidate.repository,
  scope: candidate.scope,
  credential: candidate.credential,
  webauthn: {
    rp_id: candidate.webauthn.rp_id,
    origin: candidate.webauthn.origin,
    algorithm: candidate.webauthn.algorithm,
  },
  nonce: candidate.nonce,
  issued_at: candidate.issued_at,
  not_before: candidate.not_before,
  expires_at: candidate.expires_at,
});

const parseAttestationEnvelope = (
  candidate: unknown,
  label: string,
): TicketDecisionAttestationEnvelope => {
  const parsed = ticketDecisionAttestationEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label} is invalid: ${formatZodIssues(parsed.error.issues)}`,
      { label },
    );
  }
  return parsed.data;
};

const normalizeAttestationEnvelope = (
  candidate:
    | TicketDecisionAttestationEnvelope
    | TicketDecisionAttestationDocumentPayload
    | TicketDecisionAttestationDocument,
  label: string,
): TicketDecisionAttestationEnvelope => {
  const value = parseAttestationEnvelope(
    attestationEnvelopeCandidate(candidate),
    label,
  );
  const scope = value.scope.scope_type === "plan_review"
    ? {
        scope_type: "plan_review" as const,
        graph_digest: value.scope.graph_digest,
        disposition: value.scope.disposition,
        ...(value.scope.delegated_boundaries === undefined
          ? {}
          : {
              delegated_boundaries: normalizeUniqueText(
                value.scope.delegated_boundaries,
                "delegated_boundaries",
              ),
            }),
      }
    : {
        scope_type: "protected_boundary" as const,
        ticket_id: value.scope.ticket_id,
        ticket_revision: value.scope.ticket_revision,
        boundary: normalizeText(value.scope.boundary),
        disposition: value.scope.disposition,
        ...(value.scope.selection === undefined
          ? {}
          : { selection: normalizeText(value.scope.selection) }),
      };
  return {
    schema_version: TICKET_LEDGER_SCHEMA_VERSION,
    kind: "ticket_decision_attestation",
    decision: {
      decision_id: value.decision.decision_id,
      document_path: normalizeText(value.decision.document_path),
      document_digest: value.decision.document_digest,
    },
    authority: {
      principal_id: normalizeText(value.authority.principal_id),
      principal_kind: "human",
      basis: value.authority.basis,
      basis_ref: normalizeText(value.authority.basis_ref),
    },
    repository: {
      repository_incarnation: value.repository.repository_incarnation,
      repository_root: normalizeText(value.repository.repository_root),
      worktree_identity: value.repository.worktree_identity,
      worktree_root: normalizeText(value.repository.worktree_root),
      checkout: value.repository.checkout.mode === "branch"
        ? {
            mode: "branch",
            branch: normalizeText(value.repository.checkout.branch),
          }
        : { ...value.repository.checkout },
    },
    scope,
    credential: { ...value.credential },
    webauthn: { ...value.webauthn },
    nonce: value.nonce,
    issued_at: normalizeInstant(value.issued_at),
    not_before: normalizeInstant(value.not_before),
    expires_at: normalizeInstant(value.expires_at),
  };
};

export const normalizeTicketDecisionAttestationEnvelope = (
  candidate:
    | TicketDecisionAttestationEnvelope
    | TicketDecisionAttestationDocumentPayload
    | TicketDecisionAttestationDocument,
  label = "Ticket decision attestation envelope",
): TicketDecisionAttestationEnvelope =>
  normalizeAttestationEnvelope(candidate, label);

export const ticketDecisionAttestationChallenge = (
  candidate:
    | TicketDecisionAttestationEnvelope
    | TicketDecisionAttestationDocumentPayload
    | TicketDecisionAttestationDocument,
): string => {
  const envelope = normalizeAttestationEnvelope(
    candidate,
    "Ticket decision attestation challenge envelope",
  );
  return Buffer.from(
    sha256(canonicalTicketLedgerValue(envelope)),
    "hex",
  ).toString("base64url");
};

const parseAttestationPayload = (
  candidate: unknown,
  label: string,
): TicketDecisionAttestationDocumentPayload => {
  const parsed =
    ticketDecisionAttestationDocumentPayloadSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label} is invalid: ${formatZodIssues(parsed.error.issues)}`,
      { label },
    );
  }
  return parsed.data;
};

const assertAttestationClientData = (
  payload: TicketDecisionAttestationDocumentPayload,
  label: string,
): void => {
  const bytes = Buffer.from(payload.webauthn.client_data_json, "base64url");
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label}.webauthn.client_data_json is not valid UTF-8`,
      { label },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label}.webauthn.client_data_json is not valid JSON`,
      { label },
      { cause },
    );
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label}.webauthn.client_data_json must decode to an object`,
      { label },
    );
  }
  const clientData = value as Record<string, unknown>;
  const expectedChallenge = ticketDecisionAttestationChallenge(payload);
  if (
    clientData.type !== "webauthn.get"
    || clientData.challenge !== expectedChallenge
    || clientData.origin !== payload.webauthn.origin
    || clientData.crossOrigin !== false
  ) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label}.webauthn.client_data_json does not bind the exact attestation envelope`,
      {
        label,
        expectedType: "webauthn.get",
        expectedChallenge,
        expectedOrigin: payload.webauthn.origin,
        expectedCrossOrigin: false,
      },
    );
  }
};

const normalizeAttestationPayload = (
  candidate: unknown,
  label: string,
): TicketDecisionAttestationDocumentPayload => {
  const value = parseAttestationPayload(candidate, label);
  const envelope = normalizeAttestationEnvelope(value, label);
  const normalized: TicketDecisionAttestationDocumentPayload = {
    ...envelope,
    webauthn: {
      ...envelope.webauthn,
      client_data_json: value.webauthn.client_data_json,
      authenticator_data: value.webauthn.authenticator_data,
      signature: value.webauthn.signature,
    },
  };
  assertAttestationClientData(normalized, label);
  return normalized;
};

const attestationIdentity = (
  document: TicketDecisionAttestationDocumentPayload,
): string =>
  `tda-${sha256(canonicalTicketLedgerValue(document))}`;

export const createTicketDecisionAttestationDocument = (
  candidate: TicketDecisionAttestationDocumentPayload,
  label = "Ticket decision attestation payload",
): TicketDecisionAttestationDocument => {
  const payload = normalizeAttestationPayload(candidate, label);
  return {
    ...payload,
    attestation_id: attestationIdentity(payload),
  };
};

export const normalizeTicketDecisionAttestationDocument = (
  candidate: unknown,
  label = "Ticket decision attestation document",
): TicketDecisionAttestationDocument => {
  const parsed = ticketDecisionAttestationDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label} is invalid: ${formatZodIssues(parsed.error.issues)}`,
      { label },
    );
  }
  const { attestation_id: _attestationId, ...payload } = parsed.data;
  const normalized = createTicketDecisionAttestationDocument(payload, label);
  if (parsed.data.attestation_id !== normalized.attestation_id) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label} attestation_id does not match its normalized content`,
      {
        label,
        attestationId: parsed.data.attestation_id,
        expectedAttestationId: normalized.attestation_id,
      },
    );
  }
  return normalized;
};

export const ticketDocumentPath = (ticketId: string): string => {
  const parsed = ticketDocumentSchema.shape.ticket_id.safeParse(ticketId);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_path",
      `Invalid Ticket ID for document path: ${ticketId}`,
      { ticketId },
    );
  }
  return `${TICKET_LEDGER_RELATIVE_PATH}/tickets/${ticketId}.yaml`;
};

export const ticketReviewDocumentPath = (
  subject: TicketReviewSubject,
  reviewId: string,
): string => {
  if (!/^trv-[0-9a-f]{64}$/u.test(reviewId)) {
    throw new TicketLedgerError(
      "invalid_path",
      `Invalid review ID for document path: ${reviewId}`,
      { reviewId },
    );
  }
  return `${TICKET_LEDGER_RELATIVE_PATH}/reviews/${
    ticketReviewSubjectDigest(subject)
  }/${reviewId}.yaml`;
};

export const ticketDecisionDocumentPath = (
  document: TicketDecisionDocument,
): string =>
  `${TICKET_LEDGER_RELATIVE_PATH}/decisions/${
    ticketDecisionSubjectDigest(document)
  }.yaml`;

export const ticketDecisionAttestationDocumentPath = (
  document: Pick<
    TicketDecisionAttestationDocument,
    "attestation_id" | "decision"
  >,
): string => {
  const decisionId = document.decision.decision_id;
  const attestationId = document.attestation_id;
  if (!/^tdc-[0-9a-f]{64}$/u.test(decisionId)) {
    throw new TicketLedgerError(
      "invalid_path",
      `Invalid Decision ID for attestation path: ${decisionId}`,
      { decisionId },
    );
  }
  if (!/^tda-[0-9a-f]{64}$/u.test(attestationId)) {
    throw new TicketLedgerError(
      "invalid_path",
      `Invalid attestation ID for document path: ${attestationId}`,
      { attestationId },
    );
  }
  return `${TICKET_LEDGER_RELATIVE_PATH}/attestations/${
    decisionId
  }/${attestationId}.yaml`;
};

export const ticketRevision = (document: TicketDocument): string =>
  sha256(canonicalTicketLedgerValue(document));

export const encodeTicketDocument = (candidate: unknown): Buffer =>
  Buffer.from(
    stringify(normalizeTicketDocument(candidate), {
      lineWidth: 0,
      version: "1.2",
    }),
    "utf8",
  );

export const encodeTicketReviewDocument = (candidate: unknown): Buffer =>
  Buffer.from(
    stringify(normalizeTicketReviewDocument(candidate), {
      lineWidth: 0,
      version: "1.2",
    }),
    "utf8",
  );

export const encodeTicketDecisionDocument = (candidate: unknown): Buffer =>
  Buffer.from(
    stringify(normalizeTicketDecisionDocument(candidate), {
      lineWidth: 0,
      version: "1.2",
    }),
    "utf8",
  );

export const encodeTicketDecisionAttestationDocument = (
  candidate: unknown,
): Buffer =>
  Buffer.from(
    stringify(normalizeTicketDecisionAttestationDocument(candidate), {
      lineWidth: 0,
      version: "1.2",
    }),
    "utf8",
  );

export const ticketLedgerInventoryDigest = (
  files: readonly TicketLedgerPhysicalFile[],
): string =>
  sha256(canonicalTicketLedgerValue({
    schema_version: TICKET_LEDGER_SCHEMA_VERSION,
    format: TICKET_LEDGER_FORMAT,
    kind: "ticket_ledger_physical_inventory",
    files: [...files]
      .sort((left, right) => compareText(left.documentPath, right.documentPath))
      .map((file) => ({
        document_path: file.documentPath,
        mode: String(file.mode),
        byte_digest: sha256(file.bytes),
    })),
  }));

const gitTreeMode = (mode: number | string): string => {
  if (typeof mode === "number") {
    return (mode & 0o111) === 0 ? "100644" : "100755";
  }
  return mode === "100755" ? "100755" : "100644";
};

export const ticketLedgerCheckpointInventoryDigest = (
  files: readonly TicketLedgerPhysicalFile[],
): string =>
  sha256(canonicalTicketLedgerValue({
    schema_version: TICKET_LEDGER_SCHEMA_VERSION,
    format: TICKET_LEDGER_FORMAT,
    kind: "ticket_ledger_git_checkpoint_inventory",
    files: [...files]
      .sort((left, right) => compareText(left.documentPath, right.documentPath))
      .map((file) => ({
        document_path: file.documentPath,
        git_mode: gitTreeMode(file.mode),
        byte_digest: sha256(file.bytes),
      })),
  }));

export const ticketRelationId = (
  subjectTicketId: string,
  relation: TicketRelation,
): string =>
  `trl-${sha256(canonicalTicketLedgerValue({
    schema_version: TICKET_LEDGER_SCHEMA_VERSION,
    subject_ticket_id: subjectTicketId,
    type: relation.type,
    target_ticket_id: relation.target_ticket_id,
  }))}`;

const validateTicketGraph = (tickets: readonly TicketLedgerTicket[]): void => {
  const ids = new Set(tickets.map((ticket) => ticket.document.ticket_id));
  const dependencies = new Map<string, string[]>(
    tickets.map((ticket) => [ticket.document.ticket_id, []]),
  );

  for (const ticket of tickets) {
    const subjectId = ticket.document.ticket_id;
    const targets = dependencies.get(subjectId)!;
    for (const relation of ticket.document.relations) {
      const targetId = relation.target_ticket_id;
      if (subjectId === targetId) {
        throw new TicketLedgerError(
          "invalid_graph",
          `Ticket ${subjectId} cannot depend on itself`,
          { ticketId: subjectId },
        );
      }
      if (!ids.has(targetId)) {
        throw new TicketLedgerError(
          "invalid_graph",
          `Ticket ${subjectId} depends on missing Ticket ${targetId}`,
          { ticketId: subjectId, targetTicketId: targetId },
        );
      }
      targets.push(targetId);
    }
  }

  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const visitTicket = (ticketId: string): void => {
    const current = state.get(ticketId);
    if (current === "visited") return;
    if (current === "visiting") {
      const cycleStart = stack.indexOf(ticketId);
      const cycle = [...stack.slice(cycleStart), ticketId];
      throw new TicketLedgerError(
        "invalid_graph",
        `Ticket dependency cycle: ${cycle.join(" -> ")}`,
        { cycle },
      );
    }
    state.set(ticketId, "visiting");
    stack.push(ticketId);
    for (const dependency of dependencies.get(ticketId) ?? []) {
      visitTicket(dependency);
    }
    stack.pop();
    state.set(ticketId, "visited");
  };

  for (const ticketId of [...ids].sort(compareText)) visitTicket(ticketId);
};

export const validateTicketLedger = (
  candidate: TicketLedgerCandidate,
): TicketLedgerContent => {
  const protocol = normalizeTicketLedgerProtocol(candidate.protocol);
  if (candidate.tickets.length > TICKET_LEDGER_MAX_TICKETS) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_TICKETS} Tickets`,
      { ticketCount: candidate.tickets.length },
    );
  }

  const tickets = candidate.tickets.map(({ documentPath, document }) => {
    const normalized = normalizeTicketDocument(document, documentPath);
    const expectedPath = ticketDocumentPath(normalized.ticket_id);
    if (documentPath !== expectedPath) {
      throw new TicketLedgerError(
        "invalid_path",
        `Ticket ${normalized.ticket_id} must be stored at ${expectedPath}`,
        { documentPath, expectedPath, ticketId: normalized.ticket_id },
      );
    }
    return {
      documentPath,
      ticketRevision: ticketRevision(normalized),
      document: normalized,
    };
  });

  uniqueBy(
    tickets,
    (ticket) => ticket.document.ticket_id,
    "Ticket ledger",
  );
  tickets.sort((left, right) =>
    compareText(left.document.ticket_id, right.document.ticket_id));
  const relationCount = tickets.reduce(
    (sum, ticket) => sum + ticket.document.relations.length,
    0,
  );
  if (relationCount > TICKET_LEDGER_MAX_RELATIONS) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_RELATIONS} relations`,
      { relationCount },
    );
  }
  validateTicketGraph(tickets);

  const graphDigest = sha256(canonicalTicketLedgerValue({
    protocol,
    tickets: tickets.map((ticket) => ticket.document),
  }));

  const reviewCandidates = candidate.reviews ?? [];
  if (reviewCandidates.length > TICKET_LEDGER_MAX_REVIEWS) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_REVIEWS} reviews`,
      { reviewCount: reviewCandidates.length },
    );
  }
  const reviews: TicketLedgerReview[] = reviewCandidates.map(
    ({ documentPath, document }) => {
      const normalized = normalizeTicketReviewDocument(document, documentPath);
      const expectedPath = ticketReviewDocumentPath(
        normalized.subject,
        normalized.review_id,
      );
      if (documentPath !== expectedPath) {
        throw new TicketLedgerError(
          "invalid_path",
          `Review ${normalized.review_id} must be stored at ${expectedPath}`,
          {
            documentPath,
            expectedPath,
            reviewId: normalized.review_id,
          },
        );
      }
      return { documentPath, document: normalized };
    },
  );
  uniqueBy(
    reviews,
    (review) => review.document.review_id,
    "Ticket review ledger",
  );
  reviews.sort((left, right) =>
    compareText(left.document.review_id, right.document.review_id));

  const decisionCandidates = candidate.decisions ?? [];
  if (decisionCandidates.length > TICKET_LEDGER_MAX_DECISIONS) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_DECISIONS} decisions`,
      { decisionCount: decisionCandidates.length },
    );
  }
  const decisions: TicketLedgerDecision[] = decisionCandidates.map(
    ({ documentPath, document }) => {
      const normalized =
        normalizeTicketDecisionDocument(document, documentPath);
      const expectedPath = ticketDecisionDocumentPath(normalized);
      if (documentPath !== expectedPath) {
        throw new TicketLedgerError(
          "invalid_path",
          `Decision ${normalized.decision_id} must be stored at ${expectedPath}`,
          {
            documentPath,
            expectedPath,
            decisionId: normalized.decision_id,
          },
        );
      }
      return { documentPath, document: normalized };
    },
  );
  uniqueBy(
    decisions,
    (decision) => decision.document.decision_id,
    "Ticket decision ledger",
  );
  decisions.sort((left, right) =>
    compareText(left.document.decision_id, right.document.decision_id));

  const attestationCandidates = candidate.attestations ?? [];
  if (attestationCandidates.length > TICKET_LEDGER_MAX_ATTESTATIONS) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_ATTESTATIONS} decision attestations`,
      { attestationCount: attestationCandidates.length },
    );
  }
  const attestations: TicketLedgerDecisionAttestation[] =
    attestationCandidates.map(({ documentPath, document }) => {
      const normalized = normalizeTicketDecisionAttestationDocument(
        document,
        documentPath,
      );
      const expectedPath =
        ticketDecisionAttestationDocumentPath(normalized);
      if (documentPath !== expectedPath) {
        throw new TicketLedgerError(
          "invalid_path",
          `Attestation ${normalized.attestation_id} must be stored at ${expectedPath}`,
          {
            documentPath,
            expectedPath,
            decisionId: normalized.decision.decision_id,
            attestationId: normalized.attestation_id,
          },
        );
      }
      return { documentPath, document: normalized };
    });
  uniqueBy(
    attestations,
    (attestation) => attestation.document.attestation_id,
    "Ticket decision attestation ledger",
  );
  attestations.sort((left, right) =>
    compareText(
      left.document.attestation_id,
      right.document.attestation_id,
    ));

  const semanticLedgerDigest = sha256(canonicalTicketLedgerValue({
    protocol,
    tickets: tickets.map((ticket) => ticket.document),
    reviews: reviews.map((review) => review.document),
    decisions: decisions.map((decision) => decision.document),
    attestations: attestations.map((attestation) =>
      attestation.document),
  }));
  return {
    protocol,
    tickets,
    reviews,
    decisions,
    attestations,
    graphDigest,
    semanticLedgerDigest,
  };
};

const parseYamlDocument = (
  bytes: Buffer,
  documentPath: string,
  maxBytes: number,
): unknown => {
  if (bytes.byteLength > maxBytes) {
    throw new TicketLedgerError(
      "file_too_large",
      `${documentPath} exceeds its ${maxBytes}-byte limit`,
      { documentPath, byteLength: bytes.byteLength, maxBytes },
    );
  }
  if (bytes.includes(0)) {
    throw new TicketLedgerError(
      "invalid_document",
      `${documentPath} contains a NUL byte`,
      { documentPath },
    );
  }
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)) {
    throw new TicketLedgerError(
      "invalid_document",
      `${documentPath} is not valid UTF-8`,
      { documentPath },
    );
  }

  let documents: ReturnType<typeof parseAllDocuments>;
  try {
    documents = parseAllDocuments(source, {
      version: "1.2",
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      merge: false,
      customTags: null,
      resolveKnownTags: false,
      prettyErrors: true,
    });
  } catch (cause) {
    throw new TicketLedgerError(
      "invalid_document",
      `${documentPath} is not valid YAML 1.2`,
      { documentPath },
      { cause },
    );
  }
  if (documents.length !== 1) {
    throw new TicketLedgerError(
      "invalid_document",
      `${documentPath} must contain exactly one YAML document`,
      { documentPath, documentCount: documents.length },
    );
  }
  const document = documents[0] as Document<ParsedNode, true>;
  if (document.errors.length > 0) {
    throw new TicketLedgerError(
      "invalid_document",
      `${documentPath} is not valid YAML 1.2: ${document.errors
        .slice(0, 4)
        .map((error) => error.message)
        .join("; ")}`,
      { documentPath },
    );
  }

  let forbidden: string | null = null;
  visit(document, {
    Alias: () => {
      forbidden ??= "aliases";
    },
    Pair: (_key, pair) => {
      if (isScalar(pair.key) && pair.key.value === "<<") {
        forbidden ??= "merge keys";
      }
    },
    Node: (_key, node) => {
      if (
        "tag" in node
        && typeof node.tag === "string"
        && !YAML_CORE_TAGS.has(node.tag)
      ) {
        forbidden ??= "custom tags";
      }
    },
  });
  if (forbidden !== null) {
    throw new TicketLedgerError(
      "invalid_document",
      `${documentPath} contains forbidden YAML ${forbidden}`,
      { documentPath, forbidden },
    );
  }

  try {
    return document.toJS({ mapAsMap: false, maxAliasCount: 0 });
  } catch (cause) {
    throw new TicketLedgerError(
      "invalid_document",
      `${documentPath} cannot be converted into a safe value`,
      { documentPath },
      { cause },
    );
  }
};

export const decodeTicketLedger = (
  files: readonly TicketLedgerFile[],
): TicketLedgerContent => {
  const totalBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (totalBytes > TICKET_LEDGER_MAX_BYTES) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger exceeds its ${TICKET_LEDGER_MAX_BYTES}-byte limit`,
      { totalBytes, maxBytes: TICKET_LEDGER_MAX_BYTES },
    );
  }

  const protocolPath = `${TICKET_LEDGER_RELATIVE_PATH}/protocol.yaml`;
  const protocolFiles = files.filter((file) => file.documentPath === protocolPath);
  if (protocolFiles.length !== 1) {
    throw new TicketLedgerError(
      "ledger_missing",
      `Ticket ledger must contain exactly one ${protocolPath}`,
      { protocolCount: protocolFiles.length },
    );
  }
  const protocol = parseYamlDocument(
    protocolFiles[0]!.bytes,
    protocolPath,
    TICKET_LEDGER_PROTOCOL_MAX_BYTES,
  );
  const documentFiles = files.filter(
    (file) => file.documentPath !== protocolPath,
  );
  for (const file of documentFiles) {
    if (!isTicketLedgerDocumentPath(file.documentPath)) {
      throw new TicketLedgerError(
        "unsupported_file",
        `Unsupported path inside Ticket ledger: ${file.documentPath}`,
        { documentPath: file.documentPath },
      );
    }
  }
  const ticketPrefix = `${TICKET_LEDGER_RELATIVE_PATH}/tickets/`;
  const reviewPrefix = `${TICKET_LEDGER_RELATIVE_PATH}/reviews/`;
  const decisionPrefix = `${TICKET_LEDGER_RELATIVE_PATH}/decisions/`;
  const attestationPrefix =
    `${TICKET_LEDGER_RELATIVE_PATH}/attestations/`;
  const ticketFiles = documentFiles.filter((file) =>
    file.documentPath.startsWith(ticketPrefix));
  if (ticketFiles.length > TICKET_LEDGER_MAX_TICKETS) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_TICKETS} files`,
      { ticketCount: ticketFiles.length },
    );
  }
  const tickets = ticketFiles.map((file) => ({
    documentPath: file.documentPath,
    document: parseYamlDocument(
      file.bytes,
      file.documentPath,
      TICKET_LEDGER_TICKET_MAX_BYTES,
    ),
  }));
  const reviewFiles = documentFiles.filter((file) =>
    file.documentPath.startsWith(reviewPrefix));
  if (reviewFiles.length > TICKET_LEDGER_MAX_REVIEWS) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_REVIEWS} review files`,
      { reviewCount: reviewFiles.length },
    );
  }
  const reviews = reviewFiles.map((file) => ({
    documentPath: file.documentPath,
    document: parseYamlDocument(
      file.bytes,
      file.documentPath,
      TICKET_LEDGER_REVIEW_MAX_BYTES,
    ),
  }));
  const decisionFiles = documentFiles.filter((file) =>
    file.documentPath.startsWith(decisionPrefix));
  if (decisionFiles.length > TICKET_LEDGER_MAX_DECISIONS) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_DECISIONS} decision files`,
      { decisionCount: decisionFiles.length },
    );
  }
  const decisions = decisionFiles.map((file) => ({
    documentPath: file.documentPath,
    document: parseYamlDocument(
      file.bytes,
      file.documentPath,
      TICKET_LEDGER_DECISION_MAX_BYTES,
    ),
  }));
  const attestationFiles = documentFiles.filter((file) =>
    file.documentPath.startsWith(attestationPrefix));
  if (attestationFiles.length > TICKET_LEDGER_MAX_ATTESTATIONS) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_ATTESTATIONS} attestation files`,
      { attestationCount: attestationFiles.length },
    );
  }
  const attestations = attestationFiles.map((file) => ({
    documentPath: file.documentPath,
    document: parseYamlDocument(
      file.bytes,
      file.documentPath,
      TICKET_LEDGER_ATTESTATION_MAX_BYTES,
    ),
  }));
  return validateTicketLedger({
    protocol,
    tickets,
    reviews,
    decisions,
    attestations,
  });
};

export const ticketLedgerSourceToken = (
  source:
    | {
      mode: "worktree";
      repositoryIncarnation: string;
      worktreeIdentity: string;
      resolvedCommit: string;
      graphDigest: string;
      semanticLedgerDigest: string;
      inventoryDigest: string;
    }
    | {
      mode: "ref";
      repositoryIncarnation: string;
      resolvedCommit: string;
      graphDigest: string;
      semanticLedgerDigest: string;
      inventoryDigest: string;
    },
): string =>
  `tls-${sha256(canonicalTicketLedgerValue({
    schema_version: TICKET_LEDGER_SCHEMA_VERSION,
    format: TICKET_LEDGER_FORMAT,
    ...source,
  }))}`;

export const isTicketLedgerDocumentPath = (
  repositoryRelativePath: string,
): boolean => {
  if (
    path.posix.normalize(repositoryRelativePath) !== repositoryRelativePath
    || repositoryRelativePath.startsWith("/")
  ) {
    return false;
  }
  if (repositoryRelativePath === `${TICKET_LEDGER_RELATIVE_PATH}/protocol.yaml`) {
    return true;
  }
  const ticketPrefix = `${TICKET_LEDGER_RELATIVE_PATH}/tickets/`;
  if (repositoryRelativePath.startsWith(ticketPrefix)) {
    const fileName = repositoryRelativePath.slice(ticketPrefix.length);
    if (!fileName.endsWith(".yaml") || fileName.includes("/")) return false;
    try {
      return ticketDocumentPath(fileName.slice(0, -".yaml".length))
        === repositoryRelativePath;
    } catch {
      return false;
    }
  }
  const reviewPrefix = `${TICKET_LEDGER_RELATIVE_PATH}/reviews/`;
  if (repositoryRelativePath.startsWith(reviewPrefix)) {
    const relative = repositoryRelativePath.slice(reviewPrefix.length);
    const segments = relative.split("/");
    return segments.length === 2
      && /^[0-9a-f]{64}$/u.test(segments[0]!)
      && /^trv-[0-9a-f]{64}\.yaml$/u.test(segments[1]!);
  }
  const decisionPrefix = `${TICKET_LEDGER_RELATIVE_PATH}/decisions/`;
  if (repositoryRelativePath.startsWith(decisionPrefix)) {
    const fileName = repositoryRelativePath.slice(decisionPrefix.length);
    return /^[0-9a-f]{64}\.yaml$/u.test(fileName);
  }
  const attestationPrefix =
    `${TICKET_LEDGER_RELATIVE_PATH}/attestations/`;
  if (repositoryRelativePath.startsWith(attestationPrefix)) {
    const relative = repositoryRelativePath.slice(attestationPrefix.length);
    const segments = relative.split("/");
    return segments.length === 2
      && /^tdc-[0-9a-f]{64}$/u.test(segments[0]!)
      && /^tda-[0-9a-f]{64}\.yaml$/u.test(segments[1]!);
  }
  return false;
};

export const ticketLedgerDocumentMaxBytes = (
  documentPath: string,
): number => {
  if (documentPath === `${TICKET_LEDGER_RELATIVE_PATH}/protocol.yaml`) {
    return TICKET_LEDGER_PROTOCOL_MAX_BYTES;
  }
  if (documentPath.startsWith(`${TICKET_LEDGER_RELATIVE_PATH}/tickets/`)) {
    return TICKET_LEDGER_TICKET_MAX_BYTES;
  }
  if (documentPath.startsWith(`${TICKET_LEDGER_RELATIVE_PATH}/reviews/`)) {
    return TICKET_LEDGER_REVIEW_MAX_BYTES;
  }
  if (documentPath.startsWith(`${TICKET_LEDGER_RELATIVE_PATH}/decisions/`)) {
    return TICKET_LEDGER_DECISION_MAX_BYTES;
  }
  if (
    documentPath.startsWith(
      `${TICKET_LEDGER_RELATIVE_PATH}/attestations/`,
    )
  ) {
    return TICKET_LEDGER_ATTESTATION_MAX_BYTES;
  }
  throw new TicketLedgerError(
    "invalid_path",
    `Unsupported Ticket ledger document path: ${documentPath}`,
    { documentPath },
  );
};
