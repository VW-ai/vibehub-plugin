import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseTicketReviewHostFlags,
  startTicketReviewHost,
  type TicketReviewHostHandle,
} from "../src/ticket-review-host.js";

const NOW = "2026-07-29T12:00:00.000Z";

describe("read-only Git Ticket review host", () => {
  let root: string;
  let repo: string;
  let dbPath: string;
  const hosts: TicketReviewHostHandle[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vh-ticket-host-"));
    repo = path.join(root, "repo");
    dbPath = path.join(root, "runtime.db");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    writeTicketLedger(repo);
    execFileSync("git", ["add", ".vibehub/tickets"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "ticket ledger"], { cwd: repo });
  });

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("opens the current worktree without a proposal selector", () => {
    expect(parseTicketReviewHostFlags([
      "--repo",
      repo,
      "--db",
      dbPath,
      "--port",
      "4321",
      "--no-open",
      "--json",
    ])).toEqual({
      repo,
      db: dbPath,
      port: 4321,
      open: false,
      json: true,
    });
    expect(() => parseTicketReviewHostFlags([
      "--proposal",
      "retired",
    ])).toThrow("unknown flag: --proposal");
    expect(() => parseTicketReviewHostFlags([
      "--port",
      "65536",
    ])).toThrow("--port must be an integer between 0 and 65535");
  });

  it("serves one current Git graph and complete executable context", async () => {
    const host = startTicketReviewHost({
      repoRoot: repo,
      dbPath,
      now: () => NOW,
      token: "t".repeat(32),
    });
    hosts.push(host);
    const { origin } = await host.ready;
    const state = await readJson(`${origin}/api/state`, host.token);
    expect(state).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 2,
        project: {
          repositoryRoot: fs.realpathSync(repo),
          worktreeRoot: fs.realpathSync(repo),
        },
        graph: {
          source: {
            mode: "worktree",
            worktreeRoot: fs.realpathSync(repo),
            worktreeIdentity: expect.any(String),
            semanticDirty: false,
          },
          tickets: expect.arrayContaining([
            expect.objectContaining({
              ticketId: "implement-api",
              ticketRevision: expect.any(String),
              outcome: "Expose the accepted API",
            }),
          ]),
          relations: [
            expect.objectContaining({
              prerequisiteTicketId: "design-schema",
              dependentTicketId: "implement-api",
            }),
          ],
        },
      },
    });
    const snapshotId = state.data.graph.snapshotId as string;
    const subject = await readJson(
      `${origin}/api/subject?${new URLSearchParams({
        snapshotId,
        kind: "ticket",
        ticketId: "implement-api",
      })}`,
      host.token,
    );
    expect(subject).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 2,
        subject: {
          kind: "ticket",
          ticket: {
            ticketId: "implement-api",
            ticketRevision: expect.any(String),
          },
          contextPackage: {
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
  });

  it("reports the branch from each fresh graph source after startup", async () => {
    const host = startTicketReviewHost({
      repoRoot: repo,
      dbPath,
      token: "b".repeat(32),
    });
    hosts.push(host);
    const { origin } = await host.ready;

    const initial = await readJson(`${origin}/api/state`, host.token);
    expect(initial.data.project.branch).toBe(initial.data.graph.source.branch);

    execFileSync("git", ["switch", "-q", "-c", "after-host-start"], {
      cwd: repo,
    });
    const switched = await readJson(`${origin}/api/state`, host.token);
    expect(switched.data.project.branch).toBe("after-host-start");
    expect(switched.data.graph.source.branch).toBe("after-host-start");

    execFileSync("git", ["switch", "--detach", "-q"], { cwd: repo });
    const detached = await readJson(`${origin}/api/state`, host.token);
    expect(detached.data.graph.source.branch).toBeNull();
    expect(detached.data.project.branch).toBe("detached");
  });

  it("collects the maximum contract-sized graph without exhausting its page budget", async () => {
    writeMaximumTicketLedger(repo);
    const host = startTicketReviewHost({
      repoRoot: repo,
      dbPath,
      token: "m".repeat(32),
    });
    hosts.push(host);
    const { origin } = await host.ready;

    const state = await readJson(`${origin}/api/state`, host.token);
    expect(state.data.graph.tickets).toHaveLength(1_000);
    expect(state.data.graph.relations).toHaveLength(5_000);
  }, 30_000);

  it("keeps the loopback bearer boundary and exposes no mutation route", async () => {
    const host = startTicketReviewHost({
      repoRoot: repo,
      dbPath,
      token: "s".repeat(32),
    });
    hosts.push(host);
    const { origin, port } = await host.ready;

    const health = await fetch(`${origin}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, schemaVersion: 2 });

    const unauthenticated = await fetch(`${origin}/api/state`);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({
      error: { code: "unauthorized" },
    });

    const decision = await fetch(`${origin}/api/decision`, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}` },
    });
    expect(decision.status).toBe(404);
    const apply = await fetch(`${origin}/api/apply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}` },
    });
    expect(apply.status).toBe(404);

    const foreignHost = await rawRequest(port, {
      Host: "attacker.invalid",
    });
    expect(foreignHost.status).toBe(403);
    expect(JSON.parse(foreignHost.body)).toMatchObject({
      error: { code: "host_rejected" },
    });

    const html = await (await fetch(`${origin}/`)).text();
    const script = await (await fetch(`${origin}/app.js`)).text();
    const styles = await (await fetch(`${origin}/app.css`)).text();
    expect(html).not.toMatch(/authorize|decision rationale|validation/i);
    expect(html).toContain('class="source-ref"');
    expect(html).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(script).not.toMatch(/\/api\/(?:decision|apply)/);
    expect(script).toContain("copyableWorktree(state.graph.source)");
    expect(script).toContain("navigator.clipboard.writeText(value)");
    expect(script).toContain("isCurrentSubjectResponse(");
    expect(script).toContain("inspection?.snapshotId === snapshotId");
    expect(script).toContain("inspectedSubject.ticket?.ticketId === subject.ticketId");
    expect(script).toContain(
      "inspectedSubject.relation?.relationRef === subject.relationRef",
    );
    expect(script).toMatch(
      /function renderGraphInspector\(\) \{\s*if \(!state\) return;\s*subjectRequest \+= 1;/,
    );
    expect(script).toContain("dirtyPathsTruncated");
    expect(script).toContain("Additional changed paths are not shown.");
    expect(script).toContain("minimapWorldPoint(event.clientX, event.clientY)");
    expect(script).toContain("elements.minimap.getScreenCTM()");
    expect(script).toContain("point.matrixTransform(matrix.inverse())");
    expect(script).toContain("visibleCanvasViewport()");
    expect(script).toContain("layoutGraph");
    expect(script).toContain("minimap");
    expect(script).toContain("causalCone");
    expect(styles).toContain("grid-template-rows: auto minmax(0, 1fr)");
    expect(styles).toContain("overflow-wrap: anywhere");
    expect(styles).not.toContain("height: calc(100% - 87px)");
    expect(styles).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.toolbar-tools \{\s*padding: 1px;/,
    );
    expect(styles).not.toMatch(/\.toolbar-tools \{\s*display: none;/);
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

function writeMaximumTicketLedger(repo: string): void {
  const tickets = path.join(repo, ".vibehub", "tickets", "tickets");
  fs.rmSync(tickets, { recursive: true, force: true });
  fs.mkdirSync(tickets, { recursive: true });
  for (let index = 0; index < 1_000; index += 1) {
    const ticketId = `ticket-${String(index).padStart(4, "0")}`;
    const prerequisiteOffsets = Array.from(
      { length: Math.min(index, 5) },
      (_, offset) => offset + 1,
    );
    if (index >= 6 && index <= 20) prerequisiteOffsets.push(6);
    const relations = prerequisiteOffsets.flatMap((offset) => [
      "  - type: depends_on",
      `    target_ticket_id: ticket-${String(index - offset).padStart(4, "0")}`,
    ]);
    fs.writeFileSync(path.join(tickets, `${ticketId}.yaml`), [
      "schema_version: 1",
      "kind: ticket",
      `ticket_id: ${ticketId}`,
      `outcome: Complete ${ticketId}`,
      `context: Execute ${ticketId} against its prerequisites.`,
      "acceptance: []",
      "constraints: []",
      "context_refs: []",
      ...(relations.length === 0 ? ["relations: []"] : ["relations:", ...relations]),
      "provenance_refs: []",
      "",
    ].join("\n"));
  }
}

async function readJson(url: string, token: string): Promise<any> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function rawRequest(
  port: number,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/health",
      method: "GET",
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}
