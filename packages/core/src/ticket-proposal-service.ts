import crypto from "node:crypto";
import fs from "node:fs";
import type {
  TicketGraphChangeProposalV0,
  TicketProposalDefinitionBodyInputV0,
  TicketProposalDefinitionRefV0,
  TicketProposalInspectInputV0,
  TicketProposalLedgerPageV0,
  TicketProposalListInputV0,
  TicketProposalMaterializedDefinitionV0,
  TicketProposalSummaryV0,
  TicketProposalSubmitInputV0,
  TicketProposalValidationCheckOutcomeV0,
  TicketProposalValidationInspectInputV0,
  TicketProposalValidationLedgerPageV0,
  TicketProposalValidationListInputV0,
  TicketProposalValidationReceiptV0,
  TicketProposalValidationRecordInputV0,
  TicketProposalValidationSummaryV0,
  TicketProposalV0,
} from "./contract/ticket-proposal.js";
import {
  TICKET_PROPOSAL_DEFAULT_PAGE_SIZE,
  TICKET_PROPOSAL_AUTHORITY_SIGNALS,
  TICKET_PROPOSAL_MAX_INPUT_BYTES,
  TICKET_PROPOSAL_MAX_OUTPUT_BYTES,
  TICKET_PROPOSAL_VALIDATION_CHECK_CODES,
  TICKET_PROPOSAL_VALIDATION_DEFAULT_PAGE_SIZE,
  TICKET_PROPOSAL_VALIDATION_MAX_FINDINGS,
  TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES,
  isJsonValueWithinByteBudgetV0,
  isTicketProposalInputWithinBudgetV0,
  isTicketProposalValidationInputWithinBudgetV0,
} from "./contract/ticket-proposal.js";
import {
  ticketProposalInspectInputV0Schema,
  ticketProposalListInputV0Schema,
  ticketProposalV0Schema,
  ticketProposalValidationInspectInputV0Schema,
  ticketProposalValidationListInputV0Schema,
  ticketProposalValidationReceiptV0Schema,
  ticketProposalValidationRecordInputV0Schema,
} from "./contract/ticket-proposal-schemas.js";
import type { Db } from "./db.js";
import {
  GIT_TICKET_STORE_SCHEMA_VERSION,
  compareGitTicketCanonicalTextV0,
  gitTicketRepositoryIncarnationV0,
  type GitTicketAuthoringScopeV0,
  loadCurrentGitTicketAuthoringBaseV0,
  prepareGitTicketGenerationV0,
  serializeGitTicketStoreDocumentV0,
  validateGitTicketRevisionTransitionV0,
  type GitTicketDefinitionRevisionV0,
} from "./git-ticket-store.js";
import { KnowledgeError } from "./knowledge-service.js";

const VALIDATION_STORE_ID =
  "ticket-store-00000000000000000000000000000000";
const PROPOSAL_PROVENANCE_PREFIX = "ticket-proposal:";

export type TicketProposalRepositoryScopeV0 = GitTicketAuthoringScopeV0;

export interface TicketProposalSubmitContextV0 {
  actor: string;
  taskId?: string;
  requestId: string;
  now: string;
}

/**
 * Reconstruct the complete candidate represented by one immutable proposal.
 *
 * Application authority is intentionally outside this helper. It only
 * replays already-materialized changes against the exact observed base and
 * rechecks the candidate digest that validators and authority decisions bind.
 */
export function reconstructTicketProposalCandidateV0(
  currentDefinitions: ReadonlyArray<GitTicketDefinitionRevisionV0>,
  proposal: TicketGraphChangeProposalV0,
): GitTicketDefinitionRevisionV0[] {
  const currentById = new Map(currentDefinitions.map((definition) => [
    definition.ticketId,
    definition,
  ]));
  const candidateById = new Map(currentDefinitions.map((definition) => [
    definition.ticketId,
    definition,
  ]));
  for (const change of proposal.changes) {
    const materialized = proposalGitDefinition(change.definition);
    if (change.op === "create") {
      if (currentById.has(change.ticketId)
        || materialized.definitionRevision !== 1) {
        throw conflict(
          "a proposed Ticket creation no longer targets an absent identity",
          { ticketId: change.ticketId },
        );
      }
      candidateById.set(change.ticketId, materialized);
      continue;
    }
    const current = currentById.get(change.ticketId);
    if (current === undefined
      || current.definitionRevision !== change.expectedDefinitionRevision
      || current.outcome !== change.previousOutcome
      || current.parentId !== change.previousParentId) {
      throw conflict(
        "a proposed Ticket revision no longer matches its exact base",
        {
          ticketId: change.ticketId,
          expectedDefinitionRevision: change.expectedDefinitionRevision,
          actualDefinitionRevision: current?.definitionRevision ?? null,
        },
      );
    }
    candidateById.set(change.ticketId, materialized);
  }
  const candidate = [...candidateById.values()]
    .sort((left, right) =>
      compareGitTicketCanonicalTextV0(left.ticketId, right.ticketId));
  validateGitTicketRevisionTransitionV0(
    [...currentDefinitions],
    candidate,
  );
  const actualCandidateDigest = ticketProposalCandidateDigestV0(candidate);
  if (actualCandidateDigest !== proposal.mechanicalReview.candidateDigest) {
    throw corruptLedger(
      "the materialized Ticket proposal candidate digest is inconsistent",
      {
        proposalId: proposal.proposalId,
        expectedCandidateDigest: proposal.mechanicalReview.candidateDigest,
        actualCandidateDigest,
      },
    );
  }
  return candidate;
}

export function ticketProposalCandidateDigestV0(
  definitions: ReadonlyArray<GitTicketDefinitionRevisionV0>,
): string {
  return ticketProposalDomainDigestV0(
    "vibehub.ticket-proposal-candidate.v1",
    definitions,
  );
}

/**
 * Records immutable review contributions without mutating the Ticket graph.
 *
 * The service performs mechanical preparation against one exact graph head so
 * later validators can inspect a concrete candidate. Neither successful
 * preparation nor the claimed actor/assessment grants application authority.
 */
export class TicketProposalServiceV0 {
  constructor(private readonly db: Db) {}

  submit(
    scope: TicketProposalRepositoryScopeV0,
    context: TicketProposalSubmitContextV0,
    input: TicketProposalSubmitInputV0,
  ): TicketProposalV0 {
    if (!isTicketProposalInputWithinBudgetV0(input)) {
      throw new KnowledgeError(
        "validation_error",
        "Ticket proposal input exceeds its safe JSON byte budget",
        { maximumBytes: TICKET_PROPOSAL_MAX_INPUT_BYTES },
        ["Reduce the proposal size or split it into bounded contributions."],
      );
    }
    this.assertTaskScope(scope, context.taskId);
    const scopeRef = proposalScopeRef(scope);
    const proposalId = `tgp-${domainDigest(
      "vibehub.ticket-proposal-id.v1",
      { scopeRef, requestId: context.requestId },
    )}`;
    const base = loadCurrentGitTicketAuthoringBaseV0(
      scope,
      input.observedSnapshotId,
    );
    const proposal = input.kind === "comment"
      ? this.prepareComment(
          proposalId,
          scopeRef,
          context,
          input,
          base.definitions,
          base.source,
        )
      : this.prepareGraphChange(
          proposalId,
          scopeRef,
          context,
          input,
          base.storeId,
          base.definitions,
        );
    if (!isJsonValueWithinByteBudgetV0(
      proposal,
      TICKET_PROPOSAL_MAX_OUTPUT_BYTES,
    )) {
      throw new KnowledgeError(
        "validation_error",
        "materialized Ticket proposal exceeds its safe output byte budget",
        { maximumBytes: TICKET_PROPOSAL_MAX_OUTPUT_BYTES },
        ["Split the proposal into smaller bounded contributions and retry."],
      );
    }
    const verified = ticketProposalV0Schema.safeParse(proposal);
    if (!verified.success) {
      throw corruptLedger(
        "Core produced an invalid materialized Ticket proposal",
        { issues: verified.error.issues },
      );
    }
    this.assertTaskScope(scope, context.taskId);
    this.assertRepositoryScope(scope);
    this.persist(scope, context, verified.data as TicketProposalV0);
    return verified.data as TicketProposalV0;
  }

