import test from "node:test";
import assert from "node:assert/strict";
import { run, tempRepo, ticket } from "./helpers.mjs";

const at = "2026-07-31T22:00:00.000Z";

test("Ticket graph validates dependencies and successful closeout unlocks only direct dependents", () => {
  const repo = tempRepo("ticket-vertical");
  assert.equal(run(repo, "project", "init").status, 0);
  const applied = run(repo, "ticket", "apply", {
    tickets: [ticket("base"), ticket("dependent", ["base"]), ticket("downstream", ["dependent"])],
  });
  assert.equal(applied.status, 0, applied.stdout);

  let frontier = run(repo, "ticket", "frontier");
  assert.deepEqual(frontier.envelope.data.ready.map((item) => item.ticket.ticket_id), ["base"]);

  const badEvidence = run(repo, "ticket", "evidence", {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: "bad-proof",
    ticket_id: "base",
    acceptance_ids: ["missing"],
    summary: "This should not persist.",
    refs: ["test:bad"],
    recorded_at: at,
  });
  assert.notEqual(badEvidence.status, 0);
  assert.match(JSON.stringify(badEvidence.envelope.error.details), /missing acceptance/);

  const evidence = run(repo, "ticket", "evidence", {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: "base-proof",
    ticket_id: "base",
    acceptance_ids: ["works"],
    summary: "The base behavior passed.",
    refs: ["test/ticket.test.mjs"],
    recorded_at: at,
  });
  assert.equal(evidence.status, 0, evidence.stdout);

  const closeout = run(repo, "ticket", "closeout", {
    schema_version: 1,
    kind: "ticket_outcome",
    ticket_id: "base",
    status: "successful",
    accepted_acceptance_ids: ["works"],
    unresolved_acceptance_ids: [],
    evidence_ids: ["base-proof"],
    summary: "Independent verification accepted the base Ticket.",
    closed_at: at,
  });
  assert.equal(closeout.status, 0, closeout.stdout);
  frontier = run(repo, "ticket", "frontier");
  assert.deepEqual(frontier.envelope.data.ready.map((item) => item.ticket.ticket_id), ["dependent"]);

  assert.equal(run(repo, "ticket", "evidence", {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: "dependent-proof",
    ticket_id: "dependent",
    acceptance_ids: ["works"],
    summary: "Dependent work was attempted but remains partial.",
    refs: ["test/ticket.test.mjs"],
    recorded_at: at,
  }).status, 0);
  assert.equal(run(repo, "ticket", "closeout", {
    schema_version: 1,
    kind: "ticket_outcome",
    ticket_id: "dependent",
    status: "partial",
    accepted_acceptance_ids: [],
    unresolved_acceptance_ids: ["works"],
    evidence_ids: [],
    summary: "The criterion remains unresolved.",
    closed_at: at,
  }).status, 0);
  frontier = run(repo, "ticket", "frontier");
  assert.equal(frontier.envelope.data.ready.some((item) => item.ticket.ticket_id === "downstream"), false);
});

test("Ticket validation rejects missing endpoints and dependency cycles", () => {
  const missingRepo = tempRepo("ticket-missing");
  assert.equal(run(missingRepo, "project", "init").status, 0);
  const missing = run(missingRepo, "ticket", "apply", { tickets: [ticket("a", ["missing"])] });
  assert.notEqual(missing.status, 0);
  assert.match(JSON.stringify(missing.envelope.error.details), /dangling Ticket dependency/);

  const cycleRepo = tempRepo("ticket-cycle");
  assert.equal(run(cycleRepo, "project", "init").status, 0);
  const cycle = run(cycleRepo, "ticket", "apply", {
    tickets: [ticket("a", ["b"]), ticket("b", ["a"])],
  });
  assert.notEqual(cycle.status, 0);
  assert.match(JSON.stringify(cycle.envelope.error.details), /dependency cycle/);
});

test("human acceptance stays orthogonal to readiness and requires human-origin Evidence", () => {
  const repo = tempRepo("ticket-human-authority");
  assert.equal(run(repo, "project", "init").status, 0);

  const human = ticket("human-boundary");
  human.acceptance[0].authority = "human";
  const invalid = ticket("invalid-authority");
  invalid.acceptance[0].authority = "robot";
  const rejected = run(repo, "ticket", "apply", { tickets: [invalid] });
  assert.notEqual(rejected.status, 0);
  assert.match(JSON.stringify(rejected.envelope.error.details), /authority/u);

  assert.equal(run(repo, "ticket", "apply", {
    tickets: [
      ticket("agent-default"),
      human,
      ticket("after-human", ["human-boundary"]),
    ],
  }).status, 0);
  let frontier = run(repo, "ticket", "frontier");
  assert.deepEqual(
    frontier.envelope.data.ready.map((item) => item.ticket.ticket_id),
    ["agent-default", "human-boundary"],
  );

  const invalidOrigin = run(repo, "ticket", "evidence", {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: "invalid-origin",
    ticket_id: "agent-default",
    acceptance_ids: ["works"],
    summary: "An unknown origin must not persist.",
    refs: ["test:invalid-origin"],
    origin: "robot",
    recorded_at: at,
  });
  assert.notEqual(invalidOrigin.status, 0);
  assert.match(JSON.stringify(invalidOrigin.envelope.error.details), /origin/u);

  assert.equal(run(repo, "ticket", "evidence", {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: "agent-assertion",
    ticket_id: "human-boundary",
    acceptance_ids: ["works"],
    summary: "The Agent recommends accepting the human boundary.",
    refs: ["test:agent-assertion"],
    recorded_at: at,
  }).status, 0);
  const selfAccepted = run(repo, "ticket", "closeout", {
    schema_version: 1,
    kind: "ticket_outcome",
    ticket_id: "human-boundary",
    status: "successful",
    accepted_acceptance_ids: ["works"],
    unresolved_acceptance_ids: [],
    evidence_ids: ["agent-assertion"],
    summary: "An Agent assertion cannot satisfy human authority.",
    closed_at: at,
  });
  assert.notEqual(selfAccepted.status, 0);
  assert.match(
    JSON.stringify(selfAccepted.envelope.error.details),
    /human-origin Evidence/u,
  );

  assert.equal(run(repo, "ticket", "evidence", {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: "human-decision",
    ticket_id: "human-boundary",
    acceptance_ids: ["works"],
    summary: "The human explicitly accepted the criterion.",
    refs: ["conversation:test-human-decision"],
    origin: "human",
    recorded_at: at,
  }).status, 0);
  assert.equal(run(repo, "ticket", "closeout", {
    schema_version: 1,
    kind: "ticket_outcome",
    ticket_id: "human-boundary",
    status: "successful",
    accepted_acceptance_ids: ["works"],
    unresolved_acceptance_ids: [],
    evidence_ids: ["agent-assertion", "human-decision"],
    summary: "Human-origin Evidence satisfies the protected boundary.",
    closed_at: at,
  }).status, 0);

  frontier = run(repo, "ticket", "frontier");
  assert.deepEqual(
    frontier.envelope.data.ready.map((item) => item.ticket.ticket_id),
    ["after-human", "agent-default"],
  );
});
