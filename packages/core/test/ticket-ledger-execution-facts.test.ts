import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TICKET_LEDGER_RELATIVE_PATH,
  GitFacade,
  TicketLedgerError,
  appendTicketContextBinding,
  appendTicketEvidence,
  appendTicketOutcome,
  applyTicketWorktreePatch,
  createTicketOutcomeDocument,
  currentSuccessfulOutcomeForTicket,
  deriveTicketLedgerState,
  encodeTicketOutcomeDocument,
  loadTicketLedgerAtRef,
  loadTicketLedgerFromWorktree,
  projectTicketLedgerForReview,
  projectTicketGraphSnapshotV0,
  ticketAcceptanceCriterionDigest,
  ticketContextBindingDocumentDigest,
  ticketEvidenceDocumentDigest,
  ticketOutcomeDocumentDigest,
  ticketOutcomeDocumentPath,
  validateTicketLedger,
  type TicketDocument,
  type TicketContextBindingDocument,
  type TicketLedgerPatchExpectedSource,
  type TicketLedgerSnapshot,
  type TicketOutcomeDocument,
  type TicketOutcomeDocumentPayload,
} from "../src/index.js";
import { ticketReviewProjectionSourceV0Schema } from "../src/ticket-review-source.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ticket Execution Facts Test",
      GIT_AUTHOR_EMAIL: "ticket-execution@example.test",
      GIT_COMMITTER_NAME: "Ticket Execution Facts Test",
      GIT_COMMITTER_EMAIL: "ticket-execution@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();

const sha256 = (value: Buffer | string): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const ticket = (
  ticketId: string,
  dependencies: string[] = [],
): TicketDocument => ({
  schema_version: 1,
  kind: "ticket",
  ticket_id: ticketId,
  outcome: `Deliver ${ticketId}`,
  context: `Execute ${ticketId} from exact repository context.`,
  acceptance: [{
    acceptance_id: "observable-result",
    criterion: `${ticketId} has an observable result.`,
  }],
  constraints: ["Keep semantic facts in Git."],
  context_refs: [{
    ref: "README.md",
    purpose: "Fixture context",
  }],
  relations: dependencies.map((target_ticket_id) => ({
    type: "depends_on",
    target_ticket_id,
  })),
  provenance_refs: ["README.md"],
});

const expectedSource = (
  snapshot: TicketLedgerSnapshot,
): TicketLedgerPatchExpectedSource => {
  if (snapshot.source.mode !== "worktree") throw new Error("worktree required");
  return {
    sourceToken: snapshot.source.sourceToken,
    worktreeIdentity: snapshot.source.worktreeIdentity,
    resolvedCommit: snapshot.source.resolvedCommit,
    graphDigest: `sha256:${snapshot.graphDigest}`,
    semanticLedgerDigest: `sha256:${snapshot.semanticLedgerDigest}`,
  };
};

const setup = (): string => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), "vibehub-ticket-execution-facts-"),
  );
  git(repository, "init", "-b", "main");
  fs.writeFileSync(path.join(repository, "README.md"), "# exact context\n");
  const ledgerRoot = path.join(repository, ".vibehub", "tickets");
  fs.mkdirSync(ledgerRoot, { recursive: true });
  fs.writeFileSync(path.join(ledgerRoot, "protocol.yaml"), [
    "schema_version: 1",
    "kind: ticket_protocol",
    "format: vibehub.ticket-ledger",
    "",
  ].join("\n"));
  git(repository, "add", "-A");
  git(repository, "commit", "-m", "seed fixture");
  const empty = loadTicketLedgerFromWorktree(repository);
  applyTicketWorktreePatch({
    worktreeRoot: repository,
    request: {
      expectedSource: expectedSource(empty),
      changes: [
        {
          op: "put",
          ticketId: "build-schema",
          expectedTicketRevision: null,
          document: ticket("build-schema"),
        },
        {
          op: "put",
          ticketId: "ship-api",
          expectedTicketRevision: null,
          document: ticket("ship-api", ["build-schema"]),
        },
      ],
    },
  });
  git(repository, "add", TICKET_LEDGER_RELATIVE_PATH);
  git(repository, "commit", "-m", "seed Ticket graph");
  return repository;
};