  inspect(
    scope: TicketProposalRepositoryScopeV0,
    context: TicketProposalSubmitContextV0,
    input: TicketProposalInspectInputV0,
  ): TicketProposalV0 {
    const parsed = parseInput(
      ticketProposalInspectInputV0Schema,
      input,
      "Ticket proposal inspect input",
    );
    this.assertTaskScope(scope, context.taskId);
    this.assertRepositoryScope(scope);
    const proposal = this.readProposal(scope, parsed.proposalId);
    this.assertRepositoryScope(scope);
    return proposal;
  }

  list(
    scope: TicketProposalRepositoryScopeV0,
    context: TicketProposalSubmitContextV0,
    input: TicketProposalListInputV0 = {},
  ): TicketProposalLedgerPageV0 {
    const parsed = parseInput(
      ticketProposalListInputV0Schema,
      input,
      "Ticket proposal list input",
    );
    this.assertTaskScope(scope, context.taskId);
    this.assertRepositoryScope(scope);
    const scopeRef = proposalScopeRef(scope);
    const filter = proposalListFilter(parsed);
    const filterDigest = domainDigest(
      "vibehub.ticket-proposal-list-filter.v1",
      filter.identity,
    );
    const cursor = parsed.cursor === undefined
      ? undefined
      : decodeLedgerCursor(
          parsed.cursor,
          "proposal_list",
          scopeRef,
          filterDigest,
        );
    const throughSequence = cursor?.throughSequence
      ?? this.proposalHighWater(scope.repoId, scopeRef);
    const beforeSequence = cursor?.beforeSequence ?? throughSequence + 1;
    const limit = parsed.limit ?? TICKET_PROPOSAL_DEFAULT_PAGE_SIZE;
    const parameters: unknown[] = [
      scope.repoId,
      scopeRef,
      throughSequence,
      beforeSequence,
      ...filter.parameters,
      limit + 1,
    ];
    const rows = this.db.prepare(
      `SELECT sequence,proposal_id proposalId,
              proposal_digest proposalDigest,kind,
              observed_snapshot_id observedSnapshotId,
              author,submitted_at submittedAt
       FROM ticket_proposals
       WHERE repo_id=? AND scope_ref=?
         AND sequence<=? AND sequence<?
         ${filter.sql}
       ORDER BY sequence DESC
       LIMIT ?`,
    ).all(...parameters) as ProposalSummaryRow[];
    const hasNext = rows.length > limit;
    const pageRows = hasNext ? rows.slice(0, limit) : rows;
    const countParameters: unknown[] = [
      scope.repoId,
      scopeRef,
      throughSequence,
      ...filter.parameters,
    ];
    const total = this.db.prepare(
      `SELECT COUNT(*) totalItems
       FROM ticket_proposals
       WHERE repo_id=? AND scope_ref=? AND sequence<=?
         ${filter.sql}`,
    ).get(...countParameters) as { totalItems: number };
    const items = pageRows.map(proposalSummaryFromRow);
    const nextCursor = hasNext
      ? encodeLedgerCursor({
          kind: "proposal_list",
          scopeRef,
          filterDigest,
          throughSequence,
          beforeSequence: pageRows.at(-1)!.sequence,
        })
      : null;
    this.assertRepositoryScope(scope);
    return {
      scopeRef,
      items,
      page: {
        count: items.length,
        totalItems: safeLedgerInteger(
          total.totalItems,
          "proposal list total",
        ),
      },
      nextCursor,
    };
  }

  recordValidation(
    scope: TicketProposalRepositoryScopeV0,
    context: TicketProposalSubmitContextV0,
    input: TicketProposalValidationRecordInputV0,
  ): TicketProposalValidationReceiptV0 {
    if (!isTicketProposalValidationInputWithinBudgetV0(input)) {
      throw new KnowledgeError(
        "validation_error",
        "Ticket proposal validation input exceeds its safe JSON byte budget",
        { maximumBytes: TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES },
        ["Reduce the findings or split supporting evidence into references."],
      );
    }
    const parsed = parseInput(
      ticketProposalValidationRecordInputV0Schema,
      input,
      "Ticket proposal validation record input",
    );
    this.assertTaskScope(scope, context.taskId);
    this.assertRepositoryScope(scope);
    const proposal = this.readProposal(scope, parsed.proposalId);
    if (proposal.kind !== "graph_change") {
      throw new KnowledgeError(
        "validation_error",
        "comment proposals do not have an independent semantic validation receipt",
        { proposalId: proposal.proposalId, proposalKind: proposal.kind },
        ["Inspect the comment directly; validate only graph-change proposals."],
      );
    }
    if (proposal.proposalDigest !== parsed.expectedProposalDigest
      || proposal.mechanicalReview.candidateDigest
        !== parsed.expectedCandidateDigest) {
      throw new KnowledgeError(
        "cas_conflict",
        "the validation target does not match the immutable proposal inspected by the validator",
        {
          proposalId: proposal.proposalId,
          expectedProposalDigest: parsed.expectedProposalDigest,
          actualProposalDigest: proposal.proposalDigest,
          expectedCandidateDigest: parsed.expectedCandidateDigest,
          actualCandidateDigest: proposal.mechanicalReview.candidateDigest,
        },
        ["Re-inspect the proposal and record a new validation request."],
      );
    }
    const scopeRef = proposalScopeRef(scope);
    const authorityDecision = this.db.prepare(
      `SELECT authority_decision_id authorityDecisionId,disposition
       FROM ticket_proposal_authority_decisions
       WHERE repo_id=? AND scope_ref=? AND proposal_id=?`,
    ).get(
      scope.repoId,
      scopeRef,
      proposal.proposalId,
    ) as {
      authorityDecisionId: string;
      disposition: string;
    } | undefined;
    if (authorityDecision !== undefined) {
      throw new KnowledgeError(
        "invalid_state_transition",
        "the proposal validation ledger is closed after its authority decision",
        {
          proposalId: proposal.proposalId,
          authorityDecisionId: authorityDecision.authorityDecisionId,
          disposition: authorityDecision.disposition,
        },
        [
          "Inspect the existing authority decision.",
          "Submit a new graph-change proposal if new validation evidence changes the candidate.",
        ],
      );
    }
    this.assertValidationSubjects(proposal, parsed);
    const validationReceiptId = `tpv-${domainDigest(
      "vibehub.ticket-proposal-validation-id.v1",
      { scopeRef, requestId: context.requestId },
    )}`;
    const checks = parsed.checks
      .map((check) => ({
        ...check,
        evidenceRefs: [...check.evidenceRefs].sort(
          compareGitTicketCanonicalTextV0,
        ),
        checkId: `tpc-${domainDigest(
          "vibehub.ticket-proposal-validation-check-id.v1",
          { validationReceiptId, localRef: check.localRef },
        )}`,
      }))
      .sort((left, right) =>
        TICKET_PROPOSAL_VALIDATION_CHECK_CODES.indexOf(left.code)
        - TICKET_PROPOSAL_VALIDATION_CHECK_CODES.indexOf(right.code));
    const findings = parsed.findings
      .map((finding) => ({
        ...finding,
        evidenceRefs: [...finding.evidenceRefs].sort(
          compareGitTicketCanonicalTextV0,
        ),
        findingId: `tpf-${domainDigest(
          "vibehub.ticket-proposal-validation-finding-id.v1",
          { validationReceiptId, localRef: finding.localRef },
        )}`,
      }))
      .sort((left, right) =>
        compareGitTicketCanonicalTextV0(left.localRef, right.localRef));
    const indicatedAuthoritySignals = [...new Set([
      ...proposal.reviewRequirement.indicatedAuthoritySignals,
      ...parsed.indicatedAuthoritySignals,
    ])].sort(compareGitTicketCanonicalTextV0);
    const withoutDigest = {
      schemaVersion: 1 as const,
      kind: "ticket_proposal_validation_receipt" as const,
      validationReceiptId,
      scopeRef,
      target: {
        kind: "ticket_graph_change_proposal" as const,
        proposalId: proposal.proposalId,
        proposalDigest: proposal.proposalDigest,
        observedSnapshotId: proposal.observedSnapshotId,
        candidateDigest: proposal.mechanicalReview.candidateDigest,
      },
      recordedAt: context.now,
      producer: {
        kind: "claimed_machine_validator" as const,
        ...parsed.validator,
        trust: "claimed_unverified" as const,
        invokedBy: {
          kind: "claimed_actor" as const,
          ref: context.actor,
        },
      },
      policy: {
        ...parsed.policy,
        trust: "claimed_unverified" as const,
      },
      conclusion: validationConclusion(
        checks.map((check) => check.outcome),
      ),
      checks,
      findings,
      indicatedAuthoritySignals,
      effect: "validation_evidence_only" as const,
      maturityEffect: "none" as const,
      authorityGranted: false as const,
      applicationAuthorized: false as const,
      graphMutationApplied: false as const,
    };
    const receipt: TicketProposalValidationReceiptV0 = {
      ...withoutDigest,
      validationReceiptDigest: domainDigest(
        "vibehub.ticket-proposal-validation.v1",
        withoutDigest,
      ),
    };
    const output = ticketProposalValidationReceiptV0Schema.safeParse(receipt);
    if (!output.success) {
      throw corruptLedger(
        "Core produced an invalid Ticket proposal validation receipt",
        { issues: output.error.issues },
      );
    }
    this.assertTaskScope(scope, context.taskId);
    this.assertRepositoryScope(scope);
    this.persistValidation(scope, context, output.data);
    return output.data;
  }

