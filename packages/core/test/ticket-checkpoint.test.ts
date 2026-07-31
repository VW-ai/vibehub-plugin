import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TICKET_LEDGER_RELATIVE_PATH,
  TicketLedgerError,
  applyTicketWorktreePatch,
  commitTicketCheckpoint,
  loadTicketLedgerAtRef,
  loadTicketLedgerFromWorktree,
  prepareTicketCheckpoint,
  type TicketDocument,
  type TicketLedgerCheckpointSelection,
  type TicketLedgerPatchExpectedSource,
  type TicketLedgerSnapshot,
} from "../src/index.js";

const NOW = "2026-07-29T08:00:00.000Z";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });

const document = (ticketId: string, outcome: string): TicketDocument => ({
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
  relations: [],
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

const selectionFor = (
  snapshot: TicketLedgerSnapshot,
  changedPaths: readonly string[],
): TicketLedgerCheckpointSelection => ({
  source: expectedSource(snapshot),
  changedPaths,
});

const setup = (): string => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), "vibehub-ticket-checkpoint-"),
  );
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Ticket Checkpoint Test");
  git(repository, "config", "user.email", "ticket-checkpoint@example.test");
  fs.writeFileSync(path.join(repository, "README.md"), "# checkpoint fixture\n");
  fs.writeFileSync(path.join(repository, "code.ts"), "export const value = 1;\n");
  const ledgerRoot = path.join(repository, ".vibehub", "tickets");
  fs.mkdirSync(ledgerRoot, { recursive: true });
  fs.writeFileSync(path.join(ledgerRoot, "protocol.yaml"), [
    "schema_version: 1",
    "kind: ticket_protocol",
    "format: vibehub.ticket-ledger",
    "",
  ].join("\n"));
  git(repository, "add", "-A");
  git(repository, "commit", "-m", "seed Ticket ledger");
  return repository;
};

