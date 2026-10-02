import assert from "node:assert/strict";
import test from "node:test";
import { run, tempRepo, ticket } from "./helpers.mjs";

const at = "2026-08-20T19:30:00.000Z";

function ok(result) {
  assert.equal(result.status, 0, result.stdout);
  return result.envelope.data;
}

function evidence(id, ticketId, origin = "agent") {
  return {
    schema_version: 1, kind: "ticket_evidence", evidence_id: id, ticket_id: ticketId,
    acceptance_ids: ["works"], summary: "The criterion was checked.", refs: [`test:${id}`],
    origin, recorded_at: at,
  };
}

function outcome(ticketId, status, accepted = [], evidenceIds = []) {
  return {
    schema_version: 1, kind: "ticket_outcome", ticket_id: ticketId, status,
    accepted_acceptance_ids: accepted,
    unresolved_acceptance_ids: accepted.length ? [] : ["works"],
    evidence_ids: evidenceIds, summary: `Historical result was ${status}.`, closed_at: at,
  };
}

test("human proof stays valid history without routing or completion authority", () => {
  const repo = tempRepo("ticket-proof-memory");
  ok(run(repo, "project", "init"));
  const human = ticket("human-decision");
  human.acceptance[0].authority = "human";
  ok(run(repo, "ticket", "apply", { tickets: [human, ticket("dependent", ["human-decision"])] }));
  assert.equal(ok(run(repo, "ticket", "get", { ticket_id: "human-decision" })).status, "OPEN");
  assert.equal(ok(run(repo, "ticket", "get", { ticket_id: "dependent" })).status, "BLOCKED");

  ok(run(repo, "ticket", "evidence", evidence("agent-proof", "human-decision")));
  const rejected = run(repo, "ticket", "closeout", outcome("human-decision", "successful", ["works"], ["agent-proof"]));
  assert.equal(rejected.envelope.error.code, "validation_error");
  assert.match(JSON.stringify(rejected.envelope.error.details), /human-origin Evidence/u);

  ok(run(repo, "ticket", "evidence", evidence("human-proof", "human-decision", "human")));
  ok(run(repo, "ticket", "closeout", outcome("human-decision", "successful", ["works"], ["human-proof"])));
  const recorded = ok(run(repo, "ticket", "get", { ticket_id: "human-decision" }));
  assert.equal(recorded.status, "OPEN");
  assert.equal(recorded.outcome_history[0].status, "successful");
  assert.deepEqual(recorded.evidence.map((item) => item.evidence_id), ["agent-proof", "human-proof"]);
  assert.equal(ok(run(repo, "ticket", "get", { ticket_id: "dependent" })).status, "BLOCKED");

  ok(run(repo, "ticket", "update", {
    ticket_id: "human-decision", update_id: "decision-done", summary: "Decision complete.", status: "done", recorded_at: at,
  }));
  assert.equal(ok(run(repo, "ticket", "get", { ticket_id: "dependent" })).status, "OPEN");
});

test("partial, failed, and deviated Outcomes do not prescribe the task state", () => {
  const repo = tempRepo("ticket-outcome-memory");
  ok(run(repo, "project", "init"));
  ok(run(repo, "ticket", "apply", { tickets: [ticket("partial"), ticket("failed"), ticket("deviated")] }));
  for (const status of ["partial", "failed", "deviated"]) {
    ok(run(repo, "ticket", "closeout", outcome(status, status)));
    const record = ok(run(repo, "ticket", "get", { ticket_id: status }));
    assert.equal(record.status, "OPEN");
    assert.equal(record.outcome_history[0].status, status);
  }
  ok(run(repo, "ticket", "update", {
    ticket_id: "partial", update_id: "partial-progress", summary: "Work continues.", status: "in_progress", recorded_at: at,
  }));
  ok(run(repo, "ticket", "update", {
    ticket_id: "failed", update_id: "failed-done", summary: "Task is closed after failed attempt.", status: "done", recorded_at: at,
  }));
  const frontier = ok(run(repo, "ticket", "frontier"));
  assert.deepEqual(frontier.open.map((item) => item.ticket.ticket_id), ["deviated"]);
  assert.deepEqual(frontier.in_progress.map((item) => item.ticket.ticket_id), ["partial"]);
  assert.equal(frontier.count, 2);
  assert.equal(ok(run(repo, "ticket", "get", { ticket_id: "failed" })).outcome_history[0].status, "failed");
});
