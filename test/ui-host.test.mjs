import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { buildUiSnapshot, parseUiFlags, startVibeHubUi, ticketContextPackage, traceRecords } from "../skills/vibehub-core/scripts/vh-ui.mjs";
import { context, room, run, tempRepo, ticket, writeRoom } from "./helpers.mjs";

const repos = [];
const hosts = [];
const NOW = "2026-08-02T07:00:00.000Z";

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

function fixture() {
  const repo = tempRepo("ui-host");
  repos.push(repo);
  assert.equal(run(repo, "project", "init").status, 0);
  writeRoom(repo, "product", room("product"));
  assert.equal(run(repo, "context", "put", context(), ["--room", "product"]).status, 0);
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "LOCAL_GRAPH_DESIGN.md"), "# Local graph design\n");
  writeFileSync(join(repo, "docs", "HISTORICAL.md"), "# Historical design\n\nImmutable reviewed bytes.\n");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "docs/HISTORICAL.md"], { cwd: repo });
  execFileSync("git", [
    "-c", "user.name=VibeHub Test",
    "-c", "user.email=vibehub@example.test",
    "commit", "-m", "Record historical design",
  ], { cwd: repo, stdio: "ignore" });
  const historicalCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  rmSync(join(repo, "docs", "HISTORICAL.md"));
  const feature = ticket("feature", ["foundation"]);
  feature.acceptance[0].authority = "human";
  feature.context_refs = [
    {
      ref: ".vibehub/rooms/product/decision-use-tickets.yaml",
      purpose: "Canonical product direction.",
    },
    {
      ref: "docs/LOCAL_GRAPH_DESIGN.md",
      purpose: "Design source when present.",
    },
    {
      ref: `commit:${historicalCommit}:docs/HISTORICAL.md`,
      purpose: "Exact historical design source.",
    },
  ];
  const foundation = ticket("foundation");
  foundation.acceptance[0].authority = "human";
  assert.equal(run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [
      foundation,
      feature,
      ticket("closeout-ready"),
      ticket("unsuccessful"),
      ticket("blocked", ["unsuccessful"]),
    ],
  }).status, 0);
  assert.equal(run(repo, "ticket", "evidence", {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: "closeout-ready-proof",
    ticket_id: "closeout-ready",
    acceptance_ids: ["works"],
    summary: "The current acceptance has reproducible proof.",
    refs: ["test:closeout-ready"],
    recorded_at: NOW,
  }).status, 0);
  assert.equal(run(repo, "ticket", "evidence", {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: "foundation-proof",
    ticket_id: "foundation",
    acceptance_ids: ["works"],
    summary: "Foundation behavior was observed.",
    refs: [
      "test:foundation",
      "browser:foundation-reviewed",
      "conversation:test-foundation-approved",
    ],
    origin: "human",
    recorded_at: NOW,
  }).status, 0);
  assert.equal(run(repo, "ticket", "closeout", {
    schema_version: 1,
    kind: "ticket_outcome", independence: { source: "subagent", note: "test fixture" },
    ticket_id: "foundation",
    status: "successful",
    accepted_acceptance_ids: ["works"],
    unresolved_acceptance_ids: [],
    evidence_ids: ["foundation-proof"],
    summary: "Foundation completed successfully.",
    closed_at: NOW,
  }).status, 0);
  assert.equal(run(repo, "ticket", "closeout", {
    schema_version: 1,
    kind: "ticket_outcome", independence: { source: "subagent", note: "test fixture" },
    ticket_id: "unsuccessful",
    status: "failed",
    accepted_acceptance_ids: [],
    unresolved_acceptance_ids: ["works"],
    evidence_ids: [],
    summary: "The Ticket failed independent closeout.",
    closed_at: NOW,
  }).status, 0);
  assert.equal(run(repo, "ticket", "update", {
    ticket_id: "foundation", update_id: "finished", summary: "Foundation completed.",
    status: "done", recorded_at: NOW,
  }).status, 0);
  return repo;
}

function canonicalBytes(repo) {
  const root = join(repo, ".vibehub");
  function collect(directory, prefix = "") {
    return readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const relative = join(prefix, entry.name);
        const absolute = join(directory, entry.name);
        return entry.isDirectory()
          ? collect(absolute, relative)
          : [[relative, readFileSync(absolute, "utf8")]];
      });
  }
  return collect(root).sort(([left], [right]) => left.localeCompare(right));
}

