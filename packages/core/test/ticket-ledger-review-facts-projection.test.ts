import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as corePublic from "../src/index.js";
import {
  appendTicketReview,
  applyTicketWorktreePatch,
  inspectTicketReviewSubjectV0,
  listTicketReviewTraceV0,
  loadTicketLedgerFromWorktree,
  projectTicketGraphSnapshotV0,
  projectTicketLedgerForReview,
  recordTicketDecision,
  ticketRelationId,
  type TicketDecisionAuthorityContext,
  type TicketDocument,
  type TicketLedgerPatchExpectedSource,
  type TicketLedgerSnapshot,
  type TicketReviewAuthorContext,
  type TicketReviewSubject,
} from "../src/index.js";
import {
  InMemoryTicketDecisionSessionAttestationRegistryV0,
  projectTicketLedgerForTrustedDecisionHostV0,
} from "../src/ticket-decision-attestation.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ticket Projection Test",
      GIT_AUTHOR_EMAIL: "ticket-projection@example.test",
      GIT_COMMITTER_NAME: "Ticket Projection Test",
      GIT_COMMITTER_EMAIL: "ticket-projection@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });

const ticketDocument = (
  ticketId: string,
  outcome: string,
  dependencies: string[] = [],
): TicketDocument => ({
  schema_version: 1,
  kind: "ticket",
  ticket_id: ticketId,
  outcome,
  context: `Execute ${ticketId} from the checked-out repository.`,
  acceptance: [{
    acceptance_id: "observable-result",
    criterion: `${ticketId} produces its observable result.`,
  }],
  constraints: ["Preserve unrelated worktree changes."],
  context_refs: [{
    ref: "META/09-ticket-runtime/spec.md",
    purpose: "Ticket Runtime authority",
  }],
  relations: dependencies.map((target_ticket_id) => ({
    type: "depends_on",
    target_ticket_id,
  })),
  provenance_refs: ["META/09-ticket-runtime/spec.md"],
});

const expectedSource = (
  snapshot: TicketLedgerSnapshot,
): TicketLedgerPatchExpectedSource => {
  if (snapshot.source.mode !== "worktree") {
    throw new Error("expected a worktree snapshot");
  }
  return {
    sourceToken: snapshot.source.sourceToken,
    worktreeIdentity: snapshot.source.worktreeIdentity,
    resolvedCommit: snapshot.source.resolvedCommit,
    graphDigest: `sha256:${snapshot.graphDigest}`,
    semanticLedgerDigest: `sha256:${snapshot.semanticLedgerDigest}`,
  };
};

const graphSubject = (
  snapshot: TicketLedgerSnapshot,
): Extract<TicketReviewSubject, { kind: "graph" }> => ({
  kind: "graph",
  graph_digest: snapshot.graphDigest,
});

const ticketSubject = (
  snapshot: TicketLedgerSnapshot,
  ticketId: string,
): Extract<TicketReviewSubject, { kind: "ticket" }> => {
  const ticket = snapshot.tickets.find((candidate) =>
    candidate.document.ticket_id === ticketId);
  if (ticket === undefined) throw new Error(`missing Ticket ${ticketId}`);
  return {
    kind: "ticket",
    ticket_id: ticketId,
    ticket_revision: ticket.ticketRevision,
  };
};

const relationSubject = (
  snapshot: TicketLedgerSnapshot,
  dependentTicketId: string,
): Extract<TicketReviewSubject, { kind: "relation" }> => {
  const dependent = snapshot.tickets.find((candidate) =>
    candidate.document.ticket_id === dependentTicketId);
  const relation = dependent?.document.relations[0];
  if (dependent === undefined || relation === undefined) {
    throw new Error(`missing relation for ${dependentTicketId}`);
  }
  return {
    kind: "relation",
    relation_ref: ticketRelationId(dependentTicketId, relation),
    prerequisite_ticket_id: relation.target_ticket_id,
    dependent_ticket_id: dependentTicketId,
    dependent_ticket_revision: dependent.ticketRevision,
  };
};

