import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TICKET_PROPOSAL_APPLICATION_MAX_INPUT_BYTES,
  TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION,
  TICKET_PROPOSAL_AUTHORITY_MAX_INPUT_BYTES,
  TICKET_PROPOSAL_REVIEW_MAX_INPUT_BYTES,
  type TicketProposalApplicationIntentV0,
  type TicketProposalApplicationReceiptV0,
  type TicketProposalAuthorityDecisionReceiptV0,
  type TicketProposalAuthorityProviderResultV0,
  type TicketProposalReviewPacketV0,
} from "../src/contract/ticket-application.js";
import {
  ticketProposalApplicationIntentV0Schema,
  ticketProposalApplicationReceiptV0Schema,
  ticketProposalApplyInputV0Schema,
  ticketProposalAuthorityDecideInputV0Schema,
  ticketProposalAuthorityDecisionReceiptV0Schema,
  ticketProposalAuthorityProviderResultV0Schema,
  ticketProposalReviewInputV0Schema,
  ticketProposalReviewPacketV0Schema,
} from "../src/contract/ticket-application-schemas.js";

const hex = (value: string): string => value.repeat(64);
const proposalId = `tgp-${hex("a")}`;
const proposalDigest = hex("b");
const candidateDigest = hex("c");
const snapshotId = `tgs-${hex("d")}`;
const scopeRef = `tps-${hex("e")}`;
const validationReceiptId = `tpv-${hex("1")}`;
const validationReceiptDigest = hex("2");
const authorityDecisionId = `tgd-${hex("3")}`;
const authorityDecisionDigest = hex("4");
const applicationIntentId = `tai-${hex("5")}`;
const applicationIntentDigest = hex("6");

function authorityDecision(
  disposition: "authorized" | "rejected" = "authorized",
): TicketProposalAuthorityDecisionReceiptV0 {
  const common = {
    schemaVersion: TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION,
    kind: "ticket_proposal_authority_decision" as const,
    authorityDecisionId,
    authorityDecisionDigest,
    scopeRef,
    target: {
      kind: "ticket_graph_change_proposal" as const,
      proposalId,
      proposalDigest,
      observedSnapshotId: snapshotId,
      candidateDigest,
    },
    validationSet: {
      digest: hex("7"),
      throughSequence: 1,
      count: 1,
      accepted: disposition === "authorized"
        ? [{ validationReceiptId, validationReceiptDigest }]
        : [],
    },
    requiredPath: "delegated_policy" as const,
    decidedAt: "2026-07-29T12:00:00.000Z",
    provider: {
      kind: "trusted_host_authority_provider" as const,
      id: "vibehub.host-authority",
      version: "1",
      artifactDigest: hex("8"),
      trust: "host_injected" as const,
    },
    principal: {
      kind: "service" as const,
      ref: "host-policy:local",
      authenticationContextDigest: hex("9"),
      trust: "host_authenticated" as const,
    },
    basis: {
      kind: "delegation" as const,
      ref: "delegation:accepted-plan",
      digest: hex("a"),
    },
    resolvedAssessment: {
      changeClass: "decomposition" as const,
      authoritySignals: [],
    },
    rationale: "Inside the accepted plan's delegated technical boundary.",
    effect: "authority_decision_only" as const,
    maturityEffect: "none" as const,
    graphMutationApplied: false as const,
  };
  return disposition === "authorized"
    ? {
        ...common,
        disposition,
        authorityGranted: true,
        applicationAuthorized: true,
      }
    : {
        ...common,
        disposition,
        authorityGranted: false,
        applicationAuthorized: false,
      };
}

function applicationIntent(): TicketProposalApplicationIntentV0 {
  return {
    schemaVersion: TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION,
    kind: "ticket_proposal_application_intent",
    applicationIntentId,
    applicationIntentDigest,
    scopeRef,
    preparedAt: "2026-07-29T12:01:00.000Z",
    target: authorityDecision().target,
    authorityDecision: {
      authorityDecisionId,
      authorityDecisionDigest,
    },
    publication: {
      baseSnapshotId: snapshotId,
      storeId: `ticket-store-${"0".repeat(32)}`,
      candidateSnapshotId: `tgs-${hex("f")}`,
      candidateDigest,
      ticketCount: 5,
      directUnlockCount: 4,
    },
    effect: "pending_canonical_graph_publication",
    maturityEffect: "none",
    graphMutationApplied: false,
  };
}

function applicationReceipt(): TicketProposalApplicationReceiptV0 {
  return {
    schemaVersion: TICKET_PROPOSAL_APPLICATION_SCHEMA_VERSION,
    kind: "ticket_proposal_application_receipt",
    applicationReceiptId: `tar-${hex("7")}`,
    applicationReceiptDigest: hex("8"),
    applicationIntentId,
    applicationIntentDigest,
    scopeRef,
    recordedAt: "2026-07-29T12:02:00.000Z",
    target: authorityDecision().target,
    authorityDecision: {
      authorityDecisionId,
      authorityDecisionDigest,
    },
    publication: {
      status: "published",
      previousSnapshotId: snapshotId,
      snapshotId: `tgs-${hex("f")}`,
      ticketCount: 5,
      directUnlockCount: 4,
    },
    effect: "ticket_graph_publication",
    maturityEffect: "none",
    graphMutationApplied: true,
  };
}

