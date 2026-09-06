import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { run, tempRepo } from "./helpers.mjs";

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function legacyTicket(ticketId, criterion) {
  return {
    schema_version: 2,
    kind: "ticket",
    ticket_id: ticketId,
    maturity: "firm",
    outcome: `${ticketId} works`,
    deliveries: [],
    context: "Migration fixture.",
    acceptance: [{ acceptance_id: "works", criterion }],
    constraints: [],
    context_refs: [],
    relations: [],
    provenance_refs: ["test:proof-revision-migration"],
  };
}

function legacyEvidence(ticketId, evidenceId) {
  return {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: evidenceId,
    ticket_id: ticketId,
    acceptance_ids: ["works"],
    summary: `${ticketId} proof`,
    refs: [`test:${evidenceId}`],
    recorded_at: "2026-09-04T00:00:00.000Z",
  };
}

function writeJson(path, document) {
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
}

test("semantic migration reconstructs drift and reports missing or ambiguous history", () => {
  const repo = tempRepo("proof-revision-semantic");
  assert.equal(run(repo, "project", "init").status, 0);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "VibeHub Test");
  git(repo, "config", "user.email", "vibehub@example.test");
  writeJson(join(repo, ".vibehub", "version.yaml"), { schema_version: 1, kind: "vibehub_project", format_version: 3 });

  const ticketPath = (id) => join(repo, ".vibehub", "tickets", `${id}.yaml`);
  const evidencePath = (id, proof) => join(repo, ".vibehub", "evidence", id, `${proof}.yaml`);
  writeJson(ticketPath("drift-work"), legacyTicket("drift-work", "The original responsibility works."));
  mkdirSync(join(repo, ".vibehub", "evidence", "drift-work"), { recursive: true });
  writeJson(evidencePath("drift-work", "drift-proof"), legacyEvidence("drift-work", "drift-proof"));
  writeJson(join(repo, ".vibehub", "outcomes", "drift-work.yaml"), {
    schema_version: 1,
    kind: "ticket_outcome",
    ticket_id: "drift-work",
    status: "successful",
    accepted_acceptance_ids: ["works"],
    unresolved_acceptance_ids: [],
    evidence_ids: ["drift-proof"],
    summary: "The original contract passed.",
    closed_at: "2026-09-04T00:01:00.000Z",
    independence: { source: "subagent", note: "fixture" },
  });
  git(repo, "add", ".");
  git(repo, "commit", "-m", "add original proof");
  writeJson(ticketPath("drift-work"), legacyTicket("drift-work", "The strengthened responsibility works."));
  git(repo, "add", ticketPath("drift-work"));
  git(repo, "commit", "-m", "strengthen contract");

  writeJson(ticketPath("ambiguous-work"), legacyTicket("ambiguous-work", "Ambiguous work passes."));
  mkdirSync(join(repo, ".vibehub", "evidence", "ambiguous-work"), { recursive: true });
  writeJson(evidencePath("ambiguous-work", "ambiguous-proof"), legacyEvidence("ambiguous-work", "ambiguous-proof"));
  git(repo, "add", ticketPath("ambiguous-work"), evidencePath("ambiguous-work", "ambiguous-proof"));
  git(repo, "commit", "-m", "add ambiguous proof once");
  unlinkSync(evidencePath("ambiguous-work", "ambiguous-proof"));
  git(repo, "add", "-u");
  git(repo, "commit", "-m", "remove ambiguous proof");
  writeJson(evidencePath("ambiguous-work", "ambiguous-proof"), legacyEvidence("ambiguous-work", "ambiguous-proof"));
  git(repo, "add", evidencePath("ambiguous-work", "ambiguous-proof"));
  git(repo, "commit", "-m", "add ambiguous proof twice");

  writeJson(ticketPath("missing-work"), legacyTicket("missing-work", "Missing history work passes."));
  mkdirSync(join(repo, ".vibehub", "evidence", "missing-work"), { recursive: true });
  writeJson(evidencePath("missing-work", "missing-proof"), legacyEvidence("missing-work", "missing-proof"));

  const mechanical = run(repo, "project", "migrate-mechanical");
  assert.equal(mechanical.status, 0, mechanical.stdout);
  const semantic = run(repo, "project", "migrate-proof-revisions");
  assert.equal(semantic.status, 0, semantic.stdout);
  assert.equal(semantic.envelope.data.status, "migrated_with_unresolved");
  assert.deepEqual({
    tickets: semantic.envelope.data.tickets_reconstructed,
    evidence: semantic.envelope.data.evidence_bound,
    outcomes: semantic.envelope.data.outcomes_bound,
    unresolved: semantic.envelope.data.unresolved,
  }, { tickets: 3, evidence: 1, outcomes: 1, unresolved: 2 });

  const drift = run(repo, "ticket", "get", { ticket_id: "drift-work" }).envelope.data;
  assert.deepEqual(drift.ticket.acceptance.map((item) => [item.revision, item.state]), [[1, "retired"], [2, "active"]]);
  assert.deepEqual(drift.ticket.contract_revisions.map((item) => item.revision), [1, 2]);
  assert.equal(drift.outcome, null);
  assert.equal(drift.outcome_history[0].status, "successful");
  assert.equal(drift.next_action.action, "EXECUTE");

  for (const [ticketId, evidenceId, reason] of [["ambiguous-work", "ambiguous-proof", "ambiguous-history"], ["missing-work", "missing-proof", "missing-history"]]) {
    const proof = JSON.parse(readFileSync(evidencePath(ticketId, evidenceId), "utf8"));
    assert.equal(proof.binding_state, "legacy-unresolved");
    assert.equal(proof.unresolved.reason, reason);
    assert.ok(proof.unresolved.attempted_refs.length > 0);
  }
  assert.equal(run(repo, "project", "validate").status, 0);
  assert.deepEqual(run(repo, "project", "migrate-proof-revisions").envelope.data, {
    status: "current",
    changed_paths: [],
    tickets_reconstructed: 0,
    evidence_bound: 0,
    outcomes_bound: 0,
    unresolved: 0,
  });
});

