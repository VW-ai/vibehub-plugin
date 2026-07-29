import type {
  TicketProposalApplicationIntentV0,
  TicketProposalApplicationReceiptV0,
  TicketProposalApplyInputV0,
  TicketProposalAuthorityDecideInputV0,
  TicketProposalAuthorityDecisionReceiptV0,
  TicketProposalAuthorityProviderRequestV0,
  TicketProposalAuthorityRequiredPathV0,
  TicketProposalAuthorityTargetV0,
  TicketProposalReviewInputV0,
  TicketProposalReviewPacketV0,
  TicketProposalTrustedPrincipalV0,
  TrustedTicketProposalAuthorityProviderV0,
} from "./contract/ticket-application.js";
import {
  TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION,
  TICKET_PROPOSAL_AUTHORITY_MAX_VALIDATIONS,
} from "./contract/ticket-application.js";
import {
  ticketProposalApplicationIntentV0Schema,
  ticketProposalApplicationReceiptV0Schema,
  ticketProposalApplyInputV0Schema,
  ticketProposalAuthorityDecideInputV0Schema,
  ticketProposalAuthorityDecisionReceiptV0Schema,
  ticketProposalAuthorityProviderRequestV0Schema,
  ticketProposalAuthorityProviderResultV0Schema,
  ticketProposalReviewInputV0Schema,
  ticketProposalReviewPacketV0Schema,
} from "./contract/ticket-application-schemas.js";
import type {
  TicketGraphChangeProposalV0,
  TicketProposalAuthoritySignalV0,
  TicketProposalChangeClassV0,
  TicketProposalValidationReceiptV0,
  TicketProposalValidationSummaryV0,
  TicketProposalV0,
} from "./contract/ticket-proposal.js";
import type { Db } from "./db.js";
import {
  GitTicketFencedPublicationSessionV0,
  GitTicketGenerationPublisherV0,
  GitTicketStoreErrorV0,
  gitTicketDefinitionRevisionV0Schema,
  loadCurrentGitTicketAuthoringBaseV0,
  prepareGitTicketGenerationV0,
  serializeGitTicketStoreDocumentV0,
  type GitTicketDefinitionRevisionV0,
} from "./git-ticket-store.js";
import { KnowledgeError } from "./knowledge-service.js";
import {
  reconstructTicketProposalCandidateV0,
  ticketProposalCandidateDigestV0,
  ticketProposalDomainDigestV0,
  TicketProposalServiceV0,
  ticketProposalScopeRefV0,
  type TicketProposalRepositoryScopeV0,
  type TicketProposalSubmitContextV0,
} from "./ticket-proposal-service.js";

const CHANGE_CLASS_RANK: Record<TicketProposalChangeClassV0, number> = {
  elaboration: 0,
  decomposition: 1,
  expansion: 2,
};

interface ValidationSetV0 {
  digest: string;
  throughSequence: number;
  count: number;
  receipts: TicketProposalValidationReceiptV0[];
  summaries: TicketProposalValidationSummaryV0[];
}

interface StoredIntentV0 {
  intent: TicketProposalApplicationIntentV0;
  definitions: GitTicketDefinitionRevisionV0[];
}

export interface TicketProposalApplicationServiceOptionsV0 {
  authorityProvider?: TrustedTicketProposalAuthorityProviderV0;
  publisher?: GitTicketGenerationPublisherV0;
}

/**
 * Trusted proposal authority and crash-consistent graph application.
 *
 * Public request JSON only binds immutable facts. The sole authority mint is
 * the non-serializable provider injected by the trusted host. Application
 * persists an immutable intent before entering a fenced Git publication; the
 * fence is released only after the immutable application receipt commits.
 */
export class TicketProposalApplicationServiceV0 {
  private readonly proposals: TicketProposalServiceV0;
  private readonly publisher: GitTicketGenerationPublisherV0;

  constructor(
    private readonly db: Db,
    private readonly options: TicketProposalApplicationServiceOptionsV0 = {},
  ) {
    this.proposals = new TicketProposalServiceV0(db);
    this.publisher = options.publisher ?? new GitTicketGenerationPublisherV0();
  }

  review(
    scope: TicketProposalRepositoryScopeV0,
    context: TicketProposalSubmitContextV0,
    input: TicketProposalReviewInputV0,
  ): TicketProposalReviewPacketV0 {
    const parsed = parseInput(
      ticketProposalReviewInputV0Schema,
      input,
      "Ticket proposal review input",
    );
    const state = this.db.transaction(() => {
      const proposal = this.proposals.inspect(
        scope,
        context,
        { proposalId: parsed.proposalId },
      );
      const validations = this.loadValidationSet(scope, context, proposal);
      return {
        proposal,
        validations,
        decision: this.readDecision(scope, proposal.proposalId),
        application: this.readApplication(scope, proposal.proposalId),
      };
    }).deferred();

    const packet = this.buildReviewPacket(
      scope,
      state.proposal,
      state.validations,
      state.decision,
      state.application,
    );
    return parseStored(
      ticketProposalReviewPacketV0Schema,
      packet,
      "Core produced an invalid Ticket proposal review packet",
    );
  }

