import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitFacade,
  TICKET_LEDGER_RELATIVE_PATH,
  TicketLedgerError,
  appendTicketReview,
  applyTicketWorktreePatch,
  commitTicketCheckpoint,
  loadTicketLedgerAtRef,
  loadTicketLedgerFromWorktree,
  prepareTicketCheckpoint,
  recordTicketDecision,
  type TicketDecisionAuthorityContext,
  type TicketDocument,
  type TicketLedgerPatchExpectedSource,
  type TicketLedgerSnapshot,
  type TicketReviewAuthorContext,
  type TicketReviewSubject,
} from "../src/index.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ticket Intervention Writer Test",
      GIT_AUTHOR_EMAIL: "ticket-intervention@example.test",
      GIT_COMMITTER_NAME: "Ticket Intervention Writer Test",
      GIT_COMMITTER_EMAIL: "ticket-intervention@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });

const document = (
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
    throw new Error("expected worktree snapshot");
  }
  return {
    sourceToken: snapshot.source.sourceToken,
    worktreeIdentity: snapshot.source.worktreeIdentity,
    resolvedCommit: snapshot.source.resolvedCommit,
    graphDigest: `sha256:${snapshot.graphDigest}`,
    semanticLedgerDigest: `sha256:${snapshot.semanticLedgerDigest}`,
  };
};

const ticketSubject = (
  snapshot: TicketLedgerSnapshot,
  ticketId: string,
): Extract<TicketReviewSubject, { kind: "ticket" }> => {
  const ticket = snapshot.tickets.find((candidate) =>
    candidate.document.ticket_id === ticketId);
  if (ticket === undefined) throw new Error(`missing ${ticketId}`);
  return {
    kind: "ticket",
    ticket_id: ticketId,
    ticket_revision: ticket.ticketRevision,
  };
};

const graphSubject = (
  snapshot: TicketLedgerSnapshot,
): Extract<TicketReviewSubject, { kind: "graph" }> => ({
  kind: "graph",
  graph_digest: snapshot.graphDigest,
});

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
  basis_ref: "local-host:test",
  attestation: "host_bound_local",
};

const setup = (): string => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), "vibehub-ticket-intervention-writer-"),
  );
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Ticket Intervention Writer Test");
  git(
    repository,
    "config",
    "user.email",
    "ticket-intervention@example.test",
  );
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
  git(repository, "commit", "-m", "seed Ticket intervention fixture");

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
          document: document("design-schema", "Freeze the schema"),
        },
        {
          op: "put",
          ticketId: "implement-api",
          expectedTicketRevision: null,
          document: document(
            "implement-api",
            "Expose the API",
            ["design-schema"],
          ),
        },
      ],
    },
  });
  git(repository, "add", TICKET_LEDGER_RELATIVE_PATH);
  git(repository, "commit", "-m", "seed canonical Ticket graph");
  return repository;
};

const expectCode = (
  callback: () => unknown,
  code: TicketLedgerError["code"],
): void => {
  try {
    callback();
    throw new Error("expected TicketLedgerError");
  } catch (error) {
    expect(error).toBeInstanceOf(TicketLedgerError);
    expect((error as TicketLedgerError).code).toBe(code);
  }
};

