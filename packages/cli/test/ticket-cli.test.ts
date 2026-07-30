import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.js";

interface Invocation {
  status: number;
  raw: string;
  envelope: Record<string, any>;
}

describe("vibehub ticket Git-native adapter", () => {
  let root: string;
  let repo: string;
  let dbPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vh-cli-ticket-"));
    repo = makeRepository(root, "repo-a");
    dbPath = path.join(root, "runtime.db");
    writeTicketLedger(repo);
    execFileSync("git", ["add", ".vibehub/tickets"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "ticket ledger"], { cwd: repo });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads the current graph without a persisted repository or task row", () => {
    expect(fs.existsSync(dbPath)).toBe(false);
    const result = invoke([
      "ticket",
      "graph.snapshot",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "cli-test",
      "--request",
      "ticket-current-graph",
    ]);
    expect(result.status).toBe(0);
    expect(result.envelope).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 2,
        source: {
          mode: "worktree",
          worktreeRoot: repo,
          semanticDirty: false,
        },
        tickets: expect.arrayContaining([
          expect.objectContaining({
            ticketId: "implement-api",
            ticketRevision: expect.any(String),
          }),
        ]),
      },
      meta: {
        operation: "ticket.graph.snapshot",
        requestId: "ticket-current-graph",
      },
    });
    expect(result.raw).toBe(`${JSON.stringify(result.envelope)}\n`);
  });

  it("accepts both group-relative and fully-qualified read names", () => {
    for (const [operation, requestId] of [
      ["graph.snapshot", "ticket-short-name"],
      ["ticket.graph.snapshot", "ticket-full-name"],
    ] as const) {
      const result = invoke([
        "ticket",
        operation,
        "--json",
        "--repo",
        repo,
        "--db",
        dbPath,
        "--actor",
        "cli-test",
        "--request",
        requestId,
      ]);
      expect(result.status).toBe(0);
      expect(result.envelope).toMatchObject({
        ok: true,
        data: { schemaVersion: 2 },
      });
    }
  });

  it("returns the complete executable context package and an empty M1A trace", () => {
    const graph = invoke([
      "ticket",
      "graph.snapshot",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "cli-test",
      "--request",
      "ticket-context:graph",
    ]);
    const snapshotId = graph.envelope.data.snapshotId as string;
    const input = {
      snapshotId,
      subject: { kind: "ticket", ticketId: "implement-api" },
    };
    const inspected = invoke([
      "ticket",
      "subject.inspect",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "cli-test",
      "--request",
      "ticket-context:inspect",
      "--input",
      JSON.stringify(input),
    ]);
    expect(inspected.status).toBe(0);
    expect(inspected.envelope).toMatchObject({
      ok: true,
      data: {
        subject: {
          kind: "ticket",
          ticket: {
            ticketId: "implement-api",
            ticketRevision: expect.any(String),
          },
          contextPackage: {
            outcome: "Expose the accepted API",
            context: "Implement the endpoint against the accepted schema.",
            acceptance: [{
              acceptanceId: "response",
              criterion: "The endpoint returns the canonical response.",
            }],
            relations: [{
              type: "depends_on",
              targetTicketId: "design-schema",
            }],
          },
        },
      },
    });

    const trace = invoke([
      "ticket",
      "trace.list",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "cli-test",
      "--request",
      "ticket-context:trace",
      "--input",
      JSON.stringify(input),
    ]);
    expect(trace.status).toBe(0);
    expect(trace.envelope).toMatchObject({
      ok: true,
      data: {
        subject: input.subject,
        records: [],
        nextCursor: null,
      },
    });
  });

  it("applies an exact-base worktree patch without repository initialization", () => {
    const graph = invoke([
      "ticket",
      "graph.snapshot",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "cli-test",
      "--request",
      "ticket-patch:base",
    ]);
    const source = graph.envelope.data.source as Record<string, string>;
    const target = (graph.envelope.data.tickets as Array<Record<string, string>>)
      .find((ticket) => ticket.ticketId === "implement-api");
    if (!target) throw new Error("missing implement-api");
    const patched = invoke([
      "ticket",
      "worktree.patch",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "cli-test",
      "--request",
      "ticket-patch:apply",
      "--input",
      JSON.stringify({
        expectedSource: {
          sourceToken: source.sourceToken,
          worktreeIdentity: source.worktreeIdentity,
          resolvedCommit: source.resolvedCommit,
          graphDigest: source.graphDigest,
        },
        changes: [{
          op: "put",
          ticketId: "implement-api",
          expectedTicketRevision: target.ticketRevision,
          document: {
            schema_version: 1,
            kind: "ticket",
            ticket_id: "implement-api",
            outcome: "Expose the exact-base API",
            context: "Apply the Skill-authored full Ticket document.",
            acceptance: [],
            constraints: [],
            context_refs: [],
            relations: [{
              type: "depends_on",
              target_ticket_id: "design-schema",
            }],
            provenance_refs: [],
          },
        }],
      }),
    ]);
    expect(patched.status).toBe(0);
    expect(patched.envelope).toMatchObject({
      ok: true,
      data: {
        status: "applied",
        changedPaths: [
          ".vibehub/tickets/tickets/implement-api.yaml",
        ],
      },
      meta: { operation: "ticket.worktree.patch" },
    });
    const refreshed = invoke([
      "ticket",
      "graph.snapshot",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "cli-test",
      "--request",
      "ticket-patch:refreshed",
    ]);
    expect(refreshed.envelope.data.tickets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ticketId: "implement-api",
        outcome: "Expose the exact-base API",
      }),
    ]));
  });

  it("optionally checkpoints only the exact Ticket patch selection", () => {
    execFileSync("git", ["switch", "-c", "feat/ticket-checkpoint"], {
      cwd: repo,
    });
    const graph = invoke([
      "ticket",
      "graph.snapshot",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "cli-test",
    ]);
    const source = graph.envelope.data.source as Record<string, string>;
    const target = (graph.envelope.data.tickets as Array<Record<string, string>>)
      .find((ticket) => ticket.ticketId === "implement-api");
    if (!target) throw new Error("missing implement-api");
    const patch = invoke([
      "ticket",
      "worktree.patch",
      "--json",
      "--repo",
      repo,
      "--db",
      dbPath,
      "--actor",
      "cli-test",
      "--input",
      JSON.stringify({
        expectedSource: {
          sourceToken: source.sourceToken,
          worktreeIdentity: source.worktreeIdentity,
          resolvedCommit: source.resolvedCommit,
          graphDigest: source.graphDigest,
        },
        changes: [{
          op: "put",
          ticketId: "implement-api",
          expectedTicketRevision: target.ticketRevision,
          document: {
            schema_version: 1,
            kind: "ticket",
            ticket_id: "implement-api",
            outcome: "Checkpoint this exact Ticket update",
            context: "Keep checkpointing separate from worktree mutation.",
            acceptance: [],
            constraints: [],
            context_refs: [],
            relations: [{
              type: "depends_on",
              target_ticket_id: "design-schema",
            }],
            provenance_refs: [],
          },
        }],
      }),
    ]);
    const prepared = invoke([
      "checkpoint",
      "prepare",
      "--scope",
      "ticket",
      "--json",
      "--repo",
      repo,
      "--input",
      JSON.stringify(patch.envelope.data.checkpointSelection),
    ]);
    expect(prepared.status).toBe(0);
    expect(prepared.envelope).toMatchObject({
      ok: true,
      data: {
        branch: "feat/ticket-checkpoint",
        changedPaths: [
          ".vibehub/tickets/tickets/implement-api.yaml",
        ],
      },
    });
    const committed = invoke([
      "checkpoint",
      "commit",
      "--scope",
      "ticket",
      "--json",
      "--repo",
      repo,
      "--actor",
      "cli-test",
      "--task",
      "ticket-checkpoint-test",
      "--request",
      "ticket-checkpoint-test:commit",
      "--input",
      JSON.stringify(prepared.envelope.data),
    ]);
    expect(committed.status).toBe(0);
    expect(committed.envelope).toMatchObject({
      ok: true,
      data: {
        status: "committed",
        branch: "feat/ticket-checkpoint",
        changedPaths: [
          ".vibehub/tickets/tickets/implement-api.yaml",
        ],
      },
    });
    expect(execFileSync(
      "git",
      ["show", "--format=", "--name-only", "HEAD"],
      { cwd: repo, encoding: "utf8" },
    ).trim()).toBe(".vibehub/tickets/tickets/implement-api.yaml");
  });

  it("does not register retired proposal operations", () => {
    for (const operation of [
      "proposal.submit",
      "proposal.validation.record",
      "proposal.authority.decide",
      "proposal.apply",
    ]) {
      const result = invoke([
        "ticket",
        operation,
        "--json",
        "--repo",
        repo,
        "--db",
        dbPath,
        "--actor",
        "cli-test",
      ]);
      expect(result.status).toBe(2);
      expect(result.envelope).toMatchObject({
        ok: false,
        error: { code: "validation_error" },
      });
    }
  });

  it("advertises both Ticket reads and the read-only graph host", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main([])).toBe(2);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("vibehub ticket <operation> --json"),
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("vibehub ticket review [--repo <path>]"),
    );
  });

  function invoke(args: string[]): Invocation {
    let raw = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(
      ((chunk: unknown) => {
        raw += String(chunk);
        return true;
      }) as typeof process.stdout.write,
    );
    const status = main(args);
    write.mockRestore();
    return {
      status,
      raw,
      envelope: JSON.parse(raw) as Record<string, any>,
    };
  }
});

