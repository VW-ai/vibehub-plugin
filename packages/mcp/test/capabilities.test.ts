import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  OperationDispatcher,
  openDb,
  operationInputSchemas,
  readScopePatterns,
  readTask,
  upsertRepo,
  upsertTask,
  type Db,
} from "@vw-ai/vibehub-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCapabilities,
  TICKET_OPERATION_NAMES,
} from "../src/capabilities.js";
import {
  createWorkbenchMcpServer,
  operationEnvelopeResult,
  WORKBENCH_MCP_TOOL_NAMES,
} from "../src/server.js";
import {
  openRuntimeContext,
  openRuntimeContextForClient,
  openRuntimeContextFromRoots,
} from "../src/runtime.js";

const NOW = "2026-07-12T10:00:00.000Z";
const toolText = (value: unknown): string =>
  (value as { content: Array<{ type: "text"; text: string }> }).content[0]!.text;

describe("local MCP deterministic capabilities", () => {
  let dir: string;
  let repo: string;
  let db: Db;
  let commit: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-mcp-"));
    repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    fs.writeFileSync(path.join(repo, "README.md"), "test\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo });
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    db = openDb(path.join(dir, "t.db"));
    upsertRepo(db, repo, null, "main", NOW);
    upsertTask(db, {
      id: "branch:feat/mcp",
      repoId: 1,
      title: "mcp",
      state: "running",
      signalTier: "hooks",
      branch: "feat/mcp",
      worktreePath: null,
      prNumber: null,
      prState: null,
      stateSince: NOW,
      lastEventAt: NOW,
      statusDetail: null,
      createdAt: NOW,
      startHeadSha: commit,
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("register_scope stores raw globs rather than territory ids", () => {
    const api = createCapabilities({
      db,
      repoId: 1,
      taskId: "branch:feat/mcp",
      now: () => NOW,
    });
    api.registerScope({
      status: "building MCP",
      write: [{ glob: "packages/mcp/**", label: "MCP" }],
      read: [{ glob: "META/09-ticket-runtime/**" }],
    });
    expect(readScopePatterns(db, "branch:feat/mcp").map((item) => item.glob))
      .toEqual(["packages/mcp/**", "META/09-ticket-runtime/**"]);
  });

  it("resolves task capabilities only inside the owning repository", () => {
    const other = upsertRepo(
      db,
      path.join(dir, "other"),
      null,
      "main",
      NOW,
    );
    const owner = createCapabilities({
      db,
      repoId: 1,
      taskId: "branch:feat/mcp",
      now: () => NOW,
    });
    const nonOwner = createCapabilities({
      db,
      repoId: other.id,
      taskId: "branch:feat/mcp",
      now: () => NOW,
    });
    expect(owner.selfReport({ status: "owned" }))
      .toMatchObject({ status: "owned" });
    expect(() => nonOwner.selfReport({ status: "not-owned" }))
      .toThrow(/missing task/);
  });

  it("advertises only honest tools and canonical adapters", () => {
    const server = createWorkbenchMcpServer({
      db,
      repoId: 1,
      taskId: "branch:feat/mcp",
      actor: "mcp-test",
      now: () => NOW,
    });
    const registered = (server as unknown as {
      _registeredTools: Record<string, { description?: string }>;
    })._registeredTools;
    expect(Object.keys(registered)).toEqual([...WORKBENCH_MCP_TOOL_NAMES]);
    expect(registered).not.toHaveProperty("kb_record");
    expect(Object.values(registered).map((tool) => tool.description ?? "")
      .join("\n")).not.toMatch(/compatibility name|trusted authority/i);
    const api = createCapabilities({
      db,
      repoId: 1,
      taskId: "branch:feat/mcp",
      actor: "mcp-test",
      requestId: () => "mcp-kb-write",
      now: () => NOW,
    });
    const kb = api.dispatchKnowledge("kb.spec.apply", {
      idempotencyKey: "mcp-write",
      specs: [{
        id: "mcp-contract",
        type: "contract",
        summary: "MCP persists through the canonical dispatcher",
        evidence: [{
          sourceType: "test",
          sourceRef: "mcp",
          evidenceRef: "fixture",
        }],
      }],
    });
    expect(kb).toMatchObject({ ok: true });
    expect(operationEnvelopeResult(kb).isError).toBe(false);
  });

  it("exposes Git-native Ticket reads and exact patching without repo/task rows", async () => {
    writeTicketLedger(repo);
    execFileSync("git", ["add", ".vibehub/tickets"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "ticket ledger"], { cwd: repo });
    const ticketDb = openDb(path.join(dir, "ticket-only.db"));
    const server = createWorkbenchMcpServer({
      db: ticketDb,
      repoId: 1,
      taskId: "missing-task",
      repoRoot: repo,
      actor: "mcp-test",
      now: () => NOW,
    });
    const client = new Client({
      name: "ticket-operation-test",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const listed = await client.listTools();
      const ticketTool = listed.tools.find(
        (tool) => tool.name === "ticket_operation",
      );
      const ticketSchema = ticketTool?.inputSchema as {
        properties?: { operation?: { enum?: unknown[] } };
      };
      expect(TICKET_OPERATION_NAMES).toEqual([
        "ticket.graph.snapshot",
        "ticket.subject.inspect",
        "ticket.trace.list",
        "ticket.worktree.patch",
      ]);
      expect(ticketSchema.properties?.operation?.enum)
        .toEqual([...TICKET_OPERATION_NAMES]);
      expect([...TICKET_OPERATION_NAMES].sort()).toEqual(
        Object.keys(operationInputSchemas)
          .filter((operation) => operation.startsWith("ticket."))
          .sort(),
      );
      expect(ticketTool?.description).toMatch(/Git-native Ticket graph/);
      expect(ticketTool?.description).toMatch(/exact-base worktree patch/i);
      expect(ticketTool?.description).not.toMatch(/proposal|authority/i);

      const graphResult = await client.callTool({
        name: "ticket_operation",
        arguments: {
          operation: "ticket.graph.snapshot",
          requestId: "ticket-success",
          input: { pageSize: 10 },
        },
      });
      expect(graphResult.isError).toBe(false);
      const graph = JSON.parse(toolText(graphResult));
      expect(graph).toMatchObject({
        ok: true,
        data: {
          schemaVersion: 2,
          source: {
            mode: "worktree",
            semanticDirty: false,
          },
          tickets: [{
            ticketId: "read-ticket-graph",
            ticketRevision: expect.any(String),
          }],
        },
        meta: {
          operation: "ticket.graph.snapshot",
          requestId: "ticket-success",
        },
      });

      const inspect = await client.callTool({
        name: "ticket_operation",
        arguments: {
          operation: "ticket.subject.inspect",
          requestId: "ticket-inspect",
          input: {
            snapshotId: graph.data.snapshotId,
            subject: {
              kind: "ticket",
              ticketId: "read-ticket-graph",
            },
          },
        },
      });
      expect(inspect.isError).toBe(false);
      expect(JSON.parse(toolText(inspect))).toMatchObject({
        ok: true,
        data: {
          subject: {
            kind: "ticket",
            contextPackage: {
              context: "Read current Ticket documents directly from Git.",
            },
          },
        },
      });

      const patch = await client.callTool({
        name: "ticket_operation",
        arguments: {
          operation: "ticket.worktree.patch",
          requestId: "ticket-patch",
          input: {
            expectedSource: {
              sourceToken: graph.data.source.sourceToken,
              worktreeIdentity: graph.data.source.worktreeIdentity,
              resolvedCommit: graph.data.source.resolvedCommit,
              graphDigest: graph.data.source.graphDigest,
            },
            changes: [{
              op: "put",
              ticketId: "read-ticket-graph",
              expectedTicketRevision:
                graph.data.tickets[0].ticketRevision,
              document: {
                schema_version: 1,
                kind: "ticket",
                ticket_id: "read-ticket-graph",
                outcome: "Patch the current Ticket graph exactly",
                context: "Use the trusted MCP workspace path.",
                acceptance: [],
                constraints: [],
                context_refs: [],
                relations: [],
                provenance_refs: [],
              },
            }],
          },
        },
      });
      expect(patch.isError).toBe(false);
      expect(JSON.parse(toolText(patch))).toMatchObject({
        ok: true,
        data: {
          status: "applied",
          changedPaths: [
            ".vibehub/tickets/tickets/read-ticket-graph.yaml",
          ],
        },
      });

      expect(ticketDb.prepare(
        `SELECT COUNT(*) count
           FROM operation_request_receipts
          WHERE operation LIKE 'ticket.%'`,
      ).get()).toEqual({ count: 0 });
      expect(readTask(ticketDb, "missing-task")).toBeNull();
    } finally {
      await Promise.all([client.close(), server.close()]);
      ticketDb.close();
    }
  });

  it("keeps direct capability dispatch inside its operation family", () => {
    const api = createCapabilities({
      db,
      repoId: 1,
      taskId: "branch:feat/mcp",
      actor: "mcp-test",
      now: () => NOW,
    });
    expect(api.dispatchKnowledge(
      "distill.run.status",
      { runId: "x" },
    )).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_operation",
        details: { expectedPrefix: "kb." },
      },
    });
    expect(api.dispatchTicket(
      "ticket.proposal.submit" as never,
      {},
    )).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_operation",
        details: { expectedOperations: [...TICKET_OPERATION_NAMES] },
      },
    });
  });

  it("preserves exact dispatcher envelopes for canonical reads", () => {
    const api = createCapabilities({
      db,
      repoId: 1,
      taskId: "branch:feat/mcp",
      actor: "mcp-test",
      requestId: () => "r-read",
      now: () => NOW,
    });
    expect(api.dispatchKnowledge("kb.spec.search", { query: "MCP" })).toEqual(
      new OperationDispatcher(db).dispatch(
        "kb.spec.search",
        {
          repoId: 1,
          actor: "mcp-test",
          taskId: "branch:feat/mcp",
          requestId: "r-read",
          now: NOW,
        },
        { query: "MCP" },
      ),
    );
  });

  it("self_report remains task-scoped and the manual is reference-only", () => {
    const api = createCapabilities({
      db,
      repoId: 1,
      taskId: "branch:feat/mcp",
      now: () => NOW,
    });
    expect(api.selfReport({
      status: "MCP ready",
      done: "Ticket read cut",
    })).toMatchObject({
      status: "MCP ready",
      done: "Ticket read cut",
    });
    expect(api.getManual().text).toMatch(/skills own semantic workflow/);
  });

  it("derives repo and task from the server cwd", () => {
    const runtime = openRuntimeContext(repo, path.join(dir, "runtime.db"));
    try {
      expect(runtime.context.repoRoot).toBe(fs.realpathSync(repo));
      expect(runtime.context.repoId).toBe(1);
      expect(readTask(runtime.context.db, runtime.context.taskId))
        .toMatchObject({ repoId: 1 });
    } finally {
      runtime.close();
    }
  });

  it("derives one MCP file root and rejects ambiguity", () => {
    const runtime = openRuntimeContextFromRoots(
      [{ uri: pathToFileURL(repo).href }],
      path.join(dir, "roots.db"),
    );
    try {
      expect(runtime.context.repoRoot).toBe(fs.realpathSync(repo));
    } finally {
      runtime.close();
    }
    const otherRepo = path.join(dir, "other-repo");
    fs.mkdirSync(otherRepo);
    execFileSync("git", ["init", "-q"], { cwd: otherRepo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: otherRepo });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: otherRepo,
    });
    fs.writeFileSync(path.join(otherRepo, "README.md"), "other\n");
    execFileSync("git", ["add", "README.md"], { cwd: otherRepo });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: otherRepo });
    expect(() => openRuntimeContextFromRoots([
      { uri: pathToFileURL(repo).href },
      { uri: pathToFileURL(otherRepo).href },
    ], path.join(dir, "ambiguous.db"))).toThrow(/exactly one Git workspace root/);
  });

  it("falls back to cwd only for explicit roots/list MethodNotFound", async () => {
    const runtime = await openRuntimeContextForClient({
      supportsRoots: false,
      listRoots: async () => {
        throw Object.assign(new Error("unsupported"), { code: -32601 });
      },
      cwd: repo,
      dbPath: path.join(dir, "fallback.db"),
    });
    try {
      expect(runtime.context.repoRoot).toBe(fs.realpathSync(repo));
    } finally {
      runtime.close();
    }
    await expect(openRuntimeContextForClient({
      supportsRoots: true,
      listRoots: async () => {
        throw Object.assign(new Error("broken"), { code: -32603 });
      },
      cwd: repo,
      dbPath: path.join(dir, "no-fallback.db"),
    })).rejects.toThrow("broken");
  });
});

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
  fs.writeFileSync(path.join(tickets, "read-ticket-graph.yaml"), [
    "schema_version: 1",
    "kind: ticket",
    "ticket_id: read-ticket-graph",
    "outcome: Read the current Ticket graph",
    "context: Read current Ticket documents directly from Git.",
    "acceptance:",
    "  - acceptance_id: mcp",
    "    criterion: MCP returns the same graph as Core.",
    "constraints: []",
    "context_refs: []",
    "relations: []",
    "provenance_refs:",
    "  - test:mcp",
    "",
  ].join("\n"));
}
