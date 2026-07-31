import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GitFacade,
  OperationDispatcher,
  appendTicketContextBinding,
  appendTicketReview,
  applyTicketWorktreePatch,
  loadTicketLedgerFromWorktree,
  openDb,
  ticketAcceptanceCriterionDigest,
  ticketContextBindingDocumentDigest,
  upsertRepo,
  type Db,
  type OperationContext,
  type OperationResult,
  type TicketLedgerPatchExpectedSource,
  type TicketLedgerSnapshot,
} from "../src/index.js";
import {
  InMemoryTicketDecisionSessionAttestationRegistryV0,
  projectTicketExecutionDecisionAuthorityV0,
} from "../src/ticket-decision-attestation.js";
import { git, makeScratchRepo, type ScratchRepo } from "./helpers.js";

const T0 = "2026-07-30T20:00:00.000Z";
const T1 = "2026-07-30T20:01:00.000Z";
const T2 = "2026-07-30T20:02:00.000Z";
const T3 = "2026-07-30T20:03:00.000Z";
const T4 = "2026-07-30T20:04:00.000Z";
const T5 = "2026-07-30T20:05:00.000Z";
const at = (minutes: number): string =>
  new Date(Date.parse(T0) + minutes * 60_000).toISOString();

const protocol = [
  "schema_version: 1",
  "kind: ticket_protocol",
  "format: vibehub.ticket-ledger",
  "",
].join("\n");

const ticketYaml = (
  ticketId: string,
  prerequisites: string[] = [],
): string => [
  "schema_version: 1",
  "kind: ticket",
  `ticket_id: ${ticketId}`,
  `outcome: Deliver ${ticketId}`,
  `context: Execute ${ticketId} from the exact compiled context.`,
  "acceptance:",
  "  - acceptance_id: observable-result",
  `    criterion: ${ticketId} has an observable result.`,
  "constraints:",
  "  - Preserve Git as semantic authority.",
  "context_refs:",
  "  - ref: README.md",
  "    purpose: Fixture execution context",
  ...(prerequisites.length === 0
    ? ["relations: []"]
    : [
        "relations:",
        ...prerequisites.flatMap((prerequisite) => [
          "  - type: depends_on",
          `    target_ticket_id: ${prerequisite}`,
        ]),
      ]),
  "provenance_refs:",
  "  - README.md",
  "",
].join("\n");

const writeGraph = (repo: ScratchRepo): void => {
  repo.write(".vibehub/tickets/protocol.yaml", protocol);
  repo.write(
    ".vibehub/tickets/tickets/build-client.yaml",
    ticketYaml("build-client"),
  );
  repo.write(
    ".vibehub/tickets/tickets/build-schema.yaml",
    ticketYaml("build-schema"),
  );
  repo.write(
    ".vibehub/tickets/tickets/ship-api.yaml",
    ticketYaml("ship-api", ["build-schema"]),
  );
  repo.write(
    ".vibehub/tickets/tickets/verify-product.yaml",
    ticketYaml("verify-product", ["build-client", "ship-api"]),
  );
  repo.commitAll("seed Ticket execution graph");
};

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

const ok = <T>(result: OperationResult<T>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
};

