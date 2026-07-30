import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitFacade,
  TICKET_LEDGER_RELATIVE_PATH,
  TicketLedgerError,
  applyTicketWorktreePatch,
  loadTicketLedgerFromWorktree,
  type TicketDocument,
  type TicketLedgerPatchExpectedSource,
  type TicketLedgerSnapshot,
} from "../src/index.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ticket Writer Test",
      GIT_AUTHOR_EMAIL: "ticket-writer@example.test",
      GIT_COMMITTER_NAME: "Ticket Writer Test",
      GIT_COMMITTER_EMAIL: "ticket-writer@example.test",
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

const oversizedDocument = (ticketId: string): TicketDocument => ({
  ...document(ticketId, "Reject an oversized Ticket"),
  acceptance: Array.from({ length: 40 }, (_, index) => ({
    acceptance_id: `criterion-${index}`,
    criterion: "x".repeat(8_192),
  })),
});

const aggregateHeavyDocument = (ticketId: string): TicketDocument => ({
  ...document(ticketId, "Reject an oversized prospective ledger"),
  context: "c".repeat(65_536),
  constraints: Array.from({ length: 18 }, (_, index) =>
    `constraint-${index}-${"x".repeat(8_160)}`),
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

const revision = (
  snapshot: TicketLedgerSnapshot,
  ticketId: string,
): string => {
  const value = snapshot.tickets.find((ticket) =>
    ticket.document.ticket_id === ticketId);
  if (value === undefined) throw new Error(`missing ${ticketId}`);
  return `sha256:${value.ticketRevision}`;
};

const setup = (): string => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), "vibehub-ticket-writer-"),
  );
  git(repository, "init", "-b", "main");
  fs.writeFileSync(path.join(repository, "README.md"), "# writer fixture\n");
  const ledgerRoot = path.join(repository, ".vibehub", "tickets");
  fs.mkdirSync(ledgerRoot, { recursive: true });
  fs.writeFileSync(path.join(ledgerRoot, "protocol.yaml"), [
    "schema_version: 1",
    "kind: ticket_protocol",
    "format: vibehub.ticket-ledger",
    "",
  ].join("\n"));
  git(repository, "add", "-A");
  git(repository, "commit", "-m", "seed protocol-only Ticket ledger");
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

