import test from "node:test";
import assert from "node:assert/strict";
import { ticketArchived } from "../skills/vibehub-core/scripts/vh.mjs";
import { context, room, run, tempRepo, ticket, writeRoom } from "./helpers.mjs";

const at = "2026-07-31T22:00:00.000Z";
const deliveredCommit = "a".repeat(40);
const deliveryRef = "https://github.com/VW-ai/vibehub-plugin/pull/77";

function closeSuccessfully(repo, ticketId) {
  assert.equal(run(repo, "ticket", "evidence", {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: `${ticketId}-proof`,
    ticket_id: ticketId,
    acceptance_ids: ["works"],
    summary: `${ticketId} passed.`,
    refs: [`test:${ticketId}`],
    recorded_at: at,
  }).status, 0);
  assert.equal(run(repo, "ticket", "closeout", {
    schema_version: 1,
    kind: "ticket_outcome", independence: { source: "subagent", note: "test fixture" },
    ticket_id: ticketId,
    status: "successful",
    accepted_acceptance_ids: ["works"],
    unresolved_acceptance_ids: [],
    evidence_ids: [`${ticketId}-proof`],
    summary: `${ticketId} independently passed.`,
    closed_at: at,
  }).status, 0);
}

test("delivery archive and shared current/all/delivery/Room queries stay truthful", () => {
  const repo = tempRepo("ticket-archive-query");
  assert.equal(run(repo, "project", "init").status, 0);
  writeRoom(repo, "product", room("product"));
  writeRoom(repo, "product/web", room("web"));
  assert.equal(run(repo, "context", "put", context({
    context_id: "decision-web-query",
  }), ["--room", "product/web"]).status, 0);
  const contextRef = ".vibehub/rooms/product/web/decision-web-query.yaml";
  const delivered = (id, dependencies = []) => ({
    ...ticket(id, dependencies),
    context_refs: [{ ref: contextRef, purpose: "Web query authority." }],
    deliveries: [{
      kind: "pull_request",
      ref: deliveryRef,
      state: "delivered",
      delivered_at: at,
      delivered_commit: deliveredCommit,
    }],
  });
  const old = delivered("old-history");
  const boundary = delivered("archived-boundary", ["old-history"]);
  const current = ticket("current-work", ["archived-boundary"]);
  current.context_refs = [{ ref: contextRef, purpose: "Web query authority." }];
  assert.equal(run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [old, boundary, current, ticket("unrelated-current")],
  }).status, 0);
  closeSuccessfully(repo, "old-history");
  closeSuccessfully(repo, "archived-boundary");

  const currentGraph = run(repo, "ticket", "graph").envelope.data;
  assert.deepEqual(
    currentGraph.tickets.map((item) => [item.ticket.ticket_id, item.archived]),
    [["archived-boundary", true], ["current-work", false], ["unrelated-current", false]],
  );
  assert.deepEqual(currentGraph.stubs, [{
    stub_ref: "archived-boundary:upstream",
    anchor_ticket_id: "archived-boundary",
    direction: "upstream",
    hidden_ticket_count: 1,
    next_ticket_ids: ["old-history"],
  }]);
  const all = run(repo, "ticket", "graph", undefined, ["--scope", "all"]).envelope.data;
  assert.deepEqual(all.tickets.map((item) => item.ticket.ticket_id), [
    "archived-boundary", "current-work", "old-history", "unrelated-current",
  ]);
  assert.deepEqual(all.stubs, []);
  const byDelivery = run(repo, "ticket", "graph", undefined, [
    "--scope", "all", "--delivery", deliveryRef,
  ]).envelope.data;
  assert.deepEqual(byDelivery.tickets.map((item) => item.ticket.ticket_id), [
    "archived-boundary", "old-history",
  ]);
  const byRoom = run(repo, "ticket", "graph", undefined, [
    "--scope", "all", "--room", "product",
  ]).envelope.data;
  assert.deepEqual(byRoom.tickets.map((item) => item.ticket.ticket_id), [
    "archived-boundary", "current-work", "old-history",
  ]);
  assert.equal(run(repo, "ticket", "graph", undefined, ["--scope", "past"]).envelope.error.code, "invalid_argument");
  assert.equal(run(repo, "ticket", "graph", undefined, ["--delivery", "PR-77"]).envelope.error.code, "invalid_argument");
  assert.equal(run(repo, "ticket", "graph", undefined, ["--room", "missing"]).envelope.error.code, "invalid_argument");
});

