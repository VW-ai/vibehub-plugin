import crypto from "node:crypto";
import {
  GitFacade,
  type GitWorktreeSourceSnapshot,
} from "./git-facade.js";
import {
  assertTicketContextRefsExecutable,
  compileTicketContextFiles,
  ticketContextManifestDigest,
  type TicketContextFileCompilation,
} from "./ticket-context-compiler.js";
import {
  projectTicketExecutionDecisionAuthorityV0,
  verifyTicketExecutionDecisionAuthorityV0,
  type TicketDecisionAttestationVerifierV0,
  type TicketExecutionDecisionAuthorityIssueV0,
  type TicketExecutionVerifiedDecisionV0,
} from "./ticket-decision-attestation.js";
import {
  TicketRunLeaseError,
  TicketRunStore,
  type TicketRunLease,
  type TicketRunReleaseReason,
} from "./ticket-run-store.js";
import {
  appendTicketContextBinding,
  appendTicketEvidence,
  appendTicketOutcome,
  canonicalTicketLedgerValue,
  currentSuccessfulOutcomeForTicket,
  deriveTicketLedgerState,
  loadTicketLedgerFromWorktree,
  ticketAcceptanceCriterionDigest,
  ticketContextBindingDocumentDigest,
  ticketDecisionDocumentDigest,
  ticketEvidenceDocumentDigest,
  ticketOutcomeDocumentDigest,
  type TicketContextBindingDocument,
  type TicketEvidenceDocument,
  type TicketExecutionActor,
  type TicketLedgerPatchExpectedSource,
  type TicketLedgerPatchSource,
  type TicketLedgerSnapshot,
  type TicketLedgerTicket,
} from "./ticket-ledger/index.js";
import type { Db } from "./db.js";

export type TicketExecutionErrorCode =
  | "not_ready"
  | "already_done"
  | "binding_not_found"
  | "binding_mismatch"
  | "run_actor_mismatch"
  | "run_still_active"
  | "run_stale";

export class TicketExecutionError extends Error {
  constructor(
    readonly code: TicketExecutionErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "TicketExecutionError";
  }
}

interface PublicExpectedSource {
  sourceToken: string;
  worktreeIdentity: string;
  resolvedCommit: string;
  graphDigest: string;
  semanticLedgerDigest: string;
}

export interface CompileTicketContextInput {
  expectedSource: PublicExpectedSource;
  ticketId: string;
  expectedTicketRevision: string;
}

export interface ClaimTicketExecutionInput extends CompileTicketContextInput {
  contextBindingId: string;
  contextBindingDigest: string;
  leaseSeconds: number;
}

export interface TicketRunCredentials {
  runId: string;
  generation: number;
  leaseToken: string;
}

export interface AppendTicketEvidenceInput {
  expectedSource: PublicExpectedSource;
  run: TicketRunCredentials;
  acceptanceId: string;
  evidenceType:
    | "test"
    | "inspection"
    | "artifact"
    | "commit"
    | "runtime_observation";
  summary: string;
  references: Array<{
    kind: "repo_path" | "git_commit";
    label: string;
    target: string;
    digest?: string;
  }>;
}

export interface AppendTicketCloseoutInput {
  expectedSource: PublicExpectedSource;
  runId: string;
  generation: number;
  terminalForm:
    | "successful"
    | "partial"
    | "failed"
    | "deviated"
    | "stale";
  executorReport: string;
  acceptance: Array<{
    acceptanceId: string;
    disposition: "accepted" | "rejected" | "unresolved";
    evidenceRefs: string[];
    rationale: string;
  }>;
  followUpTicketRefs: string[];
  semanticCloseoutRefs: Array<
    | { kind: "review"; reviewId: string }
    | { kind: "decision"; decisionId: string }
    | { kind: "decision_attestation"; attestationId: string }
  >;
}

export interface TicketContextPacket {
  format: "vibehub.ticket-context-packet.v1";
  ticket: {
    ticketRevision: string;
    document: TicketLedgerTicket["document"];
  };
  source: {
    repositoryIncarnation: string;
    worktreeIdentity: string;
    branch: string;
    resolvedCommit: string;
    repositorySourceDigest: string;
    changedPaths: string[];
    graphDigest: string;
  };
  prerequisiteOutcomes: Array<{
    ticketId: string;
    outcomeDigest: string;
    document: NonNullable<
      ReturnType<typeof currentSuccessfulOutcomeForTicket>
    >["document"];
  }>;
  decisions: Array<{
    decisionDigest: string;
    document: TicketLedgerSnapshot["decisions"][number]["document"];
    verification: {
      source: "durable_local_signature" | "host_session";
      verificationRef: string;
    };
  }>;
  context: TicketContextFileCompilation;
}

const sha256 = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");
const sha256Ref = (value: string): string => `sha256:${value}`;
const rawSha256 = (value: string): string =>
  value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