test("semantic migration rejects stale human Evidence for a strengthened Contract and rolls back", () => {
  const repo = tempRepo("proof-revision-stale-human");
  assert.equal(run(repo, "project", "init").status, 0);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "VibeHub Test");
  git(repo, "config", "user.email", "vibehub@example.test");
  writeJson(join(repo, ".vibehub", "version.yaml"), { schema_version: 1, kind: "vibehub_project", format_version: 3 });

  const ticketPath = join(repo, ".vibehub", "tickets", "human-contract.yaml");
  const evidenceDirectory = join(repo, ".vibehub", "evidence", "human-contract");
  const evidencePath = join(evidenceDirectory, "owner-proof.yaml");
  const outcomePath = join(repo, ".vibehub", "outcomes", "human-contract.yaml");
  const original = legacyTicket("human-contract", "The owner approves the original contract.");
  original.acceptance[0].acceptance_id = "approved";
  original.acceptance[0].authority = "human";
  writeJson(ticketPath, original);
  mkdirSync(evidenceDirectory, { recursive: true });
  writeJson(evidencePath, {
    ...legacyEvidence("human-contract", "owner-proof"),
    acceptance_ids: ["approved"],
    origin: "human",
  });
  git(repo, "add", ".");
  git(repo, "commit", "-m", "record original human approval");

  const strengthened = legacyTicket("human-contract", "The owner approves the materially strengthened contract.");
  strengthened.acceptance[0].acceptance_id = "approved";
  strengthened.acceptance[0].authority = "human";
  writeJson(ticketPath, strengthened);
  git(repo, "add", ticketPath);
  git(repo, "commit", "-m", "strengthen human contract without new approval");

  writeJson(outcomePath, {
    schema_version: 1,
    kind: "ticket_outcome",
    ticket_id: "human-contract",
    status: "successful",
    accepted_acceptance_ids: ["approved"],
    unresolved_acceptance_ids: [],
    evidence_ids: ["owner-proof"],
    summary: "The strengthened contract was incorrectly closed with old approval.",
    closed_at: "2026-09-04T00:01:00.000Z",
    independence: { source: "subagent", note: "fixture" },
  });
  git(repo, "add", outcomePath);
  git(repo, "commit", "-m", "record invalid stale-proof closeout");

  assert.equal(run(repo, "project", "migrate-mechanical").status, 0);
  const pendingBytes = new Map([ticketPath, evidencePath, outcomePath]
    .map((path) => [path, readFileSync(path, "utf8")]));
  const semantic = run(repo, "project", "migrate-proof-revisions");
  assert.equal(semantic.status, 1, semantic.stdout);
  assert.equal(semantic.envelope.error.code, "validation_error");
  assert.match(JSON.stringify(semantic.envelope.error.details), /no exact referenced human-origin Evidence: approved/u);
  for (const [path, bytes] of pendingBytes) assert.equal(readFileSync(path, "utf8"), bytes);
  assert.equal(existsSync(join(repo, ".vibehub", "outcomes", "human-contract", "contract-v1.yaml")), false);
  assert.equal(run(repo, "project", "validate").status, 0);
  assert.equal(run(repo, "ticket", "get", { ticket_id: "human-contract" })
    .envelope.data.next_action.reason, "semantic_migration_pending");
});