  decide(
    scope: TicketProposalRepositoryScopeV0,
    context: TicketProposalSubmitContextV0,
    input: TicketProposalAuthorityDecideInputV0,
  ): TicketProposalAuthorityDecisionReceiptV0 {
    const parsed = parseInput(
      ticketProposalAuthorityDecideInputV0Schema,
      input,
      "Ticket proposal authority input",
    );
    const initial = this.db.transaction(() => {
      const proposal = this.requireGraphProposal(
        this.proposals.inspect(
          scope,
          context,
          { proposalId: parsed.proposalId },
        ),
      );
      assertProposalInputBinding(proposal, parsed);
      const validationSet = this.loadValidationSet(scope, context, proposal);
      if (validationSet.digest !== parsed.expectedValidationSetDigest) {
        throw conflict(
          "the Ticket proposal validation set changed before authority resolution",
          {
            expectedValidationSetDigest: parsed.expectedValidationSetDigest,
            actualValidationSetDigest: validationSet.digest,
          },
        );
      }
      const existing = this.readDecision(scope, proposal.proposalId);
      if (existing !== null) {
        assertExistingDecisionBinding(existing, proposal, validationSet);
        return { proposal, validationSet, existing };
      }
      return { proposal, validationSet, existing: null };
    }).deferred();
    if (initial.existing !== null) return initial.existing;

    const authorityProvider = this.options.authorityProvider;
    if (authorityProvider === undefined) {
      throw new KnowledgeError(
        "trusted_authority_unavailable",
        "no trusted host authority provider is available",
        {
          proposalId: initial.proposal.proposalId,
          requiredPath: requiredAuthorityPath(
            initial.proposal,
            initial.validationSet.receipts,
          ),
        },
        [
          "Open this proposal in a trusted host decision surface, or configure a trusted delegated-policy provider.",
        ],
      );
    }
    const target = authorityTarget(initial.proposal);
    const providerRequest: TicketProposalAuthorityProviderRequestV0 = {
      schemaVersion: TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION,
      scopeRef: initial.proposal.scopeRef,
      target,
      proposal: initial.proposal,
      validationSet: {
        digest: initial.validationSet.digest,
        throughSequence: initial.validationSet.throughSequence,
        count: initial.validationSet.count,
        validations: initial.validationSet.receipts,
      },
      requiredPath: requiredAuthorityPath(
        initial.proposal,
        initial.validationSet.receipts,
      ),
    };
    const verifiedProviderRequest = parseStored(
      ticketProposalAuthorityProviderRequestV0Schema,
      providerRequest,
      "Core produced an invalid trusted authority request",
    );
    let rawProviderResult: unknown;
    try {
      rawProviderResult = authorityProvider.decide(verifiedProviderRequest);
    } catch (error) {
      throw new KnowledgeError(
        "authority_proof_invalid",
        "the trusted authority provider failed to resolve the proposal",
        { cause: error instanceof Error ? error.message : String(error) },
        ["Inspect the trusted host authority provider and retry."],
      );
    }
    const providerResult = parseAuthorityProviderResult(rawProviderResult);
    const resolvedAssessment = resolveAssessment(
      initial.proposal,
      initial.validationSet.receipts,
      providerResult.resolvedAssessment,
    );
    const requiredPath = requiredAuthorityPath(
      initial.proposal,
      initial.validationSet.receipts,
      resolvedAssessment,
    );
    assertAuthorityPath(
      requiredPath,
      providerResult.basis.kind,
      providerResult.principal,
    );
    const accepted = providerResult.acceptedValidations.slice()
      .sort((left, right) =>
        left.validationReceiptId.localeCompare(right.validationReceiptId));
    this.assertAcceptedValidations(
      initial.validationSet,
      accepted,
      providerResult.disposition,
    );

    const authorityDecisionId = `tgd-${ticketProposalDomainDigestV0(
      "vibehub.ticket-proposal-authority-decision-id.v1",
      {
        scopeRef: initial.proposal.scopeRef,
        proposalId: initial.proposal.proposalId,
      },
    )}`;
    const common = {
      schemaVersion: TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION,
      kind: "ticket_proposal_authority_decision" as const,
      authorityDecisionId,
      scopeRef: initial.proposal.scopeRef,
      target,
      validationSet: {
        digest: initial.validationSet.digest,
        throughSequence: initial.validationSet.throughSequence,
        count: initial.validationSet.count,
        accepted,
      },
      requiredPath,
      decidedAt: context.now,
      provider: providerResult.provider,
      principal: providerResult.principal,
      basis: providerResult.basis,
      resolvedAssessment,
      rationale: providerResult.rationale,
      effect: "authority_decision_only" as const,
      maturityEffect: "none" as const,
      graphMutationApplied: false as const,
    };
    const withoutDigest = providerResult.disposition === "authorized"
      ? {
          ...common,
          disposition: "authorized" as const,
          authorityGranted: true as const,
          applicationAuthorized: true as const,
        }
      : {
          ...common,
          disposition: "rejected" as const,
          authorityGranted: false as const,
          applicationAuthorized: false as const,
        };
    const receipt = parseStored(
      ticketProposalAuthorityDecisionReceiptV0Schema,
      {
        ...withoutDigest,
        authorityDecisionDigest: ticketProposalDomainDigestV0(
          "vibehub.ticket-proposal-authority-decision.v1",
          withoutDigest,
        ),
      },
      "Core produced an invalid Ticket proposal authority decision",
    );

    return this.db.transaction(() => {
      const proposal = this.requireGraphProposal(
        this.proposals.inspect(
          scope,
          context,
          { proposalId: parsed.proposalId },
        ),
      );
      assertProposalInputBinding(proposal, parsed);
      const validationSet = this.loadValidationSet(scope, context, proposal);
      if (validationSet.digest !== initial.validationSet.digest) {
        throw conflict(
          "the Ticket proposal validation set changed while trusted authority was resolving it",
          {
            expectedValidationSetDigest: initial.validationSet.digest,
            actualValidationSetDigest: validationSet.digest,
          },
        );
      }
      const existing = this.readDecision(scope, proposal.proposalId);
      if (existing !== null) {
        assertExistingDecisionBinding(existing, proposal, validationSet);
        return existing;
      }
      if (proposal.proposalDigest !== initial.proposal.proposalDigest
        || proposal.mechanicalReview.candidateDigest
          !== initial.proposal.mechanicalReview.candidateDigest) {
        throw conflict(
          "the immutable Ticket proposal binding changed while trusted authority was resolving it",
          { proposalId: proposal.proposalId },
        );
      }
      this.persistDecision(scope, context, receipt);
      return this.requireStoredDecision(scope, receipt);
    }).immediate();
  }

