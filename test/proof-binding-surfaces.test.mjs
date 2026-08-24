// Every projection surface carries the proof-binding explanation from the one
// canonical derivation in vh.mjs: the graph and handoff projections, the
// attention capability, and the Workbench phase presentation that reads the
// host's nextAction slot. None of them recomputes it.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { buildTicketHandoff, buildUiSnapshot } from "../skills/vibehub-core/scripts/vh-ui.mjs";
import { root, run, tempRepo, ticket } from "./helpers.mjs";

const NOW = "2026-08-23T11:00:00.000Z";

function loadWorkbenchModel() {
  const source = readFileSync(join(
    root,
    "skills/vibehub-ticket-review/assets/app-model.js",
  ), "utf8");
  const sandbox = { URL };
  sandbox.globalThis = sandbox;
  runInNewContext(source, sandbox, { filename: "app-model.js" });
  return sandbox.VibeHubWorkbenchModel;
}

function evidence(id, ticketId, acceptanceIds, overrides = {}) {
  return {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: id,
    ticket_id: ticketId,
    acceptance_ids: acceptanceIds,
    summary: `${ticketId} has acceptance-linked proof.`,
    refs: [`test:${id}`],
    recorded_at: NOW,
    ...overrides,
  };
}

function outcome(ticketId, accepted, evidenceIds) {
  return {
    schema_version: 1,
    kind: "ticket_outcome",
    ticket_id: ticketId,
    status: "successful",
    accepted_acceptance_ids: accepted,
    unresolved_acceptance_ids: [],
    evidence_ids: evidenceIds,
    summary: `${ticketId} was independently adjudicated as successful.`,
    closed_at: NOW,
  };
}

function setFormat(repo, formatVersion) {
  writeFileSync(join(repo, ".vibehub", "version.yaml"), `${JSON.stringify({
    format_version: formatVersion,
    kind: "vibehub_project",
    schema_version: 1,
  }, null, 2)}\n`);
}

function rewriteCriterion(repo, ticketId, acceptanceId, criterion) {
  const path = join(repo, ".vibehub", "tickets", `${ticketId}.yaml`);
  const document = JSON.parse(readFileSync(path, "utf8"));
  document.acceptance = document.acceptance.map((item) =>
    item.acceptance_id === acceptanceId ? { ...item, criterion } : item);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
}

// One repository, three proof situations: a currently-bound DONE Ticket, a
// drifted (unresolved) successful Outcome, and a Ticket whose only human
// sign-off went stale.
function surfaceRepo(label) {
  const repo = tempRepo(label);
  assert.equal(run(repo, "project", "init").status, 0);
  const human = {
    ...ticket("stale-human-work"),
    acceptance: [{ acceptance_id: "owner-approves", criterion: "The owner approves this.", authority: "human" }],
  };
  assert.equal(run(repo, "ticket", "apply", {
    tickets: [ticket("current-work"), ticket("drifted-work"), ticket("waiting-work", ["drifted-work"]), human],
  }).status, 0);
  for (const id of ["current-work", "drifted-work"]) {
    assert.equal(run(repo, "ticket", "evidence", evidence(`${id}-proof`, id, ["works"])).status, 0);
    assert.equal(run(repo, "ticket", "closeout", outcome(id, ["works"], [`${id}-proof`])).status, 0);
  }
  assert.equal(run(repo, "ticket", "evidence", evidence("owner-signoff", "stale-human-work", ["owner-approves"], { origin: "human" })).status, 0);
  rewriteCriterion(repo, "drifted-work", "works", "drifted-work behavior is observed under a revised contract.");
  rewriteCriterion(repo, "stale-human-work", "owner-approves", "The owner approves the revised behavior.");
  setFormat(repo, 3);
  return repo;
}