  inspectValidation(
    scope: TicketProposalRepositoryScopeV0,
    context: TicketProposalSubmitContextV0,
    input: TicketProposalValidationInspectInputV0,
  ): TicketProposalValidationReceiptV0 {
    const parsed = parseInput(
      ticketProposalValidationInspectInputV0Schema,
      input,
      "Ticket proposal validation inspect input",
    );
    this.assertTaskScope(scope, context.taskId);
    this.assertRepositoryScope(scope);
    const receipt = this.readValidationReceipt(
      scope,
      parsed.validationReceiptId,
    );
    this.assertRepositoryScope(scope);
    return receipt;
  }

  listValidations(
    scope: TicketProposalRepositoryScopeV0,
    context: TicketProposalSubmitContextV0,
    input: TicketProposalValidationListInputV0,
  ): TicketProposalValidationLedgerPageV0 {
    const parsed = parseInput(
      ticketProposalValidationListInputV0Schema,
      input,
      "Ticket proposal validation list input",
    );
    this.assertTaskScope(scope, context.taskId);
    this.assertRepositoryScope(scope);
    const scopeRef = proposalScopeRef(scope);
    const proposal = this.readProposal(scope, parsed.proposalId);
    if (proposal.kind !== "graph_change") {
      throw new KnowledgeError(
        "validation_error",
        "comment proposals do not have an independent semantic validation ledger",
        { proposalId: proposal.proposalId, proposalKind: proposal.kind },
        ["List validation receipts only for graph-change proposals."],
      );
    }
    const filterDigest = domainDigest(
      "vibehub.ticket-proposal-validation-list-filter.v1",
      { proposalId: parsed.proposalId },
    );
    const cursor = parsed.cursor === undefined
      ? undefined
      : decodeLedgerCursor(
          parsed.cursor,
          "proposal_validation_list",
          scopeRef,
          filterDigest,
        );
    const throughSequence = cursor?.throughSequence
      ?? this.validationHighWater(
        scope.repoId,
        scopeRef,
        parsed.proposalId,
      );
    const beforeSequence = cursor?.beforeSequence ?? throughSequence + 1;
    const limit = parsed.limit
      ?? TICKET_PROPOSAL_VALIDATION_DEFAULT_PAGE_SIZE;
    const rows = this.db.prepare(
      `SELECT sequence,
              validation_receipt_id validationReceiptId,
              validation_receipt_digest validationReceiptDigest,
              proposal_id proposalId,proposal_digest proposalDigest,
              candidate_digest candidateDigest,recorded_at recordedAt,
              validator_id validatorId,validator_version validatorVersion,
              validator_artifact_digest validatorArtifactDigest,
              policy_id policyId,policy_version policyVersion,
              policy_artifact_digest policyArtifactDigest,
              conclusion,check_count checkCount,
              finding_count findingCount,
              blocking_finding_count blockingFindingCount,
              advisory_finding_count advisoryFindingCount,
              authority_signal_count authoritySignalCount
       FROM ticket_proposal_validation_receipts
       WHERE repo_id=? AND scope_ref=? AND proposal_id=?
         AND sequence<=? AND sequence<?
       ORDER BY sequence DESC
       LIMIT ?`,
    ).all(
      scope.repoId,
      scopeRef,
      parsed.proposalId,
      throughSequence,
      beforeSequence,
      limit + 1,
    ) as ValidationSummaryRow[];
    const hasNext = rows.length > limit;
    const pageRows = hasNext ? rows.slice(0, limit) : rows;
    const total = this.db.prepare(
      `SELECT COUNT(*) totalItems
       FROM ticket_proposal_validation_receipts
       WHERE repo_id=? AND scope_ref=? AND proposal_id=?
         AND sequence<=?`,
    ).get(
      scope.repoId,
      scopeRef,
      parsed.proposalId,
      throughSequence,
    ) as { totalItems: number };
    const items = pageRows.map(validationSummaryFromRow);
    const nextCursor = hasNext
      ? encodeLedgerCursor({
          kind: "proposal_validation_list",
          scopeRef,
          filterDigest,
          throughSequence,
          beforeSequence: pageRows.at(-1)!.sequence,
        })
      : null;
    this.assertRepositoryScope(scope);
    return {
      scopeRef,
      proposalId: parsed.proposalId,
      items,
      page: {
        count: items.length,
        totalItems: safeLedgerInteger(
          total.totalItems,
          "proposal validation list total",
        ),
      },
      nextCursor,
    };
  }

  private assertTaskScope(
    scope: TicketProposalRepositoryScopeV0,
    taskId: string | undefined,
  ): void {
    if (taskId === undefined) return;
    const task = this.db.prepare(
      `SELECT repo_id repoId,worktree_path worktreePath
       FROM tasks WHERE id=?`,
    ).get(taskId) as {
      repoId: number;
      worktreePath: string | null;
    } | undefined;
    if (task === undefined || task.repoId !== scope.repoId) {
      throw new KnowledgeError(
        "ticket_store_scope_mismatch",
        "the proposal task does not belong to the addressed repository",
        { repoId: scope.repoId, taskId },
        ["Use a task belonging to the addressed repository."],
      );
    }
    if (task.worktreePath === null) return;
    let taskWorktreeRoot: string;
    try {
      taskWorktreeRoot = fs.realpathSync(task.worktreePath);
    } catch {
      throw new KnowledgeError(
        "ticket_store_scope_mismatch",
        "the proposal task worktree is no longer readable",
        { repoId: scope.repoId, taskId, taskWorktreePath: task.worktreePath },
        ["Repair the task worktree binding or use its current checkout."],
      );
    }
    if (taskWorktreeRoot === scope.worktreeRoot) return;
    throw new KnowledgeError(
      "ticket_store_scope_mismatch",
      "the proposal checkout does not match the task worktree",
      {
        repoId: scope.repoId,
        taskId,
        taskWorktreeRoot,
        proposalWorktreeRoot: scope.worktreeRoot,
      },
      ["Submit from the checkout bound to the addressed task."],
    );
  }

  private assertRepositoryScope(
    scope: TicketProposalRepositoryScopeV0,
  ): void {
    let repositoryRoot: string;
    let worktreeRoot: string;
    let repositoryIncarnation: string;
    try {
      repositoryRoot = fs.realpathSync(scope.repositoryRoot);
      worktreeRoot = fs.realpathSync(scope.worktreeRoot);
      repositoryIncarnation = gitTicketRepositoryIncarnationV0(
        scope.repositoryRoot,
      );
    } catch (error) {
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError(
        "ticket_store_scope_mismatch",
        "the Ticket proposal repository scope is no longer readable",
        {
          repositoryRoot: scope.repositoryRoot,
          worktreeRoot: scope.worktreeRoot,
        },
        ["Retry from the current repository checkout."],
      );
    }
    if (repositoryRoot === scope.repositoryRoot
      && worktreeRoot === scope.worktreeRoot
      && repositoryIncarnation === scope.repositoryIncarnation) {
      return;
    }
    throw new KnowledgeError(
      "ticket_store_scope_mismatch",
      "the Ticket proposal repository scope changed while handling the ledger",
      {
        expectedRepositoryRoot: scope.repositoryRoot,
        actualRepositoryRoot: repositoryRoot,
        expectedWorktreeRoot: scope.worktreeRoot,
        actualWorktreeRoot: worktreeRoot,
        expectedRepositoryIncarnation: scope.repositoryIncarnation,
        actualRepositoryIncarnation: repositoryIncarnation,
      },
      ["Retry from the current repository checkout."],
    );
  }

