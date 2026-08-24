// The deterministic format 2 -> 3 proof-binding migration: reconstruction
// from the first Git addition on the current HEAD ancestry only, unresolved
// markers for missing or drifted history instead of fabricated bindings,
// byte-preservation of every historical document except the registered
// version bump and the one inserted field, a dry-run impact report whose
// counts the apply must reproduce, byte-identical replay, and rollback to the
// format 2 interpretation without deleting a binding.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { firstCurrentAddition, migrateProofBindings } from "../skills/vibehub-migrate/scripts/migrate-proof-bindings.mjs";
import { contractIdentity } from "../skills/vibehub-core/scripts/vh.mjs";
import { root, run } from "./helpers.mjs";

const MIGRATOR = join(root, "skills", "vibehub-migrate", "scripts", "migrate-proof-bindings.mjs");

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function commit(repo, message, timestamp) {
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", message], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp },
  });
  return git(repo, "rev-parse", "HEAD");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function writeDoc(repo, path, document, { sortKeys = true } = {}) {
  const target = join(repo, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, `${JSON.stringify(sortKeys ? stable(document) : document, null, 2)}\n`);
}

function fixtureTicket(id, acceptance) {
  return {
    schema_version: 2,
    kind: "ticket",
    ticket_id: id,
    outcome: `${id} observable outcome`,
    deliveries: [],
    context: `Execute ${id} from its checked-in context.`,
    acceptance,
    constraints: [],
    context_refs: [],
    relations: [],
    provenance_refs: ["test:proof-binding-migration"],
  };
}

function fixtureEvidence(id, ticketId, acceptanceIds, overrides = {}) {
  return {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: id,
    ticket_id: ticketId,
    acceptance_ids: acceptanceIds,
    summary: `${ticketId} proof ${id}.`,
    refs: [`test:${id}`],
    recorded_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function fixtureOutcome(ticketId, accepted, evidenceIds) {
  return {
    schema_version: 1,
    kind: "ticket_outcome",
    ticket_id: ticketId,
    status: "successful",
    accepted_acceptance_ids: accepted,
    unresolved_acceptance_ids: [],
    evidence_ids: evidenceIds,
    summary: `${ticketId} adjudicated successful.`,
    closed_at: "2026-08-02T00:00:00.000Z",
  };
}

function proofTree(repo) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const child = join(dir, name);
      if (statSync(child).isDirectory()) walk(child);
      else files.push(child);
    }
  };
  walk(join(repo, ".vibehub"));
  return new Map(files.sort().map((file) => [relative(repo, file), readFileSync(file, "utf8")]));
}

