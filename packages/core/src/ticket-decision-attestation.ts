import crypto from "node:crypto";
import { TextDecoder } from "node:util";
import {
  type TicketReviewTraceRecordV0,
} from "./contract/ticket-review.js";
import {
  canonicalTicketLedgerValue,
  projectTicketLedgerForReview,
  ticketDecisionAttestationChallenge,
  ticketDecisionAttestationDocumentPath,
  ticketDecisionDocumentDigest,
  type TicketDecisionAttestationDocument,
  type TicketDecisionAttestationEnvelope,
  type TicketDecisionAttestationScope,
  type TicketLedgerDecision,
  type TicketLedgerDecisionAttestation,
  type TicketLedgerSnapshot,
  type TicketLedgerWorktreeSource,
} from "./ticket-ledger/index.js";
import {
  type TicketReviewProjectionSourceV0,
} from "./ticket-review-source.js";

const DEFAULT_DECISION_ATTESTATION_TTL_MS = 30 * 60 * 1_000;
const WEBAUTHN_RP_ID = "localhost";
const WEBAUTHN_TYPE = "webauthn.get";
const AUTHENTICATOR_DATA_MIN_BYTES = 37;
const AUTHENTICATOR_FLAGS_OFFSET = 32;
const AUTHENTICATOR_FLAG_USER_PRESENT = 0x01;
const AUTHENTICATOR_FLAG_USER_VERIFIED = 0x04;
const utf8 = new TextDecoder("utf-8", { fatal: true });

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
  | "not_yet_valid"
  | "expired"
  | "webauthn_policy_mismatch"
  | "client_data_invalid"
  | "challenge_mismatch"
  | "origin_mismatch"
  | "cross_origin"
  | "rp_id_hash_mismatch"
  | "user_presence_required"
  | "user_verification_required"
  | "credential_public_key_invalid"
  | "signature_invalid";

export type TicketDecisionAttestationVerificationV0 =
  | {
      status: "verified";
      verificationRef: string;
      source: "durable_webauthn" | "host_session";
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
  ): TicketDecisionAttestationVerificationV0;
}

export interface TicketDecisionAttestationTrustProfileLookupV0 {
  credentialId: string;
  credentialFingerprint: string;
  repositoryIncarnation: string;
}

/**
 * Host-owned trust material. It must be resolved from outside the repository,
 * SQLite ledger cache, browser state, and local bearer-token namespace.
 */
export interface TicketDecisionAttestationTrustProfileV0 {
  credentialId: string;
  credentialFingerprint: string;
  publicKeySpkiPem: string;
  principalId: string;
  principalKind: "human";
  basis: "repository_owner" | "designated_human";
  basisRef: string;
  repositoryIncarnation: string;
  revokedAt: string | null;
}

/**
 * The resolver is deliberately invoked for every verification. Callers must
 * not turn a once-read profile into a process-lifetime authority cache:
 * revocation has to affect already-running readers.
 */
export interface TicketDecisionAttestationTrustProfileResolverV0 {
  resolveProfile(
    lookup: TicketDecisionAttestationTrustProfileLookupV0,
  ): TicketDecisionAttestationTrustProfileV0 | null;
}

export interface DurableWebAuthnTicketDecisionAttestationVerifierOptionsV0 {
  trustProfiles: TicketDecisionAttestationTrustProfileResolverV0;
  now?: () => number;
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

const sha256Bytes = (value: string | Buffer): Buffer =>
  crypto.createHash("sha256").update(value).digest();

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
  credential: { ...document.credential },
  webauthn: {
    rp_id: document.webauthn.rp_id,
    origin: document.webauthn.origin,
    algorithm: document.webauthn.algorithm,
  },
  nonce: document.nonce,
  issued_at: document.issued_at,
  not_before: document.not_before,
  expires_at: document.expires_at,
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
): value is TicketDecisionAttestationTrustProfileV0 =>
  isRecord(value)
  && typeof value["credentialId"] === "string"
  && typeof value["credentialFingerprint"] === "string"
  && typeof value["publicKeySpkiPem"] === "string"
  && typeof value["principalId"] === "string"
  && value["principalKind"] === "human"
  && (
    value["basis"] === "repository_owner"
    || value["basis"] === "designated_human"
  )
  && typeof value["basisRef"] === "string"
  && typeof value["repositoryIncarnation"] === "string"
  && (
    value["revokedAt"] === null
    || typeof value["revokedAt"] === "string"
  );