  private proposalHighWater(repoId: number, scopeRef: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(sequence),0) highWater
       FROM ticket_proposals WHERE repo_id=? AND scope_ref=?`,
    ).get(repoId, scopeRef) as { highWater: number };
    return safeLedgerInteger(row.highWater, "proposal high-water sequence");
  }

  private validationHighWater(
    repoId: number,
    scopeRef: string,
    proposalId: string,
  ): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(sequence),0) highWater
       FROM ticket_proposal_validation_receipts
       WHERE repo_id=? AND scope_ref=? AND proposal_id=?`,
    ).get(repoId, scopeRef, proposalId) as { highWater: number };
    return safeLedgerInteger(
      row.highWater,
      "proposal validation high-water sequence",
    );
  }

  private readProposal(
    scope: TicketProposalRepositoryScopeV0,
    proposalId: string,
  ): TicketProposalV0 {
    const scopeRef = proposalScopeRef(scope);
    const row = this.db.prepare(
      `SELECT sequence,repo_id repoId,scope_ref scopeRef,
              proposal_id proposalId,proposal_digest proposalDigest,kind,
              observed_snapshot_id observedSnapshotId,
              repository_root repositoryRoot,worktree_root worktreeRoot,
              repository_incarnation repositoryIncarnation,author,
              submitted_at submittedAt,payload,byte_length byteLength
       FROM ticket_proposals
       WHERE repo_id=? AND scope_ref=? AND proposal_id=?`,
    ).get(scope.repoId, scopeRef, proposalId) as
      ProposalStorageRow | undefined;
    if (row === undefined) {
      throw notFound(
        "the Ticket proposal is absent from the verified ledger scope",
        { proposalId },
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.payload);
    } catch {
      throw corruptLedger(
        "the immutable Ticket proposal payload is not valid JSON",
        { proposalId },
      );
    }
    const parsed = ticketProposalV0Schema.safeParse(decoded);
    if (!parsed.success) {
      throw corruptLedger(
        "the immutable Ticket proposal payload violates its stored contract",
        { proposalId, issues: parsed.error.issues },
      );
    }
    const proposal = parsed.data as TicketProposalV0;
    safeLedgerInteger(row.sequence, "proposal sequence");
    const {
      proposalDigest: _storedPayloadDigest,
      ...withoutDigest
    } = proposal;
    const canonicalPayload = serializeGitTicketStoreDocumentV0(proposal);
    const actualByteLength = Buffer.byteLength(row.payload, "utf8");
    const actualDigest = proposalDigest(withoutDigest);
    if (row.repoId !== scope.repoId
      || row.scopeRef !== scopeRef
      || row.proposalId !== proposal.proposalId
      || row.proposalDigest !== proposal.proposalDigest
      || actualDigest !== proposal.proposalDigest
      || row.kind !== proposal.kind
      || row.observedSnapshotId !== proposal.observedSnapshotId
      || row.repositoryRoot !== scope.repositoryRoot
      || row.worktreeRoot !== scope.worktreeRoot
      || row.repositoryIncarnation !== scope.repositoryIncarnation
      || row.author !== proposal.proposer.ref
      || row.submittedAt !== proposal.submittedAt
      || row.byteLength !== actualByteLength
      || row.byteLength > TICKET_PROPOSAL_MAX_OUTPUT_BYTES
      || canonicalPayload !== row.payload) {
      throw corruptLedger(
        "the immutable Ticket proposal payload does not match its ledger binding",
        {
          proposalId,
          storedProposalDigest: row.proposalDigest,
          actualProposalDigest: actualDigest,
        },
      );
    }
    return proposal;
  }

  private readValidationReceipt(
    scope: TicketProposalRepositoryScopeV0,
    validationReceiptId: string,
  ): TicketProposalValidationReceiptV0 {
    const scopeRef = proposalScopeRef(scope);
    const row = this.db.prepare(
      `SELECT sequence,repo_id repoId,scope_ref scopeRef,
              validation_receipt_id validationReceiptId,
              validation_receipt_digest validationReceiptDigest,
              proposal_id proposalId,proposal_digest proposalDigest,
              observed_snapshot_id observedSnapshotId,
              candidate_digest candidateDigest,
              repository_root repositoryRoot,worktree_root worktreeRoot,
              repository_incarnation repositoryIncarnation,author,
              recorded_at recordedAt,validator_id validatorId,
              validator_version validatorVersion,
              validator_artifact_digest validatorArtifactDigest,
              policy_id policyId,policy_version policyVersion,
              policy_artifact_digest policyArtifactDigest,conclusion,
              check_count checkCount,finding_count findingCount,
              blocking_finding_count blockingFindingCount,
              advisory_finding_count advisoryFindingCount,
              authority_signal_count authoritySignalCount,
              payload,byte_length byteLength
       FROM ticket_proposal_validation_receipts
       WHERE repo_id=? AND scope_ref=? AND validation_receipt_id=?`,
    ).get(scope.repoId, scopeRef, validationReceiptId) as
      ValidationStorageRow | undefined;
    if (row === undefined) {
      throw notFound(
        "the Ticket proposal validation receipt is absent from the verified ledger scope",
        { validationReceiptId },
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.payload);
    } catch {
      throw corruptLedger(
        "the immutable Ticket proposal validation payload is not valid JSON",
        { validationReceiptId },
      );
    }
    const parsed = ticketProposalValidationReceiptV0Schema.safeParse(decoded);
    if (!parsed.success) {
      throw corruptLedger(
        "the immutable Ticket proposal validation payload violates its stored contract",
        { validationReceiptId, issues: parsed.error.issues },
      );
    }
    const receipt = parsed.data as TicketProposalValidationReceiptV0;
    safeLedgerInteger(row.sequence, "proposal validation sequence");
    const {
      validationReceiptDigest: _storedPayloadDigest,
      ...withoutDigest
    } = receipt;
    const actualDigest = domainDigest(
      "vibehub.ticket-proposal-validation.v1",
      withoutDigest,
    );
    const canonicalPayload = serializeGitTicketStoreDocumentV0(receipt);
    const actualByteLength = Buffer.byteLength(row.payload, "utf8");
    const blockingFindingCount = receipt.findings.filter(
      (finding) => finding.impact === "blocking",
    ).length;
    const advisoryFindingCount =
      receipt.findings.length - blockingFindingCount;
    const checkIdentitiesValid = receipt.checks.every((check) =>
      check.checkId === `tpc-${domainDigest(
        "vibehub.ticket-proposal-validation-check-id.v1",
        {
          validationReceiptId: receipt.validationReceiptId,
          localRef: check.localRef,
        },
      )}`);
    const findingIdentitiesValid = receipt.findings.every((finding) =>
      finding.findingId === `tpf-${domainDigest(
        "vibehub.ticket-proposal-validation-finding-id.v1",
        {
          validationReceiptId: receipt.validationReceiptId,
          localRef: finding.localRef,
        },
      )}`);
    if (row.repoId !== scope.repoId
      || row.scopeRef !== scopeRef
      || row.validationReceiptId !== receipt.validationReceiptId
      || row.validationReceiptDigest !== receipt.validationReceiptDigest
      || actualDigest !== receipt.validationReceiptDigest
      || row.proposalId !== receipt.target.proposalId
      || row.proposalDigest !== receipt.target.proposalDigest
      || row.observedSnapshotId !== receipt.target.observedSnapshotId
      || row.candidateDigest !== receipt.target.candidateDigest
      || row.repositoryRoot !== scope.repositoryRoot
      || row.worktreeRoot !== scope.worktreeRoot
      || row.repositoryIncarnation !== scope.repositoryIncarnation
      || row.author !== receipt.producer.invokedBy.ref
      || row.recordedAt !== receipt.recordedAt
      || row.validatorId !== receipt.producer.id
      || row.validatorVersion !== receipt.producer.version
      || row.validatorArtifactDigest !== receipt.producer.artifactDigest
      || row.policyId !== receipt.policy.id
      || row.policyVersion !== receipt.policy.version
      || row.policyArtifactDigest !== receipt.policy.artifactDigest
      || row.conclusion !== receipt.conclusion
      || row.checkCount !== receipt.checks.length
      || row.findingCount !== receipt.findings.length
      || row.blockingFindingCount !== blockingFindingCount
      || row.advisoryFindingCount !== advisoryFindingCount
      || row.authoritySignalCount
        !== receipt.indicatedAuthoritySignals.length
      || row.byteLength !== actualByteLength
      || !checkIdentitiesValid
      || !findingIdentitiesValid
      || canonicalPayload !== row.payload) {
      throw corruptLedger(
        "the immutable Ticket proposal validation payload does not match its ledger binding",
        {
          validationReceiptId,
          storedValidationReceiptDigest: row.validationReceiptDigest,
          actualValidationReceiptDigest: actualDigest,
        },
      );
    }
    const proposal = this.readProposal(scope, receipt.target.proposalId);
    if (proposal.kind !== "graph_change"
      || proposal.proposalDigest !== receipt.target.proposalDigest
      || proposal.observedSnapshotId !== receipt.target.observedSnapshotId
      || proposal.mechanicalReview.candidateDigest
        !== receipt.target.candidateDigest
      || proposal.reviewRequirement.indicatedAuthoritySignals.some(
        (signal) => !receipt.indicatedAuthoritySignals.includes(signal),
      )) {
      throw corruptLedger(
        "the Ticket proposal validation receipt no longer binds its exact proposal target",
        { validationReceiptId, proposalId: receipt.target.proposalId },
      );
    }
    return receipt;
  }

  private assertValidationSubjects(
    proposal: TicketGraphChangeProposalV0,
    input: TicketProposalValidationRecordInputV0,
  ): void {
    const changedTickets = new Map(proposal.changes.map((change) => [
      change.definition.ticketId,
      change.definition.definitionRevision,
    ]));
    const changedDependencies = new Set<string>();
    for (const change of proposal.changes) {
      for (const prerequisiteTicketId of
        change.dependencyDelta.addedPrerequisiteTicketIds) {
        changedDependencies.add(dependencyDeltaSubjectKey(
          "added",
          prerequisiteTicketId,
          change.definition.ticketId,
        ));
      }
      for (const prerequisiteTicketId of
        change.dependencyDelta.removedPrerequisiteTicketIds) {
        changedDependencies.add(dependencyDeltaSubjectKey(
          "removed",
          prerequisiteTicketId,
          change.definition.ticketId,
        ));
      }
    }
    const assertSubject = (
      subject:
        TicketProposalValidationRecordInputV0["checks"][number]["subject"],
      path: string,
    ): void => {
      if (subject.kind === "proposal") return;
      if (subject.kind === "ticket_change") {
        if (changedTickets.get(subject.ticketId)
          === subject.definitionRevision) {
          return;
        }
      } else if (changedDependencies.has(dependencyDeltaSubjectKey(
        subject.change,
        subject.prerequisiteTicketId,
        subject.dependentTicketId,
      ))) {
        return;
      }
      throw new KnowledgeError(
        "validation_error",
        "a proposal validation subject is not an exact change in the target proposal",
        { path, subject, proposalId: proposal.proposalId },
        ["Use proposal, ticket revision, and dependency subjects copied from the inspected proposal."],
      );
    };
    input.checks.forEach((check, index) =>
      assertSubject(check.subject, `checks[${index}].subject`));
    input.findings.forEach((finding, index) =>
      assertSubject(finding.subject, `findings[${index}].subject`));
  }

  private persistValidation(
    scope: TicketProposalRepositoryScopeV0,
    context: TicketProposalSubmitContextV0,
    receipt: TicketProposalValidationReceiptV0,
  ): void {
    const payload = serializeGitTicketStoreDocumentV0(receipt);
    const byteLength = Buffer.byteLength(payload, "utf8");
    const blockingFindingCount = receipt.findings.filter(
      (finding) => finding.impact === "blocking",
    ).length;
    const advisoryFindingCount =
      receipt.findings.length - blockingFindingCount;
    this.db.prepare(
      `INSERT INTO ticket_proposal_validation_receipts(
         repo_id,scope_ref,validation_receipt_id,
         validation_receipt_digest,proposal_id,proposal_digest,
         observed_snapshot_id,candidate_digest,
         repository_root,worktree_root,repository_incarnation,
         author,task_id,request_id,recorded_at,
         validator_id,validator_version,validator_artifact_digest,
         policy_id,policy_version,policy_artifact_digest,conclusion,
         check_count,finding_count,blocking_finding_count,
         advisory_finding_count,authority_signal_count,payload,byte_length
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      scope.repoId,
      receipt.scopeRef,
      receipt.validationReceiptId,
      receipt.validationReceiptDigest,
      receipt.target.proposalId,
      receipt.target.proposalDigest,
      receipt.target.observedSnapshotId,
      receipt.target.candidateDigest,
      scope.repositoryRoot,
      scope.worktreeRoot,
      scope.repositoryIncarnation,
      context.actor,
      context.taskId ?? null,
      context.requestId,
      context.now,
      receipt.producer.id,
      receipt.producer.version,
      receipt.producer.artifactDigest,
      receipt.policy.id,
      receipt.policy.version,
      receipt.policy.artifactDigest,
      receipt.conclusion,
      receipt.checks.length,
      receipt.findings.length,
      blockingFindingCount,
      advisoryFindingCount,
      receipt.indicatedAuthoritySignals.length,
      payload,
      byteLength,
    );
    const stored = this.db.prepare(
      `SELECT validation_receipt_digest validationReceiptDigest,
              payload,byte_length byteLength
       FROM ticket_proposal_validation_receipts
       WHERE repo_id=? AND validation_receipt_id=?`,
    ).get(scope.repoId, receipt.validationReceiptId) as {
      validationReceiptDigest: string;
      payload: string;
      byteLength: number;
    } | undefined;
    if (stored === undefined
      || stored.validationReceiptDigest !== receipt.validationReceiptDigest
      || stored.payload !== payload
      || stored.byteLength !== byteLength) {
      throw corruptLedger(
        "the immutable Ticket proposal validation receipt could not be verified after recording",
        { validationReceiptId: receipt.validationReceiptId },
      );
    }
  }

  private prepareComment(
    proposalId: string,
    scopeRef: string,
    context: TicketProposalSubmitContextV0,
    input: Extract<TicketProposalSubmitInputV0, { kind: "comment" }>,
    definitions: GitTicketDefinitionRevisionV0[],
    source: ReturnType<typeof loadCurrentGitTicketAuthoringBaseV0>["source"],
  ): TicketProposalV0 {
    const subject = input.subject;
    if (subject.kind === "ticket") {
      const definition = definitions.find(
        (item) => item.ticketId === subject.ticketId,
      );
      if (definition === undefined) {
        throw notFound(
          "the comment subject Ticket is absent from the observed snapshot",
          { subject },
        );
      }
      if (definition.definitionRevision
        !== subject.definitionRevision) {
        throw conflict(
          "the comment subject revision does not match the observed snapshot",
          {
            subject,
            actualDefinitionRevision: definition.definitionRevision,
          },
        );
      }
    } else {
      const relation = source?.directUnlocks.find(
        (item) => item.relationRef === subject.relationRef,
      );
      if (relation === undefined
        || relation.prerequisiteTicketId
          !== subject.prerequisiteTicketId
        || relation.dependentTicketId
          !== subject.dependentTicketId) {
        throw notFound(
          "the exact comment relation is absent from the observed snapshot",
          { subject },
        );
      }
    }
    const withoutDigest = {
      schemaVersion: 1 as const,
      kind: "comment" as const,
      proposalId,
      scopeRef,
      observedSnapshotId: input.observedSnapshotId,
      submittedAt: context.now,
      proposer: {
        kind: "claimed_actor" as const,
        ref: context.actor,
      },
      effect: "review_contribution_only" as const,
      graphMutationApplied: false as const,
      subject: subject.kind === "ticket"
        ? {
            kind: "ticket" as const,
            ticketId: subject.ticketId,
            definitionRevision: subject.definitionRevision,
          }
        : {
            kind: "relation" as const,
            relationRef: subject.relationRef,
            prerequisiteTicketId: subject.prerequisiteTicketId,
            dependentTicketId: subject.dependentTicketId,
          },
      body: input.body,
      reviewRequirement: {
        independentMachineValidation: "not_applicable" as const,
        authorityStatus: "not_granted" as const,
        routeHint: "comment_only" as const,
        indicatedAuthoritySignals: [],
      },
    };
    return {
      ...withoutDigest,
      proposalDigest: proposalDigest(withoutDigest),
    };
  }

  private prepareGraphChange(
    proposalId: string,
    scopeRef: string,
    context: TicketProposalSubmitContextV0,
    input: Extract<TicketProposalSubmitInputV0, { kind: "graph_change" }>,
    storeId: string | null,
    currentDefinitions: GitTicketDefinitionRevisionV0[],
  ): TicketGraphChangeProposalV0 {
    assertUnique(
      input.authorAssessment.authoritySignals,
      "authorAssessment.authoritySignals",
    );
    const creates = input.changes.filter(
      (change): change is Extract<typeof change, { op: "create" }> =>
        change.op === "create",
    );
    assertUnique(
      creates.map((change) => change.localRef),
      "create localRef values",
    );
    const localIds = new Map(creates.map((change) => [
      change.localRef,
      `tkt-${domainDigest("vibehub.ticket-id.v1", {
        proposalId,
        localRef: change.localRef,
      })}`,
    ]));
    const currentById = new Map(
      currentDefinitions.map((definition) => [
        definition.ticketId,
        definition,
      ]),
    );
    const targetIds = input.changes.map((change) =>
      change.op === "create"
        ? requiredLocalId(localIds, change.localRef)
        : change.ticketId);
    assertUnique(targetIds, "proposal mutation targets");
    for (const ticketId of localIds.values()) {
      if (currentById.has(ticketId)) {
        throw conflict(
          "a generated Ticket identity already exists in the observed graph",
          { ticketId },
        );
      }
    }

    const proposalRef = `${PROPOSAL_PROVENANCE_PREFIX}${proposalId}`;
    const candidateById = new Map(currentDefinitions.map((definition) => [
      definition.ticketId,
      definition,
    ]));
    const materializedChanges: TicketGraphChangeProposalV0["changes"] = [];

    for (const change of input.changes) {
      if (change.op === "create") {
        const ticketId = requiredLocalId(localIds, change.localRef);
        const materialized = materializeBody(
          change.definition,
          localIds,
          [proposalRef],
        );
        const definition: GitTicketDefinitionRevisionV0 = {
          schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
          kind: "ticket_definition_revision",
          ticketId,
          definitionRevision: 1,
          created: {
            at: context.now,
            by: context.actor,
            reason: input.reason,
            source: input.source ?? null,
          },
          ...materialized,
        };
        candidateById.set(ticketId, definition);
        materializedChanges.push({
          op: "create",
          localRef: change.localRef,
          ticketId,
          dependencyDelta: {
            addedPrerequisiteTicketIds: definition.dependsOn
              .map((dependency) => dependency.ticketId),
            removedPrerequisiteTicketIds: [],
          },
          definition: proposalDefinition(definition),
        });
        continue;
      }

      const current = currentById.get(change.ticketId);
      if (current === undefined) {
        throw notFound(
          "a revised Ticket is absent from the observed snapshot",
          { ticketId: change.ticketId },
        );
      }
      if (current.definitionRevision
        !== change.expectedDefinitionRevision) {
        throw conflict(
          "a revised Ticket no longer has the expected definition revision",
          {
            ticketId: change.ticketId,
            expectedDefinitionRevision:
              change.expectedDefinitionRevision,
            actualDefinitionRevision: current.definitionRevision,
          },
        );
      }
      const materialized = materializeBody(
        change.replacement,
        localIds,
        [...current.provenanceRefs, proposalRef],
      );
      assertDefinitionBodyChanged(current, materialized);
      const definition: GitTicketDefinitionRevisionV0 = {
        schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
        kind: "ticket_definition_revision",
        ticketId: current.ticketId,
        definitionRevision: current.definitionRevision + 1,
        created: current.created,
        ...materialized,
      };
      candidateById.set(definition.ticketId, definition);
      const previousDependencies = new Set(
        current.dependsOn.map((dependency) => dependency.ticketId),
      );
      const currentDependencies = new Set(
        definition.dependsOn.map((dependency) => dependency.ticketId),
      );
      materializedChanges.push({
        op: "revise",
        ticketId: definition.ticketId,
        expectedDefinitionRevision: change.expectedDefinitionRevision,
        previousOutcome: current.outcome,
        previousParentId: current.parentId,
        dependencyDelta: {
          addedPrerequisiteTicketIds: [...currentDependencies]
            .filter((ticketId) => !previousDependencies.has(ticketId))
            .sort(compareGitTicketCanonicalTextV0),
          removedPrerequisiteTicketIds: [...previousDependencies]
            .filter((ticketId) => !currentDependencies.has(ticketId))
            .sort(compareGitTicketCanonicalTextV0),
        },
        definition: proposalDefinition(definition),
      });
    }

    const candidateDefinitions = [...candidateById.values()];
    validateGitTicketRevisionTransitionV0(
      currentDefinitions,
      candidateDefinitions,
    );
    const prepared = prepareGitTicketGenerationV0(
      storeId ?? VALIDATION_STORE_ID,
      candidateDefinitions,
    );
    const candidateDigest = domainDigest(
      "vibehub.ticket-proposal-candidate.v1",
      prepared.definitions,
    );
    const indicatedAuthoritySignals = new Set(
      input.authorAssessment.authoritySignals,
    );
    if (input.observedSnapshotId === null) {
      indicatedAuthoritySignals.add("initial_plan_authority");
    }
    const authorityIndicated =
      input.observedSnapshotId === null
      || input.authorAssessment.changeClass === "expansion"
      || input.authorAssessment.introducesHumanGate
      || indicatedAuthoritySignals.size > 0;
    const withoutDigest = {
      schemaVersion: 1 as const,
      kind: "graph_change" as const,
      proposalId,
      scopeRef,
      observedSnapshotId: input.observedSnapshotId,
      submittedAt: context.now,
      proposer: {
        kind: "claimed_actor" as const,
        ref: context.actor,
      },
      effect: "review_contribution_only" as const,
      graphMutationApplied: false as const,
      reason: input.reason,
      source: input.source ?? null,
      authorAssessment: input.authorAssessment,
      changes: materializedChanges,
      mechanicalReview: {
        status: "passed" as const,
        baseTicketCount: currentDefinitions.length,
        candidateTicketCount: prepared.definitions.length,
        createdTicketIds: materializedChanges
          .filter((change) => change.op === "create")
          .map((change) => change.ticketId)
          .sort(),
        revisedTicketIds: materializedChanges
          .filter((change) => change.op === "revise")
          .map((change) => change.ticketId)
          .sort(),
        candidateDigest,
      },
      reviewRequirement: {
        independentMachineValidation: "required" as const,
        authorityStatus: "not_granted" as const,
        routeHint: authorityIndicated
          ? "human_authority_indicated" as const
          : "delegated_application_candidate" as const,
        indicatedAuthoritySignals: [...indicatedAuthoritySignals].sort(),
      },
    };
    return {
      ...withoutDigest,
      proposalDigest: proposalDigest(withoutDigest),
    };
  }

  private persist(
    scope: TicketProposalRepositoryScopeV0,
    context: TicketProposalSubmitContextV0,
    proposal: TicketProposalV0,
  ): void {
    const payload = serializeGitTicketStoreDocumentV0(proposal);
    this.db.prepare(
      `INSERT INTO ticket_proposals(
         repo_id,scope_ref,proposal_id,proposal_digest,kind,
         observed_snapshot_id,repository_root,worktree_root,
         repository_incarnation,author,task_id,request_id,
         submitted_at,payload,byte_length
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      scope.repoId,
      proposal.scopeRef,
      proposal.proposalId,
      proposal.proposalDigest,
      proposal.kind,
      proposal.observedSnapshotId,
      scope.repositoryRoot,
      scope.worktreeRoot,
      scope.repositoryIncarnation,
      context.actor,
      context.taskId ?? null,
      context.requestId,
      context.now,
      payload,
      Buffer.byteLength(payload, "utf8"),
    );
    const stored = this.db.prepare(
      `SELECT proposal_digest proposalDigest,payload,byte_length byteLength
       FROM ticket_proposals
       WHERE repo_id=? AND proposal_id=?`,
    ).get(scope.repoId, proposal.proposalId) as {
      proposalDigest: string;
      payload: string;
      byteLength: number;
    } | undefined;
    if (stored === undefined
      || stored.proposalDigest !== proposal.proposalDigest
      || stored.payload !== payload
      || stored.byteLength !== Buffer.byteLength(payload, "utf8")) {
      throw new KnowledgeError(
        "internal_error",
        "the immutable Ticket proposal could not be verified after recording",
        { proposalId: proposal.proposalId },
        ["Restore the operational database from a consistent backup."],
      );
    }
  }
}

