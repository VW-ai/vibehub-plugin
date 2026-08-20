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
import { buildUiSnapshot, parseUiFlags, startVibeHubUi } from "../skills/scripts/vh-ui.mjs";
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
  ];
  const foundation = ticket("foundation");
  foundation.acceptance[0].authority = "human";
  assert.equal(run(repo, "ticket", "apply", {
    tickets: [
      foundation,
      feature,
      ticket("unsuccessful"),
      ticket("blocked", ["unsuccessful"]),
    ],
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
    kind: "ticket_outcome",
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
    kind: "ticket_outcome",
    ticket_id: "unsuccessful",
    status: "failed",
    accepted_acceptance_ids: [],
    unresolved_acceptance_ids: ["works"],
    evidence_ids: [],
    summary: "The Ticket failed independent closeout.",
    closed_at: NOW,
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
      feature: "READY",
      foundation: "DONE",
      unsuccessful: "DEVIATED",
    },
  );
  assert.equal(snapshot.state.graph.relations.length, 2);
  assert.deepEqual(
    Object.fromEntries(snapshot.state.graph.tickets.map((item) => [
      item.ticketId,
      item.capabilities.nextAction.summary.action,
    ])),
    {
      blocked: "WAIT",
      feature: "NEEDS_HUMAN",
      foundation: "DONE",
      unsuccessful: "REPLAN",
    },
  );
  assert.deepEqual(
    Object.fromEntries(snapshot.state.graph.tickets.map((item) => [
      item.ticketId,
      item.capabilities.attention.summary.label,
    ])),
    {
      blocked: "NONE",
      feature: "PENDING",
      foundation: "COMPLETE",
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

test("human attention projection distinguishes upcoming, pending, recorded, and complete", () => {
  const repo = fixture();
  const upcoming = ticket("human-upcoming", ["unsuccessful"]);
  upcoming.acceptance[0].authority = "human";
  const recorded = ticket("human-recorded");
  recorded.acceptance[0].authority = "human";
  assert.equal(run(repo, "ticket", "apply", {
    tickets: [upcoming, recorded],
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
  assert.equal(attention["human-upcoming"].label, "UPCOMING");
  assert.equal(attention.feature.label, "PENDING");
  assert.equal(attention["human-recorded"].label, "RECORDED");
  assert.equal(attention.foundation.label, "COMPLETE");
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
    "READY",
  );
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
  assert.equal(run(repo, "ticket", "apply", {
    tickets: [
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
    kind: "ticket_outcome",
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
    kind: "ticket_outcome",
    ticket_id: prerequisites[1],
    status: "failed",
    accepted_acceptance_ids: [],
    unresolved_acceptance_ids: ["works"],
    evidence_ids: [],
    summary: "The deviated prerequisite failed.",
    closed_at: NOW,
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
      "prerequisite-2": "DEVIATED",
      "prerequisite-3": "READY",
      "prerequisite-4": "READY",
      "prerequisite-5": "READY",
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
  assert.equal(run(repo, "ticket", "apply", {
    tickets: [old, boundary, ticket("current-work", ["archived-boundary"]), ticket("other-current")],
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
      kind: "ticket_outcome",
      ticket_id: id,
      status: "successful",
      accepted_acceptance_ids: ["works"],
      unresolved_acceptance_ids: [],
      evidence_ids: [`${id}-proof`],
      summary: `${id} passed independently.`,
      closed_at: NOW,
    }).status, 0);
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

test("read-only loopback host serves assets, current graph, inspector, and trace", async () => {
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
  const { origin, url, focus } = await host.ready;
  const authorizedUrl = new URL(url);
  assert.equal(authorizedUrl.hash, `#${token}`);
  assert.equal(authorizedUrl.searchParams.get("ticket"), "foundation");
  assert.equal(authorizedUrl.searchParams.get("view"), "log");
  assert.deepEqual(focus, { ticket: "foundation", view: "log" });

  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, schemaVersion: 1, readOnly: true });
  assert.match(health.headers.get("content-security-policy"), /default-src 'self'/u);
  assert.equal(health.headers.get("access-control-allow-origin"), null);

  const unauthorized = await fetch(`${origin}/api/state`);
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error.code, "unauthorized");

  const stateResponse = await fetch(`${origin}/api/state`, authorized(token));
  assert.equal(stateResponse.status, 200);
  const state = (await stateResponse.json()).data;
  assert.equal(state.graph.tickets.length, 4);
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
  assert.equal(subject.contextPackage.attention.label, "COMPLETE");
  assert.equal(subject.contextPackage.maturity, "firm");
  assert.equal(subject.contextPackage.operationalState, "DONE");
  assert.equal(subject.contextPackage.nextAction.action, "DONE");
  assert.equal(subject.contextPackage.agentPayload.kind, "vibehub_ticket_handoff");
  assert.equal(subject.contextPackage.agentPayload.maturity, "firm");
  assert.equal(subject.contextPackage.agentPayload.operationalState, "DONE");
  assert.equal(subject.contextPackage.agentPayload.nextAction.action, "DONE");
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
  assert.equal(featureSubject.contextPackage.attention.label, "PENDING");
  assert.equal(featureSubject.contextPackage.nextAction.action, "NEEDS_HUMAN");
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
  assert.equal(unsuccessfulSubject.contextPackage.operationalState, "DEVIATED");
  assert.equal(unsuccessfulSubject.contextPackage.nextAction.action, "REPLAN");
  assert.equal(
    unsuccessfulSubject.contextPackage.agentPayload.operationalState,
    "DEVIATED",
  );

  const trace = (await (await fetch(
    `${origin}/api/trace?${ticketQuery}`,
    authorized(token),
  )).json()).data;
  assert.deepEqual(trace.records.map((record) => record.kind), ["evidence", "outcome"]);
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

  const html = await (await fetch(`${origin}/`)).text();
  const model = await (await fetch(`${origin}/app-model.js`)).text();
  const layout = await (await fetch(`${origin}/app-layout.js`)).text();
  const script = await (await fetch(`${origin}/app.js`)).text();
  const styles = await (await fetch(`${origin}/app.css`)).text();
  assert.match(html, /class="app-shell"/u);
  assert.match(html, /id="copyLink"/u);
  assert.match(html, /src="\/app-model\.js"/u);
  assert.match(html, /src="\/app-layout\.js"/u);
  assert.match(html, /class="workspace inspector-closed"/u);
  assert.match(html, /id="graphSignal"/u);
  assert.match(html, /id="sourceDock"/u);
  assert.doesNotMatch(html, /class="(?:surface|signal|sheet)/u);
  assert.doesNotMatch(html, /state-legend|brand-mark/u);
  // Canvas-first shell: operational overview is available on demand while
  // empty presence and a permanent navigation rail consume no layout space.
  assert.doesNotMatch(html, /class="rail"|id="implementingStrip"|id="implementingList"/u);
  assert.match(html, /id="overviewPanel"/u);
  assert.match(html, /aria-controls="overviewPanel"/u);
  assert.match(html, /id="closeOverview"/u);
  assert.match(html, /aria-label="Ticket state legend"/u);
  assert.match(html, /aria-label="Human attention legend"/u);
  assert.doesNotMatch(html, /id="frontierList"|id="attentionList"|id="deviationList"/u);
  assert.match(html, /id="summaryGrid"/u);
  assert.match(html, /id="summaryRefine"/u);
  assert.match(html, /id="summaryHuman"/u);
  assert.doesNotMatch(html, /id="overviewSource"/u);
  assert.match(html, /id="sourcePath"/u);
  assert.match(html, /id="sourceBranch"/u);
  assert.match(html, /id="sourceCommit"/u);
  assert.match(html, /id="sourceDirty"/u);
  // The style-lab A/B/C selector is a design-exploration artifact and must
  // never ship on the product surface.
  assert.doesNotMatch(html, /style-lab|style-option|style-swatch|data-theme/u);
  // One causal layout supports an explicit left-to-right default and
  // top-to-bottom choice without forking the graph model.
  assert.match(html, /id="directionLtr"[^>]+aria-pressed="true"/u);
  assert.match(html, /id="directionTtb"[^>]+aria-pressed="false"/u);
  assert.match(html, /id="scopeCurrent"[^>]+aria-pressed="true"/u);
  assert.match(html, /id="scopeAll"[^>]+aria-pressed="false"/u);
  assert.match(script, /function layoutGraph\(tickets, relations, direction/u);
  assert.match(layout, /function minimizeCrossings/u);
  assert.match(layout, /function routeRelations/u);
  assert.match(layout, /relationRef.*source: 0, target: 0/su);
  assert.match(layout, /The Ticket graph contains a cycle/u);
  assert.match(script, /function setLayoutDirection/u);
  assert.match(script, /function setGraphScope/u);
  assert.match(script, /function revealHistory/u);
  assert.match(script, /ARCHIVED delivery history/u);
  assert.match(script, /preserveLayout/u);
  assert.match(script, /layoutDirection === "ltr"/u);
  // No trusted Active-Run source exists, so the shell makes no presence claim
  // and never promotes Git-native state into an implementing subsystem.
  assert.doesNotMatch(script, /ACTIVE_RUN_PRESENCE|renderImplementingNow/u);
  assert.doesNotMatch(script, /"IMPLEMENTING"/u);
  // No visual preference is ever persisted by the product surface.
  assert.doesNotMatch(script, /localStorage|sessionStorage/u);
  assert.doesNotMatch(script, /renderProjectionTime|startWatchPolling|state\.watch/u);
  // Copy for Agent consumes the host-derived next action instead of inferring
  // routing from operational status or Evidence count in the browser.
  assert.match(model, /function ticketNextAction/u);
  assert.match(model, /action === "EXECUTE"/u);
  assert.match(model, /action === "CLOSE_OUT"/u);
  assert.match(model, /action === "NEEDS_HUMAN"/u);
  assert.match(model, /vibehub-ticket-run/u);
  assert.match(model, /vibehub-ticket-plan/u);
  assert.match(model, /vibehub-ticket-review/u);
  assert.match(script, /function causalCone/u);
  assert.match(layout, /function relationPorts/u);
  assert.match(script, /edge-control-halo/u);
  assert.match(script, /minimapWorldPoint/u);
  assert.match(script, /renderGraphInspector\(\{ open: false \}\)/u);
  assert.match(script, /function disclosure/u);
  assert.match(script, /function tabbedTicketView/u);
  assert.match(script, /const requestedTicketId = focusQuery\.get\("ticket"\)/u);
  assert.match(model, /function localFocusHref/u);
  assert.match(model, /function normalizeLayoutDirection/u);
  assert.match(model, /function layoutDirectionHref/u);
  assert.match(model, /function workbenchOverview/u);
  assert.match(script, /\["log", "evidence"\]/u);
  assert.match(script, /initialFocusPending/u);
  assert.match(script, /initialTabId = "execution"/u);
  assert.match(script, /function ticketExecutionPanel/u);
  assert.match(model, /function ticketAttentionState/u);
  assert.match(script, /function humanAttentionBrief/u);
  assert.match(script, /Human evidence pending/u);
  assert.match(script, /Human acceptance verified/u);
  assert.match(script, /function contractBrief/u);
  assert.match(script, /function contractSupportDisclosure/u);
  assert.match(script, /\{ id: "evidence", label: "Log", panel: proof\.panel \}/u);
  assert.doesNotMatch(script, /label: "Proof"/u);
  assert.doesNotMatch(script, /label: "Evidence"/u);
  assert.doesNotMatch(
    script,
    /Evidence supports each condition; independent Outcome decides completion\./u,
  );
  assert.match(script, /signalMetric\("Reading", "evidence", "proof-metric"\)/u);
  assert.match(script, /No Evidence recorded yet/u);
  assert.match(script, /Acceptance conditions/u);
  assert.match(script, /Supporting contract/u);
  assert.match(script, /Working boundaries/u);
  assert.match(script, /Required context/u);
  assert.match(script, /Dependency & source/u);
  assert.doesNotMatch(script, /panel\.append\(guardrailView/u);
  assert.match(script, /function canonicalContextObject/u);
  assert.match(script, /function contextSourceView/u);
  assert.match(script, /function contextEvidenceView/u);
  assert.match(script, /function contextRelationsView/u);
  assert.match(script, /function typedReferenceList/u);
  assert.match(script, /Copy for Agent/u);
  assert.equal(
    (script.match(/`Ticket · \$\{ticket\.ticketId\}`/gu) || []).length,
    2,
  );
  assert.doesNotMatch(
    script,
    /`Ticket · \$\{shortTicketId\(ticket\.ticketId\)\}`/u,
  );
  assert.match(
    script,
    /function contextActions\(payload\)[\s\S]*?return actions;/u,
  );
  assert.doesNotMatch(
    script,
    /function contextActions\(payload\)[\s\S]*?appendOpenActions\([\s\S]*?return actions;/u,
  );
  assert.doesNotMatch(script, /function iconButton/u);
  assert.doesNotMatch(script, /Reference copied|Provenance copied|Worktree path copied/u);
  assert.match(script, /function updateTicketProof/u);
  assert.match(script, /function externalLinkIcon/u);
  assert.match(script, /Open \$\{target\.target\} on GitHub/u);
  assert.match(
    styles,
    /\.source-context > p \{[\s\S]*?margin: 0 11px 10px;[\s\S]*?\}/u,
  );
  assert.match(
    styles,
    /\.inspector-head \.eyebrow \{[\s\S]*?overflow-wrap: anywhere;[\s\S]*?text-transform: none;[\s\S]*?\}/u,
  );
  assert.match(script, /function revealTicket/u);
  assert.match(script, /incoming\.length - completed/u);
  assert.match(script, /Focused local link copied · valid while this host is running/u);
  assert.doesNotMatch(script, /inspectorOutcome\.textContent = operational\?\.detail/u);
  assert.match(script, /history\.replaceState\(null, "", nextHref\)/u);
  assert.doesNotMatch(script, /\/api\/(?:review|decision)/u);
  assert.match(styles, /\.ticket-node\.state-deviated/u);
  assert.match(styles, /\.ticket-node\.state-refine/u);
  assert.match(styles, /\.minimap-node\.state-refine/u);
  assert.match(styles, /\.execution-state\.state-refine/u);
  assert.match(styles, /\.ticket-node\.attention-pending \.ticket-attention/u);
  assert.match(styles, /\.human-attention-brief\.attention-pending/u);
  assert.match(styles, /\.acceptance-item\.authority-human/u);
  assert.match(styles, /\.ticket-node:focus-visible,[\s\S]*?outline: none;/u);
  assert.match(styles, /\.ticket-node:focus-visible \.ticket-boundary/u);
  assert.match(styles, /\.edge-control-halo/u);
  // Selected warm-neutral tokens and the neutral selection outline.
  assert.match(styles, /--canvas: #fafaf8/u);
  assert.match(styles, /--selection: #252523/u);
  assert.match(
    styles,
    /\.ticket-node\.selected \.ticket-boundary \{[\s\S]*?stroke: var\(--selection\)/u,
  );
  assert.doesNotMatch(styles, /\.implementing-strip|\.presence-empty|\.rail\s*\{/u);
  assert.match(styles, /\.overview-panel/u);
  assert.doesNotMatch(styles, /\.overview-source/u);
  assert.doesNotMatch(styles, /\.overview-item/u);
  assert.match(styles, /\.summary-grid/u);
  assert.match(styles, /min-height: 44px/u);
  assert.doesNotMatch(styles, /style-lab|style-option|style-swatch/u);
  assert.match(styles, /\.inspector-disclosure/u);
  assert.match(styles, /\.inspector h1:focus-visible/u);
  assert.match(styles, /\.ticket-tabs/u);
  assert.match(styles, /\.acceptance-rail/u);
  assert.match(styles, /\.contract-brief/u);
  assert.match(styles, /\.contract-support-disclosure/u);
  assert.match(styles, /\.contract-support-body/u);
  assert.match(styles, /\.reference-link-icon/u);
  assert.match(styles, /\.guardrail-list/u);
  assert.match(styles, /\.context-grid/u);
  assert.match(styles, /\.source-dock/u);
  assert.match(styles, /\.typed-reference/u);
  assert.match(styles, /\.context-source-card/u);
  assert.match(styles, /\.context-evidence-row/u);
  assert.match(styles, /\.context-relation-row/u);
  assert.match(styles, /\.causal-more/u);
  assert.match(styles, /@media \(max-width: 720px\)/u);
  assert.doesNotMatch(styles, /\.(?:surface|signal|sheet)(?:\s|\{|\.)/u);
  assert.doesNotMatch(styles, /ui-serif|Iowan Old Style|Palatino|#245b43/u);

  assert.deepEqual(canonicalBytes(repo), beforeUi);

  const newlyVisible = ticket("newly-visible");
  newlyVisible.maturity = "draft";
  assert.equal(run(repo, "ticket", "apply", {
    tickets: [newlyVisible],
  }).status, 0);
  const refreshed = (await (await fetch(
    `${origin}/api/state`,
    authorized(token),
  )).json()).data;
  assert.equal(refreshed.graph.tickets.length, 5);
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
  assert.equal(draftSubject.contextPackage.operationalState, "REFINE");
  assert.equal(draftSubject.contextPackage.nextAction.action, "REFINE");
  assert.equal(draftSubject.contextPackage.agentPayload.maturity, "draft");
  assert.equal(draftSubject.contextPackage.agentPayload.operationalState, "REFINE");
});

test("launcher flags stay intentionally narrow", () => {
  assert.deepEqual(parseUiFlags([]), {
    repo: process.cwd(),
    port: 0,
    open: true,
    json: false,
    ticket: null,
    view: null,
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
  });
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