const equalBytes = (left: Buffer, right: Buffer): boolean =>
  left.byteLength === right.byteLength
    && crypto.timingSafeEqual(left, right);

const compareCanonical = (left: unknown, right: unknown): boolean =>
  canonicalTicketLedgerValue(left) === canonicalTicketLedgerValue(right);

const isExactLocalhostOrigin = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.hostname === WEBAUTHN_RP_ID
      && parsed.username === ""
      && parsed.password === ""
      && parsed.origin === value;
  } catch {
    return false;
  }
};

const attestationCandidates = (
  snapshot: TicketLedgerSnapshot,
  decision: TicketLedgerDecision,
): TicketLedgerDecisionAttestation[] =>
  snapshot.attestations
    .filter((attestation) =>
      attestation.document.decision.decision_id
        === decision.document.decision_id
      || attestation.document.decision.document_path
        === decision.documentPath)
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
 * credential fields are only selectors and claims, all of which must match
 * the independently resolved profile.
 */
export class DurableWebAuthnTicketDecisionAttestationVerifierV0
implements TicketDecisionAttestationVerifierV0 {
  private readonly now: () => number;

  constructor(
    private readonly options:
    DurableWebAuthnTicketDecisionAttestationVerifierOptionsV0,
  ) {
    this.now = options.now ?? Date.now;
  }

  verify(
    snapshot: TicketLedgerSnapshot,
    decision: TicketLedgerDecision,
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

    const candidates = attestationCandidates(snapshot, decision);
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
        ? document.repository.checkout.mode !== "detached"
          || document.repository.checkout.commit
            !== snapshot.source.resolvedCommit
        : document.repository.checkout.mode !== "branch"
          || document.repository.checkout.branch !== snapshot.source.branch
    ) {
      return unverified("checkout_binding_mismatch", attestation);
    }
    if (!compareCanonical(document.scope, exactDecisionScope(decision))) {
      return unverified("scope_binding_mismatch", attestation);
    }

    const issuedAt = Date.parse(document.issued_at);
    const notBefore = Date.parse(document.not_before);
    const expiresAt = Date.parse(document.expires_at);
    const decidedAt = Date.parse(decision.document.decided_at);
    const now = this.now();
    if (
      !Number.isFinite(issuedAt)
      || !Number.isFinite(notBefore)
      || !Number.isFinite(expiresAt)
      || !Number.isFinite(decidedAt)
      || issuedAt < decidedAt
      || now < issuedAt
      || now < notBefore
    ) {
      return unverified("not_yet_valid", attestation);
    }
    if (now >= expiresAt) {
      return unverified("expired", attestation);
    }

    let profile: TicketDecisionAttestationTrustProfileV0 | null;
    try {
      profile = this.options.trustProfiles.resolveProfile({
        credentialId: document.credential.credential_id,
        credentialFingerprint: document.credential.fingerprint,
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
      profile.credentialId !== document.credential.credential_id
      || profile.credentialFingerprint
        !== document.credential.fingerprint
      || profile.principalId !== document.authority.principal_id
      || profile.principalKind !== document.authority.principal_kind
      || profile.basis !== document.authority.basis
      || profile.basisRef !== document.authority.basis_ref
      || profile.repositoryIncarnation
        !== document.repository.repository_incarnation
    ) {
      return unverified("profile_mismatch", attestation);
    }
    if (profile.revokedAt !== null) {
      return unverified("profile_revoked", attestation);
    }

    const clientDataBytes = decodeCanonicalBase64Url(
      document.webauthn.client_data_json,
    );
    const authenticatorData = decodeCanonicalBase64Url(
      document.webauthn.authenticator_data,
    );
    const signature = decodeCanonicalBase64Url(
      document.webauthn.signature,
    );
    if (
      clientDataBytes === null
      || authenticatorData === null
      || authenticatorData.byteLength < AUTHENTICATOR_DATA_MIN_BYTES
      || signature === null
    ) {
      return unverified("client_data_invalid", attestation);
    }
    if (
      document.webauthn.rp_id !== WEBAUTHN_RP_ID
      || document.webauthn.algorithm !== "ES256"
      || !isExactLocalhostOrigin(document.webauthn.origin)
    ) {
      return unverified("webauthn_policy_mismatch", attestation);
    }

    let clientData: unknown;
    try {
      clientData = JSON.parse(utf8.decode(clientDataBytes));
    } catch {
      return unverified("client_data_invalid", attestation);
    }
    if (
      !isRecord(clientData)
      || clientData["type"] !== WEBAUTHN_TYPE
      || typeof clientData["challenge"] !== "string"
      || typeof clientData["origin"] !== "string"
      || typeof clientData["crossOrigin"] !== "boolean"
    ) {
      return unverified("client_data_invalid", attestation);
    }
    let expectedChallenge: string;
    try {
      expectedChallenge = ticketDecisionAttestationChallenge(
        exactAttestationEnvelope(document),
      );
    } catch {
      return unverified("challenge_mismatch", attestation);
    }
    if (clientData["challenge"] !== expectedChallenge) {
      return unverified("challenge_mismatch", attestation);
    }
    if (clientData["origin"] !== document.webauthn.origin) {
      return unverified("origin_mismatch", attestation);
    }
    if (clientData["crossOrigin"] !== false) {
      return unverified("cross_origin", attestation);
    }

    const expectedRpIdHash = sha256Bytes(WEBAUTHN_RP_ID);
    if (!equalBytes(
      authenticatorData.subarray(0, expectedRpIdHash.byteLength),
      expectedRpIdHash,
    )) {
      return unverified("rp_id_hash_mismatch", attestation);
    }
    const flags = authenticatorData[AUTHENTICATOR_FLAGS_OFFSET]!;
    if ((flags & AUTHENTICATOR_FLAG_USER_PRESENT) === 0) {
      return unverified("user_presence_required", attestation);
    }
    if ((flags & AUTHENTICATOR_FLAG_USER_VERIFIED) === 0) {
      return unverified("user_verification_required", attestation);
    }

    let publicKey: crypto.KeyObject;
    try {
      publicKey = crypto.createPublicKey(profile.publicKeySpkiPem);
      const details = publicKey.asymmetricKeyDetails;
      if (
        publicKey.asymmetricKeyType !== "ec"
        || (details?.namedCurve !== "prime256v1"
          && details?.namedCurve !== "P-256")
      ) {
        return unverified(
          "credential_public_key_invalid",
          attestation,
        );
      }
      const spki = publicKey.export({
        type: "spki",
        format: "der",
      });
      if (sha256(spki) !== profile.credentialFingerprint) {
        return unverified(
          "credential_public_key_invalid",
          attestation,
        );
      }
    } catch {
      return unverified("credential_public_key_invalid", attestation);
    }

    const signedBytes = Buffer.concat([
      authenticatorData,
      sha256Bytes(clientDataBytes),
    ]);
    try {
      if (!crypto.verify("sha256", signedBytes, publicKey, signature)) {
        return unverified("signature_invalid", attestation);
      }
    } catch {
      return unverified("signature_invalid", attestation);
    }
    return {
      status: "verified",
      verificationRef: document.attestation_id,
      source: "durable_webauthn",
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
  ): TicketDecisionAttestationVerificationV0 {
    let firstFailure: TicketDecisionAttestationVerificationV0 | undefined;
    for (const verifier of this.verifiers) {
      const result = verifier.verify(snapshot, decision);
      if (result.status === "verified") return result;
      firstFailure ??= result;
    }
    return firstFailure ?? unverified("attestation_not_found");
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
  ): TicketDecisionAttestationVerificationV0 {
    const key = decisionAttestationKey(snapshot, decision);
    if (key === null || snapshot.source.mode !== "worktree") {
      return unverified("source_not_worktree");
    }
    const entry = this.entries.get(key);
    if (entry === undefined) return unverified("attestation_not_found");
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

  /** Backward-compatible convenience for internal callers. */
  verificationRef(
    snapshot: TicketLedgerSnapshot,
    decision: TicketLedgerDecision,
  ): string | null {
    const result = this.verify(snapshot, decision);
    return result.status === "verified"
      ? result.verificationRef
      : null;
  }
}

export function projectTicketLedgerForTrustedDecisionHostV0(
  snapshot: TicketLedgerSnapshot,
  verifier: TicketDecisionAttestationVerifierV0,
): TicketReviewProjectionSourceV0 {
  const source = projectTicketLedgerForReview(snapshot);
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
