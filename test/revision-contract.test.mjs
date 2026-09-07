import assert from "node:assert/strict";
import test from "node:test";
import {
  appendTicketContractRevision,
  materializeInitialTicket,
} from "../skills/vibehub-core/scripts/revision-contract.mjs";
import { loadRepository } from "../skills/vibehub-core/scripts/vh.mjs";
import { ticketContextPackage, traceRecords } from "../skills/vibehub-core/scripts/vh-ui.mjs";
import { run, tempRepo, ticket } from "./helpers.mjs";

const NOW = "2026-09-04T20:00:00.000Z";

function evidence(ticketId, evidenceId, acceptanceIds) {
  return {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: evidenceId,
    ticket_id: ticketId,
    acceptance_ids: acceptanceIds,
    summary: `${evidenceId} proves the exact current revision.`,
    refs: [`test:${evidenceId}`],
    recorded_at: NOW,
  };
}

function outcome(ticketId, evidenceId) {
  return {
    schema_version: 1,
    kind: "ticket_outcome",
    independence: { source: "subagent", note: "fresh test adjudicator" },
    ticket_id: ticketId,
    status: "successful",
    accepted_acceptance_ids: ["works"],
    unresolved_acceptance_ids: [],
    evidence_ids: [evidenceId],
    summary: "The exact current Contract revision passed.",
    closed_at: NOW,
  };
}

test("canonical identity ignores presentation and metadata but semantic mutation appends", () => {
  const initial = materializeInitialTicket({
    ...ticket("identity-boundary"),
    schema_version: 3,
    acceptance: [{ acceptance_id: "works", criterion: "The first contract works." }],
  });
  const presented = appendTicketContractRevision(initial, {
    presentation_changes: [{ acceptance_id: "works", presentation: { label: "Friendly copy" } }],
  });
  assert.equal(presented.acceptance[0].identity, initial.acceptance[0].identity);
  assert.deepEqual(presented.contract_revisions, initial.contract_revisions);

  const revised = appendTicketContractRevision({ ...presented, context: "unrelated metadata" }, {
    acceptance_changes: [{ acceptance_id: "works", criterion: "The stronger contract works." }],
  });
  assert.equal(revised.active_contract_revision, 2);
  assert.deepEqual(revised.acceptance.map(({ acceptance_id, revision, state }) =>
    [acceptance_id, revision, state]), [
    ["works", 1, "retired"],
    ["works", 2, "active"],
  ]);
  assert.notEqual(revised.acceptance[0].identity, revised.acceptance[1].identity);
  assert.notEqual(revised.contract_revisions[0].identity, revised.contract_revisions[1].identity);

  const split = appendTicketContractRevision(revised, {
    retire_acceptance_ids: ["works"],
    acceptance_changes: [
      { acceptance_id: "reads", criterion: "Reads independently.", derived_from: [{ acceptance_id: "works", revision: 2 }] },
      { acceptance_id: "writes", criterion: "Writes independently.", derived_from: [{ acceptance_id: "works", revision: 2 }] },
    ],
  });
  assert.deepEqual(split.acceptance.filter((item) => item.state === "active")
    .map((item) => [item.acceptance_id, item.revision]), [["reads", 1], ["writes", 1]]);
});