describe("Ticket execution operation conformance", () => {
  const repos: ScratchRepo[] = [];
  const dbs: Db[] = [];

  afterEach(() => {
    dbs.splice(0).forEach((db) => db.close());
    repos.splice(0).forEach((repo) => repo.cleanup());
  });

  const setup = () => {
    const repo = makeScratchRepo();
    repos.push(repo);
    writeGraph(repo);
    const dbPath = path.join(repo.root, "operational.sqlite");
    const db = openDb(dbPath);
    dbs.push(db);
    const repoRow = upsertRepo(db, repo.work, "fixture/repo", "main", T0);
    return {
      repo,
      db,
      dbPath,
      repoId: repoRow.id,
      dispatcher: new OperationDispatcher(db, { repoRoot: repo.work }),
    };
  };

  const context = (
    repoId: number,
    requestId: string,
    now: string,
    actor = "agent:executor",
  ): OperationContext => ({
    repoId,
    actor,
    requestId,
    now,
  });

  const finishSuccessfully = (
    fixture: ReturnType<typeof setup>,
    ticketId: string,
    baseMinute: number,
  ): any => {
    const frontier = ok(fixture.dispatcher.dispatch(
      "ticket.frontier.read",
      context(
        fixture.repoId,
        `join:${ticketId}:frontier`,
        at(baseMinute),
      ),
      {},
    )) as any;
    const ticket = frontier.tickets.find((candidate: any) =>
      candidate.ticketId === ticketId);
    expect(ticket).toMatchObject({ ticketId, status: "READY" });
    const compiled = ok(fixture.dispatcher.dispatch(
      "ticket.context.compile",
      context(
        fixture.repoId,
        `join:${ticketId}:compile`,
        at(baseMinute),
      ),
      {
        expectedSource: frontier.source,
        ticketId,
        expectedTicketRevision: ticket.ticketRevision,
      },
    )) as any;
    const afterCompile = ok(fixture.dispatcher.dispatch(
      "ticket.frontier.read",
      context(
        fixture.repoId,
        `join:${ticketId}:compiled`,
        at(baseMinute + 1),
      ),
      {},
    )) as any;
    const run = ok(fixture.dispatcher.dispatch(
      "ticket.run.claim",
      context(
        fixture.repoId,
        `join:${ticketId}:claim`,
        at(baseMinute + 1),
      ),
      {
        expectedSource: afterCompile.source,
        ticketId,
        expectedTicketRevision: ticket.ticketRevision,
        contextBindingId:
          compiled.contextBinding.document.context_binding_id,
        contextBindingDigest: compiled.contextBinding.documentDigest,
        leaseSeconds: 600,
      },
    )) as any;
    const evidenceSource = ok(fixture.dispatcher.dispatch(
      "ticket.frontier.read",
      context(
        fixture.repoId,
        `join:${ticketId}:evidence-source`,
        at(baseMinute + 2),
      ),
      {},
    )) as any;
    const evidence = ok(fixture.dispatcher.dispatch(
      "ticket.evidence.append",
      context(
        fixture.repoId,
        `join:${ticketId}:evidence`,
        at(baseMinute + 2),
      ),
      {
        expectedSource: evidenceSource.source,
        run: {
          runId: run.runId,
          generation: run.generation,
          leaseToken: run.leaseToken,
        },
        acceptanceId: "observable-result",
        evidenceType: "inspection",
        summary: `${ticketId} has the observable fixture result.`,
        references: [{
          kind: "repo_path",
          label: "Fixture result",
          target: "README.md",
        }],
      },
    )) as any;
    ok(fixture.dispatcher.dispatch(
      "ticket.run.release",
      context(
        fixture.repoId,
        `join:${ticketId}:release`,
        at(baseMinute + 3),
      ),
      {
        runId: run.runId,
        generation: run.generation,
        leaseToken: run.leaseToken,
        reason: "lease_released",
      },
    ));
    const closeoutSource = ok(fixture.dispatcher.dispatch(
      "ticket.frontier.read",
      context(
        fixture.repoId,
        `join:${ticketId}:closeout-source`,
        at(baseMinute + 4),
        "agent:verifier",
      ),
      {},
    )) as any;
    return ok(fixture.dispatcher.dispatch(
      "ticket.closeout.append",
      context(
        fixture.repoId,
        `join:${ticketId}:closeout`,
        at(baseMinute + 4),
        "agent:verifier",
      ),
      {
        expectedSource: closeoutSource.source,
        runId: run.runId,
        generation: run.generation,
        terminalForm: "successful",
        executorReport: `Executed ${ticketId}.`,
        acceptance: [{
          acceptanceId: "observable-result",
          disposition: "accepted",
          evidenceRefs: [evidence.evidence.document.evidence_id],
          rationale: "The exact fixture evidence was independently inspected.",
        }],
        followUpTicketRefs: [],
        semanticCloseoutRefs: [],
      },
    ));
  };

  it("executes, independently closes, unlocks only the direct dependent, and survives DB loss", () => {
    const fixture = setup();
    const { repo, repoId } = fixture;

    const initial = ok(fixture.dispatcher.dispatch(
      "ticket.frontier.read",
      context(repoId, "frontier:initial", T0),
      {},
    )) as any;
    expect(initial.tickets.map((ticket: any) => [
      ticket.ticketId,
      ticket.status,
    ])).toEqual([
      ["build-client", "READY"],
      ["build-schema", "READY"],
      ["ship-api", "BLOCKED"],
      ["verify-product", "BLOCKED"],
    ]);
    const root = initial.tickets.find((ticket: any) =>
      ticket.ticketId === "build-schema");

    const compiled = ok(fixture.dispatcher.dispatch(
      "ticket.context.compile",
      context(repoId, "context:compile", T0),
      {
        expectedSource: initial.source,
        ticketId: root.ticketId,
        expectedTicketRevision: root.ticketRevision,
      },
    )) as any;
    expect(compiled.packet).toMatchObject({
      format: "vibehub.ticket-context-packet.v1",
      ticket: { ticketRevision: root.ticketRevision },
      context: {
        entries: [{
          ref: "README.md",
          files: [{
            path: "README.md",
            content: expect.stringContaining("# scratch"),
          }],
        }],
      },
    });

    const afterCompile = ok(fixture.dispatcher.dispatch(
      "ticket.frontier.read",
      context(repoId, "frontier:compiled", T1),
      {},
    )) as any;
    const claimed = ok(fixture.dispatcher.dispatch(
      "ticket.run.claim",
      context(repoId, "run:claim", T1),
      {
        expectedSource: afterCompile.source,
        ticketId: root.ticketId,
        expectedTicketRevision: root.ticketRevision,
        contextBindingId:
          compiled.contextBinding.document.context_binding_id,
        contextBindingDigest: compiled.contextBinding.documentDigest,
        leaseSeconds: 300,
      },
    )) as any;
    expect(claimed).toMatchObject({
      ticketId: "build-schema",
      actor: "agent:executor",
      generation: 1,
      leaseToken: expect.stringMatching(/^vht_/),
    });
    const stored = fixture.db.prepare(`
      SELECT token_hash tokenHash FROM ticket_runs WHERE run_id=?
    `).get(claimed.runId) as { tokenHash: string };
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored.tokenHash).not.toContain(claimed.leaseToken);

    repo.write("src/shared.ts", "export const a = 2;\n");
    repo.commitAll("implement build-schema");
    const head = git(repo.work, "rev-parse", "HEAD").trim();

    const afterImplementation = ok(fixture.dispatcher.dispatch(
      "ticket.frontier.read",
      context(repoId, "frontier:implemented", T2),
      {},
    )) as any;
    const evidence = ok(fixture.dispatcher.dispatch(
      "ticket.evidence.append",
      context(repoId, "evidence:append", T2),
      {
        expectedSource: afterImplementation.source,
        run: {
          runId: claimed.runId,
          generation: claimed.generation,
          leaseToken: claimed.leaseToken,
        },
        acceptanceId: "observable-result",
        evidenceType: "commit",
        summary: "The implementation commit provides the observable result.",
        references: [{
          kind: "git_commit",
          label: "Implementation commit",
          target: head,
        }],
      },
    )) as any;

    expect(ok(fixture.dispatcher.dispatch(
      "ticket.run.release",
      context(repoId, "run:release", T3),
      {
        runId: claimed.runId,
        generation: claimed.generation,
        leaseToken: claimed.leaseToken,
        reason: "lease_released",
      },
    ))).toMatchObject({ alreadyReleased: false });

    const beforeCloseout = ok(fixture.dispatcher.dispatch(
      "ticket.frontier.read",
      context(repoId, "frontier:closeout", T4, "agent:verifier"),
      {},
    )) as any;
    const closed = ok(fixture.dispatcher.dispatch(
      "ticket.closeout.append",
      context(repoId, "closeout:append", T4, "agent:verifier"),
      {
        expectedSource: beforeCloseout.source,
        runId: claimed.runId,
        generation: claimed.generation,
        terminalForm: "successful",
        executorReport: "Implemented build-schema at the recorded commit.",
        acceptance: [{
          acceptanceId: "observable-result",
          disposition: "accepted",
          evidenceRefs: [evidence.evidence.document.evidence_id],
          rationale: "The independent verifier inspected the exact commit.",
        }],
        followUpTicketRefs: [],
        semanticCloseoutRefs: [],
      },
    )) as any;
    expect(closed.outcome.document).toMatchObject({
      terminal_form: "successful",
      verifier: {
        actor_kind: "agent",
        actor_ref: "agent:verifier",
      },
    });

    const completed = ok(fixture.dispatcher.dispatch(
      "ticket.frontier.read",
      context(repoId, "frontier:completed", T5),
      {},
    )) as any;
    expect(completed.tickets.map((ticket: any) => [
      ticket.ticketId,
      ticket.status,
    ])).toEqual([
      ["build-client", "READY"],
      ["build-schema", "DONE"],
      ["ship-api", "READY"],
      ["verify-product", "BLOCKED"],
    ]);

    fixture.db.close();
    dbs.splice(dbs.indexOf(fixture.db), 1);
    fs.rmSync(fixture.dbPath, { force: true });
    const recoveredDb = openDb(fixture.dbPath);
    dbs.push(recoveredDb);
    const recoveredRepo = upsertRepo(
      recoveredDb,
      repo.work,
      "fixture/repo",
      "main",
      T5,
    );
    const recovered = ok(new OperationDispatcher(recoveredDb, {
      repoRoot: repo.work,
    }).dispatch(
      "ticket.frontier.read",
      context(recoveredRepo.id, "frontier:recovered", T5),
      {},
    )) as any;
    expect(recovered.tickets.map((ticket: any) => ticket.status))
      .toEqual(["READY", "DONE", "READY", "BLOCKED"]);
    expect(recoveredDb.prepare("SELECT COUNT(*) count FROM ticket_runs").get())
      .toEqual({ count: 0 });
  });

  it("holds a real join until both paths complete", () => {
    const fixture = setup();
    finishSuccessfully(fixture, "build-schema", 0);
    finishSuccessfully(fixture, "ship-api", 10);

    const onePathMissing = ok(fixture.dispatcher.dispatch(
      "ticket.frontier.read",
      context(fixture.repoId, "join:one-path-missing", at(15)),
      {},
    )) as any;
    expect(onePathMissing.tickets.find((ticket: any) =>
      ticket.ticketId === "verify-product")).toMatchObject({
        status: "BLOCKED",
        blockingTicketIds: ["build-client"],
      });

    finishSuccessfully(fixture, "build-client", 20);
    const joined = ok(fixture.dispatcher.dispatch(
      "ticket.frontier.read",
      context(fixture.repoId, "join:ready", at(25)),
      {},
    )) as any;
    expect(joined.tickets.find((ticket: any) =>
      ticket.ticketId === "verify-product")).toMatchObject({
        status: "READY",
        blockingTicketIds: [],
      });
  });

  it("keeps partial and failed attempts retryable while deviation blocks downstream execution", () => {
    const fixture = setup();
    const close = (
      terminalForm: "partial" | "failed" | "deviated",
      baseMinute: number,
    ): any => {
      const frontier = ok(fixture.dispatcher.dispatch(
        "ticket.frontier.read",
        context(
          fixture.repoId,
          `non-success:${terminalForm}:frontier`,
          at(baseMinute),
        ),
        {},
      )) as any;
      const ticket = frontier.tickets.find((candidate: any) =>
        candidate.ticketId === "build-schema");
      expect(ticket).toMatchObject({ status: "READY" });
      const compiled = ok(fixture.dispatcher.dispatch(
        "ticket.context.compile",
        context(
          fixture.repoId,
          `non-success:${terminalForm}:compile`,
          at(baseMinute),
        ),
        {
          expectedSource: frontier.source,
          ticketId: ticket.ticketId,
          expectedTicketRevision: ticket.ticketRevision,
        },
      )) as any;
      const current = ok(fixture.dispatcher.dispatch(
        "ticket.frontier.read",
        context(
          fixture.repoId,
          `non-success:${terminalForm}:current`,
          at(baseMinute + 1),
        ),
        {},
      )) as any;
      const run = ok(fixture.dispatcher.dispatch(
        "ticket.run.claim",
        context(
          fixture.repoId,
          `non-success:${terminalForm}:claim`,
          at(baseMinute + 1),
        ),
        {
          expectedSource: current.source,
          ticketId: ticket.ticketId,
          expectedTicketRevision: ticket.ticketRevision,
          contextBindingId:
            compiled.contextBinding.document.context_binding_id,
          contextBindingDigest: compiled.contextBinding.documentDigest,
          leaseSeconds: 600,
        },
      )) as any;
      ok(fixture.dispatcher.dispatch(
        "ticket.run.release",
        context(
          fixture.repoId,
          `non-success:${terminalForm}:release`,
          at(baseMinute + 2),
        ),
        {
          runId: run.runId,
          generation: run.generation,
          leaseToken: run.leaseToken,
          reason: "lease_released",
        },
      ));
      const closeoutSource = ok(fixture.dispatcher.dispatch(
        "ticket.frontier.read",
        context(
          fixture.repoId,
          `non-success:${terminalForm}:closeout-source`,
          at(baseMinute + 3),
          "agent:verifier",
        ),
        {},
      )) as any;
      return ok(fixture.dispatcher.dispatch(
        "ticket.closeout.append",
        context(
          fixture.repoId,
          `non-success:${terminalForm}:closeout`,
          at(baseMinute + 3),
          "agent:verifier",
        ),
        {
          expectedSource: closeoutSource.source,
          runId: run.runId,
          generation: run.generation,
          terminalForm,
          executorReport: `${terminalForm} fixture attempt.`,
          acceptance: [{
            acceptanceId: "observable-result",
            disposition: terminalForm === "failed"
              ? "rejected"
              : "unresolved",
            evidenceRefs: [],
            rationale: "The attempt does not satisfy the acceptance condition.",
          }],
          followUpTicketRefs: [],
          semanticCloseoutRefs: [],
        },
      ));
    };

    expect(close("partial", 0).outcome.document.terminal_form)
      .toBe("partial");
    expect(close("failed", 10).outcome.document.terminal_form)
      .toBe("failed");
    expect(close("deviated", 20).outcome.document.terminal_form)
      .toBe("deviated");

    const frontier = ok(fixture.dispatcher.dispatch(
      "ticket.frontier.read",
      context(fixture.repoId, "non-success:final", at(25)),
      {},
    )) as any;
    expect(frontier.tickets.find((ticket: any) =>
      ticket.ticketId === "build-schema")).toMatchObject({
        status: "DEVIATED",
      });
    expect(frontier.tickets.find((ticket: any) =>
      ticket.ticketId === "ship-api")).toMatchObject({
        status: "BLOCKED",
        blockingTicketIds: ["build-schema"],
      });
  });

  it("rejects Git administration Evidence paths and allows component-safe lookalikes", () => {
    const fixture = setup();
    const { repo, repoId, dispatcher } = fixture;
    const initial = ok(dispatcher.dispatch(
      "ticket.frontier.read",
      context(repoId, "evidence-path:initial", T0),
      {},
    )) as any;
    const ticket = initial.tickets.find((candidate: any) =>
      candidate.ticketId === "build-schema");
    const compiled = ok(dispatcher.dispatch(
      "ticket.context.compile",
      context(repoId, "evidence-path:compile", T0),
      {
        expectedSource: initial.source,
        ticketId: ticket.ticketId,
        expectedTicketRevision: ticket.ticketRevision,
      },
    )) as any;
    const afterCompile = ok(dispatcher.dispatch(
      "ticket.frontier.read",
      context(repoId, "evidence-path:compiled", T1),
      {},
    )) as any;
    const run = ok(dispatcher.dispatch(
      "ticket.run.claim",
      context(repoId, "evidence-path:claim", T1),
      {
        expectedSource: afterCompile.source,
        ticketId: ticket.ticketId,
        expectedTicketRevision: ticket.ticketRevision,
        contextBindingId:
          compiled.contextBinding.document.context_binding_id,
        contextBindingDigest: compiled.contextBinding.documentDigest,
        leaseSeconds: 600,
      },
    )) as any;

    repo.write("nested/.GIT/config", "nested admin data\n");
    repo.write(".github/evidence.md", "component-safe evidence\n");
    repo.write(".gitkeep", "component-safe marker\n");
    const current = ok(dispatcher.dispatch(
      "ticket.frontier.read",
      context(repoId, "evidence-path:current", T2),
      {},
    )) as any;
    for (const [index, target] of [
      ".git/config",
      "nested/.GIT/config",
    ].entries()) {
      expect(dispatcher.dispatch(
        "ticket.evidence.append",
        context(repoId, `evidence-path:reject:${index}`, T2),
        {
          expectedSource: current.source,
          run: {
            runId: run.runId,
            generation: run.generation,
            leaseToken: run.leaseToken,
          },
          acceptanceId: "observable-result",
          evidenceType: "inspection",
          summary: "Git administration data must never become Evidence.",
          references: [{
            kind: "repo_path",
            label: "Forbidden administration path",
            target,
          }],
        },
      )).toMatchObject({
        ok: false,
        error: { code: "ticket_ledger_invalid_document" },
      });
    }

    expect(ok(dispatcher.dispatch(
      "ticket.evidence.append",
      context(repoId, "evidence-path:allow-lookalikes", T3),
      {
        expectedSource: current.source,
        run: {
          runId: run.runId,
          generation: run.generation,
          leaseToken: run.leaseToken,
        },
        acceptanceId: "observable-result",
        evidenceType: "inspection",
        summary: "Component-safe Git lookalikes remain valid Evidence.",
        references: [
          {
            kind: "repo_path",
            label: "GitHub evidence",
            target: ".github/evidence.md",
          },
          {
            kind: "repo_path",
            label: "Git keep marker",
            target: ".gitkeep",
          },
        ],
      },
    ))).toMatchObject({
      evidence: {
        document: {
          references: [
            { target: ".github/evidence.md" },
            { target: ".gitkeep" },
          ],
        },
      },
    });
  });

  it.each([
    {
      label: "ignored file mutation",
      ref: "ignored-context.txt",
      seed: (repo: ScratchRepo) => {
        repo.write("ignored-context.txt", "compiled version\n");
      },
      mutate: (repo: ScratchRepo) => {
        repo.write("ignored-context.txt", "changed after compile\n");
      },
    },
    {
      label: "ignored directory addition",
      ref: "ignored-context",
      seed: (repo: ScratchRepo) => {
        repo.write("ignored-context/seed.md", "compiled member\n");
      },
      mutate: (repo: ScratchRepo) => {
        repo.write("ignored-context/later.md", "uncompiled member\n");
      },
    },
  ])("rejects claim after $label outside Git status", ({
    ref,
    seed,
    mutate,
  }) => {
    const fixture = setup();
    const { repo, repoId, dispatcher } = fixture;
    repo.write(
      ".gitignore",
      "/ignored-context.txt\n/ignored-context/\n",
    );
    seed(repo);
    repo.commitAll("ignore exact-context fixtures");

    const beforeEdit = loadTicketLedgerFromWorktree(repo.work);
    const original = beforeEdit.tickets.find((candidate) =>
      candidate.document.ticket_id === "build-schema");
    if (original === undefined) throw new Error("missing fixture Ticket");
    applyTicketWorktreePatch({
      worktreeRoot: repo.work,
      request: {
        expectedSource: expectedSource(beforeEdit),
        changes: [{
          op: "put",
          ticketId: original.document.ticket_id,
          expectedTicketRevision: `sha256:${original.ticketRevision}`,
          document: {
            ...original.document,
            context_refs: [{
              ref,
              purpose: "Ignored but exact execution context",
            }],
          },
        }],
      },
    });
    const ready = ok(dispatcher.dispatch(
      "ticket.frontier.read",
      context(repoId, `ignored:${ref}:ready`, T0),
      {},
    )) as any;
    const ticket = ready.tickets.find((candidate: any) =>
      candidate.ticketId === "build-schema");
    const compiled = ok(dispatcher.dispatch(
      "ticket.context.compile",
      context(repoId, `ignored:${ref}:compile`, T1),
      {
        expectedSource: ready.source,
        ticketId: ticket.ticketId,
        expectedTicketRevision: ticket.ticketRevision,
      },
    )) as any;
    const sourceBeforeMutation = GitFacade.worktreeSourceSnapshotAt(
      repo.work,
      [".vibehub/tickets"],
    );

    mutate(repo);

    const sourceAfterMutation = GitFacade.worktreeSourceSnapshotAt(
      repo.work,
      [".vibehub/tickets"],
    );
    expect(sourceAfterMutation.sourceDigest)
      .toBe(sourceBeforeMutation.sourceDigest);
    const current = ok(dispatcher.dispatch(
      "ticket.frontier.read",
      context(repoId, `ignored:${ref}:current`, T2),
      {},
    )) as any;
    expect(dispatcher.dispatch(
      "ticket.run.claim",
      context(repoId, `ignored:${ref}:claim`, T2),
      {
        expectedSource: current.source,
        ticketId: ticket.ticketId,
        expectedTicketRevision: ticket.ticketRevision,
        contextBindingId:
          compiled.contextBinding.document.context_binding_id,
        contextBindingDigest: compiled.contextBinding.documentDigest,
        leaseSeconds: 300,
      },
    )).toMatchObject({
      ok: false,
      error: { code: "ticket_run_stale" },
    });
  });

  it("cannot claim a pre-existing binding whose context targets semantic Ticket facts", () => {
    const fixture = setup();
    const { repo, repoId, dispatcher } = fixture;
    const initial = loadTicketLedgerFromWorktree(repo.work);
    const firstReview = appendTicketReview({
      worktreeRoot: repo.work,
      request: {
        expectedSource: expectedSource(initial),
        review: {
          review_type: "comment",
          subject: {
            kind: "graph",
            graph_digest: initial.graphDigest,
          },
          body: "First semantic-only review fact.",
        },
      },
      author: {
        actor_id: "local-reviewer",
        actor_kind: "human",
        attribution: "host_attested",
      },
      occurredAt: T0,
    });
    const afterReview = loadTicketLedgerFromWorktree(repo.work);
    const original = afterReview.tickets.find((candidate) =>
      candidate.document.ticket_id === "build-schema");
    if (original === undefined) throw new Error("missing fixture Ticket");
    applyTicketWorktreePatch({
      worktreeRoot: repo.work,
      request: {
        expectedSource: expectedSource(afterReview),
        changes: [{
          op: "put",
          ticketId: original.document.ticket_id,
          expectedTicketRevision: `sha256:${original.ticketRevision}`,
          document: {
            ...original.document,
            context_refs: [{
              ref: ".vibehub/tickets/reviews",
              purpose: "Legacy semantic directory reference",
            }],
          },
        }],
      },
    });
    const semanticTicket = loadTicketLedgerFromWorktree(repo.work);
    if (semanticTicket.source.mode !== "worktree") {
      throw new Error("worktree required");
    }
    const subject = semanticTicket.tickets.find((candidate) =>
      candidate.document.ticket_id === "build-schema");
    if (subject === undefined) throw new Error("missing semantic Ticket");
    const reviewBytes = fs.readFileSync(
      path.join(repo.work, firstReview.review.documentPath),
    );
    const repositorySource = GitFacade.worktreeSourceSnapshotAt(
      repo.work,
      [".vibehub/tickets"],
    );
    const legacyBinding = appendTicketContextBinding({
      worktreeRoot: repo.work,
      request: {
        expectedSource: expectedSource(semanticTicket),
        contextBinding: {
          schema_version: 1,
          kind: "ticket_context_binding",
          subject: {
            ticket_id: subject.document.ticket_id,
            ticket_revision: subject.ticketRevision,
          },
          graph_digest: semanticTicket.graphDigest,
          repository: {
            repository_incarnation:
              semanticTicket.source.repositoryIncarnation,
            worktree_identity: semanticTicket.source.worktreeIdentity,
            branch: semanticTicket.source.branch!,
            resolved_commit: semanticTicket.source.resolvedCommit,
            repository_source_digest: repositorySource.sourceDigest,
          },
          acceptance: subject.document.acceptance.map((item) => ({
            acceptance_id: item.acceptance_id,
            criterion_digest:
              ticketAcceptanceCriterionDigest(item.criterion),
          })),
          context_entries: [{
            ref: ".vibehub/tickets/reviews",
            purpose: "Legacy semantic directory reference",
            source_kind: "repo_directory",
            files: [{
              repository_path: firstReview.review.documentPath,
              file_digest: `sha256:${
                crypto.createHash("sha256").update(reviewBytes).digest("hex")
              }`,
              byte_length: reviewBytes.byteLength,
            }],
          }],
          successful_prerequisite_outcomes: [],
          relevant_decisions: [],
          packet_digest: "a".repeat(64),
        },
      },
      compiledAt: T1,
    });

    const afterBinding = loadTicketLedgerFromWorktree(repo.work);
    const operational = projectTicketExecutionDecisionAuthorityV0(
      afterBinding,
      new InMemoryTicketDecisionSessionAttestationRegistryV0(),
    );
    expect(operational.contextBindings).not.toContainEqual(
      expect.objectContaining({
        document: expect.objectContaining({
          context_binding_id:
            legacyBinding.contextBinding.document.context_binding_id,
        }),
      }),
    );
    expect(operational.issuesByContextBinding.get(
      legacyBinding.contextBinding.document.context_binding_id,
    )).toMatchObject({
      reason: "context_ref_policy_changed",
    });
    appendTicketReview({
      worktreeRoot: repo.work,
      request: {
        expectedSource: expectedSource(afterBinding),
        review: {
          review_type: "comment",
          subject: {
            kind: "graph",
            graph_digest: afterBinding.graphDigest,
          },
          body: "A later semantic fact that the old packet did not compile.",
        },
      },
      author: {
        actor_id: "second-reviewer",
        actor_kind: "human",
        attribution: "host_attested",
      },
      occurredAt: T2,
    });

    const current = ok(dispatcher.dispatch(
      "ticket.frontier.read",
      context(repoId, "semantic-ref:current", T3),
      {},
    )) as any;
    expect(current.tickets.find((ticket: any) =>
      ticket.ticketId === "build-schema")).toMatchObject({
        status: "READY",
      });
    expect(dispatcher.dispatch(
      "ticket.run.claim",
      context(repoId, "semantic-ref:claim", T3),
      {
        expectedSource: current.source,
        ticketId: subject.document.ticket_id,
        expectedTicketRevision: `sha256:${subject.ticketRevision}`,
        contextBindingId:
          legacyBinding.contextBinding.document.context_binding_id,
        contextBindingDigest: `sha256:${
          ticketContextBindingDocumentDigest(
            legacyBinding.contextBinding.document,
          )
        }`,
        leaseSeconds: 300,
      },
    )).toMatchObject({
      ok: false,
      error: { code: "ticket_run_stale" },
    });
  });

  it("cannot claim a pre-existing binding that targets Git administration data", () => {
    const fixture = setup();
    const { repo, repoId, dispatcher } = fixture;
    const initial = loadTicketLedgerFromWorktree(repo.work);
    const original = initial.tickets.find((candidate) =>
      candidate.document.ticket_id === "build-schema");
    if (original === undefined) throw new Error("missing fixture Ticket");
    applyTicketWorktreePatch({
      worktreeRoot: repo.work,
      request: {
        expectedSource: expectedSource(initial),
        changes: [{
          op: "put",
          ticketId: original.document.ticket_id,
          expectedTicketRevision: `sha256:${original.ticketRevision}`,
          document: {
            ...original.document,
            context_refs: [{
              ref: ".git/config",
              purpose: "Legacy Git administration reference",
            }],
          },
        }],
      },
    });
    const legacyTicket = loadTicketLedgerFromWorktree(repo.work);
    if (legacyTicket.source.mode !== "worktree") {
      throw new Error("worktree required");
    }
    const subject = legacyTicket.tickets.find((candidate) =>
      candidate.document.ticket_id === "build-schema");
    if (subject === undefined) throw new Error("missing legacy Ticket");
    const configBytes = fs.readFileSync(path.join(repo.work, ".git", "config"));
    const repositorySource = GitFacade.worktreeSourceSnapshotAt(
      repo.work,
      [".vibehub/tickets"],
    );
    const legacyBinding = appendTicketContextBinding({
      worktreeRoot: repo.work,
      request: {
        expectedSource: expectedSource(legacyTicket),
        contextBinding: {
          schema_version: 1,
          kind: "ticket_context_binding",
          subject: {
            ticket_id: subject.document.ticket_id,
            ticket_revision: subject.ticketRevision,
          },
          graph_digest: legacyTicket.graphDigest,
          repository: {
            repository_incarnation:
              legacyTicket.source.repositoryIncarnation,
            worktree_identity: legacyTicket.source.worktreeIdentity,
            branch: legacyTicket.source.branch!,
            resolved_commit: legacyTicket.source.resolvedCommit,
            repository_source_digest: repositorySource.sourceDigest,
          },
          acceptance: subject.document.acceptance.map((item) => ({
            acceptance_id: item.acceptance_id,
            criterion_digest:
              ticketAcceptanceCriterionDigest(item.criterion),
          })),
          context_entries: [{
            ref: ".git/config",
            purpose: "Legacy Git administration reference",
            source_kind: "repo_file",
            files: [{
              repository_path: ".git/config",
              file_digest: `sha256:${
                crypto.createHash("sha256").update(configBytes).digest("hex")
              }`,
              byte_length: configBytes.byteLength,
            }],
          }],
          successful_prerequisite_outcomes: [],
          relevant_decisions: [],
          packet_digest: "b".repeat(64),
        },
      },
      compiledAt: T1,
    });

    const current = ok(dispatcher.dispatch(
      "ticket.frontier.read",
      context(repoId, "git-ref:current", T2),
      {},
    )) as any;
    expect(dispatcher.dispatch(
      "ticket.run.claim",
      context(repoId, "git-ref:claim", T2),
      {
        expectedSource: current.source,
        ticketId: subject.document.ticket_id,
        expectedTicketRevision: `sha256:${subject.ticketRevision}`,
        contextBindingId:
          legacyBinding.contextBinding.document.context_binding_id,
        contextBindingDigest: `sha256:${
          ticketContextBindingDocumentDigest(
            legacyBinding.contextBinding.document,
          )
        }`,
        leaseSeconds: 300,
      },
    )).toMatchObject({
      ok: false,
      error: { code: "ticket_run_stale" },
    });
  });

  it("retires a stale lease and preserves an explicit stale closeout against its historical binding", () => {
    const { repo, repoId, dispatcher } = setup();
    const initial = ok(dispatcher.dispatch(
      "ticket.frontier.read",
      context(repoId, "stale:frontier", T0),
      {},
    )) as any;
    const root = initial.tickets.find((ticket: any) =>
      ticket.ticketId === "build-schema");
    const compiled = ok(dispatcher.dispatch(
      "ticket.context.compile",
      context(repoId, "stale:compile", T0),
      {
        expectedSource: initial.source,
        ticketId: root.ticketId,
        expectedTicketRevision: root.ticketRevision,
      },
    )) as any;
    const current = ok(dispatcher.dispatch(
      "ticket.frontier.read",
      context(repoId, "stale:current", T1),
      {},
    )) as any;
    const run = ok(dispatcher.dispatch(
      "ticket.run.claim",
      context(repoId, "stale:claim", T1),
      {
        expectedSource: current.source,
        ticketId: root.ticketId,
        expectedTicketRevision: root.ticketRevision,
        contextBindingId:
          compiled.contextBinding.document.context_binding_id,
        contextBindingDigest: compiled.contextBinding.documentDigest,
        leaseSeconds: 300,
      },
    )) as any;

    const beforeEdit = loadTicketLedgerFromWorktree(repo.work);
    const subject = beforeEdit.tickets.find((candidate) =>
      candidate.document.ticket_id === root.ticketId);
    if (subject === undefined) throw new Error("missing fixture Ticket");
    applyTicketWorktreePatch({
      worktreeRoot: repo.work,
      request: {
        expectedSource: expectedSource(beforeEdit),
        changes: [{
          op: "put",
          ticketId: root.ticketId,
          expectedTicketRevision: `sha256:${subject.ticketRevision}`,
          document: {
            ...subject.document,
            outcome: "Deliver the revised build-schema outcome",
          },
        }],
      },
    });

    const staleFrontier = ok(dispatcher.dispatch(
      "ticket.frontier.read",
      context(repoId, "stale:visible", T2),
      {},
    )) as any;
    expect(staleFrontier.tickets.find((ticket: any) =>
      ticket.ticketId === root.ticketId)).toMatchObject({
        status: "STALE",
        semanticStatus: "READY",
      });
    const replacementTicket = staleFrontier.tickets.find((ticket: any) =>
      ticket.ticketId === root.ticketId);
    const replacementBinding = ok(dispatcher.dispatch(
      "ticket.context.compile",
      context(repoId, "stale:replacement-compile", T2, "agent:replacement"),
      {
        expectedSource: staleFrontier.source,
        ticketId: root.ticketId,
        expectedTicketRevision: replacementTicket.ticketRevision,
      },
    )) as any;
    const replacementSource = ok(dispatcher.dispatch(
      "ticket.frontier.read",
      context(repoId, "stale:replacement-source", T3, "agent:replacement"),
      {},
    )) as any;
    const replacementRun = ok(dispatcher.dispatch(
      "ticket.run.claim",
      context(repoId, "stale:replacement-claim", T3, "agent:replacement"),
      {
        expectedSource: replacementSource.source,
        ticketId: root.ticketId,
        expectedTicketRevision: replacementTicket.ticketRevision,
        contextBindingId:
          replacementBinding.contextBinding.document.context_binding_id,
        contextBindingDigest:
          replacementBinding.contextBinding.documentDigest,
        leaseSeconds: 300,
      },
    )) as any;
    const replacementFrontier = ok(dispatcher.dispatch(
      "ticket.frontier.read",
      context(repoId, "stale:replacement-running", T3),
      {},
    )) as any;
    expect(replacementFrontier.tickets.find((ticket: any) =>
      ticket.ticketId === root.ticketId)).toMatchObject({
        status: "RUNNING",
        run: { runId: replacementRun.runId, current: true },
      });

    expect(dispatcher.dispatch(
      "ticket.run.heartbeat",
      context(repoId, "stale:heartbeat", T4),
      {
        runId: run.runId,
        generation: run.generation,
        leaseToken: run.leaseToken,
        leaseSeconds: 300,
      },
    )).toMatchObject({
      ok: false,
      error: { code: "ticket_run_stale" },
    });

    const afterEdit = ok(dispatcher.dispatch(
      "ticket.frontier.read",
      context(repoId, "stale:after-edit", T5, "agent:verifier"),
      {},
    )) as any;
    const outcome = ok(dispatcher.dispatch(
      "ticket.closeout.append",
      context(repoId, "stale:closeout", T5, "agent:verifier"),
      {
        expectedSource: afterEdit.source,
        runId: run.runId,
        generation: run.generation,
        terminalForm: "stale",
        executorReport: "The Ticket changed after execution was claimed.",
        acceptance: [{
          acceptanceId: "observable-result",
          disposition: "unresolved",
          evidenceRefs: [],
          rationale: "The old execution packet no longer governs the Ticket.",
        }],
        followUpTicketRefs: [],
        semanticCloseoutRefs: [],
      },
    )) as any;
    expect(outcome.outcome.document).toMatchObject({
      terminal_form: "stale",
      subject: {
        ticket_id: "build-schema",
        ticket_revision: root.ticketRevision.slice("sha256:".length),
      },
    });
    expect(loadTicketLedgerFromWorktree(repo.work).outcomes.at(-1)?.document
      .terminal_form).toBe("stale");
    expect(ok(dispatcher.dispatch(
      "ticket.run.release",
      context(repoId, "stale:replacement-release", at(6), "agent:replacement"),
      {
        runId: replacementRun.runId,
        generation: replacementRun.generation,
        leaseToken: replacementRun.leaseToken,
        reason: "lease_released",
      },
    ))).toMatchObject({ alreadyReleased: false });
  });
});