const ticketRevisions = (
  snapshot: TicketLedgerSnapshot,
): Record<string, string> =>
  Object.fromEntries(snapshot.tickets.map((ticket) => [
    ticket.document.ticket_id,
    ticket.ticketRevision,
  ]));

const author: TicketReviewAuthorContext = {
  actor_id: "local-reviewer",
  actor_kind: "human",
  attribution: "host_attested",
};

const authority: TicketDecisionAuthorityContext = {
  principal_id: "repository-owner",
  principal_kind: "human",
  basis: "repository_owner",
  basis_ref: "local-host:projection-test",
  attestation: "host_bound_local",
};

const setup = (): string => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), "vibehub-ticket-review-projection-"),
  );
  git(repository, "init", "-b", "main");
  fs.writeFileSync(path.join(repository, "README.md"), "# fixture\n");
  const ledgerRoot = path.join(repository, ".vibehub", "tickets");
  fs.mkdirSync(ledgerRoot, { recursive: true });
  fs.writeFileSync(path.join(ledgerRoot, "protocol.yaml"), [
    "schema_version: 1",
    "kind: ticket_protocol",
    "format: vibehub.ticket-ledger",
    "",
  ].join("\n"));
  git(repository, "add", "-A");
  git(repository, "commit", "-m", "seed review projection fixture");

  const empty = loadTicketLedgerFromWorktree(repository);
  applyTicketWorktreePatch({
    worktreeRoot: repository,
    request: {
      expectedSource: expectedSource(empty),
      changes: [
        {
          op: "put",
          ticketId: "design-schema",
          expectedTicketRevision: null,
          document: ticketDocument(
            "design-schema",
            "Freeze the database schema",
          ),
        },
        {
          op: "put",
          ticketId: "implement-api",
          expectedTicketRevision: null,
          document: ticketDocument(
            "implement-api",
            "Expose the API",
            ["design-schema"],
          ),
        },
      ],
    },
  });
  return repository;
};

