import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitFacade } from "../src/git-facade.js";
import {
  TICKET_LEDGER_RELATIVE_PATH,
  TicketLedgerError,
  loadTicketLedgerAtRef,
  loadTicketLedgerFromWorktree,
  ticketDocumentPath,
} from "../src/ticket-ledger/index.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ticket Ledger Test",
      GIT_AUTHOR_EMAIL: "ticket-ledger@example.test",
      GIT_COMMITTER_NAME: "Ticket Ledger Test",
      GIT_COMMITTER_EMAIL: "ticket-ledger@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });

const protocol = `schema_version: 1
kind: ticket_protocol
format: vibehub.ticket-ledger
`;

const ticket = (ticketId: string, outcome: string): string => `schema_version: 1
kind: ticket
ticket_id: ${ticketId}
outcome: ${outcome}
context: Context for ${ticketId}
acceptance: []
constraints: []
context_refs: []
relations: []
provenance_refs: []
`;

const write = (root: string, relative: string, content: string): void => {
  const destination = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
};

const initializeRepository = (): string => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), "vibehub-ticket-ledger-"),
  );
  git(repository, "init", "-b", "main");
  write(
    repository,
    `${TICKET_LEDGER_RELATIVE_PATH}/protocol.yaml`,
    protocol,
  );
  write(
    repository,
    ticketDocumentPath("read-cut"),
    ticket("read-cut", "Read one exact source"),
  );
  write(repository, "README.md", "# fixture\n");
  git(repository, "add", "-A");
  git(repository, "commit", "-m", "seed Ticket ledger");
  return repository;
};

const initializeSha256Repository = (): string | null => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), "vibehub-ticket-ledger-sha256-"),
  );
  try {
    git(repository, "init", "--object-format=sha256", "-b", "main");
  } catch {
    fs.rmSync(repository, { recursive: true, force: true });
    return null;
  }
  write(
    repository,
    `${TICKET_LEDGER_RELATIVE_PATH}/protocol.yaml`,
    protocol,
  );
  write(
    repository,
    ticketDocumentPath("sha256-source"),
    ticket("sha256-source", "Read an exact SHA-256 Git source"),
  );
  git(repository, "add", "-A");
  git(repository, "commit", "-m", "seed SHA-256 Ticket ledger");
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