interface ProposalSummaryRow {
  sequence: number;
  proposalId: string;
  proposalDigest: string;
  kind: string;
  observedSnapshotId: string | null;
  author: string;
  submittedAt: string;
}

interface ProposalStorageRow extends ProposalSummaryRow {
  repoId: number;
  scopeRef: string;
  repositoryRoot: string;
  worktreeRoot: string;
  repositoryIncarnation: string;
  payload: string;
  byteLength: number;
}

interface ValidationSummaryRow {
  sequence: number;
  validationReceiptId: string;
  validationReceiptDigest: string;
  proposalId: string;
  proposalDigest: string;
  candidateDigest: string;
  recordedAt: string;
  validatorId: string;
  validatorVersion: string;
  validatorArtifactDigest: string;
  policyId: string;
  policyVersion: string;
  policyArtifactDigest: string;
  conclusion: string;
  checkCount: number;
  findingCount: number;
  blockingFindingCount: number;
  advisoryFindingCount: number;
  authoritySignalCount: number;
}

interface ValidationStorageRow extends ValidationSummaryRow {
  repoId: number;
  scopeRef: string;
  observedSnapshotId: string | null;
  repositoryRoot: string;
  worktreeRoot: string;
  repositoryIncarnation: string;
  author: string;
  payload: string;
  byteLength: number;
}

