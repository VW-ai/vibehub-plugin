import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyReleaseTag } from "../scripts/verify-release-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("v0.8.0 release identity is consistent and dependency-free", () => {
  const identity = verifyReleaseTag("v0.8.0");
  assert.equal(identity.version, "0.8.0");
  assert.deepEqual(new Set(Object.values(identity.versions)), new Set(["0.8.0"]));
});

test("README is a dark-safe one-line product surface", () => {
  const readme = read("README.md");
  for (const asset of [
    "assets/brand/vibehub-logo-dark.svg",
    "assets/brand/vibehub-logo.svg",
    "docs/assets/local-graph/quiet-workbench-desktop.jpg",
    "docs/assets/local-graph/workbench-ticket-proof.jpg",
    "docs/assets/local-graph/workbench-rooms-narrow.jpg",
    "docs/CONCEPT.md",
    "docs/INSTALL.md",
    "docs/LOCAL_GRAPH_DESIGN.md",
  ]) {
    assert.ok(readme.includes(asset), `README missing ${asset}`);
    assert.ok(existsSync(join(root, asset)), `README target missing ${asset}`);
  }
  assert.ok(readme.split("\n").length <= 60, "README is no longer one-line focused");
  assert.match(readme, /VibeHub turns a development request into a Git-native Ticket cycle/u);
  assert.equal([...readme.matchAll(/Start this with VibeHub\./gu)].length, 1);
  assert.match(readme, /Memory tools preserve the conversation; VibeHub preserves the development cycle\./u);
  assert.match(readme, /codex plugin marketplace add VW-ai\/vibehub-plugin/u);
  assert.match(readme, /\/plugin install vibehub@vibehub/u);
  assert.doesNotMatch(readme, /but no global CLI|MCP server, database|background capture/u);
  assert.doesNotMatch(readme, /The workflow presents itself|\| Moment \| What you see|The entire durable model/u);
});

test("the canonical entry routes through existing Setup and Ticket Plan", () => {
  const codex = JSON.parse(read(".codex-plugin/plugin.json"));
  assert.deepEqual(codex.interface.defaultPrompt, ["Start this with VibeHub."]);
  const plan = read("skills/vibehub-ticket-plan/SKILL.md");
  assert.match(plan, /canonical user entry “Start this with VibeHub\.”/u);
  assert.match(plan, /use `\$vibehub-setup` first and then/u);
  assert.doesNotMatch(plan, /orchestration Skill|routing service|hidden router/u);
  const concept = read("docs/CONCEPT.md");
  for (const truth of ["Ticket drives; Context survives", "Routine execution stays quiet", ".vibehub/", "no required Core package"]) {
    assert.ok(concept.includes(truth), `concept doc missing ${truth}`);
  }
});

test("release is GitHub-only, reproducible, and documented", () => {
  const changelog = read("CHANGELOG.md");
  assert.match(changelog, /## 0\.8\.0 — 2026-08-13/u);
  assert.doesNotMatch(changelog, /## Unreleased/u);

  const workflow = read(".github/workflows/release.yml");
  for (const required of [
    "tags: [\"v*\"]",
    "verify-release-version.mjs",
    "npm run verify",
    "npm run build",
    "sha256sum",
    "cd dist",
    "gh release create",
  ]) assert.ok(workflow.includes(required), `release workflow missing ${required}`);
  assert.doesNotMatch(workflow, /npm publish|NODE_AUTH_TOKEN|strategy:|matrix:|native|marketplace/iu);

  const procedure = read("docs/RELEASE.md");
  assert.match(procedure, /Merge the verified PR/u);
  assert.match(procedure, /Tag the exact merged `main` commit/u);
  assert.match(procedure, /npm is not a release or installation surface/u);
});
