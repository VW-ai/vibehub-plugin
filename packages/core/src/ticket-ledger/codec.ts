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
  TICKET_LEDGER_MAX_CONTEXT_BINDINGS,
  TICKET_LEDGER_MAX_DECISIONS,
  TICKET_LEDGER_MAX_EVIDENCE,
  TICKET_LEDGER_MAX_OUTCOMES,
  TICKET_LEDGER_MAX_RELATIONS,
  TICKET_LEDGER_MAX_REVIEWS,
  TICKET_LEDGER_MAX_TICKETS,
  TICKET_LEDGER_DECISION_MAX_BYTES,
  TICKET_LEDGER_ATTESTATION_MAX_BYTES,
  TICKET_LEDGER_CONTEXT_BINDING_MAX_BYTES,
  TICKET_LEDGER_EVIDENCE_MAX_BYTES,
  TICKET_LEDGER_OUTCOME_MAX_BYTES,
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
  ticketContextBindingDocumentSchema,
  ticketEvidenceDocumentSchema,
  ticketOutcomeDocumentSchema,
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
  type TicketContextBindingDocument,
  type TicketContextBindingDocumentPayload,
  type TicketEvidenceDocument,
  type TicketEvidenceDocumentPayload,
  type TicketOutcomeDocument,
  type TicketOutcomeDocumentPayload,
  type TicketDocument,
  type TicketLedgerCandidate,
  type TicketLedgerContent,
  type TicketLedgerDecision,
  type TicketLedgerDecisionAttestation,
  type TicketLedgerContextBinding,
  type TicketLedgerEvidence,
  type TicketLedgerOutcome,
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
  signer: candidate.signer,
  confirmation: candidate.confirmation,
  nonce: candidate.nonce,
  issued_at: candidate.issued_at,
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
    signer: { ...value.signer },
    confirmation: { ...value.confirmation },
    nonce: value.nonce,
    issued_at: normalizeInstant(value.issued_at),
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

const TICKET_DECISION_ATTESTATION_SIGNING_DOMAIN = Buffer.from(
  "vibehub.ticket-decision-attestation.v1\0",
  "utf8",
);

export const ticketDecisionAttestationSigningBytes = (
  candidate:
    | TicketDecisionAttestationEnvelope
    | TicketDecisionAttestationDocumentPayload
    | TicketDecisionAttestationDocument,
): Buffer => {
  const envelope = normalizeAttestationEnvelope(
    candidate,
    "Ticket decision attestation signing envelope",
  );
  return Buffer.concat([
    TICKET_DECISION_ATTESTATION_SIGNING_DOMAIN,
    Buffer.from(canonicalTicketLedgerValue(envelope), "utf8"),
  ]);
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

const normalizeAttestationPayload = (
  candidate: unknown,
  label: string,
): TicketDecisionAttestationDocumentPayload => {
  const value = parseAttestationPayload(candidate, label);
  const envelope = normalizeAttestationEnvelope(value, label);
  const normalized: TicketDecisionAttestationDocumentPayload = {
    ...envelope,
    signature: value.signature,
  };
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

const normalizeExecutionActor = <
  T extends { actor_kind: "agent" | "human"; actor_ref: string },
>(actor: T): T => ({
  ...actor,
  actor_ref: normalizeText(actor.actor_ref),
});

const normalizeExecutionRun = <
  T extends {
    run_id: string;
    generation: number;
    executor: { actor_kind: "agent" | "human"; actor_ref: string };
    started_source_digest: string;
  },
>(run: T): T => ({
  ...run,
  executor: normalizeExecutionActor(run.executor),
});

const parseContextBindingCandidate = (
  candidate: unknown,
  label: string,
): TicketContextBindingDocument => {
  const parsed = ticketContextBindingDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label} is invalid: ${formatZodIssues(parsed.error.issues)}`,
      { label },
    );
  }
  return parsed.data;
};

const normalizeContextBindingPayload = (
  value: TicketContextBindingDocument,
): TicketContextBindingDocumentPayload => {
  const acceptance = value.acceptance.map((item) => ({ ...item }));
  uniqueBy(
    acceptance,
    (item) => item.acceptance_id,
    "context binding acceptance",
  );
  acceptance.sort((left, right) =>
    compareText(left.acceptance_id, right.acceptance_id));

  const contextEntries = value.context_entries.map((entry) => {
    const files = entry.files.map((file) => ({ ...file }));
    uniqueBy(
      files,
      (file) => file.repository_path,
      `context binding entry ${entry.ref} files`,
    );
    files.sort((left, right) =>
      compareText(left.repository_path, right.repository_path));
    return {
      ref: normalizeText(entry.ref),
      purpose: normalizeText(entry.purpose),
      source_kind: entry.source_kind,
      files,
    };
  });
  uniqueBy(
    contextEntries,
    (entry) => entry.ref,
    "context binding entries",
  );
  contextEntries.sort((left, right) => compareText(left.ref, right.ref));

  const prerequisiteOutcomes =
    value.successful_prerequisite_outcomes.map((item) => ({ ...item }));
  uniqueBy(
    prerequisiteOutcomes,
    (item) => item.ticket_id,
    "successful prerequisite outcomes",
  );
  uniqueBy(
    prerequisiteOutcomes,
    (item) => item.outcome_id,
    "successful prerequisite outcomes",
  );
  prerequisiteOutcomes.sort((left, right) =>
    compareText(left.ticket_id, right.ticket_id));

  const relevantDecisions = value.relevant_decisions.map((item) => ({
    ...item,
  }));
  uniqueBy(
    relevantDecisions,
    (item) => item.decision_id,
    "context binding decisions",
  );
  relevantDecisions.sort((left, right) =>
    compareText(left.decision_id, right.decision_id));

  return {
    schema_version: TICKET_LEDGER_SCHEMA_VERSION,
    kind: "ticket_context_binding",
    subject: { ...value.subject },
    graph_digest: value.graph_digest,
    repository: {
      ...value.repository,
      branch: normalizeText(value.repository.branch),
    },
    acceptance,
    context_entries: contextEntries,
    successful_prerequisite_outcomes: prerequisiteOutcomes,
    relevant_decisions: relevantDecisions,
    packet_digest: value.packet_digest,
    compiled_at: normalizeInstant(value.compiled_at),
  };
};

const withoutContextBindingTime = (
  payload: TicketContextBindingDocumentPayload,
): Omit<TicketContextBindingDocumentPayload, "compiled_at"> => {
  const { compiled_at: _compiledAt, ...identity } = payload;
  return identity;
};

export const createTicketContextBindingDocument = (
  candidate: TicketContextBindingDocumentPayload,
  label = "Ticket context binding payload",
): TicketContextBindingDocument => {
  const parsed = parseContextBindingCandidate({
    ...candidate,
    context_binding_id: `tcb-${"0".repeat(64)}`,
  }, label);
  const payload = normalizeContextBindingPayload(parsed);
  return {
    ...payload,
    context_binding_id: `tcb-${sha256(canonicalTicketLedgerValue(
      withoutContextBindingTime(payload),
    ))}`,
  };
};

export const normalizeTicketContextBindingDocument = (
  candidate: unknown,
  label = "Ticket context binding document",
): TicketContextBindingDocument => {
  const parsed = parseContextBindingCandidate(candidate, label);
  const { context_binding_id: _contextBindingId, ...payload } = parsed;
  const normalized = createTicketContextBindingDocument(payload, label);
  if (parsed.context_binding_id !== normalized.context_binding_id) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label} context_binding_id does not match its normalized intent`,
      {
        label,
        contextBindingId: parsed.context_binding_id,
        expectedContextBindingId: normalized.context_binding_id,
      },
    );
  }
  return normalized;
};

