import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OperationDispatcher,
  openDb,
  upsertRepo,
  type TicketGraphChangeProposalV0,
  type TicketProposalAuthorityDecisionReceiptV0,
  type TicketProposalReviewPacketV0,
} from "@vw-ai/vibehub-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLocalDecisionReceipt,
  parseTicketReviewHostFlags,
  startTicketReviewHost,
  ticketReviewGraphDisplayMode,
  trustedLocalDecisionProvider,
  type TicketReviewHostHandle,
} from "../src/ticket-review-host.js";

const NOW = "2026-07-29T20:00:00.000Z";

describe("local Ticket review host", () => {
  const roots: string[] = [];
  const hosts: TicketReviewHostHandle[] = [];

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses the explicit one-proposal launch boundary", () => {
    expect(parseTicketReviewHostFlags([
      "--proposal",
      "tgp-test",
      "--repo",
      "/tmp/repo",
      "--db",
      "/tmp/review.sqlite",
      "--port",
      "4312",
      "--open",
      "--json",
    ])).toMatchObject({
      proposalId: "tgp-test",
      repo: "/tmp/repo",
      db: "/tmp/review.sqlite",
      port: 4312,
      open: true,
      json: true,
    });
    expect(() => parseTicketReviewHostFlags([])).toThrow(
      "--proposal is required",
    );
    expect(() => parseTicketReviewHostFlags([
      "--proposal",
      "tgp-test",
      "--principal",
      "human:forged",
    ])).toThrow("unknown flag: --principal");
    expect(parseTicketReviewHostFlags([
      "--proposal",
      "tgp-default-open",
    ]).open).toBe(true);
    expect(parseTicketReviewHostFlags([
      "--proposal",
      "tgp-manual",
      "--no-open",
    ]).open).toBe(false);

    expect(ticketReviewGraphDisplayMode({
      eligibilityStatus: "authority_required",
      hasApplication: false,
      hasCurrentGraph: true,
      candidateBaseMatches: true,
    })).toBe("candidate");
    expect(ticketReviewGraphDisplayMode({
      eligibilityStatus: "authority_required",
      hasApplication: false,
      hasCurrentGraph: true,
      candidateBaseMatches: false,
    })).toBe("unavailable");
    expect(ticketReviewGraphDisplayMode({
      eligibilityStatus: "stale",
      hasApplication: false,
      hasCurrentGraph: true,
      candidateBaseMatches: false,
    })).toBe("canonical");
    expect(ticketReviewGraphDisplayMode({
      eligibilityStatus: "stale",
      hasApplication: false,
      hasCurrentGraph: false,
      candidateBaseMatches: false,
    })).toBe("unavailable");
    expect(ticketReviewGraphDisplayMode({
      eligibilityStatus: "applied",
      hasApplication: true,
      hasCurrentGraph: true,
      candidateBaseMatches: false,
    })).toBe("canonical");
  });

  it("verifies the exact Core authority receipt without a listener", () => {
    const fixture = seedValidatedBootstrap();
    const db = openDb(fixture.dbPath);
    const row = db.prepare(
      `SELECT id FROM repos WHERE root_path = ?`,
    ).get(fixture.repo) as { id: number };
    const dispatcher = new OperationDispatcher(db, {
      repoRoot: fixture.repo,
    });
    const reviewed = dispatcher.dispatch(
      "ticket.proposal.review.inspect",
      context(row.id, "review-host:pure-review"),
      { proposalId: fixture.proposal.proposalId },
    );
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) throw new Error(reviewed.error.message);
    const packet = reviewed.data as TicketProposalReviewPacketV0;
    const sessionId = "pure-receipt-boundary";
    const token = "e".repeat(43);
    const rationale =
      "I reviewed this exact bootstrap candidate and its validation set.";
    const provider = trustedLocalDecisionProvider({
      sessionId,
      token,
      action: "authorize",
      rationale,
      expectedProposalId: fixture.proposal.proposalId,
      expectedProposalDigest: fixture.proposal.proposalDigest,
      expectedCandidateDigest:
        fixture.proposal.mechanicalReview.candidateDigest,
      expectedValidationSetDigest: packet.validationSet.digest,
    });
    const decided = new OperationDispatcher(db, {
      repoRoot: fixture.repo,
      ticketAuthorityProvider: provider,
    }).dispatch(
      "ticket.proposal.authority.decide",
      context(row.id, "review-host:pure-decision"),
      {
        schemaVersion: 1,
        proposalId: fixture.proposal.proposalId,
        expectedProposalDigest: fixture.proposal.proposalDigest,
        expectedCandidateDigest:
          fixture.proposal.mechanicalReview.candidateDigest,
        expectedValidationSetDigest: packet.validationSet.digest,
      },
    );
    expect(decided.ok).toBe(true);
    if (!decided.ok) throw new Error(decided.error.message);
    const decision =
      decided.data as TicketProposalAuthorityDecisionReceiptV0;
    expect(() => assertLocalDecisionReceipt(decision, {
      sessionId,
      token,
      action: "authorize",
      rationale,
      packet,
    })).not.toThrow();

    const foreign = structuredClone(decision);
    foreign.target.candidateDigest = "f".repeat(64);
    expect(() => assertLocalDecisionReceipt(foreign, {
      sessionId,
      token,
      action: "authorize",
      rationale,
      packet,
    })).toThrow("Another terminal authority decision");
    db.close();
  });

  it("rejects unauthenticated, cross-origin, and authority-shaped browser input", async () => {
    const fixture = seedValidatedBootstrap();
    const host = startTicketReviewHost({
      repoRoot: fixture.repo,
      dbPath: fixture.dbPath,
      proposalId: fixture.proposal.proposalId,
      token: "a".repeat(43),
    });
    hosts.push(host);
    const ready = await host.ready;

    expect((await fetch(`${ready.origin}/api/state`)).status).toBe(401);

    const stateResponse = await fetch(`${ready.origin}/api/state`, {
      headers: bearer(host.token),
    });
    expect(stateResponse.status).toBe(200);
    const stateEnvelope = await stateResponse.json() as {
      data: {
        proposal: {
          proposalDigest: string;
          candidateDigest: string;
        };
        review: {
          validationSet: { digest: string };
        };
      };
    };
    const decision = {
      action: "authorize",
      rationale: "I reviewed the complete initial graph.",
      expectedProposalDigest: stateEnvelope.data.proposal.proposalDigest,
      expectedCandidateDigest: stateEnvelope.data.proposal.candidateDigest,
      expectedValidationSetDigest:
        stateEnvelope.data.review.validationSet.digest,
    };

    expect((await fetch(`${ready.origin}/api/state`, {
      headers: {
        ...bearer(host.token),
        Host: `localhost:${ready.port}`,
      },
    })).status).toBe(403);

    expect((await fetch(`${ready.origin}/api/decision`, {
      method: "POST",
      headers: {
        ...bearer(host.token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(decision),
    })).status).toBe(403);

    expect((await fetch(`${ready.origin}/api/decision`, {
      method: "POST",
      headers: {
        ...bearer(host.token),
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify(decision),
    })).status).toBe(403);

    expect((await fetch(`${ready.origin}/api/decision`, {
      method: "POST",
      headers: {
        ...bearer(host.token),
        "Content-Type": "application/json",
        Origin: ready.origin,
      },
      body: JSON.stringify({
        ...decision,
        principal: {
          kind: "human",
          ref: "human:forged",
        },
      }),
    })).status).toBe(400);

    const db = openDb(fixture.dbPath);
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposal_authority_decisions`,
    ).get()).toEqual({ count: 0 });
    db.close();
    expect(fs.existsSync(
      path.join(fixture.repo, ".vibehub", "ticket-store"),
    )).toBe(false);
  });

  it("turns one explicit local human decision into an exact authority receipt and canonical graph", async () => {
    const fixture = seedValidatedBootstrap();
    const host = startTicketReviewHost({
      repoRoot: fixture.repo,
      dbPath: fixture.dbPath,
      proposalId: fixture.proposal.proposalId,
      token: "b".repeat(43),
    });
    hosts.push(host);
    const ready = await host.ready;
    const before = await getState(ready.origin, host.token);

    expect(before.graph).toMatchObject({
      source: "proposal_candidate",
      tickets: [
        expect.objectContaining({ state: "created" }),
        expect.objectContaining({ state: "created" }),
      ],
      relations: [
        expect.objectContaining({ state: "created" }),
      ],
    });
    expect(before.review).toMatchObject({
      eligibility: { status: "authority_required" },
      nextAction: "request_authority_decision",
      requiredPath: "human_authority",
      validationSet: { count: 1 },
    });

    const response = await fetch(`${ready.origin}/api/decision`, {
      method: "POST",
      headers: {
        ...bearer(host.token),
        "Content-Type": "application/json",
        Origin: ready.origin,
      },
      body: JSON.stringify({
        action: "authorize",
        rationale:
          "I reviewed every Ticket and direct unlock path in this initial plan.",
        expectedProposalDigest: before.proposal.proposalDigest,
        expectedCandidateDigest: before.proposal.candidateDigest,
        expectedValidationSetDigest: before.review.validationSet.digest,
      }),
    });
    expect(response.status).toBe(200);
    const envelope = await response.json() as {
      ok: boolean;
      data: {
        graph: { source: string; tickets: unknown[]; relations: unknown[] };
        review: {
          eligibility: { status: string };
          decision: {
            disposition: string;
            principal: { kind: string; ref: string; trust: string };
            basis: { kind: string };
          };
          application: {
            publication: { status: string; snapshotId: string };
          };
        };
      };
    };
    expect(envelope).toMatchObject({
      ok: true,
      data: {
        graph: {
          source: "canonical",
          tickets: [{ state: "existing" }, { state: "existing" }],
          relations: [{ state: "existing" }],
        },
        review: {
          eligibility: { status: "applied" },
          decision: {
            disposition: "authorized",
            principal: {
              kind: "human",
              ref: expect.stringMatching(/^local-os-user:/),
              trust: "host_authenticated",
            },
            basis: { kind: "human_authority" },
          },
          application: {
            publication: {
              status: "published",
              snapshotId: expect.stringMatching(/^tgs-/),
            },
          },
        },
      },
    });

    const db = openDb(fixture.dbPath);
    expect(db.prepare(
      `SELECT provider_id providerId,principal_kind principalKind,
              basis_kind basisKind,disposition
       FROM ticket_proposal_authority_decisions`,
    ).get()).toEqual({
      providerId: "vibehub.local-ticket-review-host",
      principalKind: "human",
      basisKind: "human_authority",
      disposition: "authorized",
    });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposal_application_receipts`,
    ).get()).toEqual({ count: 1 });
    db.close();
    expect(fs.existsSync(
      path.join(fixture.repo, ".vibehub", "ticket-store", "latest.yaml"),
    )).toBe(true);
    await host.closed;
    await expect(fetch(`${ready.origin}/api/state`, {
      headers: bearer(host.token),
    })).rejects.toThrow();
  });

  it("records rejection without publication and revokes the terminal capability", async () => {
    const fixture = seedValidatedBootstrap();
    const host = startTicketReviewHost({
      repoRoot: fixture.repo,
      dbPath: fixture.dbPath,
      proposalId: fixture.proposal.proposalId,
      token: "c".repeat(43),
    });
    hosts.push(host);
    const ready = await host.ready;
    const before = await getState(ready.origin, host.token);

    const response = await fetch(`${ready.origin}/api/decision`, {
      method: "POST",
      headers: {
        ...bearer(host.token),
        "Content-Type": "application/json",
        Origin: ready.origin,
      },
      body: JSON.stringify({
        action: "reject",
        rationale:
          "The graph needs a narrower execution boundary before publication.",
        expectedProposalDigest: before.proposal.proposalDigest,
        expectedCandidateDigest: before.proposal.candidateDigest,
        expectedValidationSetDigest: before.review.validationSet.digest,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: {
        review: {
          eligibility: { status: "rejected" },
          decision: { disposition: "rejected" },
          application: null,
        },
      },
    });
    await host.closed;

    const db = openDb(fixture.dbPath);
    expect(db.prepare(
      `SELECT disposition FROM ticket_proposal_authority_decisions`,
    ).get()).toEqual({ disposition: "rejected" });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposal_application_receipts`,
    ).get()).toEqual({ count: 0 });
    db.close();
    expect(fs.existsSync(
      path.join(fixture.repo, ".vibehub", "ticket-store"),
    )).toBe(false);
    await expect(fetch(`${ready.origin}/api/state`, {
      headers: bearer(host.token),
    })).rejects.toThrow();
  });

  it("expires and closes an unused local decision capability", async () => {
    const fixture = seedValidatedBootstrap();
    const host = startTicketReviewHost({
      repoRoot: fixture.repo,
      dbPath: fixture.dbPath,
      proposalId: fixture.proposal.proposalId,
      token: "d".repeat(43),
      tokenLifetimeMs: 10,
    });
    hosts.push(host);
    const ready = await host.ready;
    await host.closed;
    await expect(fetch(`${ready.origin}/api/state`, {
      headers: bearer(host.token),
    })).rejects.toThrow();

    const db = openDb(fixture.dbPath);
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposal_authority_decisions`,
    ).get()).toEqual({ count: 0 });
    db.close();
  });

  function seedValidatedBootstrap(): {
    root: string;
    repo: string;
    dbPath: string;
    proposal: TicketGraphChangeProposalV0;
  } {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "vh-ticket-review-host-")),
    );
    roots.push(root);
    const repo = makeRepository(root);
    const dbPath = path.join(root, "operational.sqlite");
    const db = openDb(dbPath);
    const row = upsertRepo(db, repo, null, "main", NOW);
    const dispatcher = new OperationDispatcher(db, { repoRoot: repo });
    const submitted = dispatcher.dispatch(
      "ticket.proposal.submit",
      context(row.id, "review-host:submit"),
      {
        schemaVersion: 1,
        kind: "graph_change",
        observedSnapshotId: null,
        reason: "Bootstrap the first live Ticket review path",
        source: {
          kind: "plan",
          ref: "plan:ticket-review-host",
        },
        authorAssessment: {
          changeClass: "decomposition",
          authoritySignals: ["initial_plan_authority"],
          introducesHumanGate: false,
          rationale:
            "The initial graph requires explicit human review before publication.",
        },
        changes: [
          {
            op: "create",
            localRef: "plan",
            definition: {
              outcome: "A person can review the complete initial Ticket graph.",
              parent: null,
              dependsOn: [],
            },
          },
          {
            op: "create",
            localRef: "publish",
            definition: {
              outcome:
                "The reviewed initial Ticket graph becomes canonical without caller-forged authority.",
              parent: null,
              dependsOn: [{
                target: { kind: "local", localRef: "plan" },
                rationale:
                  "The graph must be reviewed before it can be published.",
              }],
            },
          },
        ],
      },
    );
    if (!submitted.ok) {
      throw new Error(`proposal failed: ${JSON.stringify(submitted)}`);
    }
    const proposal = submitted.data as TicketGraphChangeProposalV0;
    const validation = dispatcher.dispatch(
      "ticket.proposal.validation.record",
      context(row.id, "review-host:validation"),
      passingValidation(proposal),
    );
    if (!validation.ok) {
      throw new Error(`validation failed: ${JSON.stringify(validation)}`);
    }
    db.close();
    return { root, repo, dbPath, proposal };
  }
});