test("historical success remains queryable but cannot close a newer active Contract", () => {
  const repo = tempRepo("revision-lifecycle");
  assert.equal(run(repo, "project", "init").status, 0);
  assert.equal(run(repo, "ticket", "apply", {
    validation: { independent: false, note: "test fixture" },
    tickets: [ticket("revision-work")],
  }).status, 0);
  assert.equal(run(repo, "ticket", "evidence", evidence("revision-work", "proof-v1", ["works"])).status, 0);
  assert.equal(run(repo, "ticket", "closeout", outcome("revision-work", "proof-v1")).status, 0);
  assert.equal(run(repo, "ticket", "get", { ticket_id: "revision-work" }).envelope.data.next_action.action, "DONE");

  assert.equal(run(repo, "ticket", "revise", {
    ticket_id: "revision-work",
    validation: { independent: false, note: "test fixture" },
    mutation: {
      acceptance_changes: [{ acceptance_id: "works", criterion: "revision-work behavior is observed under the stronger contract." }],
    },
  }).status, 0);
  const revised = run(repo, "ticket", "get", { ticket_id: "revision-work" }).envelope.data;
  assert.equal(revised.ticket.active_contract_revision, 2);
  assert.equal(revised.next_action.action, "EXECUTE");
  assert.equal(revised.outcome, null);
  assert.equal(revised.outcome_history.length, 1);
  assert.equal(revised.outcome_history[0].status, "successful");

  assert.equal(run(repo, "ticket", "evidence", evidence("revision-work", "proof-v2", ["works"])).status, 0);
  assert.equal(run(repo, "ticket", "closeout", outcome("revision-work", "proof-v2")).status, 0);
  const closed = run(repo, "ticket", "get", { ticket_id: "revision-work" }).envelope.data;
  assert.equal(closed.next_action.action, "DONE");
  assert.deepEqual(closed.outcome_history.map((item) => item.contract_revision.revision), [1, 2]);

  const repository = loadRepository(repo);
  const source = { worktreeRoot: repo, repositoryRoot: repo, branch: "test", resolvedCommit: null };
  const projected = ticketContextPackage(closed.ticket, [], repository, source);
  assert.equal(projected.activeContractRevision.revision, 2);
  assert.deepEqual(projected.acceptance.map((item) => [item.acceptanceId, item.revision, item.state]), [
    ["works", 1, "retired"],
    ["works", 2, "active"],
  ]);
  assert.deepEqual(projected.outcomeHistory.map((item) => item.contract_revision.revision), [1, 2]);
  assert.deepEqual(traceRecords(repository, source, "revision-work")
    .filter((item) => item.kind === "outcome")
    .map((item) => [item.contractRevision.revision, item.bindingOrigin]), [[1, "native"], [2, "native"]]);
});

test("native closeout replaces grouped Evidence after one logical Acceptance advances", () => {
  const repo = tempRepo("revision-grouped-evidence");
  assert.equal(run(repo, "project", "init").status, 0);
  const candidate = ticket("grouped-proof");
  candidate.acceptance.push({
    acceptance_id: "other",
    criterion: "The independent companion responsibility works.",
  });
  assert.equal(run(repo, "ticket", "apply", {
    validation: { independent: false, note: "test fixture" },
    tickets: [candidate],
  }).status, 0);
  assert.equal(run(repo, "ticket", "evidence", evidence(
    "grouped-proof", "grouped-v1", ["works", "other"],
  )).status, 0);
  assert.equal(run(repo, "ticket", "revise", {
    ticket_id: "grouped-proof",
    validation: { independent: false, note: "test fixture" },
    mutation: {
      acceptance_changes: [{
        acceptance_id: "works",
        criterion: "grouped-proof behavior is observed under the stronger contract.",
      }],
    },
  }).status, 0);
  assert.equal(run(repo, "ticket", "evidence", evidence(
    "grouped-proof", "works-v2", ["works"],
  )).status, 0);
  const closeout = (evidenceIds) => run(repo, "ticket", "closeout", {
    schema_version: 1,
    kind: "ticket_outcome",
    independence: { source: "subagent", note: "fresh test adjudicator" },
    ticket_id: "grouped-proof",
    status: "successful",
    accepted_acceptance_ids: ["works", "other"],
    unresolved_acceptance_ids: [],
    evidence_ids: evidenceIds,
    summary: "The exact current Contract revision passed.",
    closed_at: NOW,
  });
  const mixed = closeout(["grouped-v1", "works-v2"]);
  assert.equal(mixed.status, 1, mixed.stdout);
  assert.match(JSON.stringify(mixed.envelope.error.details), /does not bind accepted revision: works/u);

  assert.equal(run(repo, "ticket", "evidence", evidence(
    "grouped-proof", "grouped-current", ["works", "other"],
  )).status, 0);
  assert.equal(closeout(["grouped-current"]).status, 0);
  assert.equal(run(repo, "ticket", "get", { ticket_id: "grouped-proof" })
    .envelope.data.next_action.action, "DONE");
});
