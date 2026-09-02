import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRepo } from "./helpers.mjs";
import {
  computeProjection, humanizeTicketId, markerValue, planSync, planUpdates, planDependencies,
  TICKET_MARKER, EVIDENCE_MARKER,
} from "../scripts/sync-github-issues.mjs";

const GITHUB = "acme/demo";

function ticket(id, extra = {}) {
  return {
    schema_version: 2, kind: "ticket", ticket_id: id, maturity: "firm",
    outcome: `Outcome of ${id}`, deliveries: [], context: "ctx",
    acceptance: [{ acceptance_id: "a1", criterion: "first" }, { acceptance_id: "a2", criterion: "second", authority: "human" }],
    constraints: ["no write-back"], context_refs: [{ ref: "README.md", purpose: "readme" }],
    relations: [], provenance_refs: ["conversation:test"], ...extra,
  };
}

function fixtureRepo() {
  const repo = tempRepo("sync-issues");
  for (const d of ["tickets", "outcomes", "evidence/ticket-done", "rooms"]) mkdirSync(join(repo, ".vibehub", d), { recursive: true });
  writeFileSync(join(repo, ".vibehub", "version.yaml"), JSON.stringify({ schema_version: 1, kind: "vibehub_project", format_version: 2 }));
  writeFileSync(join(repo, "README.md"), "# demo\n");
  writeFileSync(join(repo, ".vibehub", "tickets", "ticket-done.yaml"), JSON.stringify(ticket("ticket-done")));
  writeFileSync(join(repo, ".vibehub", "tickets", "ticket-open.yaml"), JSON.stringify(ticket("ticket-open", {
    relations: [{ type: "depends_on", target_ticket_id: "ticket-done", rationale: "needs it" }],
  })));
  writeFileSync(join(repo, ".vibehub", "outcomes", "ticket-done.yaml"), JSON.stringify({
    schema_version: 1, kind: "ticket_outcome", independence: { source: "subagent", note: "test fixture" }, ticket_id: "ticket-done", status: "successful",
    accepted_acceptance_ids: ["a1", "a2"], unresolved_acceptance_ids: [], evidence_ids: ["proof-one", "owner-signoff"],
    summary: "All good.", closed_at: "2026-08-01T00:00:00Z",
  }));
  writeFileSync(join(repo, ".vibehub", "evidence", "ticket-done", "proof-one.yaml"), JSON.stringify({
    schema_version: 1, kind: "ticket_evidence", evidence_id: "proof-one", ticket_id: "ticket-done",
    acceptance_ids: ["a1"], summary: "It works.", refs: ["commit:abc1234"], recorded_at: "2026-07-31T00:00:00Z",
  }));
  writeFileSync(join(repo, ".vibehub", "evidence", "ticket-done", "owner-signoff.yaml"), JSON.stringify({
    schema_version: 1, kind: "ticket_evidence", evidence_id: "owner-signoff", ticket_id: "ticket-done", origin: "human",
    acceptance_ids: ["a2"], summary: "Owner approved.", refs: ["conversation:2026-07-31-signoff"], recorded_at: "2026-07-31T01:00:00Z",
  }));
  return repo;
}

function remoteFrom(projection, startNumber = 1) {
  const numbers = new Map(projection.map((item, i) => [item.ticket_id, startNumber + i]));
  return projection.map((item) => ({
    number: numbers.get(item.ticket_id), title: item.title, body: item.renderBody(numbers),
    state: item.state.toUpperCase(), labels: item.labels.map((name) => ({ name })),
    comments: item.comments.map((c) => ({ body: c.body })),
  }));
}

test("humanizes ticket ids into titles", () => {
  assert.equal(humanizeTicketId("ticket-mirror-tickets-to-github-issues"), "Mirror tickets to GitHub issues");
  assert.equal(humanizeTicketId("ticket-release-v050"), "Release v050");
});

