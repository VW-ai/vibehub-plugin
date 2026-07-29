import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openDb,
  TICKET_PROPOSAL_MAX_INPUT_BYTES,
  upsertRepo,
} from "@vw-ai/vibehub-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.js";

interface Invocation {
  status: number;
  raw: string;
  envelope: Record<string, unknown>;
}

describe("vibehub ticket JSON adapter", () => {
  let root: string;
  let repo: string;
  let dbPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vh-cli-ticket-"));
    repo = makeRepository(root, "repo-a");
    dbPath = path.join(root, "workbench.db");
    const db = openDb(dbPath);
    upsertRepo(
      db,
      fs.realpathSync(repo),
      "fixture/repo-a",
      "main",
      "2026-07-28T12:00:00.000Z",
    );
    db.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("forwards the default provider's honest absent result as the raw envelope", () => {
    const result = invoke([
      "ticket",
      "ticket.graph.snapshot",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "cli-test",
      "--request",
      "ticket-absent",
    ]);

    expect(result.status).toBe(3);
    expect(result.envelope).toEqual({
      ok: false,
      error: {
        code: "not_found",
        message: "the repository has no canonical Ticket graph to review",
        details: { repoId: 1 },
        nextSafeActions: [
          "Publish a canonical Ticket generation for this worktree.",
        ],
      },
    });
    expect(result.raw).toBe(`${JSON.stringify(result.envelope)}\n`);
  });

  it("accepts both group-relative and fully-qualified Ticket operation names", () => {
    for (const [operation, requestId] of [
      ["graph.snapshot", "ticket-short-name"],
      ["ticket.graph.snapshot", "ticket-full-name"],
    ] as const) {
      const result = invoke([
        "ticket",
        operation,
        "--json",
        "--repo",
        repo,
        "--db",
        dbPath,
        "--actor",
        "cli-test",
        "--request",
        requestId,
      ]);
      expect(result.status).toBe(3);
      expect(result.envelope).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
    }
  });

  it("submits an immutable proposal without publishing a Ticket graph", () => {
    const input = {
      schemaVersion: 1,
      kind: "graph_change",
      observedSnapshotId: null,
      reason: "Shape the accepted CLI work",
      authorAssessment: {
        changeClass: "decomposition",
        authoritySignals: [],
        introducesHumanGate: false,
        rationale: "The proposal remains within the accepted outcome.",
      },
      changes: [{
        op: "create",
        localRef: "implementation",
        definition: {
          outcome: "Implement the accepted CLI behavior",
          parent: null,
          dependsOn: [],
        },
      }],
    };
    const result = invoke([
      "ticket",
      "proposal.submit",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "cli-test",
      "--request",
      "ticket-proposal-submit",
      "--input",
      JSON.stringify(input),
    ]);

    expect(result.status).toBe(0);
    expect(result.envelope).toMatchObject({
      ok: true,
      data: {
        kind: "graph_change",
        effect: "review_contribution_only",
        graphMutationApplied: false,
        reviewRequirement: {
          authorityStatus: "not_granted",
        },
      },
      meta: {
        operation: "ticket.proposal.submit",
        requestId: "ticket-proposal-submit",
      },
    });
    const db = openDb(dbPath);
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposals`,
    ).get()).toEqual({ count: 1 });
    db.close();
    expect(fs.existsSync(
      path.join(repo, ".vibehub", "ticket-store"),
    )).toBe(false);
  });

  it("queries proposals and records independent validation evidence end to end", () => {
    const submitted = invoke([
      "ticket",
      "proposal.submit",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "proposal-author",
      "--request",
      "ticket-proposal-query-validation:submit",
      "--input",
      JSON.stringify({
        schemaVersion: 1,
        kind: "graph_change",
        observedSnapshotId: null,
        reason: "Create one independently reviewable Ticket",
        authorAssessment: {
          changeClass: "decomposition",
          authoritySignals: [],
          introducesHumanGate: false,
          rationale: "The candidate decomposes the accepted outcome.",
        },
        changes: [{
          op: "create",
          localRef: "implementation",
          definition: {
            outcome: "Implement the accepted behavior",
            parent: null,
            dependsOn: [],
          },
        }],
      }),
    ]);
    expect(submitted.status).toBe(0);
    const proposal = submitted.envelope["data"] as {
      proposalId: string;
      proposalDigest: string;
      mechanicalReview: { candidateDigest: string };
    };

    const inspected = invoke([
      "ticket",
      "proposal.inspect",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "proposal-validator",
      "--request",
      "ticket-proposal-query-validation:inspect",
      "--input",
      JSON.stringify({ proposalId: proposal.proposalId }),
    ]);
    expect(inspected.status).toBe(0);
    expect(inspected.envelope).toMatchObject({
      ok: true,
      data: {
        proposalId: proposal.proposalId,
        proposalDigest: proposal.proposalDigest,
        graphMutationApplied: false,
      },
    });

    const listed = invoke([
      "ticket",
      "proposal.list",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "proposal-validator",
      "--request",
      "ticket-proposal-query-validation:list",
      "--input",
      JSON.stringify({ kind: "graph_change", limit: 10 }),
    ]);
    expect(listed.status).toBe(0);
    expect(listed.envelope).toMatchObject({
      ok: true,
      data: {
        items: [{
          proposalId: proposal.proposalId,
          proposalDigest: proposal.proposalDigest,
        }],
        page: { count: 1, totalItems: 1 },
        nextCursor: null,
      },
    });

    const evidenceRef = `proposal:${proposal.proposalId}`;
    const recorded = invoke([
      "ticket",
      "proposal.validation.record",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "proposal-validator",
      "--request",
      "ticket-proposal-query-validation:record",
      "--input",
      JSON.stringify({
        schemaVersion: 1,
        proposalId: proposal.proposalId,
        expectedProposalDigest: proposal.proposalDigest,
        expectedCandidateDigest:
          proposal.mechanicalReview.candidateDigest,
        validator: {
          id: "vibehub-ticket-validate",
          version: "1",
          artifactDigest:
            "578541ee161a9c1134cce20d7137ac336317f1db1bd573ad2888461794add438",
        },
        policy: {
          id: "vibehub-ticket-proposal-semantic-review",
          version: "1",
          artifactDigest:
            "c02806b436408e925536509669be7c05510f3c6126f86fb7dd6fee47d59f465c",
        },
        checks: [
          "promise_preservation",
          "containment_truth",
          "dependency_truth",
          "change_classification",
          "delegated_scope",
          "protected_boundaries",
        ].map((code, index) => ({
          localRef: `check-${index + 1}`,
          code,
          subject: { kind: "proposal" },
          outcome: "passed",
          summary: `${code} is supported by the inspected candidate.`,
          evidenceRefs: [evidenceRef],
        })),
        findings: [],
        indicatedAuthoritySignals: [],
      }),
    ]);
    expect(recorded.status).toBe(0);
    expect(recorded.envelope).toMatchObject({
      ok: true,
      data: {
        kind: "ticket_proposal_validation_receipt",
        conclusion: "passed",
        effect: "validation_evidence_only",
        maturityEffect: "none",
        authorityGranted: false,
        applicationAuthorized: false,
        graphMutationApplied: false,
      },
    });
    const receipt = recorded.envelope["data"] as {
      validationReceiptId: string;
      validationReceiptDigest: string;
    };

    const validationInspected = invoke([
      "ticket",
      "proposal.validation.inspect",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "proposal-validator",
      "--request",
      "ticket-proposal-query-validation:validation-inspect",
      "--input",
      JSON.stringify({
        validationReceiptId: receipt.validationReceiptId,
      }),
    ]);
    expect(validationInspected.status).toBe(0);
    expect(validationInspected.envelope).toMatchObject({
      ok: true,
      data: {
        validationReceiptId: receipt.validationReceiptId,
        validationReceiptDigest: receipt.validationReceiptDigest,
        authorityGranted: false,
        applicationAuthorized: false,
      },
    });

    const validationsListed = invoke([
      "ticket",
      "proposal.validation.list",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "proposal-validator",
      "--request",
      "ticket-proposal-query-validation:validation-list",
      "--input",
      JSON.stringify({ proposalId: proposal.proposalId, limit: 10 }),
    ]);
    expect(validationsListed.status).toBe(0);
    expect(validationsListed.envelope).toMatchObject({
      ok: true,
      data: {
        proposalId: proposal.proposalId,
        items: [{
          validationReceiptId: receipt.validationReceiptId,
          conclusion: "passed",
          effect: "validation_evidence_only",
          maturityEffect: "none",
          authorityGranted: false,
          applicationAuthorized: false,
          graphMutationApplied: false,
        }],
        page: { count: 1, totalItems: 1 },
        nextCursor: null,
      },
    });

    const db = openDb(dbPath);
    expect(db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM ticket_proposals) proposalCount,
         (SELECT COUNT(*) FROM ticket_proposal_validation_receipts)
           validationCount`,
    ).get()).toEqual({ proposalCount: 1, validationCount: 1 });
    db.close();
    expect(fs.existsSync(
      path.join(repo, ".vibehub", "ticket-store"),
    )).toBe(false);
  });

  it("rejects oversized raw proposal JSON before parsing it", () => {
    const result = invoke([
      "ticket",
      "proposal.submit",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "cli-test",
      "--input",
      `${" ".repeat(TICKET_PROPOSAL_MAX_INPUT_BYTES)}{}`,
    ]);

    expect(result.status).toBe(2);
    expect(result.envelope).toMatchObject({
      ok: false,
      error: {
        code: "validation_error",
        message:
          `operation raw JSON input exceeds ${TICKET_PROPOSAL_MAX_INPUT_BYTES} bytes`,
      },
    });
  });

  it("keeps Ticket parser messages group-aware and uses stable exit classes", () => {
    const missingOperation = invoke(["ticket"]);
    expect(missingOperation.status).toBe(2);
    expect(missingOperation.envelope).toMatchObject({
      ok: false,
      error: {
        code: "validation_error",
        message: "ticket operation is required",
        nextSafeActions: [
          "Run vibehub ticket with --json and a valid JSON --input payload.",
        ],
      },
    });

    const missingJson = invoke([
      "ticket",
      "graph.snapshot",
      "--repo",
      repo,
      "--db",
      dbPath,
    ]);
    expect(missingJson.status).toBe(2);
    expect(missingJson.envelope).toMatchObject({
      ok: false,
      error: {
        code: "validation_error",
        message: "ticket operations require --json",
        nextSafeActions: [
          "Run vibehub ticket with --json and a valid JSON --input payload.",
        ],
      },
    });

    const missingActor = invoke([
      "ticket",
      "graph.snapshot",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
    ]);
    expect(missingActor.status).toBe(2);
    expect(missingActor.envelope).toMatchObject({
      ok: false,
      error: {
        code: "validation_error",
        message: "ticket operations require --actor <id>",
      },
    });

    const invalidInput = invoke([
      "ticket",
      "graph.snapshot",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "cli-test",
      "--request",
      "ticket-invalid-input",
      "--input",
      JSON.stringify({ pageSize: 0 }),
    ]);
    expect(invalidInput.status).toBe(2);
    expect(invalidInput.envelope).toMatchObject({
      ok: false,
      error: {
        code: "validation_error",
        message: "invalid input",
      },
    });

    const expiredSnapshot = invoke([
      "ticket",
      "subject.inspect",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "cli-test",
      "--request",
      "ticket-expired",
      "--input",
      JSON.stringify({
        snapshotId: `tgs-${"a".repeat(64)}`,
        subject: { kind: "ticket", ticketId: "TKT-001" },
      }),
    ]);
    expect(expiredSnapshot.status).toBe(3);
    expect(expiredSnapshot.envelope).toMatchObject({
      ok: false,
      error: { code: "snapshot_expired" },
    });
  });

  it("does not let a fully-qualified operation escape the Ticket family", () => {
    const result = invoke([
      "ticket",
      "kb.status",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "cli-test",
    ]);
    expect(result.status).toBe(2);
    expect(result.envelope).toMatchObject({
      ok: false,
      error: {
        code: "validation_error",
        message: "kb.status does not belong to the ticket operation family",
      },
    });
  });

  it("rejects the absent proposal.apply operation before reading its input", () => {
    const result = invoke([
      "ticket",
      "proposal.apply",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "cli-test",
      "--input",
      `${" ".repeat(128 * 1024)}not-json`,
    ]);
    expect(result.status).toBe(2);
    expect(result.envelope).toMatchObject({
      ok: false,
      error: {
        code: "validation_error",
        message: "unsupported ticket operation: proposal.apply",
      },
    });
  });

  it("rejects missing flag values and invalid repository ids", () => {
    for (const [tail, message] of [
      [["--request"], "--request requires a value"],
      [["--input"], "--input requires a value"],
      [["--repo-id", "not-an-id"], "--repo-id requires a positive integer"],
    ] as const) {
      const result = invoke([
        "ticket",
        "graph.snapshot",
        "--json",
        "--repo",
        repo,
        "--db",
        dbPath,
        "--actor",
        "cli-test",
        ...tail,
      ]);
      expect(result.status).toBe(2);
      expect(result.envelope).toMatchObject({
        ok: false,
        error: {
          code: "validation_error",
          message,
        },
      });
    }
  });

  it("fails closed when --repo-id addresses a different repository", () => {
    const otherRepo = makeRepository(root, "repo-b");
    const db = openDb(dbPath);
    const other = upsertRepo(
      db,
      fs.realpathSync(otherRepo),
      "fixture/repo-b",
      "main",
      "2026-07-28T12:01:00.000Z",
    );
    db.close();

    const result = invoke([
      "ticket",
      "graph.snapshot",
      "--json",
      "--repo",
      repo,
      "--repo-id",
      String(other.id),
      "--db",
      dbPath,
      "--actor",
      "cli-test",
      "--request",
      "ticket-scope-mismatch",
    ]);

    expect(result.status).toBe(2);
    expect(result.envelope).toMatchObject({
      ok: false,
      error: {
        code: "ticket_store_scope_mismatch",
        message: "dispatcher worktree does not belong to the addressed repository",
        details: { repoId: other.id },
      },
    });
  });

  it("reports a corrupt default Ticket store instead of treating it as absent", () => {
    fs.mkdirSync(path.join(repo, ".vibehub/ticket-store"), {
      recursive: true,
    });

    const result = invoke([
      "ticket",
      "graph.snapshot",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "cli-test",
      "--request",
      "ticket-corrupt",
    ]);

    expect(result.status).toBe(5);
    expect(result.envelope).toMatchObject({
      ok: false,
      error: {
        code: "ticket_store_corrupt",
        message: "Ticket store exists without its protocol",
        details: { file: "protocol.yaml" },
      },
    });
  });

  it("advertises the Ticket operation group in CLI usage", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main([])).toBe(2);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("vibehub ticket <operation> --json"),
    );
  });

  function invoke(args: string[]): Invocation {
    let raw = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(
      ((chunk: unknown) => {
        raw += String(chunk);
        return true;
      }) as typeof process.stdout.write,
    );
    const status = main(args);
    write.mockRestore();
    return {
      status,
      raw,
      envelope: JSON.parse(raw) as Record<string, unknown>,
    };
  }
});

function makeRepository(parent: string, name: string): string {
  const repository = path.join(parent, name);
  fs.mkdirSync(repository);
  execFileSync("git", ["init", "-b", "main"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Ticket CLI Test"], {
    cwd: repository,
  });
  execFileSync("git", ["config", "user.email", "ticket-cli@example.test"], {
    cwd: repository,
  });
  fs.writeFileSync(path.join(repository, "README.md"), `${name}\n`);
  execFileSync("git", ["add", "README.md"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repository });
  return fs.realpathSync(repository);
}