describe("Ticket ledger reader", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads coherent committed worktree and exact-ref snapshots without a DB", () => {
    const repository = initializeRepository();
    roots.push(repository);
    const resolve = vi.spyOn(GitFacade, "resolveCommitAt");

    const worktree = loadTicketLedgerFromWorktree(repository);
    const exactRef = loadTicketLedgerAtRef(repository, "main");

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(worktree.graphDigest).toBe(exactRef.graphDigest);
    expect(worktree.source).toMatchObject({
      mode: "worktree",
      resolvedCommit: exactRef.source.resolvedCommit,
      semanticDirty: false,
      dirtyPaths: [],
    });
    expect(exactRef.source).toMatchObject({
      mode: "ref",
      requestedRef: "main",
    });
    expect(worktree.source.sourceToken).not.toBe(exactRef.source.sourceToken);
    expect(worktree.tickets[0]!.ticketRevision).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("keeps reading the once-resolved commit when a branch moves", () => {
    const repository = initializeRepository();
    roots.push(repository);
    const originalCommit = git(repository, "rev-parse", "main").trim();
    const resolveCommitAt = GitFacade.resolveCommitAt;
    vi.spyOn(GitFacade, "resolveCommitAt").mockImplementation(
      (repositoryPath, ref) => {
        const resolved = resolveCommitAt(repositoryPath, ref);
        write(
          repository,
          ticketDocumentPath("read-cut"),
          ticket("read-cut", "Moved branch semantics"),
        );
        git(repository, "add", "-A");
        git(repository, "commit", "-m", "move branch during exact read");
        return resolved;
      },
    );

    const exact = loadTicketLedgerAtRef(repository, "main");
    expect(exact.source.resolvedCommit).toBe(originalCommit);
    expect(exact.tickets[0]!.document.outcome)
      .toBe("Read one exact source");
    expect(git(repository, "rev-parse", "main").trim()).not.toBe(originalCommit);
  });

  it("loads an exact ref from a SHA-256 object-format repository when supported", () => {
    const repository = initializeSha256Repository();
    if (repository === null) return;
    roots.push(repository);

    const expectedCommit = git(repository, "rev-parse", "main").trim();
    expect(expectedCommit).toMatch(/^[0-9a-f]{64}$/u);
    expect(GitFacade.hasCommitAt(repository, expectedCommit)).toBe(true);
    const exact = loadTicketLedgerAtRef(repository, "main");

    expect(exact.source).toMatchObject({
      mode: "ref",
      requestedRef: "main",
      resolvedCommit: expectedCommit,
    });
    expect(exact.tickets[0]!.document.ticket_id).toBe("sha256-source");
  });

  it("includes dirty Ticket semantics but ignores unrelated dirty files", () => {
    const repository = initializeRepository();
    roots.push(repository);
    const committed = loadTicketLedgerFromWorktree(repository);

    write(repository, "README.md", "# unrelated dirty edit\n");
    const unrelated = loadTicketLedgerFromWorktree(repository);
    expect(unrelated.graphDigest).toBe(committed.graphDigest);
    expect(unrelated.source.mode).toBe("worktree");
    if (unrelated.source.mode === "worktree") {
      expect(unrelated.source.dirtyPaths).toEqual([]);
      expect(unrelated.source.semanticDirty).toBe(false);
    }

    write(
      repository,
      ticketDocumentPath("read-cut"),
      ticket("read-cut", "Read dirty worktree semantics"),
    );
    const dirty = loadTicketLedgerFromWorktree(repository);
    const exactRef = loadTicketLedgerAtRef(repository, "HEAD");
    expect(dirty.graphDigest).not.toBe(exactRef.graphDigest);
    if (dirty.source.mode === "worktree") {
      expect(dirty.source.semanticDirty).toBe(true);
      expect(dirty.source.dirtyPaths)
        .toEqual([ticketDocumentPath("read-cut")]);
      expect(dirty.source.committedGraphDigest).toBe(exactRef.graphDigest);
    }
  });

  it("reports formatting dirt without changing the semantic digest", () => {
    const repository = initializeRepository();
    roots.push(repository);
    const before = loadTicketLedgerFromWorktree(repository);
    const documentPath = path.join(
      repository,
      ...ticketDocumentPath("read-cut").split("/"),
    );
    fs.appendFileSync(documentPath, "# formatting only\n");

    const after = loadTicketLedgerFromWorktree(repository);
    expect(after.graphDigest).toBe(before.graphDigest);
    if (after.source.mode === "worktree") {
      expect(after.source.semanticDirty).toBe(false);
      expect(after.source.dirtyPaths)
        .toEqual([ticketDocumentPath("read-cut")]);
    }
  });

  it("includes untracked Tickets and committed deletions only in the worktree graph", () => {
    const repository = initializeRepository();
    roots.push(repository);
    const committed = loadTicketLedgerAtRef(repository, "HEAD");

    write(
      repository,
      ticketDocumentPath("untracked"),
      ticket("untracked", "Pending local semantics"),
    );
    const withUntracked = loadTicketLedgerFromWorktree(repository);
    expect(withUntracked.tickets.map((item) => item.document.ticket_id))
      .toEqual(["read-cut", "untracked"]);
    expect(withUntracked.graphDigest).not.toBe(committed.graphDigest);
    if (withUntracked.source.mode === "worktree") {
      expect(withUntracked.source.dirtyPaths)
        .toContain(ticketDocumentPath("untracked"));
    }

    fs.rmSync(path.join(
      repository,
      ...ticketDocumentPath("untracked").split("/"),
    ));
    fs.rmSync(path.join(
      repository,
      ...ticketDocumentPath("read-cut").split("/"),
    ));
    const withDeletion = loadTicketLedgerFromWorktree(repository);
    expect(withDeletion.tickets).toEqual([]);
    expect(withDeletion.graphDigest).not.toBe(committed.graphDigest);
    expect(loadTicketLedgerAtRef(repository, "HEAD").graphDigest)
      .toBe(committed.graphDigest);
  });

  it("changes source identity across HEAD changes even with equal Ticket content", () => {
    const repository = initializeRepository();
    roots.push(repository);
    const before = loadTicketLedgerFromWorktree(repository);
    write(repository, "README.md", "# a non-semantic commit\n");
    git(repository, "add", "README.md");
    git(repository, "commit", "-m", "non-semantic commit");
    const after = loadTicketLedgerFromWorktree(repository);

    expect(after.graphDigest).toBe(before.graphDigest);
    expect(after.source.resolvedCommit).not.toBe(before.source.resolvedCommit);
    expect(after.source.sourceToken).not.toBe(before.source.sourceToken);
  });

  it("keeps sibling worktree identity and semantics isolated", () => {
    const repository = initializeRepository();
    roots.push(repository);
    const firstCommit = git(repository, "rev-parse", "HEAD").trim();
    git(repository, "branch", "older", firstCommit);
    write(
      repository,
      ticketDocumentPath("read-cut"),
      ticket("read-cut", "Newer main semantics"),
    );
    git(repository, "add", "-A");
    git(repository, "commit", "-m", "change main semantics");

    const linkedRoot = `${repository}-linked`;
    roots.push(linkedRoot);
    git(repository, "worktree", "add", linkedRoot, "older");
    const detachedRoot = `${repository}-detached`;
    roots.push(detachedRoot);
    git(repository, "worktree", "add", "--detach", detachedRoot, firstCommit);

    const main = loadTicketLedgerFromWorktree(repository);
    const linked = loadTicketLedgerFromWorktree(linkedRoot);
    const detached = loadTicketLedgerFromWorktree(detachedRoot);

    expect(main.graphDigest).not.toBe(linked.graphDigest);
    expect(linked.graphDigest).toBe(detached.graphDigest);
    if (
      linked.source.mode === "worktree"
      && detached.source.mode === "worktree"
    ) {
      expect(linked.source.repositoryIncarnation)
        .toBe(detached.source.repositoryIncarnation);
      expect(linked.source.worktreeIdentity)
        .not.toBe(detached.source.worktreeIdentity);
      expect(linked.source.sourceToken).not.toBe(detached.source.sourceToken);
    }
  });

  it("keeps identity across a worktree move but rotates it after same-name prune and recreation", () => {
    const repository = initializeRepository();
    roots.push(repository);

    const moveFrom = `${repository}-move-from`;
    const moveTo = `${repository}-move-to`;
    roots.push(moveFrom, moveTo);
    git(
      repository,
      "worktree",
      "add",
      "-b",
      "identity-move",
      moveFrom,
    );
    const beforeMove = loadTicketLedgerFromWorktree(moveFrom);
    git(repository, "worktree", "move", moveFrom, moveTo);
    const afterMove = loadTicketLedgerFromWorktree(moveTo);
    expect(beforeMove.source.mode).toBe("worktree");
    expect(afterMove.source.mode).toBe("worktree");
    if (
      beforeMove.source.mode === "worktree"
      && afterMove.source.mode === "worktree"
    ) {
      expect(afterMove.source.worktreeIdentity)
        .toBe(beforeMove.source.worktreeIdentity);
      expect(afterMove.source.sourceToken).toBe(beforeMove.source.sourceToken);
      expect(afterMove.source.worktreeRoot).not.toBe(beforeMove.source.worktreeRoot);
    }

    const reusedRoot = `${repository}-reused`;
    roots.push(reusedRoot);
    git(
      repository,
      "worktree",
      "add",
      "-b",
      "identity-reuse",
      reusedRoot,
    );
    const beforePrune = loadTicketLedgerFromWorktree(reusedRoot);
    fs.rmSync(reusedRoot, { recursive: true, force: true });
    git(repository, "worktree", "prune", "--expire", "now");
    git(repository, "worktree", "add", reusedRoot, "identity-reuse");
    const afterRecreate = loadTicketLedgerFromWorktree(reusedRoot);
    expect(beforePrune.source.mode).toBe("worktree");
    expect(afterRecreate.source.mode).toBe("worktree");
    if (
      beforePrune.source.mode === "worktree"
      && afterRecreate.source.mode === "worktree"
    ) {
      expect(afterRecreate.source.worktreeIdentity)
        .not.toBe(beforePrune.source.worktreeIdentity);
      expect(afterRecreate.source.sourceToken)
        .not.toBe(beforePrune.source.sourceToken);
      expect(afterRecreate.source.resolvedCommit)
        .toBe(beforePrune.source.resolvedCommit);
      expect(afterRecreate.graphDigest).toBe(beforePrune.graphDigest);
    }
  });

  it("fails closed on symlinks and unsupported ledger paths", () => {
    const repository = initializeRepository();
    roots.push(repository);
    const ticketPath = path.join(
      repository,
      ...ticketDocumentPath("read-cut").split("/"),
    );
    fs.rmSync(ticketPath);
    fs.symlinkSync(path.join(repository, "README.md"), ticketPath);
    expectCode(
      () => loadTicketLedgerFromWorktree(repository),
      "symlink",
    );

    fs.rmSync(ticketPath);
    write(
      repository,
      `${TICKET_LEDGER_RELATIVE_PATH}/notes.md`,
      "not protocol\n",
    );
    expectCode(
      () => loadTicketLedgerFromWorktree(repository),
      "unsupported_file",
    );
  });

  it("fails after bounded retries when capture facts keep changing", () => {
    const repository = initializeRepository();
    roots.push(repository);
    let call = 0;
    vi.spyOn(GitFacade, "statusPathsAt").mockImplementation(() => {
      call += 1;
      return call % 2 === 0
        ? []
        : [{
          path: ticketDocumentPath("read-cut"),
          indexStatus: " ",
          worktreeStatus: "M",
          unmerged: false,
        }];
    });

    expectCode(
      () => loadTicketLedgerFromWorktree(repository),
      "source_changed_during_read",
    );
  });

  it("fails closed on an unmerged Ticket path", () => {
    const repository = initializeRepository();
    roots.push(repository);
    git(repository, "checkout", "-b", "left");
    write(
      repository,
      ticketDocumentPath("read-cut"),
      ticket("read-cut", "Left branch semantics"),
    );
    git(repository, "add", "-A");
    git(repository, "commit", "-m", "left");
    git(repository, "checkout", "main");
    write(
      repository,
      ticketDocumentPath("read-cut"),
      ticket("read-cut", "Main branch semantics"),
    );
    git(repository, "add", "-A");
    git(repository, "commit", "-m", "main");
    try {
      git(repository, "merge", "left");
    } catch {
      // Expected content conflict; the reader must report the Git state.
    }

    expectCode(() => loadTicketLedgerFromWorktree(repository), "unmerged");
  });
});