export const ticketContextBindingDocumentDigest = (
  candidate: unknown,
): string => sha256(canonicalTicketLedgerValue(
  normalizeTicketContextBindingDocument(candidate),
));

const parseEvidenceCandidate = (
  candidate: unknown,
  label: string,
): TicketEvidenceDocument => {
  const parsed = ticketEvidenceDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label} is invalid: ${formatZodIssues(parsed.error.issues)}`,
      { label },
    );
  }
  return parsed.data;
};

const normalizeEvidencePayload = (
  value: TicketEvidenceDocument,
): TicketEvidenceDocumentPayload => {
  const references = value.references.map((reference) => ({
    ...reference,
    label: normalizeText(reference.label),
  }));
  uniqueBy(
    references,
    (reference) => `${reference.reference_type}\0${reference.target}`,
    "evidence references",
  );
  references.sort((left, right) => compareText(
    `${left.reference_type}\0${left.target}`,
    `${right.reference_type}\0${right.target}`,
  ));
  return {
    schema_version: TICKET_LEDGER_SCHEMA_VERSION,
    kind: "ticket_evidence",
    subject: { ...value.subject },
    context_binding: { ...value.context_binding },
    run: normalizeExecutionRun(value.run),
    acceptance_id: value.acceptance_id,
    evidence_type: value.evidence_type,
    summary: normalizeText(value.summary),
    references,
    produced_at: normalizeInstant(value.produced_at),
  };
};

const withoutEvidenceTime = (
  payload: TicketEvidenceDocumentPayload,
): Omit<TicketEvidenceDocumentPayload, "produced_at"> => {
  const { produced_at: _producedAt, ...identity } = payload;
  return identity;
};

export const createTicketEvidenceDocument = (
  candidate: TicketEvidenceDocumentPayload,
  label = "Ticket evidence payload",
): TicketEvidenceDocument => {
  const parsed = parseEvidenceCandidate({
    ...candidate,
    evidence_id: `tev-${"0".repeat(64)}`,
  }, label);
  const payload = normalizeEvidencePayload(parsed);
  return {
    ...payload,
    evidence_id: `tev-${sha256(canonicalTicketLedgerValue(
      withoutEvidenceTime(payload),
    ))}`,
  };
};

export const normalizeTicketEvidenceDocument = (
  candidate: unknown,
  label = "Ticket evidence document",
): TicketEvidenceDocument => {
  const parsed = parseEvidenceCandidate(candidate, label);
  const { evidence_id: _evidenceId, ...payload } = parsed;
  const normalized = createTicketEvidenceDocument(payload, label);
  if (parsed.evidence_id !== normalized.evidence_id) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label} evidence_id does not match its normalized intent`,
      {
        label,
        evidenceId: parsed.evidence_id,
        expectedEvidenceId: normalized.evidence_id,
      },
    );
  }
  return normalized;
};

export const ticketEvidenceDocumentDigest = (
  candidate: unknown,
): string => sha256(canonicalTicketLedgerValue(
  normalizeTicketEvidenceDocument(candidate),
));

