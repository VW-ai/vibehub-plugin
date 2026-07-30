import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OperationDispatcher,
  openDb,
  type Db,
  type OperationContext,
} from "../src/index.js";
import { makeScratchRepo, type ScratchRepo } from "./helpers.js";

const NOW = "2026-07-29T12:00:00.000Z";

const protocol = [
  "schema_version: 1",
  "kind: ticket_protocol",
  "format: vibehub.ticket-ledger",
  "",
].join("\n");

function ticketDocument(input: {
  ticketId: string;
  outcome: string;
  dependency?: string;
  unknownField?: boolean;
}): string {
  return [
    "schema_version: 1",
    "kind: ticket",
    `ticket_id: ${input.ticketId}`,
    `outcome: ${input.outcome}`,
    `context: Execute ${input.ticketId} from the checked-out project context.`,
    "acceptance:",
    "  - acceptance_id: observable-result",
    `    criterion: ${input.ticketId} produces its observable result.`,
    "constraints:",
    "  - Preserve the accepted dependency boundary.",
    "context_refs:",
    "  - ref: META/09-ticket-runtime/spec.md",
    "    purpose: Ticket runtime contract",
    input.dependency
      ? [
          "relations:",
          "  - type: depends_on",
          `    target_ticket_id: ${input.dependency}`,
          "    rationale: The prerequisite must land first.",
        ].join("\n")
      : "relations: []",
    "provenance_refs:",
    "  - META/09-ticket-runtime/spec.md",
    ...(input.unknownField ? ["legacy_status: active"] : []),
    "",
  ].join("\n");
}

function writeLedger(
  worktreeRoot: string,
  outcome = "The Git Ticket graph is directly reviewable.",
): void {
  const ledgerRoot = path.join(worktreeRoot, ".vibehub", "tickets");
  const ticketsRoot = path.join(ledgerRoot, "tickets");
  fs.mkdirSync(ticketsRoot, { recursive: true });
  fs.writeFileSync(path.join(ledgerRoot, "protocol.yaml"), protocol);
  fs.writeFileSync(
    path.join(ticketsRoot, "read-authority.yaml"),
    ticketDocument({
      ticketId: "read-authority",
      outcome,
    }),
  );
  fs.writeFileSync(
    path.join(ticketsRoot, "review-surface.yaml"),
    ticketDocument({
      ticketId: "review-surface",
      outcome: "The complete graph and executable context are visible.",
      dependency: "read-authority",
    }),
  );
}

