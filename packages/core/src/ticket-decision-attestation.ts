import crypto from "node:crypto";
import {
  type TicketReviewTraceRecordV0,
} from "./contract/ticket-review.js";
import {
  canonicalTicketLedgerValue,
  projectTicketLedgerForReview,
  ticketDecisionAttestationDocumentPath,
  ticketDecisionAttestationSigningBytes,
  ticketDecisionDocumentDigest,
  type TicketDecisionAttestationDocument,
  type TicketDecisionAttestationEnvelope,
  type TicketDecisionAttestationScope,
  type TicketContextBindingDocument,
  type TicketLedgerDecision,
  type TicketLedgerDecisionAttestation,
  type TicketLedgerContextBinding,
  type TicketLedgerSnapshot,
  type TicketLedgerTicket,
  type TicketLedgerWorktreeSource,
} from "./ticket-ledger/index.js";
import {
  type TicketReviewProjectionSourceV0,
} from "./ticket-review-source.js";
import {
  assertTicketContextRefsExecutable,
} from "./ticket-context-compiler.js";

const DEFAULT_DECISION_ATTESTATION_TTL_MS = 30 * 60 * 1_000;

export type TicketDecisionAttestationUnverifiedReasonV0 =
  | "source_not_worktree"
  | "decision_not_durable"
  | "attestation_not_found"
  | "attestation_invalid"
  | "attestation_identity_mismatch"
  | "decision_binding_mismatch"
  | "authority_binding_mismatch"
  | "repository_binding_mismatch"
  | "checkout_binding_mismatch"
  | "scope_binding_mismatch"
  | "profile_unavailable"
  | "profile_mismatch"
  | "profile_revoked"
  | "timestamp_binding_mismatch"
  | "signing_key_invalid"
  | "expired"
  | "signature_invalid";

export type TicketDecisionAttestationVerificationV0 =
  | {
      status: "verified";
      verificationRef: string;
      source: "durable_local_signature" | "host_session";
    }
  | {
      status: "unverified";
      reason: TicketDecisionAttestationUnverifiedReasonV0;
      attestationId?: string;
    };

export interface TicketDecisionAttestationVerifierV0 {
  verify(
    snapshot: TicketLedgerSnapshot,
    decision: TicketLedgerDecision,
    expectedVerificationRef?: string,
  ): TicketDecisionAttestationVerificationV0;
}

export type TicketExecutionDecisionAuthorityIssueReasonV0 =
  | TicketDecisionAttestationUnverifiedReasonV0
  | "decision_set_changed"
  | "decision_binding_changed"
  | "verification_binding_changed"
  | "non_authorizing_disposition"
  | "context_ref_policy_changed";

export interface TicketExecutionDecisionAuthorityIssueV0 {
  reason: TicketExecutionDecisionAuthorityIssueReasonV0;
  message: string;
  decisionId: string | null;
  decisionType: string | null;
  disposition: string | null;
  verificationRef: string | null;
}

export interface TicketExecutionVerifiedDecisionV0 {
  decision: TicketLedgerDecision;
  verification: Extract<
    TicketDecisionAttestationVerificationV0,
    { status: "verified" }
  >;
}

export type TicketExecutionDecisionAuthorityVerificationV0 =
  | {
      status: "verified";
      decisions: readonly TicketExecutionVerifiedDecisionV0[];
    }
  | {
      status: "unverified";
      issue: TicketExecutionDecisionAuthorityIssueV0;
    };

export interface TicketExecutionDecisionAuthorityProjectionV0 {
  contextBindings: readonly TicketLedgerContextBinding[];
  issuesByContextBinding: ReadonlyMap<
    string,
    TicketExecutionDecisionAuthorityIssueV0
  >;
}

const relevantExecutionDecisions = (
  snapshot: TicketLedgerSnapshot,
  ticket: TicketLedgerTicket,
): TicketLedgerDecision[] =>
  snapshot.decisions.filter(({ document }) => {
    if (document.subject.kind === "graph") {
      return document.subject.graph_digest === snapshot.graphDigest;
    }
    return document.subject.kind === "ticket"
      && document.subject.ticket_id === ticket.document.ticket_id
      && document.subject.ticket_revision === ticket.ticketRevision;
  }).sort((left, right) =>
    compareText(left.document.decision_id, right.document.decision_id));

