import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { firstCurrentAddition } from "../scripts/audit-legacy-proof.mjs";
import { loadRepository } from "../skills/vibehub-core/scripts/vh.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("pinned 59de368 legacy audit remains fully reconstructable with known drift", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/legacy-proof-snapshot-59de368.json", import.meta.url), "utf8"));
  const summarize = (classes) => ({
    total: classes.reduce((sum, item) => sum + item.count, 0),
    reconstructable: classes.filter((item) => item.reconstructable).reduce((sum, item) => sum + item.count, 0),
    unresolved: classes.filter((item) => !item.reconstructable).reduce((sum, item) => sum + item.count, 0),
    drifted: classes.filter((item) => item.contract_drifted).reduce((sum, item) => sum + item.count, 0),
  });
  assert.equal(fixture.commit, "59de368c8a420d2913a6aa7a9d35cf7f52a7e569");
  assert.deepEqual(summarize(fixture.evidence_classes), { total: 307, reconstructable: 307, unresolved: 0, drifted: 24 });
  assert.deepEqual(summarize(fixture.outcome_classes), { total: 95, reconstructable: 95, unresolved: 0, drifted: 2 });
  assert.deepEqual(fixture.outcome_classes.find((item) => item.contract_drifted).ticket_ids, [
    "ticket-deploy-public-site-cloudflare",
    "ticket-encode-human-acceptance-authority",
  ]);
});

test("current reconstructed Outcomes preserve mismatched legacy refs without granting revision credit", () => {
  const repository = loadRepository(root);
  assert.deepEqual(repository.errors, []);
  let preservedMismatches = 0;
  for (const { document: outcome } of repository.outcomes.history.values()) {
    if (outcome.binding_origin !== "reconstructed" || outcome.binding_state !== "bound") continue;
    const ticket = repository.tickets.documents.get(outcome.ticket_id)?.document;
    const contract = ticket?.contract_revisions.find((item) =>
      item.revision === outcome.contract_revision.revision
      && item.identity === outcome.contract_revision.identity);
    if (!contract) continue;
    for (const acceptanceId of outcome.accepted_acceptance_ids) {
      const expected = contract.acceptance_revisions.find((item) => item.acceptance_id === acceptanceId);
      for (const evidenceId of outcome.evidence_ids) {
        const evidence = repository.evidence.documents.get(evidenceId)?.document;
        if (!evidence?.acceptance_ids.includes(acceptanceId)) continue;
        const actual = evidence.acceptance_revisions?.find((item) => item.acceptance_id === acceptanceId);
        if (!actual || actual.revision !== expected?.revision || actual.identity !== expected?.identity) {
          preservedMismatches += 1;
        }
      }
    }
  }
  assert.ok(preservedMismatches > 0, "fixture must retain at least one immutable mismatched legacy Evidence ref");
});

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function commit(repo, message, timestamp) {
  return execFileSync("git", ["-C", repo, "commit", "-m", message], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_DATE: timestamp,
    },
  }).trim();
}

test("legacy proof reconstruction follows current HEAD ancestry, not unrelated refs", () => {
  const repo = mkdtempSync(join(tmpdir(), "vibehub-proof-history-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "proof@example.test");
  git(repo, "config", "user.name", "Proof Fixture");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  commit(repo, "base", "2026-01-01T00:00:00Z");
  git(repo, "branch", "unrelated");

  writeFileSync(join(repo, "proof.json"), "{\"branch\":\"main\"}\n");
  git(repo, "add", "proof.json");
  commit(repo, "main proof", "2026-01-02T00:00:00Z");
  const mainAddition = git(repo, "rev-parse", "HEAD");

  git(repo, "checkout", "unrelated");
  writeFileSync(join(repo, "proof.json"), "{\"branch\":\"unrelated\"}\n");
  git(repo, "add", "proof.json");
  commit(repo, "unrelated proof", "2026-01-03T00:00:00Z");
  const unrelatedAddition = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "main");

  assert.notEqual(mainAddition, unrelatedAddition);
  assert.equal(firstCurrentAddition(repo, "proof.json"), mainAddition);
});

test("policy proposal records every protected impact surface", () => {
  const source = readFileSync(join(root, "scripts", "audit-legacy-proof.mjs"), "utf8");
  const proposal = readFileSync(join(root, "docs", "LEGACY_PROOF_REVISION_POLICY.md"), "utf8");
  for (const field of [
    "done_tickets_retained",
    "archived_tickets_retained",
    "human_authority_satisfactions_retained",
    "close_out_tickets",
    "current_graph_tickets",
    "all_graph_tickets",
    "successful_prerequisite_edges",
    "open_dependents_unblocked",
    "installed_artifact_compatibility",
  ]) assert.match(source, new RegExp(field, "u"));
  assert.match(proposal, /Installed-artifact compatibility/u);
  assert.match(proposal, /current `HEAD` ancestry/u);
  assert.doesNotMatch(source, /"log", "--all"/u);
});
