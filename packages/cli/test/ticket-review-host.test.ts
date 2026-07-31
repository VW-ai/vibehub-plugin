import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadTicketLedgerFromWorktree,
  type TicketDecisionAuthorityGrant,
} from "@vw-ai/vibehub-core";
import {
  parseTicketReviewHostFlags,
  startTicketReviewHost,
  type TicketReviewHostHandle,
} from "../src/ticket-review-host.js";
import {
  TicketLocalDecisionAuthority,
} from "../src/ticket-local-decision-authority.js";

const NOW = "2026-07-29T12:00:00.000Z";

describe("Git Ticket review host", () => {
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
    expect(() => startTicketReviewHost({
      repoRoot: repo,
      dbPath,
      token: "x".repeat(32),
      ticketReviewAttribution: {
        actorId: "human:reviewer",
        actorKind: "human",
        attribution: "host_attested",
      },
      ticketDecisionAuthority: {
        authority: {
          principal_id: "human:someone-else",
          principal_kind: "human",
          basis: "designated_human",
          basis_ref: "test",
          attestation: "host_bound_local",
        },
        scopes: [],
      },
    })).toThrow(
      "Ticket review attribution and Decision authority must bind the same human",
    );
  });

  it("serves one current Git graph with recorded context and operational state", async () => {
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
        schemaVersion: 3,
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
              ticketId: "design-schema",
              capabilities: expect.objectContaining({
                operational: expect.objectContaining({
                  availability: "available",
                  producerReceiptRef: expect.any(String),
                  summary: {
                    label: "READY",
                    detail: "All direct prerequisites have accepted current Outcomes",
                    references: [],
                  },
                }),
              }),
            }),
            expect.objectContaining({
              ticketId: "implement-api",
              ticketRevision: expect.any(String),
              outcome: "Expose the accepted API",
              capabilities: expect.objectContaining({
                operational: expect.objectContaining({
                  availability: "available",
                  producerReceiptRef: expect.any(String),
                  summary: {
                    label: "BLOCKED",
                    detail: "Waiting for 1 prerequisite",
                    references: [{
                      ref: "design-schema",
                      label: "Blocking prerequisite",
                    }],
                  },
                }),
              }),
            }),
          ]),
          relations: [
            expect.objectContaining({
              prerequisiteTicketId: "design-schema",
              dependentTicketId: "implement-api",
            }),
          ],
        },
        interventions: {
          review: { available: false },
          planReview: { available: false },
          protectedBoundaries: [],
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
        schemaVersion: 3,
        subject: {
          kind: "ticket",
          ticket: {
            ticketId: "implement-api",
            ticketRevision: expect.any(String),
            capabilities: {
              operational: {
                availability: "available",
                summary: {
                  label: "BLOCKED",
                  references: [{
                    ref: "design-schema",
                  }],
                },
              },
            },
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

  it("keeps the loopback bearer boundary on reads and writes", async () => {
    const host = startTicketReviewHost({
      repoRoot: repo,
      dbPath,
      token: "s".repeat(32),
    });
    hosts.push(host);
    const { origin, port } = await host.ready;

    const health = await fetch(`${origin}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("access-control-allow-origin")).toBeNull();
    expect(await health.json()).toEqual({ ok: true, schemaVersion: 3 });

    const unauthenticated = await fetch(`${origin}/api/state`);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({
      error: { code: "unauthorized" },
    });

    const decision = await fetch(`${origin}/api/decision`, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}` },
    });
    expect(decision.status).toBe(403);
    expect(await decision.json()).toMatchObject({
      error: { code: "origin_rejected" },
    });
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
    const retiredWebAuthnAsset = await fetch(`${origin}/webauthn.js`);
    expect(retiredWebAuthnAsset.status).toBe(404);
    expect(html).not.toMatch(/authorize|decision rationale|validation/i);
    expect(html).not.toContain("/webauthn.js");
    expect(html).not.toMatch(
      /complete executable context|\.vibehub\/tickets\/tickets|add documents/i,
    );
    expect(html).toContain(
      "Select a Ticket to inspect its current state, context, and trace.",
    );
    expect(html).toContain('class="source-ref"');
    expect(html).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(script).toContain('route: "/api/review"');
    expect(script).toContain('route: "/api/decision"');
    expect(script).toContain("Recording exact decision…");
    expect(script).toContain("`Receipt · ${receiptPath}`");
    expect(script).not.toMatch(
      /SimpleWebAuthn|webauthn-|\/api\/decision\/challenge/,
    );
    expect(script).not.toMatch(/\/api\/apply/);
    expect(script).toContain("semanticLedgerDigest: source.semanticLedgerDigest");
    expect(script).toContain("Your draft is preserved");
    expect(script).toContain("state.interventions");
    expect(script).toContain("activeActionKey = draftKey");
    expect(script).toContain("traceSubjectMatches");
    expect(script).toContain("traceDecisionDetails(record.decision)");
    expect(script).toContain("ticketOperationalState(ticket)");
    expect(script).toContain("executionStateView(ticket)");
    expect(script).toContain('"READY"');
    expect(script).toContain('"DONE"');
    expect(script).toContain('"BLOCKED"');
    expect(script).toContain('"DEVIATED"');
    expect(script).toContain('record.kind !== "outcome"');
    expect(script).not.toMatch(
      /context a fresh Agent receives|Reading executable context|Reading review facts|No review facts/i,
    );
    expect(styles).toContain(".ticket-node.state-deviated");
    expect(styles).toContain(".execution-state.state-done");
    expect(styles).toContain(".trace-row.trace-deviated");
    expect(script).toContain('append("Boundary", decision.boundary)');
    expect(script).toContain('append("Selection", decision.selection)');
    expect(script).toContain(
      'append("Delegated boundaries", decision.delegatedBoundaries)',
    );
    expect(script).toContain('append("Resolution refs", decision.resolutionRefs)');
    expect(script).toContain("replacementTicket(");
    expect(script).toContain("copyableWorktree(state.graph.source)");
    expect(script).toContain("navigator.clipboard.writeText(value)");
    expect(script).toContain("isCurrentSubjectResponse(");
    expect(script).toContain("inspection?.snapshotId === snapshotId");
    expect(script).toContain("inspectedSubject.ticket?.ticketId === subject.ticketId");
    expect(script).toContain(
      "inspectedSubject.relation?.relationRef === subject.relationRef",
    );
    expect(script).toMatch(
      /function renderGraphInspector\(\) \{\s*if \(!state\) return;\s*const request = \+\+subjectRequest;/,
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
    expect(styles).toMatch(
      /\.trace-decision dd \{[\s\S]*?white-space: pre-wrap;/,
    );
    expect(styles).not.toContain("height: calc(100% - 87px)");
    expect(styles).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.toolbar-tools \{\s*padding: 1px;/,
    );
    expect(styles).not.toMatch(/\.toolbar-tools \{\s*display: none;/);
  });

  it("keeps the default CLI host truly read-only", async () => {
    const host = startTicketReviewHost({
      repoRoot: repo,
      dbPath,
      token: "o".repeat(32),
    });
    hosts.push(host);
    const { origin } = await host.ready;
    const state = await readJson(`${origin}/api/state`, host.token);
    const source = state.data.graph.source;
    const denied = await postJson(
      `${origin}/api/review`,
      host.token,
      origin,
      {
        expectedSource: mutationSource(source),
        review: {
          type: "comment",
          subject: {
            kind: "graph",
            graphDigest: source.graphDigest,
          },
          body: "A bearer without trusted attribution cannot write this.",
        },
      },
    );

    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({
      error: { code: "ticket_attribution_unavailable" },
    });
    expect(loadTicketLedgerFromWorktree(repo).reviews).toEqual([]);
  });

  it("appends a host-attested review without accepting browser identity fields", async () => {
    const host = startTicketReviewHost({
      repoRoot: repo,
      dbPath,
      now: () => NOW,
      token: "r".repeat(32),
      ticketReviewAttribution: {
        actorId: "human:local-reviewer",
        actorKind: "human",
        attribution: "host_attested",
      },
    });
    hosts.push(host);
    const { origin } = await host.ready;
    const state = await readJson(`${origin}/api/state`, host.token);
    const source = state.data.graph.source;
    expect(state.data.interventions.review).toEqual({
      available: true,
      actorKind: "human",
      attribution: "host_attested",
    });
    const response = await postJson(
      `${origin}/api/review`,
      host.token,
      origin,
      {
        expectedSource: mutationSource(source),
        review: {
          type: "comment",
          subject: {
            kind: "graph",
            graphDigest: source.graphDigest,
          },
          body: "The plan preserves the intended execution boundary.",
        },
      },
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as any;
    expect(payload).toMatchObject({
      ok: true,
      data: {
        status: "applied",
        review: {
          documentPath: expect.stringMatching(
            /^\.vibehub\/tickets\/reviews\/[0-9a-f]{64}\/trv-[0-9a-f]{64}\.yaml$/u,
          ),
          document: {
            kind: "ticket_review",
            author: {
              actor_id: "human:local-reviewer",
              actor_kind: "human",
              attribution: "host_attested",
            },
            occurred_at: NOW,
          },
        },
      },
    });
    const documentPath = payload.data.review.documentPath as string;
    expect(fs.readFileSync(path.join(repo, documentPath), "utf8"))
      .toContain("actor_id: human:local-reviewer");

    const refreshed = await readJson(`${origin}/api/state`, host.token);
    const trace = await readJson(
      `${origin}/api/trace?${new URLSearchParams({
        snapshotId: refreshed.data.graph.snapshotId,
        kind: "graph",
      })}`,
      host.token,
    );
    expect(trace.data).toMatchObject({
      subject: { kind: "graph" },
      records: [
        expect.objectContaining({
          producer: {
            kind: "claimed_actor",
            ref: expect.stringMatching(/^trv-[0-9a-f]{64}$/u),
          },
          status: "current_host_attested",
          summary: "Review comment from human:local-reviewer",
        }),
      ],
      nextCursor: null,
    });

    const forged = await postJson(
      `${origin}/api/review`,
      host.token,
      origin,
      {
        expectedSource: mutationSource(refreshed.data.graph.source),
        review: {
          type: "comment",
          subject: {
            kind: "graph",
            graphDigest: refreshed.data.graph.source.graphDigest,
          },
          body: "This must not be written.",
        },
        author: { actorId: "forged" },
      },
    );
    expect(forged.status).toBe(400);
    expect(await forged.json()).toMatchObject({
      error: { code: "validation_error" },
    });
  });

  it("records only an exactly authorized Decision and fails closed by default", async () => {
    const before = loadTicketLedgerFromWorktree(repo);
    const grant: TicketDecisionAuthorityGrant = {
      authority: {
        principal_id: "human:repository-owner",
        principal_kind: "human",
        basis: "repository_owner",
        basis_ref: "ticket-review-host:test",
        attestation: "host_bound_local",
      },
      scopes: [{
        decisionType: "plan_review",
        graphDigest: `sha256:${before.graphDigest}`,
      }],
    };
    const authorized = startTicketReviewHost({
      repoRoot: repo,
      dbPath,
      now: () => NOW,
      token: "d".repeat(32),
      ticketReviewAttribution: {
        actorId: grant.authority.principal_id,
        actorKind: "human",
        attribution: "host_attested",
      },
      ticketDecisionAuthority: grant,
    });
    hosts.push(authorized);
    const { origin } = await authorized.ready;
    const state = await readJson(`${origin}/api/state`, authorized.token);
    const source = state.data.graph.source;
    expect(state.data.interventions.planReview).toEqual({
      available: true,
    });
    const recorded = await postJson(
      `${origin}/api/decision`,
      authorized.token,
      origin,
      {
        expectedSource: mutationSource(source),
        decision: {
          type: "plan_review",
          subject: {
            kind: "graph",
            graphDigest: source.graphDigest,
          },
          disposition: "approve_execution",
          rationale: "The exact reviewed graph is ready to execute.",
          resolutionRefs: [],
        },
      },
    );
    expect(recorded.status).toBe(200);
    expect(await recorded.json()).toMatchObject({
      ok: true,
      data: {
        decision: {
          documentPath: expect.stringMatching(
            /^\.vibehub\/tickets\/decisions\/[0-9a-f]{64}\.yaml$/u,
          ),
          document: {
            authority: {
              principal_id: "human:repository-owner",
              attestation: "host_bound_local",
            },
          },
        },
      },
    });

    await authorized.close();
    const noAuthority = startTicketReviewHost({
      repoRoot: repo,
      dbPath: path.join(root, "no-authority.db"),
      token: "n".repeat(32),
      ticketReviewAttribution: {
        actorId: "human:repository-owner",
        actorKind: "human",
        attribution: "host_attested",
      },
    });
    hosts.push(noAuthority);
    const noAuthorityReady = await noAuthority.ready;
    const current = await readJson(
      `${noAuthorityReady.origin}/api/state`,
      noAuthority.token,
    );
    const denied = await postJson(
      `${noAuthorityReady.origin}/api/decision`,
      noAuthority.token,
      noAuthorityReady.origin,
      {
        expectedSource: mutationSource(current.data.graph.source),
        decision: {
          type: "plan_review",
          subject: {
            kind: "graph",
            graphDigest: current.data.graph.source.graphDigest,
          },
          disposition: "request_changes",
          rationale: "This browser claim has no authority.",
          resolutionRefs: [],
        },
      },
    );
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({
      error: { code: "ticket_authority_unavailable" },
    });
  });

  it("records one local-signed Decision and exposes its receipt to a fresh host", async () => {
    const decisionNow = new Date().toISOString();
    const registryPath = path.join(
      fs.realpathSync(root),
      "trust",
      "decision-authority.v1",
      "registry.json",
    );
    const authority = new TicketLocalDecisionAuthority({
      registryPath,
      now: () => decisionNow,
    });
    const host = startTicketReviewHost({
      repoRoot: repo,
      dbPath,
      now: () => decisionNow,
      token: "a".repeat(32),
      ticketLocalDecisionAuthority: authority,
    });
    hosts.push(host);
    const { origin } = await host.ready;

    const active = await readJson(`${origin}/api/state`, host.token);
    const profile = authority.listProfiles().find(
      (candidate) => candidate.revokedAt === null,
    );
    expect(profile).toBeDefined();
    if (profile === undefined) {
      throw new Error("expected one active local Decision profile");
    }
    expect(active.data.interventions).toMatchObject({
      review: {
        available: true,
        actorKind: "human",
        attribution: "host_attested",
      },
      authority: {
        status: "active",
        principalId: profile.principalId,
        keyFingerprint: profile.keyFingerprint,
      },
      planReview: { available: true },
      protectedDecision: { available: true },
    });

    for (const retiredRoute of [
      "/api/authority/enroll/challenge",
      "/api/authority/enroll/complete",
      "/api/decision/challenge",
      "/api/decision/complete",
      "/api/authority/revoke/challenge",
      "/api/authority/revoke/complete",
    ]) {
      const retired = await postJson(
        `${origin}${retiredRoute}`,
        host.token,
        origin,
        {},
      );
      expect(retired.status, retiredRoute).toBe(404);
    }

    const attributedReview = await postJson(
      `${origin}/api/review`,
      host.token,
      origin,
      {
        expectedSource: mutationSource(active.data.graph.source),
        review: {
          type: "comment",
          subject: {
            kind: "graph",
            graphDigest: active.data.graph.source.graphDigest,
          },
          body: "The local signer also binds review attribution.",
        },
      },
    );
    expect(attributedReview.status).toBe(200);
    expect(await attributedReview.json()).toMatchObject({
      data: {
        review: {
          document: {
            author: {
              actor_id: profile.principalId,
              actor_kind: "human",
              attribution: "host_attested",
            },
          },
        },
      },
    });

    const reviewed = await readJson(`${origin}/api/state`, host.token);
    const source = reviewed.data.graph.source;
    const decisionInput = {
      expectedSource: mutationSource(source),
      decision: {
        type: "plan_review",
        subject: {
          kind: "graph",
          graphDigest: source.graphDigest,
        },
        disposition: "approve_execution",
        rationale: "The exact reviewed graph is ready to execute.",
        resolutionRefs: [],
      },
    };
    const forgedDecision = await postJson(
      `${origin}/api/decision`,
      host.token,
      origin,
      {
        ...decisionInput,
        authority: {
          principalId: "browser-forgery",
        },
        decidedAt: "2099-01-01T00:00:00.000Z",
        signature: "browser-forgery",
      },
    );
    expect(forgedDecision.status).toBe(400);
    expect(await forgedDecision.json()).toMatchObject({
      error: { code: "validation_error" },
    });

    const recorded = await postJson(
      `${origin}/api/decision`,
      host.token,
      origin,
      decisionInput,
    );
    expect(recorded.status).toBe(200);
    const completed = await recorded.json() as any;
    expect(completed).toMatchObject({
      ok: true,
      data: {
        decision: {
          document: {
            authority: {
              principal_id: profile.principalId,
              basis: "designated_human",
            },
            decided_at: decisionNow,
          },
        },
        attestation: {
          documentPath: expect.stringMatching(
            /^\.vibehub\/tickets\/attestations\/tdc-[0-9a-f]{64}\/tda-[0-9a-f]{64}\.yaml$/u,
          ),
          document: {
            authority: {
              principal_id: profile.principalId,
            },
            signer: {
              key_id: profile.keyId,
              key_fingerprint: profile.keyFingerprint,
              algorithm: "Ed25519",
            },
            confirmation: {
              method: "plugin_host_click",
            },
            issued_at: decisionNow,
            signature: expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
          },
        },
      },
    });
    const ledger = loadTicketLedgerFromWorktree(repo);
    expect(ledger.decisions).toHaveLength(1);
    expect(ledger.attestations).toHaveLength(1);
    expect(ledger.attestations[0]?.document.decision.document_digest)
      .toBe(completed.data.attestation.document.decision.document_digest);
    await host.close();
    const freshHost = startTicketReviewHost({
      repoRoot: repo,
      dbPath: path.join(root, "fresh-runtime.db"),
      now: () => decisionNow,
      token: "f".repeat(32),
      ticketLocalDecisionAuthority: new TicketLocalDecisionAuthority({
        registryPath,
        now: () => decisionNow,
      }),
    });
    hosts.push(freshHost);
    const freshReady = await freshHost.ready;
    const verifiedState = await readJson(
      `${freshReady.origin}/api/state`,
      freshHost.token,
    );
    const verifiedTrace = await readJson(
      `${freshReady.origin}/api/trace?${new URLSearchParams({
        snapshotId: verifiedState.data.graph.snapshotId,
        kind: "graph",
      })}`,
      freshHost.token,
    );
    expect(verifiedTrace.data.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "gate_decision",
        status: "current",
        producer: {
          kind: "authority_receipt",
          ref: completed.data.attestation.document.attestation_id,
        },
      }),
    ]));

    const stale = await postJson(
      `${freshReady.origin}/api/decision`,
      freshHost.token,
      freshReady.origin,
      {
        ...decisionInput,
        decision: {
          ...decisionInput.decision,
          disposition: "request_changes",
          rationale: "This stale source must not authorize a new Decision.",
        },
      },
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "ticket_ledger_stale_source" },
    });
    expect(loadTicketLedgerFromWorktree(repo).attestations).toHaveLength(1);

    const protectedTicket = verifiedState.data.graph.tickets.find(
      (ticket: { ticketId: string }) => ticket.ticketId === "implement-api",
    );
    expect(protectedTicket).toBeDefined();
    const protectedRevision = protectedTicket.ticketRevision.replace(
      /^sha256:/u,
      "",
    );
    const protectedInput = {
      expectedSource: mutationSource(verifiedState.data.graph.source),
      decision: {
        type: "protected_boundary",
        subject: {
          kind: "ticket",
          ticketId: protectedTicket.ticketId,
          ticketRevision: protectedTicket.ticketRevision,
        },
        boundary: "Choose the user-visible API conflict behavior.",
        disposition: "resolve",
        selection: "Return one stable conflict response.",
        rationale: "Clients need one explicit observable contract.",
        resolutionRefs: [],
      },
    };
    const protectedComplete = await postJson(
      `${freshReady.origin}/api/decision`,
      freshHost.token,
      freshReady.origin,
      protectedInput,
    );
    expect(protectedComplete.status).toBe(200);
    const protectedCompleted = await protectedComplete.json() as any;
    expect(protectedCompleted).toMatchObject({
      ok: true,
      data: {
        decision: {
          document: {
            decision_type: "protected_boundary",
            subject: {
              kind: "ticket",
              ticket_id: "implement-api",
              ticket_revision: protectedRevision,
            },
            boundary: protectedInput.decision.boundary,
            selection: protectedInput.decision.selection,
          },
        },
        attestation: {
          document: {
            scope: {
              scope_type: "protected_boundary",
              ticket_id: "implement-api",
              ticket_revision: protectedRevision,
              boundary: protectedInput.decision.boundary,
              selection: protectedInput.decision.selection,
            },
          },
        },
      },
    });
    expect(loadTicketLedgerFromWorktree(repo).decisions).toHaveLength(2);
    expect(loadTicketLedgerFromWorktree(repo).attestations).toHaveLength(2);
    const protectedState = await readJson(
      `${freshReady.origin}/api/state`,
      freshHost.token,
    );
    const protectedTrace = await readJson(
      `${freshReady.origin}/api/trace?${new URLSearchParams({
        snapshotId: protectedState.data.graph.snapshotId,
        kind: "ticket",
        ticketId: "implement-api",
      })}`,
      freshHost.token,
    );
    expect(protectedTrace.data.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "gate_decision",
        status: "current",
        producer: {
          kind: "authority_receipt",
          ref:
            protectedCompleted.data.attestation.document.attestation_id,
        },
      }),
    ]));

    authority.revokeRepository(profile.repositoryIncarnation);
    const afterRevocation = await readJson(
      `${freshReady.origin}/api/state`,
      freshHost.token,
    );
    expect(afterRevocation.data.interventions).toMatchObject({
      authority: { status: "unavailable" },
      planReview: { available: false },
      protectedDecision: { available: false },
    });
    const revokedTrace = await readJson(
      `${freshReady.origin}/api/trace?${new URLSearchParams({
        snapshotId: afterRevocation.data.graph.snapshotId,
        kind: "graph",
      })}`,
      freshHost.token,
    );
    expect(revokedTrace.data.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "artifact",
        status: "current_unverified",
        producer: {
          kind: "receipt",
          ref: completed.data.decision.document.decision_id,
        },
      }),
    ]));
    const revokedProtectedTrace = await readJson(
      `${freshReady.origin}/api/trace?${new URLSearchParams({
        snapshotId: afterRevocation.data.graph.snapshotId,
        kind: "ticket",
        ticketId: "implement-api",
      })}`,
      freshHost.token,
    );
    expect(revokedProtectedTrace.data.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "artifact",
          status: "current_unverified",
          producer: {
            kind: "receipt",
            ref:
              protectedCompleted.data.decision.document.decision_id,
          },
        }),
      ]),
    );
    expect(loadTicketLedgerFromWorktree(repo).attestations).toHaveLength(2);
    const revokedDecision = await postJson(
      `${freshReady.origin}/api/decision`,
      freshHost.token,
      freshReady.origin,
      {
        expectedSource: mutationSource(afterRevocation.data.graph.source),
        decision: {
          type: "protected_boundary",
          subject: {
            kind: "ticket",
            ticketId: "design-schema",
            ticketRevision: afterRevocation.data.graph.tickets.find(
              (ticket: { ticketId: string }) =>
                ticket.ticketId === "design-schema",
            ).ticketRevision,
          },
          boundary: "Choose the schema naming convention.",
          disposition: "resolve",
          selection: "Use stable snake_case names.",
          rationale: "A revoked running host must not rotate itself.",
          resolutionRefs: [],
        },
      },
    );
    expect(revokedDecision.status).toBe(409);
    expect(await revokedDecision.json()).toMatchObject({
      error: { code: "ticket_local_authority_profile_revoked" },
    });
    expect(authority.listProfiles().filter(
      (candidate) => candidate.revokedAt === null,
    )).toHaveLength(0);
    expect(loadTicketLedgerFromWorktree(repo).decisions).toHaveLength(2);
    expect(loadTicketLedgerFromWorktree(repo).attestations).toHaveLength(2);
    await freshHost.close();
    const rotatedHost = startTicketReviewHost({
      repoRoot: repo,
      dbPath: path.join(root, "rotated-runtime.db"),
      now: () => decisionNow,
      token: "r".repeat(32),
      ticketLocalDecisionAuthority: new TicketLocalDecisionAuthority({
        registryPath,
        now: () => decisionNow,
      }),
    });
    hosts.push(rotatedHost);
    const rotatedReady = await rotatedHost.ready;
    const rotatedState = await readJson(
      `${rotatedReady.origin}/api/state`,
      rotatedHost.token,
    );
    expect(rotatedState.data.interventions).toMatchObject({
      authority: {
        status: "active",
        profileId: expect.any(String),
      },
      planReview: { available: true },
      protectedDecision: { available: true },
    });
    expect(rotatedState.data.interventions.authority.profileId)
      .not.toBe(profile.profileId);
    const rotatedTrace = await readJson(
      `${rotatedReady.origin}/api/trace?${new URLSearchParams({
        snapshotId: rotatedState.data.graph.snapshotId,
        kind: "graph",
      })}`,
      rotatedHost.token,
    );
    expect(rotatedTrace.data.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "artifact",
        status: "current_unverified",
        producer: {
          kind: "receipt",
          ref: completed.data.decision.document.decision_id,
        },
      }),
    ]));
  }, 20_000);

  it("keeps a detached checkout readable while durable Decisions fail closed", async () => {
    execFileSync("git", ["switch", "--detach", "-q"], { cwd: repo });
    const registryPath = path.join(
      fs.realpathSync(root),
      "detached-trust",
      "decision-authority.v1",
      "registry.json",
    );
    const host = startTicketReviewHost({
      repoRoot: repo,
      dbPath,
      now: () => NOW,
      token: "d".repeat(32),
      ticketLocalDecisionAuthority: new TicketLocalDecisionAuthority({
        registryPath,
        now: () => NOW,
      }),
    });
    hosts.push(host);
    const { origin } = await host.ready;
    const state = await readJson(`${origin}/api/state`, host.token);
    expect(state.data.graph.source.branch).toBeNull();
    expect(state.data.interventions).toMatchObject({
      review: { available: false },
      planReview: { available: false },
      protectedDecision: { available: false },
      authority: { status: "unavailable" },
    });

    const decision = await postJson(
      `${origin}/api/decision`,
      host.token,
      origin,
      {
        expectedSource: mutationSource(state.data.graph.source),
        decision: {
          type: "plan_review",
          subject: {
            kind: "graph",
            graphDigest: state.data.graph.source.graphDigest,
          },
          disposition: "approve_execution",
          rationale: "Detached checkouts cannot persist this authority.",
          resolutionRefs: [],
        },
      },
    );
    expect(decision.status).toBe(409);
    expect(await decision.json()).toMatchObject({
      error: {
        code: "ticket_decision_detached_checkout_unsupported",
      },
    });
    expect(loadTicketLedgerFromWorktree(repo).decisions).toEqual([]);
    expect(loadTicketLedgerFromWorktree(repo).attestations).toEqual([]);
    expect(fs.existsSync(registryPath)).toBe(false);
  });

  it("rejects unauthenticated, cross-origin, non-JSON, oversized, malformed, and stale writes", async () => {
    const host = startTicketReviewHost({
      repoRoot: repo,
      dbPath,
      token: "w".repeat(32),
      ticketReviewAttribution: {
        actorId: "human:trusted-reviewer",
        actorKind: "human",
        attribution: "host_attested",
      },
    });
    hosts.push(host);
    const { origin } = await host.ready;
    const state = await readJson(`${origin}/api/state`, host.token);
    const valid = {
      expectedSource: mutationSource(state.data.graph.source),
      review: {
        type: "comment",
        subject: {
          kind: "graph",
          graphDigest: state.data.graph.source.graphDigest,
        },
        body: "A bounded review comment.",
      },
    };

    const unauthenticated = await fetch(`${origin}/api/review`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify(valid),
    });
    expect(unauthenticated.status).toBe(401);

    const foreignOrigin = await postJson(
      `${origin}/api/review`,
      host.token,
      "http://attacker.invalid",
      valid,
    );
    expect(foreignOrigin.status).toBe(403);
    expect(await foreignOrigin.json()).toMatchObject({
      error: { code: "origin_rejected" },
    });

    const wrongType = await fetch(`${origin}/api/review`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${host.token}`,
        Origin: origin,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(valid),
    });
    expect(wrongType.status).toBe(415);

    const oversized = await postJson(
      `${origin}/api/review`,
      host.token,
      origin,
      {
        ...valid,
        review: {
          ...valid.review,
          body: "x".repeat(512 * 1024),
        },
      },
    );
    expect(oversized.status).toBe(413);

    const malformed = await fetch(`${origin}/api/review`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${host.token}`,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: { code: "malformed_json" },
    });

    const stale = await postJson(
      `${origin}/api/review`,
      host.token,
      origin,
      {
        ...valid,
        expectedSource: {
          ...valid.expectedSource,
          sourceToken: `tls-${"0".repeat(64)}`,
        },
      },
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "ticket_ledger_stale_source" },
    });
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

function mutationSource(source: {
  sourceToken: string;
  worktreeIdentity: string;
  resolvedCommit: string;
  graphDigest: string;
  semanticLedgerDigest: string;
}): {
  sourceToken: string;
  worktreeIdentity: string;
  resolvedCommit: string;
  graphDigest: string;
  semanticLedgerDigest: string;
} {
  return {
    sourceToken: source.sourceToken,
    worktreeIdentity: source.worktreeIdentity,
    resolvedCommit: source.resolvedCommit,
    graphDigest: source.graphDigest,
    semanticLedgerDigest: source.semanticLedgerDigest,
  };
}

async function postJson(
  url: string,
  token: string,
  origin: string,
  body: unknown,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
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
