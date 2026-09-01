import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildUiSnapshot } from "../skills/vibehub-core/scripts/vh-ui.mjs";
import { run, tempRepo, ticket } from "./helpers.mjs";

const NOW = "2026-08-20T19:30:00.000Z";

function acceptance(count, { human = [] } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    acceptance_id: `criterion-${index + 1}`,
    criterion: `Criterion ${index + 1} is reproducibly satisfied.`,
    ...(human.includes(index + 1) ? { authority: "human" } : {}),
  }));
}

function withAcceptance(id, count, options = {}) {
  return { ...ticket(id), acceptance: acceptance(count, options) };
}

function evidence(id, ticketId, acceptanceIds, origin = "agent") {
  return {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: id,
    ticket_id: ticketId,
    acceptance_ids: acceptanceIds,
    summary: `${ticketId} has acceptance-linked proof.`,
    refs: [`test:${id}`],
    origin,
    recorded_at: NOW,
  };
}

function outcome(ticketId, status, accepted, unresolved, evidenceIds = []) {
  return {
    schema_version: 1,
    kind: "ticket_outcome",
    ticket_id: ticketId,
    status,
    accepted_acceptance_ids: accepted,
    unresolved_acceptance_ids: unresolved,
    evidence_ids: evidenceIds,
    summary: `${ticketId} was independently adjudicated as ${status}.`,
    closed_at: NOW,
  };
}

function itemById(items, id) {
  return items.find((item) => item.ticket.ticket_id === id);
}

test("next action covers execution, authority, adjudication, dependencies, maturity, and Outcomes", () => {
  const repo = tempRepo("next-action-matrix");
  assert.equal(run(repo, "project", "init").status, 0);

  const draft = ticket("draft-contract");
  draft.maturity = "draft";
  const waiting = ticket("waiting-work", ["unfinished-prerequisite"]);
  const human = withAcceptance("human-authority", 1, { human: [1] });
  const mixed = withAcceptance("mixed-authority", 2, { human: [2] });
  const tickets = [
    ticket("ordinary-ready"),
    ticket("unfinished-prerequisite"),
    waiting,
    draft,
    human,
    mixed,
    withAcceptance("v080-publication", 4),
    withAcceptance("dogfood-repair", 6),
    ticket("successful-work"),
    ticket("partial-work"),
    ticket("failed-work"),
    ticket("deviated-work"),
  ];
  assert.equal(run(repo, "ticket", "apply", { tickets }).status, 0);

  for (const [id, count] of [["v080-publication", 4], ["dogfood-repair", 6]]) {
    const ids = acceptance(count).map((criterion) => criterion.acceptance_id);
    assert.equal(run(repo, "ticket", "evidence", evidence(`${id}-proof`, id, ids)).status, 0);
  }
  assert.equal(run(repo, "ticket", "evidence", evidence(
    "agent-cannot-satisfy-human",
    "human-authority",
    ["criterion-1"],
  )).status, 0);
  assert.equal(run(repo, "ticket", "evidence", evidence(
    "successful-proof",
    "successful-work",
    ["works"],
  )).status, 0);
  assert.equal(run(repo, "ticket", "closeout", outcome(
    "successful-work",
    "successful",
    ["works"],
    [],
    ["successful-proof"],
  )).status, 0);
  for (const [id, status] of [
    ["partial-work", "partial"],
    ["failed-work", "failed"],
    ["deviated-work", "deviated"],
  ]) {
    assert.equal(run(repo, "ticket", "closeout", outcome(
      id,
      status,
      [],
      ["works"],
    )).status, 0);
  }

  const graph = run(repo, "ticket", "graph", undefined, ["--scope", "all"])
    .envelope.data.tickets;
  const actions = Object.fromEntries(graph.map((item) => [
    item.ticket.ticket_id,
    [item.next_action.action, item.next_action.reason],
  ]));
  assert.deepEqual(actions["ordinary-ready"], ["EXECUTE", "acceptance_evidence_incomplete"]);
  assert.deepEqual(actions["waiting-work"], ["WAIT", "unresolved_direct_dependencies"]);
  assert.deepEqual(actions["draft-contract"], ["REFINE", "draft_contract"]);
  assert.deepEqual(actions["human-authority"], ["NEEDS_HUMAN", "missing_human_evidence"]);
  assert.deepEqual(actions["mixed-authority"], ["EXECUTE", "acceptance_evidence_incomplete"]);
  assert.deepEqual(actions["v080-publication"], ["CLOSE_OUT", "authority_satisfying_evidence_complete"]);
  assert.deepEqual(actions["dogfood-repair"], ["CLOSE_OUT", "authority_satisfying_evidence_complete"]);
  assert.deepEqual(actions["successful-work"], ["DONE", "successful_outcome"]);
  for (const id of ["partial-work", "failed-work", "deviated-work"]) {
    assert.deepEqual(actions[id], ["REPLAN", "non_successful_outcome"]);
  }

  const frontier = run(repo, "ticket", "frontier").envelope.data;
  assert.deepEqual(
    frontier.ready.map((item) => item.ticket.ticket_id),
    frontier.ready_to_execute.map((item) => item.ticket.ticket_id),
  );
  assert.deepEqual(
    frontier.ready_to_closeout.map((item) => item.ticket.ticket_id),
    ["dogfood-repair", "v080-publication"],
  );
  assert.deepEqual(
    frontier.needs_human.map((item) => item.ticket.ticket_id),
    ["human-authority"],
  );
  assert.deepEqual(
    frontier.needs_replan.map((item) => item.ticket.ticket_id),
    ["deviated-work", "failed-work", "partial-work"],
  );
  assert.deepEqual(frontier.needs_refinement.map((item) => item.ticket.ticket_id), ["draft-contract"]);
  assert.deepEqual(frontier.waiting.map((item) => item.ticket.ticket_id), ["waiting-work"]);
  assert.equal(
    frontier.ready_to_execute.some((item) => item.ticket.ticket_id === "dogfood-repair"),
    false,
  );

  const node = buildUiSnapshot(repo).state.graph.tickets.find(
    (candidate) => candidate.ticketId === "dogfood-repair",
  );
  assert.equal(node.capabilities.operational.summary.label, "READY");
  assert.equal(node.capabilities.nextAction.summary.action, "CLOSE_OUT");
  assert.equal(node.capabilities.attention.summary.label, "NONE");
  assert.equal(existsSync(join(repo, ".vibehub", "outcomes", "dogfood-repair.yaml")), false);
});