type LedgerCursorKind = "proposal_list" | "proposal_validation_list";

interface LedgerCursorCore {
  v: 1;
  kind: LedgerCursorKind;
  scopeRef: string;
  filterDigest: string;
  throughSequence: number;
  beforeSequence: number;
}

interface LedgerCursor extends LedgerCursorCore {
  checksum: string;
}

function parseInput<T>(
  schema: {
    safeParse(input: unknown):
      | { success: true; data: T }
      | { success: false; error: { issues: unknown[] } };
  },
  input: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new KnowledgeError(
    "validation_error",
    `${label} violates its contract`,
    { issues: parsed.error.issues },
    ["Correct the reported fields and retry."],
  );
}

function proposalListFilter(input: TicketProposalListInputV0): {
  sql: string;
  parameters: unknown[];
  identity: unknown;
} {
  const fragments: string[] = [];
  const parameters: unknown[] = [];
  if (input.kind !== undefined) {
    fragments.push("AND kind=?");
    parameters.push(input.kind);
  }
  let observedSnapshot: string;
  if (input.observedSnapshotId === undefined) {
    observedSnapshot = "all";
  } else if (input.observedSnapshotId === null) {
    observedSnapshot = "bootstrap";
    fragments.push("AND observed_snapshot_id IS NULL");
  } else {
    observedSnapshot = input.observedSnapshotId;
    fragments.push("AND observed_snapshot_id=?");
    parameters.push(input.observedSnapshotId);
  }
  return {
    sql: fragments.join("\n         "),
    parameters,
    identity: {
      kind: input.kind ?? "all",
      observedSnapshot,
    },
  };
}

