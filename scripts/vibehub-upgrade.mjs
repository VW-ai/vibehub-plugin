#!/usr/bin/env node
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const COMMIT = /^[0-9a-f]{40}$/u;
const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const packagedRoot = resolve(scriptDir, "..");
const sourceRoot = resolve(scriptDir, "..");
const packagedEngine = join(packagedRoot, "vibehub-core", "scripts", "vh.mjs");
const sourceEngine = join(sourceRoot, "skills", "vibehub-core", "scripts", "vh.mjs");
const enginePath = existsSync(packagedEngine) ? packagedEngine : sourceEngine;
const packagedMigrations = join(packagedRoot, "vibehub-migrate", "references", "migrations.json");
const sourceMigrations = join(sourceRoot, "skills", "vibehub-migrate", "references", "migrations.json");
const migrationsPath = existsSync(packagedMigrations) ? packagedMigrations : sourceMigrations;
const packagedVersions = join(packagedRoot, "vibehub-core", "contracts", "versions.json");
const identityPath = join(packagedRoot, "release-identity.json");
const packagePath = join(packagedRoot, "package.json");

export const UPGRADE_CONTRACT_PATHS = [
  "vibehub-core/contracts/acceptance-authority.md",
  "vibehub-core/contracts/context.schema.json",
  "vibehub-core/contracts/dependency-hygiene.json",
  "vibehub-core/contracts/evidence.schema.json",
  "vibehub-core/contracts/outcome.schema.json",
  "vibehub-core/contracts/project-format.schema.json",
  "vibehub-core/contracts/revision-identity.md",
  "vibehub-core/contracts/room.schema.json",
  "vibehub-core/contracts/ticket-next-action.md",
  "vibehub-core/contracts/ticket.schema.json",
  "vibehub-core/contracts/versions.json",
];

class UpgradeError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function fileDigest(path) {
  return sha256(readFileSync(path));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function text(buffer) {
  return Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer ?? "");
}

function git(repo, args, options = {}) {
  const result = run("git", ["-c", "core.fsmonitor=false", "-C", repo, ...args], {
    ...options,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...(options.env ?? {}) },
  });
  if (result.status !== 0) {
    throw new UpgradeError(
      "git_failed",
      `git ${args[0]} failed in ${repo}: ${text(result.stderr).trim() || text(result.stdout).trim()}`,
      { command: ["git", "-c", "core.fsmonitor=false", "-C", repo, ...args], status: result.status },
    );
  }
  return result.stdout;
}

function engine(repo, operation) {
  const result = run(process.execPath, [enginePath, "project", operation, "--repo", repo]);
  let envelope;
  try {
    envelope = JSON.parse(text(result.stdout));
  } catch {
    throw new UpgradeError("engine_failed", text(result.stderr).trim() || "VibeHub engine returned invalid output");
  }
  if (result.status !== 0 || !envelope.ok) {
    throw new UpgradeError(
      envelope.error?.code ?? "engine_failed",
      envelope.error?.message ?? "VibeHub engine failed",
      envelope.error?.details ?? null,
    );
  }
  return envelope.data;
}

function parseArgs(argv) {
  const roots = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--root" || !argv[index + 1]) {
      throw new UpgradeError(
        "invalid_argument",
        "Usage: vibehub-upgrade --root <bounded-root> [--root <another-root>]",
      );
    }
    roots.push(argv[++index]);
  }
  if (roots.length === 0) {
    throw new UpgradeError("missing_root", "At least one explicit --root is required; no discovery ran.");
  }
  return roots;
}

