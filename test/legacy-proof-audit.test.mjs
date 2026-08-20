import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { firstCurrentAddition } from "../scripts/audit-legacy-proof.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

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