function authorized(token) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

test("direct YAML projection exposes graph topology and operational states", () => {
  const repo = fixture();
  const snapshot = buildUiSnapshot(repo);
  assert.deepEqual(
    Object.fromEntries(snapshot.state.graph.tickets.map((item) => [
      item.ticketId,
      item.capabilities.operational.summary.label,
    ])),
    {
      blocked: "BLOCKED",
      "closeout-ready": "OPEN",
      feature: "OPEN",
      foundation: "DONE",
      unsuccessful: "OPEN",
    },
  );
  assert.equal(snapshot.state.graph.relations.length, 2);
  assert.equal(snapshot.state.graph.tickets.some(item => "nextAction" in item.capabilities), false);
  assert.deepEqual(
    Object.fromEntries(snapshot.state.graph.tickets.map((item) => [
      item.ticketId,
      item.capabilities.attention.summary.label,
    ])),
    {
      blocked: "NONE",
      "closeout-ready": "NONE",
      feature: "PENDING",
      foundation: "RECORDED",
      unsuccessful: "NONE",
    },
  );
  const featureRelation = snapshot.state.graph.relations.find(
    (relation) => relation.dependentTicketId === "feature",
  );
  assert.deepEqual(featureRelation, {
    relationRef: featureRelation.relationRef,
    prerequisiteTicketId: "foundation",
    dependentTicketId: "feature",
    rationale: "feature needs foundation.",
    provenanceRefs: ["test:ticket-vertical-slice"],
  });
});

test("human criteria and historical evidence remain visible without changing task status", () => {
  const repo = fixture();
  const upcoming = ticket("human-upcoming", ["unsuccessful"]);
  upcoming.acceptance[0].authority = "human";
  const recorded = ticket("human-recorded");
  recorded.acceptance[0].authority = "human";
  assert.equal(run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [upcoming, recorded],
  }).status, 0);
  assert.equal(run(repo, "ticket", "evidence", {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: "human-recorded-proof",
    ticket_id: "human-recorded",
    acceptance_ids: ["works"],
    summary: "The human supplied the required decision.",
    refs: ["conversation:test-human-recorded"],
    origin: "human",
    recorded_at: NOW,
  }).status, 0);

  const snapshot = buildUiSnapshot(repo);
  const attention = Object.fromEntries(snapshot.state.graph.tickets.map((item) => [
    item.ticketId,
    item.capabilities.attention.summary,
  ]));
  assert.equal(attention["human-upcoming"].label, "PENDING");
  assert.equal(attention.feature.label, "PENDING");
  assert.equal(attention["human-recorded"].label, "RECORDED");
  assert.equal(attention.foundation.label, "RECORDED");
  assert.equal(attention["human-recorded"].humanAcceptanceCount, 1);
  assert.equal(attention["human-recorded"].humanEvidenceCount, 1);
  assert.deepEqual(attention["human-recorded"].recordedAcceptanceIds, ["works"]);
  assert.equal(
    snapshot.state.graph.tickets.find(
      (item) => item.ticketId === "human-upcoming",
    ).capabilities.operational.summary.label,
    "BLOCKED",
  );
  assert.equal(
    snapshot.state.graph.tickets.find(
      (item) => item.ticketId === "human-recorded",
    ).capabilities.operational.summary.label,
    "OPEN",
  );
});