function releaseIdentity() {
  if (!existsSync(identityPath) || !existsSync(packagePath) || !existsSync(packagedVersions)) {
    throw new UpgradeError(
      "unpackaged_entry",
      "vibehub-upgrade must run from its versioned GitHub Release package.",
    );
  }
  const identity = JSON.parse(readFileSync(identityPath, "utf8"));
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const versions = JSON.parse(readFileSync(packagedVersions, "utf8"));
  const migrations = JSON.parse(readFileSync(migrationsPath, "utf8"));
  const errors = [];
  if (identity.version !== packageJson.version) errors.push("package version");
  if (identity.tag !== `v${packageJson.version}`) errors.push("release tag");
  if (!COMMIT.test(identity.commit ?? "")) errors.push("release commit");
  if (identity.coordinator_sha256 !== fileDigest(scriptPath)) errors.push("coordinator digest");
  if (identity.engine_sha256 !== fileDigest(enginePath)) errors.push("engine digest");
  if (identity.migrations_sha256 !== fileDigest(migrationsPath)) errors.push("migration registry digest");
  const manifestPaths = Object.keys(identity.contract_sha256 ?? {}).sort();
  if (JSON.stringify(manifestPaths) !== JSON.stringify([...UPGRADE_CONTRACT_PATHS].sort())) {
    errors.push("contract manifest");
  }
  for (const path of UPGRADE_CONTRACT_PATHS) {
    const digest = identity.contract_sha256?.[path];
    if (!existsSync(join(packagedRoot, path)) || fileDigest(join(packagedRoot, path)) !== digest) {
      errors.push(`contract digest ${path}`);
    }
  }
  if (identity.project_format !== versions.project_format
    || identity.project_format !== migrations.current_format) errors.push("project format");
  if (errors.length > 0) {
    throw new UpgradeError("release_identity_mismatch", `Release package identity mismatch: ${errors.join(", ")}`);
  }
  return identity;
}

function normalizeRoots(values) {
  const roots = [];
  for (const value of values) {
    const absolute = resolve(value);
    if (!existsSync(absolute)) throw new UpgradeError("root_missing", `Discovery root does not exist: ${absolute}`);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new UpgradeError("root_not_directory", `Discovery root must be a real directory, not a symlink: ${absolute}`);
    }
    accessSync(absolute, constants.R_OK);
    roots.push(realpathSync(absolute));
  }
  return [...new Set(roots)].sort();
}

function discoverCandidates(roots) {
  const candidates = new Set();
  for (const root of roots) {
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop();
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      const marker = entries.find((entry) => entry.name === ".vibehub");
      if (marker?.isDirectory() && !marker.isSymbolicLink()) candidates.add(current);
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === ".vibehub" || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        pending.push(join(current, entry.name));
      }
    }
  }
  maybeFail("after-candidate-discovery");
  return [...candidates].sort();
}

function repositoryFor(candidate) {
  try {
    const top = text(git(candidate, ["rev-parse", "--show-toplevel"])).trim();
    const commonRaw = text(git(candidate, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    return { top: realpathSync(top), common: realpathSync(commonRaw) };
  } catch {
    return null;
  }
}

function parseWorktrees(source) {
  const records = [];
  let current = null;
  for (const line of source.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), prunable: false, detached: false };
      records.push(current);
    } else if (!current || !line) continue;
    else if (line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (line.startsWith("branch ")) current.branch = line.slice(7);
    else if (line === "detached") current.detached = true;
    else if (line.startsWith("prunable")) current.prunable = true;
    else if (line.startsWith("locked")) current.locked = true;
  }
  return records;
}

function discoverRepositories(roots) {
  const repositories = new Map();
  for (const candidate of discoverCandidates(roots)) {
    const repository = repositoryFor(candidate);
    maybeFail("after-repository-resolution");
    if (!repository || repositories.has(repository.common)) continue;
    const worktrees = parseWorktrees(text(git(repository.top, ["worktree", "list", "--porcelain"]))).map((item) => ({
      ...item,
      path: resolve(item.path),
    }));
    maybeFail("after-worktree-enumeration");
    repositories.set(repository.common, { ...repository, worktrees });
  }
  return [...repositories.values()].sort((a, b) => a.common.localeCompare(b.common));
}