const parseOutcomeCandidate = (
  candidate: unknown,
  label: string,
): TicketOutcomeDocument => {
  const parsed = ticketOutcomeDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label} is invalid: ${formatZodIssues(parsed.error.issues)}`,
      { label },
    );
  }
  return parsed.data;
};

const semanticCloseoutRefKey = (
  reference: TicketOutcomeDocument["semantic_closeout_refs"][number],
): string => reference.kind === "review"
  ? `review\0${reference.review_id}`
  : reference.kind === "decision"
    ? `decision\0${reference.decision_id}`
    : `decision_attestation\0${reference.attestation_id}`;

const normalizeOutcomePayload = (
  value: TicketOutcomeDocument,
): TicketOutcomeDocumentPayload => {
  const acceptance = value.acceptance.map((item) => {
    const evidenceRefs = item.evidence_refs.map((reference) => ({
      ...reference,
    }));
    uniqueBy(
      evidenceRefs,
      (reference) => reference.evidence_id,
      `outcome acceptance ${item.acceptance_id} evidence`,
    );
    evidenceRefs.sort((left, right) =>
      compareText(left.evidence_id, right.evidence_id));
    return {
      acceptance_id: item.acceptance_id,
      adjudication: item.adjudication,
      evidence_refs: evidenceRefs,
      rationale: normalizeText(item.rationale),
    };
  });
  uniqueBy(
    acceptance,
    (item) => item.acceptance_id,
    "outcome acceptance",
  );
  acceptance.sort((left, right) =>
    compareText(left.acceptance_id, right.acceptance_id));

  const followUpTicketRefs = [...value.follow_up_ticket_refs];
  uniqueBy(
    followUpTicketRefs,
    (reference) => reference,
    "follow-up Ticket references",
  );
  followUpTicketRefs.sort(compareText);

  const semanticCloseoutRefs = value.semantic_closeout_refs.map(
    (reference) => ({ ...reference }),
  );
  uniqueBy(
    semanticCloseoutRefs,
    semanticCloseoutRefKey,
    "semantic closeout references",
  );
  semanticCloseoutRefs.sort((left, right) =>
    compareText(semanticCloseoutRefKey(left), semanticCloseoutRefKey(right)));

  return {
    schema_version: TICKET_LEDGER_SCHEMA_VERSION,
    kind: "ticket_outcome",
    subject: { ...value.subject },
    context_binding: { ...value.context_binding },
    run: normalizeExecutionRun(value.run),
    terminal_form: value.terminal_form,
    executor_report: normalizeText(value.executor_report),
    acceptance,
    verifier: normalizeExecutionActor(value.verifier),
    follow_up_ticket_refs: followUpTicketRefs,
    semantic_closeout_refs: semanticCloseoutRefs,
    closed_at: normalizeInstant(value.closed_at),
  };
};

const withoutOutcomeTime = (
  payload: TicketOutcomeDocumentPayload,
): Omit<TicketOutcomeDocumentPayload, "closed_at"> => {
  const { closed_at: _closedAt, ...identity } = payload;
  return identity;
};

const outcomeExecutionIdentityKey = (
  document: Pick<
    TicketOutcomeDocument,
    "subject" | "run"
  >,
): string => canonicalTicketLedgerValue({
  subject: document.subject,
  run: {
    run_id: document.run.run_id,
    generation: document.run.generation,
  },
});

export const createTicketOutcomeDocument = (
  candidate: TicketOutcomeDocumentPayload,
  label = "Ticket outcome payload",
): TicketOutcomeDocument => {
  const parsed = parseOutcomeCandidate({
    ...candidate,
    outcome_id: `tout-${"0".repeat(64)}`,
  }, label);
  const payload = normalizeOutcomePayload(parsed);
  return {
    ...payload,
    outcome_id: `tout-${sha256(canonicalTicketLedgerValue(
      withoutOutcomeTime(payload),
    ))}`,
  };
};

export const normalizeTicketOutcomeDocument = (
  candidate: unknown,
  label = "Ticket outcome document",
): TicketOutcomeDocument => {
  const parsed = parseOutcomeCandidate(candidate, label);
  const { outcome_id: _outcomeId, ...payload } = parsed;
  const normalized = createTicketOutcomeDocument(payload, label);
  if (parsed.outcome_id !== normalized.outcome_id) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label} outcome_id does not match its normalized intent`,
      {
        label,
        outcomeId: parsed.outcome_id,
        expectedOutcomeId: normalized.outcome_id,
      },
    );
  }
  return normalized;
};

export const ticketOutcomeDocumentDigest = (
  candidate: unknown,
): string => sha256(canonicalTicketLedgerValue(
  normalizeTicketOutcomeDocument(candidate),
));

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

const ticketScopedSemanticDocumentPath = (
  directory: "context-bindings" | "evidence" | "outcomes",
  ticketId: string,
  documentId: string,
  expectedId: RegExp,
): string => {
  ticketDocumentPath(ticketId);
  if (!expectedId.test(documentId)) {
    throw new TicketLedgerError(
      "invalid_path",
      `Invalid ${directory} document ID for path: ${documentId}`,
      { ticketId, documentId },
    );
  }
  return `${TICKET_LEDGER_RELATIVE_PATH}/${directory}/${
    ticketId
  }/${documentId}.yaml`;
};

export const ticketContextBindingDocumentPath = (
  document: Pick<
    TicketContextBindingDocument,
    "context_binding_id" | "subject"
  >,
): string => ticketScopedSemanticDocumentPath(
  "context-bindings",
  document.subject.ticket_id,
  document.context_binding_id,
  /^tcb-[0-9a-f]{64}$/u,
);

export const ticketEvidenceDocumentPath = (
  document: Pick<TicketEvidenceDocument, "evidence_id" | "subject">,
): string => ticketScopedSemanticDocumentPath(
  "evidence",
  document.subject.ticket_id,
  document.evidence_id,
  /^tev-[0-9a-f]{64}$/u,
);