const compareText = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const snapshotSource = (
  snapshot: TicketLedgerSnapshot,
): TicketLedgerPatchSource => {
  if (snapshot.source.mode !== "worktree") {
    throw new TicketExecutionError(
      "binding_mismatch",
      "Ticket execution requires a worktree source",
    );
  }
  return {
    sourceToken: snapshot.source.sourceToken,
    worktreeIdentity: snapshot.source.worktreeIdentity,
    resolvedCommit: snapshot.source.resolvedCommit,
    graphDigest: sha256Ref(snapshot.graphDigest),
    semanticLedgerDigest: sha256Ref(snapshot.semanticLedgerDigest),
  };
};

const assertExpectedSource = (
  snapshot: TicketLedgerSnapshot,
  expected: PublicExpectedSource,
): void => {
  const actual = snapshotSource(snapshot);
  const mismatches = (
    Object.keys(actual) as Array<keyof TicketLedgerPatchSource>
  ).filter((key) => actual[key] !== expected[key]);
  if (mismatches.length > 0) {
    throw new TicketExecutionError(
      "binding_mismatch",
      "Ticket execution source changed before the operation",
      { expected, actual, mismatches },
    );
  }
};

const currentTicket = (
  snapshot: TicketLedgerSnapshot,
  ticketId: string,
  expectedRevision?: string,
): TicketLedgerTicket => {
  const ticket = snapshot.tickets.find((candidate) =>
    candidate.document.ticket_id === ticketId);
  if (
    ticket === undefined
    || (
      expectedRevision !== undefined
      && ticket.ticketRevision !== rawSha256(expectedRevision)
    )
  ) {
    throw new TicketExecutionError(
      "binding_mismatch",
      `Ticket ${ticketId} is missing or changed`,
      {
        ticketId,
        expectedTicketRevision: expectedRevision ?? null,
        actualTicketRevision: ticket === undefined
          ? null
          : sha256Ref(ticket.ticketRevision),
      },
    );
  }
  return ticket;
};

const authorityAwareLedger = (
  snapshot: TicketLedgerSnapshot,
  verifier: TicketDecisionAttestationVerifierV0,
) => {
  const authority = projectTicketExecutionDecisionAuthorityV0(
    snapshot,
    verifier,
  );
  return {
    ledger: {
      tickets: snapshot.tickets,
      contextBindings: authority.contextBindings,
      outcomes: snapshot.outcomes,
    },
    issuesByContextBinding: authority.issuesByContextBinding,
  };
};

const assertReady = (
  snapshot: TicketLedgerSnapshot,
  ticketId: string,
  verifier: TicketDecisionAttestationVerifierV0,
): void => {
  const state = deriveTicketLedgerState(
    authorityAwareLedger(snapshot, verifier).ledger,
  ).find((candidate) => candidate.ticketId === ticketId);
  if (state === undefined) {
    throw new TicketExecutionError(
      "binding_mismatch",
      `Ticket ${ticketId} is not in the current graph`,
      { ticketId },
    );
  }
  if (state.status === "DONE") {
    throw new TicketExecutionError(
      "already_done",
      `Ticket ${ticketId} already has an accepted current Outcome`,
      { ticketId, outcomeId: state.currentSuccessfulOutcome?.document.outcome_id },
    );
  }
  if (state.status !== "READY") {
    throw new TicketExecutionError(
      "not_ready",
      `Ticket ${ticketId} is not currently eligible`,
      {
        ticketId,
        status: state.status,
        blockingTicketIds: state.blockingTicketIds,
      },
    );
  }
};

type VerifiedTicketDecision = TicketExecutionVerifiedDecisionV0;

type BoundTicketDecision =
  TicketContextBindingDocument["relevant_decisions"][number];

const verifiedRelevantDecisions = (
  snapshot: TicketLedgerSnapshot,
  ticket: TicketLedgerTicket,
  verifier: TicketDecisionAttestationVerifierV0,
  boundDecisions?: readonly BoundTicketDecision[],
): VerifiedTicketDecision[] => {
  const authority = verifyTicketExecutionDecisionAuthorityV0(
    snapshot,
    ticket,
    verifier,
    boundDecisions,
  );
  if (authority.status === "verified") {
    return [...authority.decisions];
  }
  throw new TicketExecutionError(
    "not_ready",
    authority.issue.message,
    {
      ticketId: ticket.document.ticket_id,
      decisionId: authority.issue.decisionId,
      decisionType: authority.issue.decisionType,
      reason: authority.issue.reason,
      disposition: authority.issue.disposition,
      verificationRef: authority.issue.verificationRef,
    },
  );
};

const verifiedDecisionRefs = (
  decisions: readonly VerifiedTicketDecision[],
) => decisions.map(({ decision, verification }) => ({
  decision_id: decision.document.decision_id,
  decision_digest: ticketDecisionDocumentDigest(decision.document),
  verification: {
    source: verification.source,
    verification_ref: verification.verificationRef,
  },
}));