test("projection renders state, checklist, dependencies, evidence, and markers", () => {
  const p = computeProjection(fixtureRepo(), GITHUB);
  assert.deepEqual(p.map((x) => x.ticket_id), ["ticket-done", "ticket-open"]);
  const [done, open] = p;
  assert.equal(done.state, "closed");
  assert.deepEqual(done.labels, ["state: done", "maturity: firm"]);
  assert.equal(open.state, "open");
  assert.deepEqual(open.labels, ["state: needs-human", "maturity: firm"]);
  const numbers = new Map([["ticket-done", 7], ["ticket-open", 8]]);
  const doneBody = done.renderBody(numbers);
  assert.equal(markerValue(doneBody, TICKET_MARKER), "ticket-done");
  assert.match(doneBody, /- \[x\] \*\*`a1`\*\* — first/);
  assert.match(doneBody, /- \[x\] \*\*`a2`\*\* 👤 human — second/);
  assert.match(doneBody, /https:\/\/github\.com\/acme\/demo\/blob\/main\/README\.md/);
  assert.match(doneBody, /## Outcome record · successful/);
  assert.match(open.renderBody(numbers), /Blocked by #7 — needs it/);
  assert.equal(done.comments.length, 2);
  assert.equal(markerValue(done.comments[0].body, EVIDENCE_MARKER), "proof-one");
});

test("empty remote plans one create per ticket, then bodies with resolved numbers", () => {
  const p = computeProjection(fixtureRepo(), GITHUB);
  const { byTicket, creates } = planSync(p, []);
  assert.equal(creates.length, 2);
  byTicket.set("ticket-done", { number: 1, body: "", state: "OPEN", labels: [], comments: [] });
  byTicket.set("ticket-open", { number: 2, body: "", state: "OPEN", labels: [], comments: [] });
  const ops = planUpdates(p, byTicket);
  assert.deepEqual(ops.map((o) => o.kind), ["update", "comment", "comment", "close", "update"]);
  assert.match(ops[4].body, /Blocked by #1/);
});

test("a remote that already matches produces zero operations", () => {
  const p = computeProjection(fixtureRepo(), GITHUB);
  const remote = remoteFrom(p, 40);
  const { byTicket, creates } = planSync(p, remote);
  assert.equal(creates.length, 0);
  assert.deepEqual(planUpdates(p, byTicket), []);
});

test("drift in state, labels, or missing evidence is repaired without touching the rest", () => {
  const p = computeProjection(fixtureRepo(), GITHUB);
  const remote = remoteFrom(p, 1);
  remote[0].state = "OPEN";                        // someone reopened a DONE ticket
  remote[0].comments = [];                          // evidence comment missing
  remote[1].labels = [{ name: "state: done" }, { name: "bug" }]; // wrong managed label, foreign label kept
  const { byTicket } = planSync(p, remote);
  const ops = planUpdates(p, byTicket);
  assert.deepEqual(ops.map((o) => `${o.kind}:${o.ticket_id}`), ["comment:ticket-done", "comment:ticket-done", "close:ticket-done", "update:ticket-open"]);
  assert.deepEqual(ops[3].addLabels, ["state: needs-human", "maturity: firm"]);
  assert.deepEqual(ops[3].removeLabels, ["state: done"]);
});

test("native dependencies: add missing, remove stale mirrored, keep foreign, no-op when matching", () => {
  const p = computeProjection(fixtureRepo(), GITHUB);
  const { byTicket } = planSync(p, remoteFrom(p, 1)); // ticket-done=#1, ticket-open=#2
  // nothing on remote → add #2 blocked by #1
  assert.deepEqual(planDependencies(p, byTicket, new Map()), [{ kind: "dep-add", number: 2, ticket_id: "ticket-open", blocker: 1 }]);
  // matching → no-op
  assert.deepEqual(planDependencies(p, byTicket, new Map([[2, [1]]])), []);
  // stale mirrored relation on #1 (blocked by #2) is removed; foreign blocker #99 on #2 is kept
  assert.deepEqual(planDependencies(p, byTicket, new Map([[1, [2]], [2, [1, 99]]])), [
    { kind: "dep-remove", number: 1, ticket_id: "ticket-done", blocker: 2 },
  ]);
});