function passingValidation(proposal: TicketGraphChangeProposalV0) {
  return {
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    expectedProposalDigest: proposal.proposalDigest,
    expectedCandidateDigest: proposal.mechanicalReview.candidateDigest,
    validator: {
      id: "vibehub-ticket-validate",
      version: "1",
      artifactDigest: "1".repeat(64),
    },
    policy: {
      id: "vibehub-ticket-proposal-semantic-review",
      version: "1",
      artifactDigest: "2".repeat(64),
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
      summary: `${code} is supported by the exact initial candidate.`,
      evidenceRefs: [`proposal:${proposal.proposalId}`],
    })),
    findings: [],
    indicatedAuthoritySignals: ["initial_plan_authority"],
  };
}

function context(repoId: number, requestId: string) {
  return {
    repoId,
    actor: "agent:ticket-planner",
    requestId,
    now: NOW,
  };
}

function makeRepository(parent: string): string {
  const repository = path.join(parent, "repo");
  fs.mkdirSync(repository);
  execFileSync("git", ["init", "-b", "main"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Ticket Review Host Test"], {
    cwd: repository,
  });
  execFileSync("git", ["config", "user.email", "review-host@example.test"], {
    cwd: repository,
  });
  fs.writeFileSync(path.join(repository, "README.md"), "review host\n");
  execFileSync("git", ["add", "README.md"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repository });
  return fs.realpathSync(repository);
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function getState(origin: string, token: string): Promise<any> {
  const response = await fetch(`${origin}/api/state`, {
    headers: bearer(token),
  });
  if (!response.ok) throw new Error(`state failed: ${response.status}`);
  return ((await response.json()) as { data: unknown }).data;
}