// A format-2 repository whose Git history carries every reconstruction case:
// clean HEAD-ancestry reconstruction, drift after addition, a Ticket added
// after its Evidence, a criterion referenced before it existed, a re-added
// file, and a document with no addition commit at all.
function migrationFixture() {
  const repo = mkdtempSync(join(tmpdir(), "vibehub-binding-migration-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "proof@example.test");
  git(repo, "config", "user.name", "Proof Fixture");
  for (const dir of ["tickets", "evidence", "outcomes", "rooms"]) {
    mkdirSync(join(repo, ".vibehub", dir), { recursive: true });
  }
  writeDoc(repo, ".vibehub/version.yaml", { schema_version: 1, kind: "vibehub_project", format_version: 2 });

  const clean = fixtureTicket("t-clean", [{ acceptance_id: "works", criterion: "t-clean works as specified." }]);
  const drift = fixtureTicket("t-drift", [{ acceptance_id: "works", criterion: "t-drift works as first specified." }]);
  const human = fixtureTicket("t-human", [{ acceptance_id: "approves", authority: "human", criterion: "The owner approves t-human." }]);
  const grow = fixtureTicket("t-grow", [{ acceptance_id: "works", criterion: "t-grow works as specified." }]);
  writeDoc(repo, ".vibehub/tickets/t-clean.yaml", clean);
  writeDoc(repo, ".vibehub/tickets/t-drift.yaml", drift);
  writeDoc(repo, ".vibehub/tickets/t-human.yaml", human);
  writeDoc(repo, ".vibehub/tickets/t-grow.yaml", grow);
  writeDoc(repo, ".vibehub/evidence/t-clean/e-clean.yaml", fixtureEvidence("e-clean", "t-clean", ["works"]));
  writeDoc(repo, ".vibehub/evidence/t-clean/e-readd.yaml", fixtureEvidence("e-readd", "t-clean", ["works"]));
  // Deliberately non-sorted key order (summary before refs), still exactly
  // JSON.stringify(..., null, 2): the migration must preserve it byte for
  // byte apart from the version bump and the inserted field.
  const oddOrder = fixtureEvidence("e-drift", "t-drift", ["works"]);
  writeDoc(repo, ".vibehub/evidence/t-drift/e-drift.yaml", {
    schema_version: oddOrder.schema_version,
    kind: oddOrder.kind,
    evidence_id: oddOrder.evidence_id,
    ticket_id: oddOrder.ticket_id,
    acceptance_ids: oddOrder.acceptance_ids,
    summary: oddOrder.summary,
    refs: oddOrder.refs,
    recorded_at: oddOrder.recorded_at,
  }, { sortKeys: false });
  writeDoc(repo, ".vibehub/evidence/t-human/e-human.yaml", fixtureEvidence("e-human", "t-human", ["approves"], { origin: "human" }));
  // References a criterion that does not exist yet at this addition.
  writeDoc(repo, ".vibehub/evidence/t-grow/e-grow.yaml", fixtureEvidence("e-grow", "t-grow", ["works", "extra"]));
  // Belongs to a Ticket whose file is only committed later.
  writeDoc(repo, ".vibehub/evidence/t-late/e-early.yaml", fixtureEvidence("e-early", "t-late", ["works"]));
  writeDoc(repo, ".vibehub/outcomes/t-clean.yaml", fixtureOutcome("t-clean", ["works"], ["e-clean"]));
  writeDoc(repo, ".vibehub/outcomes/t-drift.yaml", fixtureOutcome("t-drift", ["works"], ["e-drift"]));
  writeDoc(repo, ".vibehub/outcomes/t-human.yaml", fixtureOutcome("t-human", ["approves"], ["e-human"]));
  // Adjudicated before the referenced criterion existed on the Ticket.
  writeDoc(repo, ".vibehub/outcomes/t-grow.yaml", fixtureOutcome("t-grow", ["works", "extra"], ["e-grow"]));
  git(repo, "add", ".");
  const first = commit(repo, "legacy proof corpus", "2026-08-02T00:00:00Z");

  // The contract drifts after the proof was added; the grown Ticket gains the
  // criterion its Evidence referenced early; the late Ticket file arrives.
  writeDoc(repo, ".vibehub/tickets/t-drift.yaml", fixtureTicket("t-drift", [
    { acceptance_id: "works", criterion: "t-drift works as revised after adjudication." },
  ]));
  writeDoc(repo, ".vibehub/tickets/t-grow.yaml", fixtureTicket("t-grow", [
    { acceptance_id: "works", criterion: "t-grow works as specified." },
    { acceptance_id: "extra", criterion: "t-grow covers the later criterion." },
  ]));
  writeDoc(repo, ".vibehub/tickets/t-late.yaml", fixtureTicket("t-late", [
    { acceptance_id: "works", criterion: "t-late works as specified." },
  ]));
  git(repo, "add", ".");
  commit(repo, "contract revisions and late arrivals", "2026-08-03T00:00:00Z");

  // A deleted and re-added proof reconstructs from its current incarnation.
  unlinkSync(join(repo, ".vibehub", "evidence", "t-clean", "e-readd.yaml"));
  git(repo, "add", ".");
  commit(repo, "remove e-readd", "2026-08-04T00:00:00Z");
  writeDoc(repo, ".vibehub/evidence/t-clean/e-readd.yaml", fixtureEvidence("e-readd", "t-clean", ["works"]));
  git(repo, "add", ".");
  const readdCommit = commit(repo, "re-add e-readd", "2026-08-05T00:00:00Z");

  // Never committed at all: reconstruction must fall to unresolved, not
  // invent an addition.
  writeDoc(repo, ".vibehub/evidence/t-clean/e-uncommitted.yaml", fixtureEvidence("e-uncommitted", "t-clean", ["works"]));

  return { repo, first, readdCommit };
}

test("the migrator's firstCurrentAddition follows HEAD ancestry and re-added incarnations", () => {
  const { repo, first, readdCommit } = migrationFixture();
  assert.equal(firstCurrentAddition(repo, ".vibehub/evidence/t-clean/e-clean.yaml"), first);
  // git log --follow chains the deleted-and-re-added proof back to its first
  // addition on the current HEAD ancestry: reconstruction stays deterministic
  // and reads the contract the proof was originally checked in beside.
  const readd = firstCurrentAddition(repo, ".vibehub/evidence/t-clean/e-readd.yaml");
  assert.equal(readd, first);
  assert.notEqual(readd, null);
  assert.notEqual(readdCommit, first, "the fixture really did delete and re-add the file in later commits");
  assert.equal(firstCurrentAddition(repo, ".vibehub/evidence/t-clean/e-uncommitted.yaml"), null);

  // An unrelated branch is not current repository truth.
  git(repo, "branch", "unrelated", first);
  git(repo, "checkout", "-q", "unrelated");
  writeDoc(repo, ".vibehub/evidence/t-clean/e-elsewhere.yaml", fixtureEvidence("e-elsewhere", "t-clean", ["works"]));
  git(repo, "add", ".");
  commit(repo, "unrelated proof", "2026-08-06T00:00:00Z");
  git(repo, "checkout", "-q", "main");
  assert.equal(firstCurrentAddition(repo, ".vibehub/evidence/t-clean/e-elsewhere.yaml"), null);
});

test("dry run reconstructs the corpus mechanically and the apply reproduces its retention exactly", () => {
  const { repo, first } = migrationFixture();
  const dryRun = migrateProofBindings(repo);
  assert.equal(dryRun.mode, "dry-run");
  assert.equal(dryRun.audited_commit, git(repo, "rev-parse", "HEAD"));
  assert.deepEqual(dryRun.corpus, { tickets: 5, evidence: 7, outcomes: 4, successful_outcomes: 4 });

  assert.deepEqual(dryRun.evidence.unresolved, [
    { evidence_id: "e-early", ticket_id: "t-late", reasons: ["ticket-unreadable-at-addition"], missing_at_addition_ids: [] },
    { evidence_id: "e-grow", ticket_id: "t-grow", reasons: ["referenced-acceptance-missing-at-addition"], missing_at_addition_ids: ["extra"] },
    { evidence_id: "e-uncommitted", ticket_id: "t-clean", reasons: ["no-addition-commit"], missing_at_addition_ids: [] },
  ]);
  assert.deepEqual(dryRun.evidence.drifted, [
    { evidence_id: "e-drift", ticket_id: "t-drift", stale_acceptance_ids: ["works"] },
  ]);
  assert.deepEqual(dryRun.outcomes.unresolved, [
    { ticket_id: "t-drift", status: "successful", reason: "contract-drifted-since-addition", acceptance_ids: ["works"] },
    { ticket_id: "t-grow", status: "successful", reason: "referenced-acceptance-missing-at-addition", acceptance_ids: ["extra"] },
  ]);
  assert.equal(dryRun.outcomes.reconstructed_current, 2, "t-clean and t-human reconstruct to the unchanged current contract");

  // Retention is recomputed, never hard-coded: the drifted and unresolvable
  // Outcomes stop counting, everything else is preserved.
  assert.equal(dryRun.retention.before.done_tickets, 4);
  assert.equal(dryRun.retention.after.done_tickets, 2);
  assert.deepEqual(dryRun.retention.after.replan_unresolved_tickets, ["t-drift", "t-grow"]);
  assert.equal(dryRun.retention.before.human_authority_criteria_satisfied, 1);
  assert.equal(dryRun.retention.after.human_authority_criteria_satisfied, 1, "an unchanged human criterion keeps its reconstructed human-origin satisfaction");
  assert.deepEqual(
    dryRun.changed_projection.map((item) => [item.ticket_id, item.before.action, item.after.action, item.after.reason]),
    [
      ["t-drift", "DONE", "REPLAN", "unresolved_legacy_outcome"],
      ["t-grow", "DONE", "REPLAN", "unresolved_legacy_outcome"],
      ["t-late", "CLOSE_OUT", "EXECUTE", "acceptance_evidence_incomplete"],
    ],
  );

  // A dry run writes nothing.
  const beforeTree = proofTree(repo);
  assert.equal(readFileSync(join(repo, ".vibehub", "version.yaml"), "utf8").includes("\"format_version\": 2"), true);

  const applied = migrateProofBindings(repo, { apply: true });
  assert.equal(applied.apply.retention_verified_after_apply, true);
  assert.deepEqual(applied.retention, dryRun.retention, "the apply retention equals the dry-run report");
  assert.deepEqual(applied.outcomes, dryRun.outcomes);
  assert.deepEqual(applied.evidence, dryRun.evidence);

  // Byte preservation: removing the inserted field and restoring the version
  // reproduces the original bytes exactly — including the deliberately odd
  // key order of e-drift.
  const afterTree = proofTree(repo);
  for (const [path, original] of beforeTree) {
    const migrated = afterTree.get(path);
    if (migrated === original) continue;
    const document = JSON.parse(migrated);
    if (path === ".vibehub/version.yaml") {
      assert.equal(document.format_version, 3);
      continue;
    }
    assert.equal(document.schema_version, 2, `${path} carries the registered version bump`);
    delete document.acceptance_bindings;
    delete document.contract_binding;
    document.schema_version = 1;
    assert.equal(`${JSON.stringify(document, null, 2)}\n`, original, `${path} is byte-preserved except the added optional field`);
  }
  const oddMigrated = readFileSync(join(repo, ".vibehub", "evidence", "t-drift", "e-drift.yaml"), "utf8");
  assert.ok(oddMigrated.indexOf("\"summary\"") < oddMigrated.indexOf("\"refs\""), "the odd historical key order survives the migration");

  // The reconstructed bindings carry the addition commit as provenance, and
  // the drifted digest is the historical criterion's, not the current one.
  const driftEvidence = JSON.parse(oddMigrated);
  assert.deepEqual(driftEvidence.acceptance_bindings, [{
    acceptance_id: "works",
    binding: "reconstructed",
    digest: contractIdentity(fixtureTicket("t-drift", [
      { acceptance_id: "works", criterion: "t-drift works as first specified." },
    ])).criterion_digests.works,
    provenance_ref: `commit:${first}`,
  }]);
  const uncommitted = JSON.parse(afterTree.get(".vibehub/evidence/t-clean/e-uncommitted.yaml"));
  assert.equal(uncommitted.acceptance_bindings, undefined, "no binding is fabricated for missing history");
  assert.equal(uncommitted.schema_version, 2);
  const growOutcome = JSON.parse(afterTree.get(".vibehub/outcomes/t-grow.yaml"));
  assert.deepEqual(growOutcome.contract_binding, {
    binding: "reconstructed",
    unresolved: { reason: "referenced-acceptance-missing-at-addition", acceptance_ids: ["extra"] },
  });

  // The migrated repository is CURRENT, valid, and projects the report.
  assert.equal(run(repo, "project", "compatibility").envelope.data.state, "CURRENT");
  const validated = run(repo, "ticket", "validate");
  assert.equal(validated.status, 0, validated.stdout);
  const graph = run(repo, "ticket", "graph", undefined, ["--scope", "all"]).envelope.data;
  const actions = Object.fromEntries(graph.tickets.map((item) => [item.ticket.ticket_id, [item.next_action.action, item.next_action.reason]]));
  assert.deepEqual(actions["t-clean"], ["DONE", "successful_outcome"]);
  assert.deepEqual(actions["t-human"], ["DONE", "successful_outcome"]);
  assert.deepEqual(actions["t-drift"], ["REPLAN", "unresolved_legacy_outcome"]);
  assert.deepEqual(actions["t-grow"], ["REPLAN", "unresolved_legacy_outcome"]);

  // Replay: a second apply is byte-identical with the same unresolved set.
  const replay = migrateProofBindings(repo, { apply: true });
  assert.deepEqual(replay.outcomes.unresolved, dryRun.outcomes.unresolved);
  assert.deepEqual(replay.evidence.unresolved, dryRun.evidence.unresolved);
  assert.equal(replay.apply.rewritten_documents, 0, "a replay rewrites nothing");
  const replayTree = proofTree(repo);
  assert.deepEqual([...replayTree.entries()], [...afterTree.entries()], "replay is byte-identical");

  // Rollback: the format 2 interpretation returns without deleting bindings,
  // and reapplying reproduces identical results.
  writeDoc(repo, ".vibehub/version.yaml", { schema_version: 1, kind: "vibehub_project", format_version: 2 });
  const rolledBack = run(repo, "ticket", "graph", undefined, ["--scope", "all"]).envelope.data;
  const rolledBackDrift = rolledBack.tickets.find((item) => item.ticket.ticket_id === "t-drift");
  assert.equal(rolledBackDrift.next_action.action, "DONE", "rollback restores the legacy interpretation");
  assert.ok(JSON.parse(readFileSync(join(repo, ".vibehub", "outcomes", "t-drift.yaml"), "utf8")).contract_binding, "rollback deletes no binding");
  const reapplied = migrateProofBindings(repo, { apply: true });
  assert.deepEqual(reapplied.outcomes.unresolved, dryRun.outcomes.unresolved);
  assert.deepEqual([...proofTree(repo).entries()], [...afterTree.entries()], "reapply after rollback is byte-identical");

  // Human authority still requires human-origin Evidence after migration:
  // the now-CURRENT repository routes a fresh human criterion to NEEDS_HUMAN
  // until explicit human-origin Evidence arrives.
  const fresh = fixtureTicket("t-fresh-human", [
    { acceptance_id: "signoff", authority: "human", criterion: "The owner signs off on t-fresh-human." },
  ]);
  assert.equal(run(repo, "ticket", "apply", { tickets: [fresh] }).status, 0);
  assert.equal(run(repo, "ticket", "evidence", fixtureEvidence("agent-attempt", "t-fresh-human", ["signoff"])).status, 0);
  assert.deepEqual(
    [
      run(repo, "ticket", "get", { ticket_id: "t-fresh-human" }).envelope.data.next_action.action,
      run(repo, "ticket", "get", { ticket_id: "t-fresh-human" }).envelope.data.next_action.reason,
    ],
    ["NEEDS_HUMAN", "missing_human_evidence"],
  );
  assert.equal(run(repo, "ticket", "evidence", fixtureEvidence("owner-signoff", "t-fresh-human", ["signoff"], { origin: "human" })).status, 0);
  assert.equal(run(repo, "ticket", "get", { ticket_id: "t-fresh-human" }).envelope.data.next_action.action, "CLOSE_OUT");
});

test("the migrator is a CLI with a dry-run default and refuses non-canonical serialization", () => {
  const { repo } = migrationFixture();
  const dryRun = spawnSync(process.execPath, [MIGRATOR, "--repo", repo], { encoding: "utf8" });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const report = JSON.parse(dryRun.stdout);
  assert.equal(report.mode, "dry-run");
  assert.equal(readFileSync(join(repo, ".vibehub", "version.yaml"), "utf8").includes("\"format_version\": 2"), true, "a dry run writes nothing");

  const reportPath = join(repo, "dry-run-report.json");
  const withReport = spawnSync(process.execPath, [MIGRATOR, "--repo", repo, "--report", reportPath], { encoding: "utf8" });
  assert.equal(withReport.status, 0, withReport.stderr);
  assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), JSON.parse(withReport.stdout));

  // A document that is not exactly its own JSON.stringify(…, null, 2) bytes
  // is refused rather than silently normalized.
  const odd = join(repo, ".vibehub", "evidence", "t-clean", "e-clean.yaml");
  const document = JSON.parse(readFileSync(odd, "utf8"));
  writeFileSync(odd, `${JSON.stringify(document, null, 4)}\n`);
  const refused = spawnSync(process.execPath, [MIGRATOR, "--repo", repo], { encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /non-canonically-serialized/u);
});