describe("Ticket worktree patch", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates, updates, and deletes full Ticket documents from exact bases", () => {
    const repository = setup();
    roots.push(repository);
    fs.appendFileSync(path.join(repository, "README.md"), "unrelated dirty\n");
    fs.writeFileSync(path.join(repository, "staged.txt"), "staged user work\n");
    git(repository, "add", "staged.txt");
    const indexBefore = git(repository, "diff", "--cached", "--binary");
    const readmeBefore = fs.readFileSync(
      path.join(repository, "README.md"),
      "utf8",
    );

    const empty = loadTicketLedgerFromWorktree(repository);
    expect(empty.tickets).toEqual([]);
    const created = applyTicketWorktreePatch({
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
          {
            op: "put",
            ticketId: "verify-api",
            expectedTicketRevision: null,
            document: document(
              "verify-api",
              "Verify the API",
              ["implement-api"],
            ),
          },
        ],
      },
    });
    expect(created).toMatchObject({
      status: "applied",
      changedPaths: [
        `${TICKET_LEDGER_RELATIVE_PATH}/tickets/design-schema.yaml`,
        `${TICKET_LEDGER_RELATIVE_PATH}/tickets/implement-api.yaml`,
        `${TICKET_LEDGER_RELATIVE_PATH}/tickets/verify-api.yaml`,
      ],
      checkpointSelection: {
        source: { sourceToken: expect.stringMatching(/^tls-/u) },
      },
    });
    const afterCreate = loadTicketLedgerFromWorktree(repository);
    expect(afterCreate.graphDigest)
      .toBe(created.after.graphDigest.slice("sha256:".length));

    const updated = applyTicketWorktreePatch({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(afterCreate),
        changes: [
          {
            op: "put",
            ticketId: "implement-api",
            expectedTicketRevision: revision(
              afterCreate,
              "implement-api",
            ),
            document: document("implement-api", "Expose the stable API"),
          },
          {
            op: "delete",
            ticketId: "design-schema",
            expectedTicketRevision: revision(
              afterCreate,
              "design-schema",
            ),
          },
        ],
      },
    });
    expect(updated.status).toBe("applied");
    const afterUpdate = loadTicketLedgerFromWorktree(repository);
    expect(afterUpdate.tickets.map((ticket) => ticket.document.ticket_id))
      .toEqual(["implement-api", "verify-api"]);
    expect(afterUpdate.tickets.find((ticket) =>
      ticket.document.ticket_id === "implement-api")?.document.outcome)
      .toBe("Expose the stable API");
    expect(git(repository, "diff", "--cached", "--binary")).toBe(indexBefore);
    expect(fs.readFileSync(path.join(repository, "README.md"), "utf8"))
      .toBe(readmeBefore);
  });

  it("rejects stale raw sources, stale revisions, and duplicate targets with zero writes", () => {
    const repository = setup();
    roots.push(repository);
    const empty = loadTicketLedgerFromWorktree(repository);
    const protocolPath = path.join(
      repository,
      ".vibehub",
      "tickets",
      "protocol.yaml",
    );
    fs.appendFileSync(protocolPath, "# human formatting note\n");
    const formatted = loadTicketLedgerFromWorktree(repository);
    expect(formatted.graphDigest).toBe(empty.graphDigest);
    expect(formatted.source.sourceToken).not.toBe(empty.source.sourceToken);
    expectCode(
      () => applyTicketWorktreePatch({
        worktreeRoot: repository,
        request: {
          expectedSource: expectedSource(empty),
          changes: [{
            op: "put",
            ticketId: "new-ticket",
            expectedTicketRevision: null,
            document: document("new-ticket", "Create a Ticket"),
          }],
        },
      }),
      "stale_source",
    );
    expect(fs.existsSync(path.join(
      repository,
      ".vibehub",
      "tickets",
      "tickets",
    ))).toBe(false);

    expectCode(
      () => applyTicketWorktreePatch({
        worktreeRoot: repository,
        request: {
          expectedSource: expectedSource(formatted),
          changes: [
            {
              op: "put",
              ticketId: "same",
              expectedTicketRevision: "sha256:".concat("0".repeat(64)),
              document: document("same", "First"),
            },
          ],
        },
      }),
      "stale_ticket_revision",
    );
    expectCode(
      () => applyTicketWorktreePatch({
        worktreeRoot: repository,
        request: {
          expectedSource: expectedSource(formatted),
          changes: [
            {
              op: "put",
              ticketId: "same",
              expectedTicketRevision: null,
              document: document("same", "First"),
            },
            {
              op: "put",
              ticketId: "same",
              expectedTicketRevision: null,
              document: document("same", "Second"),
            },
          ],
        },
      }),
      "duplicate_change",
    );
  });

  it("validates the complete prospective graph before any canonical write", () => {
    const repository = setup();
    roots.push(repository);
    const empty = loadTicketLedgerFromWorktree(repository);
    expectCode(
      () => applyTicketWorktreePatch({
        worktreeRoot: repository,
        request: {
          expectedSource: expectedSource(empty),
          changes: [{
            op: "put",
            ticketId: "orphan",
            expectedTicketRevision: null,
            document: document("orphan", "Depend on a missing Ticket", [
              "missing",
            ]),
          }],
        },
      }),
      "invalid_graph",
    );
    expect(loadTicketLedgerFromWorktree(repository).tickets).toEqual([]);
  });

  it("rejects prospective per-file and aggregate byte overflow before writing", () => {
    const repository = setup();
    roots.push(repository);
    const empty = loadTicketLedgerFromWorktree(repository);
    expectCode(
      () => applyTicketWorktreePatch({
        worktreeRoot: repository,
        request: {
          expectedSource: expectedSource(empty),
          changes: [{
            op: "put",
            ticketId: "oversized-ticket",
            expectedTicketRevision: null,
            document: oversizedDocument("oversized-ticket"),
          }],
        },
      }),
      "file_too_large",
    );
    expectCode(
      () => applyTicketWorktreePatch({
        worktreeRoot: repository,
        request: {
          expectedSource: expectedSource(empty),
          changes: Array.from({ length: 40 }, (_, index) => {
            const ticketId = `aggregate-${String(index).padStart(2, "0")}`;
            return {
              op: "put" as const,
              ticketId,
              expectedTicketRevision: null,
              document: aggregateHeavyDocument(ticketId),
            };
          }),
        },
      }),
      "ledger_too_large",
    );
    expect(loadTicketLedgerFromWorktree(repository).source.sourceToken)
      .toBe(empty.source.sourceToken);
    expect(fs.existsSync(path.join(
      repository,
      ".vibehub",
      "tickets",
      "tickets",
    ))).toBe(false);
  });

  it("serializes writers per worktree and keeps sibling worktrees independent", () => {
    const repository = setup();
    roots.push(repository);
    git(repository, "branch", "sibling");
    const sibling = `${repository}-sibling`;
    roots.push(sibling);
    git(repository, "worktree", "add", sibling, "sibling");
    const lockPath = GitFacade.gitPathAt(
      repository,
      "vibehub-ticket-ledger-patch.lock",
    );
    fs.writeFileSync(lockPath, "busy\n");
    const main = loadTicketLedgerFromWorktree(repository);
    expectCode(
      () => applyTicketWorktreePatch({
        worktreeRoot: repository,
        request: {
          expectedSource: expectedSource(main),
          changes: [{
            op: "put",
            ticketId: "blocked",
            expectedTicketRevision: null,
            document: document("blocked", "Wait for the writer"),
          }],
        },
      }),
      "writer_busy",
    );

    const siblingBase = loadTicketLedgerFromWorktree(sibling);
    expect(applyTicketWorktreePatch({
      worktreeRoot: sibling,
      request: {
        expectedSource: expectedSource(siblingBase),
        changes: [{
          op: "put",
          ticketId: "sibling-only",
          expectedTicketRevision: null,
          document: document("sibling-only", "Stay in the sibling"),
        }],
      },
    }).status).toBe("applied");
    expect(loadTicketLedgerFromWorktree(sibling).tickets).toHaveLength(1);
    expect(loadTicketLedgerFromWorktree(repository).tickets).toHaveLength(0);
    fs.unlinkSync(lockPath);
  });

  it("cleans a partially initialized writer lock and remains retryable", () => {
    const repository = setup();
    roots.push(repository);
    const base = loadTicketLedgerFromWorktree(repository);
    const lockPath = GitFacade.gitPathAt(
      repository,
      "vibehub-ticket-ledger-patch.lock",
    );
    const request = {
      expectedSource: expectedSource(base),
      changes: [{
        op: "put" as const,
        ticketId: "retry-after-lock-failure",
        expectedTicketRevision: null,
        document: document(
          "retry-after-lock-failure",
          "Recover after lock initialization fails",
        ),
      }],
    };
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw new Error("injected lock fsync failure");
    });

    expectCode(
      () => applyTicketWorktreePatch({
        worktreeRoot: repository,
        request,
      }),
      "io",
    );
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(loadTicketLedgerFromWorktree(repository).source.sourceToken)
      .toBe(base.source.sourceToken);

    expect(applyTicketWorktreePatch({
      worktreeRoot: repository,
      request,
    }).status).toBe("applied");
  });

  it("rolls back already installed files after a synchronous mid-patch failure", () => {
    const repository = setup();
    roots.push(repository);
    const empty = loadTicketLedgerFromWorktree(repository);
    const rename = fs.renameSync;
    let injected = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (
        !injected
        && String(target).endsWith("/second.yaml")
        && !String(source).includes("rollback-")
      ) {
        injected = true;
        throw new Error("injected rename failure");
      }
      return rename(source, target);
    });

    expectCode(
      () => applyTicketWorktreePatch({
        worktreeRoot: repository,
        request: {
          expectedSource: expectedSource(empty),
          changes: [
            {
              op: "put",
              ticketId: "first",
              expectedTicketRevision: null,
              document: document("first", "First"),
            },
            {
              op: "put",
              ticketId: "second",
              expectedTicketRevision: null,
              document: document("second", "Second"),
            },
          ],
        },
      }),
      "io",
    );
    expect(loadTicketLedgerFromWorktree(repository).source.sourceToken)
      .toBe(empty.source.sourceToken);
    expect(loadTicketLedgerFromWorktree(repository).tickets).toEqual([]);
  });

  it("replaces a hardlinked Ticket path without changing the external inode", () => {
    const repository = setup();
    roots.push(repository);
    const empty = loadTicketLedgerFromWorktree(repository);
    applyTicketWorktreePatch({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(empty),
        changes: [{
          op: "put",
          ticketId: "hardlink-safe",
          expectedTicketRevision: null,
          document: document("hardlink-safe", "Before replacement"),
        }],
      },
    });
    const base = loadTicketLedgerFromWorktree(repository);
    const target = path.join(
      repository,
      ".vibehub",
      "tickets",
      "tickets",
      "hardlink-safe.yaml",
    );
    const external = path.join(repository, "external-copy.yaml");
    fs.linkSync(target, external);
    const externalBefore = fs.readFileSync(external);
    const linkedBase = loadTicketLedgerFromWorktree(repository);

    applyTicketWorktreePatch({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(linkedBase),
        changes: [{
          op: "put",
          ticketId: "hardlink-safe",
          expectedTicketRevision: revision(base, "hardlink-safe"),
          document: document("hardlink-safe", "After replacement"),
        }],
      },
    });
    expect(fs.readFileSync(external)).toEqual(externalBefore);
    expect(fs.readFileSync(target)).not.toEqual(externalBefore);
  });
});