function proposalSummaryFromRow(
  row: ProposalSummaryRow,
): TicketProposalSummaryV0 {
  safeLedgerInteger(row.sequence, "proposal sequence");
  const kind = row.kind === "comment" || row.kind === "graph_change"
    ? row.kind
    : undefined;
  if (kind === undefined
    || !/^tgp-[0-9a-f]{64}$/u.test(row.proposalId)
    || !isDigest(row.proposalDigest)
    || (row.observedSnapshotId !== null
      && !/^tgs-[0-9a-f]{64}$/u.test(row.observedSnapshotId))
    || !isCanonicalStoredString(row.author, 200)
    || !isInstant(row.submittedAt)) {
    throw corruptLedger(
      "a Ticket proposal list summary violates its column contract",
      { proposalId: row.proposalId },
    );
  }
  return {
    proposalId: row.proposalId,
    proposalDigest: row.proposalDigest,
    kind,
    observedSnapshotId: row.observedSnapshotId,
    submittedAt: row.submittedAt,
    proposer: {
      kind: "claimed_actor",
      ref: row.author,
    },
  };
}

function validationSummaryFromRow(
  row: ValidationSummaryRow,
): TicketProposalValidationSummaryV0 {
  safeLedgerInteger(row.sequence, "proposal validation sequence");
  const conclusion = row.conclusion === "passed"
    || row.conclusion === "failed"
    || row.conclusion === "inconclusive"
    ? row.conclusion
    : undefined;
  const counts = [
    row.checkCount,
    row.findingCount,
    row.blockingFindingCount,
    row.advisoryFindingCount,
    row.authoritySignalCount,
  ];
  if (conclusion === undefined
    || !/^tpv-[0-9a-f]{64}$/u.test(row.validationReceiptId)
    || !isDigest(row.validationReceiptDigest)
    || !/^tgp-[0-9a-f]{64}$/u.test(row.proposalId)
    || !isDigest(row.proposalDigest)
    || !isDigest(row.candidateDigest)
    || !isInstant(row.recordedAt)
    || !isCanonicalStoredString(row.validatorId, 200)
    || !isCanonicalStoredString(row.validatorVersion, 100)
    || !isDigest(row.validatorArtifactDigest)
    || !isCanonicalStoredString(row.policyId, 200)
    || !isCanonicalStoredString(row.policyVersion, 100)
    || !isDigest(row.policyArtifactDigest)
    || counts.some((count) =>
      !Number.isSafeInteger(count) || count < 0)
    || row.checkCount !== TICKET_PROPOSAL_VALIDATION_CHECK_CODES.length
    || row.findingCount > TICKET_PROPOSAL_VALIDATION_MAX_FINDINGS
    || row.blockingFindingCount > TICKET_PROPOSAL_VALIDATION_MAX_FINDINGS
    || row.advisoryFindingCount > TICKET_PROPOSAL_VALIDATION_MAX_FINDINGS
    || row.authoritySignalCount > TICKET_PROPOSAL_AUTHORITY_SIGNALS.length
    || row.blockingFindingCount + row.advisoryFindingCount
      !== row.findingCount) {
    throw corruptLedger(
      "a Ticket proposal validation list summary violates its column contract",
      { validationReceiptId: row.validationReceiptId },
    );
  }
  return {
    validationReceiptId: row.validationReceiptId,
    validationReceiptDigest: row.validationReceiptDigest,
    proposalId: row.proposalId,
    proposalDigest: row.proposalDigest,
    candidateDigest: row.candidateDigest,
    recordedAt: row.recordedAt,
    validator: {
      kind: "claimed_machine_validator",
      id: row.validatorId,
      version: row.validatorVersion,
      artifactDigest: row.validatorArtifactDigest,
      trust: "claimed_unverified",
    },
    policy: {
      id: row.policyId,
      version: row.policyVersion,
      artifactDigest: row.policyArtifactDigest,
      trust: "claimed_unverified",
    },
    conclusion,
    checkCount: row.checkCount,
    findingCount: row.findingCount,
    blockingFindingCount: row.blockingFindingCount,
    advisoryFindingCount: row.advisoryFindingCount,
    authoritySignalCount: row.authoritySignalCount,
    effect: "validation_evidence_only",
    maturityEffect: "none",
    authorityGranted: false,
    applicationAuthorized: false,
    graphMutationApplied: false,
  };
}

function validationConclusion(
  outcomes: readonly TicketProposalValidationCheckOutcomeV0[],
): TicketProposalValidationCheckOutcomeV0 {
  if (outcomes.some((outcome) => outcome === "failed")) return "failed";
  if (outcomes.some((outcome) => outcome === "inconclusive")) {
    return "inconclusive";
  }
  return "passed";
}

function dependencyDeltaSubjectKey(
  change: "added" | "removed",
  prerequisiteTicketId: string,
  dependentTicketId: string,
): string {
  return `${change}\0${prerequisiteTicketId}\0${dependentTicketId}`;
}

