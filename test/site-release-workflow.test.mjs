import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("the public-site release workflow is repository-local and discoverable", async () => {
  const [skill, agents, packageJson, readme, manifest, artifactBuilder] = await Promise.all([
    source("site/release/SKILL.md"),
    source("AGENTS.md"),
    source("site/package.json"),
    source("site/README.md"),
    source(".codex-plugin/plugin.json"),
    source("scripts/build-plugin-artifact.mjs"),
  ]);

  assert.match(skill, /name: vibehub-site-release/);
  assert.match(skill, /vibehub\.team/);
  assert.match(skill, /vibehub-website-v1/);
  assert.match(skill, /Cloudflare Pages/);
  assert.doesNotMatch(skill, /Sites hosting Skill|saved Sites version/);
  assert.match(agents, /site\/release\/SKILL\.md/);
  assert.match(packageJson, /"release:preflight"/);
  assert.match(packageJson, /"release:deploy"/);
  assert.match(packageJson, /"release:verify"/);
  assert.match(readme, /Production: \[vibehub\.team\]\(https:\/\/vibehub\.team\)/);
  assert.match(manifest, /"skills": "\.\/skills\/"/);
  assert.doesNotMatch(artifactBuilder, /["']site\/release["']/);
  await assert.rejects(access(new URL("site/.openai/hosting.json", root)), { code: "ENOENT" });
});

test("the release checker accepts the checked-in production identity", () => {
  const result = spawnSync(
    process.execPath,
    ["site/release/scripts/release.mjs", "check"],
    { cwd: new URL("../", import.meta.url), encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.canonical_url, "https://vibehub.team");
  assert.equal(output.cloudflare_account_id, "72091e7e079e357ced7f9603c03a926e");
  assert.equal(output.pages_project_name, "vibehub-website-v1");
  assert.equal(output.production_branch, "main");
});
