import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyReleaseTag } from "../scripts/verify-release-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("v0.4.0 release identity is consistent and dependency-free", () => {
  const identity = verifyReleaseTag("v0.4.0");
  assert.equal(identity.version, "0.4.0");
  assert.deepEqual(new Set(Object.values(identity.versions)), new Set(["0.4.0"]));
});

test("README leads with the visual product and teaches proactive presentation", () => {
  const readme = read("README.md");
  for (const asset of [
    "assets/brand/vibehub-logo.svg",
    "docs/assets/local-graph/quiet-workbench-desktop.jpg",
    "docs/INSTALL.md",
    "docs/LOCAL_GRAPH_DESIGN.md",
  ]) {
    assert.ok(readme.includes(asset), `README missing ${asset}`);
    assert.ok(existsSync(join(root, asset)), `README target missing ${asset}`);
  }
  assert.match(readme, /\| \*\*Plan\*\* \| \*\*Execution\*\*/u);
  assert.match(readme, /\| \*\*Run\*\* \| Nothing extra/u);
  assert.match(readme, /\*\*Human boundary\*\* \| \*\*Contract\*\*/u);
  assert.match(readme, /\| \*\*Closeout\*\* \| \*\*Log\*\*/u);
  assert.doesNotMatch(readme, /Ask the Agent to open the VibeHub Ticket graph/u);
});

test("release is GitHub-only, reproducible, and documented", () => {
  const changelog = read("CHANGELOG.md");
  assert.match(changelog, /## 0\.4\.0 — 2026-08-02/u);
  assert.doesNotMatch(changelog, /## Unreleased/u);

  const workflow = read(".github/workflows/release.yml");
  for (const required of [
    "tags: [\"v*\"]",
    "verify-release-version.mjs",
    "npm run verify",
    "npm run build",
    "sha256sum",
    "gh release create",
  ]) assert.ok(workflow.includes(required), `release workflow missing ${required}`);
  assert.doesNotMatch(workflow, /npm publish|NODE_AUTH_TOKEN|strategy:|matrix:|native|marketplace/iu);

  const procedure = read("docs/RELEASE.md");
  assert.match(procedure, /Merge the verified PR/u);
  assert.match(procedure, /Tag the exact merged `main` commit/u);
  assert.match(procedure, /npm is not a release or installation surface/u);
});