describe("Ticket checkpoint", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("commits only a patch selection and preserves unrelated user changes", () => {
    const repository = setup();
    roots.push(repository);
    git(repository, "switch", "-c", "feat/ticket-checkpoint");
    const beforePatchHead = git(repository, "rev-parse", "HEAD").trim();
    const patched = applyTicketWorktreePatch({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(
          loadTicketLedgerFromWorktree(repository),
        ),
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
            document: document("implement-api", "Expose the API"),
          },
        ],
      },
    });

    expect(git(repository, "rev-parse", "HEAD").trim()).toBe(beforePatchHead);
    fs.writeFileSync(
      path.join(repository, "code.ts"),
      "export const value = 2;\n",
    );
    git(repository, "add", "code.ts");
    fs.appendFileSync(path.join(repository, "README.md"), "working note\n");

    const receipt = prepareTicketCheckpoint({
      repoRoot: repository,
      checkpointSelection: patched.checkpointSelection,
    });
    expect(receipt).toMatchObject({
      branch: "feat/ticket-checkpoint",
      headSha: beforePatchHead,
      sourceToken: patched.after.sourceToken,
      worktreeIdentity: patched.after.worktreeIdentity,
      graphDigest: patched.after.graphDigest,
    });
    const result = commitTicketCheckpoint({
      repoRoot: repository,
      receipt,
      actor: "agent:codex",
      taskId: "task:ticket-checkpoint",
      requestId: "request:ticket-checkpoint-1",
      now: NOW,
    });

    expect(result).toMatchObject({
      status: "committed",
      beforeHeadSha: beforePatchHead,
      graphDigest: receipt.graphDigest,
      changedPaths: receipt.changedPaths,
    });
    expect(
      git(repository, "show", "--format=", "--name-only", "HEAD")
        .trim()
        .split("\n"),
    ).toEqual(receipt.changedPaths);
    expect(git(repository, "diff", "--cached", "--name-only").trim())
      .toBe("code.ts");
    expect(git(repository, "diff", "--name-only").trim()).toBe("README.md");
    expect(git(repository, "show", "-s", "--format=%B", "HEAD")).toContain(
      `VibeHub-Ticket-Semantic-Ledger-Digest: ${receipt.semanticLedgerDigest}`,
    );
    expect(`sha256:${loadTicketLedgerAtRef(repository, "HEAD").graphDigest}`)
      .toBe(receipt.graphDigest);

    const clean = loadTicketLedgerFromWorktree(repository);
    const noopReceipt = prepareTicketCheckpoint({
      repoRoot: repository,
      checkpointSelection: selectionFor(clean, []),
    });
    expect(commitTicketCheckpoint({
      repoRoot: repository,
      receipt: noopReceipt,
      actor: "agent:codex",
      requestId: "request:ticket-checkpoint-2",
      now: NOW,
    })).toMatchObject({
      status: "noop",
      commitSha: result.commitSha,
    });
  });

  it("rejects protected branches, stale sources, and stale receipts", () => {
    const repository = setup();
    roots.push(repository);
    const patched = applyTicketWorktreePatch({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(
          loadTicketLedgerFromWorktree(repository),
        ),
        changes: [{
          op: "put",
          ticketId: "design-schema",
          expectedTicketRevision: null,
          document: document("design-schema", "Freeze the schema"),
        }],
      },
    });
    expect(() => prepareTicketCheckpoint({
      repoRoot: repository,
      checkpointSelection: patched.checkpointSelection,
    })).toThrow(/protected branch/u);

    git(repository, "switch", "-c", "feat/stale-ticket-checkpoint");
    const receipt = prepareTicketCheckpoint({
      repoRoot: repository,
      checkpointSelection: patched.checkpointSelection,
    });
    fs.appendFileSync(
      path.join(
        repository,
        TICKET_LEDGER_RELATIVE_PATH,
        "tickets",
        "design-schema.yaml",
      ),
      "# formatting drift\n",
    );
    try {
      commitTicketCheckpoint({
        repoRoot: repository,
        receipt,
        actor: "agent:codex",
        requestId: "request:stale-ticket-checkpoint",
        now: NOW,
      });
      throw new Error("expected stale Ticket source");
    } catch (error) {
      expect(error).toBeInstanceOf(TicketLedgerError);
      expect((error as TicketLedgerError).code).toBe("stale_source");
    }
    expect(git(repository, "rev-parse", "HEAD").trim()).toBe(receipt.headSha);
  });

  it("fails closed when the selected patch paths omit other Ticket dirt", () => {
    const repository = setup();
    roots.push(repository);
    git(repository, "switch", "-c", "feat/exact-ticket-selection");
    const first = applyTicketWorktreePatch({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(
          loadTicketLedgerFromWorktree(repository),
        ),
        changes: [{
          op: "put",
          ticketId: "design-schema",
          expectedTicketRevision: null,
          document: document("design-schema", "Freeze the schema"),
        }],
      },
    });
    const second = applyTicketWorktreePatch({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(
          loadTicketLedgerFromWorktree(repository),
        ),
        changes: [{
          op: "put",
          ticketId: "implement-api",
          expectedTicketRevision: null,
          document: document("implement-api", "Expose the API"),
        }],
      },
    });
    const current = loadTicketLedgerFromWorktree(repository);
    const incompleteSelection = selectionFor(
      current,
      first.checkpointSelection.changedPaths,
    );
    expect(() => prepareTicketCheckpoint({
      repoRoot: repository,
      checkpointSelection: incompleteSelection,
    })).toThrow(/path selection is stale/u);
    expect(git(repository, "rev-parse", "HEAD").trim())
      .toBe(second.before.resolvedCommit);
  });

  it("rejects a candidate commit whose Git clean filter changes raw Ticket bytes", () => {
    const repository = setup();
    roots.push(repository);
    const filterPath = path.join(repository, "append-ticket-comment.mjs");
    fs.writeFileSync(filterPath, [
      "#!/usr/bin/env node",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(`${input}# filtered by Git\\n`);",
      "});",
      "",
    ].join("\n"));
    fs.chmodSync(filterPath, 0o755);
    fs.writeFileSync(
      path.join(repository, ".gitattributes"),
      ".vibehub/tickets/tickets/*.yaml filter=ticket-clean\n",
    );
    git(repository, "config", "filter.ticket-clean.clean",
      "./append-ticket-comment.mjs");
    git(repository, "config", "filter.ticket-clean.required", "true");
    git(repository, "add", ".gitattributes", "append-ticket-comment.mjs");
    git(repository, "commit", "-m", "configure Ticket clean filter");
    git(repository, "switch", "-c", "feat/raw-checkpoint-candidate");

    const patched = applyTicketWorktreePatch({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(
          loadTicketLedgerFromWorktree(repository),
        ),
        changes: [{
          op: "put",
          ticketId: "design-schema",
          expectedTicketRevision: null,
          document: document("design-schema", "Freeze the schema"),
        }],
      },
    });
    const receipt = prepareTicketCheckpoint({
      repoRoot: repository,
      checkpointSelection: patched.checkpointSelection,
    });
    const before = git(repository, "rev-parse", "HEAD").trim();
    expect(() => commitTicketCheckpoint({
      repoRoot: repository,
      receipt,
      actor: "agent:codex",
      requestId: "request:filtered-ticket-checkpoint",
      now: NOW,
    })).toThrow(/candidate commit source mismatch/u);
    expect(git(repository, "rev-parse", "HEAD").trim()).toBe(before);
  });
});