test("human precedence remains authority-aware and full Evidence never unlocks dependents", () => {
  const repo = tempRepo("next-action-boundaries");
  assert.equal(run(repo, "project", "init").status, 0);
  const mixed = withAcceptance("mixed", 2, { human: [2] });
  const prerequisite = withAcceptance("fully-evidenced", 2);
  assert.equal(run(repo, "ticket", "apply", {
    tickets: [mixed, prerequisite, ticket("dependent", ["fully-evidenced"])],
  }).status, 0);

  assert.equal(run(repo, "ticket", "evidence", evidence(
    "mixed-human",
    "mixed",
    ["criterion-2"],
    "human",
  )).status, 0);
  assert.equal(run(repo, "ticket", "evidence", evidence(
    "fully-evidenced-proof",
    "fully-evidenced",
    ["criterion-1", "criterion-2"],
  )).status, 0);

  const mixedGet = run(repo, "ticket", "get", { ticket_id: "mixed" }).envelope.data;
  assert.equal(mixedGet.next_action.action, "EXECUTE");
  assert.deepEqual(mixedGet.next_action.acceptance_ids, ["criterion-1"]);
  let frontier = run(repo, "ticket", "frontier").envelope.data;
  assert.deepEqual(frontier.ready_to_closeout.map((item) => item.ticket.ticket_id), ["fully-evidenced"]);
  assert.deepEqual(frontier.waiting.map((item) => item.ticket.ticket_id), ["dependent"]);
  assert.equal(existsSync(join(repo, ".vibehub", "outcomes", "fully-evidenced.yaml")), false);

  assert.equal(run(repo, "ticket", "closeout", outcome(
    "fully-evidenced",
    "successful",
    ["criterion-1", "criterion-2"],
    [],
    ["fully-evidenced-proof"],
  )).status, 0);
  frontier = run(repo, "ticket", "frontier").envelope.data;
  assert.equal(
    run(repo, "ticket", "get", { ticket_id: "fully-evidenced" })
      .envelope.data.next_action.action,
    "DONE",
  );
  assert.equal(itemById(frontier.ready_to_execute, "dependent").next_action.action, "EXECUTE");
});