  apply(
    scope: TicketProposalRepositoryScopeV0,
    context: TicketProposalSubmitContextV0,
    input: TicketProposalApplyInputV0,
  ): TicketProposalApplicationReceiptV0 {
    const parsed = parseInput(
      ticketProposalApplyInputV0Schema,
      input,
      "Ticket proposal application input",
    );
    const initial = this.db.transaction(() => {
      const proposal = this.requireGraphProposal(
        this.proposals.inspect(
          scope,
          context,
          { proposalId: parsed.proposalId },
        ),
      );
      assertProposalInputBinding(proposal, parsed);
      const decision = this.requireAuthorizedDecision(
        scope,
        proposal,
        parsed,
      );
      const validationSet = this.loadValidationSet(scope, context, proposal);
      if (validationSet.digest !== decision.validationSet.digest) {
        throw conflict(
          "the authority decision no longer binds the complete validation set",
          {
            expectedValidationSetDigest: decision.validationSet.digest,
            actualValidationSetDigest: validationSet.digest,
          },
        );
      }
      const application = this.readApplication(scope, proposal.proposalId);
      if (application !== null) {
        assertApplicationBinding(application, proposal, decision);
      }
      return { proposal, decision, application };
    }).deferred();
    if (initial.application !== null) {
      this.releaseCompletedApplicationFence(scope, initial.application);
      return initial.application;
    }

    const storedIntent = this.db.transaction(() => {
      const racedApplication = this.readApplication(
        scope,
        initial.proposal.proposalId,
      );
      if (racedApplication !== null) {
        assertApplicationBinding(
          racedApplication,
          initial.proposal,
          initial.decision,
        );
        return null;
      }
      this.releaseLatestCompletedApplicationFence(scope);
      const existing = this.readIntent(scope, initial.proposal.proposalId);
      if (existing !== null) {
        assertIntentBinding(existing.intent, initial.proposal, initial.decision);
        return existing;
      }
      this.assertNoUnresolvedApplication(scope);
      const base = loadCurrentGitTicketAuthoringBaseV0(
        scope,
        initial.proposal.observedSnapshotId,
      );
      const definitions = reconstructTicketProposalCandidateV0(
        base.definitions,
        initial.proposal,
      );
      const applicationIntentId = `tai-${ticketProposalDomainDigestV0(
        "vibehub.ticket-proposal-application-intent-id.v1",
        {
          scopeRef: initial.proposal.scopeRef,
          proposalId: initial.proposal.proposalId,
          authorityDecisionId: initial.decision.authorityDecisionId,
        },
      )}`;
      const storeId = base.storeId
        ?? `ticket-store-${ticketProposalDomainDigestV0(
          "vibehub.ticket-proposal-bootstrap-store-id.v1",
          { applicationIntentId },
        ).slice(0, 32)}`;
      const prepared = prepareGitTicketGenerationV0(storeId, definitions);
      const common = {
        schemaVersion: TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION,
        kind: "ticket_proposal_application_intent" as const,
        applicationIntentId,
        scopeRef: initial.proposal.scopeRef,
        preparedAt: context.now,
        target: authorityTarget(initial.proposal),
        authorityDecision: {
          authorityDecisionId: initial.decision.authorityDecisionId,
          authorityDecisionDigest:
            initial.decision.authorityDecisionDigest,
        },
        publication: {
          baseSnapshotId: initial.proposal.observedSnapshotId,
          storeId,
          candidateSnapshotId: prepared.generation.snapshotId,
          candidateDigest:
            initial.proposal.mechanicalReview.candidateDigest,
          ticketCount: prepared.definitions.length,
          directUnlockCount: prepared.relationCount,
        },
        effect: "pending_canonical_graph_publication" as const,
        maturityEffect: "none" as const,
        graphMutationApplied: false as const,
      };
      const intent = parseStored(
        ticketProposalApplicationIntentV0Schema,
        {
          ...common,
          applicationIntentDigest: ticketProposalDomainDigestV0(
            "vibehub.ticket-proposal-application-intent.v1",
            common,
          ),
        },
        "Core produced an invalid Ticket proposal application intent",
      );
      this.persistIntent(scope, context, intent, prepared.definitions);
      return this.requireStoredIntent(scope, intent);
    }).immediate();
    if (storedIntent === null) {
      const raced = this.readApplication(scope, initial.proposal.proposalId);
      if (raced === null) {
        throw corrupt(
          "application completed concurrently without a readable receipt",
          { proposalId: initial.proposal.proposalId },
        );
      }
      this.releaseCompletedApplicationFence(scope, raced);
      return raced;
    }

    let session: GitTicketFencedPublicationSessionV0 | undefined;
    const receipt = this.db.transaction(() => {
      const raced = this.readApplication(scope, initial.proposal.proposalId);
      if (raced !== null) {
        assertApplicationBinding(raced, initial.proposal, initial.decision);
        return raced;
      }
      const exactIntent = this.requireStoredIntent(scope, storedIntent.intent);
      session = this.publisher.publishFenced(scope, {
        expectedSnapshotId:
          exactIntent.intent.publication.baseSnapshotId,
        definitions: exactIntent.definitions,
        bootstrapStoreId: exactIntent.intent.publication.storeId,
        fence: {
          applicationIntentId:
            exactIntent.intent.applicationIntentId,
          intentDigest:
            exactIntent.intent.applicationIntentDigest,
          candidateSnapshotId:
            exactIntent.intent.publication.candidateSnapshotId,
        },
      });
      const result = session.result;
      const common = {
        schemaVersion: TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION,
        kind: "ticket_proposal_application_receipt" as const,
        applicationReceiptId: `tar-${ticketProposalDomainDigestV0(
          "vibehub.ticket-proposal-application-receipt-id.v1",
          {
            applicationIntentId:
              exactIntent.intent.applicationIntentId,
          },
        )}`,
        applicationIntentId: exactIntent.intent.applicationIntentId,
        applicationIntentDigest:
          exactIntent.intent.applicationIntentDigest,
        scopeRef: initial.proposal.scopeRef,
        recordedAt: context.now,
        target: authorityTarget(initial.proposal),
        authorityDecision: {
          authorityDecisionId: initial.decision.authorityDecisionId,
          authorityDecisionDigest:
            initial.decision.authorityDecisionDigest,
        },
        publication: {
          status: result.status,
          previousSnapshotId: result.previousSnapshotId,
          snapshotId: result.snapshotId,
          ticketCount: result.ticketCount,
          directUnlockCount: result.directUnlockCount,
        },
        effect: "ticket_graph_publication" as const,
        maturityEffect: "none" as const,
        graphMutationApplied: true as const,
      };
      const application = parseStored(
        ticketProposalApplicationReceiptV0Schema,
        {
          ...common,
          applicationReceiptDigest: ticketProposalDomainDigestV0(
            "vibehub.ticket-proposal-application-receipt.v1",
            common,
          ),
        },
        "Core produced an invalid Ticket proposal application receipt",
      );
      this.persistApplication(scope, context, application);
      return this.requireStoredApplication(scope, application);
    }).immediate();
    if (session === undefined) {
      this.releaseCompletedApplicationFence(scope, receipt);
    } else if (!session.release()) {
      throw applicationRecoveryRequired(
        "the Ticket graph was applied but its exact writer fence could not be released",
        {
          proposalId: initial.proposal.proposalId,
          applicationReceiptId: receipt.applicationReceiptId,
        },
      );
    }
    return receipt;
  }