function gitPath(repo, name) {
  const value = text(git(repo, ["rev-parse", "--git-path", name])).trim();
  return resolve(repo, value);
}

function statusBytes(repo) {
  return git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
}

function indexPath(repo) {
  return gitPath(repo, "index");
}

function snapshotPath(path) {
  if (!existsSync(path)) return { exists: false };
  const stat = lstatSync(path);
  if (!stat.isFile()) return { exists: true, type: stat.isSymbolicLink() ? "symlink" : "other" };
  return {
    exists: true,
    type: "file",
    mode: stat.mode & 0o111 ? "100755" : "100644",
    bytes: readFileSync(path),
  };
}

function sameSnapshot(left, right) {
  return left.exists === right.exists
    && left.type === right.type
    && left.mode === right.mode
    && (!left.exists || left.type !== "file" || left.bytes.equals(right.bytes));
}

function snapshotFromHead(repo, head, path) {
  const entry = text(git(repo, ["ls-tree", "-z", head, "--", path])).split("\0").filter(Boolean);
  if (entry.length === 0) return { exists: false };
  const match = entry[0].match(/^(\d{6}) (\w+) ([0-9a-f]{40})\t/u);
  if (!match || match[2] !== "blob") return { exists: true, type: match?.[2] ?? "other" };
  return {
    exists: true,
    type: "file",
    mode: match[1],
    bytes: git(repo, ["show", `${head}:${path}`]),
  };
}

function copyForPreview(worktree, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(worktree, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    cpSync(join(worktree, entry.name), join(target, entry.name), {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
  }
}

function previewOnce(worktree) {
  const holder = mkdtempSync(join(tmpdir(), "vibehub-upgrade-preview-"));
  const copy = join(holder, "worktree");
  try {
    copyForPreview(worktree, copy);
    const migration = engine(copy, "migrate-mechanical");
    if (migration.status === "semantic_required") return { migration, files: {} };
    engine(copy, "validate");
    const files = {};
    for (const path of migration.changed_paths ?? []) {
      const absolute = join(copy, ...path.split("/"));
      const snapshot = snapshotPath(absolute);
      if (!snapshot.exists || snapshot.type !== "file") {
        throw new UpgradeError("preview_non_file", `Migration result is not a regular file: ${path}`);
      }
      files[path] = {
        mode: snapshot.mode,
        digest: sha256(snapshot.bytes),
        bytes: snapshot.bytes.toString("base64"),
      };
    }
    return { migration, files };
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
}

function preview(worktree) {
  const first = previewOnce(worktree);
  maybeFail("after-first-preview");
  const second = previewOnce(worktree);
  if (JSON.stringify(stable(first)) !== JSON.stringify(stable(second))) {
    throw new UpgradeError("nondeterministic_preview", "Two mechanical migration previews produced different results.");
  }
  return second;
}

function operationInProgress(repo) {
  for (const name of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]) {
    if (existsSync(gitPath(repo, name))) return name;
  }
  return null;
}

function baseResult(repository, worktree) {
  return {
    repository: repository.common,
    path: worktree.path,
    branch: worktree.branch ?? null,
    old_head: worktree.head ?? null,
    new_head: worktree.head ?? null,
    format: null,
    state: "pending",
    reason: null,
    diagnostic: null,
    migration_ids: [],
    commit_id: null,
    semantic_pending_refs: [],
  };
}

function pending(result, reason, diagnostic = null) {
  return { ...result, state: "pending", reason, diagnostic };
}

function maybeFail(stage) {
  if (process.env.VIBEHUB_UPGRADE_FAIL_AT === stage) {
    throw new UpgradeError("injected_failure", `Injected failure at ${stage}`);
  }
}

function prepareCommit(repo, baseline, previewResult) {
  const holder = mkdtempSync(join(tmpdir(), "vibehub-upgrade-commit-"));
  const temporaryIndex = join(holder, "index");
  const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
  try {
  git(repo, ["read-tree", baseline], { env });
  for (const [path, result] of Object.entries(previewResult.files)) {
    const bytes = Buffer.from(result.bytes, "base64");
    const object = text(git(repo, ["hash-object", "-w", "--stdin"], { input: bytes })).trim();
    maybeFail("after-object-write");
    git(repo, ["update-index", "--add", "--cacheinfo", `${result.mode},${object},${path}`], { env });
  }
  maybeFail("after-temporary-index");
  const tree = text(git(repo, ["write-tree"], { env })).trim();
  maybeFail("after-prepared-tree");
  const now = new Date().toISOString();
  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "VibeHub Upgrade",
    GIT_AUTHOR_EMAIL: "upgrade@vibehub.local",
    GIT_COMMITTER_NAME: "VibeHub Upgrade",
    GIT_COMMITTER_EMAIL: "upgrade@vibehub.local",
    GIT_AUTHOR_DATE: now,
    GIT_COMMITTER_DATE: now,
  };
  const commit = text(git(repo, ["commit-tree", tree, "-p", baseline], {
    env: commitEnv,
    input: Buffer.from("Migrate VibeHub project data\n"),
  })).trim();
  maybeFail("after-commit-object");
  const parents = text(git(repo, ["show", "-s", "--format=%P", commit])).trim();
  const commitTree = text(git(repo, ["show", "-s", "--format=%T", commit])).trim();
  const paths = text(git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit]))
    .split("\0").filter(Boolean).sort();
  const expected = Object.keys(previewResult.files).sort();
  if (parents !== baseline || commitTree !== tree || JSON.stringify(paths) !== JSON.stringify(expected)) {
    rmSync(holder, { recursive: true, force: true });
    throw new UpgradeError("prepared_commit_mismatch", "Prepared commit does not match the verified preview.");
  }
  for (const [path, result] of Object.entries(previewResult.files)) {
    const blob = git(repo, ["show", `${commit}:${path}`]);
    if (sha256(blob) !== result.digest) {
      rmSync(holder, { recursive: true, force: true });
      throw new UpgradeError("prepared_blob_mismatch", `Prepared blob does not match preview: ${path}`);
    }
  }
  maybeFail("after-commit-inspection");
  return { holder, temporaryIndex, tree, commit };
  } catch (error) {
    rmSync(holder, { recursive: true, force: true });
    throw error;
  }
}