const compilePacket = (
  snapshot: TicketLedgerSnapshot,
  ticket: TicketLedgerTicket,
  repositorySource: GitWorktreeSourceSnapshot,
  decisions: readonly VerifiedTicketDecision[],
  operationalLedger: ReturnType<typeof authorityAwareLedger>["ledger"],
): TicketContextPacket => {
  if (
    snapshot.source.mode !== "worktree"
    || snapshot.source.branch === null
  ) {
    throw new TicketExecutionError(
      "binding_mismatch",
      "Ticket execution requires a named-branch worktree",
      { ticketId: ticket.document.ticket_id },
    );
  }
  const context = compileTicketContextFiles(
    snapshot.source.worktreeRoot,
    ticket.document.context_refs,
  );
  const prerequisiteOutcomes = ticket.document.relations
    .map((relation) => {
      const outcome = currentSuccessfulOutcomeForTicket(
        operationalLedger,
        relation.target_ticket_id,
      );
      if (outcome === null) {
        throw new TicketExecutionError(
          "not_ready",
          `Ticket ${ticket.document.ticket_id} has an unresolved prerequisite`,
          {
            ticketId: ticket.document.ticket_id,
            prerequisiteTicketId: relation.target_ticket_id,
          },
        );
      }
      return {
        ticketId: relation.target_ticket_id,
        outcomeDigest: sha256Ref(
          ticketOutcomeDocumentDigest(outcome.document),
        ),
        document: outcome.document,
      };
    })
    .sort((left, right) => compareText(left.ticketId, right.ticketId));
  const packetDecisions = decisions.map(({ decision, verification }) => ({
    decisionDigest: sha256Ref(
      ticketDecisionDocumentDigest(decision.document),
    ),
    document: decision.document,
    verification: {
      source: verification.source,
      verificationRef: verification.verificationRef,
    },
  }));
  return {
    format: "vibehub.ticket-context-packet.v1",
    ticket: {
      ticketRevision: sha256Ref(ticket.ticketRevision),
      document: ticket.document,
    },
    source: {
      repositoryIncarnation: snapshot.source.repositoryIncarnation,
      worktreeIdentity: snapshot.source.worktreeIdentity,
      branch: snapshot.source.branch,
      resolvedCommit: snapshot.source.resolvedCommit,
      repositorySourceDigest: repositorySource.sourceDigest,
      changedPaths: repositorySource.changedPaths,
      graphDigest: sha256Ref(snapshot.graphDigest),
    },
    prerequisiteOutcomes,
    decisions: packetDecisions,
    context,
  };
};

const bindingById = (
  snapshot: TicketLedgerSnapshot,
  contextBindingId: string,
): TicketContextBindingDocument => {
  const binding = snapshot.contextBindings.find((candidate) =>
    candidate.document.context_binding_id === contextBindingId);
  if (binding === undefined) {
    throw new TicketExecutionError(
      "binding_not_found",
      `ContextBinding ${contextBindingId} was not found`,
      { contextBindingId },
    );
  }
  return binding.document;
};

