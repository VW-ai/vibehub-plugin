import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OperationDispatcher,
  loadTicketLedgerFromWorktree,
  openDb,
  type Db,
  type OperationContext,
  type TicketDocument,
  type TicketLedgerSnapshot,
} from "../src/index.js";
import { makeScratchRepo, type ScratchRepo } from "./helpers.js";

const NOW = "2026-07-30T19:00:00.000Z";
const HUMAN = "human:repository-owner";

const protocol = [
  "schema_version: 1",
  "kind: ticket_protocol",
  "format: vibehub.ticket-ledger",
  "",
].join("\n");

const ticket = (ticketId: string): TicketDocument => ({
  schema_version: 1,
  kind: "ticket",
  ticket_id: ticketId,
  outcome: `${ticketId} is ready for review.`,
  context: `Execute ${ticketId} from this checked-out repository.`,
  acceptance: [{
    acceptance_id: "reviewable-result",
    criterion: `${ticketId} has a reviewable result.`,
  }],
  constraints: ["Preserve the accepted Ticket boundary."],
  context_refs: [{
    ref: "META/09-ticket-runtime/spec.md",
    purpose: "Ticket Runtime contract",
  }],
  relations: [],
  provenance_refs: ["META/09-ticket-runtime/spec.md"],
});

const writeLedger = (worktreeRoot: string): void => {
  const ledgerRoot = path.join(worktreeRoot, ".vibehub", "tickets");
  const ticketsRoot = path.join(ledgerRoot, "tickets");
  fs.mkdirSync(ticketsRoot, { recursive: true });
  fs.writeFileSync(path.join(ledgerRoot, "protocol.yaml"), protocol);
  fs.writeFileSync(
    path.join(ticketsRoot, "review-surface.yaml"),
    [
      "schema_version: 1",
      "kind: ticket",
      "ticket_id: review-surface",
      "outcome: The Ticket graph is ready for review.",
      "context: Review the graph from the checked-out repository.",
      "acceptance:",
      "  - acceptance_id: reviewable-result",
      "    criterion: The graph has a reviewable result.",
      "constraints:",
      "  - Preserve the accepted Ticket boundary.",
      "context_refs:",
      "  - ref: META/09-ticket-runtime/spec.md",
      "    purpose: Ticket Runtime contract",
      "relations: []",
      "provenance_refs:",
      "  - META/09-ticket-runtime/spec.md",
      "",
    ].join("\n"),
  );
};

const context = (
  requestId: string,
  actor = "agent:planner",
): OperationContext => ({
  repoId: 9_999,
  actor,
  requestId,
  now: NOW,
});

const expectedSource = (snapshot: TicketLedgerSnapshot) => {
  if (snapshot.source.mode !== "worktree") {
    throw new Error("expected a worktree Ticket snapshot");
  }
  return {
    sourceToken: snapshot.source.sourceToken,
    worktreeIdentity: snapshot.source.worktreeIdentity,
    resolvedCommit: snapshot.source.resolvedCommit,
    graphDigest: `sha256:${snapshot.graphDigest}`,
    semanticLedgerDigest: `sha256:${snapshot.semanticLedgerDigest}`,
  };
};

const publicGraphSubject = (snapshot: TicketLedgerSnapshot) => ({
  kind: "graph" as const,
  graphDigest: `sha256:${snapshot.graphDigest}`,
});

const ticketRevision = (
  snapshot: TicketLedgerSnapshot,
  ticketId = "review-surface",
): string => {
  const found = snapshot.tickets.find((candidate) =>
    candidate.document.ticket_id === ticketId);
  if (found === undefined) throw new Error(`missing ${ticketId}`);
  return `sha256:${found.ticketRevision}`;
};

const publicTicketSubject = (snapshot: TicketLedgerSnapshot) => ({
  kind: "ticket" as const,
  ticketId: "review-surface",
  ticketRevision: ticketRevision(snapshot),
});

const reviewInput = (snapshot: TicketLedgerSnapshot) => ({
  expectedSource: expectedSource(snapshot),
  review: {
    type: "comment" as const,
    subject: publicGraphSubject(snapshot),
    body: "The graph is coherent and ready for review.",
  },
});

const receiptCount = (db: Db): number =>
  (db.prepare(
    `SELECT COUNT(*) count FROM operation_request_receipts
     WHERE operation IN ('ticket.review.append','ticket.decision.record')`,
  ).get() as { count: number }).count;