test("historical Evidence and Outcomes do not change recorded task states", () => {
  const repo = tempRepo("ui-closeout-corpus");
  repos.push(repo);
  assert.equal(run(repo, "project", "init").status, 0);
  const partial = ticket("partial");
  partial.acceptance.push({
    acceptance_id: "second",
    criterion: "the second condition is observed.",
  });
  const humanMissing = ticket("human-missing");
  humanMissing.acceptance[0].authority = "human";
  const humanComplete = ticket("human-complete");
  humanComplete.acceptance[0].authority = "human";
  assert.equal(run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [
      ticket("zero"),
      partial,
      ticket("agent-complete"),
      humanMissing,
      humanComplete,
      ticket("successful"),
      ticket("failed"),
    ],
  }).status, 0);
  for (const [ticketId, acceptanceIds, origin = "agent"] of [
    ["partial", ["works"]],
    ["agent-complete", ["works"]],
    ["human-complete", ["works"], "human"],
    ["successful", ["works"]],
  ]) {
    assert.equal(run(repo, "ticket", "evidence", {
      schema_version: 1,
      kind: "ticket_evidence",
      evidence_id: `${ticketId}-proof`,
      ticket_id: ticketId,
      acceptance_ids: acceptanceIds,
      summary: `${ticketId} has bounded proof.`,
      refs: [origin === "human" ? `conversation:${ticketId}` : `test:${ticketId}`],
      origin,
      recorded_at: NOW,
    }).status, 0);
  }
  assert.equal(run(repo, "ticket", "closeout", {
    schema_version: 1,
    kind: "ticket_outcome", independence: { source: "subagent", note: "test fixture" },
    ticket_id: "successful",
    status: "successful",
    accepted_acceptance_ids: ["works"],
    unresolved_acceptance_ids: [],
    evidence_ids: ["successful-proof"],
    summary: "Independent adjudication accepted the Ticket.",
    closed_at: NOW,
  }).status, 0);
  assert.equal(run(repo, "ticket", "closeout", {
    schema_version: 1,
    kind: "ticket_outcome", independence: { source: "subagent", note: "test fixture" },
    ticket_id: "failed",
    status: "failed",
    accepted_acceptance_ids: [],
    unresolved_acceptance_ids: ["works"],
    evidence_ids: [],
    summary: "Independent adjudication rejected the Ticket.",
    closed_at: NOW,
  }).status, 0);

  const snapshot = buildUiSnapshot(repo, { scope: "all" });
  assert.deepEqual(Object.fromEntries(snapshot.state.graph.tickets.map((item) => [
    item.ticketId, item.capabilities.operational.summary.label,
  ])), {
    "agent-complete": "OPEN", failed: "OPEN", "human-complete": "OPEN",
    "human-missing": "OPEN", partial: "OPEN", successful: "OPEN", zero: "OPEN",
  });
});