function makeRepository(parent: string, name: string): string {
  const repository = path.join(parent, name);
  fs.mkdirSync(repository);
  execFileSync("git", ["init", "-b", "main"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Ticket CLI Test"], {
    cwd: repository,
  });
  execFileSync("git", ["config", "user.email", "ticket-cli@example.test"], {
    cwd: repository,
  });
  fs.writeFileSync(path.join(repository, "README.md"), `${name}\n`);
  execFileSync("git", ["add", "README.md"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repository });
  return fs.realpathSync(repository);
}

function writeTicketLedger(repo: string): void {
  const ledger = path.join(repo, ".vibehub", "tickets");
  const tickets = path.join(ledger, "tickets");
  fs.mkdirSync(tickets, { recursive: true });
  fs.writeFileSync(path.join(ledger, "protocol.yaml"), [
    "schema_version: 1",
    "kind: ticket_protocol",
    "format: vibehub.ticket-ledger",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(tickets, "design-schema.yaml"), [
    "schema_version: 1",
    "kind: ticket",
    "ticket_id: design-schema",
    "outcome: Design the accepted schema",
    "context: Freeze the smallest schema needed by the API.",
    "acceptance: []",
    "constraints: []",
    "context_refs: []",
    "relations: []",
    "provenance_refs: []",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(tickets, "implement-api.yaml"), [
    "schema_version: 1",
    "kind: ticket",
    "ticket_id: implement-api",
    "outcome: Expose the accepted API",
    "context: Implement the endpoint against the accepted schema.",
    "acceptance:",
    "  - acceptance_id: response",
    "    criterion: The endpoint returns the canonical response.",
    "constraints:",
    "  - Keep transport concerns outside the domain model.",
    "context_refs:",
    "  - ref: META/api.md",
    "    purpose: Accepted API behavior",
    "relations:",
    "  - type: depends_on",
    "    target_ticket_id: design-schema",
    "    rationale: The endpoint follows the schema.",
    "provenance_refs:",
    "  - plan:api",
    "",
  ].join("\n"));
}