describe("Ticket proposal authority/application browser-safe contracts", () => {
  it("keeps every public operation input fact-bound and strict", () => {
    expect(ticketProposalReviewInputV0Schema.parse({ proposalId })).toEqual({
      proposalId,
    });
    expect(ticketProposalReviewInputV0Schema.safeParse({
      proposalId,
      principal: "human:caller",
    }).success).toBe(false);

    const decideInput = {
      schemaVersion: 1,
      proposalId,
      expectedProposalDigest: proposalDigest,
      expectedCandidateDigest: candidateDigest,
      expectedValidationSetDigest: hex("7"),
    };
    expect(ticketProposalAuthorityDecideInputV0Schema.safeParse(decideInput).success)
      .toBe(true);
    expect(ticketProposalAuthorityDecideInputV0Schema.safeParse({
      ...decideInput,
      disposition: "authorized",
      principal: { kind: "human", ref: "caller" },
      authorityGranted: true,
    }).success).toBe(false);

    const applyInput = {
      schemaVersion: 1,
      proposalId,
      expectedProposalDigest: proposalDigest,
      expectedCandidateDigest: candidateDigest,
      authorityDecisionId,
      expectedAuthorityDecisionDigest: authorityDecisionDigest,
    };
    expect(ticketProposalApplyInputV0Schema.safeParse(applyInput).success)
      .toBe(true);
    expect(ticketProposalApplyInputV0Schema.safeParse({
      ...applyInput,
      authorityOverride: true,
    }).success).toBe(false);
    expect(TICKET_PROPOSAL_REVIEW_MAX_INPUT_BYTES).toBe(4 * 1024);
    expect(TICKET_PROPOSAL_AUTHORITY_MAX_INPUT_BYTES).toBe(64 * 1024);
    expect(TICKET_PROPOSAL_APPLICATION_MAX_INPUT_BYTES).toBe(64 * 1024);
  });

  it("accepts only coherent trusted authority decisions", () => {
    expect(ticketProposalAuthorityDecisionReceiptV0Schema
      .safeParse(authorityDecision()).success).toBe(true);
    expect(ticketProposalAuthorityDecisionReceiptV0Schema
      .safeParse(authorityDecision("rejected")).success).toBe(true);

    expect(ticketProposalAuthorityDecisionReceiptV0Schema.safeParse({
      ...authorityDecision(),
      authorityGranted: false,
    }).success).toBe(false);
    expect(ticketProposalAuthorityDecisionReceiptV0Schema.safeParse({
      ...authorityDecision(),
      validationSet: {
        ...authorityDecision().validationSet,
        accepted: [],
      },
    }).success).toBe(false);
    expect(ticketProposalAuthorityDecisionReceiptV0Schema.safeParse({
      ...authorityDecision(),
      basis: {
        kind: "human_authority",
        ref: "human-session:1",
        digest: hex("a"),
      },
    }).success).toBe(false);
  });

  it("requires provider results to carry host-established trust", () => {
    const decision = authorityDecision();
    const providerResult: TicketProposalAuthorityProviderResultV0 = {
      disposition: "authorized",
      provider: decision.provider,
      principal: decision.principal,
      basis: decision.basis,
      acceptedValidations: decision.validationSet.accepted,
      resolvedAssessment: decision.resolvedAssessment,
      rationale: decision.rationale,
    };
    expect(ticketProposalAuthorityProviderResultV0Schema
      .safeParse(providerResult).success).toBe(true);
    expect(ticketProposalAuthorityProviderResultV0Schema.safeParse({
      ...providerResult,
      provider: {
        ...providerResult.provider,
        trust: "claimed_unverified",
      },
    }).success).toBe(false);
  });

  it("binds application intent and receipt to the exact base", () => {
    expect(ticketProposalApplicationIntentV0Schema
      .safeParse(applicationIntent()).success).toBe(true);
    expect(ticketProposalApplicationReceiptV0Schema
      .safeParse(applicationReceipt()).success).toBe(true);

    expect(ticketProposalApplicationIntentV0Schema.safeParse({
      ...applicationIntent(),
      publication: {
        ...applicationIntent().publication,
        baseSnapshotId: null,
      },
    }).success).toBe(false);
    expect(ticketProposalApplicationReceiptV0Schema.safeParse({
      ...applicationReceipt(),
      publication: {
        ...applicationReceipt().publication,
        previousSnapshotId: null,
      },
    }).success).toBe(false);
  });

  it("validates a complete, bounded review packet", () => {
    const packet: TicketProposalReviewPacketV0 = {
      schemaVersion: 1,
      scopeRef,
      proposal: {
        schemaVersion: 1,
        kind: "comment",
        proposalId,
        proposalDigest,
        scopeRef,
        observedSnapshotId: snapshotId,
        submittedAt: "2026-07-29T11:00:00.000Z",
        proposer: { kind: "claimed_actor", ref: "agent:reviewer" },
        effect: "review_contribution_only",
        graphMutationApplied: false,
        subject: {
          kind: "ticket",
          ticketId: "ticket-a",
          definitionRevision: 1,
        },
        body: "Preserve the accepted outcome.",
        reviewRequirement: {
          independentMachineValidation: "not_applicable",
          authorityStatus: "not_granted",
          routeHint: "comment_only",
          indicatedAuthoritySignals: [],
        },
      },
      validations: [],
      validationSet: {
        digest: hex("0"),
        throughSequence: 0,
        count: 0,
      },
      decision: null,
      application: null,
      eligibility: {
        status: "comment_only",
        reasons: ["Comments never mutate the Ticket Graph."],
      },
      nextAction: "none",
    };
    expect(ticketProposalReviewPacketV0Schema.safeParse(packet).success)
      .toBe(true);
    expect(ticketProposalReviewPacketV0Schema.safeParse({
      ...packet,
      validationSet: { ...packet.validationSet, count: 1 },
    }).success).toBe(false);
  });

  it("keeps the type-only contract free of Node and runtime-schema imports", () => {
    const testDirectory = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(
      path.join(testDirectory, "../src/contract/ticket-application.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/\b(?:node:|zod)\b/u);
  });
});