test("reopening updates the graph and brief while retaining completion and proof history", () => {
  const repo = fixture();
  const before = buildUiSnapshot(repo);
  assert.equal(run(repo, "ticket", "update", {
    ticket_id: "foundation", update_id: "reopened", status: "open",
    summary: "Reopened after a translated setting was missed.", recorded_at: "2026-08-03T07:00:00.000Z",
  }).status, 0);
  const snapshot = buildUiSnapshot(repo);
  const states = new Map(snapshot.state.graph.tickets.map(item => [item.ticketId, item.capabilities.operational.summary.label]));
  assert.equal(states.get("foundation"), "OPEN");
  assert.equal(states.get("feature"), "BLOCKED");
  assert.notEqual(snapshot.state.graph.snapshotId, before.state.graph.snapshotId);
  const document = snapshot.repository.tickets.documents.get("foundation").document;
  const brief = ticketContextPackage(document, snapshot.graph.relations, snapshot.repository, snapshot.state.graph.source);
  assert.equal(brief.status, "open");
  assert.deepEqual(brief.updates.map(update => update.status), ["done", "open"]);
  assert.equal(brief.outcomeHistory[0].status, "successful");
  assert.equal(brief.agentPayload.status, "open");
  assert.equal("nextAction" in brief.agentPayload, false);
  assert.match(brief.agentPayload.handoff.instruction, /user's chosen skills/u);
  assert.deepEqual(traceRecords(snapshot.repository, snapshot.state.graph.source, "foundation")
    .filter(record => record.kind === "update").map(record => record.status), ["done", "open"]);
});

test("invalid canonical documents fail before UI projection", () => {
  const repo = fixture();
  writeFileSync(join(repo, ".vibehub", "tickets", "feature.yaml"), "{}\n");
  assert.throws(
    () => buildUiSnapshot(repo),
    (error) => {
      assert.equal(error.code, "validation_error");
      assert.match(JSON.stringify(error.details), /feature\.yaml/u);
      return true;
    },
  );
});

test("read-only projection disables repository-configured fsmonitor hooks", () => {
  const repo = fixture();
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  const hook = join(repo, "malicious-fsmonitor.sh");
  const marker = join(repo, "fsmonitor-executed");
  writeFileSync(
    hook,
    `#!/bin/sh\n: > ${JSON.stringify(marker)}\nprintf 'token\\n'\n`,
  );
  chmodSync(hook, 0o755);
  execFileSync("git", ["config", "core.fsmonitor", hook], { cwd: repo });

  // Prove the fixture is capable of executing the repository-configured hook.
  execFileSync("git", ["status", "--short"], { cwd: repo });
  assert.equal(existsSync(marker), true);
  rmSync(marker);

  buildUiSnapshot(repo);
  assert.equal(existsSync(marker), false);
});

test("focused launcher rejects an unknown Ticket before binding", () => {
  const repo = fixture();
  assert.throws(
    () => startVibeHubUi({ repoRoot: repo, ticket: "missing-ticket" }),
    /Unknown Ticket for --ticket/u,
  );
});

test("dense causal position preserves every direct prerequisite and unlock", () => {
  const repo = tempRepo("ui-dense-causal");
  repos.push(repo);
  assert.equal(run(repo, "project", "init").status, 0);
  const prerequisites = Array.from({ length: 5 }, (_, index) => `prerequisite-${index + 1}`);
  const dependents = Array.from({ length: 5 }, (_, index) => `dependent-${index + 1}`);
  assert.equal(run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [
      ...prerequisites.map((id) => ticket(id)),
      ticket("causal-center", prerequisites),
      ...dependents.map((id) => ticket(id, ["causal-center"])),
    ],
  }).status, 0);
  assert.equal(run(repo, "ticket", "evidence", {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: "dense-completed-proof",
    ticket_id: prerequisites[0],
    acceptance_ids: ["works"],
    summary: "The completed prerequisite passed.",
    refs: ["test:dense-completed"],
    recorded_at: NOW,
  }).status, 0);
  assert.equal(run(repo, "ticket", "closeout", {
    schema_version: 1,
    kind: "ticket_outcome", independence: { source: "subagent", note: "test fixture" },
    ticket_id: prerequisites[0],
    status: "successful",
    accepted_acceptance_ids: ["works"],
    unresolved_acceptance_ids: [],
    evidence_ids: ["dense-completed-proof"],
    summary: "The completed prerequisite succeeded.",
    closed_at: NOW,
  }).status, 0);
  assert.equal(run(repo, "ticket", "closeout", {
    schema_version: 1,
    kind: "ticket_outcome", independence: { source: "subagent", note: "test fixture" },
    ticket_id: prerequisites[1],
    status: "failed",
    accepted_acceptance_ids: [],
    unresolved_acceptance_ids: ["works"],
    evidence_ids: [],
    summary: "The deviated prerequisite failed.",
    closed_at: NOW,
  }).status, 0);
  assert.equal(run(repo, "ticket", "update", {
    ticket_id: prerequisites[0], update_id: "finished", summary: "The prerequisite is done.", status: "done",
  }).status, 0);
  const snapshot = buildUiSnapshot(repo);
  const center = snapshot.state.graph.tickets.find(
    (item) => item.ticketId === "causal-center",
  );
  assert.deepEqual(center.relationCounts, { prerequisites: 5, dependents: 5 });
  assert.deepEqual(
    Object.fromEntries(snapshot.state.graph.tickets
      .filter((item) => prerequisites.includes(item.ticketId))
      .map((item) => [
        item.ticketId,
        item.capabilities.operational.summary.label,
      ])),
    {
      "prerequisite-1": "DONE",
      "prerequisite-2": "OPEN",
      "prerequisite-3": "OPEN",
      "prerequisite-4": "OPEN",
      "prerequisite-5": "OPEN",
    },
  );
  assert.equal(
    snapshot.state.graph.relations.filter(
      (relation) => relation.dependentTicketId === "causal-center",
    ).length,
    5,
  );
  assert.equal(
    snapshot.state.graph.relations.filter(
      (relation) => relation.prerequisiteTicketId === "causal-center",
    ).length,
    5,
  );
});