function encodeLedgerCursor(input: Omit<LedgerCursorCore, "v">): string {
  const core: LedgerCursorCore = {
    v: 1,
    ...input,
  };
  const cursor: LedgerCursor = {
    ...core,
    checksum: domainDigest("vibehub.ticket-proposal-cursor.v1", core),
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeLedgerCursor(
  value: string,
  expectedKind: LedgerCursorKind,
  expectedScopeRef: string,
  expectedFilterDigest: string,
): LedgerCursor {
  const invalid = (): never => {
    throw new KnowledgeError(
      "validation_error",
      "the Ticket proposal ledger cursor is invalid for this query",
      null,
      ["Restart pagination without a cursor."],
    );
  };
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return invalid();
  let decodedText: string;
  let decoded: unknown;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) return invalid();
    decodedText = bytes.toString("utf8");
    decoded = JSON.parse(decodedText);
  } catch {
    return invalid();
  }
  if (decoded === null
    || typeof decoded !== "object"
    || Array.isArray(decoded)
    || Object.getPrototypeOf(decoded) !== Object.prototype) {
    return invalid();
  }
  const record = decoded as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    "beforeSequence",
    "checksum",
    "filterDigest",
    "kind",
    "scopeRef",
    "throughSequence",
    "v",
  ];
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])) {
    return invalid();
  }
  if (record["v"] !== 1
    || record["kind"] !== expectedKind
    || record["scopeRef"] !== expectedScopeRef
    || record["filterDigest"] !== expectedFilterDigest
    || !isDigest(record["checksum"])
    || !isSafeLedgerCursorInteger(record["throughSequence"], true)
    || !isSafeLedgerCursorInteger(record["beforeSequence"], false)
    || (record["beforeSequence"] as number)
      > (record["throughSequence"] as number) + 1) {
    return invalid();
  }
  const core: LedgerCursorCore = {
    v: 1,
    kind: record["kind"] as LedgerCursorKind,
    scopeRef: record["scopeRef"] as string,
    filterDigest: record["filterDigest"] as string,
    throughSequence: record["throughSequence"] as number,
    beforeSequence: record["beforeSequence"] as number,
  };
  if (record["checksum"] !== domainDigest(
    "vibehub.ticket-proposal-cursor.v1",
    core,
  )) {
    return invalid();
  }
  return {
    ...core,
    checksum: record["checksum"] as string,
  };
}

function isSafeLedgerCursorInteger(
  value: unknown,
  allowZero: boolean,
): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= (allowZero ? 0 : 1)
    && (value as number) < Number.MAX_SAFE_INTEGER;
}

function safeLedgerInteger(value: number, label: string): number {
  if (isSafeLedgerCursorInteger(value, true)) return value;
  throw corruptLedger(`the ${label} is outside the supported range`, {
    value,
  });
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isInstant(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 100
    && Number.isFinite(Date.parse(value))
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u
      .test(value);
}

function isCanonicalStoredString(
  value: unknown,
  maximum: number,
): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && [...value].length <= maximum;
}

function corruptLedger(message: string, details: unknown): KnowledgeError {
  return new KnowledgeError(
    "internal_error",
    message,
    details,
    ["Restore the operational database from a consistent backup."],
  );
}

function materializeBody(
  input: TicketProposalDefinitionBodyInputV0,
  localIds: ReadonlyMap<string, string>,
  requiredProvenanceRefs: string[],
): Pick<
  GitTicketDefinitionRevisionV0,
  "outcome" | "parentId" | "dependsOn" | "provenanceRefs"
> {
  const parentId = input.parent === null
    ? null
    : resolveDefinitionRef(input.parent, localIds);
  const dependsOn = input.dependsOn.map((dependency) => ({
    ticketId: resolveDefinitionRef(dependency.target, localIds),
    ...(dependency.rationale === undefined
      ? {}
      : { rationale: dependency.rationale }),
  })).sort((left, right) =>
    compareGitTicketCanonicalTextV0(left.ticketId, right.ticketId));
  assertUnique(
    dependsOn.map((dependency) => dependency.ticketId),
    "definition dependencies",
  );
  return {
    outcome: input.outcome,
    parentId,
    dependsOn,
    provenanceRefs: [...new Set([
      ...requiredProvenanceRefs,
    ])].sort(),
  };
}

function resolveDefinitionRef(
  ref: TicketProposalDefinitionRefV0,
  localIds: ReadonlyMap<string, string>,
): string {
  return ref.kind === "ticket"
    ? ref.ticketId
    : requiredLocalId(localIds, ref.localRef);
}

function requiredLocalId(
  localIds: ReadonlyMap<string, string>,
  localRef: string,
): string {
  const ticketId = localIds.get(localRef);
  if (ticketId !== undefined) return ticketId;
  throw new KnowledgeError(
    "validation_error",
    "a Ticket proposal references an unknown localRef",
    { localRef },
    ["Create the localRef in the same proposal or use an existing Ticket ID."],
  );
}

function proposalDefinition(
  definition: GitTicketDefinitionRevisionV0,
): TicketProposalMaterializedDefinitionV0 {
  return {
    ticketId: definition.ticketId,
    definitionRevision: definition.definitionRevision,
    created: {
      ...definition.created,
      trust: "claimed_unverified",
    },
    outcome: definition.outcome,
    parentId: definition.parentId,
    dependsOn: definition.dependsOn,
    provenanceRefs: definition.provenanceRefs,
  };
}

function assertDefinitionBodyChanged(
  current: GitTicketDefinitionRevisionV0,
  candidate: Pick<
    GitTicketDefinitionRevisionV0,
    "outcome" | "parentId" | "dependsOn"
  >,
): void {
  const currentBody = {
    outcome: current.outcome,
    parentId: current.parentId,
    dependsOn: current.dependsOn,
  };
  const candidateBody = {
    outcome: candidate.outcome,
    parentId: candidate.parentId,
    dependsOn: candidate.dependsOn,
  };
  if (serializeGitTicketStoreDocumentV0(currentBody)
    === serializeGitTicketStoreDocumentV0(candidateBody)) {
    throw new KnowledgeError(
      "validation_error",
      "a Ticket revision proposal must change its outcome or relations",
      { ticketId: current.ticketId },
      ["Remove the no-op revision or describe a material definition change."],
    );
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size === values.length) return;
  throw new KnowledgeError(
    "validation_error",
    `${label} must be unique`,
    { label },
    ["Remove duplicate proposal entries and retry."],
  );
}

function proposalScopeRef(scope: TicketProposalRepositoryScopeV0): string {
  return ticketProposalScopeRefV0(scope);
}

export function ticketProposalScopeRefV0(
  scope: TicketProposalRepositoryScopeV0,
): string {
  return `tps-${ticketProposalDomainDigestV0(
    "vibehub.ticket-proposal-scope.v1",
    {
    repoId: scope.repoId,
    repositoryRoot: scope.repositoryRoot,
    worktreeRoot: scope.worktreeRoot,
    repositoryIncarnation: scope.repositoryIncarnation,
    },
  )}`;
}

function proposalDigest(value: unknown): string {
  return domainDigest("vibehub.ticket-proposal.v1", value);
}

function domainDigest(domain: string, value: unknown): string {
  return ticketProposalDomainDigestV0(domain, value);
}

export function ticketProposalDomainDigestV0(
  domain: string,
  value: unknown,
): string {
  return crypto.createHash("sha256")
    .update(domain)
    .update("\0")
    .update(serializeGitTicketStoreDocumentV0(value))
    .digest("hex");
}

function proposalGitDefinition(
  definition: TicketProposalMaterializedDefinitionV0,
): GitTicketDefinitionRevisionV0 {
  const {
    trust: _trust,
    ...created
  } = definition.created;
  return {
    schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
    kind: "ticket_definition_revision",
    ticketId: definition.ticketId,
    definitionRevision: definition.definitionRevision,
    created,
    outcome: definition.outcome,
    parentId: definition.parentId,
    dependsOn: definition.dependsOn.map((dependency) => ({ ...dependency })),
    provenanceRefs: [...definition.provenanceRefs],
  };
}

function conflict(message: string, details: unknown): KnowledgeError {
  return new KnowledgeError(
    "cas_conflict",
    message,
    details,
    ["Refresh ticket.graph.snapshot and submit a new proposal."],
  );
}

function notFound(message: string, details: unknown): KnowledgeError {
  return new KnowledgeError(
    "not_found",
    message,
    details,
    ["Refresh ticket.graph.snapshot and choose an exact current subject."],
  );
}
