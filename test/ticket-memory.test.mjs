import test from "node:test";
import assert from "node:assert/strict";
import { run, tempRepo } from "./helpers.mjs";

const at = "2026-10-01T12:00:00.000Z";

function ok(result) {
  assert.equal(result.status, 0, result.stdout);
  return result.envelope.data;
}

test("a task can be recorded, completed, reopened, and related without proof", () => {
  const repo = tempRepo("ticket-memory");
  ok(run(repo, "project", "init"));
  ok(run(repo, "ticket", "put", { ticket_id: "base", outcome: "Ship password reset" }));
  ok(run(repo, "ticket", "put", {
    ticket_id: "follow-up", outcome: "Document password reset",
    relations: [{ type: "depends_on", target_ticket_id: "base" }],
  }));
  assert.equal(ok(run(repo, "ticket", "get", { ticket_id: "base" })).status, "OPEN");
  assert.deepEqual(ok(run(repo, "ticket", "get", { ticket_id: "follow-up" })).blocking_ticket_ids, ["base"]);
  assert.deepEqual(ok(run(repo, "ticket", "frontier")).blocked.map((item) => item.ticket.ticket_id), ["follow-up"]);

  ok(run(repo, "ticket", "update", {
    ticket_id: "base", update_id: "progress-one", summary: "Reset email is wired.", status: "in_progress", recorded_at: at,
  }));
  assert.equal(ok(run(repo, "ticket", "get", { ticket_id: "base" })).status, "IN_PROGRESS");
  ok(run(repo, "ticket", "update", {
    ticket_id: "base", update_id: "done-one", summary: "Reset works.", status: "done", refs: ["commit:abc"], recorded_at: at,
  }));
  assert.equal(ok(run(repo, "ticket", "get", { ticket_id: "follow-up" })).status, "OPEN");
  assert.deepEqual(ok(run(repo, "ticket", "frontier")).open.map((item) => item.ticket.ticket_id), ["follow-up"]);
  assert.equal(ok(run(repo, "ticket", "update", {
    ticket_id: "base", update_id: "done-one", summary: "Reset works.", status: "done", refs: ["commit:abc"], recorded_at: at,
  })).status, "unchanged");
  const conflicting = run(repo, "ticket", "update", {
    ticket_id: "base", update_id: "done-one", summary: "Different result.", status: "done", recorded_at: at,
  });
  assert.equal(conflicting.envelope.error.code, "invalid_state");

  ok(run(repo, "ticket", "update", {
    ticket_id: "base", update_id: "reopen-one", summary: "Reset email regressed.", status: "open", recorded_at: at,
  }));
  const reopened = ok(run(repo, "ticket", "get", { ticket_id: "base" }));
  assert.equal(reopened.status, "OPEN");
  assert.deepEqual(reopened.ticket.updates.map((item) => item.update_id), ["progress-one", "done-one", "reopen-one"]);
  assert.deepEqual(ok(run(repo, "ticket", "get", { ticket_id: "follow-up" })).blocking_ticket_ids, ["base"]);
});

test("put patches only named definition fields and can restore a prior criterion", () => {
  const repo = tempRepo("ticket-memory-definition");
  ok(run(repo, "project", "init"));
  ok(run(repo, "ticket", "put", {
    ticket_id: "task", outcome: "A task", context: "Original context",
    acceptance: [{ acceptance_id: "behavior", criterion: "A" }],
  }));
  ok(run(repo, "ticket", "put", {
    ticket_id: "task", acceptance: [{ acceptance_id: "behavior", criterion: "B" }],
  }));
  ok(run(repo, "ticket", "put", {
    ticket_id: "task", acceptance: [{ acceptance_id: "behavior", criterion: "A" }],
  }));
  const document = ok(run(repo, "ticket", "get", { ticket_id: "task" })).ticket;
  assert.equal(document.context, "Original context");
  assert.equal(document.active_contract_revision, 3);
  assert.deepEqual(document.acceptance.map((item) => item.criterion), ["A", "B", "A"]);
  assert.equal(document.status, "open");
  const malformed = run(repo, "ticket", "put", {
    ticket_id: "bad", outcome: "Bad", acceptance: [null],
  });
  assert.equal(malformed.envelope.error.code, "invalid_input");
});

test("format 5 migration keeps old proof and derives only matching success as done", async () => {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { ticket } = await import("./helpers.mjs");
  const repo = tempRepo("ticket-memory-migration");
  ok(run(repo, "project", "init"));
  ok(run(repo, "ticket", "apply", { tickets: [ticket("succeeded"), ticket("failed")] }));
  ok(run(repo, "ticket", "evidence", {
    schema_version: 2, kind: "ticket_evidence", evidence_id: "proof", ticket_id: "succeeded",
    acceptance_ids: ["works"], binding_state: "bound", binding_origin: "native",
    acceptance_revisions: [ok(run(repo, "ticket", "get", { ticket_id: "succeeded" })).ticket.contract_revisions[0].acceptance_revisions[0]],
    summary: "Worked.", refs: ["test:worked"], recorded_at: at,
  }));
  const succeeded = ok(run(repo, "ticket", "get", { ticket_id: "succeeded" })).ticket;
  const failed = ok(run(repo, "ticket", "get", { ticket_id: "failed" })).ticket;
  const historical = {
    schema_version: 2, kind: "ticket_outcome", outcome_id: "contract-v1", ticket_id: "succeeded",
    binding_state: "bound", binding_origin: "native",
    contract_revision: { revision: 1, identity: succeeded.contract_revisions[0].identity },
    status: "successful", accepted_acceptance_ids: ["works"], unresolved_acceptance_ids: [],
    evidence_ids: ["proof"], summary: "Worked.", closed_at: at,
  };
  ok(run(repo, "ticket", "closeout", historical));
  ok(run(repo, "ticket", "closeout", {
    ...historical, ticket_id: "failed", contract_revision: { revision: 1, identity: failed.contract_revisions[0].identity },
    status: "failed", accepted_acceptance_ids: [], unresolved_acceptance_ids: ["works"], evidence_ids: [], summary: "Not done.",
  }));
  const proofPath = join(repo, ".vibehub", "outcomes", "succeeded", "contract-v1.yaml");
  const proofBefore = readFileSync(proofPath, "utf8");
  for (const id of ["succeeded", "failed"]) {
    const path = join(repo, ".vibehub", "tickets", `${id}.yaml`);
    const old = JSON.parse(readFileSync(path, "utf8"));
    old.schema_version = 3;
    delete old.status;
    delete old.updates;
    writeFileSync(path, `${JSON.stringify(old, null, 2)}\n`);
  }
  const versionPath = join(repo, ".vibehub", "version.yaml");
  writeFileSync(versionPath, `${JSON.stringify({ schema_version: 1, kind: "vibehub_project", format_version: 5 })}\n`);
  const migrated = ok(run(repo, "project", "migrate-mechanical"));
  assert.deepEqual(migrated.applied_migrations, ["format-5-to-format-6", "format-6-to-format-7"]);
  assert.equal(ok(run(repo, "ticket", "get", { ticket_id: "succeeded" })).status, "DONE");
  assert.equal(ok(run(repo, "ticket", "get", { ticket_id: "failed" })).status, "OPEN");
  assert.equal(readFileSync(proofPath, "utf8"), proofBefore);
  assert.deepEqual(ok(run(repo, "project", "migrate-mechanical")).changed_paths, []);
});
