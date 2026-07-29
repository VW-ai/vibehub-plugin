import {
  TICKET_REVIEW_SCHEMA_VERSION,
} from "../contract/ticket-review.js";
import {
  type TicketReviewProjectionSourceV0,
} from "../ticket-review-source.js";
import { ticketRelationId } from "./codec.js";
import { type TicketLedgerSnapshot } from "./contract.js";

const sha256Ref = (digest: string): string => `sha256:${digest}`;

/**
 * Mechanical adapter from one validated Git Ticket ledger snapshot into the
 * storage-agnostic review source. It adds no readiness, workflow, or planning
 * judgment.
 */
export function projectTicketLedgerForReview(
  snapshot: TicketLedgerSnapshot,
): TicketReviewProjectionSourceV0 {
  const source = snapshot.source.mode === "worktree"
    ? {
        mode: "worktree" as const,
        repositoryRoot: snapshot.source.repositoryRoot,
        repositoryIncarnation: snapshot.source.repositoryIncarnation,
        resolvedCommit: snapshot.source.resolvedCommit,
        graphDigest: sha256Ref(snapshot.source.graphDigest),
        sourceToken: snapshot.source.sourceToken,
        worktreeIdentity: snapshot.source.worktreeIdentity,
        worktreeRoot: snapshot.source.worktreeRoot,
        branch: snapshot.source.branch,
        committedGraphDigest: snapshot.source.committedGraphDigest === null
          ? null
          : sha256Ref(snapshot.source.committedGraphDigest),
        semanticDirty: snapshot.source.semanticDirty,
        dirtyPaths: [...snapshot.source.dirtyPaths],
        dirtyPathsTruncated: snapshot.source.dirtyPathsTruncated,
      }
    : {
        mode: "ref" as const,
        repositoryRoot: snapshot.source.repositoryRoot,
        repositoryIncarnation: snapshot.source.repositoryIncarnation,
        resolvedCommit: snapshot.source.resolvedCommit,
        graphDigest: sha256Ref(snapshot.source.graphDigest),
        sourceToken: snapshot.source.sourceToken,
        requestedRef: snapshot.source.requestedRef,
      };
  return {
    schemaVersion: TICKET_REVIEW_SCHEMA_VERSION,
    snapshotRevision: snapshot.source.sourceToken,
    projectionWatermark: sha256Ref(snapshot.source.graphDigest),
    source,
    ticketDefinitions: snapshot.tickets.map((ticket) => ({
      ticketId: ticket.document.ticket_id,
      ticketRevision: sha256Ref(ticket.ticketRevision),
      outcome: ticket.document.outcome,
      context: ticket.document.context,
      acceptance: ticket.document.acceptance.map((item) => ({
        acceptanceId: item.acceptance_id,
        criterion: item.criterion,
      })),
      constraints: [...ticket.document.constraints],
      contextRefs: ticket.document.context_refs.map((item) => ({
        ref: item.ref,
        purpose: item.purpose,
      })),
      provenanceRefs: [...ticket.document.provenance_refs],
    })),
    directUnlocks: snapshot.tickets.flatMap((ticket) =>
      ticket.document.relations.map((relation) => ({
        relationRef: ticketRelationId(ticket.document.ticket_id, relation),
        prerequisiteTicketId: relation.target_ticket_id,
        dependentTicketId: ticket.document.ticket_id,
        ...(relation.rationale === undefined
          ? {}
          : { rationale: relation.rationale }),
        provenanceRefs: [...ticket.document.provenance_refs],
      }))),
    currentCapabilityProjections: [],
    traceRecords: [],
  };
}