test("delivery schema requires an explicit array and enforces discriminated states and unique refs", () => {
  const repo = tempRepo("ticket-delivery-schema");
  assert.equal(run(repo, "project", "init").status, 0);
  const legacy = ticket("legacy-schema");
  legacy.schema_version = 1;
  const rejectedLegacy = run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [legacy] });
  assert.notEqual(rejectedLegacy.status, 0);
  assert.match(JSON.stringify(rejectedLegacy.envelope.error.details), /schema_version.*must equal 2/u);
  const missing = ticket("missing-deliveries");
  delete missing.deliveries;
  assert.notEqual(run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [missing] }).status, 0);
  assert.equal(run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [ticket("explicit-current")] }).status, 0);
  const proposed = ticket("proposed-work");
  proposed.deliveries = [{ kind: "pull_request", ref: deliveryRef, state: "proposed" }];
  assert.equal(run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [proposed] }).status, 0);
  const invalid = ticket("invalid-delivery");
  invalid.deliveries = [{
    kind: "pull_request",
    ref: deliveryRef,
    state: "proposed",
    delivered_commit: deliveredCommit,
  }];
  const rejected = run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [invalid] });
  assert.notEqual(rejected.status, 0);
  assert.match(JSON.stringify(rejected.envelope.error.details), /only for delivered/u);
  const duplicate = ticket("duplicate-delivery");
  duplicate.deliveries = [
    { kind: "pull_request", ref: deliveryRef, state: "proposed" },
    { kind: "pull_request", ref: deliveryRef, state: "abandoned" },
  ];
  assert.match(
    JSON.stringify(run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [duplicate] }).envelope.error.details),
    /unique per Ticket/u,
  );
});

test("current scope is seeded by actionable Tickets rather than delivery metadata", () => {
  const repo = tempRepo("ticket-actionable-current");
  assert.equal(run(repo, "project", "init").status, 0);
  const old = ticket("old-done");
  const boundary = ticket("done-boundary", ["old-done"]);
  const unrelated = ticket("unrelated-done");
  const current = ticket("current-work", ["done-boundary"]);
  assert.equal(run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [old, boundary, unrelated, current],
  }).status, 0);
  for (const id of ["old-done", "done-boundary", "unrelated-done"]) closeSuccessfully(repo, id);

  const graph = run(repo, "ticket", "graph").envelope.data;
  assert.deepEqual(graph.tickets.map((item) => [item.ticket.ticket_id, item.archived]), [
    ["current-work", false], ["done-boundary", false],
  ]);
  assert.deepEqual(graph.stubs, [{
    stub_ref: "done-boundary:upstream",
    anchor_ticket_id: "done-boundary",
    direction: "upstream",
    hidden_ticket_count: 1,
    next_ticket_ids: ["old-done"],
  }]);
  const all = run(repo, "ticket", "graph", undefined, ["--scope", "all"]).envelope.data;
  assert.deepEqual(all.tickets.map((item) => item.ticket.ticket_id), [
    "current-work", "done-boundary", "old-done", "unrelated-done",
  ]);
});

test("archive state table stays orthogonal to Outcome status, revert, and reopen provenance", () => {
  const delivered = {
    kind: "pull_request",
    ref: deliveryRef,
    state: "delivered",
    delivered_at: at,
    delivered_commit: deliveredCommit,
  };
  const cases = [
    ["successful", undefined, false],
    ["successful", [{ kind: "pull_request", ref: deliveryRef, state: "proposed" }], false],
    ["successful", [{ kind: "pull_request", ref: deliveryRef, state: "abandoned" }], false],
    ["partial", [delivered], false],
    ["failed", [delivered], false],
    ["deviated", [delivered], false],
    ["successful", [delivered], true],
    ["successful", [{ ...delivered, reverted_by: `commit:${"b".repeat(40)}` }], true],
    ["successful", [{
      kind: "cherry_pick",
      ref: `commit:${"c".repeat(40)}`,
      state: "delivered",
      delivered_at: at,
      delivered_commit: "c".repeat(40),
    }], true],
  ];
  cases.forEach(([status, deliveries, expected], index) => {
    const id = `case-${index}`;
    const repository = {
      outcomes: { documents: new Map([[id, { document: { status } }]]) },
    };
    assert.equal(ticketArchived(repository, { ticket_id: id, deliveries }), expected);
  });
  const reopened = ticket("reopened-fix");
  reopened.provenance_refs = ["reopens:old-history"];
  assert.deepEqual(reopened.provenance_refs, ["reopens:old-history"]);
});