const executionRun = (binding: TicketContextBindingDocument) => ({
  run_id: "019fb4b8-3385-77e2-878f-09226436d87f",
  generation: 1,
  executor: {
    actor_kind: "agent" as const,
    actor_ref: "codex:executor",
  },
  started_source_digest: binding.repository.repository_source_digest,
});

const appendBinding = (
  repository: string,
  snapshot: TicketLedgerSnapshot,
  ticketId: string,
  prerequisites: Array<{
    ticket_id: string;
    outcome_id: TicketOutcomeDocument["outcome_id"];
    outcome_digest: string;
  }> = [],
  compiledAt = "2026-07-30T20:00:00.000Z",
  packetDigest = sha256(`packet:${ticketId}`),
) => {
  if (snapshot.source.mode !== "worktree") throw new Error("worktree required");
  const subject = snapshot.tickets.find((candidate) =>
    candidate.document.ticket_id === ticketId);
  if (subject === undefined) throw new Error(`missing ${ticketId}`);
  const readme = fs.readFileSync(path.join(repository, "README.md"));
  const repositorySource = GitFacade.worktreeSourceSnapshotAt(
    repository,
    [TICKET_LEDGER_RELATIVE_PATH],
  );
  return appendTicketContextBinding({
    worktreeRoot: repository,
    request: {
      expectedSource: expectedSource(snapshot),
      contextBinding: {
        schema_version: 1,
        kind: "ticket_context_binding",
        subject: {
          ticket_id: ticketId,
          ticket_revision: subject.ticketRevision,
        },
        graph_digest: snapshot.graphDigest,
        repository: {
          repository_incarnation: snapshot.source.repositoryIncarnation,
          worktree_identity: snapshot.source.worktreeIdentity,
          branch: snapshot.source.branch!,
          resolved_commit: snapshot.source.resolvedCommit,
          repository_source_digest: repositorySource.sourceDigest,
        },
        acceptance: subject.document.acceptance.map((item) => ({
          acceptance_id: item.acceptance_id,
          criterion_digest:
            ticketAcceptanceCriterionDigest(item.criterion),
        })),
        context_entries: [{
          ref: "README.md",
          purpose: "Fixture context",
          source_kind: "repo_file",
          files: [{
            repository_path: "README.md",
            file_digest: `sha256:${sha256(readme)}`,
            byte_length: readme.byteLength,
          }],
        }],
        successful_prerequisite_outcomes: prerequisites,
        relevant_decisions: [],
        packet_digest: packetDigest,
      },
    },
    compiledAt,
  });
};