const assertBindingCurrent = (
  snapshot: TicketLedgerSnapshot,
  binding: TicketContextBindingDocument,
  expectedDigest: string,
  verifyStartSource: boolean,
  verifier: TicketDecisionAttestationVerifierV0,
): void => {
  if (
    snapshot.source.mode !== "worktree"
    || snapshot.source.branch === null
  ) {
    throw new TicketExecutionError(
      "run_stale",
      "Ticket execution requires a named-branch worktree",
    );
  }
  const actualDigest = sha256Ref(
    ticketContextBindingDocumentDigest(binding),
  );
  const ticket = currentTicket(
    snapshot,
    binding.subject.ticket_id,
    sha256Ref(binding.subject.ticket_revision),
  );
  try {
    assertTicketContextRefsExecutable(ticket.document.context_refs);
  } catch (error) {
    throw new TicketExecutionError(
      "run_stale",
      `ContextBinding ${binding.context_binding_id} targets excluded repository context`,
      {
        contextBindingId: binding.context_binding_id,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  const operational = authorityAwareLedger(snapshot, verifier);
  const currentState = deriveTicketLedgerState(operational.ledger).find(
    (candidate) => candidate.ticketId === ticket.document.ticket_id,
  );
  if (currentState === undefined) {
    throw new TicketExecutionError(
      "run_stale",
      `ContextBinding ${binding.context_binding_id} names a missing Ticket`,
      { contextBindingId: binding.context_binding_id },
    );
  }
  const expectedPrerequisites = ticket.document.relations
    .map((relation) => {
      const outcome = currentSuccessfulOutcomeForTicket(
        operational.ledger,
        relation.target_ticket_id,
      );
      return outcome === null
        ? null
        : {
            ticket_id: relation.target_ticket_id,
            outcome_id: outcome.document.outcome_id,
            outcome_digest: ticketOutcomeDocumentDigest(outcome.document),
          };
    })
    .filter((value) => value !== null)
    .sort((left, right) => compareText(left.ticket_id, right.ticket_id));
  const repositoryMatches =
    binding.repository.repository_incarnation
      === snapshot.source.repositoryIncarnation
    && binding.repository.worktree_identity
      === snapshot.source.worktreeIdentity
    && binding.repository.branch === snapshot.source.branch;
  let expectedDecisions: ReturnType<typeof verifiedDecisionRefs>;
  try {
    expectedDecisions = verifiedDecisionRefs(
      verifiedRelevantDecisions(
        snapshot,
        ticket,
        verifier,
        binding.relevant_decisions,
      ),
    );
  } catch (error) {
    if (!(error instanceof TicketExecutionError)) throw error;
    throw new TicketExecutionError(
      "run_stale",
      `ContextBinding ${binding.context_binding_id} no longer has current Decision authority`,
      {
        contextBindingId: binding.context_binding_id,
        causeCode: error.code,
        cause: error.message,
        ...error.details,
      },
    );
  }
  if (
    actualDigest !== expectedDigest
    || binding.graph_digest !== snapshot.graphDigest
    || !repositoryMatches
    || expectedPrerequisites.length !== ticket.document.relations.length
    || canonicalTicketLedgerValue(expectedPrerequisites)
      !== canonicalTicketLedgerValue(
        binding.successful_prerequisite_outcomes,
      )
    || canonicalTicketLedgerValue(expectedDecisions)
      !== canonicalTicketLedgerValue(binding.relevant_decisions)
    || (currentState.status !== "READY" && currentState.status !== "DONE")
  ) {
    throw new TicketExecutionError(
      "run_stale",
      `ContextBinding ${binding.context_binding_id} is no longer current`,
      {
        contextBindingId: binding.context_binding_id,
        expectedDigest,
        actualDigest,
        ticketStatus: currentState.status,
      },
    );
  }
  if (!verifyStartSource) return;
  let currentContext: TicketContextFileCompilation;
  try {
    currentContext = compileTicketContextFiles(
      snapshot.source.worktreeRoot,
      ticket.document.context_refs,
    );
  } catch (error) {
    throw new TicketExecutionError(
      "run_stale",
      `ContextBinding ${binding.context_binding_id} no longer has readable exact context`,
      {
        contextBindingId: binding.context_binding_id,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  const currentContextEntries = currentContext.entries.map((entry) => ({
    ref: entry.ref,
    purpose: entry.purpose,
    source_kind: entry.kind === "file"
      ? "repo_file" as const
      : "repo_directory" as const,
    files: entry.files.map((file) => ({
      repository_path: file.path,
      file_digest: file.digest,
      byte_length: file.byteLength,
    })),
  }));
  const boundContextDigest = ticketContextManifestDigest(
    binding.context_entries.map((entry) => ({
      ref: entry.ref,
      purpose: entry.purpose,
      kind: entry.source_kind === "repo_file"
        ? "file" as const
        : "directory" as const,
      files: entry.files.map((file) => ({
        path: file.repository_path,
        digest: file.file_digest,
        byteLength: file.byte_length,
      })),
    })),
  );
  if (
    canonicalTicketLedgerValue(currentContextEntries)
      !== canonicalTicketLedgerValue(binding.context_entries)
    || currentContext.contentDigest !== boundContextDigest
  ) {
    throw new TicketExecutionError(
      "run_stale",
      `ContextBinding ${binding.context_binding_id} no longer names the exact compiled context`,
      {
        contextBindingId: binding.context_binding_id,
        expectedContextDigest: boundContextDigest,
        actualContextDigest: currentContext.contentDigest,
      },
    );
  }
  const repositorySource = GitFacade.worktreeSourceSnapshotAt(
    snapshot.source.worktreeRoot,
    [".vibehub/tickets"],
  );
  if (
    repositorySource.headSha !== binding.repository.resolved_commit
    || repositorySource.branch !== binding.repository.branch
    || repositorySource.sourceDigest
      !== binding.repository.repository_source_digest
  ) {
    throw new TicketExecutionError(
      "run_stale",
      `ContextBinding ${binding.context_binding_id} no longer names the execution-start source`,
      {
        contextBindingId: binding.context_binding_id,
        expected: binding.repository,
        actual: repositorySource,
      },
    );
  }
};

const runBinding = (
  snapshot: TicketLedgerSnapshot,
  run: TicketRunLease,
  verifyStartSource: boolean,
  verifier: TicketDecisionAttestationVerifierV0,
): TicketContextBindingDocument => {
  if (
    snapshot.source.mode !== "worktree"
    || run.worktreeIdentity !== snapshot.source.worktreeIdentity
  ) {
    throw new TicketExecutionError(
      "run_stale",
      `Run ${run.runId} belongs to another worktree`,
      { runId: run.runId, worktreeIdentity: run.worktreeIdentity },
    );
  }
  const binding = bindingById(snapshot, run.contextBindingId);
  try {
    assertBindingCurrent(
      snapshot,
      binding,
      run.contextBindingDigest,
      verifyStartSource,
      verifier,
    );
  } catch (error) {
    if (!(error instanceof TicketExecutionError)) throw error;
    throw new TicketExecutionError(
      "run_stale",
      `Run ${run.runId} no longer has a current execution binding`,
      {
        runId: run.runId,
        contextBindingId: run.contextBindingId,
        causeCode: error.code,
        cause: error.message,
      },
    );
  }
  if (
    binding.subject.ticket_id !== run.ticketId
    || sha256Ref(binding.subject.ticket_revision) !== run.ticketRevision
    || binding.repository.repository_source_digest !== run.startSourceDigest
    || binding.repository.branch !== run.startBranch
    || binding.repository.resolved_commit !== run.startHeadSha
  ) {
    throw new TicketExecutionError(
      "run_stale",
      `Run ${run.runId} does not match its ContextBinding`,
      { runId: run.runId, contextBindingId: run.contextBindingId },
    );
  }
  return binding;
};

const historicalRunBinding = (
  snapshot: TicketLedgerSnapshot,
  run: TicketRunLease,
): TicketContextBindingDocument => {
  if (
    snapshot.source.mode !== "worktree"
    || run.worktreeIdentity !== snapshot.source.worktreeIdentity
  ) {
    throw new TicketExecutionError(
      "run_stale",
      `Run ${run.runId} belongs to another worktree`,
      { runId: run.runId, worktreeIdentity: run.worktreeIdentity },
    );
  }
  const binding = bindingById(snapshot, run.contextBindingId);
  const actualDigest = sha256Ref(
    ticketContextBindingDocumentDigest(binding),
  );
  if (
    actualDigest !== run.contextBindingDigest
    || binding.subject.ticket_id !== run.ticketId
    || sha256Ref(binding.subject.ticket_revision) !== run.ticketRevision
    || binding.repository.repository_source_digest !== run.startSourceDigest
    || binding.repository.branch !== run.startBranch
    || binding.repository.resolved_commit !== run.startHeadSha
  ) {
    throw new TicketExecutionError(
      "run_stale",
      `Run ${run.runId} does not match its durable ContextBinding`,
      {
        runId: run.runId,
        contextBindingId: run.contextBindingId,
        expectedDigest: run.contextBindingDigest,
        actualDigest,
      },
    );
  }
  return binding;
};

const decisionBlockerFromIssue = (
  issue: TicketExecutionDecisionAuthorityIssueV0,
) => ({
  kind: "decision_authority" as const,
  decisionId: issue.decisionId,
  decisionType: issue.decisionType,
  reason: issue.reason,
  disposition: issue.disposition,
  message: issue.message,
});

export class TicketExecutionService {
  private readonly runs: TicketRunStore;

  constructor(
    db: Db,
    private readonly decisionVerifier:
      TicketDecisionAttestationVerifierV0,
  ) {
    this.runs = new TicketRunStore(db);
  }

  frontier(
    repoId: number,
    worktreeRoot: string,
    now: string,
  ) {
    const snapshot = loadTicketLedgerFromWorktree(worktreeRoot);
    if (snapshot.source.mode !== "worktree") {
      throw new TicketExecutionError(
        "binding_mismatch",
        "Ticket frontier requires a worktree",
      );
    }
    const runs = this.runs.listCurrent({
      repoId,
      worktreeIdentity: snapshot.source.worktreeIdentity,
      now,
    });
    const runsByTicket = new Map<string, TicketRunLease[]>();
    for (const run of runs) {
      const current = runsByTicket.get(run.ticketId) ?? [];
      current.push(run);
      runsByTicket.set(run.ticketId, current);
    }
    const operational = authorityAwareLedger(
      snapshot,
      this.decisionVerifier,
    );
    const semanticStates = new Map(
      deriveTicketLedgerState(snapshot).map((state) => [
        state.ticketId,
        state,
      ]),
    );
    const tickets = deriveTicketLedgerState(
      operational.ledger,
    ).map((state) => {
      const semanticState = semanticStates.get(state.ticketId);
      if (semanticState === undefined) {
        throw new TicketExecutionError(
          "binding_mismatch",
          `Ticket ${state.ticketId} disappeared from semantic state`,
          { ticketId: state.ticketId },
        );
      }
      const ticketRuns = runsByTicket.get(state.ticketId) ?? [];
      let run: TicketRunLease | null = null;
      let runCurrent = false;
      for (const candidate of ticketRuns) {
        if (
          candidate.ticketRevision !== sha256Ref(state.ticketRevision)
        ) {
          continue;
        }
        try {
          runBinding(
            snapshot,
            candidate,
            false,
            this.decisionVerifier,
          );
          run = candidate;
          runCurrent = true;
          break;
        } catch (error) {
          if (!(error instanceof TicketExecutionError)) throw error;
        }
      }
      if (run === null && ticketRuns.length > 0) {
        run = ticketRuns[0]!;
      }
      let decisionBlocker: {
        kind: "decision_authority";
        decisionId: string | null;
        decisionType: string | null;
        reason: string;
        disposition: string | null;
        message: string;
      } | null = null;
      const rawOutcome = semanticState.currentSuccessfulOutcome;
      if (
        rawOutcome !== null
        && state.currentSuccessfulOutcome === null
      ) {
        const issue = operational.issuesByContextBinding.get(
          rawOutcome.document.context_binding.context_binding_id,
        );
        if (issue !== undefined) {
          decisionBlocker = decisionBlockerFromIssue(issue);
        }
      }
      if (state.status === "READY" && run === null) {
        const ticket = snapshot.tickets.find((candidate) =>
          candidate.document.ticket_id === state.ticketId);
        if (ticket === undefined) {
          throw new TicketExecutionError(
            "binding_mismatch",
            `Ticket ${state.ticketId} disappeared from the current graph`,
            { ticketId: state.ticketId },
          );
        }
        try {
          verifiedRelevantDecisions(
            snapshot,
            ticket,
            this.decisionVerifier,
          );
        } catch (error) {
          if (!(error instanceof TicketExecutionError)) throw error;
          decisionBlocker ??= {
            kind: "decision_authority",
            decisionId: typeof error.details["decisionId"] === "string"
              ? error.details["decisionId"]
              : null,
            decisionType:
              typeof error.details["decisionType"] === "string"
                ? error.details["decisionType"]
                : null,
            reason: typeof error.details["reason"] === "string"
              ? error.details["reason"]
              : "non_authorizing_disposition",
            disposition:
              typeof error.details["disposition"] === "string"
                ? error.details["disposition"]
                : null,
            message: error.message,
          };
        }
      }
      const status = state.status === "DONE"
        ? "DONE"
        : run !== null && runCurrent
          ? "RUNNING"
          : run !== null
            ? "STALE"
            : decisionBlocker === null
              ? state.status
              : "BLOCKED";
      return {
        ticketId: state.ticketId,
        ticketRevision: sha256Ref(state.ticketRevision),
        status,
        semanticStatus: semanticState.status,
        blockingTicketIds: [...state.blockingTicketIds],
        decisionBlocker,
        currentOutcomeId:
          state.currentSuccessfulOutcome?.document.outcome_id ?? null,
        run: run === null
          ? null
          : {
              runId: run.runId,
              generation: run.generation,
              actor: run.actor,
              expiresAt: run.expiresAt,
              current: runCurrent,
            },
      };
    });
    return {
      source: snapshotSource(snapshot),
      tickets,
      counts: Object.fromEntries([
        "READY",
        "RUNNING",
        "DONE",
        "BLOCKED",
        "DEVIATED",
        "STALE",
      ].map((status) => [
        status,
        tickets.filter((ticket) => ticket.status === status).length,
      ])),
    };
  }

  compileContext(
    worktreeRoot: string,
    input: CompileTicketContextInput,
    compiledAt: string,
  ) {
    const snapshot = loadTicketLedgerFromWorktree(worktreeRoot);
    assertExpectedSource(snapshot, input.expectedSource);
    const ticket = currentTicket(
      snapshot,
      input.ticketId,
      input.expectedTicketRevision,
    );
    assertReady(
      snapshot,
      ticket.document.ticket_id,
      this.decisionVerifier,
    );
    if (snapshot.source.mode !== "worktree") {
      throw new TicketExecutionError(
        "binding_mismatch",
        "Ticket context compilation requires a worktree",
      );
    }
    const repositorySource = GitFacade.worktreeSourceSnapshotAt(
      snapshot.source.worktreeRoot,
      [".vibehub/tickets"],
    );
    if (
      repositorySource.headSha !== snapshot.source.resolvedCommit
      || repositorySource.branch !== snapshot.source.branch
      || repositorySource.branch === null
    ) {
      throw new TicketExecutionError(
        "binding_mismatch",
        "Ticket repository source moved during context compilation",
        {
          ledgerHead: snapshot.source.resolvedCommit,
          ledgerBranch: snapshot.source.branch,
          repositorySource,
        },
      );
    }
    const branch = repositorySource.branch;
    const decisions = verifiedRelevantDecisions(
      snapshot,
      ticket,
      this.decisionVerifier,
    );
    const operational = authorityAwareLedger(
      snapshot,
      this.decisionVerifier,
    );
    const packet = compilePacket(
      snapshot,
      ticket,
      repositorySource,
      decisions,
      operational.ledger,
    );
    const packetDigest = sha256(canonicalTicketLedgerValue(packet));
    const request = {
      expectedSource: input.expectedSource as TicketLedgerPatchExpectedSource,
      contextBinding: {
        schema_version: 1 as const,
        kind: "ticket_context_binding" as const,
        subject: {
          ticket_id: ticket.document.ticket_id,
          ticket_revision: ticket.ticketRevision,
        },
        graph_digest: snapshot.graphDigest,
        repository: {
          repository_incarnation: snapshot.source.repositoryIncarnation,
          worktree_identity: snapshot.source.worktreeIdentity,
          branch,
          resolved_commit: snapshot.source.resolvedCommit,
          repository_source_digest: repositorySource.sourceDigest,
        },
        acceptance: ticket.document.acceptance.map((acceptance) => ({
          acceptance_id: acceptance.acceptance_id,
          criterion_digest:
            ticketAcceptanceCriterionDigest(acceptance.criterion),
        })),
        context_entries: packet.context.entries.map((entry) => ({
          ref: entry.ref,
          purpose: entry.purpose,
          source_kind: entry.kind === "file"
            ? "repo_file" as const
            : "repo_directory" as const,
          files: entry.files.map((file) => ({
            repository_path: file.path,
            file_digest: file.digest,
            byte_length: file.byteLength,
          })),
        })),
        successful_prerequisite_outcomes:
          packet.prerequisiteOutcomes.map((outcome) => ({
            ticket_id: outcome.ticketId,
            outcome_id: outcome.document.outcome_id,
            outcome_digest: rawSha256(outcome.outcomeDigest),
          })),
        relevant_decisions: verifiedDecisionRefs(decisions),
        packet_digest: packetDigest,
      },
    };
    const result = appendTicketContextBinding({
      worktreeRoot,
      request,
      compiledAt,
    });
    return {
      ...result,
      contextBinding: {
        ...result.contextBinding,
        documentDigest: sha256Ref(ticketContextBindingDocumentDigest(
          result.contextBinding.document,
        )),
      },
      packet,
      packetDigest: sha256Ref(packetDigest),
    };
  }

  claim(
    repoId: number,
    worktreeRoot: string,
    actor: string,
    now: string,
    input: ClaimTicketExecutionInput,
  ) {
    const snapshot = loadTicketLedgerFromWorktree(worktreeRoot);
    assertExpectedSource(snapshot, input.expectedSource);
    currentTicket(snapshot, input.ticketId, input.expectedTicketRevision);
    assertReady(snapshot, input.ticketId, this.decisionVerifier);
    const binding = bindingById(snapshot, input.contextBindingId);
    assertBindingCurrent(
      snapshot,
      binding,
      input.contextBindingDigest,
      true,
      this.decisionVerifier,
    );
    if (
      binding.subject.ticket_id !== input.ticketId
      || sha256Ref(binding.subject.ticket_revision)
        !== input.expectedTicketRevision
      || snapshot.source.mode !== "worktree"
    ) {
      throw new TicketExecutionError(
        "binding_mismatch",
        "ContextBinding does not name the requested Ticket",
        { ticketId: input.ticketId, contextBindingId: input.contextBindingId },
      );
    }
    return this.runs.claim({
      repoId,
      worktreeIdentity: snapshot.source.worktreeIdentity,
      ticketId: input.ticketId,
      ticketRevision: input.expectedTicketRevision,
      contextBindingId: input.contextBindingId,
      contextBindingDigest: input.contextBindingDigest,
      actor,
      startSourceDigest: binding.repository.repository_source_digest,
      startBranch: binding.repository.branch,
      startHeadSha: binding.repository.resolved_commit,
      leaseSeconds: input.leaseSeconds,
      now,
    });
  }

  heartbeat(
    repoId: number,
    worktreeRoot: string,
    actor: string,
    now: string,
    input: TicketRunCredentials & { leaseSeconds: number },
  ) {
    const authorized = this.runs.authorize({
      repoId,
      now,
      runId: input.runId,
      generation: input.generation,
      leaseToken: input.leaseToken,
    });
    if (authorized.actor !== actor) {
      throw new TicketExecutionError(
        "run_actor_mismatch",
        `Run ${authorized.runId} belongs to another actor`,
        { runId: authorized.runId, actor },
      );
    }
    const run = this.runs.heartbeat({ repoId, ...input, now });
    try {
      runBinding(
        loadTicketLedgerFromWorktree(worktreeRoot),
        run,
        false,
        this.decisionVerifier,
      );
      return run;
    } catch (error) {
      this.runs.release({
        repoId,
        ...input,
        reason: "stale_binding",
        now,
      });
      throw error;
    }
  }

  release(
    repoId: number,
    actor: string,
    now: string,
    input: TicketRunCredentials & { reason: TicketRunReleaseReason },
  ) {
    const authorized = this.runs.authenticate({
      repoId,
      runId: input.runId,
      generation: input.generation,
      leaseToken: input.leaseToken,
    });
    if (authorized.actor !== actor) {
      throw new TicketExecutionError(
        "run_actor_mismatch",
        `Run ${input.runId} belongs to another actor`,
        { runId: input.runId, actor },
      );
    }
    return this.runs.release({ repoId, ...input, now });
  }

  appendEvidence(
    repoId: number,
    worktreeRoot: string,
    actor: string,
    now: string,
    input: AppendTicketEvidenceInput,
  ) {
    const run = this.runs.authorize({
      repoId,
      ...input.run,
      now,
    });
    if (run.actor !== actor) {
      throw new TicketExecutionError(
        "run_actor_mismatch",
        `Run ${run.runId} belongs to another actor`,
        { runId: run.runId, actor, runActor: run.actor },
      );
    }
    const snapshot = loadTicketLedgerFromWorktree(worktreeRoot);
    assertExpectedSource(snapshot, input.expectedSource);
    const binding = runBinding(
      snapshot,
      run,
      false,
      this.decisionVerifier,
    );
    return appendTicketEvidence({
      worktreeRoot,
      producedAt: now,
      request: {
        expectedSource:
          input.expectedSource as TicketLedgerPatchExpectedSource,
        evidence: {
          schema_version: 1,
          kind: "ticket_evidence",
          subject: {
            ticket_id: run.ticketId,
            ticket_revision: rawSha256(run.ticketRevision),
          },
          context_binding: {
            context_binding_id: binding.context_binding_id,
            document_digest:
              ticketContextBindingDocumentDigest(binding),
            packet_digest: binding.packet_digest,
          },
          run: {
            run_id: run.runId,
            generation: run.generation,
            executor: {
              actor_kind: "agent",
              actor_ref: run.actor,
            },
            started_source_digest: run.startSourceDigest,
          },
          acceptance_id: input.acceptanceId,
          evidence_type: input.evidenceType,
          summary: input.summary,
          references: input.references.map((reference) => ({
            reference_type: reference.kind,
            label: reference.label,
            target: reference.target,
            ...(reference.digest === undefined
              ? {}
              : { digest: reference.digest }),
          })),
        },
      },
    });
  }

  appendCloseout(
    repoId: number,
    worktreeRoot: string,
    verifier: TicketExecutionActor,
    now: string,
    input: AppendTicketCloseoutInput,
  ) {
    const run = this.runs.get({
      repoId,
      runId: input.runId,
      generation: input.generation,
    });
    if (run.releasedAt === null) {
      throw new TicketExecutionError(
        "run_still_active",
        `Run ${run.runId} must be released before independent closeout`,
        { runId: run.runId, expiresAt: run.expiresAt },
      );
    }
    const snapshot = loadTicketLedgerFromWorktree(worktreeRoot);
    assertExpectedSource(snapshot, input.expectedSource);
    const binding = input.terminalForm === "stale"
      ? historicalRunBinding(snapshot, run)
      : runBinding(
          snapshot,
          run,
          false,
          this.decisionVerifier,
        );
    const evidenceById = new Map(snapshot.evidence.map((item) => [
      item.document.evidence_id,
      item.document,
    ]));
    const acceptance = input.acceptance.map((adjudication) => ({
      acceptance_id: adjudication.acceptanceId,
      adjudication: adjudication.disposition,
      evidence_refs: adjudication.evidenceRefs.map((evidenceId) => {
        const evidence = evidenceById.get(evidenceId);
        if (evidence === undefined) {
          throw new TicketExecutionError(
            "binding_mismatch",
            `Evidence ${evidenceId} was not found for closeout`,
            { runId: run.runId, evidenceId },
          );
        }
        return {
          evidence_id: evidenceId,
          evidence_digest: ticketEvidenceDocumentDigest(evidence),
        };
      }),
      rationale: adjudication.rationale,
    }));
    return appendTicketOutcome({
      worktreeRoot,
      closedAt: now,
      request: {
        expectedSource:
          input.expectedSource as TicketLedgerPatchExpectedSource,
        outcome: {
          schema_version: 1,
          kind: "ticket_outcome",
          subject: {
            ticket_id: run.ticketId,
            ticket_revision: rawSha256(run.ticketRevision),
          },
          context_binding: {
            context_binding_id: binding.context_binding_id,
            document_digest:
              ticketContextBindingDocumentDigest(binding),
            packet_digest: binding.packet_digest,
          },
          run: {
            run_id: run.runId,
            generation: run.generation,
            executor: {
              actor_kind: "agent",
              actor_ref: run.actor,
            },
            started_source_digest: run.startSourceDigest,
          },
          terminal_form: input.terminalForm,
          executor_report: input.executorReport,
          acceptance,
          verifier,
          follow_up_ticket_refs: input.followUpTicketRefs,
          semantic_closeout_refs: input.semanticCloseoutRefs.map(
            (reference) => reference.kind === "review"
              ? { kind: "review" as const, review_id: reference.reviewId }
              : reference.kind === "decision"
                ? {
                    kind: "decision" as const,
                    decision_id: reference.decisionId,
                  }
                : {
                    kind: "decision_attestation" as const,
                    attestation_id: reference.attestationId,
                  },
          ),
        },
      },
    });
  }
}

export const isTicketRunLeaseFailure = (
  error: unknown,
): error is TicketRunLeaseError => error instanceof TicketRunLeaseError;
