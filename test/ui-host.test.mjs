import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  assert.equal(run(repo, "ticket", "apply", {
    tickets: [
      ticket("foundation"),
      ticket("feature", ["foundation"]),
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
    refs: ["test:foundation"],
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

  const trace = (await (await fetch(
    `${origin}/api/trace?${ticketQuery}`,
    authorized(token),
  )).json()).data;
  assert.deepEqual(trace.records.map((record) => record.kind), ["evidence", "outcome"]);
  assert.equal(trace.records[1].subkind, "successful");

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
  assert.doesNotMatch(html, /class="(?:surface|signal|sheet)/u);
  assert.match(script, /function layoutGraph/u);
  assert.match(script, /function causalCone/u);
  assert.match(script, /minimapWorldPoint/u);
  assert.match(script, /copyText\(location\.href, "Authorized link copied"\)/u);
  assert.doesNotMatch(script, /history\.replaceState/u);
  assert.doesNotMatch(script, /\/api\/(?:review|decision)/u);
  assert.match(styles, /\.ticket-node\.state-deviated/u);
  assert.match(styles, /@media \(max-width: 720px\)/u);
  assert.doesNotMatch(styles, /\.(?:surface|signal|sheet)(?:\s|\{|\.)/u);

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