  private buildReviewPacket(
    scope: TicketProposalRepositoryScopeV0,
    proposal: TicketProposalV0,
    validationSet: ValidationSetV0,
    decision: TicketProposalAuthorityDecisionReceiptV0 | null,
    application: TicketProposalApplicationReceiptV0 | null,
  ): TicketProposalReviewPacketV0 {
    const base = {
      schemaVersion: TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION,
      scopeRef: proposal.scopeRef,
      proposal,
      validations: validationSet.summaries,
      validationSet: {
        digest: validationSet.digest,
        throughSequence: validationSet.throughSequence,
        count: validationSet.count,
      },
      decision,
      application,
    };
    if (proposal.kind === "comment") {
      return {
        ...base,
        eligibility: {
          status: "comment_only",
          reasons: ["Comments contribute review context and never mutate the Ticket Graph."],
        },
        nextAction: "none",
      };
    }
    if (application !== null) {
      return {
        ...base,
        eligibility: {
          status: "applied",
          reasons: ["The exact authorized proposal has an immutable application receipt."],
        },
        nextAction: "inspect_application",
      };
    }
    if (decision?.disposition === "rejected") {
      return {
        ...base,
        eligibility: {
          status: "rejected",
          reasons: ["The trusted authority decision rejected this exact proposal."],
        },
        nextAction: "none",
      };
    }
    if (isProposalStale(scope, proposal)) {
      return {
        ...base,
        eligibility: {
          status: "stale",
          reasons: ["The proposal's observed Ticket Graph is no longer current."],
        },
        nextAction: "none",
      };
    }
    if (decision?.disposition === "authorized") {
      return {
        ...base,
        eligibility: {
          status: "application_ready",
          reasons: ["Trusted authority authorized the exact proposal and validation set."],
        },
        nextAction: "apply_proposal",
      };
    }
    const hasPassingValidation = validationSet.receipts.some(
      (validation) =>
        validation.conclusion === "passed"
        && validation.findings.every(
          (finding) => finding.impact !== "blocking",
        ),
    );
    return hasPassingValidation
      ? {
          ...base,
          eligibility: {
            status: "authority_required",
            reasons: [
              requiredAuthorityPath(proposal, validationSet.receipts)
                === "human_authority"
                ? "A protected boundary requires a trusted human authority decision."
                : "A trusted delegated-policy decision must bind the exact validation set.",
            ],
          },
          nextAction: "request_authority_decision",
        }
      : {
          ...base,
          eligibility: {
            status: "validation_required",
            reasons: ["No complete passing proposal validation is available."],
          },
          nextAction: "record_validation",
        };
  }

  private loadValidationSet(
    scope: TicketProposalRepositoryScopeV0,
    context: TicketProposalSubmitContextV0,
    proposal: TicketProposalV0,
  ): ValidationSetV0 {
    const rows = this.db.prepare(
      `SELECT sequence,validation_receipt_id validationReceiptId,
              validation_receipt_digest validationReceiptDigest
       FROM ticket_proposal_validation_receipts
       WHERE repo_id=? AND scope_ref=? AND proposal_id=?
       ORDER BY sequence`,
    ).all(
      scope.repoId,
      proposal.scopeRef,
      proposal.proposalId,
    ) as Array<{
      sequence: number;
      validationReceiptId: string;
      validationReceiptDigest: string;
    }>;
    if (rows.length > TICKET_PROPOSAL_AUTHORITY_MAX_VALIDATIONS) {
      throw new KnowledgeError(
        "projection_too_large",
        "the proposal has too many validation receipts for one authority decision",
        {
          proposalId: proposal.proposalId,
          count: rows.length,
          maximum: TICKET_PROPOSAL_AUTHORITY_MAX_VALIDATIONS,
        },
        ["Submit a replacement proposal after consolidating the review evidence."],
      );
    }
    const receipts = rows.map((row) => {
      const receipt = this.proposals.inspectValidation(
        scope,
        context,
        { validationReceiptId: row.validationReceiptId },
      );
      if (receipt.validationReceiptDigest !== row.validationReceiptDigest) {
        throw corrupt(
          "a validation ledger row changed during authority resolution",
          { validationReceiptId: row.validationReceiptId },
        );
      }
      return receipt;
    });
    const throughSequence = rows.at(-1)?.sequence ?? 0;
    const digest = ticketProposalDomainDigestV0(
      "vibehub.ticket-proposal-validation-set.v1",
      {
        scopeRef: proposal.scopeRef,
        proposalId: proposal.proposalId,
        throughSequence,
        receipts: rows.map((row) => ({
          sequence: row.sequence,
          validationReceiptId: row.validationReceiptId,
          validationReceiptDigest: row.validationReceiptDigest,
        })),
      },
    );
    return {
      digest,
      throughSequence,
      count: receipts.length,
      receipts,
      summaries: receipts.map(validationSummary),
    };
  }

  private assertAcceptedValidations(
    set: ValidationSetV0,
    accepted: Array<{
      validationReceiptId: string;
      validationReceiptDigest: string;
    }>,
    disposition: "authorized" | "rejected",
  ): void {
    const byId = new Map(set.receipts.map((receipt) => [
      receipt.validationReceiptId,
      receipt,
    ]));
    for (const ref of accepted) {
      const receipt = byId.get(ref.validationReceiptId);
      if (receipt === undefined
        || receipt.validationReceiptDigest
          !== ref.validationReceiptDigest) {
        throw new KnowledgeError(
          "authority_proof_invalid",
          "the authority provider accepted validation evidence outside the bound set",
          { validationReceiptId: ref.validationReceiptId },
          ["Refresh the review packet and retry with the exact validation set."],
        );
      }
      if (receipt.conclusion !== "passed"
        || receipt.findings.some(
          (finding) => finding.impact === "blocking",
        )) {
        throw new KnowledgeError(
          "authority_proof_invalid",
          "an accepted validation receipt is not a complete passing review",
          { validationReceiptId: ref.validationReceiptId },
          ["Resolve blocking validation findings before requesting authorization."],
        );
      }
    }
    if (disposition === "authorized" && accepted.length === 0) {
      throw new KnowledgeError(
        "authority_proof_invalid",
        "authorization requires an exact accepted passing validation",
        null,
        ["Record independent semantic validation before authorization."],
      );
    }
  }

  private requireGraphProposal(
    proposal: TicketProposalV0,
  ): TicketGraphChangeProposalV0 {
    if (proposal.kind === "graph_change") return proposal;
    throw new KnowledgeError(
      "invalid_state_transition",
      "comment proposals cannot receive graph-application authority",
      { proposalId: proposal.proposalId },
      ["Use the comment as review context or submit a graph-change proposal."],
    );
  }