describe("Ticket intervention operation dispatcher", () => {
  const repos: ScratchRepo[] = [];
  const dbs: Db[] = [];

  afterEach(() => {
    dbs.splice(0).forEach((db) => db.close());
    repos.splice(0).forEach((repo) => repo.cleanup());
  });

  const setup = (options: ConstructorParameters<
    typeof OperationDispatcher
  >[1] = {}) => {
    const repo = makeScratchRepo();
    repos.push(repo);
    writeLedger(repo.work);
    const db = openDb(path.join(repo.root, "operational.sqlite"));
    dbs.push(db);
    return {
      repo,
      db,
      dispatcher: new OperationDispatcher(db, {
        repoRoot: repo.work,
        ...options,
      }),
    };
  };

  it("appends an Agent-claimed review without a SQLite receipt", () => {
    const { repo, db, dispatcher } = setup();
    const before = loadTicketLedgerFromWorktree(repo.work);

    expect(dispatcher.dispatch(
      "ticket.review.append",
      context("agent-comment"),
      reviewInput(before),
    )).toMatchObject({
      ok: true,
      data: {
        status: "applied",
        review: {
          document: {
            kind: "ticket_review",
            review_type: "comment",
            subject: {
              kind: "graph",
              graph_digest: before.graphDigest,
            },
            observed: {
              resolved_commit: before.source.resolvedCommit,
              graph_digest: before.graphDigest,
            },
            author: {
              actor_id: "agent:planner",
              actor_kind: "agent",
              attribution: "claimed",
            },
          },
        },
      },
    });

    const after = loadTicketLedgerFromWorktree(repo.work);
    expect(after.reviews).toHaveLength(1);
    expect(after.decisions).toHaveLength(0);
    expect(receiptCount(db)).toBe(0);
  });

  it("fails closed without Decision authority and performs no durable write", () => {
    const { repo, db, dispatcher } = setup();
    const before = loadTicketLedgerFromWorktree(repo.work);

    expect(dispatcher.dispatch(
      "ticket.decision.record",
      context("decision-without-authority", HUMAN),
      {
        expectedSource: expectedSource(before),
        decision: {
          type: "plan_review",
          subject: publicGraphSubject(before),
          disposition: "approve_execution",
          rationale: "The reviewed plan is ready to execute.",
          resolutionRefs: [],
        },
      },
    )).toMatchObject({
      ok: false,
      error: { code: "ticket_authority_unavailable" },
    });

    const after = loadTicketLedgerFromWorktree(repo.work);
    expect(after.source.sourceToken).toBe(before.source.sourceToken);
    expect(after.reviews).toHaveLength(0);
    expect(after.decisions).toHaveLength(0);
    expect(receiptCount(db)).toBe(0);
  });

  it("uses trusted host attribution and an exact protected-boundary authority grant", () => {
    const provisional = setup();
    const before = loadTicketLedgerFromWorktree(provisional.repo.work);
    const ticketSubject = publicTicketSubject(before);
    const boundary = "Choose the user-visible recovery behavior.";
    const trustedOptions = {
      repoRoot: provisional.repo.work,
      ticketReviewAttribution: {
        actorId: HUMAN,
        actorKind: "human" as const,
        attribution: "host_attested" as const,
      },
      ticketDecisionAuthority: {
        authority: {
          principal_id: HUMAN,
          principal_kind: "human" as const,
          basis: "repository_owner" as const,
          basis_ref: "local-review-host:test",
          attestation: "host_bound_local" as const,
        },
        scopes: [{
          decisionType: "protected_boundary" as const,
          ticketId: ticketSubject.ticketId,
          ticketRevision: ticketSubject.ticketRevision,
          boundary,
        }],
      },
    };
    const dispatcher = new OperationDispatcher(
      provisional.db,
      trustedOptions,
    );

    expect(dispatcher.dispatch(
      "ticket.review.append",
      context("human-comment", HUMAN),
      {
        expectedSource: expectedSource(before),
        review: {
          type: "comment",
          subject: ticketSubject,
          body: "This protected boundary needs an explicit selection.",
        },
      },
    )).toMatchObject({
      ok: true,
      data: {
        review: {
          document: {
            subject: {
              kind: "ticket",
              ticket_id: "review-surface",
              ticket_revision: before.tickets[0]?.ticketRevision,
            },
            author: {
              actor_id: HUMAN,
              actor_kind: "human",
              attribution: "host_attested",
            },
          },
        },
      },
    });

    const afterReview = loadTicketLedgerFromWorktree(provisional.repo.work);
    expect(dispatcher.dispatch(
      "ticket.decision.record",
      context("human-decision", HUMAN),
      {
        expectedSource: expectedSource(afterReview),
        decision: {
          type: "protected_boundary",
          subject: publicTicketSubject(afterReview),
          boundary,
          disposition: "resolve",
          selection: "Keep the draft in place and show the stale conflict.",
          rationale: "The user must not lose an in-progress edit.",
          resolutionRefs: [afterReview.reviews[0]!.documentPath],
        },
      },
    )).toMatchObject({
      ok: true,
      data: {
        status: "applied",
        decision: {
          document: {
            decision_type: "protected_boundary",
            subject: {
              kind: "ticket",
              ticket_id: "review-surface",
              ticket_revision: before.tickets[0]?.ticketRevision,
            },
            boundary,
            authority: {
              principal_id: HUMAN,
              principal_kind: "human",
              attestation: "host_bound_local",
            },
          },
        },
      },
    });

    const afterDecision = loadTicketLedgerFromWorktree(provisional.repo.work);
    expect(afterDecision.reviews).toHaveLength(1);
    expect(afterDecision.decisions).toHaveLength(1);
    expect(receiptCount(provisional.db)).toBe(0);

    const liveGraph = dispatcher.dispatch(
      "ticket.graph.snapshot",
      context("live-graph", HUMAN),
      {},
    );
    if (!liveGraph.ok) throw new Error(JSON.stringify(liveGraph));
    const liveSnapshotId = (liveGraph.data as { snapshotId: string })
      .snapshotId;
    const liveTrace = dispatcher.dispatch(
      "ticket.trace.list",
      context("live-trace", HUMAN),
      {
        snapshotId: liveSnapshotId,
        subject: { kind: "ticket", ticketId: "review-surface" },
      },
    );
    if (!liveTrace.ok) throw new Error(JSON.stringify(liveTrace));
    expect((liveTrace.data as { records: unknown[] }).records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "gate_decision",
          status: "current",
          producer: expect.objectContaining({
            kind: "authority_receipt",
          }),
        }),
      ]),
    );

    const restarted = new OperationDispatcher(
      provisional.db,
      trustedOptions,
    );
    const restartedGraph = restarted.dispatch(
      "ticket.graph.snapshot",
      context("restarted-graph", HUMAN),
      {},
    );
    if (!restartedGraph.ok) {
      throw new Error(JSON.stringify(restartedGraph));
    }
    const restartedSnapshotId = (restartedGraph.data as {
      snapshotId: string;
    }).snapshotId;
    const restartedTrace = restarted.dispatch(
      "ticket.trace.list",
      context("restarted-trace", HUMAN),
      {
        snapshotId: restartedSnapshotId,
        subject: { kind: "ticket", ticketId: "review-surface" },
      },
    );
    if (!restartedTrace.ok) {
      throw new Error(JSON.stringify(restartedTrace));
    }
    expect((restartedTrace.data as { records: unknown[] }).records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "artifact",
          status: "current_unverified",
          producer: expect.objectContaining({ kind: "receipt" }),
        }),
      ]),
    );

    expect(restarted.dispatch(
      "ticket.decision.record",
      context("explicit-reattest", HUMAN),
      {
        expectedSource: expectedSource(afterDecision),
        decision: {
          type: "protected_boundary",
          subject: publicTicketSubject(afterDecision),
          boundary,
          disposition: "resolve",
          selection: "Keep the draft in place and show the stale conflict.",
          rationale: "The user must not lose an in-progress edit.",
          resolutionRefs: [afterDecision.reviews[0]!.documentPath],
        },
      },
    )).toMatchObject({
      ok: true,
      data: {
        status: "noop",
        changedPaths: [],
      },
    });
    const reattestedGraph = restarted.dispatch(
      "ticket.graph.snapshot",
      context("reattested-graph", HUMAN),
      {},
    );
    if (!reattestedGraph.ok) {
      throw new Error(JSON.stringify(reattestedGraph));
    }
    const reattestedSnapshotId = (reattestedGraph.data as {
      snapshotId: string;
    }).snapshotId;
    expect(reattestedSnapshotId).not.toBe(restartedSnapshotId);
    const reattestedTrace = restarted.dispatch(
      "ticket.trace.list",
      context("reattested-trace", HUMAN),
      {
        snapshotId: reattestedSnapshotId,
        subject: { kind: "ticket", ticketId: "review-surface" },
      },
    );
    if (!reattestedTrace.ok) {
      throw new Error(JSON.stringify(reattestedTrace));
    }
    expect((reattestedTrace.data as { records: unknown[] }).records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "gate_decision",
          status: "current",
          producer: expect.objectContaining({
            kind: "authority_receipt",
          }),
        }),
      ]),
    );
  });

  it.each([
    ["author", { author: { actorId: "forged" } }],
    ["authority", { authority: { principalId: "forged" } }],
    ["review ID", { reviewId: "trv-".concat("0".repeat(64)) }],
    ["unknown field", { browserOnly: true }],
  ])("rejects a public %s field before writing", (_label, injected) => {
    const { repo, dispatcher } = setup();
    const before = loadTicketLedgerFromWorktree(repo.work);
    const base = reviewInput(before);

    expect(dispatcher.dispatch(
      "ticket.review.append",
      context(`forged-${_label}`),
      { ...base, ...injected },
    )).toMatchObject({
      ok: false,
      error: { code: "validation_error" },
    });
    expect(loadTicketLedgerFromWorktree(repo.work).reviews).toHaveLength(0);
  });

  it("rejects a Decision outside the trusted exact graph scope", () => {
    const { repo, db } = setup();
    const before = loadTicketLedgerFromWorktree(repo.work);
    const dispatcher = new OperationDispatcher(db, {
      repoRoot: repo.work,
      ticketDecisionAuthority: {
        authority: {
          principal_id: HUMAN,
          principal_kind: "human",
          basis: "designated_human",
          basis_ref: "local-review-host:test",
          attestation: "host_bound_local",
        },
        scopes: [{
          decisionType: "plan_review",
          graphDigest: `sha256:${"0".repeat(64)}`,
        }],
      },
    });

    expect(dispatcher.dispatch(
      "ticket.decision.record",
      context("out-of-scope-decision", HUMAN),
      {
        expectedSource: expectedSource(before),
        decision: {
          type: "plan_review",
          subject: publicGraphSubject(before),
          disposition: "request_changes",
          rationale: "The exact reviewed graph still needs changes.",
          resolutionRefs: [],
        },
      },
    )).toMatchObject({
      ok: false,
      error: { code: "ticket_authority_scope_mismatch" },
    });
    expect(loadTicketLedgerFromWorktree(repo.work).decisions).toHaveLength(0);
    expect(receiptCount(db)).toBe(0);
  });

  it("rejects nested public identity and authority claims", () => {
    const { repo, dispatcher } = setup();
    const before = loadTicketLedgerFromWorktree(repo.work);
    const base = reviewInput(before);
    const forged = [
      {
        ...base,
        review: {
          ...base.review,
          author: { actorId: "forged" },
        },
      },
      {
        ...base,
        review: {
          ...base.review,
          id: "trv-".concat("0".repeat(64)),
        },
      },
    ];

    for (const [index, input] of forged.entries()) {
      expect(dispatcher.dispatch(
        "ticket.review.append",
        context(`nested-forgery-${index}`),
        input,
      )).toMatchObject({
        ok: false,
        error: { code: "validation_error" },
      });
    }
    expect(loadTicketLedgerFromWorktree(repo.work).reviews).toHaveLength(0);
  });

  it("keeps source and subject conversion exact for a ticket edit proposal", () => {
    const { repo, dispatcher } = setup();
    const before = loadTicketLedgerFromWorktree(repo.work);
    const subject = publicTicketSubject(before);
    const replacement = ticket("review-surface");

    expect(dispatcher.dispatch(
      "ticket.review.append",
      context("ticket-edit"),
      {
        expectedSource: expectedSource(before),
        review: {
          type: "ticket_edit",
          subject,
          body: "Make the executable package more explicit.",
          replacementTicket: replacement,
          rationale: "A fresh Agent needs the complete execution boundary.",
        },
      },
    )).toMatchObject({
      ok: true,
      data: {
        review: {
          document: {
            review_type: "ticket_edit",
            subject: {
              kind: "ticket",
              ticket_id: subject.ticketId,
              ticket_revision: before.tickets[0]?.ticketRevision,
            },
            expected_ticket_revision: before.tickets[0]?.ticketRevision,
            replacement_ticket: replacement,
            observed: {
              resolved_commit: before.source.resolvedCommit,
              graph_digest: before.graphDigest,
            },
          },
        },
      },
    });
  });
});
