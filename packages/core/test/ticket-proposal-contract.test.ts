import { describe, expect, it } from "vitest";
import {
  TICKET_PROPOSAL_MAX_INPUT_BYTES,
  TICKET_PROPOSAL_VALIDATION_CHECK_CODES,
  TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES,
  isJsonValueWithinByteBudgetV0,
  isTicketProposalInputWithinBudgetV0,
  type TicketProposalSubmitInputV0,
  type TicketProposalValidationRecordInputV0,
} from "../src/contract/ticket-proposal.js";
import {
  ticketProposalValidationRecordInputV0Schema,
} from "../src/contract/ticket-proposal-schemas.js";
import { operationInputSchemas } from "../src/operation-contracts.js";

type GraphProposalInput = Extract<
  TicketProposalSubmitInputV0,
  { kind: "graph_change" }
>;

const validProposal = (): GraphProposalInput => ({
  schemaVersion: 1 as const,
  kind: "graph_change" as const,
  observedSnapshotId: null,
  reason: "Decompose the accepted outcome",
  authorAssessment: {
    changeClass: "decomposition" as const,
    authoritySignals: [],
    introducesHumanGate: false,
    rationale: "The work stays inside delegated authority.",
  },
  changes: [{
    op: "create" as const,
    localRef: "implementation",
    definition: {
      outcome: "Implement the accepted capability",
      parent: null,
      dependsOn: [],
    },
  }],
});

const validValidation = (): TicketProposalValidationRecordInputV0 => ({
  schemaVersion: 1,
  proposalId: `tgp-${"1".repeat(64)}`,
  expectedProposalDigest: "2".repeat(64),
  expectedCandidateDigest: "3".repeat(64),
  validator: {
    id: "semantic-validator",
    version: "1.0.0",
    artifactDigest: "4".repeat(64),
  },
  policy: {
    id: "ticket-proposal-policy",
    version: "1",
    artifactDigest: "5".repeat(64),
  },
  checks: TICKET_PROPOSAL_VALIDATION_CHECK_CODES.map((code, index) => ({
    localRef: `check-${index}`,
    code,
    subject: { kind: "proposal" as const },
    outcome: "passed" as const,
    summary: `${code} passed`,
    evidenceRefs: [`evidence:${code}`],
  })),
  findings: [],
  indicatedAuthoritySignals: [],
});

describe("Ticket proposal browser contract", () => {
  it("enforces the exact 4 MiB JSON UTF-8 boundary", () => {
    expect(TICKET_PROPOSAL_MAX_INPUT_BYTES).toBe(4_194_304);
    expect(isTicketProposalInputWithinBudgetV0([
      "x".repeat(TICKET_PROPOSAL_MAX_INPUT_BYTES - 4),
    ])).toBe(true);
    expect(isTicketProposalInputWithinBudgetV0([
      "x".repeat(TICKET_PROPOSAL_MAX_INPUT_BYTES - 3),
    ])).toBe(false);
  });

  it("stops traversal immediately after the budget is exhausted", () => {
    let readPastBudget = false;
    const value: Record<string, unknown> = {
      payload: "x".repeat(TICKET_PROPOSAL_MAX_INPUT_BYTES),
    };
    Object.defineProperty(value, "mustNotRead", {
      enumerable: true,
      get() {
        readPastBudget = true;
        throw new Error("budget traversal continued");
      },
    });

    expect(isTicketProposalInputWithinBudgetV0(value)).toBe(false);
    expect(readPastBudget).toBe(false);
  });

  it("fails closed for cycles and unsupported non-JSON values", () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(isTicketProposalInputWithinBudgetV0(cycle)).toBe(false);
    expect(isTicketProposalInputWithinBudgetV0({ value: 1n })).toBe(false);
  });

  it("rejects duplicate authority signals and caller-authored provenance", () => {
    const duplicateSignals = validProposal();
    duplicateSignals.authorAssessment.authoritySignals = [
      "risk_policy",
      "risk_policy",
    ];
    expect(operationInputSchemas["ticket.proposal.submit"]
      .safeParse(duplicateSignals).success).toBe(false);

    const callerProvenance = {
      ...validProposal(),
      changes: [{
        op: "create",
        localRef: "implementation",
        definition: {
          outcome: "Implement the accepted capability",
          parent: null,
          dependsOn: [],
          provenanceRefs: ["caller:forged"],
        },
      }],
    };
    expect(operationInputSchemas["ticket.proposal.submit"]
      .safeParse(callerProvenance).success).toBe(false);
  });

  it("applies the aggregate budget after all structural field checks", () => {
    const proposal = validProposal();
    const outcome = "x".repeat(20_000);
    const rationale = "y".repeat(1_000);
    proposal.changes = Array.from({ length: 200 }, (_, index) => ({
      op: "create" as const,
      localRef: `budget-${index}`,
      definition: {
        outcome,
        parent: null,
        dependsOn: [{
          target: { kind: "ticket" as const, ticketId: `TKT-${index}` },
          rationale,
        }],
      },
    }));

    expect(new TextEncoder().encode(JSON.stringify(proposal)).byteLength)
      .toBeGreaterThan(TICKET_PROPOSAL_MAX_INPUT_BYTES);
    const parsed = operationInputSchemas["ticket.proposal.submit"].safeParse(proposal);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message))
        .toContain("Ticket proposal input must not exceed 4194304 JSON bytes");
    }
  });

  it("enforces the proposal-validation 1 MiB JSON budget exactly", () => {
    expect(TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES).toBe(1_048_576);
    expect(isJsonValueWithinByteBudgetV0(
      ["x".repeat(TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES - 4)],
      TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES,
    )).toBe(true);
    expect(isJsonValueWithinByteBudgetV0(
      ["x".repeat(TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES - 3)],
      TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES,
    )).toBe(false);
  });

  it("requires every frozen semantic check exactly once with evidence", () => {
    expect(ticketProposalValidationRecordInputV0Schema
      .safeParse(validValidation()).success).toBe(true);

    const duplicate = validValidation();
    duplicate.checks[1]!.code = duplicate.checks[0]!.code;
    expect(ticketProposalValidationRecordInputV0Schema
      .safeParse(duplicate).success).toBe(false);

    const missingEvidence = validValidation();
    missingEvidence.checks[0]!.evidenceRefs = [];
    expect(ticketProposalValidationRecordInputV0Schema
      .safeParse(missingEvidence).success).toBe(false);

    const missingDeltaDirection = validValidation();
    missingDeltaDirection.checks[0]!.subject = {
      kind: "dependency_change",
      prerequisiteTicketId: "TKT-A",
      dependentTicketId: "TKT-B",
    } as TicketProposalValidationRecordInputV0["checks"][number]["subject"];
    expect(ticketProposalValidationRecordInputV0Schema
      .safeParse(missingDeltaDirection).success).toBe(false);
  });

  it("binds non-passing checks to blocking findings", () => {
    const invalid = validValidation();
    invalid.checks[0]!.outcome = "inconclusive";
    expect(ticketProposalValidationRecordInputV0Schema
      .safeParse(invalid).success).toBe(false);

    invalid.findings.push({
      localRef: "finding-0",
      checkLocalRef: invalid.checks[0]!.localRef,
      subject: { kind: "proposal" },
      impact: "blocking",
      code: "insufficient_evidence",
      summary: "The evidence does not establish this check.",
      evidenceRefs: ["evidence:gap"],
    });
    expect(ticketProposalValidationRecordInputV0Schema
      .safeParse(invalid).success).toBe(true);
  });
});
