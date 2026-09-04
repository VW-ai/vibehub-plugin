import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { buildUpgradePackage, buildUpgradePackageDirectory, RELEASE_FILES } from "../scripts/build-upgrade-package.mjs";
import { helper, root, run, ticket } from "./helpers.mjs";

const RELEASE_TAG = `v${JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version}`;
const RELEASE_COMMIT = "1111111111111111111111111111111111111111";

function git(repo, ...args) {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function packagedBin(holder) {
  const packageRoot = join(holder, "package");
  buildUpgradePackageDirectory({ packageRoot, tag: RELEASE_TAG, commit: RELEASE_COMMIT });
  return join(packageRoot, "bin", "vibehub-upgrade.mjs");
}

function invokeUpgrade(bin, roots = [], env = {}) {
  const args = roots.flatMap((entry) => ["--root", entry]);
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
  return { ...result, envelope: JSON.parse(result.stdout) };
}

function initializeLegacyRepo(path) {
  mkdirSync(path, { recursive: true });
  assert.equal(run(path, "project", "init").status, 0);
  const current = ticket("legacy-work");
  const { revision_state, active_contract_revision, contract_revisions, ...legacy } = current;
  legacy.schema_version = 1;
  legacy.acceptance = current.acceptance.map(({ identity, revision, state, derived_from, presentation, ...item }) => item);
  delete legacy.deliveries;
  writeFileSync(join(path, ".vibehub", "tickets", "legacy-work.yaml"), `${JSON.stringify(legacy, null, 2)}\n`);
  writeFileSync(join(path, ".vibehub", "version.yaml"), `${JSON.stringify({
    schema_version: 1,
    kind: "vibehub_project",
    format_version: 1,
  }, null, 2)}\n`);
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "VibeHub Test");
  git(path, "config", "user.email", "vibehub@example.test");
  git(path, "add", ".");
  git(path, "commit", "-m", "format 1 fixture");
  return path;
}

function fileMap(repo) {
  const result = {};
  const pending = [repo];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) result[relative(repo, path)] = sha256(readFileSync(path));
    }
  }
  return result;
}

function snapshot(repo) {
  const index = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "index").trim();
  return {
    head: git(repo, "rev-parse", "HEAD").trim(),
    branch: git(repo, "symbolic-ref", "HEAD").trim(),
    status: git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
    indexSha256: sha256(readFileSync(index)),
    indexEntries: git(repo, "ls-files", "--stage", "-z"),
    files: fileMap(repo),
  };
}