  private readDecision(
    scope: TicketProposalRepositoryScopeV0,
    proposalId: string,
  ): TicketProposalAuthorityDecisionReceiptV0 | null {
    const row = this.db.prepare(
      `SELECT payload FROM ticket_proposal_authority_decisions
       WHERE repo_id=? AND scope_ref=? AND proposal_id=?`,
    ).get(scope.repoId, ticketProposalScopeRefV0(scope), proposalId) as
      | { payload: string }
      | undefined;
    if (row === undefined) return null;
    const receipt = parseStoredDocument(
      ticketProposalAuthorityDecisionReceiptV0Schema,
      row.payload,
      "Ticket proposal authority decision ledger is corrupt",
    );
    const {
      authorityDecisionDigest: _authorityDecisionDigest,
      ...content
    } = receipt;
    if (receipt.authorityDecisionDigest !== ticketProposalDomainDigestV0(
      "vibehub.ticket-proposal-authority-decision.v1",
      content,
    )) {
      throw corrupt(
        "Ticket proposal authority decision digest is inconsistent",
        { authorityDecisionId: receipt.authorityDecisionId },
      );
    }
    return receipt;
  }

  private requireAuthorizedDecision(
    scope: TicketProposalRepositoryScopeV0,
    proposal: TicketGraphChangeProposalV0,
    input: TicketProposalApplyInputV0,
  ): Extract<TicketProposalAuthorityDecisionReceiptV0, {
    disposition: "authorized";
  }> {
    const decision = this.readDecision(scope, proposal.proposalId);
    if (decision === null) {
      throw new KnowledgeError(
        "authority_required",
        "the proposal has no trusted authority decision",
        { proposalId: proposal.proposalId },
        ["Resolve authority through the trusted host before applying."],
      );
    }
    if (decision.authorityDecisionId !== input.authorityDecisionId
      || decision.authorityDecisionDigest
        !== input.expectedAuthorityDecisionDigest
      || decision.target.proposalDigest !== proposal.proposalDigest
      || decision.target.candidateDigest
        !== proposal.mechanicalReview.candidateDigest) {
      throw conflict(
        "the application input does not bind the proposal's exact authority decision",
        {
          proposalId: proposal.proposalId,
          authorityDecisionId: decision.authorityDecisionId,
        },
      );
    }
    if (decision.disposition !== "authorized") {
      throw new KnowledgeError(
        "authority_required",
        "the trusted authority decision did not authorize application",
        {
          proposalId: proposal.proposalId,
          disposition: decision.disposition,
        },
        ["Submit a replacement proposal that resolves the authority decision."],
      );
    }
    return decision;
  }

  private persistDecision(
    scope: TicketProposalRepositoryScopeV0,
    context: TicketProposalSubmitContextV0,
    receipt: TicketProposalAuthorityDecisionReceiptV0,
  ): void {
    const payload = serializeGitTicketStoreDocumentV0(receipt);
    const acceptedValidations = serializeGitTicketStoreDocumentV0(
      receipt.validationSet.accepted,
    ).trim();
    const resolvedAuthoritySignals = serializeGitTicketStoreDocumentV0(
      receipt.resolvedAssessment.authoritySignals,
    ).trim();
    this.db.prepare(
      `INSERT INTO ticket_proposal_authority_decisions(
         repo_id,scope_ref,authority_decision_id,authority_decision_digest,
         proposal_id,proposal_digest,observed_snapshot_id,candidate_digest,
         validation_set_digest,validation_through_sequence,
         validation_set_count,accepted_validations,
         required_path,disposition,
         provider_kind,provider_id,provider_version,
         provider_artifact_digest,provider_trust,
         principal_kind,principal_ref,
         principal_authentication_context_digest,principal_trust,
         basis_kind,basis_ref,basis_digest,resolved_change_class,
         resolved_authority_signals,authority_signal_count,rationale,
         request_id,decided_at,payload,byte_length
       ) VALUES(
         ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
       )`,
    ).run(
      scope.repoId,
      receipt.scopeRef,
      receipt.authorityDecisionId,
      receipt.authorityDecisionDigest,
      receipt.target.proposalId,
      receipt.target.proposalDigest,
      receipt.target.observedSnapshotId,
      receipt.target.candidateDigest,
      receipt.validationSet.digest,
      receipt.validationSet.throughSequence,
      receipt.validationSet.count,
      acceptedValidations,
      receipt.requiredPath,
      receipt.disposition,
      receipt.provider.kind,
      receipt.provider.id,
      receipt.provider.version,
      receipt.provider.artifactDigest,
      receipt.provider.trust,
      receipt.principal.kind,
      receipt.principal.ref,
      receipt.principal.authenticationContextDigest,
      receipt.principal.trust,
      receipt.basis.kind,
      receipt.basis.ref,
      receipt.basis.digest,
      receipt.resolvedAssessment.changeClass,
      resolvedAuthoritySignals,
      receipt.resolvedAssessment.authoritySignals.length,
      receipt.rationale,
      context.requestId,
      receipt.decidedAt,
      payload,
      Buffer.byteLength(payload, "utf8"),
    );
  }

  private requireStoredDecision(
    scope: TicketProposalRepositoryScopeV0,
    expected: TicketProposalAuthorityDecisionReceiptV0,
  ): TicketProposalAuthorityDecisionReceiptV0 {
    const stored = this.readDecision(scope, expected.target.proposalId);
    if (stored === null
      || stored.authorityDecisionId !== expected.authorityDecisionId
      || serializeGitTicketStoreDocumentV0(stored)
        !== serializeGitTicketStoreDocumentV0(expected)) {
      throw corrupt(
        "the immutable authority decision could not be verified after recording",
        { authorityDecisionId: expected.authorityDecisionId },
      );
    }
    return stored;
  }

