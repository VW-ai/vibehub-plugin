import { execFileSync } from "node:child_process";
import crypto, { type KeyObject } from "node:crypto";
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
import type {
  TicketWebAuthnAuthorityProfileV1,
  TicketWebAuthnVerifiedPresenceV1,
} from "../src/ticket-webauthn-authority.js";

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
    expect(html).not.toMatch(/authorize|decision rationale|validation/i);
    expect(html).toContain('class="source-ref"');
    expect(html).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(script).toContain('route: "/api/review"');
    expect(script).toContain('route: "/api/decision"');
    expect(script).not.toMatch(/\/api\/apply/);
    expect(script).toContain("semanticLedgerDigest: source.semanticLedgerDigest");
    expect(script).toContain("Your draft is preserved");
    expect(script).toContain("state.interventions");
    expect(script).toContain("activeActionKey = draftKey");
    expect(script).toContain("traceSubjectMatches");
    expect(script).toContain("traceDecisionDetails(record.decision)");
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

  it("runs a one-use WebAuthn ceremony and keeps authority outside browser claims", async () => {
    const ceremonyNow = new Date().toISOString();
    const registry = new DeterministicWebAuthnRegistry();
    const host = startTicketReviewHost({
      repoRoot: repo,
      dbPath,
      now: () => ceremonyNow,
      token: "a".repeat(32),
      ticketWebAuthnAuthorityRegistry: registry as any,
    });
    hosts.push(host);
    const { origin } = await host.ready;

    const unenrolled = await readJson(
      `${origin}/api/state`,
      host.token,
    );
    expect(unenrolled.data.interventions).toMatchObject({
      authority: { status: "unenrolled" },
      planReview: { available: false },
      protectedDecision: { available: false },
    });

    const forgedEnrollment = await postJson(
      `${origin}/api/authority/enroll/challenge`,
      host.token,
      origin,
      {
        principalId: "human:repository-owner",
        authorityBasis: "designated_human",
      },
    );
    expect(forgedEnrollment.status).toBe(400);
    expect(await forgedEnrollment.json()).toMatchObject({
      error: { code: "validation_error" },
    });

    const enrollmentChallenge = await postJson(
      `${origin}/api/authority/enroll/challenge`,
      host.token,
      origin,
      { principalId: "human:repository-owner" },
    );
    expect(enrollmentChallenge.status).toBe(200);
    const enrollment = (await enrollmentChallenge.json() as any).data;
    const enrollmentComplete = await postJson(
      `${origin}/api/authority/enroll/complete`,
      host.token,
      origin,
      {
        ceremonyId: enrollment.ceremonyId,
        credential: { id: "deterministic-registration" },
      },
    );
    expect(enrollmentComplete.status).toBe(200);
    expect(await enrollmentComplete.json()).toMatchObject({
      data: {
        authority: {
          principalId: "human:repository-owner",
          credentialFingerprint: registry.keyFingerprint,
        },
      },
    });

    const active = await readJson(`${origin}/api/state`, host.token);
    expect(active.data.interventions).toMatchObject({
      authority: {
        status: "active",
        principalId: "human:repository-owner",
        credentialFingerprint: registry.keyFingerprint,
      },
      planReview: {
        available: true,
        ceremony: "webauthn",
      },
      protectedDecision: {
        available: true,
        ceremony: "webauthn",
      },
    });
    const source = active.data.graph.source;
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
      `${origin}/api/decision/challenge`,
      host.token,
      origin,
      {
        ...decisionInput,
        authority: {
          principalId: "browser-forgery",
        },
        decidedAt: "2099-01-01T00:00:00.000Z",
      },
    );
    expect(forgedDecision.status).toBe(400);
    expect(await forgedDecision.json()).toMatchObject({
      error: { code: "validation_error" },
    });

    const decisionChallenge = await postJson(
      `${origin}/api/decision/challenge`,
      host.token,
      origin,
      decisionInput,
    );
    expect(decisionChallenge.status).toBe(200);
    const preparedDecision = (await decisionChallenge.json() as any).data;
    const decisionComplete = await postJson(
      `${origin}/api/decision/complete`,
      host.token,
      origin,
      {
        ceremonyId: preparedDecision.ceremonyId,
        credential: { id: "deterministic-assertion" },
      },
    );
    expect(decisionComplete.status).toBe(200);
    const completed = await decisionComplete.json() as any;
    expect(completed).toMatchObject({
      ok: true,
      data: {
        decision: {
          document: {
            authority: {
              principal_id: "human:repository-owner",
              basis: "repository_owner",
            },
            decided_at: ceremonyNow,
          },
        },
        attestation: {
          documentPath: expect.stringMatching(
            /^\.vibehub\/tickets\/attestations\/tdc-[0-9a-f]{64}\/tda-[0-9a-f]{64}\.yaml$/u,
          ),
          document: {
            authority: {
              principal_id: "human:repository-owner",
            },
            credential: {
              fingerprint: registry.keyFingerprint,
            },
            issued_at: ceremonyNow,
            not_before: ceremonyNow,
            expires_at: new Date(
              Date.parse(ceremonyNow) + 30 * 60 * 1_000,
            ).toISOString(),
          },
        },
      },
    });
    const ledger = loadTicketLedgerFromWorktree(repo);
    expect(ledger.decisions).toHaveLength(1);
    expect(ledger.attestations).toHaveLength(1);
    expect(ledger.attestations[0]?.document.decision.document_digest)
      .toBe(completed.data.attestation.document.decision.document_digest);
    const verifiedState = await readJson(`${origin}/api/state`, host.token);
    const verifiedTrace = await readJson(
      `${origin}/api/trace?${new URLSearchParams({
        snapshotId: verifiedState.data.graph.snapshotId,
        kind: "graph",
      })}`,
      host.token,
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

    const replay = await postJson(
      `${origin}/api/decision/complete`,
      host.token,
      origin,
      {
        ceremonyId: preparedDecision.ceremonyId,
        credential: { id: "deterministic-assertion" },
      },
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      error: { code: "ticket_webauthn_ceremony_expired" },
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
    const protectedChallenge = await postJson(
      `${origin}/api/decision/challenge`,
      host.token,
      origin,
      protectedInput,
    );
    expect(protectedChallenge.status).toBe(200);
    const preparedProtected =
      (await protectedChallenge.json() as any).data;
    const protectedComplete = await postJson(
      `${origin}/api/decision/complete`,
      host.token,
      origin,
      {
        ceremonyId: preparedProtected.ceremonyId,
        credential: { id: "deterministic-protected-assertion" },
      },
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
      `${origin}/api/state`,
      host.token,
    );
    const protectedTrace = await readJson(
      `${origin}/api/trace?${new URLSearchParams({
        snapshotId: protectedState.data.graph.snapshotId,
        kind: "ticket",
        ticketId: "implement-api",
      })}`,
      host.token,
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

    const revokeChallenge = await postJson(
      `${origin}/api/authority/revoke/challenge`,
      host.token,
      origin,
      {},
    );
    expect(revokeChallenge.status).toBe(200);
    const revoke = (await revokeChallenge.json() as any).data;
    const revoked = await postJson(
      `${origin}/api/authority/revoke/complete`,
      host.token,
      origin,
      {
        ceremonyId: revoke.ceremonyId,
        credential: { id: "deterministic-revocation" },
      },
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      data: {
        authority: {
          status: "revoked",
          principalId: "human:repository-owner",
        },
      },
    });
    const afterRevocation = await readJson(
      `${origin}/api/state`,
      host.token,
    );
    expect(afterRevocation.data.interventions).toMatchObject({
      authority: { status: "unenrolled" },
      planReview: { available: false },
      protectedDecision: { available: false },
    });
    const revokedTrace = await readJson(
      `${origin}/api/trace?${new URLSearchParams({
        snapshotId: afterRevocation.data.graph.snapshotId,
        kind: "graph",
      })}`,
      host.token,
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
      `${origin}/api/trace?${new URLSearchParams({
        snapshotId: afterRevocation.data.graph.snapshotId,
        kind: "ticket",
        ticketId: "implement-api",
      })}`,
      host.token,
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

class DeterministicWebAuthnRegistry {
  private profiles: TicketWebAuthnAuthorityProfileV1[] = [];
  private readonly privateKey: KeyObject;
  private readonly publicKeySpkiPem: string;
  readonly keyFingerprint: string;
  private readonly credentialId: string;

  constructor() {
    const pair = crypto.generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    this.privateKey = pair.privateKey;
    this.publicKeySpkiPem = pair.publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();
    this.keyFingerprint = crypto.createHash("sha256").update(
      pair.publicKey.export({ type: "spki", format: "der" }),
    ).digest("hex");
    this.credentialId = crypto.createHash("sha256")
      .update(this.publicKeySpkiPem)
      .digest("base64url");
  }

  listProfiles(): TicketWebAuthnAuthorityProfileV1[] {
    return this.profiles.map((profile) => ({
      ...profile,
      transports: [...profile.transports],
    }));
  }

  async createRegistrationOptions(request: {
    challenge: string;
  }): Promise<Record<string, unknown>> {
    return {
      challenge: request.challenge,
      rp: { id: "localhost", name: "Vibehub Ticket Decisions" },
      user: {
        id: "deterministic-user",
        name: "human:repository-owner",
        displayName: "human:repository-owner",
      },
    };
  }

  async verifyRegistration(request: {
    principalId: string;
    authorityBasis: "repository_owner" | "designated_human";
    authorityRef: string;
    repositoryIncarnation: string;
  }): Promise<TicketWebAuthnAuthorityProfileV1> {
    const profile: TicketWebAuthnAuthorityProfileV1 = {
      profileId: `twa-${"0".repeat(64)}`,
      keyFingerprint: this.keyFingerprint,
      principalId: request.principalId,
      principalKind: "human",
      authorityBasis: request.authorityBasis,
      authorityRef: request.authorityRef,
      repositoryIncarnation: request.repositoryIncarnation,
      rpId: "localhost",
      algorithm: "ES256",
      credentialId: this.credentialId,
      publicKeyCose: Buffer.from("deterministic-public-key")
        .toString("base64url"),
      publicKeySpkiPem: this.publicKeySpkiPem,
      transports: ["internal"],
      counter: 0,
      lastAssertionDigest: null,
      createdAt: NOW,
      revokedAt: null,
    };
    this.profiles = [profile];
    return { ...profile, transports: [...profile.transports] };
  }

  async createAuthenticationOptions(request: {
    challenge: string;
  }): Promise<Record<string, unknown>> {
    return {
      challenge: request.challenge,
      rpId: "localhost",
      userVerification: "required",
    };
  }

  async verifyAuthentication(request: {
    profileId: string;
    challenge: string;
    origin: string;
  }): Promise<TicketWebAuthnVerifiedPresenceV1> {
    const index = this.profiles.findIndex(
      (profile) => profile.profileId === request.profileId,
    );
    const profile = this.profiles[index];
    if (profile === undefined || profile.revokedAt !== null) {
      throw new Error("deterministic authority is unavailable");
    }
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: "webauthn.get",
      challenge: request.challenge,
      origin: request.origin,
      crossOrigin: false,
    }));
    const authenticatorData = Buffer.alloc(37);
    crypto.createHash("sha256").update("localhost").digest()
      .copy(authenticatorData, 0);
    authenticatorData[32] = 0x05;
    authenticatorData.writeUInt32BE(profile.counter + 1, 33);
    const signature = crypto.sign(
      "sha256",
      Buffer.concat([
        authenticatorData,
        crypto.createHash("sha256").update(clientDataJSON).digest(),
      ]),
      this.privateKey,
    );
    const assertionDigest = crypto.createHash("sha256").update(
      Buffer.concat([clientDataJSON, authenticatorData, signature]),
    ).digest("hex");
    const updated: TicketWebAuthnAuthorityProfileV1 = {
      ...profile,
      counter: profile.counter + 1,
      lastAssertionDigest: assertionDigest,
      transports: [...profile.transports],
    };
    this.profiles[index] = updated;
    return {
      profile: { ...updated, transports: [...updated.transports] },
      verifiedAt: NOW,
      challenge: request.challenge,
      origin: request.origin,
      rpId: "localhost",
      userVerified: true,
      counter: updated.counter,
      assertionDigest,
      assertion: {
        credentialId: updated.credentialId,
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authenticatorData.toString("base64url"),
        signature: signature.toString("base64url"),
        userHandle: null,
      },
    };
  }

  async revoke(request: {
    profileId: string;
    challenge: string;
    origin: string;
  }): Promise<TicketWebAuthnAuthorityProfileV1> {
    const presence = await this.verifyAuthentication(request);
    const index = this.profiles.findIndex(
      (profile) => profile.profileId === request.profileId,
    );
    const revoked = {
      ...presence.profile,
      revokedAt: NOW,
      transports: [...presence.profile.transports],
    };
    this.profiles[index] = revoked;
    return { ...revoked, transports: [...revoked.transports] };
  }
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
