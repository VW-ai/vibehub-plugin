import test from "node:test";
import assert from "node:assert/strict";
import { buildUiSnapshot } from "../skills/vibehub-core/scripts/vh-ui.mjs";
import { run, tempRepo, ticket } from "./helpers.mjs";

const at = "2026-08-04T00:00:00.000Z";

function ok(result) {
  assert.equal(result.status, 0, result.stdout);
  return result.envelope.data;
}

function draft(id, dependencies = []) {
  return { ...ticket(id, dependencies), maturity: "draft" };
}

test("maturity remains task metadata and does not prescribe a work stage", () => {
  const repo = tempRepo("draft-schema");
  ok(run(repo, "project", "init"));
  ok(run(repo, "ticket", "apply", {
    tickets: [draft("sketch"), { ...ticket("explicit-firm"), maturity: "firm" }, ticket("legacy-firm")],
  }));
  for (const id of ["sketch", "explicit-firm", "legacy-firm"]) {
    assert.equal(ok(run(repo, "ticket", "get", { ticket_id: id })).status, "OPEN");
  }
  const invalid = run(repo, "ticket", "apply", { tickets: [{ ...ticket("bad"), maturity: "fuzzy" }] });
  assert.equal(invalid.envelope.error.code, "validation_error");
  assert.match(JSON.stringify(invalid.envelope.error.details), /must equal firm or draft when present/u);
});

test("a draft becomes unblocked when its prerequisite is recorded done", () => {
  const repo = tempRepo("draft-chain");
  ok(run(repo, "project", "init"));
  ok(run(repo, "ticket", "apply", {
    tickets: [ticket("blocker"), draft("frontend", ["blocker"]), draft("e2e", ["frontend"])],
  }));
  assert.equal(ok(run(repo, "ticket", "get", { ticket_id: "frontend" })).status, "BLOCKED");
  ok(run(repo, "ticket", "update", {
    ticket_id: "blocker", update_id: "blocker-done", summary: "Decision recorded.", status: "done", recorded_at: at,
  }));
  assert.equal(ok(run(repo, "ticket", "get", { ticket_id: "frontend" })).status, "OPEN");
  assert.equal(ok(run(repo, "ticket", "get", { ticket_id: "e2e" })).status, "BLOCKED");
  assert.deepEqual(ok(run(repo, "ticket", "frontier")).open.map((item) => item.ticket.ticket_id), ["frontend"]);
});

test("the dashboard shows a draft as an open task", () => {
  const repo = tempRepo("draft-projection");
  ok(run(repo, "project", "init"));
  ok(run(repo, "ticket", "apply", { tickets: [draft("sketch")] }));
  const node = buildUiSnapshot(repo).state.graph.tickets.find((item) => item.ticketId === "sketch");
  assert.equal(node.capabilities.operational.summary.label, "OPEN");
});