test("Ticket graph validates dependencies and successful closeout unlocks only direct dependents", () => {
  const repo = tempRepo("ticket-vertical");
  assert.equal(run(repo, "project", "init").status, 0);
  const applied = run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [ticket("base"), ticket("dependent", ["base"]), ticket("downstream", ["dependent"])],
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
    kind: "ticket_outcome", independence: { source: "subagent", note: "test fixture" },
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
    kind: "ticket_outcome", independence: { source: "subagent", note: "test fixture" },
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

test("new dependencies on DONE Tickets return deterministic nonblocking planning advice", () => {
  const repo = tempRepo("ticket-completed-dependency-advice");
  assert.equal(run(repo, "project", "init").status, 0);
  assert.equal(run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [ticket("completed-baseline"), ticket("active-prerequisite")],
  }).status, 0);
  closeSuccessfully(repo, "completed-baseline");

  const contextOnly = ticket("context-only-consumer");
  contextOnly.context_refs = [{
    ref: ".vibehub/outcomes/completed-baseline.yaml",
    purpose: "Completed implementation baseline, not an execution unlock.",
  }];
  const contextApply = run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [contextOnly] });
  assert.equal(contextApply.status, 0, contextApply.stdout);
  assert.deepEqual(contextApply.envelope.data.advice, []);
  assert.deepEqual(run(repo, "ticket", "graph").envelope.data.stubs, []);

  const candidate = ticket("historical-causal-consumer", ["completed-baseline"]);
  candidate.relations[0].rationale = "Consumes the exact completed migration artifact.";
  const advised = run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [candidate] });
  assert.equal(advised.status, 0, advised.stdout);
  assert.deepEqual(advised.envelope.data.advice, [{
    code: "completed-dependency-review",
    level: "advisory",
    blocking: false,
    relation_path: "tickets[0].relations[0]",
    ticket_id: "historical-causal-consumer",
    target_ticket_id: "completed-baseline",
    rationale: "Consumes the exact completed migration artifact.",
    rationale_present: true,
    message: "Require an explicit causal rationale and review whether the completed target is still an exact input. Keep a justified historical dependency; otherwise replace the edge with an exact Ticket, Outcome, Evidence, Context, or source context_ref.",
    suggested_context_refs: [
      ".vibehub/tickets/completed-baseline.yaml",
      ".vibehub/outcomes/completed-baseline.yaml",
    ],
  }]);
  assert.equal(
    run(repo, "ticket", "graph", undefined, ["--scope", "all"]).envelope.data.relations
      .some((relation) => relation.prerequisite_ticket_id === "completed-baseline"
        && relation.dependent_ticket_id === "historical-causal-consumer"),
    true,
  );

  const repeated = run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [candidate] });
  assert.equal(repeated.status, 0, repeated.stdout);
  assert.deepEqual(repeated.envelope.data.advice, []);

  const missingRationale = ticket("missing-rationale-consumer", ["completed-baseline"]);
  delete missingRationale.relations[0].rationale;
  const missingRationaleApply = run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [missingRationale] });
  assert.equal(missingRationaleApply.status, 0, missingRationaleApply.stdout);
  assert.equal(missingRationaleApply.envelope.data.advice[0].blocking, false);
  assert.equal(missingRationaleApply.envelope.data.advice[0].rationale, null);
  assert.equal(missingRationaleApply.envelope.data.advice[0].rationale_present, false);

  const activeConsumer = ticket("active-consumer", ["active-prerequisite"]);
  const activeApply = run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [activeConsumer] });
  assert.equal(activeApply.status, 0, activeApply.stdout);
  assert.deepEqual(activeApply.envelope.data.advice, []);
  assert.equal(
    run(repo, "ticket", "get", activeConsumer).envelope.data.status,
    "BLOCKED",
  );

  const forkLeft = ticket("fork-left", ["completed-baseline"]);
  forkLeft.relations[0].rationale = "Forks from the accepted baseline.";
  const forkRight = ticket("fork-right", ["completed-baseline"]);
  forkRight.relations[0].rationale = "Forks from the accepted baseline.";
  const releaseConsumer = ticket("release-consumer", ["completed-baseline"]);
  releaseConsumer.relations[0].rationale = "Packages the exact accepted release input.";
  const migrationConsumer = ticket("migration-consumer", ["completed-baseline"]);
  migrationConsumer.relations[0].rationale = "Migrates the exact accepted prior format.";
  const joinConsumer = ticket("join-consumer", ["completed-baseline", "active-prerequisite"]);
  joinConsumer.relations[0].rationale = "Joins the accepted baseline with pending active work.";
  joinConsumer.relations[1].rationale = "Joins pending active work with the accepted baseline.";
  const topologyApply = run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [releaseConsumer, forkRight, joinConsumer, migrationConsumer, forkLeft],
  });
  assert.equal(topologyApply.status, 0, topologyApply.stdout);
  assert.deepEqual(
    topologyApply.envelope.data.advice.map((item) => [item.ticket_id, item.target_ticket_id]),
    [
      ["fork-left", "completed-baseline"],
      ["fork-right", "completed-baseline"],
      ["join-consumer", "completed-baseline"],
      ["migration-consumer", "completed-baseline"],
      ["release-consumer", "completed-baseline"],
    ],
  );
  const allRelations = run(repo, "ticket", "graph", undefined, ["--scope", "all"])
    .envelope.data.relations;
  for (const dependent of [
    "fork-left",
    "fork-right",
    "historical-causal-consumer",
    "join-consumer",
    "migration-consumer",
    "release-consumer",
  ]) {
    assert.equal(
      allRelations.some((relation) => relation.prerequisite_ticket_id === "completed-baseline"
        && relation.dependent_ticket_id === dependent),
      true,
      `completed causal edge was lost for ${dependent}`,
    );
  }
  assert.equal(
    allRelations.some((relation) => relation.prerequisite_ticket_id === "active-prerequisite"
      && relation.dependent_ticket_id === "join-consumer"),
    true,
  );
});