  private readIntent(
    scope: TicketProposalRepositoryScopeV0,
    proposalId: string,
  ): StoredIntentV0 | null {
    const row = this.db.prepare(
      `SELECT payload,candidate_definitions candidateDefinitions
       FROM ticket_proposal_application_intents
       WHERE repo_id=? AND scope_ref=? AND proposal_id=?`,
    ).get(scope.repoId, ticketProposalScopeRefV0(scope), proposalId) as
      | { payload: string; candidateDefinitions: string }
      | undefined;
    if (row === undefined) return null;
    const intent = parseStoredDocument(
      ticketProposalApplicationIntentV0Schema,
      row.payload,
      "Ticket proposal application intent ledger is corrupt",
    );
    const {
      applicationIntentDigest: _applicationIntentDigest,
      ...intentContent
    } = intent;
    if (intent.applicationIntentDigest !== ticketProposalDomainDigestV0(
      "vibehub.ticket-proposal-application-intent.v1",
      intentContent,
    )) {
      throw corrupt(
        "Ticket proposal application intent digest is inconsistent",
        { applicationIntentId: intent.applicationIntentId },
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.candidateDefinitions);
    } catch {
      throw corrupt(
        "Ticket proposal application intent candidate is not valid JSON",
        { applicationIntentId: intent.applicationIntentId },
      );
    }
    const definitions = gitTicketDefinitionRevisionV0Schema.array()
      .safeParse(decoded);
    if (!definitions.success) {
      throw corrupt(
        "Ticket proposal application intent candidate violates its schema",
        {
          applicationIntentId: intent.applicationIntentId,
          issues: definitions.error.issues,
        },
      );
    }
    const prepared = prepareGitTicketGenerationV0(
      intent.publication.storeId,
      definitions.data,
    );
    if (ticketProposalCandidateDigestV0(prepared.definitions)
        !== intent.publication.candidateDigest
      || prepared.generation.snapshotId
        !== intent.publication.candidateSnapshotId
      || prepared.definitions.length !== intent.publication.ticketCount
      || prepared.relationCount !== intent.publication.directUnlockCount) {
      throw corrupt(
        "Ticket proposal application intent candidate does not match its publication binding",
        { applicationIntentId: intent.applicationIntentId },
      );
    }
    return { intent, definitions: prepared.definitions };
  }

  private persistIntent(
    scope: TicketProposalRepositoryScopeV0,
    context: TicketProposalSubmitContextV0,
    intent: TicketProposalApplicationIntentV0,
    definitions: GitTicketDefinitionRevisionV0[],
  ): void {
    const payload = serializeGitTicketStoreDocumentV0(intent);
    const candidate = serializeGitTicketStoreDocumentV0(definitions);
    this.db.prepare(
      `INSERT INTO ticket_proposal_application_intents(
         repo_id,scope_ref,application_intent_id,application_intent_digest,
         proposal_id,proposal_digest,observed_snapshot_id,candidate_digest,
         authority_decision_id,authority_decision_digest,
         repository_incarnation,request_id,prepared_at,
         base_snapshot_id,store_id,candidate_snapshot_id,
         ticket_count,direct_unlock_count,
         payload,byte_length,candidate_definitions,candidate_byte_length
       ) VALUES(
         ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
       )`,
    ).run(
      scope.repoId,
      intent.scopeRef,
      intent.applicationIntentId,
      intent.applicationIntentDigest,
      intent.target.proposalId,
      intent.target.proposalDigest,
      intent.target.observedSnapshotId,
      intent.target.candidateDigest,
      intent.authorityDecision.authorityDecisionId,
      intent.authorityDecision.authorityDecisionDigest,
      scope.repositoryIncarnation,
      context.requestId,
      intent.preparedAt,
      intent.publication.baseSnapshotId,
      intent.publication.storeId,
      intent.publication.candidateSnapshotId,
      intent.publication.ticketCount,
      intent.publication.directUnlockCount,
      payload,
      Buffer.byteLength(payload, "utf8"),
      candidate,
      Buffer.byteLength(candidate, "utf8"),
    );
  }

  private requireStoredIntent(
    scope: TicketProposalRepositoryScopeV0,
    expected: TicketProposalApplicationIntentV0,
  ): StoredIntentV0 {
    const stored = this.readIntent(scope, expected.target.proposalId);
    if (stored === null
      || stored.intent.applicationIntentId !== expected.applicationIntentId
      || serializeGitTicketStoreDocumentV0(stored.intent)
        !== serializeGitTicketStoreDocumentV0(expected)) {
      throw corrupt(
        "the immutable application intent could not be verified after recording",
        { applicationIntentId: expected.applicationIntentId },
      );
    }
    return stored;
  }

  private assertNoUnresolvedApplication(
    scope: TicketProposalRepositoryScopeV0,
  ): void {
    const row = this.db.prepare(
      `SELECT i.application_intent_id applicationIntentId,
              i.proposal_id proposalId
       FROM ticket_proposal_application_intents i
       LEFT JOIN ticket_proposal_application_receipts r
         ON r.repo_id=i.repo_id
        AND r.application_intent_id=i.application_intent_id
       WHERE i.repo_id=? AND i.scope_ref=?
         AND r.application_receipt_id IS NULL
       LIMIT 1`,
    ).get(scope.repoId, ticketProposalScopeRefV0(scope)) as
      | { applicationIntentId: string; proposalId: string }
      | undefined;
    if (row === undefined) return;
    throw new KnowledgeError(
      "application_in_progress",
      "another Ticket proposal application intent must resolve first",
      row,
      ["Retry the exact unresolved proposal application so Core can reconcile it."],
    );
  }

  private readApplication(
    scope: TicketProposalRepositoryScopeV0,
    proposalId: string,
  ): TicketProposalApplicationReceiptV0 | null {
    const row = this.db.prepare(
      `SELECT payload FROM ticket_proposal_application_receipts
       WHERE repo_id=? AND scope_ref=? AND proposal_id=?`,
    ).get(scope.repoId, ticketProposalScopeRefV0(scope), proposalId) as
      | { payload: string }
      | undefined;
    if (row === undefined) return null;
    const receipt = parseStoredDocument(
      ticketProposalApplicationReceiptV0Schema,
      row.payload,
      "Ticket proposal application receipt ledger is corrupt",
    );
    const {
      applicationReceiptDigest: _applicationReceiptDigest,
      ...content
    } = receipt;
    if (receipt.applicationReceiptDigest !== ticketProposalDomainDigestV0(
      "vibehub.ticket-proposal-application-receipt.v1",
      content,
    )) {
      throw corrupt(
        "Ticket proposal application receipt digest is inconsistent",
        { applicationReceiptId: receipt.applicationReceiptId },
      );
    }
    return receipt;
  }