describe("Git review facts projected into Ticket review traces", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects comment, edit, plan, protected, and relation facts at their exact loci without changing the Ticket graph", () => {
    const repository = setup();
    roots.push(repository);
    const initial = loadTicketLedgerFromWorktree(repository);
    const initialSource = projectTicketLedgerForReview(initial);
    const initialGraph = projectTicketGraphSnapshotV0(initialSource);
    const initialRevisions = ticketRevisions(initial);

    const graphComment = appendTicketReview({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(initial),
        review: {
          review_type: "comment",
          subject: graphSubject(initial),
          body: "The graph is coherent.",
        },
      },
      author,
      occurredAt: "2026-07-30T18:00:00.000Z",
    });
    const afterGraphComment = loadTicketLedgerFromWorktree(repository);
    const edit = appendTicketReview({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(afterGraphComment),
        review: {
          review_type: "ticket_edit",
          subject: ticketSubject(afterGraphComment, "implement-api"),
          body: "Clarify the compatibility boundary.",
          replacement_ticket: ticketDocument(
            "implement-api",
            "Expose the stable API",
            ["design-schema"],
          ),
          rationale: "The executable package should name the stable API.",
        },
      },
      author,
      occurredAt: "2026-07-30T18:01:00.000Z",
    });
    const afterEdit = loadTicketLedgerFromWorktree(repository);
    const plan = recordTicketDecision({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(afterEdit),
        decision: {
          decision_type: "plan_review",
          subject: graphSubject(afterEdit),
          disposition: "delegate_within_boundaries",
          delegated_boundaries: ["Implement only the reviewed graph."],
          rationale: "The exact plan is ready for bounded execution.",
          resolution_refs: [graphComment.review.documentPath],
        },
      },
      authority,
      decidedAt: "2026-07-30T18:02:00.000Z",
    });
    const afterPlan = loadTicketLedgerFromWorktree(repository);
    const protectedDecision = recordTicketDecision({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(afterPlan),
        decision: {
          decision_type: "protected_boundary",
          subject: ticketSubject(afterPlan, "implement-api"),
          boundary: "Select the public API compatibility policy.",
          disposition: "resolve",
          selection: "Preserve backwards compatibility.",
          rationale: "This product boundary requires human intent.",
          resolution_refs: [edit.review.documentPath],
        },
      },
      authority,
      decidedAt: "2026-07-30T18:03:00.000Z",
    });
    const afterProtected = loadTicketLedgerFromWorktree(repository);
    const relationComment = appendTicketReview({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(afterProtected),
        review: {
          review_type: "comment",
          subject: relationSubject(afterProtected, "implement-api"),
          body: "The schema must unlock the API implementation.",
        },
      },
      author,
      occurredAt: "2026-07-30T18:04:00.000Z",
    });

    const final = loadTicketLedgerFromWorktree(repository);
    const source = projectTicketLedgerForReview(final);
    const graph = projectTicketGraphSnapshotV0(source);
    const relationRef = relationSubject(
      final,
      "implement-api",
    ).relation_ref;

    expect(final.graphDigest).toBe(initial.graphDigest);
    expect(ticketRevisions(final)).toEqual(initialRevisions);
    expect(graph.topologyDigest).toBe(initialGraph.topologyDigest);
    expect(graph.snapshotId).not.toBe(initialGraph.snapshotId);
    expect(graph.projectionWatermark)
      .not.toBe(initialGraph.projectionWatermark);

    const graphInspection = inspectTicketReviewSubjectV0(source, {
      snapshotId: graph.snapshotId,
      subject: { kind: "graph" },
    });
    expect(graphInspection.subject).toMatchObject({
      kind: "graph",
      traceCount: 2,
    });
    const graphTrace = listTicketReviewTraceV0(source, {
      snapshotId: graph.snapshotId,
      subject: { kind: "graph" },
    });
    expect(graphTrace.records.map((record) => record.recordRef))
      .toEqual(expect.arrayContaining([
        graphComment.review.document.review_id,
        plan.decision.document.decision_id,
      ]));
    expect(graphTrace.records.find((record) =>
      record.recordRef === plan.decision.document.decision_id))
      .toMatchObject({
        kind: "artifact",
        subkind: "plan_review",
        status: "current_unverified",
        producer: { kind: "receipt" },
        decision: {
          decisionType: "plan_review",
          disposition: "delegate_within_boundaries",
          delegatedBoundaries: ["Implement only the reviewed graph."],
          resolutionRefs: [graphComment.review.documentPath],
        },
      });

    const ticketTrace = listTicketReviewTraceV0(source, {
      snapshotId: graph.snapshotId,
      subject: { kind: "ticket", ticketId: "implement-api" },
    });
    expect(ticketTrace.records.map((record) => record.recordRef))
      .toEqual(expect.arrayContaining([
        edit.review.document.review_id,
        protectedDecision.decision.document.decision_id,
      ]));
    expect(ticketTrace.records.find((record) =>
      record.recordRef === edit.review.document.review_id))
      .toMatchObject({
        subkind: "ticket_edit",
        status: "current_host_attested",
      });
    expect(ticketTrace.records.find((record) =>
      record.recordRef === protectedDecision.decision.document.decision_id))
      .toMatchObject({
        kind: "artifact",
        subkind: "protected_boundary",
        status: "current_unverified",
        producer: { kind: "receipt" },
        decision: {
          decisionType: "protected_boundary",
          boundary: "Select the public API compatibility policy.",
          disposition: "resolve",
          selection: "Preserve backwards compatibility.",
          resolutionRefs: [edit.review.documentPath],
        },
      });

    const relationTrace = listTicketReviewTraceV0(source, {
      snapshotId: graph.snapshotId,
      subject: { kind: "relation", relationRef },
    });
    expect(relationTrace.records).toEqual([
      expect.objectContaining({
        recordRef: relationComment.review.document.review_id,
        subkind: "comment",
        status: "current_host_attested",
      }),
    ]);
  });

  it("makes Ticket and relation facts historical when the dependent Ticket revision changes", () => {
    const repository = setup();
    roots.push(repository);
    const initial = loadTicketLedgerFromWorktree(repository);
    const protectedDecision = recordTicketDecision({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(initial),
        decision: {
          decision_type: "protected_boundary",
          subject: ticketSubject(initial, "implement-api"),
          boundary: "Select the API compatibility policy.",
          disposition: "resolve",
          selection: "Preserve backwards compatibility.",
          rationale: "Human intent is required.",
          resolution_refs: [],
        },
      },
      authority,
      decidedAt: "2026-07-30T19:00:00.000Z",
    });
    const afterDecision = loadTicketLedgerFromWorktree(repository);
    const relationComment = appendTicketReview({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(afterDecision),
        review: {
          review_type: "comment",
          subject: relationSubject(afterDecision, "implement-api"),
          body: "This unlock is correct for the current dependent revision.",
        },
      },
      author,
      occurredAt: "2026-07-30T19:01:00.000Z",
    });
    const beforeRevision = loadTicketLedgerFromWorktree(repository);
    const currentSource = projectTicketLedgerForReview(beforeRevision);
    const currentGraph = projectTicketGraphSnapshotV0(currentSource);
    const relationRef = relationSubject(
      beforeRevision,
      "implement-api",
    ).relation_ref;

    expect(listTicketReviewTraceV0(currentSource, {
      snapshotId: currentGraph.snapshotId,
      subject: { kind: "ticket", ticketId: "implement-api" },
    }).records[0]).toMatchObject({
      recordRef: protectedDecision.decision.document.decision_id,
      kind: "artifact",
      status: "current_unverified",
      producer: { kind: "receipt" },
    });
    expect(listTicketReviewTraceV0(currentSource, {
      snapshotId: currentGraph.snapshotId,
      subject: { kind: "relation", relationRef },
    }).records[0]).toMatchObject({
      recordRef: relationComment.review.document.review_id,
      status: "current_host_attested",
    });

    applyTicketWorktreePatch({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(beforeRevision),
        changes: [{
          op: "put",
          ticketId: "implement-api",
          expectedTicketRevision: `sha256:${
            ticketSubject(beforeRevision, "implement-api").ticket_revision
          }`,
          document: ticketDocument(
            "implement-api",
            "Expose the revised stable API",
            ["design-schema"],
          ),
        }],
      },
    });

    const revised = loadTicketLedgerFromWorktree(repository);
    const revisedSource = projectTicketLedgerForReview(revised);
    const revisedGraph = projectTicketGraphSnapshotV0(revisedSource);
    expect(revisedGraph.topologyDigest).toBe(currentGraph.topologyDigest);

    expect(listTicketReviewTraceV0(revisedSource, {
      snapshotId: revisedGraph.snapshotId,
      subject: { kind: "ticket", ticketId: "implement-api" },
    }).records[0]).toMatchObject({
      recordRef: protectedDecision.decision.document.decision_id,
      kind: "artifact",
      status: "historical",
      producer: { kind: "receipt" },
    });
    expect(listTicketReviewTraceV0(revisedSource, {
      snapshotId: revisedGraph.snapshotId,
      subject: { kind: "relation", relationRef },
    }).records[0]).toMatchObject({
      recordRef: relationComment.review.document.review_id,
      status: "historical_host_attested",
    });
  });

  it("requires an exact live host-session attestation before a current Decision becomes a gate", () => {
    expect(corePublic).not.toHaveProperty(
      "InMemoryTicketDecisionSessionAttestationRegistryV0",
    );
    expect(corePublic).not.toHaveProperty(
      "projectTicketLedgerForTrustedDecisionHostV0",
    );
    expect(corePublic).not.toHaveProperty(
      "createTrustedTicketLedgerReviewProjectionSourceProviderV0",
    );
    const repository = setup();
    roots.push(repository);
    const initial = loadTicketLedgerFromWorktree(repository);
    const recorded = recordTicketDecision({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(initial),
        decision: {
          decision_type: "protected_boundary",
          subject: ticketSubject(initial, "implement-api"),
          boundary: "Select the API compatibility policy.",
          disposition: "resolve",
          selection: "Preserve backwards compatibility.",
          rationale: "Human intent is required.",
          resolution_refs: [],
        },
      },
      authority,
      decidedAt: "2026-07-30T19:00:00.000Z",
    });
    const snapshot = loadTicketLedgerFromWorktree(repository);
    const decision = snapshot.decisions.find((candidate) =>
      candidate.documentPath === recorded.decision.documentPath);
    if (decision === undefined) throw new Error("missing recorded Decision");

    let now = 1_000;
    const attestations =
      new InMemoryTicketDecisionSessionAttestationRegistryV0({
        now: () => now,
        ttlMs: 100,
      });
    expect(attestations.attest(snapshot, decision)).toBe(true);

    const trace = (
      candidate: TicketLedgerSnapshot,
      registry = attestations,
    ) => {
      const source = projectTicketLedgerForTrustedDecisionHostV0(
        candidate,
        registry,
      );
      const graph = projectTicketGraphSnapshotV0(source);
      return listTicketReviewTraceV0(source, {
        snapshotId: graph.snapshotId,
        subject: { kind: "ticket", ticketId: "implement-api" },
      }).records.find((record) =>
        record.recordRef === decision.document.decision_id);
    };

    expect(trace(snapshot)).toMatchObject({
      kind: "gate_decision",
      status: "current",
      producer: { kind: "authority_receipt" },
    });

    const tampered = {
      ...snapshot,
      decisions: snapshot.decisions.map((candidate) =>
        candidate.documentPath === decision.documentPath
          ? {
              ...candidate,
              document: {
                ...candidate.document,
                rationale: "A repository writer changed this rationale.",
              },
            }
          : candidate),
    } satisfies TicketLedgerSnapshot;
    expect(
      new InMemoryTicketDecisionSessionAttestationRegistryV0()
        .attest(tampered, decision),
    ).toBe(false);
    expect(trace(tampered)).toMatchObject({
      kind: "artifact",
      status: "current_unverified",
      producer: { kind: "receipt" },
    });

    if (snapshot.source.mode !== "worktree") {
      throw new Error("expected worktree source");
    }
    const otherBranch = {
      ...snapshot,
      source: {
        ...snapshot.source,
        branch: "other-review-branch",
      },
    } satisfies TicketLedgerSnapshot;
    expect(trace(otherBranch)).toMatchObject({
      kind: "artifact",
      status: "current_unverified",
    });
    const otherWorktree = {
      ...snapshot,
      source: {
        ...snapshot.source,
        worktreeIdentity: `worktree-${"0".repeat(64)}`,
      },
    } satisfies TicketLedgerSnapshot;
    expect(trace(otherWorktree)).toMatchObject({
      kind: "artifact",
      status: "current_unverified",
    });

    now = 1_100;
    expect(trace(snapshot)).toMatchObject({
      kind: "artifact",
      status: "current_unverified",
      producer: { kind: "receipt" },
    });
    expect(trace(
      snapshot,
      new InMemoryTicketDecisionSessionAttestationRegistryV0(),
    )).toMatchObject({
      kind: "artifact",
      status: "current_unverified",
    });
  });

  it("retreats facts whose Ticket locus was deleted to the graph trace", () => {
    const repository = setup();
    roots.push(repository);
    const initial = loadTicketLedgerFromWorktree(repository);
    const comment = appendTicketReview({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(initial),
        review: {
          review_type: "comment",
          subject: ticketSubject(initial, "implement-api"),
          body: "Keep this historical review discoverable.",
        },
      },
      author,
      occurredAt: "2026-07-30T20:00:00.000Z",
    });
    const withComment = loadTicketLedgerFromWorktree(repository);
    applyTicketWorktreePatch({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(withComment),
        changes: [{
          op: "delete",
          ticketId: "implement-api",
          expectedTicketRevision: `sha256:${
            ticketSubject(withComment, "implement-api").ticket_revision
          }`,
        }],
      },
    });

    const deleted = loadTicketLedgerFromWorktree(repository);
    const source = projectTicketLedgerForReview(deleted);
    const graph = projectTicketGraphSnapshotV0(source);
    expect(listTicketReviewTraceV0(source, {
      snapshotId: graph.snapshotId,
      subject: { kind: "graph" },
    }).records).toEqual([
      expect.objectContaining({
        recordRef: comment.review.document.review_id,
        status: "historical_host_attested",
      }),
    ]);
  });
});
