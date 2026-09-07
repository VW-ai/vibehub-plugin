import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  latestReachableStableTag,
  verifyReleaseTag,
  verifyShippedContentVersion,
} from "../scripts/verify-release-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("v0.9.0 release identity is consistent and dependency-free", () => {
  const identity = verifyReleaseTag("v0.9.0");
  assert.equal(identity.version, "0.9.0");
  assert.deepEqual(new Set(Object.values(identity.versions)), new Set(["0.9.0"]));
});

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function writeIdentity(repo, version, changelog) {
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({
    name: "release-gate-fixture",
    version,
    private: true,
  }, null, 2)}\n`);
  writeFileSync(join(repo, ".claude-plugin", "plugin.json"), `${JSON.stringify({
    name: "vibehub",
    version,
  }, null, 2)}\n`);
  writeFileSync(join(repo, "CHANGELOG.md"), changelog);
}

function releaseGateFixture(name) {
  const repo = mkdtempSync(join(tmpdir(), `${name}-`));
  mkdirSync(join(repo, ".claude-plugin"));
  mkdirSync(join(repo, "skills", "fixture"), { recursive: true });
  writeIdentity(repo, "0.8.0", "# Changelog\n\n## 0.8.0 — 2026-08-13\n");
  writeFileSync(join(repo, "skills", "fixture", "SKILL.md"), "baseline\n");
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "VibeHub Test");
  git(repo, "config", "user.email", "vibehub@example.test");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "release 0.8.0");
  git(repo, "tag", "v0.8.0");
  return repo;
}

function importShippedHistory(repo, count) {
  const commands = [];
  for (let index = 1; index <= count; index += 1) {
    const message = `shipped change ${index}\n`;
    const content = `shipped change ${index}\n`;
    commands.push(
      "commit refs/heads/replayed-main",
      `mark :${index}`,
      "author VibeHub Test <vibehub@example.test> 1788552000 +0000",
      "committer VibeHub Test <vibehub@example.test> 1788552000 +0000",
      `data ${Buffer.byteLength(message)}`,
      message.trimEnd(),
      `from ${index === 1 ? "refs/tags/v0.8.0" : `:${index - 1}`}`,
      "M 100644 inline skills/fixture/SKILL.md",
      `data ${Buffer.byteLength(content)}`,
      content.trimEnd(),
      "",
    );
  }
  const imported = spawnSync("git", ["-C", repo, "fast-import", "--quiet"], {
    input: `${commands.join("\n")}\n`,
    encoding: "utf8",
  });
  assert.equal(imported.status, 0, imported.stderr || imported.stdout);
  git(repo, "checkout", "-B", "main", "replayed-main");
}

test("shipped-content gate blocks the 143-commit stale identity and permits honest release states", () => {
  const unshipped = releaseGateFixture("release-gate-unshipped");
  writeFileSync(join(unshipped, "maintainer-note.txt"), "not in the artifact\n");
  git(unshipped, "add", "maintainer-note.txt");
  git(unshipped, "commit", "-m", "maintainer-only note");
  assert.equal(verifyShippedContentVersion({ sourceRoot: unshipped }).shippedContentChanged, false);

  const repo = releaseGateFixture("release-gate-143");
  importShippedHistory(repo, 143);
  assert.equal(Number(git(repo, "rev-list", "--count", "v0.8.0..HEAD")), 143);
  assert.throws(
    () => verifyShippedContentVersion({ sourceRoot: repo }),
    /shipped content differs from v0\.8\.0.*reuses that published release identity/u,
  );

  git(repo, "branch", "unreachable-release", "v0.8.0");
  git(repo, "checkout", "unreachable-release");
  writeFileSync(join(repo, "unreachable.txt"), "not on main\n");
  git(repo, "add", "unreachable.txt");
  git(repo, "commit", "-m", "unreachable future release");
  git(repo, "tag", "v9.0.0");
  git(repo, "checkout", "main");
  git(repo, "tag", "v99.0.0-rc.1");
  assert.equal(latestReachableStableTag(repo), "v0.8.0");

  writeIdentity(repo, "not-a-version", "# Changelog\n");
  assert.throws(
    () => verifyShippedContentVersion({ sourceRoot: repo }),
    /invalid release version/u,
  );
  writeIdentity(repo, "0.7.0", "# Changelog\n\n## 0.7.0 — 2026-01-01\n");
  assert.throws(
    () => verifyShippedContentVersion({ sourceRoot: repo }),
    /older than reachable release v0\.8\.0/u,
  );
  writeIdentity(repo, "0.9.0-dev.1", "# Changelog\n\n## 0.8.0 — 2026-08-13\n");
  assert.throws(
    () => verifyShippedContentVersion({ sourceRoot: repo }),
    /prerelease 0\.9\.0-dev\.1 requires an Unreleased/u,
  );
  writeIdentity(repo, "0.9.0-dev.1", "# Changelog\n\n## Unreleased\n\n- Next release.\n\n## 0.8.0 — 2026-08-13\n");
  assert.deepEqual(
    (({ baselineTag, releaseState, shippedContentChanged }) => ({ baselineTag, releaseState, shippedContentChanged }))(
      verifyShippedContentVersion({ sourceRoot: repo }),
    ),
    { baselineTag: "v0.8.0", releaseState: "prerelease", shippedContentChanged: true },
  );
  writeFileSync(join(repo, ".claude-plugin", "plugin.json"), `${JSON.stringify({
    name: "vibehub",
    version: "0.9.0-dev.2",
  }, null, 2)}\n`);
  assert.throws(
    () => verifyShippedContentVersion({ sourceRoot: repo }),
    /release versions do not match/u,
  );

  writeIdentity(repo, "0.9.0", "# Changelog\n\n## Unreleased\n\n- Not finalized.\n");
  assert.throws(
    () => verifyShippedContentVersion({ sourceRoot: repo }),
    /stable release candidate 0\.9\.0 must finalize/u,
  );
  writeIdentity(repo, "0.9.0", "# Changelog\n\n## 0.9.0 — 2026-09-04\n\n- Final.\n");
  assert.equal(verifyShippedContentVersion({ sourceRoot: repo }).releaseState, "stable");
  git(repo, "add", "package.json", ".claude-plugin/plugin.json", "CHANGELOG.md");
  git(repo, "commit", "-m", "release 0.9.0");
  git(repo, "tag", "v0.9.0");
  writeFileSync(join(repo, "skills", "fixture", "SKILL.md"), "first shipped change after 0.9.0\n");
  assert.throws(
    () => verifyShippedContentVersion({ sourceRoot: repo }),
    /shipped content differs from v0\.9\.0.*reuses that published release identity/u,
  );
});

test("README is a dark-safe one-line product surface", () => {
  const readme = read("README.md");
  for (const asset of [
    "assets/brand/vibehub-logo-dark.svg",
    "assets/brand/vibehub-logo.svg",
    "docs/assets/local-graph/quiet-workbench-desktop-2x.png",
    "docs/assets/local-graph/workbench-ticket-action-2x.png",
    "docs/assets/local-graph/workbench-rooms-narrow-2x.png",
    "docs/assets/github-issues/issue-blocked-by-2x.png",
    "docs/CONCEPT.md",
    "docs/INSTALL.md",
    "docs/LOCAL_GRAPH_DESIGN.md",
    "docs/GITHUB_ISSUES.md",
  ]) {
    assert.ok(readme.includes(asset), `README missing ${asset}`);
    assert.ok(existsSync(join(root, asset)), `README target missing ${asset}`);
  }
  assert.ok(existsSync(join(root, "docs/assets/local-graph/readme-capture-manifest.json")));
  assert.ok(readme.split("\n").length <= 90, "README grew past its two-part budget");
  // Install is above the fold: the one-line command and the entry line precede every image and the story.
  const installAt = readme.indexOf("npx skills add VW-ai/vibehub-plugin");
  const entryAt = readme.indexOf("Start this with VibeHub.");
  const firstImageAt = readme.indexOf("<img src=\"docs/assets/");
  const storyAt = readme.indexOf("## How it works");
  assert.ok(installAt > 0 && installAt < firstImageAt && installAt < storyAt, "install command must precede the first image and the story");
  assert.ok(entryAt > installAt && entryAt < firstImageAt, "entry line must follow install and precede the first image");
  assert.match(readme, /## Work with your team on GitHub/u);
  assert.match(readme, /mirrors one-way to a GitHub Issue/u);
  assert.match(readme, /Stop managing chats\. Manage the work\./u);
  assert.match(readme, /Turn one coding request into a Git-native Ticket with the exact Context needed/u);
  assert.equal([...readme.matchAll(/href="https:\/\/vibehub\.team"/gu)].length, 1);
  assert.match(readme, /request and exact Context shape one Ticket/u);
  assert.match(readme, /work produces acceptance-linked Evidence; a separate Agent decides the Outcome; accepted learning returns to Context/u);
  assert.match(readme, /Git keeps the history reviewable and reversible/u);
  assert.doesNotMatch(readme, /https:\/\/(?:www\.)?vibehub\.team[^"<\s]|https:\/\/[^"<\s]*\.pages\.dev|AI-Native Command Center|From PRD to delivery/iu);
  assert.equal([...readme.matchAll(/Start this with VibeHub\./gu)].length, 1);
  assert.match(readme, /Memory tools preserve the conversation; VibeHub preserves the development cycle\./u);
  for (const phase of ["DRAFT", "READY", "RUNNING", "DONE"]) assert.match(readme, new RegExp(`\\b${phase}\\b`, "u"));
  assert.match(readme, /Recommended action stays primary/u);
  assert.doesNotMatch(readme, /docs\/assets\/local-graph\/[^\s"')]+\.jpe?g/iu);
  assert.match(readme, /npx skills add VW-ai\/vibehub-plugin/u);
  assert.doesNotMatch(readme, /plugin marketplace add|plugin install vibehub@vibehub/u);
  assert.doesNotMatch(readme, /but no global CLI|MCP server, database|background capture/u);
  assert.doesNotMatch(readme, /The workflow presents itself|\| Moment \| What you see|The entire durable model/u);
  const install = read("docs/INSTALL.md");
  assert.match(install, /retains `.claude-plugin\/plugin\.json` only because\s+skills\.sh reads it as repository metadata/u);
  assert.match(install, /marketplace manifest and the retired Codex plugin manifest were removed/u);
  assert.doesNotMatch(install, /Installation copies manifests/u);
});

test("retired marketplace distribution cannot reappear in active surfaces", () => {
  assert.equal(existsSync(join(root, ".agents/plugins/marketplace.json")), false);
  const site = read("site/app/page.tsx");
  const siteTest = read("site/tests/rendered-html.test.mjs");
  const historicalProposal = read("docs/proposals/npx-first-install-experience.md");
  const retiredCommands = /plugin marketplace add|plugin install vibehub@vibehub/u;

  assert.doesNotMatch(site, retiredCommands);
  assert.doesNotMatch(siteTest, /assert\.match\([^\n]+(?:plugin marketplace add|plugin install vibehub@vibehub)/u);
  assert.doesNotMatch(historicalProposal, /marketplace commands keep working|host marketplace upgrade|marketplace path keeps working/u);
  assert.match(historicalProposal, /Historical proposal[\s\S]+only supported install path now/u);
});

test("README Workbench screenshots match the checked-in Retina capture manifest", () => {
  const manifest = JSON.parse(read("docs/assets/local-graph/readme-capture-manifest.json"));
  assert.equal(manifest.source_commit, "55c52b49b9d7caffe0ce5c048529269dbfdb9261");
  assert.equal(manifest.dpr, 2);
  const expected = new Map([
    ["docs/assets/local-graph/quiet-workbench-desktop-2x.png", [1280, 720, 2560, 1440]],
    ["docs/assets/local-graph/workbench-ticket-action-2x.png", [1180, 820, 2360, 1640]],
    ["docs/assets/local-graph/workbench-rooms-narrow-2x.png", [390, 844, 780, 1688]],
    ["docs/assets/github-issues/issue-blocked-by-2x.png", [1280, 720, 2560, 1440]],
    ["docs/assets/github-issues/issues-list-2x.png", [1280, 720, 2560, 1440]],
  ]);
  assert.equal(manifest.captures.length, expected.size);
  for (const capture of manifest.captures) {
    const dimensions = expected.get(capture.path);
    assert.ok(dimensions, `unexpected README capture ${capture.path}`);
    assert.deepEqual(capture.css_viewport, { width: dimensions[0], height: dimensions[1] });
    assert.deepEqual(capture.output_pixels, { width: dimensions[2], height: dimensions[3] });
    assert.equal(capture.dpr, 2);
    const bytes = readFileSync(join(root, capture.path));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16), dimensions[2]);
    assert.equal(bytes.readUInt32BE(20), dimensions[3]);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), capture.sha256);
  }
});

test("the canonical entry routes through existing Setup and Ticket Plan", () => {
  // The canonical entry prompt lived in the Codex marketplace manifest, which
  // was retired with the rest of marketplace distribution; the Skills are now
  // its only home.
  const setup = read("skills/vibehub-setup/SKILL.md");
  assert.match(setup, /Start this with VibeHub\./u);
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
  assert.match(changelog, /## 0\.9\.0 — 2026-09-04/u);
  assert.doesNotMatch(changelog, /## Unreleased/u);
  assert.match(changelog, /## 0\.8\.0 — 2026-08-13/u);

  const workflow = read(".github/workflows/release.yml");
  for (const required of [
    "tags: [\"v*\"]",
    "verify-release-version.mjs",
    "npm run verify",
    "npm run build",
    "build-upgrade-package.mjs",
    "vibehub-upgrade.tgz",
    "vibehub-upgrade.tgz.sha256",
    "sha256sum",
    "cd dist",
    "gh release create",
  ]) assert.ok(workflow.includes(required), `release workflow missing ${required}`);
  assert.doesNotMatch(workflow, /npm publish|NODE_AUTH_TOKEN|strategy:|matrix:|native|marketplace/iu);

  const verifyWorkflow = read(".github/workflows/verify.yml");
  assert.match(verifyWorkflow, /fetch-depth: 0/u);
  assert.match(verifyWorkflow, /node scripts\/verify-release-version\.mjs --check-shipped-content/u);
  assert.ok(
    verifyWorkflow.indexOf("--check-shipped-content") < verifyWorkflow.indexOf("npm test"),
    "version identity must fail before the expensive suite",
  );

  const procedure = read("docs/RELEASE.md");
  assert.match(procedure, /Merge the verified PR/u);
  assert.match(procedure, /Tag the exact merged `main` commit/u);
  assert.match(procedure, /npm is an execution client/u);
  assert.match(procedure, /not a registry release or global installation surface/u);
  assert.match(procedure, /same tag and commit identity/u);
  assert.match(procedure, /the package\s+and retained Claude plugin manifest as the only release-version\s+declarations/u);
  assert.doesNotMatch(procedure, /both plugin manifests|Claude marketplace\s+metadata/u);
  assert.match(procedure, /--check-shipped-content/u);
  assert.match(procedure, /imports `PLUGIN_PATHS`/u);
  assert.match(procedure, /There is intentionally no installed staleness command/u);
  const install = read("docs/INSTALL.md");
  assert.match(install, /updater detects plugin changes by content hash or\s+an unconditional refetch/u);
  assert.match(install, /ships no separate staleness command/u);
});