export const ticketOutcomeDocumentPath = (
  document: Pick<TicketOutcomeDocument, "outcome_id" | "subject">,
): string => ticketScopedSemanticDocumentPath(
  "outcomes",
  document.subject.ticket_id,
  document.outcome_id,
  /^tout-[0-9a-f]{64}$/u,
);

export const ticketRevision = (document: TicketDocument): string =>
  sha256(canonicalTicketLedgerValue(document));

export const ticketAcceptanceCriterionDigest = (
  criterion: string,
): string => sha256(canonicalTicketLedgerValue(normalizeText(criterion)));

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

export const encodeTicketContextBindingDocument = (
  candidate: unknown,
): Buffer =>
  Buffer.from(
    stringify(normalizeTicketContextBindingDocument(candidate), {
      lineWidth: 0,
      version: "1.2",
    }),
    "utf8",
  );

export const encodeTicketEvidenceDocument = (
  candidate: unknown,
): Buffer =>
  Buffer.from(
    stringify(normalizeTicketEvidenceDocument(candidate), {
      lineWidth: 0,
      version: "1.2",
    }),
    "utf8",
  );

export const encodeTicketOutcomeDocument = (
  candidate: unknown,
): Buffer =>
  Buffer.from(
    stringify(normalizeTicketOutcomeDocument(candidate), {
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

  const contextBindingCandidates = candidate.contextBindings ?? [];
  if (
    contextBindingCandidates.length > TICKET_LEDGER_MAX_CONTEXT_BINDINGS
  ) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_CONTEXT_BINDINGS} context bindings`,
      { contextBindingCount: contextBindingCandidates.length },
    );
  }
  const contextBindings: TicketLedgerContextBinding[] =
    contextBindingCandidates.map(({ documentPath, document }) => {
      const normalized =
        normalizeTicketContextBindingDocument(document, documentPath);
      const expectedPath = ticketContextBindingDocumentPath(normalized);
      if (documentPath !== expectedPath) {
        throw new TicketLedgerError(
          "invalid_path",
          `Context binding ${normalized.context_binding_id} must be stored at ${expectedPath}`,
          {
            documentPath,
            expectedPath,
            contextBindingId: normalized.context_binding_id,
          },
        );
      }
      return { documentPath, document: normalized };
    });
  uniqueBy(
    contextBindings,
    (binding) => binding.document.context_binding_id,
    "Ticket context binding ledger",
  );
  contextBindings.sort((left, right) => compareText(
    left.document.context_binding_id,
    right.document.context_binding_id,
  ));

  const evidenceCandidates = candidate.evidence ?? [];
  if (evidenceCandidates.length > TICKET_LEDGER_MAX_EVIDENCE) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_EVIDENCE} evidence documents`,
      { evidenceCount: evidenceCandidates.length },
    );
  }
  const evidence: TicketLedgerEvidence[] = evidenceCandidates.map(
    ({ documentPath, document }) => {
      const normalized = normalizeTicketEvidenceDocument(
        document,
        documentPath,
      );
      const expectedPath = ticketEvidenceDocumentPath(normalized);
      if (documentPath !== expectedPath) {
        throw new TicketLedgerError(
          "invalid_path",
          `Evidence ${normalized.evidence_id} must be stored at ${expectedPath}`,
          {
            documentPath,
            expectedPath,
            evidenceId: normalized.evidence_id,
          },
        );
      }
      return { documentPath, document: normalized };
    },
  );
  uniqueBy(
    evidence,
    (item) => item.document.evidence_id,
    "Ticket evidence ledger",
  );
  evidence.sort((left, right) =>
    compareText(left.document.evidence_id, right.document.evidence_id));

  const outcomeCandidates = candidate.outcomes ?? [];
  if (outcomeCandidates.length > TICKET_LEDGER_MAX_OUTCOMES) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_OUTCOMES} outcome documents`,
      { outcomeCount: outcomeCandidates.length },
    );
  }
  const outcomes: TicketLedgerOutcome[] = outcomeCandidates.map(
    ({ documentPath, document }) => {
      const normalized = normalizeTicketOutcomeDocument(
        document,
        documentPath,
      );
      const expectedPath = ticketOutcomeDocumentPath(normalized);
      if (documentPath !== expectedPath) {
        throw new TicketLedgerError(
          "invalid_path",
          `Outcome ${normalized.outcome_id} must be stored at ${expectedPath}`,
          {
            documentPath,
            expectedPath,
            outcomeId: normalized.outcome_id,
          },
        );
      }
      return { documentPath, document: normalized };
    },
  );
  uniqueBy(
    outcomes,
    (outcome) => outcome.document.outcome_id,
    "Ticket outcome ledger",
  );
  const outcomesByExecutionIdentity = new Map<
    string,
    TicketLedgerOutcome
  >();
  for (const outcome of outcomes) {
    const executionIdentity =
      outcomeExecutionIdentityKey(outcome.document);
    const existing = outcomesByExecutionIdentity.get(executionIdentity);
    if (existing !== undefined) {
      throw new TicketLedgerError(
        "invalid_document",
        "A Ticket execution can have only one terminal Outcome",
        {
          ticketId: outcome.document.subject.ticket_id,
          ticketRevision: outcome.document.subject.ticket_revision,
          contextBindingId:
            outcome.document.context_binding.context_binding_id,
          runId: outcome.document.run.run_id,
          generation: outcome.document.run.generation,
          existingContextBindingId:
            existing.document.context_binding.context_binding_id,
          conflictingContextBindingId:
            outcome.document.context_binding.context_binding_id,
          existingOutcomeId: existing.document.outcome_id,
          conflictingOutcomeId: outcome.document.outcome_id,
        },
      );
    }
    outcomesByExecutionIdentity.set(executionIdentity, outcome);
  }
  outcomes.sort((left, right) =>
    compareText(left.document.outcome_id, right.document.outcome_id));

  const ticketsById = new Map(tickets.map((ticket) => [
    ticket.document.ticket_id,
    ticket,
  ]));
  const decisionsById = new Map(decisions.map((decision) => [
    decision.document.decision_id,
    decision,
  ]));
  const reviewsById = new Map(reviews.map((review) => [
    review.document.review_id,
    review,
  ]));
  const attestationsById = new Map(attestations.map((attestation) => [
    attestation.document.attestation_id,
    attestation,
  ]));
  const bindingsById = new Map(contextBindings.map((binding) => [
    binding.document.context_binding_id,
    binding,
  ]));
  const evidenceById = new Map(evidence.map((item) => [
    item.document.evidence_id,
    item,
  ]));
  const outcomesById = new Map(outcomes.map((outcome) => [
    outcome.document.outcome_id,
    outcome,
  ]));

  for (const binding of contextBindings) {
    const document = binding.document;
    if (!ticketsById.has(document.subject.ticket_id)) {
      throw new TicketLedgerError(
        "invalid_document",
        `Context binding ${document.context_binding_id} references a missing Ticket`,
        {
          contextBindingId: document.context_binding_id,
          ticketId: document.subject.ticket_id,
        },
      );
    }
    for (const reference of document.relevant_decisions) {
      const decision = decisionsById.get(reference.decision_id);
      if (
        decision === undefined
        || ticketDecisionDocumentDigest(decision.document)
          !== reference.decision_digest
      ) {
        throw new TicketLedgerError(
          "invalid_document",
          `Context binding ${document.context_binding_id} has an unresolved Decision reference`,
          {
            contextBindingId: document.context_binding_id,
            decisionId: reference.decision_id,
          },
        );
      }
      if (reference.verification.source === "durable_local_signature") {
        const attestation = attestationsById.get(
          reference.verification.verification_ref,
        );
        if (
          attestation === undefined
          || attestation.document.decision.decision_id
            !== reference.decision_id
          || attestation.document.decision.document_digest
            !== reference.decision_digest
        ) {
          throw new TicketLedgerError(
            "invalid_document",
            `Context binding ${document.context_binding_id} has an unresolved durable Decision verification`,
            {
              contextBindingId: document.context_binding_id,
              decisionId: reference.decision_id,
              verificationRef:
                reference.verification.verification_ref,
            },
          );
        }
      }
      if (
        Date.parse(decision.document.decided_at)
        > Date.parse(document.compiled_at)
      ) {
        throw new TicketLedgerError(
          "invalid_document",
          `Context binding ${document.context_binding_id} predates a referenced Decision`,
          {
            contextBindingId: document.context_binding_id,
            decisionId: reference.decision_id,
          },
        );
      }
    }
  }

  for (const item of evidence) {
    const document = item.document;
    const binding = bindingsById.get(
      document.context_binding.context_binding_id,
    );
    if (
      binding === undefined
      || ticketContextBindingDocumentDigest(binding.document)
        !== document.context_binding.document_digest
      || binding.document.packet_digest
        !== document.context_binding.packet_digest
      || canonicalTicketLedgerValue(binding.document.subject)
        !== canonicalTicketLedgerValue(document.subject)
    ) {
      throw new TicketLedgerError(
        "invalid_document",
        `Evidence ${document.evidence_id} has an unresolved or mismatched context binding`,
        {
          evidenceId: document.evidence_id,
          contextBindingId: document.context_binding.context_binding_id,
        },
      );
    }
    if (
      document.run.started_source_digest
      !== binding.document.repository.repository_source_digest
    ) {
      throw new TicketLedgerError(
        "invalid_document",
        `Evidence ${document.evidence_id} run source does not match its context binding`,
        { evidenceId: document.evidence_id },
      );
    }
    if (!binding.document.acceptance.some((acceptance) =>
      acceptance.acceptance_id === document.acceptance_id)) {
      throw new TicketLedgerError(
        "invalid_document",
        `Evidence ${document.evidence_id} references an unknown acceptance condition`,
        {
          evidenceId: document.evidence_id,
          acceptanceId: document.acceptance_id,
        },
      );
    }
    if (
      Date.parse(document.produced_at)
      < Date.parse(binding.document.compiled_at)
    ) {
      throw new TicketLedgerError(
        "invalid_document",
        `Evidence ${document.evidence_id} predates its context binding`,
        { evidenceId: document.evidence_id },
      );
    }
  }

  for (const outcome of outcomes) {
    const document = outcome.document;
    const binding = bindingsById.get(
      document.context_binding.context_binding_id,
    );
    if (
      binding === undefined
      || ticketContextBindingDocumentDigest(binding.document)
        !== document.context_binding.document_digest
      || binding.document.packet_digest
        !== document.context_binding.packet_digest
      || canonicalTicketLedgerValue(binding.document.subject)
        !== canonicalTicketLedgerValue(document.subject)
      || document.run.started_source_digest
        !== binding.document.repository.repository_source_digest
    ) {
      throw new TicketLedgerError(
        "invalid_document",
        `Outcome ${document.outcome_id} has an unresolved or mismatched context binding`,
        {
          outcomeId: document.outcome_id,
          contextBindingId: document.context_binding.context_binding_id,
        },
      );
    }
    if (
      canonicalTicketLedgerValue(document.run.executor)
      === canonicalTicketLedgerValue(document.verifier)
    ) {
      throw new TicketLedgerError(
        "invalid_document",
        `Outcome ${document.outcome_id} executor cannot verify itself`,
        { outcomeId: document.outcome_id },
      );
    }
    const expectedAcceptanceIds = binding.document.acceptance.map(
      (acceptance) => acceptance.acceptance_id,
    );
    const actualAcceptanceIds = document.acceptance.map(
      (acceptance) => acceptance.acceptance_id,
    );
    if (
      canonicalTicketLedgerValue(expectedAcceptanceIds)
      !== canonicalTicketLedgerValue(actualAcceptanceIds)
    ) {
      throw new TicketLedgerError(
        "invalid_document",
        `Outcome ${document.outcome_id} must adjudicate every bound acceptance condition exactly once`,
        {
          outcomeId: document.outcome_id,
          expectedAcceptanceIds,
          actualAcceptanceIds,
        },
      );
    }
    for (const adjudication of document.acceptance) {
      if (
        adjudication.adjudication === "accepted"
        && adjudication.evidence_refs.length === 0
      ) {
        throw new TicketLedgerError(
          "invalid_document",
          `Accepted outcome condition ${adjudication.acceptance_id} requires evidence`,
          {
            outcomeId: document.outcome_id,
            acceptanceId: adjudication.acceptance_id,
          },
        );
      }
      for (const reference of adjudication.evidence_refs) {
        const resolved = evidenceById.get(reference.evidence_id);
        if (
          resolved === undefined
          || ticketEvidenceDocumentDigest(resolved.document)
            !== reference.evidence_digest
          || resolved.document.acceptance_id
            !== adjudication.acceptance_id
          || canonicalTicketLedgerValue(resolved.document.subject)
            !== canonicalTicketLedgerValue(document.subject)
          || canonicalTicketLedgerValue(resolved.document.context_binding)
            !== canonicalTicketLedgerValue(document.context_binding)
          || canonicalTicketLedgerValue(resolved.document.run)
            !== canonicalTicketLedgerValue(document.run)
        ) {
          throw new TicketLedgerError(
            "invalid_document",
            `Outcome ${document.outcome_id} has unresolved or mismatched evidence`,
            {
              outcomeId: document.outcome_id,
              acceptanceId: adjudication.acceptance_id,
              evidenceId: reference.evidence_id,
            },
          );
        }
        if (
          Date.parse(resolved.document.produced_at)
          > Date.parse(document.closed_at)
        ) {
          throw new TicketLedgerError(
            "invalid_document",
            `Outcome ${document.outcome_id} predates referenced evidence`,
            {
              outcomeId: document.outcome_id,
              evidenceId: reference.evidence_id,
            },
          );
        }
      }
    }
    if (
      document.terminal_form === "successful"
      && document.acceptance.some((adjudication) =>
        adjudication.adjudication !== "accepted")
    ) {
      throw new TicketLedgerError(
        "invalid_document",
        `Successful Outcome ${document.outcome_id} must accept every condition`,
        { outcomeId: document.outcome_id },
      );
    }
    for (const ticketId of document.follow_up_ticket_refs) {
      if (!ticketsById.has(ticketId)) {
        throw new TicketLedgerError(
          "invalid_document",
          `Outcome ${document.outcome_id} references a missing follow-up Ticket`,
          { outcomeId: document.outcome_id, ticketId },
        );
      }
    }
    for (const reference of document.semantic_closeout_refs) {
      const resolves = reference.kind === "review"
        ? reviewsById.has(reference.review_id)
        : reference.kind === "decision"
          ? decisionsById.has(reference.decision_id)
          : attestationsById.has(reference.attestation_id);
      if (!resolves) {
        throw new TicketLedgerError(
          "invalid_document",
          `Outcome ${document.outcome_id} has an unresolved semantic closeout reference`,
          {
            outcomeId: document.outcome_id,
            reference: semanticCloseoutRefKey(reference),
          },
        );
      }
    }
    if (Date.parse(document.closed_at) < Date.parse(binding.document.compiled_at)) {
      throw new TicketLedgerError(
        "invalid_document",
        `Outcome ${document.outcome_id} predates its context binding`,
        { outcomeId: document.outcome_id },
      );
    }
  }

  for (const binding of contextBindings) {
    for (
      const reference
      of binding.document.successful_prerequisite_outcomes
    ) {
      const outcome = outcomesById.get(reference.outcome_id);
      if (
        outcome === undefined
        || outcome.document.subject.ticket_id !== reference.ticket_id
        || outcome.document.terminal_form !== "successful"
        || ticketOutcomeDocumentDigest(outcome.document)
          !== reference.outcome_digest
      ) {
        throw new TicketLedgerError(
          "invalid_document",
          `Context binding ${binding.document.context_binding_id} has an unresolved successful prerequisite Outcome`,
          {
            contextBindingId: binding.document.context_binding_id,
            ticketId: reference.ticket_id,
            outcomeId: reference.outcome_id,
          },
        );
      }
      if (
        Date.parse(outcome.document.closed_at)
        > Date.parse(binding.document.compiled_at)
      ) {
        throw new TicketLedgerError(
          "invalid_document",
          `Context binding ${binding.document.context_binding_id} predates a prerequisite Outcome`,
          {
            contextBindingId: binding.document.context_binding_id,
            outcomeId: reference.outcome_id,
          },
        );
      }
    }
  }

  const semanticLedgerDigest = sha256(canonicalTicketLedgerValue({
    protocol,
    tickets: tickets.map((ticket) => ticket.document),
    reviews: reviews.map((review) => review.document),
    decisions: decisions.map((decision) => decision.document),
    attestations: attestations.map((attestation) =>
      attestation.document),
    context_bindings: contextBindings.map((binding) => binding.document),
    evidence: evidence.map((item) => item.document),
    outcomes: outcomes.map((outcome) => outcome.document),
  }));
  return {
    protocol,
    tickets,
    reviews,
    decisions,
    attestations,
    contextBindings,
    evidence,
    outcomes,
    graphDigest,
    semanticLedgerDigest,
  };
};

export type TicketLedgerDerivedStatus =
  | "READY"
  | "DONE"
  | "BLOCKED"
  | "DEVIATED";

export interface TicketLedgerDerivedTicketState {
  ticketId: string;
  ticketRevision: string;
  status: TicketLedgerDerivedStatus;
  blockingTicketIds: readonly string[];
  currentSuccessfulOutcome: TicketLedgerOutcome | null;
}

const currentSuccessfulOutcomes = (
  ledger: Pick<
    TicketLedgerContent,
    "tickets" | "contextBindings" | "outcomes"
  >,
): Map<string, TicketLedgerOutcome[]> => {
  const tickets = new Map(ledger.tickets.map((ticket) => [
    ticket.document.ticket_id,
    ticket,
  ]));
  const bindings = new Map(ledger.contextBindings.map((binding) => [
    binding.document.context_binding_id,
    binding,
  ]));
  const outcomeExecutionCounts = new Map<string, number>();
  for (const outcome of ledger.outcomes) {
    const executionIdentity =
      outcomeExecutionIdentityKey(outcome.document);
    outcomeExecutionCounts.set(
      executionIdentity,
      (outcomeExecutionCounts.get(executionIdentity) ?? 0) + 1,
    );
  }
  const outcomesByTicket = new Map<string, TicketLedgerOutcome[]>();
  for (const outcome of ledger.outcomes) {
    if (outcome.document.terminal_form !== "successful") continue;
    if (
      outcomeExecutionCounts.get(
        outcomeExecutionIdentityKey(outcome.document),
      ) !== 1
    ) {
      // validateTicketLedger rejects this corruption. Keep derived views
      // fail-closed as well if a caller bypasses ledger validation.
      continue;
    }
    const ticketId = outcome.document.subject.ticket_id;
    const list = outcomesByTicket.get(ticketId) ?? [];
    list.push(outcome);
    outcomesByTicket.set(ticketId, list);
  }
  for (const list of outcomesByTicket.values()) {
    list.sort((left, right) => {
      const byTime = compareText(
        right.document.closed_at,
        left.document.closed_at,
      );
      return byTime !== 0
        ? byTime
        : compareText(
            right.document.outcome_id,
            left.document.outcome_id,
          );
    });
  }

  const memo = new Map<string, TicketLedgerOutcome[]>();
  const visiting = new Set<string>();
  const resolve = (ticketId: string): TicketLedgerOutcome[] => {
    const cached = memo.get(ticketId);
    if (cached !== undefined) return cached;
    if (visiting.has(ticketId)) return [];
    visiting.add(ticketId);
    const ticket = tickets.get(ticketId);
    if (ticket === undefined) {
      visiting.delete(ticketId);
      memo.set(ticketId, []);
      return [];
    }
    const prerequisites = ticket.document.relations
      .map((relation) => relation.target_ticket_id)
      .sort(compareText);
    const currentPrerequisiteOutcomes = new Map(
      prerequisites.map((prerequisiteId) => [
        prerequisiteId,
        resolve(prerequisiteId)[0] ?? null,
      ]),
    );
    const expectedAcceptance = ticket.document.acceptance
      .map((acceptance) => ({
        acceptance_id: acceptance.acceptance_id,
        criterion_digest:
          ticketAcceptanceCriterionDigest(acceptance.criterion),
      }))
      .sort((left, right) =>
        compareText(left.acceptance_id, right.acceptance_id));
    const current = (outcomesByTicket.get(ticketId) ?? []).find((outcome) => {
      if (
        outcome.document.subject.ticket_revision !== ticket.ticketRevision
      ) {
        return false;
      }
      const binding = bindings.get(
        outcome.document.context_binding.context_binding_id,
      );
      if (
        binding === undefined
        || canonicalTicketLedgerValue(binding.document.subject)
          !== canonicalTicketLedgerValue(outcome.document.subject)
        || canonicalTicketLedgerValue(binding.document.acceptance)
          !== canonicalTicketLedgerValue(expectedAcceptance)
      ) {
        return false;
      }
      const references =
        binding.document.successful_prerequisite_outcomes;
      if (
        references.length !== prerequisites.length
        || !references.every((reference, index) =>
          reference.ticket_id === prerequisites[index]
          && currentPrerequisiteOutcomes.get(reference.ticket_id)
            ?.document.outcome_id === reference.outcome_id)
      ) {
        return false;
      }
      return true;
    });
    visiting.delete(ticketId);
    const selected = current === undefined ? [] : [current];
    memo.set(ticketId, selected);
    return selected;
  };

  for (const ticketId of tickets.keys()) resolve(ticketId);
  return memo;
};

export const currentSuccessfulOutcomeForTicket = (
  ledger: Pick<
    TicketLedgerContent,
    "tickets" | "contextBindings" | "outcomes"
  >,
  ticketId: string,
): TicketLedgerOutcome | null =>
  currentSuccessfulOutcomes(ledger).get(ticketId)?.[0] ?? null;

export const deriveTicketLedgerState = (
  ledger: Pick<
    TicketLedgerContent,
    "tickets" | "contextBindings" | "outcomes"
  >,
): readonly TicketLedgerDerivedTicketState[] => {
  const successful = currentSuccessfulOutcomes(ledger);
  return ledger.tickets.map((ticket) => {
    const ticketId = ticket.document.ticket_id;
    const currentSuccessfulOutcome = successful.get(ticketId)?.[0] ?? null;
    const blockingTicketIds = ticket.document.relations
      .map((relation) => relation.target_ticket_id)
      .filter((prerequisiteId) =>
        (successful.get(prerequisiteId)?.length ?? 0) === 0)
      .sort(compareText);
    const hasCurrentDeviation = ledger.outcomes.some((outcome) =>
      outcome.document.subject.ticket_id === ticketId
      && outcome.document.subject.ticket_revision === ticket.ticketRevision
      && outcome.document.terminal_form === "deviated");
    const status: TicketLedgerDerivedStatus =
      currentSuccessfulOutcome !== null
        ? "DONE"
        : hasCurrentDeviation
          ? "DEVIATED"
          : blockingTicketIds.length === 0
            ? "READY"
            : "BLOCKED";
    return {
      ticketId,
      ticketRevision: ticket.ticketRevision,
      status,
      blockingTicketIds,
      currentSuccessfulOutcome,
    };
  });
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
  const contextBindingPrefix =
    `${TICKET_LEDGER_RELATIVE_PATH}/context-bindings/`;
  const evidencePrefix = `${TICKET_LEDGER_RELATIVE_PATH}/evidence/`;
  const outcomePrefix = `${TICKET_LEDGER_RELATIVE_PATH}/outcomes/`;
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
  const contextBindingFiles = documentFiles.filter((file) =>
    file.documentPath.startsWith(contextBindingPrefix));
  if (contextBindingFiles.length > TICKET_LEDGER_MAX_CONTEXT_BINDINGS) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_CONTEXT_BINDINGS} context binding files`,
      { contextBindingCount: contextBindingFiles.length },
    );
  }
  const contextBindings = contextBindingFiles.map((file) => ({
    documentPath: file.documentPath,
    document: parseYamlDocument(
      file.bytes,
      file.documentPath,
      TICKET_LEDGER_CONTEXT_BINDING_MAX_BYTES,
    ),
  }));
  const evidenceFiles = documentFiles.filter((file) =>
    file.documentPath.startsWith(evidencePrefix));
  if (evidenceFiles.length > TICKET_LEDGER_MAX_EVIDENCE) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_EVIDENCE} evidence files`,
      { evidenceCount: evidenceFiles.length },
    );
  }
  const evidence = evidenceFiles.map((file) => ({
    documentPath: file.documentPath,
    document: parseYamlDocument(
      file.bytes,
      file.documentPath,
      TICKET_LEDGER_EVIDENCE_MAX_BYTES,
    ),
  }));
  const outcomeFiles = documentFiles.filter((file) =>
    file.documentPath.startsWith(outcomePrefix));
  if (outcomeFiles.length > TICKET_LEDGER_MAX_OUTCOMES) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_OUTCOMES} outcome files`,
      { outcomeCount: outcomeFiles.length },
    );
  }
  const outcomes = outcomeFiles.map((file) => ({
    documentPath: file.documentPath,
    document: parseYamlDocument(
      file.bytes,
      file.documentPath,
      TICKET_LEDGER_OUTCOME_MAX_BYTES,
    ),
  }));
  return validateTicketLedger({
    protocol,
    tickets,
    reviews,
    decisions,
    attestations,
    contextBindings,
    evidence,
    outcomes,
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
  const scopedSemanticDirectories = [
    ["context-bindings", /^tcb-[0-9a-f]{64}\.yaml$/u],
    ["evidence", /^tev-[0-9a-f]{64}\.yaml$/u],
    ["outcomes", /^tout-[0-9a-f]{64}\.yaml$/u],
  ] as const;
  for (const [directory, filePattern] of scopedSemanticDirectories) {
    const prefix = `${TICKET_LEDGER_RELATIVE_PATH}/${directory}/`;
    if (!repositoryRelativePath.startsWith(prefix)) continue;
    const segments = repositoryRelativePath.slice(prefix.length).split("/");
    if (segments.length !== 2 || !filePattern.test(segments[1]!)) {
      return false;
    }
    try {
      ticketDocumentPath(segments[0]!);
      return true;
    } catch {
      return false;
    }
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
  if (
    documentPath.startsWith(
      `${TICKET_LEDGER_RELATIVE_PATH}/context-bindings/`,
    )
  ) {
    return TICKET_LEDGER_CONTEXT_BINDING_MAX_BYTES;
  }
  if (documentPath.startsWith(`${TICKET_LEDGER_RELATIVE_PATH}/evidence/`)) {
    return TICKET_LEDGER_EVIDENCE_MAX_BYTES;
  }
  if (documentPath.startsWith(`${TICKET_LEDGER_RELATIVE_PATH}/outcomes/`)) {
    return TICKET_LEDGER_OUTCOME_MAX_BYTES;
  }
  throw new TicketLedgerError(
    "invalid_path",
    `Unsupported Ticket ledger document path: ${documentPath}`,
    { documentPath },
  );
};