test("human routing waits until the human criterion is the remaining blocker", () => {
  const repo = tempRepo("next-action-human-ordering");
  assert.equal(run(repo, "project", "init").status, 0);

  const delivery = withAcceptance("terminal-signoff", 3, { human: [3] });
  const humanOnly = withAcceptance("human-only", 1, { human: [1] });
  assert.equal(run(repo, "ticket", "apply", { tickets: [delivery, humanOnly] }).status, 0);

  // Mixed authority, before any Evidence: agent work remains, so the Ticket is
  // executable and names only the agent-authority criteria.
  let projection = run(repo, "ticket", "get", { ticket_id: "terminal-signoff" })
    .envelope.data.next_action;
  assert.equal(projection.action, "EXECUTE");
  assert.equal(projection.reason, "acceptance_evidence_incomplete");
  assert.deepEqual(projection.acceptance_ids, ["criterion-1", "criterion-2"]);

  // A human-authority-only Ticket has no agent work to do, so it routes to the
  // human immediately.
  projection = run(repo, "ticket", "get", { ticket_id: "human-only" })
    .envelope.data.next_action;
  assert.equal(projection.action, "NEEDS_HUMAN");
  assert.equal(projection.reason, "missing_human_evidence");
  assert.deepEqual(projection.acceptance_ids, ["criterion-1"]);

  let frontier = run(repo, "ticket", "frontier").envelope.data;
  assert.deepEqual(frontier.ready_to_execute.map((item) => item.ticket.ticket_id), ["terminal-signoff"]);
  assert.deepEqual(frontier.needs_human.map((item) => item.ticket.ticket_id), ["human-only"]);

  // Partial agent Evidence still leaves agent work: still EXECUTE.
  assert.equal(run(repo, "ticket", "evidence", evidence(
    "signoff-agent-partial",
    "terminal-signoff",
    ["criterion-1"],
  )).status, 0);
  projection = run(repo, "ticket", "get", { ticket_id: "terminal-signoff" })
    .envelope.data.next_action;
  assert.equal(projection.action, "EXECUTE");
  assert.deepEqual(projection.acceptance_ids, ["criterion-2"]);

  // Every agent-authority criterion evidenced: the human criterion is now the
  // remaining blocker, and Agent-origin Evidence cannot satisfy it.
  assert.equal(run(repo, "ticket", "evidence", evidence(
    "signoff-agent-rest",
    "terminal-signoff",
    ["criterion-2", "criterion-3"],
  )).status, 0);
  projection = run(repo, "ticket", "get", { ticket_id: "terminal-signoff" })
    .envelope.data.next_action;
  assert.equal(projection.action, "NEEDS_HUMAN");
  assert.equal(projection.reason, "missing_human_evidence");
  assert.deepEqual(projection.acceptance_ids, ["criterion-3"]);

  frontier = run(repo, "ticket", "frontier").envelope.data;
  assert.deepEqual(
    frontier.needs_human.map((item) => item.ticket.ticket_id),
    ["human-only", "terminal-signoff"],
  );
  assert.deepEqual(frontier.ready_to_execute.map((item) => item.ticket.ticket_id), []);

  // Human-origin Evidence closes the last criterion and adjudication is next.
  assert.equal(run(repo, "ticket", "evidence", evidence(
    "signoff-human",
    "terminal-signoff",
    ["criterion-3"],
    "human",
  )).status, 0);
  projection = run(repo, "ticket", "get", { ticket_id: "terminal-signoff" })
    .envelope.data.next_action;
  assert.equal(projection.action, "CLOSE_OUT");
  assert.equal(projection.reason, "authority_satisfying_evidence_complete");
});

test("rows one through four still outrank both EXECUTE and NEEDS_HUMAN", () => {
  const repo = tempRepo("next-action-higher-precedence");
  assert.equal(run(repo, "project", "init").status, 0);

  // Each Ticket carries the same mixed-authority shape with zero Evidence,
  // which alone would project EXECUTE, so any other action proves precedence.
  const mixed = (id, relations = []) => ({
    ...withAcceptance(id, 2, { human: [2] }),
    relations: relations.map((target) => ({
      type: "depends_on",
      target_ticket_id: target,
      rationale: "The prerequisite must close first.",
    })),
  });
  const draft = { ...mixed("mixed-draft"), maturity: "draft" };
  assert.equal(run(repo, "ticket", "apply", {
    tickets: [
      mixed("mixed-successful"),
      mixed("mixed-partial"),
      mixed("mixed-prerequisite"),
      mixed("mixed-waiting", ["mixed-prerequisite"]),
      draft,
    ],
  }).status, 0);

  assert.equal(run(repo, "ticket", "evidence", evidence(
    "successful-agent",
    "mixed-successful",
    ["criterion-1"],
  )).status, 0);
  assert.equal(run(repo, "ticket", "evidence", evidence(
    "successful-human",
    "mixed-successful",
    ["criterion-2"],
    "human",
  )).status, 0);
  assert.equal(run(repo, "ticket", "closeout", outcome(
    "mixed-successful",
    "successful",
    ["criterion-1", "criterion-2"],
    [],
    ["successful-agent", "successful-human"],
  )).status, 0);
  assert.equal(run(repo, "ticket", "closeout", outcome(
    "mixed-partial",
    "partial",
    [],
    ["criterion-1", "criterion-2"],
  )).status, 0);

  const actionFor = (id) => {
    const projection = run(repo, "ticket", "get", { ticket_id: id }).envelope.data.next_action;
    return [projection.action, projection.reason];
  };
  assert.deepEqual(actionFor("mixed-successful"), ["DONE", "successful_outcome"]);
  assert.deepEqual(actionFor("mixed-partial"), ["REPLAN", "non_successful_outcome"]);
  assert.deepEqual(actionFor("mixed-waiting"), ["WAIT", "unresolved_direct_dependencies"]);
  assert.deepEqual(actionFor("mixed-draft"), ["REFINE", "draft_contract"]);
  assert.deepEqual(actionFor("mixed-prerequisite"), ["EXECUTE", "acceptance_evidence_incomplete"]);
});
