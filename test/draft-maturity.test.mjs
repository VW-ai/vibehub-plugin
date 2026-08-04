import test from "node:test";
import assert from "node:assert/strict";
import { buildUiSnapshot } from "../skills/scripts/vh-ui.mjs";
import { run, tempRepo, ticket } from "./helpers.mjs";

function draft(id, dependencies = []) {
  return { ...ticket(id, dependencies), maturity: "draft" };
}

function statusOf(repo, id) {
  const result = run(repo, "ticket", "get", { ticket_id: id });
  assert.equal(result.status, 0, result.stdout);
  return result.envelope.data.status;
}

test("maturity accepts only draft and existing tickets stay valid", () => {
  const repo = tempRepo("draft-schema");
  assert.equal(run(repo, "project", "init").status, 0);
  assert.equal(run(repo, "ticket", "apply", { tickets: [draft("sketch")] }).status, 0);

  const invalid = run(repo, "ticket", "apply", { tickets: [{ ...ticket("bad"), maturity: "firm" }] });
  assert.notEqual(invalid.status, 0);
  assert.match(JSON.stringify(invalid.envelope.error.details), /must equal draft when present/);
});

test("an unblocked draft surfaces as REFINE, never READY, and firms up in place", () => {
  const repo = tempRepo("draft-chain");
  assert.equal(run(repo, "project", "init").status, 0);
  assert.equal(run(repo, "ticket", "apply", {
    tickets: [
      ticket("blocker"),
      draft("frontend", ["blocker"]),
      draft("e2e", ["frontend"]),
    ],
  }).status, 0);

  assert.equal(statusOf(repo, "blocker"), "READY");
  assert.equal(statusOf(repo, "frontend"), "BLOCKED");

  assert.equal(run(repo, "ticket", "evidence", {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: "blocker-works",
    ticket_id: "blocker",
    acceptance_ids: ["works"],
    summary: "The blocker behavior was observed.",
    refs: ["test:draft-chain"],
    recorded_at: "2026-08-04T00:00:00.000Z",
  }).status, 0);
  assert.equal(run(repo, "ticket", "closeout", {
    schema_version: 1,
    kind: "ticket_outcome",
    ticket_id: "blocker",
    status: "successful",
    accepted_acceptance_ids: ["works"],
    unresolved_acceptance_ids: [],
    evidence_ids: ["blocker-works"],
    summary: "Blocker closed with full evidence.",
    closed_at: "2026-08-04T00:00:00.000Z",
  }).status, 0);

  assert.equal(statusOf(repo, "frontend"), "REFINE");
  assert.equal(statusOf(repo, "e2e"), "BLOCKED");

  const frontier = run(repo, "ticket", "frontier");
  assert.deepEqual(
    frontier.envelope.data.ready.map((item) => item.ticket.ticket_id),
    [],
    "a draft must never enter the READY frontier",
  );

  const firmed = ticket("frontend", ["blocker"]);
  firmed.acceptance = [{ acceptance_id: "interaction-approved", criterion: "The approved interaction design is implemented." }];
  assert.equal(run(repo, "ticket", "apply", { tickets: [firmed] }).status, 0);
  assert.equal(statusOf(repo, "frontend"), "READY");
  assert.equal(
    run(repo, "ticket", "frontier").envelope.data.ready.map((item) => item.ticket.ticket_id).join(","),
    "frontend",
  );
});

test("the projection reports REFINE honestly instead of the READY wording", () => {
  const repo = tempRepo("draft-projection");
  assert.equal(run(repo, "project", "init").status, 0);
  assert.equal(run(repo, "ticket", "apply", { tickets: [draft("sketch")] }).status, 0);
  const snapshot = buildUiSnapshot(repo);
  const node = snapshot.state.graph.tickets.find((item) => item.ticketId === "sketch");
  assert.ok(node, JSON.stringify(snapshot.state.graph.tickets.map((item) => item.ticketId)));
  assert.equal(node.capabilities.operational.summary.label, "REFINE");
  assert.match(node.capabilities.operational.summary.detail, /planning must rewrite its acceptance/);
  assert.doesNotMatch(node.capabilities.operational.summary.detail, /prevents execution/);
});
