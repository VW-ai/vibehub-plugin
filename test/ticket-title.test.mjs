import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run, tempRepo } from "./helpers.mjs";
import { computeProjection } from "../scripts/sync-github-issues.mjs";

function ok(result) {
  assert.equal(result.status, 0, result.stdout);
  return result.envelope.data;
}

function recorded(repo, id) {
  return JSON.parse(readFileSync(join(repo, ".vibehub", "tickets", `${id}.yaml`), "utf8"));
}

test("put sets, keeps, and changes an optional title without touching the contract identity", () => {
  const repo = tempRepo("ticket-title");
  ok(run(repo, "project", "init"));
  ok(run(repo, "ticket", "put", {
    ticket_id: "reset", title: "Password reset", outcome: "Users can reset a forgotten password.",
    acceptance: [{ acceptance_id: "email", criterion: "A reset email arrives." }],
  }));
  const created = recorded(repo, "reset");
  assert.equal(created.schema_version, 5);
  assert.equal(created.title, "Password reset");

  ok(run(repo, "ticket", "put", { ticket_id: "reset", context: "Start from the login page." }));
  assert.equal(recorded(repo, "reset").title, "Password reset");

  ok(run(repo, "ticket", "put", { ticket_id: "reset", title: "Reset a forgotten password" }));
  const renamed = recorded(repo, "reset");
  assert.equal(renamed.title, "Reset a forgotten password");
  assert.deepEqual(renamed.contract_revisions, created.contract_revisions);
  assert.equal(renamed.active_contract_revision, created.active_contract_revision);

  ok(run(repo, "ticket", "put", { ticket_id: "untitled", outcome: "Titles stay optional." }));
  assert.equal("title" in recorded(repo, "untitled"), false);
  assert.equal(ok(run(repo, "ticket", "get", { ticket_id: "reset" })).ticket.title, "Reset a forgotten password");
});

test("a title is one trimmed line of at most 80 characters", () => {
  const repo = tempRepo("ticket-title-invalid");
  ok(run(repo, "project", "init"));
  for (const title of ["", " padded", "trailing ", "two\nlines", "x".repeat(81), 7]) {
    const result = run(repo, "ticket", "put", { ticket_id: "bad", title, outcome: "Rejected." });
    assert.notEqual(result.status, 0, JSON.stringify(title));
    assert.match(JSON.stringify(result.envelope.error.details), /title/u);
  }
  ok(run(repo, "ticket", "put", { ticket_id: "good", title: "x".repeat(80), outcome: "Accepted." }));
});

test("format 6 projects migrate mechanically to format 7 and then accept titles", () => {
  const repo = tempRepo("ticket-title-migration");
  ok(run(repo, "project", "init"));
  ok(run(repo, "ticket", "put", { ticket_id: "legacy", outcome: "Written before titles." }));
  const path = join(repo, ".vibehub", "tickets", "legacy.yaml");
  const old = { ...recorded(repo, "legacy"), schema_version: 4 };
  writeFileSync(path, `${JSON.stringify(old, null, 2)}\n`);
  const versionPath = join(repo, ".vibehub", "version.yaml");
  writeFileSync(versionPath, `${JSON.stringify({ schema_version: 1, kind: "vibehub_project", format_version: 6 })}\n`);

  assert.equal(run(repo, "ticket", "put", { ticket_id: "legacy", title: "Too early" }).envelope.error.code, "format_mismatch");
  assert.equal(ok(run(repo, "ticket", "get", { ticket_id: "legacy" })).ticket.outcome, "Written before titles.");

  const migrated = ok(run(repo, "project", "migrate-mechanical"));
  assert.equal(migrated.status, "migrated");
  assert.deepEqual(migrated.applied_migrations, ["format-6-to-format-7"]);
  assert.deepEqual(migrated.changed_paths, [".vibehub/tickets/legacy.yaml", ".vibehub/version.yaml"]);
  assert.deepEqual(recorded(repo, "legacy"), { ...old, schema_version: 5 });
  assert.deepEqual(ok(run(repo, "project", "migrate-mechanical")).changed_paths, []);

  ok(run(repo, "ticket", "put", { ticket_id: "legacy", title: "Legacy work" }));
  assert.equal(recorded(repo, "legacy").title, "Legacy work");
});

test("GitHub mirrors prefer the title and fall back to the humanized ID", () => {
  const repo = tempRepo("ticket-title-github");
  ok(run(repo, "project", "init"));
  mkdirSync(join(repo, ".vibehub", "rooms"), { recursive: true });
  ok(run(repo, "ticket", "put", { ticket_id: "ticket-titled", title: "Titled work", outcome: "Has a title." }));
  ok(run(repo, "ticket", "put", { ticket_id: "ticket-plain-work", outcome: "Has no title." }));
  const titles = Object.fromEntries(computeProjection(repo, "acme/demo").map((item) => [item.ticket_id, item.title]));
  assert.equal(titles["ticket-titled"], "Titled work");
  assert.equal(titles["ticket-plain-work"], "Plain work");
});