test("Web projection shares current/all archive queries and progressive history stubs", () => {
  const repo = tempRepo("ui-archive-query");
  repos.push(repo);
  assert.equal(run(repo, "project", "init").status, 0);
  const delivery = {
    kind: "pull_request",
    ref: "https://github.com/VW-ai/vibehub-plugin/pull/77",
    state: "delivered",
    delivered_at: NOW,
    delivered_commit: "a".repeat(40),
  };
  const old = { ...ticket("old-history"), deliveries: [delivery] };
  const boundary = { ...ticket("archived-boundary", ["old-history"]), deliveries: [delivery] };
  assert.equal(run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [old, boundary, ticket("current-work", ["archived-boundary"]), ticket("other-current")],
  }).status, 0);
  for (const id of ["old-history", "archived-boundary"]) {
    assert.equal(run(repo, "ticket", "evidence", {
      schema_version: 1,
      kind: "ticket_evidence",
      evidence_id: `${id}-proof`,
      ticket_id: id,
      acceptance_ids: ["works"],
      summary: `${id} passed.`,
      refs: [`test:${id}`],
      recorded_at: NOW,
    }).status, 0);
    assert.equal(run(repo, "ticket", "closeout", {
      schema_version: 1,
      kind: "ticket_outcome", independence: { source: "subagent", note: "test fixture" },
      ticket_id: id,
      status: "successful",
      accepted_acceptance_ids: ["works"],
      unresolved_acceptance_ids: [],
      evidence_ids: [`${id}-proof`],
      summary: `${id} passed independently.`,
      closed_at: NOW,
    }).status, 0);
  }
  for (const id of ["old-history", "archived-boundary"]) {
    assert.equal(run(repo, "ticket", "update", { ticket_id: id, update_id: "finished", summary: "Task done.", status: "done" }).status, 0);
  }
  const current = buildUiSnapshot(repo);
  assert.deepEqual(current.state.graph.tickets.map((item) => [item.ticketId, item.archived]), [
    ["archived-boundary", true], ["current-work", false], ["other-current", false],
  ]);
  assert.deepEqual(current.state.graph.stubs.map((stub) => ({
    anchor: stub.anchorTicketId,
    direction: stub.direction,
    count: stub.hiddenTicketCount,
    next: stub.nextTicketIds,
  })), [{
    anchor: "archived-boundary",
    direction: "upstream",
    count: 1,
    next: ["old-history"],
  }]);
  const expanded = buildUiSnapshot(repo, { historyIds: ["old-history"] });
  assert.deepEqual(expanded.state.graph.tickets.map((item) => item.ticketId), [
    "archived-boundary", "current-work", "old-history", "other-current",
  ]);
  assert.deepEqual(expanded.state.graph.stubs, []);
  const all = buildUiSnapshot(repo, { scope: "all" });
  assert.deepEqual(all.state.graph.tickets.map((item) => item.ticketId), [
    "archived-boundary", "current-work", "old-history", "other-current",
  ]);
  assert.deepEqual(all.state.graph.stubs, []);
});