test("Ticket validation rejects missing endpoints and dependency cycles", () => {
  const missingRepo = tempRepo("ticket-missing");
  assert.equal(run(missingRepo, "project", "init").status, 0);
  const missing = run(missingRepo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [ticket("a", ["missing"])] });
  assert.notEqual(missing.status, 0);
  assert.match(JSON.stringify(missing.envelope.error.details), /dangling Ticket dependency/);

  const cycleRepo = tempRepo("ticket-cycle");
  assert.equal(run(cycleRepo, "project", "init").status, 0);
  const cycle = run(cycleRepo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [ticket("a", ["b"]), ticket("b", ["a"])],
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
  const rejected = run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [invalid] });
  assert.notEqual(rejected.status, 0);
  assert.match(JSON.stringify(rejected.envelope.error.details), /authority/u);

  assert.equal(run(repo, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [
      ticket("agent-default"),
      human,
      ticket("after-human", ["human-boundary"]),
    ],
  }).status, 0);
  let frontier = run(repo, "ticket", "frontier");
  assert.deepEqual(
    frontier.envelope.data.ready.map((item) => item.ticket.ticket_id),
    ["agent-default"],
  );
  assert.deepEqual(
    frontier.envelope.data.needs_human.map((item) => item.ticket.ticket_id),
    ["human-boundary"],
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
    kind: "ticket_outcome", independence: { source: "subagent", note: "test fixture" },
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
  frontier = run(repo, "ticket", "frontier");
  assert.deepEqual(
    frontier.envelope.data.ready_to_closeout.map((item) => item.ticket.ticket_id),
    ["human-boundary"],
  );
  assert.equal(run(repo, "ticket", "closeout", {
    schema_version: 1,
    kind: "ticket_outcome", independence: { source: "subagent", note: "test fixture" },
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