  private persistApplication(
    scope: TicketProposalRepositoryScopeV0,
    context: TicketProposalSubmitContextV0,
    receipt: TicketProposalApplicationReceiptV0,
  ): void {
    const payload = serializeGitTicketStoreDocumentV0(receipt);
    this.db.prepare(
      `INSERT INTO ticket_proposal_application_receipts(
         repo_id,scope_ref,application_receipt_id,application_receipt_digest,
         application_intent_id,application_intent_digest,
         proposal_id,proposal_digest,observed_snapshot_id,candidate_digest,
         authority_decision_id,authority_decision_digest,recorded_at,
         publication_status,previous_snapshot_id,snapshot_id,
         ticket_count,direct_unlock_count,request_id,payload,byte_length
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      scope.repoId,
      receipt.scopeRef,
      receipt.applicationReceiptId,
      receipt.applicationReceiptDigest,
      receipt.applicationIntentId,
      receipt.applicationIntentDigest,
      receipt.target.proposalId,
      receipt.target.proposalDigest,
      receipt.target.observedSnapshotId,
      receipt.target.candidateDigest,
      receipt.authorityDecision.authorityDecisionId,
      receipt.authorityDecision.authorityDecisionDigest,
      receipt.recordedAt,
      receipt.publication.status,
      receipt.publication.previousSnapshotId,
      receipt.publication.snapshotId,
      receipt.publication.ticketCount,
      receipt.publication.directUnlockCount,
      context.requestId,
      payload,
      Buffer.byteLength(payload, "utf8"),
    );
  }

  private requireStoredApplication(
    scope: TicketProposalRepositoryScopeV0,
    expected: TicketProposalApplicationReceiptV0,
  ): TicketProposalApplicationReceiptV0 {
    const stored = this.readApplication(scope, expected.target.proposalId);
    if (stored === null
      || stored.applicationReceiptId !== expected.applicationReceiptId
      || serializeGitTicketStoreDocumentV0(stored)
        !== serializeGitTicketStoreDocumentV0(expected)) {
      throw corrupt(
        "the immutable application receipt could not be verified after recording",
        { applicationReceiptId: expected.applicationReceiptId },
      );
    }
    return stored;
  }

  private releaseCompletedApplicationFence(
    scope: TicketProposalRepositoryScopeV0,
    receipt: TicketProposalApplicationReceiptV0,
  ): void {
    const stored = this.readIntent(scope, receipt.target.proposalId);
    if (stored === null
      || stored.intent.applicationIntentId !== receipt.applicationIntentId
      || stored.intent.applicationIntentDigest
        !== receipt.applicationIntentDigest
      || stored.intent.publication.candidateSnapshotId
        !== receipt.publication.snapshotId) {
      throw corrupt(
        "the completed Ticket application does not bind a readable exact intent",
        { applicationReceiptId: receipt.applicationReceiptId },
      );
    }
    const released = this.publisher.releaseCompletedFence(scope, {
      applicationIntentId: stored.intent.applicationIntentId,
      intentDigest: stored.intent.applicationIntentDigest,
      candidateSnapshotId:
        stored.intent.publication.candidateSnapshotId,
    });
    if (!released) {
      throw applicationRecoveryRequired(
        "the completed Ticket application has an invalid or unreleasable writer fence",
        {
          proposalId: receipt.target.proposalId,
          applicationReceiptId: receipt.applicationReceiptId,
        },
      );
    }
  }

  private releaseLatestCompletedApplicationFence(
    scope: TicketProposalRepositoryScopeV0,
  ): void {
    const row = this.db.prepare(
      `SELECT proposal_id proposalId
       FROM ticket_proposal_application_receipts
       WHERE repo_id=? AND scope_ref=?
       ORDER BY sequence DESC
       LIMIT 1`,
    ).get(scope.repoId, ticketProposalScopeRefV0(scope)) as
      | { proposalId: string }
      | undefined;
    if (row === undefined) return;
    const receipt = this.readApplication(scope, row.proposalId);
    if (receipt === null) {
      throw corrupt(
        "the latest completed Ticket application receipt disappeared",
        { proposalId: row.proposalId },
      );
    }
    this.releaseCompletedApplicationFence(scope, receipt);
  }
}

function authorityTarget(
  proposal: TicketGraphChangeProposalV0,
): TicketProposalAuthorityTargetV0 {
  return {
    kind: "ticket_graph_change_proposal",
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    observedSnapshotId: proposal.observedSnapshotId,
    candidateDigest: proposal.mechanicalReview.candidateDigest,
  };
}

function validationSummary(
  receipt: TicketProposalValidationReceiptV0,
): TicketProposalValidationSummaryV0 {
  const blockingFindingCount = receipt.findings.filter(
    (finding) => finding.impact === "blocking",
  ).length;
  return {
    validationReceiptId: receipt.validationReceiptId,
    validationReceiptDigest: receipt.validationReceiptDigest,
    proposalId: receipt.target.proposalId,
    proposalDigest: receipt.target.proposalDigest,
    candidateDigest: receipt.target.candidateDigest,
    recordedAt: receipt.recordedAt,
    validator: {
      kind: receipt.producer.kind,
      id: receipt.producer.id,
      version: receipt.producer.version,
      artifactDigest: receipt.producer.artifactDigest,
      trust: receipt.producer.trust,
    },
    policy: receipt.policy,
    conclusion: receipt.conclusion,
    checkCount: receipt.checks.length,
    findingCount: receipt.findings.length,
    blockingFindingCount,
    advisoryFindingCount: receipt.findings.length - blockingFindingCount,
    authoritySignalCount: receipt.indicatedAuthoritySignals.length,
    effect: "validation_evidence_only",
    maturityEffect: "none",
    authorityGranted: false,
    applicationAuthorized: false,
    graphMutationApplied: false,
  };
}

function requiredAuthorityPath(
  proposal: TicketGraphChangeProposalV0,
  validations: readonly TicketProposalValidationReceiptV0[],
  resolved?: {
    changeClass: TicketProposalChangeClassV0;
    authoritySignals: TicketProposalAuthoritySignalV0[];
  },
): TicketProposalAuthorityRequiredPathV0 {
  const signals = new Set<TicketProposalAuthoritySignalV0>([
    ...proposal.reviewRequirement.indicatedAuthoritySignals,
    ...validations.flatMap(
      (validation) => validation.indicatedAuthoritySignals,
    ),
    ...(resolved?.authoritySignals ?? []),
  ]);
  const changeClass = resolved?.changeClass
    ?? proposal.authorAssessment.changeClass;
  return proposal.observedSnapshotId === null
    || proposal.authorAssessment.introducesHumanGate
    || changeClass === "expansion"
    || signals.size > 0
    ? "human_authority"
    : "delegated_policy";
}

function resolveAssessment(
  proposal: TicketGraphChangeProposalV0,
  validations: readonly TicketProposalValidationReceiptV0[],
  provider: {
    changeClass: TicketProposalChangeClassV0;
    authoritySignals: TicketProposalAuthoritySignalV0[];
  },
): {
  changeClass: TicketProposalChangeClassV0;
  authoritySignals: TicketProposalAuthoritySignalV0[];
} {
  const proposalClass = proposal.authorAssessment.changeClass;
  const changeClass = CHANGE_CLASS_RANK[provider.changeClass]
      >= CHANGE_CLASS_RANK[proposalClass]
    ? provider.changeClass
    : proposalClass;
  const authoritySignals = [...new Set<TicketProposalAuthoritySignalV0>([
    ...proposal.reviewRequirement.indicatedAuthoritySignals,
    ...validations.flatMap(
      (validation) => validation.indicatedAuthoritySignals,
    ),
    ...provider.authoritySignals,
  ])].sort();
  return { changeClass, authoritySignals };
}

function assertAuthorityPath(
  path: TicketProposalAuthorityRequiredPathV0,
  basisKind: "delegation" | "human_authority",
  principal: TicketProposalTrustedPrincipalV0,
): void {
  if (path === "delegated_policy" && basisKind === "delegation") return;
  if (path === "human_authority"
    && basisKind === "human_authority"
    && principal.kind === "human") {
    return;
  }
  throw new KnowledgeError(
    "authority_proof_invalid",
    "the trusted authority result does not satisfy the Core-derived authority path",
    { requiredPath: path, basisKind, principalKind: principal.kind },
    ["Resolve this proposal through the required trusted authority path."],
  );
}

function assertProposalInputBinding(
  proposal: TicketGraphChangeProposalV0,
  input: {
    proposalId: string;
    expectedProposalDigest: string;
    expectedCandidateDigest: string;
  },
): void {
  if (proposal.proposalId === input.proposalId
    && proposal.proposalDigest === input.expectedProposalDigest
    && proposal.mechanicalReview.candidateDigest
      === input.expectedCandidateDigest) {
    return;
  }
  throw conflict(
    "the request does not bind the exact Ticket graph-change proposal",
    {
      proposalId: proposal.proposalId,
      proposalDigest: proposal.proposalDigest,
      candidateDigest: proposal.mechanicalReview.candidateDigest,
    },
  );
}

function assertExistingDecisionBinding(
  decision: TicketProposalAuthorityDecisionReceiptV0,
  proposal: TicketGraphChangeProposalV0,
  validationSet: ValidationSetV0,
): void {
  if (decision.target.proposalId === proposal.proposalId
    && decision.target.proposalDigest === proposal.proposalDigest
    && decision.target.candidateDigest
      === proposal.mechanicalReview.candidateDigest
    && decision.validationSet.digest === validationSet.digest) {
    return;
  }
  throw new KnowledgeError(
    "authority_conflict",
    "an existing authority decision binds different immutable evidence",
    { proposalId: proposal.proposalId },
    ["Submit a replacement proposal instead of rewriting a terminal decision."],
  );
}

function assertIntentBinding(
  intent: TicketProposalApplicationIntentV0,
  proposal: TicketGraphChangeProposalV0,
  decision: TicketProposalAuthorityDecisionReceiptV0,
): void {
  if (intent.target.proposalId === proposal.proposalId
    && intent.target.proposalDigest === proposal.proposalDigest
    && intent.target.candidateDigest
      === proposal.mechanicalReview.candidateDigest
    && intent.authorityDecision.authorityDecisionId
      === decision.authorityDecisionId
    && intent.authorityDecision.authorityDecisionDigest
      === decision.authorityDecisionDigest) {
    return;
  }
  throw new KnowledgeError(
    "authority_conflict",
    "an existing application intent binds different proposal authority",
    { proposalId: proposal.proposalId },
    ["Reconcile the exact existing application intent."],
  );
}

function assertApplicationBinding(
  receipt: TicketProposalApplicationReceiptV0,
  proposal: TicketGraphChangeProposalV0,
  decision: TicketProposalAuthorityDecisionReceiptV0,
): void {
  if (receipt.target.proposalId === proposal.proposalId
    && receipt.target.proposalDigest === proposal.proposalDigest
    && receipt.target.candidateDigest
      === proposal.mechanicalReview.candidateDigest
    && receipt.authorityDecision.authorityDecisionId
      === decision.authorityDecisionId
    && receipt.authorityDecision.authorityDecisionDigest
      === decision.authorityDecisionDigest) {
    return;
  }
  throw new KnowledgeError(
    "authority_conflict",
    "an existing application receipt binds different proposal authority",
    { proposalId: proposal.proposalId },
    ["Inspect the immutable application history."],
  );
}

function isProposalStale(
  scope: TicketProposalRepositoryScopeV0,
  proposal: TicketGraphChangeProposalV0,
): boolean {
  try {
    loadCurrentGitTicketAuthoringBaseV0(
      scope,
      proposal.observedSnapshotId,
    );
    return false;
  } catch (error) {
    if (error instanceof GitTicketStoreErrorV0
      && error.code === "ticket_store_cas_conflict") {
      return true;
    }
    throw error;
  }
}

function parseAuthorityProviderResult(
  value: unknown,
): ReturnType<typeof ticketProposalAuthorityProviderResultV0Schema.parse> {
  const parsed = ticketProposalAuthorityProviderResultV0Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new KnowledgeError(
    "authority_proof_invalid",
    "the trusted authority provider returned an invalid proof",
    { issues: parsed.error.issues },
    ["Repair or update the trusted host authority provider."],
  );
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

function parseStored<T>(
  schema: {
    safeParse(input: unknown):
      | { success: true; data: T }
      | { success: false; error: { issues: unknown[] } };
  },
  input: unknown,
  message: string,
): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw corrupt(message, { issues: parsed.error.issues });
}

function parseStoredDocument<T>(
  schema: {
    safeParse(input: unknown):
      | { success: true; data: T }
      | { success: false; error: { issues: unknown[] } };
  },
  payload: string,
  message: string,
): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    throw corrupt(message, { cause: "invalid_json" });
  }
  const parsed = parseStored(schema, decoded, message);
  if (serializeGitTicketStoreDocumentV0(parsed) !== payload) {
    throw corrupt(message, { cause: "non_canonical_payload" });
  }
  return parsed;
}

function conflict(message: string, details: unknown): KnowledgeError {
  return new KnowledgeError(
    "cas_conflict",
    message,
    details,
    ["Refresh the proposal review packet and retry against exact current facts."],
  );
}

function corrupt(message: string, details: unknown): KnowledgeError {
  return new KnowledgeError(
    "internal_error",
    message,
    details,
    ["Restore the operational database from a consistent backup."],
  );
}

function applicationRecoveryRequired(
  message: string,
  details: unknown,
): KnowledgeError {
  return new KnowledgeError(
    "application_recovery_required",
    message,
    details,
    [
      "Retry the exact applied proposal after inspecting the Ticket writer fence and operational ledger.",
    ],
  );
}