const prepareTerminalFixture = (repository: string) => {
  const initial = loadTicketLedgerFromWorktree(repository);
  const binding = appendBinding(repository, initial, "build-schema");
  const afterBinding = loadTicketLedgerFromWorktree(repository);
  const run = executionRun(binding.contextBinding.document);
  const evidence = appendTicketEvidence({
    worktreeRoot: repository,
    request: {
      expectedSource: expectedSource(afterBinding),
      evidence: {
        schema_version: 1,
        kind: "ticket_evidence",
        subject: binding.contextBinding.document.subject,
        context_binding: {
          context_binding_id:
            binding.contextBinding.document.context_binding_id,
          document_digest: ticketContextBindingDocumentDigest(
            binding.contextBinding.document,
          ),
          packet_digest: binding.contextBinding.document.packet_digest,
        },
        run,
        acceptance_id: "observable-result",
        evidence_type: "commit",
        summary: "The exact implementation commit contains the result.",
        references: [{
          reference_type: "git_commit",
          label: "Implementation commit",
          target: afterBinding.source.resolvedCommit,
        }],
      },
    },
    producedAt: "2026-07-30T20:01:00.000Z",
  });
  const afterEvidence = loadTicketLedgerFromWorktree(repository);
  const common = {
    schema_version: 1 as const,
    kind: "ticket_outcome" as const,
    subject: binding.contextBinding.document.subject,
    context_binding: evidence.evidence.document.context_binding,
    run,
    verifier: {
      actor_kind: "agent" as const,
      actor_ref: "codex:verifier",
    },
    follow_up_ticket_refs: [],
    semantic_closeout_refs: [],
  };
  const successful = {
    ...common,
    terminal_form: "successful" as const,
    executor_report: "Implemented and independently verified.",
    acceptance: [{
      acceptance_id: "observable-result",
      adjudication: "accepted" as const,
      evidence_refs: [{
        evidence_id: evidence.evidence.document.evidence_id,
        evidence_digest: ticketEvidenceDocumentDigest(
          evidence.evidence.document,
        ),
      }],
      rationale: "The exact commit is inspectable.",
    }],
  };
  const failed = {
    ...common,
    terminal_form: "failed" as const,
    executor_report: "The execution did not satisfy acceptance.",
    acceptance: [{
      acceptance_id: "observable-result",
      adjudication: "rejected" as const,
      evidence_refs: [],
      rationale: "The verifier rejected the result.",
    }],
  };
  return {
    afterEvidence,
    successful,
    failed,
  };
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

describe("Git-native Ticket execution facts", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("appends exact context, evidence, and accepted Outcome facts and derives downstream readiness", () => {
    const repository = setup();
    roots.push(repository);

    const initial = loadTicketLedgerFromWorktree(repository);
    const binding = appendBinding(
      repository,
      initial,
      "build-schema",
    );
    expect(binding.status).toBe("applied");

    const afterBinding = loadTicketLedgerFromWorktree(repository);
    const run = executionRun(binding.contextBinding.document);
    const evidenceIntent = {
      schema_version: 1 as const,
      kind: "ticket_evidence" as const,
      subject: binding.contextBinding.document.subject,
      context_binding: {
        context_binding_id:
          binding.contextBinding.document.context_binding_id,
        document_digest: ticketContextBindingDocumentDigest(
          binding.contextBinding.document,
        ),
        packet_digest: binding.contextBinding.document.packet_digest,
      },
      run,
      acceptance_id: "observable-result",
      evidence_type: "commit" as const,
      summary: "The exact implementation commit contains the result.",
      references: [{
        reference_type: "git_commit" as const,
        label: "Implementation commit",
        target: afterBinding.source.resolvedCommit,
      }],
    };
    const evidence = appendTicketEvidence({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(afterBinding),
        evidence: evidenceIntent,
      },
      producedAt: "2026-07-30T20:01:00.000Z",
    });
    expect(evidence.status).toBe("applied");

    const afterEvidence = loadTicketLedgerFromWorktree(repository);
    const evidenceRetry = appendTicketEvidence({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(afterEvidence),
        evidence: evidenceIntent,
      },
      producedAt: "2026-07-30T20:01:30.000Z",
    });
    expect(evidenceRetry.status).toBe("noop");
    expect(evidenceRetry.evidence.document.produced_at)
      .toBe(evidence.evidence.document.produced_at);
    const outcomeIntent = {
      schema_version: 1 as const,
      kind: "ticket_outcome" as const,
      subject: binding.contextBinding.document.subject,
      context_binding:
        evidence.evidence.document.context_binding,
      run,
      terminal_form: "successful" as const,
      executor_report: "Implemented and verified the requested result.",
      acceptance: [{
        acceptance_id: "observable-result",
        adjudication: "accepted" as const,
        evidence_refs: [{
          evidence_id: evidence.evidence.document.evidence_id,
          evidence_digest: ticketEvidenceDocumentDigest(
            evidence.evidence.document,
          ),
        }],
        rationale: "The exact commit is inspectable.",
      }],
      verifier: {
        actor_kind: "agent" as const,
        actor_ref: "codex:verifier",
      },
      follow_up_ticket_refs: [],
      semantic_closeout_refs: [],
    };
    const outcome = appendTicketOutcome({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(afterEvidence),
        outcome: outcomeIntent,
      },
      closedAt: "2026-07-30T20:02:00.000Z",
    });
    expect(outcome.status).toBe("applied");

    const completed = loadTicketLedgerFromWorktree(repository);
    const outcomeRetry = appendTicketOutcome({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(completed),
        outcome: outcomeIntent,
      },
      closedAt: "2026-07-30T20:03:00.000Z",
    });
    expect(outcomeRetry.status).toBe("noop");
    expect(outcomeRetry.outcome.document.closed_at)
      .toBe(outcome.outcome.document.closed_at);
    expect(completed.graphDigest).toBe(initial.graphDigest);
    expect(completed.semanticLedgerDigest).not.toBe(initial.semanticLedgerDigest);
    expect(currentSuccessfulOutcomeForTicket(completed, "build-schema")
      ?.document.outcome_id).toBe(outcome.outcome.document.outcome_id);
    expect(deriveTicketLedgerState(completed).map((state) => [
      state.ticketId,
      state.status,
    ])).toEqual([
      ["build-schema", "DONE"],
      ["ship-api", "READY"],
    ]);

    const projection = projectTicketLedgerForReview(completed);
    expect(projection.currentCapabilityProjections.map((item) => [
      item.subject.kind === "ticket" ? item.subject.ticketId : null,
      item.summary.label,
    ])).toEqual([
      ["build-schema", "DONE"],
      ["ship-api", "READY"],
    ]);
    expect(projection.traceRecords.map((record) => record.kind))
      .toEqual(["context_binding", "evidence", "outcome"]);
    const projectionParse = ticketReviewProjectionSourceV0Schema.safeParse(
      projection,
    );
    expect(projectionParse.success).toBe(true);
    const graphPage = projectTicketGraphSnapshotV0(projection);
    expect(graphPage.tickets.map((ticket) => [
      ticket.ticketId,
      ticket.capabilities.operational.availability === "available"
        ? ticket.capabilities.operational.summary.label
        : null,
    ])).toEqual([
      ["build-schema", "DONE"],
      ["ship-api", "READY"],
    ]);

    const dependentBinding = appendBinding(
      repository,
      completed,
      "ship-api",
      [{
        ticket_id: "build-schema",
        outcome_id: outcome.outcome.document.outcome_id,
        outcome_digest: ticketOutcomeDocumentDigest(
          outcome.outcome.document,
        ),
      }],
      "2026-07-30T20:03:00.000Z",
    );
    expect(dependentBinding.status).toBe("applied");
    git(repository, "add", TICKET_LEDGER_RELATIVE_PATH);
    git(repository, "commit", "-m", "record execution facts");
    const committed = loadTicketLedgerAtRef(repository, "HEAD");
    expect(committed.contextBindings).toHaveLength(2);
    expect(committed.evidence).toHaveLength(1);
    expect(committed.outcomes).toHaveLength(1);
    expect(deriveTicketLedgerState(committed).map((state) => state.status))
      .toEqual(["DONE", "READY"]);
  });

  it("keeps terminal replay idempotent and rejects a contradictory sequential closeout", () => {
    const repository = setup();
    roots.push(repository);
    const fixture = prepareTerminalFixture(repository);

    const first = appendTicketOutcome({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(fixture.afterEvidence),
        outcome: fixture.successful,
      },
      closedAt: "2026-07-30T20:02:00.000Z",
    });
    const afterFirst = loadTicketLedgerFromWorktree(repository);
    const replay = appendTicketOutcome({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(afterFirst),
        outcome: fixture.successful,
      },
      closedAt: "2026-07-30T20:03:00.000Z",
    });
    expect(replay.status).toBe("noop");
    expect(replay.outcome.document.outcome_id)
      .toBe(first.outcome.document.outcome_id);
    expect(replay.outcome.document.closed_at)
      .toBe(first.outcome.document.closed_at);

    expectCode(() => appendTicketOutcome({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(afterFirst),
        outcome: fixture.failed,
      },
      closedAt: "2026-07-30T20:04:00.000Z",
    }), "invalid_document");
    const afterConflict = loadTicketLedgerFromWorktree(repository);
    expect(afterConflict.outcomes.map((item) =>
      item.document.outcome_id)).toEqual([
      first.outcome.document.outcome_id,
    ]);

    const alternateBinding = appendBinding(
      repository,
      afterConflict,
      "build-schema",
      [],
      "2026-07-30T20:05:00.000Z",
      sha256("alternate packet"),
    );
    expect(alternateBinding.contextBinding.document.context_binding_id)
      .not.toBe(fixture.successful.context_binding.context_binding_id);
    const afterAlternateBinding =
      loadTicketLedgerFromWorktree(repository);
    expectCode(() => appendTicketOutcome({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(afterAlternateBinding),
        outcome: {
          ...fixture.failed,
          context_binding: {
            context_binding_id:
              alternateBinding.contextBinding.document.context_binding_id,
            document_digest: ticketContextBindingDocumentDigest(
              alternateBinding.contextBinding.document,
            ),
            packet_digest:
              alternateBinding.contextBinding.document.packet_digest,
          },
          run: executionRun(alternateBinding.contextBinding.document),
        },
      },
      closedAt: "2026-07-30T20:06:00.000Z",
    }), "invalid_document");
    expect(loadTicketLedgerFromWorktree(repository).outcomes).toHaveLength(1);
  });

  it("rejects contradictory terminal facts during ledger validation and derived views fail closed", () => {
    const repository = setup();
    roots.push(repository);
    const fixture = prepareTerminalFixture(repository);
    const first = appendTicketOutcome({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(fixture.afterEvidence),
        outcome: fixture.successful,
      },
      closedAt: "2026-07-30T20:02:00.000Z",
    });
    const afterFirst = loadTicketLedgerFromWorktree(repository);
    const alternateBinding = appendBinding(
      repository,
      afterFirst,
      "build-schema",
      [],
      "2026-07-30T20:03:00.000Z",
      sha256("projection alternate packet"),
    );
    const valid = loadTicketLedgerFromWorktree(repository);
    const conflictingDocument = createTicketOutcomeDocument({
      ...fixture.failed,
      context_binding: {
        context_binding_id:
          alternateBinding.contextBinding.document.context_binding_id,
        document_digest: ticketContextBindingDocumentDigest(
          alternateBinding.contextBinding.document,
        ),
        packet_digest:
          alternateBinding.contextBinding.document.packet_digest,
      },
      run: executionRun(alternateBinding.contextBinding.document),
      closed_at: "2026-07-30T20:03:00.000Z",
    } satisfies TicketOutcomeDocumentPayload);
    const conflictingOutcome = {
      documentPath: ticketOutcomeDocumentPath(conflictingDocument),
      document: conflictingDocument,
    };
    const contradictory = {
      ...valid,
      outcomes: [...valid.outcomes, conflictingOutcome],
    };

    expectCode(() => validateTicketLedger({
      protocol: contradictory.protocol,
      tickets: contradictory.tickets,
      reviews: contradictory.reviews,
      decisions: contradictory.decisions,
      attestations: contradictory.attestations,
      contextBindings: contradictory.contextBindings,
      evidence: contradictory.evidence,
      outcomes: contradictory.outcomes,
    }), "invalid_document");
    expect(deriveTicketLedgerState(contradictory).map((state) => [
      state.ticketId,
      state.status,
    ])).toEqual([
      ["build-schema", "READY"],
      ["ship-api", "BLOCKED"],
    ]);
    const projected = projectTicketLedgerForReview(contradictory);
    expect(projected.currentCapabilityProjections.map((item) => [
      item.subject.kind === "ticket" ? item.subject.ticketId : null,
      item.summary.label,
    ])).toEqual([
      ["build-schema", "READY"],
      ["ship-api", "BLOCKED"],
    ]);
    expect(currentSuccessfulOutcomeForTicket(
      contradictory,
      "build-schema",
    )).toBeNull();
    expect(first.outcome.document.terminal_form).toBe("successful");

    const conflictingPath = path.join(
      repository,
      ...conflictingOutcome.documentPath.split("/"),
    );
    fs.writeFileSync(
      conflictingPath,
      encodeTicketOutcomeDocument(conflictingDocument),
    );
    expectCode(
      () => loadTicketLedgerFromWorktree(repository),
      "invalid_document",
    );
  });

  it("serializes contradictory closeouts at the atomic writer boundary", () => {
    const repository = setup();
    roots.push(repository);
    const fixture = prepareTerminalFixture(repository);
    const lockPath = GitFacade.gitPathAt(
      repository,
      "vibehub-ticket-ledger-patch.lock",
    );
    fs.writeFileSync(lockPath, "concurrent closeout\n");
    try {
      expectCode(() => appendTicketOutcome({
        worktreeRoot: repository,
        request: {
          expectedSource: expectedSource(fixture.afterEvidence),
          outcome: fixture.successful,
        },
        closedAt: "2026-07-30T20:02:00.000Z",
      }), "writer_busy");
      expectCode(() => appendTicketOutcome({
        worktreeRoot: repository,
        request: {
          expectedSource: expectedSource(fixture.afterEvidence),
          outcome: fixture.failed,
        },
        closedAt: "2026-07-30T20:02:00.000Z",
      }), "writer_busy");
      expect(loadTicketLedgerFromWorktree(repository).outcomes).toEqual([]);
    } finally {
      fs.unlinkSync(lockPath);
    }

    appendTicketOutcome({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(fixture.afterEvidence),
        outcome: fixture.successful,
      },
      closedAt: "2026-07-30T20:02:00.000Z",
    });
    const afterWinner = loadTicketLedgerFromWorktree(repository);
    expectCode(() => appendTicketOutcome({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(afterWinner),
        outcome: fixture.failed,
      },
      closedAt: "2026-07-30T20:03:00.000Z",
    }), "invalid_document");
    expect(loadTicketLedgerFromWorktree(repository).outcomes).toHaveLength(1);
  });

  it("keeps the first timestamp on an equivalent retry and rejects executor self-verification", () => {
    const repository = setup();
    roots.push(repository);
    const initial = loadTicketLedgerFromWorktree(repository);
    const first = appendBinding(repository, initial, "build-schema");
    const run = executionRun(first.contextBinding.document);
    const afterFirst = loadTicketLedgerFromWorktree(repository);

    const retry = appendBinding(
      repository,
      afterFirst,
      "build-schema",
    );
    expect(retry.status).toBe("noop");
    expect(retry.contextBinding.document.compiled_at)
      .toBe(first.contextBinding.document.compiled_at);

    const evidence = appendTicketEvidence({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(afterFirst),
        evidence: {
          schema_version: 1,
          kind: "ticket_evidence",
          subject: first.contextBinding.document.subject,
          context_binding: {
            context_binding_id:
              first.contextBinding.document.context_binding_id,
            document_digest: ticketContextBindingDocumentDigest(
              first.contextBinding.document,
            ),
            packet_digest: first.contextBinding.document.packet_digest,
          },
          run,
          acceptance_id: "observable-result",
          evidence_type: "commit",
          summary: "Exact commit evidence.",
          references: [{
            reference_type: "git_commit",
            label: "Implementation commit",
            target: afterFirst.source.resolvedCommit,
          }],
        },
      },
      producedAt: "2026-07-30T20:01:00.000Z",
    });
    const afterEvidence = loadTicketLedgerFromWorktree(repository);
    expect(() => appendTicketOutcome({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(afterEvidence),
        outcome: {
          schema_version: 1,
          kind: "ticket_outcome",
          subject: first.contextBinding.document.subject,
          context_binding: evidence.evidence.document.context_binding,
          run,
          terminal_form: "successful",
          executor_report: "Self-certified result.",
          acceptance: [{
            acceptance_id: "observable-result",
            adjudication: "accepted",
            evidence_refs: [{
              evidence_id: evidence.evidence.document.evidence_id,
              evidence_digest: ticketEvidenceDocumentDigest(
                evidence.evidence.document,
              ),
            }],
            rationale: "Executor claims success.",
          }],
          verifier: run.executor,
          follow_up_ticket_refs: [],
          semantic_closeout_refs: [],
        },
      },
      closedAt: "2026-07-30T20:02:00.000Z",
    })).toThrowError(TicketLedgerError);
    expect(loadTicketLedgerFromWorktree(repository).outcomes).toEqual([]);
  });

  it("resolves Evidence paths inside the exact linked worktree", () => {
    const repository = setup();
    roots.push(repository);
    const linked = fs.mkdtempSync(
      path.join(os.tmpdir(), "vibehub-ticket-linked-worktree-"),
    );
    fs.rmdirSync(linked);
    git(repository, "worktree", "add", "-b", "linked-test", linked);
    roots.push(linked);
    fs.writeFileSync(path.join(linked, "sibling-only.txt"), "linked truth\n");

    const initial = loadTicketLedgerFromWorktree(linked);
    const binding = appendBinding(linked, initial, "build-schema");
    const run = executionRun(binding.contextBinding.document);
    const afterBinding = loadTicketLedgerFromWorktree(linked);
    const siblingBytes = fs.readFileSync(
      path.join(linked, "sibling-only.txt"),
    );
    const result = appendTicketEvidence({
      worktreeRoot: linked,
      request: {
        expectedSource: expectedSource(afterBinding),
        evidence: {
          schema_version: 1,
          kind: "ticket_evidence",
          subject: binding.contextBinding.document.subject,
          context_binding: {
            context_binding_id:
              binding.contextBinding.document.context_binding_id,
            document_digest: ticketContextBindingDocumentDigest(
              binding.contextBinding.document,
            ),
            packet_digest: binding.contextBinding.document.packet_digest,
          },
          run,
          acceptance_id: "observable-result",
          evidence_type: "artifact",
          summary: "Evidence exists only in the linked worktree.",
          references: [{
            reference_type: "repo_path",
            label: "Linked-worktree artifact",
            target: "sibling-only.txt",
            digest: `sha256:${sha256(siblingBytes)}`,
          }],
        },
      },
      producedAt: "2026-07-30T20:01:00.000Z",
    });
    expect(result.status).toBe("applied");
  });

  it("rejects a ContextBinding when non-ledger repository source changes after compilation", () => {
    const repository = setup();
    roots.push(repository);
    const snapshot = loadTicketLedgerFromWorktree(repository);
    if (snapshot.source.mode !== "worktree") throw new Error("worktree required");
    const subject = snapshot.tickets.find((candidate) =>
      candidate.document.ticket_id === "build-schema")!;
    const readme = fs.readFileSync(path.join(repository, "README.md"));
    const repositorySource = GitFacade.worktreeSourceSnapshotAt(
      repository,
      [TICKET_LEDGER_RELATIVE_PATH],
    );
    const contextBinding = {
      schema_version: 1 as const,
      kind: "ticket_context_binding" as const,
      subject: {
        ticket_id: subject.document.ticket_id,
        ticket_revision: subject.ticketRevision,
      },
      graph_digest: snapshot.graphDigest,
      repository: {
        repository_incarnation: snapshot.source.repositoryIncarnation,
        worktree_identity: snapshot.source.worktreeIdentity,
        branch: snapshot.source.branch!,
        resolved_commit: snapshot.source.resolvedCommit,
        repository_source_digest: repositorySource.sourceDigest,
      },
      acceptance: subject.document.acceptance.map((item) => ({
        acceptance_id: item.acceptance_id,
        criterion_digest: ticketAcceptanceCriterionDigest(item.criterion),
      })),
      context_entries: [{
        ref: "README.md",
        purpose: "Fixture context",
        source_kind: "repo_file" as const,
        files: [{
          repository_path: "README.md",
          file_digest: `sha256:${sha256(readme)}`,
          byte_length: readme.byteLength,
        }],
      }],
      successful_prerequisite_outcomes: [],
      relevant_decisions: [],
      packet_digest: sha256("compiled-before-source-change"),
    };
    fs.writeFileSync(
      path.join(repository, "implementation.ts"),
      "export const changed = true;\n",
    );
    expect(() => appendTicketContextBinding({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(snapshot),
        contextBinding,
      },
      compiledAt: "2026-07-30T20:00:00.000Z",
    })).toThrowError(TicketLedgerError);
    expect(loadTicketLedgerFromWorktree(repository).contextBindings)
      .toEqual([]);
  });
});
