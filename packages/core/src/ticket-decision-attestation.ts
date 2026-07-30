import crypto from "node:crypto";
import {
  type TicketReviewTraceRecordV0,
} from "./contract/ticket-review.js";
import {
  canonicalTicketLedgerValue,
  projectTicketLedgerForReview,
  type TicketLedgerDecision,
  type TicketLedgerSnapshot,
} from "./ticket-ledger/index.js";
import {
  type TicketReviewProjectionSourceV0,
} from "./ticket-review-source.js";

const DEFAULT_DECISION_ATTESTATION_TTL_MS = 30 * 60 * 1_000;

export interface TicketDecisionAttestationVerifierV0 {
  verificationRef(
    snapshot: TicketLedgerSnapshot,
    decision: TicketLedgerDecision,
  ): string | null;
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

const sha256 = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const decisionDocumentRevision = (
  decision: TicketLedgerDecision,
): string => sha256(canonicalTicketLedgerValue(decision.document));

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

  verificationRef(
    snapshot: TicketLedgerSnapshot,
    decision: TicketLedgerDecision,
  ): string | null {
    const key = decisionAttestationKey(snapshot, decision);
    if (key === null || snapshot.source.mode !== "worktree") return null;
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    const now = this.now();
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return entry.sessionId === this.sessionId
        && entry.repositoryIncarnation
          === snapshot.source.repositoryIncarnation
        && entry.worktreeIdentity === snapshot.source.worktreeIdentity
        && entry.worktreeRoot === snapshot.source.worktreeRoot
        && entry.branch === snapshot.source.branch
        && entry.detachedCommit === (snapshot.source.branch === null
          ? snapshot.source.resolvedCommit
          : null)
        && entry.documentPath === decision.documentPath
        && entry.decisionId === decision.document.decision_id
        && entry.documentRevision === decisionDocumentRevision(decision)
      ? entry.receiptRef
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
        const verificationRef = verifier.verificationRef(
          snapshot,
          decision,
        );
        if (verificationRef === null) return record;
        return {
          ...record,
          kind: "gate_decision",
          producer: {
            kind: "authority_receipt",
            ref: verificationRef,
          },
          status: "current",
        };
      },
    ),
  };
}