test("read-only loopback host serves assets, current graph, inspector, and trace", async (t) => {
  const repo = fixture();
  const beforeUi = canonicalBytes(repo);
  const token = "a".repeat(64);
  const host = startVibeHubUi({
    repoRoot: repo,
    token,
    tokenLifetimeMs: 60_000,
    ticket: "foundation",
    view: "log",
  });
  hosts.push(host);
  let ready;
  try {
    ready = await host.ready;
  } catch (error) {
    if (error?.code === "EPERM") {
      hosts.pop();
      t.skip("loopback sockets are unavailable in this sandbox");
      return;
    }
    throw error;
  }
  const { origin, url, focus } = ready;
  const authorizedUrl = new URL(url);
  assert.equal(authorizedUrl.hash, `#${token}`);
  assert.equal(authorizedUrl.searchParams.get("ticket"), "foundation");
  assert.equal(authorizedUrl.searchParams.get("view"), "log");
  assert.deepEqual(focus, { ticket: "foundation", view: "log", rooms: false, room: null });

  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, schemaVersion: 1, readOnly: true });
  assert.match(health.headers.get("content-security-policy"), /default-src 'self'/u);
  assert.equal(health.headers.get("access-control-allow-origin"), null);

  const favicon = await fetch(`${origin}/vibehub-mark.svg`);
  assert.equal(favicon.status, 200);
  assert.equal(favicon.redirected, false);
  assert.equal(favicon.headers.get("content-type"), "image/svg+xml");
  assert.deepEqual(
    Buffer.from(await favicon.arrayBuffer()),
    readFileSync(new URL("../assets/brand/vibehub-mark.svg", import.meta.url)),
  );
  const faviconHead = await fetch(`${origin}/vibehub-mark.svg`, { method: "HEAD" });
  assert.equal(faviconHead.status, 200);
  assert.equal(faviconHead.headers.get("content-type"), "image/svg+xml");

  const unauthorized = await fetch(`${origin}/api/state`);
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error.code, "unauthorized");

  const stateResponse = await fetch(`${origin}/api/state`, authorized(token));
  assert.equal(stateResponse.status, 200);
  const state = (await stateResponse.json()).data;
  assert.equal(state.graph.tickets.length, 5);
  assert.equal(state.graph.relations.length, 2);
  assert.equal(state.interventions.review.available, false);
  assert.deepEqual(state.interventions.authority, {
    status: "available",
    scope: "acceptance",
    default: "agent",
  });
  assert.equal(state.interventions.protectedBoundaries.length, 2);
  assert.equal(state.graph.source.actions.worktree.editorHref.startsWith("vscode://file"), true);
  assert.equal(state.graph.source.agentPayload.kind, "vibehub_git_source");
  assert.equal(state.graph.filters.scope, "current");
  assert.deepEqual(state.graph.stubs, []);
  for (const ticket of state.graph.tickets) {
    assert.deepEqual(ticket.capabilities.runtime, {
      availability: "available",
      sessions: [],
      summary: null,
    });
  }

  const invalidFilter = await fetch(
    `${origin}/api/state?scope=past`,
    authorized(token),
  );
  assert.equal(invalidFilter.status, 400);
  assert.equal((await invalidFilter.json()).error.code, "invalid_filter");

  const ticketQuery = new URLSearchParams({
    snapshotId: state.graph.snapshotId,
    kind: "ticket",
    ticketId: "foundation",
  });
  const subject = (await (await fetch(
    `${origin}/api/subject?${ticketQuery}`,
    authorized(token),
  )).json()).data;
  assert.equal(subject.subject.ticket.ticketId, "foundation");
  assert.equal(subject.contextPackage.acceptance[0].acceptanceId, "works");
  assert.equal(subject.contextPackage.acceptance[0].authority, "human");
  assert.equal(subject.contextPackage.attention.label, "RECORDED");
  assert.equal(subject.contextPackage.maturity, "firm");
  assert.equal(subject.contextPackage.operationalState, "DONE");
  assert.equal(subject.contextPackage.agentPayload.kind, "vibehub_ticket_handoff");
  assert.equal(subject.contextPackage.agentPayload.maturity, "firm");
  assert.equal(subject.contextPackage.agentPayload.operationalState, "DONE");
  assert.deepEqual(subject.contextPackage.agentPayload.humanBoundaries, [{
    acceptanceId: "works",
    criterion: "foundation behavior is observed.",
    authority: "human",
    evidenceState: "recorded",
  }]);

  const featureQuery = new URLSearchParams({
    snapshotId: state.graph.snapshotId,
    kind: "ticket",
    ticketId: "feature",
  });
  const featureSubject = (await (await fetch(
    `${origin}/api/subject?${featureQuery}`,
    authorized(token),
  )).json()).data;
  assert.equal(featureSubject.contextPackage.contextRefs[0].kind, "context");
  assert.equal(
    featureSubject.contextPackage.contextRefs[0].canonicalContext.summary,
    "Use Tickets as the development entry point",
  );
  assert.equal(featureSubject.contextPackage.contextRefs[0].canonicalContext.room, "product");
  assert.equal(featureSubject.contextPackage.contextRefs[1].kind, "source");
  assert.equal(featureSubject.contextPackage.contextRefs[1].canonicalContext, null);
  assert.equal("actions" in featureSubject.contextPackage.contextRefs[1], false);
  assert.equal(featureSubject.contextPackage.contextRefs[2].kind, "source");
  assert.match(featureSubject.contextPackage.contextRefs[2].identity.commit, /^[0-9a-f]{40}$/u);
  assert.equal(featureSubject.contextPackage.contextRefs[2].identity.path, "docs/HISTORICAL.md");
  assert.match(featureSubject.contextPackage.contextRefs[2].identity.blob, /^[0-9a-f]{40}$/u);
  assert.deepEqual(
    featureSubject.contextPackage.agentPayload.contextRefs[2].identity,
    featureSubject.contextPackage.contextRefs[2].identity,
  );
  assert.equal(featureSubject.contextPackage.attention.label, "PENDING");
  assert.deepEqual(
    featureSubject.contextPackage.agentPayload.humanBoundaries.map(
      (item) => [item.acceptanceId, item.criterion, item.evidenceState],
    ),
    [["works", "feature behavior is observed.", "pending"]],
  );

  const unsuccessfulQuery = new URLSearchParams({
    snapshotId: state.graph.snapshotId,
    kind: "ticket",
    ticketId: "unsuccessful",
  });
  const unsuccessfulSubject = (await (await fetch(
    `${origin}/api/subject?${unsuccessfulQuery}`,
    authorized(token),
  )).json()).data;
  assert.equal(unsuccessfulSubject.contextPackage.operationalState, "OPEN");
  assert.equal(
    unsuccessfulSubject.contextPackage.agentPayload.operationalState,
    "OPEN",
  );

  const closeoutQuery = new URLSearchParams({
    snapshotId: state.graph.snapshotId,
    kind: "ticket",
    ticketId: "closeout-ready",
  });
  const closeoutSubject = (await (await fetch(
    `${origin}/api/subject?${closeoutQuery}`,
    authorized(token),
  )).json()).data;
  const closeoutPayload = closeoutSubject.contextPackage.agentPayload;
  assert.equal(closeoutSubject.contextPackage.evidence.length, 1);
  assert.equal(closeoutPayload.ticketRef, ".vibehub/tickets/closeout-ready.yaml");
  assert.equal(closeoutPayload.acceptance[0].authority, "agent");
  assert.equal(closeoutPayload.evidence[0].evidenceId, "closeout-ready-proof");
  assert.deepEqual(closeoutPayload.evidence[0].acceptanceIds, ["works"]);
  assert.equal(closeoutPayload.outcomeRecord, null);
  assert.equal(closeoutPayload.handoff.readOnly, true);
  assert.equal("presentation" in closeoutPayload, false);
  assert.equal("phase" in closeoutPayload, false);
  assert.equal("substate" in closeoutPayload, false);
  assert.match(closeoutPayload.handoff.instruction, /user's chosen skills/iu);
  assert.doesNotMatch(closeoutPayload.handoff.instruction, /independent|vibehub-ticket-(run|plan|closeout)/iu);
  assert.deepEqual(closeoutPayload.reviewInputs.evidenceRefs, [
    ".vibehub/evidence/closeout-ready/closeout-ready-proof.yaml",
  ]);
  assert.equal(closeoutPayload.reviewInputs.outcomeRef, null);

  const trace = (await (await fetch(
    `${origin}/api/trace?${ticketQuery}`,
    authorized(token),
  )).json()).data;
  assert.deepEqual(trace.records.map((record) => record.kind), ["evidence", "outcome", "update"]);
  assert.deepEqual(trace.records[0].acceptanceIds, ["works"]);
  assert.equal(trace.records[0].origin, "human");
  assert.deepEqual(
    trace.records[0].targets.map((target) => target.kind),
    ["test", "browser", "conversation"],
  );
  assert.equal(trace.records[0].agentPayload.kind, "vibehub_ticket_evidence");
  assert.equal(trace.records[0].agentPayload.origin, "human");
  assert.equal(trace.records[1].subkind, "successful");
  assert.deepEqual(trace.records[1].acceptedAcceptanceIds, ["works"]);
  assert.deepEqual(trace.records[1].unresolvedAcceptanceIds, []);

  const readOnly = await fetch(`${origin}/api/review`, {
    method: "POST",
    ...authorized(token),
  });
  assert.equal(readOnly.status, 405);
  assert.equal((await readOnly.json()).error.code, "read_only");
  const faviconWrite = await fetch(`${origin}/vibehub-mark.svg`, { method: "POST" });
  assert.equal(faviconWrite.status, 405);
  assert.equal((await faviconWrite.json()).error.code, "read_only");

  const html = await (await fetch(`${origin}/`)).text();
  const model = await (await fetch(`${origin}/app-model.js`)).text();
  const layout = await (await fetch(`${origin}/app-layout.js`)).text();
  const script = await (await fetch(`${origin}/app.js`)).text();
  const styles = await (await fetch(`${origin}/app.css`)).text();
  assert.match(html, /class="app-shell"/u);
  assert.match(html, /src="\/app-model\.js"/u);
  assert.match(layout, /VibeHubGraphLayout/u);
  assert.match(styles, /\.ticket-node/u);
  assert.doesNotMatch(model, /ticketNextAction|CLOSE_OUT|vibehub-ticket-(run|plan|closeout)/u);
  assert.doesNotMatch(script, /closeoutReviewBrief|CLOSE_OUT/u);

  assert.deepEqual(canonicalBytes(repo), beforeUi);

  const newlyVisible = ticket("newly-visible");
  newlyVisible.maturity = "draft";
  assert.equal(run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [newlyVisible],
  }).status, 0);
  const refreshed = (await (await fetch(
    `${origin}/api/state`,
    authorized(token),
  )).json()).data;
  assert.equal(refreshed.graph.tickets.length, 6);
  assert.notEqual(refreshed.graph.snapshotId, state.graph.snapshotId);
  const draftQuery = new URLSearchParams({
    snapshotId: refreshed.graph.snapshotId,
    kind: "ticket",
    ticketId: "newly-visible",
  });
  const draftSubject = (await (await fetch(
    `${origin}/api/subject?${draftQuery}`,
    authorized(token),
  )).json()).data;
  assert.equal(draftSubject.contextPackage.maturity, "draft");
  assert.equal(draftSubject.contextPackage.operationalState, "OPEN");
  assert.equal(draftSubject.contextPackage.agentPayload.maturity, "draft");
  assert.equal(draftSubject.contextPackage.agentPayload.operationalState, "OPEN");
});