function hostileExecutable(path, sentinel) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nprintf invoked > "${sentinel}"\nexit 91\n`);
  chmodSync(path, 0o755);
}

function recordingGit(holder) {
  const actual = realpathSync(process.env.PATH.split(":")
    .map((entry) => join(entry, "git"))
    .find((entry) => existsSync(entry)));
  const directory = join(holder, "recording-git");
  const log = join(holder, "git-subprocesses.log");
  const wrapper = join(directory, "git");
  mkdirSync(directory, { recursive: true });
  writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\034' "$@" >> "${log}"\nprintf '\\n' >> "${log}"\nexec "${actual}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  return { directory, log };
}

function gitSubcommand(args) {
  let index = 0;
  while (index < args.length) {
    if (["-c", "-C", "--git-dir", "--work-tree", "--namespace"].includes(args[index])) index += 2;
    else if (args[index].startsWith("--git-dir=") || args[index].startsWith("--work-tree=")
      || args[index].startsWith("--namespace=")) index += 1;
    else break;
  }
  return args[index];
}

test("release package is deterministic, allowlisted, single-bin, and identity-checked", () => {
  const holder = mkdtempSync(join(tmpdir(), "vibehub-upgrade-release-"));
  const first = buildUpgradePackage({ outDir: join(holder, "one"), tag: RELEASE_TAG, commit: RELEASE_COMMIT });
  const second = buildUpgradePackage({ outDir: join(holder, "two"), tag: RELEASE_TAG, commit: RELEASE_COMMIT });
  assert.equal(readFileSync(first.archive).equals(readFileSync(second.archive)), true);
  assert.equal(readFileSync(first.checksum, "utf8"), `${first.sha256}  vibehub-upgrade.tgz\n`);
  assert.deepEqual(first.files, [
    "bin/vibehub-upgrade.mjs",
    "package.json",
    "release-identity.json",
    ...RELEASE_FILES.slice(1).map(([, target]) => target),
  ].sort());

  const bin = packagedBin(join(holder, "runtime"));
  const packageRoot = dirname(dirname(bin));
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(packageJson.bin, { "vibehub-upgrade": "bin/vibehub-upgrade.mjs" });
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.scripts, undefined);
  const noRoot = invokeUpgrade(bin);
  assert.equal(noRoot.status, 1);
  assert.equal(noRoot.envelope.error.code, "missing_root");

  const npmCache = join(holder, "npm-cache");
  mkdirSync(npmCache);
  const npx = spawnSync("npx", ["--yes", `file:${first.archive}`], {
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: npmCache },
  });
  assert.equal(npx.status, 1, npx.stderr);
  assert.equal(JSON.parse(npx.stdout).error.code, "missing_root");

  const incompleteBin = packagedBin(join(holder, "incomplete-runtime"));
  const incompleteRoot = dirname(dirname(incompleteBin));
  const identityPath = join(incompleteRoot, "release-identity.json");
  const identity = JSON.parse(readFileSync(identityPath, "utf8"));
  const omittedContract = "vibehub-core/contracts/ticket.schema.json";
  delete identity.contract_sha256[omittedContract];
  writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
  writeFileSync(join(incompleteRoot, omittedContract), "tampered and omitted from manifest\n");
  const incomplete = invokeUpgrade(incompleteBin, [holder]);
  assert.equal(incomplete.status, 1);
  assert.equal(incomplete.envelope.error.code, "release_identity_mismatch");

  writeFileSync(join(packageRoot, "vibehub-core", "scripts", "vh.mjs"), "tampered\n");
  const rejected = invokeUpgrade(bin, [holder]);
  assert.equal(rejected.status, 1);
  assert.equal(rejected.envelope.error.code, "release_identity_mismatch");
});

test("bounded discovery migrates each safe registered worktree once and reports every other record", () => {
  const holder = mkdtempSync(join(tmpdir(), "vibehub-upgrade-multi-"));
  const scanRoot = join(holder, "scan");
  const repo = initializeLegacyRepo(join(scanRoot, "project"));
  const outside = join(holder, "outside");
  mkdirSync(outside, { recursive: true });
  const safeSibling = join(outside, "safe-sibling");
  const dirtySibling = join(outside, "dirty-sibling");
  const missingSibling = join(outside, "missing-sibling");
  git(repo, "worktree", "add", "-b", "safe-sibling", safeSibling);
  git(repo, "worktree", "add", "-b", "dirty-sibling", dirtySibling);
  git(repo, "worktree", "add", "-b", "missing-sibling", missingSibling);
  git(repo, "branch", "unregistered-branch");
  const unregisteredBefore = git(repo, "rev-parse", "unregistered-branch").trim();
  writeFileSync(join(dirtySibling, "user-note.txt"), "keep me\n");
  rmSync(missingSibling, { recursive: true, force: true });
  const outsideProject = initializeLegacyRepo(join(holder, "not-scanned", "ordinary-project"));
  symlinkSync(outsideProject, join(scanRoot, "linked-project"), "dir");
  const outsideBefore = snapshot(outsideProject);

  const hookSentinel = join(holder, "hook-ran");
  const signerSentinel = join(holder, "signer-ran");
  const fsmonitorSentinel = join(holder, "fsmonitor-ran");
  const hooks = join(holder, "hostile-hooks");
  hostileExecutable(join(hooks, "reference-transaction"), hookSentinel);
  hostileExecutable(join(hooks, "commit-msg"), hookSentinel);
  const signer = join(holder, "hostile-signer");
  hostileExecutable(signer, signerSentinel);
  const fsmonitor = join(holder, "hostile-fsmonitor");
  hostileExecutable(fsmonitor, fsmonitorSentinel);
  git(repo, "config", "core.hooksPath", hooks);
  git(repo, "config", "commit.gpgSign", "true");
  git(repo, "config", "gpg.program", signer);
  git(repo, "config", "core.fsmonitor", fsmonitor);

  const dirtyBefore = snapshot(dirtySibling);
  const bin = packagedBin(join(holder, "runtime"));
  const recorder = recordingGit(holder);
  const first = invokeUpgrade(bin, [scanRoot], {
    PATH: `${recorder.directory}:${process.env.PATH}`,
  });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.envelope.ok, true);
  assert.equal(first.envelope.data.repositories, 1);
  assert.equal(first.envelope.data.identity.tag, RELEASE_TAG);
  const results = first.envelope.data.worktrees;
  assert.equal(results.length, 4);
  assert.deepEqual(results.filter((item) => item.state === "migrated").map((item) => item.path).sort(), [
    realpathSync(repo),
    realpathSync(safeSibling),
  ].sort());
  assert.equal(results.find((item) => item.path === realpathSync(dirtySibling)).reason, "dirty-worktree");
  assert.equal(results.find((item) => item.reason === "prunable").path, join(realpathSync(holder), "outside", "missing-sibling"));
  for (const path of [repo, safeSibling]) {
    const item = results.find((entry) => entry.path === realpathSync(path));
    assert.match(item.commit_id, /^[0-9a-f]{40}$/u);
    assert.equal(git(path, "rev-parse", "HEAD").trim(), item.commit_id);
    assert.equal(git(path, "status", "--porcelain=v1", "--untracked-files=all"), "");
    assert.equal(run(path, "project", "validate").status, 0);
    assert.deepEqual(item.semantic_pending_refs, [
      "migration-pending:format-1-to-format-2:classify-delivery-membership",
      "migration-pending:format-3-to-format-4:reconstruct-proof-revisions",
    ]);
  }
  assert.deepEqual(snapshot(dirtySibling), dirtyBefore);
  assert.deepEqual(snapshot(outsideProject), outsideBefore);
  assert.equal(git(repo, "rev-parse", "unregistered-branch").trim(), unregisteredBefore);
  assert.equal(existsSync(hookSentinel), false);
  assert.equal(existsSync(signerSentinel), false);
  assert.equal(existsSync(fsmonitorSentinel), false);
  const subprocesses = readFileSync(recorder.log, "utf8").trim().split("\n")
    .map((line) => line.split("\x1c").filter(Boolean));
  assert.ok(subprocesses.length > 0);
  for (const args of subprocesses) {
    assert.deepEqual(args.slice(0, 2), ["-c", "core.fsmonitor=false"]);
    assert.equal([
      "branch", "stash", "reset", "checkout", "clean", "commit", "push", "fetch", "pull", "remote",
    ].includes(gitSubcommand(args)), false, args.join(" "));
  }
  const commands = new Set(subprocesses.map(gitSubcommand));
  for (const command of ["read-tree", "hash-object", "update-index", "write-tree", "commit-tree", "update-ref"]) {
    assert.equal(commands.has(command), true, `missing recorded plumbing command ${command}`);
  }
  const cas = subprocesses.find((args) => gitSubcommand(args) === "update-ref");
  assert.ok(cas.some((arg) => arg.startsWith("core.hooksPath=")));
  assert.match(first.stderr, /migrated/u);

  const rerun = invokeUpgrade(bin, [scanRoot]);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(rerun.envelope.data.worktrees.filter((item) => item.state === "migrated").length, 0);
  assert.equal(rerun.envelope.data.worktrees.filter((item) => item.state === "current").length, 2);
  assert.deepEqual(snapshot(dirtySibling), dirtyBefore);
});

test("classification distinguishes current, unaffected, unsupported, and semantic-first without writes", () => {
  const holder = mkdtempSync(join(tmpdir(), "vibehub-upgrade-states-"));
  const scanRoot = join(holder, "scan");

  const current = join(scanRoot, "current");
  mkdirSync(current, { recursive: true });
  assert.equal(run(current, "project", "init").status, 0);
  git(current, "init", "-b", "main");
  git(current, "config", "user.name", "VibeHub Test");
  git(current, "config", "user.email", "vibehub@example.test");
  git(current, "add", ".");
  git(current, "commit", "-m", "current fixture");

  const invalidCurrent = join(scanRoot, "invalid-current");
  mkdirSync(invalidCurrent, { recursive: true });
  assert.equal(run(invalidCurrent, "project", "init").status, 0);
  git(invalidCurrent, "init", "-b", "main");
  git(invalidCurrent, "config", "user.name", "VibeHub Test");
  git(invalidCurrent, "config", "user.email", "vibehub@example.test");
  writeFileSync(join(invalidCurrent, ".vibehub", "tickets", "invalid.yaml"), "{}\n");
  git(invalidCurrent, "add", ".");
  git(invalidCurrent, "commit", "-m", "schema-invalid current fixture");
  const unaffected = join(holder, "outside", "unaffected");
  git(current, "worktree", "add", "-b", "unaffected", unaffected);
  git(unaffected, "rm", "-r", ".vibehub");
  git(unaffected, "commit", "-m", "remove VibeHub data on this branch");

  const newer = initializeLegacyRepo(join(scanRoot, "newer"));
  writeFileSync(join(newer, ".vibehub", "version.yaml"), `${JSON.stringify({
    schema_version: 1,
    kind: "vibehub_project",
    format_version: 99,
  }, null, 2)}\n`);
  git(newer, "add", ".vibehub/version.yaml");
  git(newer, "commit", "-m", "newer format fixture");

  const semantic = initializeLegacyRepo(join(scanRoot, "semantic-first"));
  unlinkSync(join(semantic, ".vibehub", "version.yaml"));
  mkdirSync(join(semantic, ".vibehub", "context"), { recursive: true });
  writeFileSync(join(semantic, ".vibehub", "context", "legacy.yaml"), "{}\n");
  git(semantic, "add", "-A");
  git(semantic, "commit", "-m", "semantic-first fixture");

  const before = new Map([current, invalidCurrent, unaffected, newer, semantic]
    .map((path) => [realpathSync(path), snapshot(path)]));
  const result = invokeUpgrade(packagedBin(join(holder, "runtime")), [scanRoot]);
  assert.equal(result.status, 0, result.stderr);
  const states = new Map(result.envelope.data.worktrees.map((item) => [item.path, item]));
  assert.equal(states.get(realpathSync(current)).state, "current");
  assert.equal(states.get(realpathSync(invalidCurrent)).state, "unsupported");
  assert.equal(states.get(realpathSync(invalidCurrent)).reason, "validation_error");
  assert.equal(states.get(realpathSync(unaffected)).state, "unaffected");
  assert.equal(states.get(realpathSync(newer)).state, "unsupported");
  assert.equal(states.get(realpathSync(newer)).reason, "newer-format");
  assert.equal(states.get(realpathSync(semantic)).state, "pending");
  assert.equal(states.get(realpathSync(semantic)).reason, "semantic-first");
  assert.equal(result.envelope.data.worktrees.some((item) => item.commit_id), false);
  for (const [path, original] of before) assert.deepEqual(snapshot(path), original);
});

for (const stage of [
  "after-first-preview",
  "after-preview",
  "after-object-write",
  "after-temporary-index",
  "after-prepared-tree",
  "after-commit-object",
  "after-commit-inspection",
  "after-prepare",
  "after-worktree-write",
  "after-index-write",
  "after-final-gate",
  "before-cas",
  "cas-rejected",
]) {
  test(`failure at ${stage} proves exact worktree, index, and HEAD invariance`, () => {
    const holder = mkdtempSync(join(tmpdir(), `vibehub-upgrade-${stage}-`));
    const repo = initializeLegacyRepo(join(holder, "scan", "project"));
    const before = snapshot(repo);
    const result = invokeUpgrade(packagedBin(join(holder, "runtime")), [join(holder, "scan")], {
      VIBEHUB_UPGRADE_FAIL_AT: stage,
    });
    assert.equal(result.status, 0, result.stderr);
    const worktree = result.envelope.data.worktrees[0];
    assert.equal(worktree.state, "pending");
    assert.equal(worktree.reason, stage === "cas-rejected" ? "git_failed" : "injected_failure");
    assert.deepEqual(snapshot(repo), before);
    if (stage === "after-index-write") {
      const retry = invokeUpgrade(packagedBin(join(holder, "retry-runtime")), [join(holder, "scan")]);
      assert.equal(retry.status, 0, retry.stderr);
      const retriedWorktree = retry.envelope.data.worktrees[0];
      assert.equal(retriedWorktree.state, "migrated");
      assert.equal(retriedWorktree.old_head, before.head);
      const index = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "index").trim();
      assert.equal(existsSync(`${index}.lock`), false);
    }
  });
}

test("a reporting failure after successful CAS cannot relabel or roll back migration", () => {
  const holder = mkdtempSync(join(tmpdir(), "vibehub-upgrade-after-cas-"));
  const repo = initializeLegacyRepo(join(holder, "scan", "project"));
  const before = snapshot(repo);
  const result = invokeUpgrade(packagedBin(join(holder, "runtime")), [join(holder, "scan")], {
    VIBEHUB_UPGRADE_FAIL_AT: "after-cas",
  });
  assert.equal(result.status, 0, result.stderr);
  const worktree = result.envelope.data.worktrees[0];
  assert.equal(worktree.state, "migrated");
  assert.equal(worktree.commit_id, git(repo, "rev-parse", "HEAD").trim());
  assert.notEqual(worktree.commit_id, before.head);
  assert.equal(git(repo, "status", "--porcelain=v1", "--untracked-files=all"), "");
});

for (const stage of [
  "after-root-normalization",
  "after-candidate-discovery",
  "after-repository-resolution",
  "after-worktree-enumeration",
  "after-discovery",
]) {
  test(`failure at discovery boundary ${stage} is fatal before every project write`, () => {
    const holder = mkdtempSync(join(tmpdir(), `vibehub-upgrade-${stage}-`));
    const repo = initializeLegacyRepo(join(holder, "scan", "project"));
    const before = snapshot(repo);
    const result = invokeUpgrade(packagedBin(join(holder, "runtime")), [join(holder, "scan")], {
      VIBEHUB_UPGRADE_FAIL_AT: stage,
    });
    assert.equal(result.status, 1);
    assert.equal(result.envelope.error.code, "injected_failure");
    if (stage === "after-root-normalization") {
      const prefix = "VibeHub release identity ";
      const lines = result.stderr.trim().split("\n");
      assert.equal(lines.length, 1);
      assert.equal(lines[0].startsWith(prefix), true);
      const printed = JSON.parse(lines[0].slice(prefix.length));
      assert.equal(printed.tag, RELEASE_TAG);
      assert.equal(printed.commit, RELEASE_COMMIT);
      assert.match(printed.engine_sha256, /^[0-9a-f]{64}$/u);
      assert.match(printed.migrations_sha256, /^[0-9a-f]{64}$/u);
      assert.equal(Object.keys(printed.contract_sha256).length, 11);
    }
    assert.deepEqual(snapshot(repo), before);
  });
}

for (const stage of [
  "after-reachability-preflight",
  "after-marker-preflight",
  "after-branch-preflight",
  "after-operation-preflight",
  "after-clean-preflight",
  "after-compatibility-preflight",
]) {
  test(`failure at preflight boundary ${stage} is fatal before every project write`, () => {
    const holder = mkdtempSync(join(tmpdir(), `vibehub-upgrade-${stage}-`));
    const repo = initializeLegacyRepo(join(holder, "scan", "project"));
    const before = snapshot(repo);
    const result = invokeUpgrade(packagedBin(join(holder, "runtime")), [join(holder, "scan")], {
      VIBEHUB_UPGRADE_FAIL_AT: stage,
    });
    assert.equal(result.status, 1);
    assert.equal(result.envelope.error.code, "injected_failure");
    assert.deepEqual(snapshot(repo), before);
  });
}

test("unprovable restoration aborts the command and does not continue writes", () => {
  const holder = mkdtempSync(join(tmpdir(), "vibehub-upgrade-recovery-failed-"));
  const scanRoot = join(holder, "scan");
  const firstRepo = initializeLegacyRepo(join(scanRoot, "a-project"));
  const secondRepo = initializeLegacyRepo(join(scanRoot, "z-project"));
  const secondBefore = snapshot(secondRepo);
  const result = invokeUpgrade(packagedBin(join(holder, "runtime")), [scanRoot], {
    VIBEHUB_UPGRADE_FAIL_AT: "after-worktree-write",
    VIBEHUB_UPGRADE_FAIL_RECOVERY: "1",
  });
  assert.equal(result.status, 1);
  assert.equal(result.envelope.error.code, "recovery_failed");
  assert.deepEqual(snapshot(secondRepo), secondBefore);
  assert.equal(git(firstRepo, "rev-parse", "HEAD").trim().length, 40);
});

test("the implemented boundary and release documentation preserve the narrow exception", () => {
  const proposal = readFileSync(join(root, "docs", "proposals", "cross-project-upgrade-surface.md"), "utf8");
  const quoted = proposal.split("with exactly:\n\n", 2)[1].split("\n\n### Mechanical assertions", 1)[0]
    .split("\n")
    .map((line) => line === ">" ? "" : line.replace(/^> ?/u, ""))
    .join("\n");
  assert.equal(readFileSync(join(root, "skills", "vibehub-setup", "references", "architecture-boundary.md"), "utf8").trim(), quoted.trim());

  const install = readFileSync(join(root, "docs", "INSTALL.md"), "utf8");
  assert.match(install, /tree\/<release-tag>/u);
  assert.match(install, /releases\/download\/<release-tag>\/vibehub-upgrade\.tgz/u);
  assert.match(install, /Nothing is pushed/u);
  const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /build-upgrade-package\.mjs --out dist --tag "\$GITHUB_REF_NAME" --commit "\$GITHUB_SHA"/u);
  assert.match(workflow, /vibehub-upgrade\.tgz\.sha256/u);
  const coordinator = readFileSync(join(root, "scripts", "vibehub-upgrade.mjs"), "utf8");
  assert.doesNotMatch(coordinator, /\["(?:push|fetch|pull|stash|reset|checkout|clean|commit)"/u);
  for (const entry of readdirSync(join(root, "skills"), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("vibehub-")) continue;
    const skill = readFileSync(join(root, "skills", entry.name, "SKILL.md"), "utf8");
    assert.doesNotMatch(skill, /vibehub-upgrade(?:\.mjs|\.tgz| --root)/u, `${entry.name} must not invoke the one-shot entry`);
  }
  const migrate = readFileSync(join(root, "skills", "vibehub-migrate", "SKILL.md"), "utf8");
  assert.match(migrate, /tell the user the\s+40-hex local migration commit for this worktree/u);
  assert.match(migrate, /do not infer a commit from branch position/u);
});
