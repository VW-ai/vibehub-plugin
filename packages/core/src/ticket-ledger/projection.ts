import {
  TICKET_REVIEW_SCHEMA_VERSION,
  type TicketReviewTraceRecordV0,
  type TicketReviewTraceSubjectV0,
} from "../contract/ticket-review.js";
import {
  type TicketReviewProjectionSourceV0,
} from "../ticket-review-source.js";
import {
  ticketRelationId,
} from "./codec.js";
import {
  type TicketDecisionDocument,
  type TicketLedgerSnapshot,
  type TicketReviewDocument,
  type TicketReviewSubject,
} from "./contract.js";

const sha256Ref = (digest: string): string => `sha256:${digest}`;
const truncate = (value: string, maximum: number): string =>
  [...value].slice(0, maximum).join("");

interface ReviewLocus {
  subject: TicketReviewTraceSubjectV0;
  current: boolean;
  references: string[];
}

const reviewLocus = (
  snapshot: TicketLedgerSnapshot,
  subject: TicketReviewSubject,
): ReviewLocus => {
  if (subject.kind === "graph") {
    return {
      subject: { kind: "graph" },
      current: subject.graph_digest === snapshot.graphDigest,
      references: [sha256Ref(subject.graph_digest)],
    };
  }
  if (subject.kind === "ticket") {
    const ticket = snapshot.tickets.find((candidate) =>
      candidate.document.ticket_id === subject.ticket_id);
    return {
      subject: ticket === undefined
        ? { kind: "graph" }
        : {
            kind: "ticket",
            ticketId: ticket.document.ticket_id,
            boundTicketRevision: sha256Ref(ticket.ticketRevision),
          },
      current: ticket?.ticketRevision === subject.ticket_revision,
      references: [
        subject.ticket_id,
        sha256Ref(subject.ticket_revision),
      ],
    };
  }

  const dependent = snapshot.tickets.find((candidate) =>
    candidate.document.ticket_id === subject.dependent_ticket_id);
  const relation = dependent?.document.relations.find((candidate) =>
    candidate.target_ticket_id === subject.prerequisite_ticket_id
    && ticketRelationId(dependent.document.ticket_id, candidate)
      === subject.relation_ref);
  return {
    subject: relation === undefined || dependent === undefined
      ? { kind: "graph" }
      : {
          kind: "relation",
          relationRef: subject.relation_ref,
          prerequisiteTicketId: subject.prerequisite_ticket_id,
          dependentTicketId: subject.dependent_ticket_id,
        },
    current: relation !== undefined
      && dependent?.ticketRevision === subject.dependent_ticket_revision,
    references: [
      subject.relation_ref,
      subject.prerequisite_ticket_id,
      subject.dependent_ticket_id,
      sha256Ref(subject.dependent_ticket_revision),
    ],
  };
};

const reviewTraceRecord = (
  snapshot: TicketLedgerSnapshot,
  review: {
    documentPath: string;
    document: TicketReviewDocument;
  },
): TicketReviewTraceRecordV0 => {
  const locus = reviewLocus(snapshot, review.document.subject);
  const edit = review.document.review_type === "ticket_edit";
  const actor = truncate(review.document.author.actor_id, 240);
  return {
    recordRef: review.document.review_id,
    kind: "artifact",
    subkind: edit ? "ticket_edit" : "comment",
    subject: locus.subject,
    producer: {
      kind: "claimed_actor",
      ref: review.document.review_id,
    },
    occurredAt: review.document.occurred_at,
    summary: edit
      ? `Ticket edit proposal from ${actor}`
      : `Review comment from ${actor}`,
    body: review.document.body,
    status: `${locus.current ? "current" : "historical"}_${
      review.document.author.attribution
    }`,
    crossReferences: locus.references,
    targets: [{
      kind: "repo_path",
      label: "Review document",
      target: review.documentPath,
    }],
    availability: "available",
  };
};

const decisionTraceRecord = (
  snapshot: TicketLedgerSnapshot,
  decision: {
    documentPath: string;
    document: TicketDecisionDocument;
  },
): TicketReviewTraceRecordV0 => {
  const locus = reviewLocus(snapshot, decision.document.subject);
  const current = locus.current;
  const principal = truncate(
    decision.document.authority.principal_id,
    220,
  );
  const details = decision.document.decision_type === "plan_review"
    ? {
        decisionType: "plan_review" as const,
        disposition: decision.document.disposition,
        ...(decision.document.delegated_boundaries === undefined
          ? {}
          : {
              delegatedBoundaries: [
                ...decision.document.delegated_boundaries,
              ],
            }),
        resolutionRefs: [...decision.document.resolution_refs],
      }
    : {
        decisionType: "protected_boundary" as const,
        boundary: decision.document.boundary,
        disposition: decision.document.disposition,
        ...(decision.document.selection === undefined
          ? {}
          : { selection: decision.document.selection }),
        resolutionRefs: [...decision.document.resolution_refs],
      };
  return {
    recordRef: decision.document.decision_id,
    kind: "artifact",
    subkind: decision.document.decision_type,
    subject: locus.subject,
    producer: {
      kind: "receipt",
      ref: decision.document.decision_id,
    },
    occurredAt: decision.document.decided_at,
    summary: `${decision.document.disposition} by ${principal}`,
    body: decision.document.rationale,
    status: current
      ? "current_unverified"
      : "historical",
    decision: details,
    crossReferences: locus.references,
    targets: [{
      kind: "repo_path",
      label: "Decision document",
      target: decision.documentPath,
    }],
    availability: "available",
  };
};

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
        semanticLedgerDigest:
          sha256Ref(snapshot.source.semanticLedgerDigest),
        sourceToken: snapshot.source.sourceToken,
        worktreeIdentity: snapshot.source.worktreeIdentity,
        worktreeRoot: snapshot.source.worktreeRoot,
        branch: snapshot.source.branch,
        committedGraphDigest: snapshot.source.committedGraphDigest === null
          ? null
          : sha256Ref(snapshot.source.committedGraphDigest),
        committedSemanticLedgerDigest:
          snapshot.source.committedSemanticLedgerDigest === null
            ? null
            : sha256Ref(snapshot.source.committedSemanticLedgerDigest),
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
        semanticLedgerDigest:
          sha256Ref(snapshot.source.semanticLedgerDigest),
        sourceToken: snapshot.source.sourceToken,
        requestedRef: snapshot.source.requestedRef,
      };
  return {
    schemaVersion: TICKET_REVIEW_SCHEMA_VERSION,
    snapshotRevision: snapshot.source.sourceToken,
    projectionWatermark: sha256Ref(snapshot.source.semanticLedgerDigest),
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
    traceRecords: [
      ...snapshot.reviews.map((review) =>
        reviewTraceRecord(snapshot, review)),
      ...snapshot.decisions.map((decision) =>
        decisionTraceRecord(snapshot, decision)),
    ],
  };
}