const decisionAuthorizesExecution = (
  decision: TicketLedgerDecision,
): boolean => decision.document.decision_type === "plan_review"
  ? decision.document.disposition !== "request_changes"
  : decision.document.disposition === "resolve";

const authorityIssue = (
  reason: TicketExecutionDecisionAuthorityIssueReasonV0,
  message: string,
  decision?: TicketLedgerDecision,
  verificationRef?: string,
): TicketExecutionDecisionAuthorityVerificationV0 => ({
  status: "unverified",
  issue: {
    reason,
    message,
    decisionId: decision?.document.decision_id ?? null,
    decisionType: decision?.document.decision_type ?? null,
    disposition: decision?.document.disposition ?? null,
    verificationRef: verificationRef ?? null,
  },
});

/**
 * Resolves the exact current Decision authority set for one Ticket. A bound
 * ContextBinding must name every currently relevant Decision, its exact
 * document digest, and the exact verification receipt that is still trusted
 * now. Repository bytes remain evidence; current execution authority does not.
 */
export function verifyTicketExecutionDecisionAuthorityV0(
  snapshot: TicketLedgerSnapshot,
  ticket: TicketLedgerTicket,
  verifier: TicketDecisionAttestationVerifierV0,
  boundDecisions?: ReadonlyArray<
    TicketContextBindingDocument["relevant_decisions"][number]
  >,
): TicketExecutionDecisionAuthorityVerificationV0 {
  const decisions = relevantExecutionDecisions(snapshot, ticket);
  if (
    boundDecisions !== undefined
    && boundDecisions.length !== decisions.length
  ) {
    return authorityIssue(
      "decision_set_changed",
      `Ticket ${ticket.document.ticket_id} Decision authority set changed`,
    );
  }

  const verified: TicketExecutionVerifiedDecisionV0[] = [];
  for (const decision of decisions) {
    const bound = boundDecisions?.find((candidate) =>
      candidate.decision_id === decision.document.decision_id);
    const decisionDigest = ticketDecisionDocumentDigest(
      decision.document,
    );
    if (
      boundDecisions !== undefined
      && (
        bound === undefined
        || bound.decision_digest !== decisionDigest
      )
    ) {
      return authorityIssue(
        "decision_binding_changed",
        `Ticket ${ticket.document.ticket_id} Decision authority binding changed`,
        decision,
        bound?.verification.verification_ref,
      );
    }
    const verification = verifier.verify(
      snapshot,
      decision,
      bound?.verification.verification_ref,
    );
    if (verification.status !== "verified") {
      return authorityIssue(
        verification.reason,
        `Ticket ${ticket.document.ticket_id} has a relevant Decision without current authority`,
        decision,
        bound?.verification.verification_ref
          ?? verification.attestationId,
      );
    }
    if (
      bound !== undefined
      && (
        verification.verificationRef
          !== bound.verification.verification_ref
        || verification.source !== bound.verification.source
      )
    ) {
      return authorityIssue(
        "verification_binding_changed",
        `Ticket ${ticket.document.ticket_id} Decision authority receipt changed`,
        decision,
        bound.verification.verification_ref,
      );
    }
    if (!decisionAuthorizesExecution(decision)) {
      return authorityIssue(
        "non_authorizing_disposition",
        `Ticket ${ticket.document.ticket_id} has a relevant Decision that does not authorize execution`,
        decision,
        verification.verificationRef,
      );
    }
    verified.push({ decision, verification });
  }
  return { status: "verified", decisions: verified };
}

/**
 * Builds the authority-aware operational view without deleting or rewriting
 * any Git-native semantic fact. Invalid ContextBindings are absent only from
 * the current execution projection, so their Outcomes remain traceable while
 * no longer satisfying DONE or unlocking dependents.
 */
