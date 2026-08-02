import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { buildUiSnapshot, parseUiFlags, startVibeHubUi } from "../skills/scripts/vh-ui.mjs";
import { context, run, tempRepo, ticket } from "./helpers.mjs";

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
  assert.equal(run(repo, "context", "put", context()).status, 0);
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "LOCAL_GRAPH_DESIGN.md"), "# Local graph design\n");
  const feature = ticket("feature", ["foundation"]);
  feature.context_refs = [
    {
      ref: ".vibehub/context/decision-use-tickets.yaml",
      purpose: "Canonical product direction.",
    },
    {
      ref: "docs/LOCAL_GRAPH_DESIGN.md",
      purpose: "Design source when present.",
    },
  ];
  assert.equal(run(repo, "ticket", "apply", {
    tickets: [
      ticket("foundation"),
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
    refs: ["test:foundation", "browser:foundation-reviewed"],
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

test("read-only loopback host serves assets, current graph, inspector, and trace", async () => {
  const repo = fixture();
  const beforeUi = canonicalBytes(repo);
  const token = "a".repeat(64);
  const host = startVibeHubUi({ repoRoot: repo, token, tokenLifetimeMs: 60_000 });
  hosts.push(host);
  const { origin, url } = await host.ready;
  assert.equal(new URL(url).hash, `#${token}`);

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
  assert.equal(state.graph.source.actions.worktree.editorHref.startsWith("vscode://file"), true);
  assert.equal(state.graph.source.agentPayload.kind, "vibehub_git_source");

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
  assert.equal(subject.contextPackage.agentPayload.kind, "vibehub_ticket_handoff");

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
  assert.equal(featureSubject.contextPackage.contextRefs[1].kind, "source");
  assert.equal(featureSubject.contextPackage.contextRefs[1].canonicalContext, null);
  assert.equal("actions" in featureSubject.contextPackage.contextRefs[1], false);

  const trace = (await (await fetch(
    `${origin}/api/trace?${ticketQuery}`,
    authorized(token),
  )).json()).data;
  assert.deepEqual(trace.records.map((record) => record.kind), ["evidence", "outcome"]);
  assert.deepEqual(trace.records[0].acceptanceIds, ["works"]);
  assert.deepEqual(
    trace.records[0].targets.map((target) => target.kind),
    ["test", "browser"],
  );
  assert.equal(trace.records[0].agentPayload.kind, "vibehub_ticket_evidence");
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
  const script = await (await fetch(`${origin}/app.js`)).text();
  const styles = await (await fetch(`${origin}/app.css`)).text();
  assert.match(html, /class="app-shell"/u);
  assert.match(html, /id="copyLink"/u);
  assert.match(html, /class="workspace inspector-closed"/u);
  assert.match(html, /id="graphSignal"/u);
  assert.match(html, /id="sourceDock"/u);
  assert.doesNotMatch(html, /class="(?:surface|signal|sheet)/u);
  assert.doesNotMatch(html, /state-legend|brand-mark/u);
  assert.match(script, /function layoutGraph/u);
  assert.match(script, /function causalCone/u);
  assert.match(script, /function relationPorts/u);
  assert.match(script, /edge-control-halo/u);
  assert.match(script, /minimapWorldPoint/u);
  assert.match(script, /renderGraphInspector\(\{ open: false \}\)/u);
  assert.match(script, /function disclosure/u);
  assert.match(script, /function tabbedTicketView/u);
  assert.match(script, /function ticketExecutionPanel/u);
  assert.match(script, /function contractBrief/u);
  assert.match(script, /function contractSupportDisclosure/u);
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
  assert.match(script, /copyText\(location\.href, "Authorized link copied"\)/u);
  assert.doesNotMatch(script, /inspectorOutcome\.textContent = operational\?\.detail/u);
  assert.doesNotMatch(script, /history\.replaceState/u);
  assert.doesNotMatch(script, /\/api\/(?:review|decision)/u);
  assert.match(styles, /\.ticket-node\.state-deviated/u);
  assert.match(styles, /\.ticket-node:focus-visible,[\s\S]*?outline: none;/u);
  assert.match(styles, /\.ticket-node:focus-visible \.ticket-boundary/u);
  assert.match(styles, /\.edge-control-halo/u);
  assert.match(styles, /--canvas: #f1f2f0/u);
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

  assert.equal(run(repo, "ticket", "apply", {
    tickets: [ticket("newly-visible")],
  }).status, 0);
  const refreshed = (await (await fetch(
    `${origin}/api/state`,
    authorized(token),
  )).json()).data;
  assert.equal(refreshed.graph.tickets.length, 5);
  assert.notEqual(refreshed.graph.snapshotId, state.graph.snapshotId);
});

test("launcher flags stay intentionally narrow", () => {
  assert.deepEqual(parseUiFlags([]), {
    repo: process.cwd(),
    port: 0,
    open: true,
    json: false,
  });
  assert.deepEqual(parseUiFlags([
    "--repo", ".", "--port", "4321", "--no-open", "--json",
  ]), {
    repo: process.cwd(),
    port: 4321,
    open: false,
    json: true,
  });
  assert.throws(() => parseUiFlags(["--db", "state.sqlite"]), /unknown flag/u);
  assert.throws(() => parseUiFlags(["--port", "70000"]), /between 0 and 65535/u);
});