describe("Ticket review and decision writers", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("appends comment, ticket edit, plan, and protected-boundary facts without changing Ticket identity", () => {
    const repository = setup();
    roots.push(repository);
    const initial = loadTicketLedgerFromWorktree(repository);
    const initialRevisions = ticketRevisions(initial);

    const comment = appendTicketReview({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(initial),
        review: {
          review_type: "comment",
          subject: graphSubject(initial),
          body: "The graph is coherent and ready for a focused review.",
        },
      },
      author,
      occurredAt: "2026-07-30T18:00:00.000Z",
    });
    expect(comment.status).toBe("applied");
    expect(comment.review.document).toMatchObject({
      kind: "ticket_review",
      review_type: "comment",
      author,
    });
    expect(comment.changedPaths).toEqual([
      comment.review.documentPath,
    ]);

    const afterComment = loadTicketLedgerFromWorktree(repository);
    const edit = appendTicketReview({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(afterComment),
        review: {
          review_type: "ticket_edit",
          subject: ticketSubject(afterComment, "implement-api"),
          body: "Make the stability boundary explicit.",
          replacement_ticket: document(
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
    expect(edit.status).toBe("applied");
    expect(edit.review.document).toMatchObject({
      kind: "ticket_review",
      review_type: "ticket_edit",
      expected_ticket_revision:
        ticketSubject(afterComment, "implement-api").ticket_revision,
      replacement_ticket: { outcome: "Expose the stable API" },
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
          rationale: "The plan is sufficiently bounded for execution.",
          resolution_refs: [comment.review.documentPath],
        },
      },
      authority,
      decidedAt: "2026-07-30T18:02:00.000Z",
    });
    expect(plan.status).toBe("applied");
    expect(plan.decision.document).toMatchObject({
      decision_type: "plan_review",
      disposition: "delegate_within_boundaries",
      authority,
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
          rationale: "This product-facing boundary requires human intent.",
          resolution_refs: [edit.review.documentPath],
        },
      },
      authority,
      decidedAt: "2026-07-30T18:03:00.000Z",
    });
    expect(protectedDecision.status).toBe("applied");
    expect(protectedDecision.decision.document).toMatchObject({
      decision_type: "protected_boundary",
      disposition: "resolve",
      selection: "Preserve backwards compatibility.",
      authority,
    });

    const final = loadTicketLedgerFromWorktree(repository);
    expect(final.reviews).toHaveLength(2);
    expect(final.decisions).toHaveLength(2);
    expect(final.graphDigest).toBe(initial.graphDigest);
    expect(ticketRevisions(final)).toEqual(initialRevisions);
    expect(final.semanticLedgerDigest).not.toBe(initial.semanticLedgerDigest);
    expect(final.source.sourceToken).not.toBe(initial.source.sourceToken);

    for (const [before, after] of [
      [initial, afterComment],
      [afterComment, afterEdit],
      [afterEdit, afterPlan],
      [afterPlan, final],
    ] as const) {
      expect(after.graphDigest).toBe(before.graphDigest);
      expect(ticketRevisions(after)).toEqual(ticketRevisions(before));
      expect(after.semanticLedgerDigest).not.toBe(
        before.semanticLedgerDigest,
      );
      expect(after.source.sourceToken).not.toBe(before.source.sourceToken);
    }
  });

  it("rejects stale raw sources and exact Ticket subjects before writing", () => {
    const repository = setup();
    roots.push(repository);
    const base = loadTicketLedgerFromWorktree(repository);
    const staleTicketSubject = ticketSubject(base, "implement-api");

    appendTicketReview({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(base),
        review: {
          review_type: "comment",
          subject: graphSubject(base),
          body: "Advance the physical and semantic source identity.",
        },
      },
      author,
      occurredAt: "2026-07-30T19:00:00.000Z",
    });
    expectCode(
      () => appendTicketReview({
        worktreeRoot: repository,
        request: {
          expectedSource: expectedSource(base),
          review: {
            review_type: "comment",
            subject: graphSubject(base),
            body: "This request still carries the old source token.",
          },
        },
        author,
        occurredAt: "2026-07-30T19:01:00.000Z",
      }),
      "stale_source",
    );

    const current = loadTicketLedgerFromWorktree(repository);
    applyTicketWorktreePatch({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(current),
        changes: [{
          op: "put",
          ticketId: "implement-api",
          expectedTicketRevision:
            `sha256:${staleTicketSubject.ticket_revision}`,
          document: document(
            "implement-api",
            "Expose the revised API",
            ["design-schema"],
          ),
        }],
      },
    });
    const revised = loadTicketLedgerFromWorktree(repository);
    const reviewsBefore = revised.reviews.length;
    expectCode(
      () => appendTicketReview({
        worktreeRoot: repository,
        request: {
          expectedSource: expectedSource(revised),
          review: {
            review_type: "comment",
            subject: staleTicketSubject,
            body: "This comment is bound to an obsolete Ticket revision.",
          },
        },
        author,
        occurredAt: "2026-07-30T19:02:00.000Z",
      }),
      "stale_subject",
    );
    expect(loadTicketLedgerFromWorktree(repository).reviews)
      .toHaveLength(reviewsBefore);
  });

  it("rejects an oversized Decision before creating any semantic path", () => {
    const repository = setup();
    roots.push(repository);
    const base = loadTicketLedgerFromWorktree(repository);
    const decisionsRoot = path.join(
      repository,
      TICKET_LEDGER_RELATIVE_PATH,
      "decisions",
    );

    expectCode(
      () => recordTicketDecision({
        worktreeRoot: repository,
        request: {
          expectedSource: expectedSource(base),
          decision: {
            decision_type: "plan_review",
            subject: graphSubject(base),
            disposition: "delegate_within_boundaries",
            delegated_boundaries: Array.from(
              { length: 10 },
              (_, index) => `${index}:${"x".repeat(7_500)}`,
            ),
            rationale: "The encoded Decision must respect its file limit.",
            resolution_refs: [],
          },
        },
        authority,
        decidedAt: "2026-07-30T19:30:00.000Z",
      }),
      "file_too_large",
    );

    expect(fs.existsSync(decisionsRoot)).toBe(false);
    const after = loadTicketLedgerFromWorktree(repository);
    expect(after.decisions).toEqual([]);
    expect(after.source.sourceToken).toBe(base.source.sourceToken);
    expect(after.semanticLedgerDigest).toBe(base.semanticLedgerDigest);
  });

  it("treats the same decision intent at a different time as a noop and rejects conflicting intent", () => {
    const repository = setup();
    roots.push(repository);
    const base = loadTicketLedgerFromWorktree(repository);
    const decision = {
      decision_type: "plan_review" as const,
      subject: graphSubject(base),
      disposition: "approve_execution" as const,
      rationale: "The exact graph is approved.",
      resolution_refs: [] as string[],
    };
    const first = recordTicketDecision({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(base),
        decision,
      },
      authority,
      decidedAt: "2026-07-30T20:00:00.000Z",
    });
    const afterFirst = loadTicketLedgerFromWorktree(repository);

    const replay = recordTicketDecision({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(afterFirst),
        decision,
      },
      authority,
      decidedAt: "2026-07-30T20:10:00.000Z",
    });
    expect(replay).toMatchObject({
      status: "noop",
      changedPaths: [],
      before: replay.after,
    });
    expect(replay.decision.document.decision_id)
      .toBe(first.decision.document.decision_id);
    expect(replay.decision.document.decided_at)
      .toBe("2026-07-30T20:00:00.000Z");
    expect(loadTicketLedgerFromWorktree(repository).source.sourceToken)
      .toBe(afterFirst.source.sourceToken);

    expectCode(
      () => recordTicketDecision({
        worktreeRoot: repository,
        request: {
          expectedSource: expectedSource(afterFirst),
          decision: {
            ...decision,
            disposition: "request_changes",
            rationale: "The same exact graph now needs revision.",
          },
        },
        authority,
        decidedAt: "2026-07-30T20:20:00.000Z",
      }),
      "document_conflict",
    );
    expect(loadTicketLedgerFromWorktree(repository).decisions)
      .toHaveLength(1);
  });

  it("uses the same per-worktree writer lock as Ticket graph patches", () => {
    const repository = setup();
    roots.push(repository);
    const base = loadTicketLedgerFromWorktree(repository);
    const lockPath = GitFacade.gitPathAt(
      repository,
      "vibehub-ticket-ledger-patch.lock",
    );
    fs.writeFileSync(lockPath, "busy\n");
    try {
      expectCode(
        () => appendTicketReview({
          worktreeRoot: repository,
          request: {
            expectedSource: expectedSource(base),
            review: {
              review_type: "comment",
              subject: graphSubject(base),
              body: "Wait for the shared writer.",
            },
          },
          author,
          occurredAt: "2026-07-30T21:00:00.000Z",
        }),
        "writer_busy",
      );
      expectCode(
        () => applyTicketWorktreePatch({
          worktreeRoot: repository,
          request: {
            expectedSource: expectedSource(base),
            changes: [{
              op: "put",
              ticketId: "blocked-by-review-writer",
              expectedTicketRevision: null,
              document: document(
                "blocked-by-review-writer",
                "Wait for the shared writer",
              ),
            }],
          },
        }),
        "writer_busy",
      );
    } finally {
      fs.unlinkSync(lockPath);
    }
    expect(loadTicketLedgerFromWorktree(repository).source.sourceToken)
      .toBe(base.source.sourceToken);
  });

  it("never replaces a semantic target created by a publisher race", () => {
    const repository = setup();
    roots.push(repository);
    const base = loadTicketLedgerFromWorktree(repository);
    const racedBytes = Buffer.from(
      "concurrent publisher owns these exact bytes\n",
      "utf8",
    );
    const link = fs.linkSync;
    let racedTarget: string | null = null;
    vi.spyOn(fs, "linkSync").mockImplementation((source, target) => {
      racedTarget = String(target);
      fs.writeFileSync(target, racedBytes);
      return link(source, target);
    });

    expectCode(
      () => appendTicketReview({
        worktreeRoot: repository,
        request: {
          expectedSource: expectedSource(base),
          review: {
            review_type: "comment",
            subject: graphSubject(base),
            body: "Do not overwrite a concurrently published document.",
          },
        },
        author,
        occurredAt: "2026-07-30T21:10:00.000Z",
      }),
      "stale_source",
    );
    expect(racedTarget).not.toBeNull();
    expect(fs.readFileSync(racedTarget!)).toEqual(racedBytes);
  });

  it("fails verification after a post-publish external edit and preserves both recovery facts", () => {
    const repository = setup();
    roots.push(repository);
    const base = loadTicketLedgerFromWorktree(repository);
    const protocolPath = path.join(
      repository,
      TICKET_LEDGER_RELATIVE_PATH,
      "protocol.yaml",
    );
    const protocolBefore = fs.readFileSync(protocolPath, "utf8");
    const externalEdit = "# concurrent human formatting\n";
    const link = fs.linkSync;
    let publishedTarget: string | null = null;
    vi.spyOn(fs, "linkSync").mockImplementation((source, target) => {
      const result = link(source, target);
      publishedTarget = String(target);
      fs.appendFileSync(protocolPath, externalEdit);
      return result;
    });

    let thrown: unknown;
    try {
      appendTicketReview({
        worktreeRoot: repository,
        request: {
          expectedSource: expectedSource(base),
          review: {
            review_type: "comment",
            subject: graphSubject(base),
            body: "Keep this complete candidate for explicit recovery.",
          },
        },
        author,
        occurredAt: "2026-07-30T21:20:00.000Z",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TicketLedgerError);
    expect((thrown as TicketLedgerError).code)
      .toBe("write_verification_failed");
    expect((thrown as TicketLedgerError).details).toMatchObject({
      recovery: expect.stringContaining("Inspect"),
    });
    expect(fs.readFileSync(protocolPath, "utf8"))
      .toBe(`${protocolBefore}${externalEdit}`);
    expect(publishedTarget).not.toBeNull();
    expect(fs.existsSync(publishedTarget!)).toBe(true);

    const recovery = loadTicketLedgerFromWorktree(repository);
    expect(recovery.reviews).toHaveLength(1);
    expect(recovery.reviews[0]?.document).toMatchObject({
      kind: "ticket_review",
      review_type: "comment",
      body: "Keep this complete candidate for explicit recovery.",
    });
    expect(fs.realpathSync(path.join(
      repository,
      ...recovery.reviews[0]!.documentPath.split("/"),
    ))).toBe(fs.realpathSync(publishedTarget!));
  });

  it("checkpoints a review-only selection with its semantic digest and preserves unrelated work", () => {
    const repository = setup();
    roots.push(repository);
    git(repository, "switch", "-c", "feat/review-only-checkpoint");
    fs.writeFileSync(
      path.join(repository, "staged-user-work.txt"),
      "keep staged\n",
    );
    git(repository, "add", "staged-user-work.txt");
    fs.appendFileSync(path.join(repository, "README.md"), "keep dirty\n");
    const stagedBefore = git(repository, "diff", "--cached", "--binary");
    const dirtyBefore = fs.readFileSync(
      path.join(repository, "README.md"),
      "utf8",
    );
    const base = loadTicketLedgerFromWorktree(repository);

    const review = appendTicketReview({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(base),
        review: {
          review_type: "comment",
          subject: graphSubject(base),
          body: "Checkpoint this review independently of the Ticket graph.",
        },
      },
      author,
      occurredAt: "2026-07-30T22:00:00.000Z",
    });
    const receipt = prepareTicketCheckpoint({
      repoRoot: repository,
      checkpointSelection: review.checkpointSelection,
    });
    expect(receipt).toMatchObject({
      branch: "feat/review-only-checkpoint",
      graphDigest: review.after.graphDigest,
      semanticLedgerDigest: review.after.semanticLedgerDigest,
      changedPaths: [review.review.documentPath],
    });

    const result = commitTicketCheckpoint({
      repoRoot: repository,
      receipt,
      actor: "agent:codex",
      taskId: "task:review-only-checkpoint",
      requestId: "request:review-only-checkpoint",
      now: "2026-07-30T22:01:00.000Z",
    });
    expect(result).toMatchObject({
      status: "committed",
      graphDigest: receipt.graphDigest,
      semanticLedgerDigest: receipt.semanticLedgerDigest,
      changedPaths: [review.review.documentPath],
    });
    expect(
      git(repository, "show", "--format=", "--name-only", "HEAD").trim(),
    ).toBe(review.review.documentPath);
    expect(git(repository, "show", "-s", "--format=%B", "HEAD")).toContain(
      `VibeHub-Ticket-Semantic-Ledger-Digest: ${receipt.semanticLedgerDigest}`,
    );
    const committed = loadTicketLedgerAtRef(repository, "HEAD");
    expect(`sha256:${committed.semanticLedgerDigest}`)
      .toBe(receipt.semanticLedgerDigest);
    expect(`sha256:${committed.graphDigest}`).toBe(receipt.graphDigest);
    expect(committed.reviews).toHaveLength(1);
    expect(committed.decisions).toHaveLength(0);
    expect(git(repository, "diff", "--cached", "--binary"))
      .toBe(stagedBefore);
    expect(fs.readFileSync(path.join(repository, "README.md"), "utf8"))
      .toBe(dirtyBefore);
  });

  it("checkpoints a decision-only selection with its semantic digest and preserves unrelated work", () => {
    const repository = setup();
    roots.push(repository);
    git(repository, "switch", "-c", "feat/decision-only-checkpoint");
    fs.writeFileSync(
      path.join(repository, "staged-user-work.txt"),
      "keep staged\n",
    );
    git(repository, "add", "staged-user-work.txt");
    fs.appendFileSync(path.join(repository, "README.md"), "keep dirty\n");
    const stagedBefore = git(repository, "diff", "--cached", "--binary");
    const dirtyBefore = fs.readFileSync(
      path.join(repository, "README.md"),
      "utf8",
    );
    const base = loadTicketLedgerFromWorktree(repository);

    const decision = recordTicketDecision({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(base),
        decision: {
          decision_type: "protected_boundary",
          subject: ticketSubject(base, "implement-api"),
          boundary: "Select the compatibility policy.",
          disposition: "resolve",
          selection: "Preserve backwards compatibility.",
          rationale: "Record the human decision as a standalone fact.",
          resolution_refs: [],
        },
      },
      authority,
      decidedAt: "2026-07-30T23:00:00.000Z",
    });
    const receipt = prepareTicketCheckpoint({
      repoRoot: repository,
      checkpointSelection: decision.checkpointSelection,
    });
    expect(receipt).toMatchObject({
      branch: "feat/decision-only-checkpoint",
      graphDigest: decision.after.graphDigest,
      semanticLedgerDigest: decision.after.semanticLedgerDigest,
      changedPaths: [decision.decision.documentPath],
    });

    const result = commitTicketCheckpoint({
      repoRoot: repository,
      receipt,
      actor: "agent:codex",
      taskId: "task:decision-only-checkpoint",
      requestId: "request:decision-only-checkpoint",
      now: "2026-07-30T23:01:00.000Z",
    });
    expect(result).toMatchObject({
      status: "committed",
      graphDigest: receipt.graphDigest,
      semanticLedgerDigest: receipt.semanticLedgerDigest,
      changedPaths: [decision.decision.documentPath],
    });
    expect(
      git(repository, "show", "--format=", "--name-only", "HEAD").trim(),
    ).toBe(decision.decision.documentPath);
    expect(git(repository, "show", "-s", "--format=%B", "HEAD")).toContain(
      `VibeHub-Ticket-Semantic-Ledger-Digest: ${receipt.semanticLedgerDigest}`,
    );
    const committed = loadTicketLedgerAtRef(repository, "HEAD");
    expect(`sha256:${committed.semanticLedgerDigest}`)
      .toBe(receipt.semanticLedgerDigest);
    expect(`sha256:${committed.graphDigest}`).toBe(receipt.graphDigest);
    expect(committed.reviews).toHaveLength(0);
    expect(committed.decisions).toHaveLength(1);
    expect(git(repository, "diff", "--cached", "--binary"))
      .toBe(stagedBefore);
    expect(fs.readFileSync(path.join(repository, "README.md"), "utf8"))
      .toBe(dirtyBefore);
  });
});
