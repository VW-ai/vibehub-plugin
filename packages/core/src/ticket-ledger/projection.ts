import {
  TICKET_REVIEW_SCHEMA_VERSION,
  type TicketReviewTraceRecordV0,
  type TicketReviewTraceSubjectV0,
} from "../contract/ticket-review.js";
import {
  type TicketReviewProjectionSourceV0,
  type TicketReviewCurrentCapabilityProjectionV0,
} from "../ticket-review-source.js";
import {
  deriveTicketLedgerState,
  ticketRelationId,
} from "./codec.js";
import {
  type TicketContextBindingDocument,
  type TicketDecisionDocument,
  type TicketEvidenceDocument,
  type TicketLedgerContextBinding,
  type TicketLedgerSnapshot,
  type TicketOutcomeDocument,
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

const executionSubject = (
  snapshot: TicketLedgerSnapshot,
  subject: { ticket_id: string; ticket_revision: string },
): {
  subject: TicketReviewTraceSubjectV0;
  current: boolean;
} => {
  const ticket = snapshot.tickets.find((candidate) =>
    candidate.document.ticket_id === subject.ticket_id);
  return {
    subject: {
      kind: "ticket",
      ticketId: subject.ticket_id,
      boundTicketRevision: sha256Ref(subject.ticket_revision),
    },
    current: ticket?.ticketRevision === subject.ticket_revision,
  };
};

const contextBindingTraceRecord = (
  snapshot: TicketLedgerSnapshot,
  item: {
    documentPath: string;
    document: TicketContextBindingDocument;
  },
): TicketReviewTraceRecordV0 => {
  const locus = executionSubject(snapshot, item.document.subject);
  return {
    recordRef: item.document.context_binding_id,
    kind: "context_binding",
    subkind: "compiled_context",
    subject: locus.subject,
    producer: {
      kind: "system",
      ref: item.document.context_binding_id,
    },
    occurredAt: item.document.compiled_at,
    summary: `Compiled ${item.document.context_entries.length} bounded context ${
      item.document.context_entries.length === 1 ? "entry" : "entries"
    }`,
    status: locus.current ? "current" : "historical",
    crossReferences: [
      sha256Ref(item.document.graph_digest),
      item.document.packet_digest,
      item.document.repository.repository_source_digest,
      ...item.document.successful_prerequisite_outcomes.map(
        (reference) => reference.outcome_id,
      ),
      ...item.document.relevant_decisions.map(
        (reference) => reference.decision_id,
      ),
      ...item.document.relevant_decisions.map(
        (reference) => reference.verification.verification_ref,
      ),
    ],
    targets: [{
      kind: "repo_path",
      label: "Context binding",
      target: item.documentPath,
    }],
    availability: "available",
  };
};

const evidenceTraceRecord = (
  snapshot: TicketLedgerSnapshot,
  item: {
    documentPath: string;
    document: TicketEvidenceDocument;
  },
): TicketReviewTraceRecordV0 => {
  const locus = executionSubject(snapshot, item.document.subject);
  return {
    recordRef: item.document.evidence_id,
    kind: "evidence",
    subkind: item.document.evidence_type,
    subject: locus.subject,
    producer: {
      kind: "receipt",
      ref: item.document.evidence_id,
    },
    occurredAt: item.document.produced_at,
    summary: item.document.summary,
    status: `${locus.current ? "current" : "historical"}:${
      item.document.acceptance_id
    }`,
    crossReferences: [
      item.document.context_binding.context_binding_id,
      item.document.run.run_id,
      item.document.acceptance_id,
      ...item.document.references.map((reference) => reference.target),
    ],
    targets: [
      {
        kind: "repo_path",
        label: "Evidence document",
        target: item.documentPath,
      },
      ...item.document.references.map((reference) =>
        reference.reference_type === "repo_path"
          ? {
              kind: "repo_path" as const,
              label: reference.label,
              target: reference.target,
            }
          : {
              kind: "opaque" as const,
              label: reference.label,
              target: reference.target,
            }),
    ],
    availability: "available",
  };
};

const outcomeTraceRecord = (
  snapshot: TicketLedgerSnapshot,
  item: {
    documentPath: string;
    document: TicketOutcomeDocument;
  },
): TicketReviewTraceRecordV0 => {
  const locus = executionSubject(snapshot, item.document.subject);
  return {
    recordRef: item.document.outcome_id,
    kind: "outcome",
    subkind: item.document.terminal_form,
    subject: locus.subject,
    producer: {
      kind: "receipt",
      ref: item.document.verifier.actor_ref,
    },
    occurredAt: item.document.closed_at,
    summary: `${item.document.terminal_form} Outcome verified by ${
      truncate(item.document.verifier.actor_ref, 180)
    }`,
    body: item.document.executor_report,
    status: locus.current
      ? item.document.terminal_form
      : `historical_${item.document.terminal_form}`,
    crossReferences: [
      item.document.context_binding.context_binding_id,
      item.document.run.run_id,
      ...item.document.acceptance.flatMap((acceptance) =>
        acceptance.evidence_refs.map((reference) => reference.evidence_id)),
      ...item.document.follow_up_ticket_refs,
    ],
    targets: [{
      kind: "repo_path",
      label: "Outcome document",
      target: item.documentPath,
    }],
    availability: "available",
  };
};

const operationalCapabilityProjections = (
  snapshot: TicketLedgerSnapshot,
  options?: TicketLedgerOperationalProjectionOptionsV0,
): TicketReviewCurrentCapabilityProjectionV0[] => {
  const watermark = sha256Ref(snapshot.semanticLedgerDigest);
  const operationalLedger = options === undefined
    ? snapshot
    : {
        tickets: snapshot.tickets,
        contextBindings: options.contextBindings,
        outcomes: snapshot.outcomes,
      };
  const semanticState = new Map(
    deriveTicketLedgerState(snapshot).map((state) => [
      state.ticketId,
      state,
    ]),
  );
  return deriveTicketLedgerState(operationalLedger).map((state) => {
    const rawState = semanticState.get(state.ticketId);
    const rawOutcome = rawState?.currentSuccessfulOutcome ?? null;
    const authorityIssue = rawOutcome === null
      || state.currentSuccessfulOutcome !== null
      ? undefined
      : options?.issuesByContextBinding.get(
          rawOutcome.document.context_binding.context_binding_id,
        );
    const operationalStatus = authorityIssue === undefined
      ? state.status
      : "BLOCKED";
    const currentDeviation = snapshot.outcomes
      .filter((outcome) =>
        outcome.document.subject.ticket_id === state.ticketId
        && outcome.document.subject.ticket_revision === state.ticketRevision
        && outcome.document.terminal_form === "deviated")
      .sort((left, right) =>
        right.document.closed_at.localeCompare(left.document.closed_at))[0];
    const occurredAt = state.currentSuccessfulOutcome?.document.closed_at
      ?? (authorityIssue === undefined ? undefined : rawOutcome?.document.closed_at)
      ?? currentDeviation?.document.closed_at
      ?? "1970-01-01T00:00:00.000Z";
    const references = authorityIssue !== undefined
      ? [
          {
            ref: rawOutcome?.document.outcome_id
              ?? state.ticketId,
            label: "Outcome without current Decision authority",
          },
          ...(authorityIssue.decisionId === null
            ? []
            : [{
                ref: authorityIssue.decisionId,
                label: "Decision requiring current authority",
              }]),
        ]
      : state.currentSuccessfulOutcome === null
        ? state.blockingTicketIds.map((ticketId) => ({
            ref: ticketId,
            label: "Blocking prerequisite",
          }))
      : [{
          ref: state.currentSuccessfulOutcome.document.outcome_id,
          label: "Accepted Outcome",
        }];
    return {
      producerReceiptRef:
        `${snapshot.source.sourceToken}:${state.ticketId}:operational`,
      producedAt: occurredAt,
      snapshotRevision: snapshot.source.sourceToken,
      projectionWatermark: watermark,
      summary: {
        label: operationalStatus,
        detail: authorityIssue !== undefined
          ? `Recorded Outcome is not operational: ${authorityIssue.reason}`
          : state.status === "BLOCKED"
          ? `Waiting for ${state.blockingTicketIds.length} prerequisite${
              state.blockingTicketIds.length === 1 ? "" : "s"
            }`
          : state.status === "DONE"
            ? "Accepted current Outcome"
            : state.status === "DEVIATED"
              ? "Current execution deviation requires attention"
              : "All direct prerequisites have accepted current Outcomes",
        references,
      },
      producer: {
        kind: "runtime",
        id: "git-ticket-ledger",
        version: "1",
      },
      subject: {
        kind: "ticket",
        ticketId: state.ticketId,
        ticketRevision: sha256Ref(state.ticketRevision),
      },
      capability: "operational",
    };
  });
};

export interface TicketLedgerOperationalProjectionOptionsV0 {
  contextBindings: readonly TicketLedgerContextBinding[];
  issuesByContextBinding: ReadonlyMap<string, {
    reason: string;
    decisionId: string | null;
  }>;
}

/**
 * Mechanical adapter from one validated Git Ticket ledger snapshot into the
 * storage-agnostic review source. It adds no readiness, workflow, or planning
 * judgment.
 */
export function projectTicketLedgerForReview(
  snapshot: TicketLedgerSnapshot,
  operational?: TicketLedgerOperationalProjectionOptionsV0,
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
    currentCapabilityProjections:
      operationalCapabilityProjections(snapshot, operational),
    traceRecords: [
      ...snapshot.reviews.map((review) =>
        reviewTraceRecord(snapshot, review)),
      ...snapshot.decisions.map((decision) =>
        decisionTraceRecord(snapshot, decision)),
      ...snapshot.contextBindings.map((binding) =>
        contextBindingTraceRecord(snapshot, binding)),
      ...snapshot.evidence.map((item) =>
        evidenceTraceRecord(snapshot, item)),
      ...snapshot.outcomes.map((outcome) =>
        outcomeTraceRecord(snapshot, outcome)),
    ],
  };
}