export function projectTicketExecutionDecisionAuthorityV0(
  snapshot: TicketLedgerSnapshot,
  verifier: TicketDecisionAttestationVerifierV0,
): TicketExecutionDecisionAuthorityProjectionV0 {
  const tickets = new Map(snapshot.tickets.map((ticket) => [
    ticket.document.ticket_id,
    ticket,
  ]));
  const contextBindings: TicketLedgerContextBinding[] = [];
  const issuesByContextBinding = new Map<
    string,
    TicketExecutionDecisionAuthorityIssueV0
  >();
  for (const binding of snapshot.contextBindings) {
    const ticket = tickets.get(binding.document.subject.ticket_id);
    if (
      ticket === undefined
      || ticket.ticketRevision !== binding.document.subject.ticket_revision
    ) {
      // Historical bindings are never candidates for the current successful
      // Outcome and remain harmless in the mechanical derivation.
      contextBindings.push(binding);
      continue;
    }
    try {
      assertTicketContextRefsExecutable(ticket.document.context_refs);
      assertTicketContextRefsExecutable([
        ...binding.document.context_entries.map((entry) => ({
          ref: entry.ref,
          purpose: entry.purpose,
        })),
        ...binding.document.context_entries.flatMap((entry) =>
          entry.files.map((file) => ({
            ref: file.repository_path,
            purpose: `Compiled file for ${entry.ref}`,
          }))),
      ]);
      const expectedContextRefs = [...ticket.document.context_refs]
        .sort((left, right) => compareText(left.ref, right.ref));
      const boundContextRefs = binding.document.context_entries
        .map((entry) => ({
          ref: entry.ref,
          purpose: entry.purpose,
        }))
        .sort((left, right) => compareText(left.ref, right.ref));
      if (
        canonicalTicketLedgerValue(expectedContextRefs)
        !== canonicalTicketLedgerValue(boundContextRefs)
      ) {
        throw new Error(
          "ContextBinding does not exactly cover the current Ticket context refs",
        );
      }
    } catch (error) {
      issuesByContextBinding.set(
        binding.document.context_binding_id,
        {
          reason: "context_ref_policy_changed",
          message:
            `Ticket ${ticket.document.ticket_id} context reference policy changed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          decisionId: null,
          decisionType: null,
          disposition: null,
          verificationRef: null,
        },
      );
      continue;
    }
    const authority = verifyTicketExecutionDecisionAuthorityV0(
      snapshot,
      ticket,
      verifier,
      binding.document.relevant_decisions,
    );
    if (authority.status === "verified") {
      contextBindings.push(binding);
      continue;
    }
    issuesByContextBinding.set(
      binding.document.context_binding_id,
      authority.issue,
    );
  }
  return { contextBindings, issuesByContextBinding };
}

export interface TicketDecisionLocalSignatureTrustProfileLookupV0 {
  keyId: string;
  keyFingerprint: string;
  repositoryIncarnation: string;
}

/**
 * Host-owned trust material. It must be resolved from outside the repository,
 * SQLite ledger cache, browser state, and local bearer-token namespace.
 */
export interface TicketDecisionLocalSignatureTrustProfileV0 {
  keyId: string;
  keyFingerprint: string;
  publicKeySpkiPem: string;
  principalId: string;
  principalKind: "human";
  basis: "repository_owner" | "designated_human";
  basisRef: string;
  repositoryIncarnation: string;
  createdAt: string;
  revokedAt: string | null;
}

/**
 * The resolver is deliberately invoked for every verification. Callers must
 * not turn a once-read profile into a process-lifetime authority cache:
 * revocation has to affect already-running readers.
 */
export interface TicketDecisionLocalSignatureTrustProfileResolverV0 {
  resolveProfile(
    lookup: TicketDecisionLocalSignatureTrustProfileLookupV0,
  ): TicketDecisionLocalSignatureTrustProfileV0 | null;
}

export interface DurableLocalSignatureTicketDecisionAttestationVerifierOptionsV0 {
  trustProfiles: TicketDecisionLocalSignatureTrustProfileResolverV0;
}

export interface TicketDecisionSessionAttestationRegistryOptionsV0 {
  now?: () => number;
  ttlMs?: number;
}

interface TicketDecisionSessionAttestationV0 {
  sessionId: string;
  repositoryIncarnation: string;
  worktreeIdentity: string;
  worktreeRoot: string;
  branch: string | null;
  detachedCommit: string | null;
  documentPath: string;
  decisionId: string;
  documentRevision: string;
  receiptRef: string;
  expiresAt: number;
}

const sha256 = (value: string | Buffer): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const compareText = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const unverified = (
  reason: TicketDecisionAttestationUnverifiedReasonV0,
  attestation?: TicketLedgerDecisionAttestation,
): TicketDecisionAttestationVerificationV0 => ({
  status: "unverified",
  reason,
  ...(attestation === undefined
    ? {}
    : { attestationId: attestation.document.attestation_id }),
});

const decisionDocumentRevision = (
  decision: TicketLedgerDecision,
): string | null => {
  try {
    return ticketDecisionDocumentDigest(decision.document);
  } catch {
    return null;
  }
};

const decisionAttestationKey = (
  snapshot: TicketLedgerSnapshot,
  decision: TicketLedgerDecision,
): string | null => {
  if (snapshot.source.mode !== "worktree") return null;
  return canonicalTicketLedgerValue({
    repositoryIncarnation: snapshot.source.repositoryIncarnation,
    worktreeIdentity: snapshot.source.worktreeIdentity,
    worktreeRoot: snapshot.source.worktreeRoot,
    branch: snapshot.source.branch,
    detachedCommit: snapshot.source.branch === null
      ? snapshot.source.resolvedCommit
      : null,
    documentPath: decision.documentPath,
    decisionId: decision.document.decision_id,
  });
};

const exactDecisionScope = (
  decision: TicketLedgerDecision,
): TicketDecisionAttestationScope =>
  decision.document.decision_type === "plan_review"
    ? {
        scope_type: "plan_review",
        graph_digest: decision.document.subject.graph_digest,
        disposition: decision.document.disposition,
        ...(decision.document.delegated_boundaries === undefined
          ? {}
          : {
              delegated_boundaries:
                [...decision.document.delegated_boundaries],
            }),
      }
    : {
        scope_type: "protected_boundary",
        ticket_id: decision.document.subject.ticket_id,
        ticket_revision: decision.document.subject.ticket_revision,
        boundary: decision.document.boundary,
        disposition: decision.document.disposition,
        ...(decision.document.selection === undefined
          ? {}
          : { selection: decision.document.selection }),
      };

const exactAttestationEnvelope = (
  document: TicketDecisionAttestationDocument,
): TicketDecisionAttestationEnvelope => ({
  schema_version: document.schema_version,
  kind: document.kind,
  decision: { ...document.decision },
  authority: { ...document.authority },
  repository: {
    ...document.repository,
    checkout: { ...document.repository.checkout },
  },
  scope: document.scope.scope_type === "plan_review"
    ? {
        ...document.scope,
        ...(document.scope.delegated_boundaries === undefined
          ? {}
          : {
              delegated_boundaries:
                [...document.scope.delegated_boundaries],
            }),
      }
    : { ...document.scope },
  signer: { ...document.signer },
  confirmation: { ...document.confirmation },
  nonce: document.nonce,
  issued_at: document.issued_at,
});

const decodeCanonicalBase64Url = (value: string): Buffer | null => {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength > 0
        && decoded.toString("base64url") === value
      ? decoded
      : null;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTrustProfile = (
  value: unknown,
): value is TicketDecisionLocalSignatureTrustProfileV0 =>
  isRecord(value)
  && typeof value["keyId"] === "string"
  && typeof value["keyFingerprint"] === "string"
  && typeof value["publicKeySpkiPem"] === "string"
  && typeof value["principalId"] === "string"
  && value["principalKind"] === "human"
  && (
    value["basis"] === "repository_owner"
    || value["basis"] === "designated_human"
  )
  && typeof value["basisRef"] === "string"
  && typeof value["repositoryIncarnation"] === "string"
  && typeof value["createdAt"] === "string"
  && (
    value["revokedAt"] === null
    || typeof value["revokedAt"] === "string"
  );

const compareCanonical = (left: unknown, right: unknown): boolean =>
  canonicalTicketLedgerValue(left) === canonicalTicketLedgerValue(right);

const attestationCandidates = (
  snapshot: TicketLedgerSnapshot,
  decision: TicketLedgerDecision,
  expectedVerificationRef?: string,
): TicketLedgerDecisionAttestation[] =>
  snapshot.attestations
    .filter((attestation) =>
      (
        attestation.document.decision.decision_id
          === decision.document.decision_id
        || attestation.document.decision.document_path
          === decision.documentPath
      )
      && (
        expectedVerificationRef === undefined
        || attestation.document.attestation_id
          === expectedVerificationRef
      ))
    .sort((left, right) => {
      const byId = compareText(
        left.document.attestation_id,
        right.document.attestation_id,
      );
      return byId !== 0
        ? byId
        : compareText(left.documentPath, right.documentPath);
    });

/**
 * Verifies durable, repository-carried Decision evidence against a trust
 * profile that the host resolves dynamically from outside the repository.
 *
 * The repository receipt never supplies its own verification key. Its
 * signer fields are only selectors and claims, all of which must match
 * the independently resolved profile.
 */
export class DurableLocalSignatureTicketDecisionAttestationVerifierV0
implements TicketDecisionAttestationVerifierV0 {
  constructor(
    private readonly options:
    DurableLocalSignatureTicketDecisionAttestationVerifierOptionsV0,
  ) {}

  verify(
    snapshot: TicketLedgerSnapshot,
    decision: TicketLedgerDecision,
    expectedVerificationRef?: string,
  ): TicketDecisionAttestationVerificationV0 {
    if (snapshot.source.mode !== "worktree") {
      return unverified("source_not_worktree");
    }
    const revision = decisionDocumentRevision(decision);
    if (revision === null) {
      return unverified("decision_binding_mismatch");
    }
    const durableDecision = snapshot.decisions.find((candidate) =>
      candidate.documentPath === decision.documentPath
      && candidate.document.decision_id === decision.document.decision_id
      && decisionDocumentRevision(candidate) === revision);
    if (durableDecision === undefined) {
      return unverified("decision_not_durable");
    }

    const candidates = attestationCandidates(
      snapshot,
      decision,
      expectedVerificationRef,
    );
    if (candidates.length === 0) {
      return unverified("attestation_not_found");
    }
    const worktreeSnapshot = snapshot as TicketLedgerSnapshot & {
      source: TicketLedgerWorktreeSource;
    };
    let firstFailure: TicketDecisionAttestationVerificationV0 | undefined;
    for (const candidate of candidates) {
      let result: TicketDecisionAttestationVerificationV0;
      try {
        result = this.verifyCandidate(
          worktreeSnapshot,
          decision,
          candidate,
        );
      } catch {
        result = unverified("attestation_invalid", candidate);
      }
      if (result.status === "verified") return result;
      firstFailure ??= result;
    }
    return firstFailure ?? unverified("attestation_not_found");
  }

  private verifyCandidate(
    snapshot: TicketLedgerSnapshot & {
      source: TicketLedgerWorktreeSource;
    },
    decision: TicketLedgerDecision,
    attestation: TicketLedgerDecisionAttestation,
  ): TicketDecisionAttestationVerificationV0 {
    const document = attestation.document;
    const {
      attestation_id: attestationId,
      ...attestationPayload
    } = document;
    const expectedAttestationId =
      `tda-${sha256(canonicalTicketLedgerValue(attestationPayload))}`;
    if (
      attestationId !== expectedAttestationId
      || attestation.documentPath
        !== ticketDecisionAttestationDocumentPath(document)
    ) {
      return unverified("attestation_identity_mismatch", attestation);
    }
    if (
      document.decision.decision_id !== decision.document.decision_id
      || document.decision.document_path !== decision.documentPath
      || document.decision.document_digest
        !== decisionDocumentRevision(decision)
    ) {
      return unverified("decision_binding_mismatch", attestation);
    }

    const authority = decision.document.authority;
    if (
      document.authority.principal_id !== authority.principal_id
      || document.authority.principal_kind !== authority.principal_kind
      || document.authority.basis !== authority.basis
      || document.authority.basis_ref !== authority.basis_ref
    ) {
      return unverified("authority_binding_mismatch", attestation);
    }

    if (
      document.repository.repository_incarnation
        !== snapshot.source.repositoryIncarnation
      || document.repository.repository_root
        !== snapshot.source.repositoryRoot
      || document.repository.worktree_identity
        !== snapshot.source.worktreeIdentity
      || document.repository.worktree_root
        !== snapshot.source.worktreeRoot
    ) {
      return unverified("repository_binding_mismatch", attestation);
    }
    if (
      snapshot.source.branch === null
      || document.repository.checkout.branch !== snapshot.source.branch
    ) {
      return unverified("checkout_binding_mismatch", attestation);
    }
    if (!compareCanonical(document.scope, exactDecisionScope(decision))) {
      return unverified("scope_binding_mismatch", attestation);
    }

    const issuedAt = Date.parse(document.issued_at);
    const decidedAt = Date.parse(decision.document.decided_at);
    if (
      !Number.isFinite(issuedAt)
      || !Number.isFinite(decidedAt)
      || issuedAt < decidedAt
    ) {
      return unverified("timestamp_binding_mismatch", attestation);
    }

    let profile: TicketDecisionLocalSignatureTrustProfileV0 | null;
    try {
      profile = this.options.trustProfiles.resolveProfile({
        keyId: document.signer.key_id,
        keyFingerprint: document.signer.key_fingerprint,
        repositoryIncarnation:
          document.repository.repository_incarnation,
      });
    } catch {
      return unverified("profile_unavailable", attestation);
    }
    if (profile === null) {
      return unverified("profile_unavailable", attestation);
    }
    if (!isTrustProfile(profile)) {
      return unverified("profile_mismatch", attestation);
    }
    if (
      profile.keyId !== document.signer.key_id
      || profile.keyFingerprint !== document.signer.key_fingerprint
      || profile.principalId !== document.authority.principal_id
      || profile.principalKind !== document.authority.principal_kind
      || profile.basis !== document.authority.basis
      || profile.basisRef !== document.authority.basis_ref
      || profile.repositoryIncarnation
        !== document.repository.repository_incarnation
    ) {
      return unverified("profile_mismatch", attestation);
    }
    const profileCreatedAt = Date.parse(profile.createdAt);
    if (
      !Number.isFinite(profileCreatedAt)
      || issuedAt < profileCreatedAt
    ) {
      return unverified("profile_mismatch", attestation);
    }
    if (profile.revokedAt !== null) {
      return unverified("profile_revoked", attestation);
    }

    let publicKey: crypto.KeyObject;
    try {
      publicKey = crypto.createPublicKey(profile.publicKeySpkiPem);
      if (publicKey.asymmetricKeyType !== "ed25519") {
        return unverified("signing_key_invalid", attestation);
      }
      const spki = publicKey.export({
        type: "spki",
        format: "der",
      });
      if (sha256(spki) !== profile.keyFingerprint) {
        return unverified("signing_key_invalid", attestation);
      }
    } catch {
      return unverified("signing_key_invalid", attestation);
    }

    const signature = decodeCanonicalBase64Url(document.signature);
    if (signature === null || signature.byteLength !== 64) {
      return unverified("signature_invalid", attestation);
    }
    try {
      if (!crypto.verify(
        null,
        ticketDecisionAttestationSigningBytes(
          exactAttestationEnvelope(document),
        ),
        publicKey,
        signature,
      )) {
        return unverified("signature_invalid", attestation);
      }
    } catch {
      return unverified("signature_invalid", attestation);
    }
    return {
      status: "verified",
      verificationRef: document.attestation_id,
      source: "durable_local_signature",
    };
  }
}

export class CompositeTicketDecisionAttestationVerifierV0
implements TicketDecisionAttestationVerifierV0 {
  constructor(
    private readonly verifiers:
    readonly TicketDecisionAttestationVerifierV0[],
  ) {}

  verify(
    snapshot: TicketLedgerSnapshot,
    decision: TicketLedgerDecision,
    expectedVerificationRef?: string,
  ): TicketDecisionAttestationVerificationV0 {
    let firstFailure: TicketDecisionAttestationVerificationV0 | undefined;
    let lastFailure: TicketDecisionAttestationVerificationV0 | undefined;
    for (const verifier of this.verifiers) {
      const result = verifier.verify(
        snapshot,
        decision,
        expectedVerificationRef,
      );
      if (result.status === "verified") return result;
      firstFailure ??= result;
      lastFailure = result;
    }
    // Durable receipt refs (`tda-`) are handled by the first verifier in the
    // production composite, while process-local refs (`tdsa-`) are handled by
    // the session registry that follows it. Preserve the relevant verifier's
    // exact expired/identity failure instead of masking it with an unrelated
    // durable `attestation_not_found`.
    return expectedVerificationRef?.startsWith("tdsa-") === true
      ? lastFailure ?? unverified("attestation_not_found")
      : firstFailure ?? unverified("attestation_not_found");
  }
}

/**
 * Process-local authority capability for Decisions written through one trusted
 * host session. Durable Decision documents remain review artifacts by default;
 * this registry deliberately does not survive a dispatcher/host restart.
 *
 * This module is internal to Core and is not exported from the package root.
 */
export class InMemoryTicketDecisionSessionAttestationRegistryV0
implements TicketDecisionAttestationVerifierV0 {
  private readonly sessionId = crypto.randomUUID();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly entries =
    new Map<string, TicketDecisionSessionAttestationV0>();

  constructor(
    options: TicketDecisionSessionAttestationRegistryOptionsV0 = {},
  ) {
    const ttlMs = options.ttlMs
      ?? DEFAULT_DECISION_ATTESTATION_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError("Decision attestation ttlMs must be positive");
    }
    this.now = options.now ?? Date.now;
    this.ttlMs = ttlMs;
  }

  attest(
    snapshot: TicketLedgerSnapshot,
    decision: TicketLedgerDecision,
  ): boolean {
    const key = decisionAttestationKey(snapshot, decision);
    if (key === null || snapshot.source.mode !== "worktree") return false;
    const revision = decisionDocumentRevision(decision);
    if (revision === null) return false;
    const durable = snapshot.decisions.find((candidate) =>
      candidate.documentPath === decision.documentPath
      && candidate.document.decision_id === decision.document.decision_id
      && decisionDocumentRevision(candidate) === revision);
    if (durable === undefined) return false;
    const now = this.now();
    const expiresAt = now + this.ttlMs;
    this.entries.set(key, {
      sessionId: this.sessionId,
      repositoryIncarnation: snapshot.source.repositoryIncarnation,
      worktreeIdentity: snapshot.source.worktreeIdentity,
      worktreeRoot: snapshot.source.worktreeRoot,
      branch: snapshot.source.branch,
      detachedCommit: snapshot.source.branch === null
        ? snapshot.source.resolvedCommit
        : null,
      documentPath: decision.documentPath,
      decisionId: decision.document.decision_id,
      documentRevision: revision,
      receiptRef: `tdsa-${sha256(canonicalTicketLedgerValue({
        sessionId: this.sessionId,
        key,
        revision,
        expiresAt,
      }))}`,
      expiresAt,
    });
    return true;
  }

  verify(
    snapshot: TicketLedgerSnapshot,
    decision: TicketLedgerDecision,
    expectedVerificationRef?: string,
  ): TicketDecisionAttestationVerificationV0 {
    const key = decisionAttestationKey(snapshot, decision);
    if (key === null || snapshot.source.mode !== "worktree") {
      return unverified("source_not_worktree");
    }
    const entry = this.entries.get(key);
    if (entry === undefined) return unverified("attestation_not_found");
    if (
      expectedVerificationRef !== undefined
      && entry.receiptRef !== expectedVerificationRef
    ) {
      return unverified("attestation_identity_mismatch");
    }
    const now = this.now();
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return unverified("expired");
    }
    if (
      entry.sessionId !== this.sessionId
      || entry.repositoryIncarnation
        !== snapshot.source.repositoryIncarnation
      || entry.worktreeIdentity !== snapshot.source.worktreeIdentity
      || entry.worktreeRoot !== snapshot.source.worktreeRoot
      || entry.branch !== snapshot.source.branch
      || entry.detachedCommit !== (snapshot.source.branch === null
        ? snapshot.source.resolvedCommit
        : null)
      || entry.documentPath !== decision.documentPath
      || entry.decisionId !== decision.document.decision_id
      || entry.documentRevision !== decisionDocumentRevision(decision)
    ) {
      return unverified("decision_binding_mismatch");
    }
    return {
      status: "verified",
      verificationRef: entry.receiptRef,
      source: "host_session",
    };
  }
}

export function projectTicketLedgerForTrustedDecisionHostV0(
  snapshot: TicketLedgerSnapshot,
  verifier: TicketDecisionAttestationVerifierV0,
): TicketReviewProjectionSourceV0 {
  const executionAuthority =
    projectTicketExecutionDecisionAuthorityV0(snapshot, verifier);
  const source = projectTicketLedgerForReview(snapshot, {
    contextBindings: executionAuthority.contextBindings,
    issuesByContextBinding:
      executionAuthority.issuesByContextBinding,
  });
  const decisions = new Map(snapshot.decisions.map((decision) => [
    decision.document.decision_id,
    decision,
  ]));
  return {
    ...source,
    traceRecords: source.traceRecords.map(
      (record): TicketReviewTraceRecordV0 => {
        if (
          record.kind !== "artifact"
          || record.status !== "current_unverified"
          || record.decision === undefined
        ) {
          return record;
        }
        const decision = decisions.get(record.recordRef);
        if (decision === undefined) return record;
        const verification = verifier.verify(snapshot, decision);
        if (verification.status !== "verified") return record;
        return {
          ...record,
          kind: "gate_decision",
          producer: {
            kind: "authority_receipt",
            ref: verification.verificationRef,
          },
          status: "current",
        };
      },
    ),
  };
}