test("launcher flags stay intentionally narrow", () => {
  assert.deepEqual(parseUiFlags([]), {
    repo: process.cwd(),
    port: 0,
    open: true,
    json: false,
    ticket: null,
    view: null,
    rooms: false,
    room: null,
  });
  assert.deepEqual(parseUiFlags([
    "--repo", ".", "--port", "4321", "--no-open", "--json",
    "--ticket", "feature", "--view", "contract",
  ]), {
    repo: process.cwd(),
    port: 4321,
    open: false,
    json: true,
    ticket: "feature",
    view: "contract",
    rooms: false,
    room: null,
  });
  assert.deepEqual(parseUiFlags(["--repo", ".", "--rooms"]), {
    repo: process.cwd(),
    port: 0,
    open: true,
    json: false,
    ticket: null,
    view: null,
    rooms: true,
    room: null,
  });
  assert.deepEqual(parseUiFlags(["--repo", ".", "--room", "product/ux"]), {
    repo: process.cwd(),
    port: 0,
    open: true,
    json: false,
    ticket: null,
    view: null,
    rooms: true,
    room: "product/ux",
  });
  assert.throws(() => parseUiFlags(["--room", "Product"]), /canonical Room path/u);
  assert.throws(
    () => parseUiFlags(["--rooms", "--ticket", "feature"]),
    /cannot be combined with --ticket/u,
  );
  assert.throws(() => parseUiFlags(["--db", "state.sqlite"]), /unknown flag/u);
  assert.throws(() => parseUiFlags(["--port", "70000"]), /between 0 and 65535/u);
  assert.throws(() => parseUiFlags(["--view", "log"]), /requires --ticket/u);
  assert.throws(
    () => parseUiFlags(["--ticket", "Feature", "--view", "execution"]),
    /canonical Ticket ID/u,
  );
  assert.throws(
    () => parseUiFlags(["--ticket", "feature", "--view", "proof"]),
    /execution, contract, or log/u,
  );
});