test("graph, handoff, and attention surfaces carry the canonical proof explanation verbatim", () => {
  const repo = surfaceRepo("surfaces-carry-proof");
  const snapshot = buildUiSnapshot(repo, { scope: "all" });
  const row = (id) => snapshot.state.graph.tickets.find((item) => item.ticketId === id);

  const current = row("current-work");
  assert.equal(current.capabilities.operational.summary.label, "DONE");
  assert.deepEqual(
    [current.capabilities.nextAction.summary.action, current.capabilities.nextAction.summary.proof.outcome.state],
    ["DONE", "current"],
  );
  assert.equal(current.capabilities.nextAction.summary.proof.outcome.binding, "native");

  const drifted = row("drifted-work");
  assert.equal(drifted.capabilities.operational.summary.label, "DEVIATED");
  assert.match(drifted.capabilities.operational.summary.detail, /unresolved against the current acceptance contract/u);
  const driftedAction = drifted.capabilities.nextAction.summary;
  assert.deepEqual(
    [driftedAction.action, driftedAction.reason, driftedAction.acceptanceIds],
    ["REPLAN", "unresolved_legacy_outcome", ["works"]],
  );
  assert.deepEqual(
    [driftedAction.proof.outcome.state, driftedAction.proof.outcome.reason],
    ["unresolved", "contract-drifted-since-addition"],
  );
  assert.equal(drifted.archived, false);

  const waiting = row("waiting-work");
  assert.deepEqual(
    [waiting.capabilities.nextAction.summary.action, waiting.capabilities.nextAction.summary.blockingTicketIds],
    ["WAIT", ["drifted-work"]],
  );

  // Stale human sign-off returns the boundary to pending; nothing claims
  // RECORDED from a superseded criterion revision.
  const staleHuman = row("stale-human-work");
  assert.equal(staleHuman.capabilities.attention.summary.label, "PENDING");
  assert.deepEqual(staleHuman.capabilities.attention.summary.pendingAcceptanceIds, ["owner-approves"]);
  assert.deepEqual(
    [staleHuman.capabilities.nextAction.summary.action, staleHuman.capabilities.nextAction.summary.reason],
    ["NEEDS_HUMAN", "missing_human_evidence"],
  );
  assert.deepEqual(staleHuman.capabilities.nextAction.summary.proof.stale_acceptance_ids, ["owner-approves"]);

  // The handoff carries the same explanation object, and the agent payload
  // hands it over verbatim.
  const handoff = buildTicketHandoff(repo, "drifted-work");
  assert.deepEqual(handoff.nextAction, driftedAction);
  assert.equal(handoff.nextAction.proof.mode, "binding");
  assert.deepEqual(
    buildTicketHandoff(repo, "stale-human-work").nextAction.proof.stale_acceptance_ids,
    ["owner-approves"],
  );

  // Rollback interpretation: the same tree at format 2 restores DONE and the
  // legacy explanation without touching a document.
  setFormat(repo, 2);
  const rolledBack = buildUiSnapshot(repo, { scope: "all" }).state.graph.tickets.find((item) => item.ticketId === "drifted-work");
  assert.equal(rolledBack.capabilities.operational.summary.label, "DONE");
  assert.equal(rolledBack.capabilities.nextAction.summary.proof.mode, "legacy");
});

test("the Workbench phase labels read the host slot and carry the explanation without recomputing", () => {
  const repo = surfaceRepo("surfaces-workbench-phase");
  const snapshot = buildUiSnapshot(repo, { scope: "all" });
  const model = loadWorkbenchModel();
  const presentation = (id) => model.ticketPhasePresentation(
    snapshot.state.graph.tickets.find((item) => item.ticketId === id),
  );

  const drifted = presentation("drifted-work");
  assert.deepEqual([drifted.label, drifted.substate], ["DRAFT", "DEVIATED"]);
  assert.equal(drifted.nextAction.reason, "unresolved_legacy_outcome");
  assert.deepEqual(
    [drifted.nextAction.proof.outcome.state, drifted.nextAction.proof.outcome.reason],
    ["unresolved", "contract-drifted-since-addition"],
  );
  assert.match(drifted.operational.detail, /unresolved against the current acceptance contract/u);

  const current = presentation("current-work");
  assert.equal(current.label, "DONE");
  assert.equal(current.nextAction.proof.outcome.state, "current");

  const staleHuman = presentation("stale-human-work");
  assert.deepEqual([staleHuman.label, staleHuman.substate], ["READY", "NEEDS_YOU"]);
  assert.deepEqual(staleHuman.nextAction.proof.stale_acceptance_ids, ["owner-approves"]);
});