describe("Ticket operation dispatcher Git read cut", () => {
  const repos: ScratchRepo[] = [];
  const dbs: Db[] = [];

  afterEach(() => {
    dbs.splice(0).forEach((db) => db.close());
    repos.splice(0).forEach((repo) => repo.cleanup());
  });

  const setup = (): {
    repo: ScratchRepo;
    db: Db;
    dispatcher: OperationDispatcher;
  } => {
    const repo = makeScratchRepo();
    repos.push(repo);
    writeLedger(repo.work);
    const db = openDb(path.join(repo.root, "operational.sqlite"));
    dbs.push(db);
    return {
      repo,
      db,
      dispatcher: new OperationDispatcher(db, { repoRoot: repo.work }),
    };
  };

  const context = (
    requestId: string,
    repoId = 9_999,
  ): OperationContext => ({
    repoId,
    actor: "agent:reviewer",
    requestId,
    now: NOW,
  });

  it("serves the three reads from one trusted worktree without DB identity rows", () => {
    const { dispatcher } = setup();

    expect(dispatcher.operations()).toEqual(expect.arrayContaining([
      "ticket.graph.snapshot",
      "ticket.subject.inspect",
      "ticket.trace.list",
      "ticket.worktree.patch",
    ]));
    expect(dispatcher.operations().filter((name) =>
      name.startsWith("ticket."))).toEqual([
      "ticket.graph.snapshot",
      "ticket.subject.inspect",
      "ticket.trace.list",
      "ticket.worktree.patch",
    ]);

    const graph = dispatcher.dispatch(
      "ticket.graph.snapshot",
      context("graph"),
      {},
    );
    if (!graph.ok) throw new Error(JSON.stringify(graph));
    expect(graph.data).toMatchObject({
      schemaVersion: 2,
      source: {
        mode: "worktree",
        semanticDirty: true,
      },
      summary: { ticketCount: 2, directUnlockCount: 1 },
      page: { count: 3, totalItems: 3 },
      tickets: [
        {
          ticketId: "read-authority",
          ticketRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        },
        {
          ticketId: "review-surface",
          ticketRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        },
      ],
      relations: [{
        prerequisiteTicketId: "read-authority",
        dependentTicketId: "review-surface",
      }],
    });
    const snapshot = graph.data as { snapshotId: string };

    const inspection = dispatcher.dispatch(
      "ticket.subject.inspect",
      context("inspect"),
      {
        snapshotId: snapshot.snapshotId,
        subject: { kind: "ticket", ticketId: "review-surface" },
      },
    );
    expect(inspection).toMatchObject({
      ok: true,
      data: {
        subject: {
          kind: "ticket",
          contextPackage: {
            outcome: "The complete graph and executable context are visible.",
            context: expect.stringContaining("review-surface"),
            acceptance: [{
              acceptanceId: "observable-result",
            }],
            constraints: ["Preserve the accepted dependency boundary."],
            contextRefs: [{
              ref: "META/09-ticket-runtime/spec.md",
              purpose: "Ticket runtime contract",
            }],
            relations: [{
              type: "depends_on",
              targetTicketId: "read-authority",
            }],
            provenanceRefs: ["META/09-ticket-runtime/spec.md"],
          },
        },
      },
    });

    expect(dispatcher.dispatch(
      "ticket.trace.list",
      context("trace"),
      {
        snapshotId: snapshot.snapshotId,
        subject: { kind: "ticket", ticketId: "review-surface" },
      },
    )).toMatchObject({
      ok: true,
      data: {
        records: [],
        page: { count: 0, totalItems: 0 },
      },
    });
  });

  it("does not persist or replay Ticket read receipts", () => {
    const { repo, db, dispatcher } = setup();
    const request = context("same-request");
    const first = dispatcher.dispatch("ticket.graph.snapshot", request, {});
    if (!first.ok) throw new Error(JSON.stringify(first));

    writeLedger(repo.work, "A dirty edit is immediately authoritative.");
    const second = dispatcher.dispatch("ticket.graph.snapshot", request, {});
    if (!second.ok) throw new Error(JSON.stringify(second));

    expect((second.data as { snapshotId: string }).snapshotId)
      .not.toBe((first.data as { snapshotId: string }).snapshotId);
    expect(second.meta).toMatchObject({
      requestId: "same-request",
      at: NOW,
    });
    expect((second.data as {
      tickets: Array<{ ticketId: string; outcome: string }>;
    }).tickets.find((ticket) => ticket.ticketId === "read-authority"))
      .toMatchObject({
        outcome: "A dirty edit is immediately authoritative.",
      });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM operation_request_receipts
       WHERE operation LIKE 'ticket.%'`,
    ).get()).toEqual({ count: 0 });
  });

  it("applies an exact-base patch without DB identity or receipt replay", () => {
    const { db, dispatcher } = setup();
    const graph = dispatcher.dispatch(
      "ticket.graph.snapshot",
      context("patch-base"),
      {},
    );
    if (!graph.ok) throw new Error(JSON.stringify(graph));
    const page = graph.data as {
      source: {
        sourceToken: string;
        worktreeIdentity: string;
        resolvedCommit: string;
        graphDigest: string;
      };
      tickets: Array<{ ticketId: string; ticketRevision: string }>;
    };
    const target = page.tickets.find((ticket) =>
      ticket.ticketId === "read-authority");
    if (target === undefined) throw new Error("missing patch target");
    const input = {
      expectedSource: {
        sourceToken: page.source.sourceToken,
        worktreeIdentity: page.source.worktreeIdentity,
        resolvedCommit: page.source.resolvedCommit,
        graphDigest: page.source.graphDigest,
      },
      changes: [{
        op: "put",
        ticketId: "read-authority",
        expectedTicketRevision: target.ticketRevision,
        document: {
          schema_version: 1,
          kind: "ticket",
          ticket_id: "read-authority",
          outcome: "The Skill can safely change the Git Ticket graph.",
          context: "Use the exact worktree patch capability.",
          acceptance: [],
          constraints: [],
          context_refs: [],
          relations: [],
          provenance_refs: ["META/09-ticket-runtime/spec.md"],
        },
      }],
    };
    const request = context("same-patch-request");
    expect(dispatcher.dispatch(
      "ticket.worktree.patch",
      request,
      input,
    )).toMatchObject({
      ok: true,
      data: {
        status: "applied",
        changedPaths: [
          ".vibehub/tickets/tickets/read-authority.yaml",
        ],
      },
    });
    expect(dispatcher.dispatch(
      "ticket.worktree.patch",
      request,
      input,
    )).toMatchObject({
      ok: false,
      error: { code: "ticket_ledger_stale_source" },
    });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM operation_request_receipts
       WHERE operation LIKE 'ticket.%'`,
    ).get()).toEqual({ count: 0 });
  });

  it("never replays a receipt for a retired Ticket operation", () => {
    const { repo, db, dispatcher } = setup();
    const retiredContext = context("retired-operation");
    db.prepare(
      `INSERT INTO repos(id,root_path,default_branch,created_at)
       VALUES(?,?,?,?)`,
    ).run(retiredContext.repoId, repo.work, "main", NOW);
    const payloadHash = crypto.createHash("sha256").update(JSON.stringify({
      actor: retiredContext.actor,
      input: {},
      taskId: null,
    })).digest("hex");
    const forgedSuccess = {
      ok: true,
      data: { applied: true },
      meta: {
        operation: "ticket.proposal.apply",
        repoId: retiredContext.repoId,
        requestId: retiredContext.requestId,
        at: NOW,
      },
    };
    db.prepare(
      `INSERT INTO operation_request_receipts(
         repo_id,request_id,operation,payload_hash,
         outcome_kind,outcome,created_at
       ) VALUES(?,?,?,?,?,?,?)`,
    ).run(
      retiredContext.repoId,
      retiredContext.requestId,
      "ticket.proposal.apply",
      payloadHash,
      "success",
      JSON.stringify(forgedSuccess),
      NOW,
    );

    expect(dispatcher.dispatch(
      "ticket.proposal.apply",
      retiredContext,
      {},
    )).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_operation",
        details: { operation: "ticket.proposal.apply" },
      },
    });
  });

  it("expires an old snapshot after the worktree Ticket source changes", () => {
    const { repo, dispatcher } = setup();
    const graph = dispatcher.dispatch(
      "ticket.graph.snapshot",
      context("graph-before-edit"),
      {},
    );
    if (!graph.ok) throw new Error(JSON.stringify(graph));
    const snapshotId = (graph.data as { snapshotId: string }).snapshotId;

    writeLedger(repo.work, "The graph changed after inspection began.");
    expect(dispatcher.dispatch(
      "ticket.subject.inspect",
      context("inspect-after-edit"),
      {
        snapshotId,
        subject: { kind: "ticket", ticketId: "read-authority" },
      },
    )).toMatchObject({
      ok: false,
      error: { code: "snapshot_expired" },
    });
  });

  it("fails closed on absent or malformed ledgers", () => {
    const repo = makeScratchRepo();
    repos.push(repo);
    const db = openDb(path.join(repo.root, "operational.sqlite"));
    dbs.push(db);
    const dispatcher = new OperationDispatcher(db, { repoRoot: repo.work });

    expect(dispatcher.dispatch(
      "ticket.graph.snapshot",
      context("missing"),
      {},
    )).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });

    writeLedger(repo.work);
    fs.writeFileSync(
      path.join(
        repo.work,
        ".vibehub",
        "tickets",
        "tickets",
        "read-authority.yaml",
      ),
      ticketDocument({
        ticketId: "read-authority",
        outcome: "Malformed legacy semantics fail closed.",
        unknownField: true,
      }),
    );
    expect(dispatcher.dispatch(
      "ticket.graph.snapshot",
      context("malformed"),
      {},
    )).toMatchObject({
      ok: false,
      error: { code: "ticket_ledger_invalid_document" },
    });
  });

  it("requires an explicit trusted worktree", () => {
    const repo = makeScratchRepo();
    repos.push(repo);
    const db = openDb(path.join(repo.root, "operational.sqlite"));
    dbs.push(db);
    const dispatcher = new OperationDispatcher(db);

    expect(dispatcher.dispatch(
      "ticket.graph.snapshot",
      context("unbound"),
      {},
    )).toMatchObject({
      ok: false,
      error: { code: "ticket_ledger_scope_mismatch" },
    });
  });
});