function atomicWrite(path, bytes, mode = null) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.vibehub-upgrade-${process.pid}`;
  writeFileSync(temporary, bytes, { flag: "wx", mode: mode === "100755" ? 0o755 : 0o644 });
  renameSync(temporary, path);
}

function restore(repo, originals, originalIndex, realIndex, indexLock, baseline, branch) {
  try {
    if (process.env.VIBEHUB_UPGRADE_FAIL_RECOVERY === "1") {
      throw new Error("Injected restoration failure");
    }
    const branchBefore = text(git(repo, ["symbolic-ref", "-q", "HEAD"])).trim();
    const headBefore = text(git(repo, ["rev-parse", "HEAD"])).trim();
    if (branchBefore !== branch || headBefore !== baseline) {
      throw new Error("branch or HEAD changed before restoration");
    }
    for (const [path, snapshot] of [...originals].reverse()) {
      if (!snapshot.exists) {
        if (existsSync(path)) unlinkSync(path);
      } else if (snapshot.type === "file") atomicWrite(path, snapshot.bytes, snapshot.mode);
      else throw new Error(`cannot restore non-file ${path}`);
    }
    atomicWrite(realIndex, originalIndex);
    if (existsSync(indexLock)) unlinkSync(indexLock);
    const head = text(git(repo, ["rev-parse", "HEAD"])).trim();
    const restoredBranch = text(git(repo, ["symbolic-ref", "-q", "HEAD"])).trim();
    const status = statusBytes(repo);
    if (head !== baseline || restoredBranch !== branch || status.length !== 0 || !readFileSync(realIndex).equals(originalIndex)) {
      throw new Error("baseline proof failed after restoration");
    }
    for (const [path, snapshot] of originals) {
      if (!sameSnapshot(snapshotPath(path), snapshot)) throw new Error(`byte restoration failed for ${path}`);
    }
  } catch (error) {
    throw new UpgradeError("recovery_failed", error instanceof Error ? error.message : String(error));
  }
}

function installAndCommit(repo, branch, baseline, previewResult, baselineIndex) {
  const changed = Object.keys(previewResult.files).sort();
  const originals = changed.map((path) => [join(repo, ...path.split("/")), snapshotPath(join(repo, ...path.split("/")))]);
  const realIndex = indexPath(repo);
  const originalIndex = readFileSync(realIndex);
  if (!originalIndex.equals(baselineIndex)) {
    throw new UpgradeError("concurrent_change", "Real index changed during preview.");
  }
  for (const path of changed) {
    if (!sameSnapshot(snapshotPath(join(repo, ...path.split("/"))), snapshotFromHead(repo, baseline, path))) {
      throw new UpgradeError("concurrent_change", `Declared path changed from baseline during preview: ${path}`);
    }
  }
  const prepared = prepareCommit(repo, baseline, previewResult);
  const indexLock = `${realIndex}.lock`;
  let materialized = false;
  try {
    maybeFail("after-prepare");
    const currentHead = text(git(repo, ["rev-parse", "HEAD"])).trim();
    const currentBranch = text(git(repo, ["symbolic-ref", "-q", "HEAD"])).trim();
    if (currentHead !== baseline || currentBranch !== branch
      || statusBytes(repo).length !== 0 || !readFileSync(realIndex).equals(originalIndex)) {
      throw new UpgradeError("concurrent_change", "Branch, HEAD, status, or index changed before materialization.");
    }
    const lockFd = openSync(indexLock, "wx");
    closeSync(lockFd);
    for (const [path, result] of Object.entries(previewResult.files)) {
      atomicWrite(join(repo, ...path.split("/")), Buffer.from(result.bytes, "base64"), result.mode);
    }
    materialized = true;
    maybeFail("after-worktree-write");
    atomicWrite(realIndex, readFileSync(prepared.temporaryIndex));
    maybeFail("after-index-write");

    const finalHead = text(git(repo, ["rev-parse", "HEAD"])).trim();
    const finalBranch = text(git(repo, ["symbolic-ref", "-q", "HEAD"])).trim();
    if (finalHead !== baseline || finalBranch !== branch) throw new UpgradeError("concurrent_change", "Branch or HEAD changed before CAS.");
    for (const [path, result] of Object.entries(previewResult.files)) {
      const actual = snapshotPath(join(repo, ...path.split("/")));
      const expected = { exists: true, type: "file", mode: result.mode, bytes: Buffer.from(result.bytes, "base64") };
      if (!sameSnapshot(actual, expected)) throw new UpgradeError("materialization_mismatch", `Materialized bytes differ: ${path}`);
    }
    const verificationIndex = join(prepared.holder, "verification-index");
    const realIndexBytes = readFileSync(realIndex);
    const preparedIndexBytes = readFileSync(prepared.temporaryIndex);
    writeFileSync(verificationIndex, realIndexBytes, { flag: "wx" });
    const actualTree = text(git(repo, ["write-tree"], {
      env: { GIT_INDEX_FILE: verificationIndex },
    })).trim();
    const staged = text(git(repo, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean).sort();
    const unstaged = text(git(repo, ["diff", "--name-only", "-z"])).split("\0").filter(Boolean);
    const porcelain = text(statusBytes(repo)).split("\0").filter(Boolean);
    if (!realIndexBytes.equals(preparedIndexBytes)
      || actualTree !== prepared.tree
      || JSON.stringify(staged) !== JSON.stringify(changed)
      || unstaged.length !== 0
      || porcelain.length !== changed.length
      || porcelain.some((entry) => entry[1] !== " " || !changed.includes(entry.slice(3)))) {
      throw new UpgradeError("final_gate_mismatch", "Real worktree/index/status does not equal the prepared commit.");
    }
    maybeFail("after-final-gate");
    maybeFail("before-cas");
    const hooks = mkdtempSync(join(tmpdir(), "vibehub-upgrade-empty-hooks-"));
    try {
      unlinkSync(indexLock);
      const expectedOld = process.env.VIBEHUB_UPGRADE_FAIL_AT === "cas-rejected"
        ? "0000000000000000000000000000000000000000"
        : baseline;
      git(repo, ["-c", `core.hooksPath=${hooks}`, "update-ref", branch, prepared.commit, expectedOld]);
      try {
        maybeFail("after-cas");
      } catch {
        // Simulated output/read failure: successful CAS remains migrated.
      }
    } finally {
      try {
        rmSync(hooks, { recursive: true, force: true });
      } catch {
        // Disposable temp cleanup is not project state and cannot move a ref
        // back or relabel a successful terminal CAS.
      }
    }
    return prepared.commit;
  } catch (error) {
    if (materialized || !readFileSync(realIndex).equals(originalIndex)) {
      restore(repo, originals, originalIndex, realIndex, indexLock, baseline, branch);
    } else if (existsSync(indexLock)) unlinkSync(indexLock);
    throw error;
  } finally {
    rmSync(prepared.holder, { recursive: true, force: true });
  }
}

function processWorktree(repository, worktree) {
  let result = baseResult(repository, worktree);
  if (worktree.prunable || !existsSync(worktree.path)) return pending(result, worktree.prunable ? "prunable" : "missing");
  let canonical;
  try {
    canonical = realpathSync(worktree.path);
    result.path = canonical;
    accessSync(canonical, constants.R_OK | constants.W_OK);
    accessSync(repository.common, constants.R_OK | constants.W_OK);
    const admin = text(git(canonical, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"])).trim();
    accessSync(realpathSync(admin), constants.R_OK | constants.W_OK);
  } catch (error) {
    return pending(result, "unreachable-or-unwritable", error instanceof Error ? error.message : String(error));
  }
  maybeFail("after-reachability-preflight");
  const marker = join(canonical, ".vibehub");
  if (!existsSync(marker) || !lstatSync(marker).isDirectory() || lstatSync(marker).isSymbolicLink()) {
    return { ...result, state: "unaffected", reason: "no-vibehub-data" };
  }
  maybeFail("after-marker-preflight");
  if (worktree.detached || !worktree.branch || !COMMIT.test(worktree.head ?? "")) {
    return pending(result, "detached-or-unborn");
  }
  try {
    const actualBranch = text(git(canonical, ["symbolic-ref", "-q", "HEAD"])).trim();
    const actualHead = text(git(canonical, ["rev-parse", "HEAD"])).trim();
    if (actualBranch !== worktree.branch || actualHead !== worktree.head) return pending(result, "concurrent-change");
  } catch (error) {
    return pending(result, "detached-or-unborn", error instanceof Error ? error.message : String(error));
  }
  maybeFail("after-branch-preflight");
  let operation;
  try {
    operation = operationInProgress(canonical);
  } catch (error) {
    return pending(result, "git-administration-unreadable", error instanceof Error ? error.message : String(error));
  }
  if (operation) return pending(result, "git-operation-in-progress", operation);
  maybeFail("after-operation-preflight");
  if (statusBytes(canonical).length !== 0) return pending(result, "dirty-worktree");
  let baselineIndex;
  try {
    baselineIndex = readFileSync(indexPath(canonical));
  } catch (error) {
    return pending(result, "git-administration-unreadable", error instanceof Error ? error.message : String(error));
  }
  maybeFail("after-clean-preflight");

  let compatibility;
  try {
    compatibility = engine(canonical, "compatibility");
    result.format = compatibility.detected_format;
  } catch (error) {
    return { ...result, state: "unsupported", reason: error.code ?? "malformed-project", diagnostic: error.message };
  }
  maybeFail("after-compatibility-preflight");
  if (compatibility.state === "UNSUPPORTED_NEWER") {
    return { ...result, state: "unsupported", reason: "newer-format", diagnostic: compatibility.reason };
  }
  if (compatibility.detected_format === "uninitialized") {
    return { ...result, state: "unaffected", reason: "uninitialized" };
  }
  if (compatibility.state === "CURRENT") {
    try {
      engine(canonical, "validate");
      const current = engine(canonical, "migrate-mechanical");
      return {
        ...result,
        state: "current",
        reason: current.status,
        semantic_pending_refs: current.pending_semantic_refs ?? [],
      };
    } catch (error) {
      return { ...result, state: "unsupported", reason: error.code ?? "malformed-project", diagnostic: error.message };
    }
  }

  let previewResult;
  try {
    previewResult = preview(canonical);
    maybeFail("after-preview");
  } catch (error) {
    return pending(result, error.code ?? "preview-failed", error.message);
  }
  result.migration_ids = previewResult.migration.applied_migrations ?? [];
  result.semantic_pending_refs = previewResult.migration.pending_semantic_refs ?? [];
  if (previewResult.migration.status === "semantic_required") {
    return pending(result, "semantic-first", previewResult.migration.reason);
  }
  if (Object.keys(previewResult.files).length === 0) return pending(result, "empty-migration-result");
  if (text(git(canonical, ["rev-parse", "HEAD"])).trim() !== worktree.head || statusBytes(canonical).length !== 0) {
    return pending(result, "concurrent-change");
  }
  try {
    const commit = installAndCommit(canonical, worktree.branch, worktree.head, previewResult, baselineIndex);
    return { ...result, state: "migrated", reason: null, new_head: commit, commit_id: commit };
  } catch (error) {
    if (error.code === "recovery_failed") throw error;
    return pending(result, error.code ?? "migration-failed", error.message);
  }
}

function renderIdentity(identity) {
  return `VibeHub release identity ${JSON.stringify(stable(identity))}`;
}

function renderHuman(roots, results) {
  const lines = [
    `Roots: ${roots.join(", ")}`,
  ];
  for (const result of results) {
    const suffix = result.commit_id ? ` commit=${result.commit_id}` : result.reason ? ` reason=${result.reason}` : "";
    lines.push(`${result.state.padEnd(11)} ${result.path}${suffix}`);
  }
  return lines.join("\n");
}

function executeVerifiedUpgrade(rootValues, identity) {
  const roots = normalizeRoots(rootValues);
  maybeFail("after-root-normalization");
  const repositories = discoverRepositories(roots);
  maybeFail("after-discovery");
  const results = [];
  for (const repository of repositories) {
    for (const worktree of repository.worktrees) results.push(processWorktree(repository, worktree));
  }
  return { identity, roots, repositories: repositories.length, worktrees: results };
}

export function executeUpgrade(rootValues) {
  return executeVerifiedUpgrade(rootValues, releaseIdentity());
}

function main() {
  try {
    const roots = parseArgs(process.argv.slice(2));
    const identity = releaseIdentity();
    process.stderr.write(`${renderIdentity(identity)}\n`);
    const report = executeVerifiedUpgrade(roots, identity);
    process.stderr.write(`${renderHuman(report.roots, report.worktrees)}\n`);
    process.stdout.write(`${JSON.stringify({ ok: true, data: report })}\n`);
  } catch (error) {
    const normalized = error instanceof UpgradeError
      ? error
      : new UpgradeError("internal_error", error instanceof Error ? error.message : String(error));
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: { code: normalized.code, message: normalized.message, details: normalized.details },
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(scriptPath)) main();
