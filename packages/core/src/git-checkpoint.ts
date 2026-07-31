import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface GitCheckpointInspection {
  digest: string;
  sourceIdentity?: string;
}

export interface GitCheckpointScope {
  label: string;
  relativeRoot: string;
  commitSubject: string;
  reflogMessage: string;
  digestTrailer: string;
  inspectWorktree(repoRoot: string): GitCheckpointInspection;
  inspectCommit(repoRoot: string, commitSha: string): GitCheckpointInspection;
}

export interface GitCheckpointReceipt {
  schemaVersion: 1;
  branch: string;
  headSha: string;
  digest: string;
  sourceIdentity?: string;
  changedPaths: string[];
}

export interface GitCheckpointResult {
  status: "committed" | "noop";
  branch: string;
  beforeHeadSha: string;
  commitSha: string;
  digest: string;
  changedPaths: string[];
}

export interface PrepareGitCheckpointOptions {
  repoRoot: string;
  scope: GitCheckpointScope;
  protectedBranches?: readonly string[];
  expectedHeadSha?: string;
  expectedDigest?: string;
  expectedSourceIdentity?: string;
  expectedChangedPaths?: readonly string[];
}

export interface CommitGitCheckpointOptions
  extends PrepareGitCheckpointOptions {
  receipt: GitCheckpointReceipt;
  actor: string;
  taskId?: string;
  requestId: string;
  now: string;
}

const runGit = (
  repoRoot: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
): string => execFileSync("git", [...args], {
  cwd: repoRoot,
  encoding: "utf8",
  env: {
    ...process.env,
    ...options.env,
  },
  ...(options.input === undefined ? {} : { input: options.input }),
});

const checkpointValue = (
  scope: GitCheckpointScope,
  value: string | undefined,
  field: string,
): string => {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || /[\0\r\n]/u.test(value)
  ) {
    throw new Error(
      `${scope.label}: ${field} must be a nonblank single-line string`,
    );
  }
  return value.trim();
};

const validateScope = (scope: GitCheckpointScope): void => {
  checkpointValue(scope, scope.label, "label");
  checkpointValue(scope, scope.commitSubject, "commitSubject");
  checkpointValue(scope, scope.reflogMessage, "reflogMessage");
  checkpointValue(scope, scope.digestTrailer, "digestTrailer");
  if (
    scope.relativeRoot.length === 0
    || path.posix.normalize(scope.relativeRoot) !== scope.relativeRoot
    || scope.relativeRoot.startsWith("/")
    || scope.relativeRoot.includes("\\")
    || scope.relativeRoot.split("/").includes("..")
  ) {
    throw new Error(`${scope.label}: invalid repository-relative checkpoint root`);
  }
};

const resolveCommit = (repoRoot: string, ref: string, label: string): string => {
  const commit = runGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]).trim();
  if (!COMMIT_ID.test(commit)) {
    throw new Error(`${label}: Git returned an invalid commit for ${ref}`);
  }
  return commit;
};

const currentBranch = (repoRoot: string, label: string): string => {
  let branch: string;
  try {
    branch = runGit(
      repoRoot,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
    ).trim();
  } catch {
    throw new Error(`${label}: detached HEAD is not committable`);
  }
  if (!branch || /[\0\r\n]/u.test(branch)) {
    throw new Error(`${label}: invalid current branch`);
  }
  return branch;
};

const protectedBranches = (
  repoRoot: string,
  additional: readonly string[],
): Set<string> => {
  const result = new Set(["main", "master", ...additional]);
  try {
    const remoteHead = runGit(repoRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]).trim().replace(/^origin\//u, "");
    if (remoteHead) result.add(remoteHead);
  } catch {
    // main/master remain protected in repositories without origin/HEAD.
  }
  return result;
};

const isWithinRoot = (relativePath: string, relativeRoot: string): boolean =>
  relativePath === relativeRoot
  || relativePath.startsWith(`${relativeRoot}/`);

const normalizeChangedPaths = (
  paths: readonly string[],
  scope: GitCheckpointScope,
): string[] => {
  const result = paths.map((relativePath) => {
    if (
      typeof relativePath !== "string"
      || relativePath.length === 0
      || relativePath.includes("\0")
      || relativePath.includes("\\")
      || path.posix.normalize(relativePath) !== relativePath
      || relativePath.startsWith("/")
      || !isWithinRoot(relativePath, scope.relativeRoot)
    ) {
      throw new Error(
        `${scope.label}: path escaped checkpoint root: ${String(relativePath)}`,
      );
    }
    return relativePath;
  });
  return [...new Set(result)].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
};

const statusPaths = (
  repoRoot: string,
  scope: GitCheckpointScope,
): { changedPaths: string[]; unmergedPaths: string[] } => {
  const output = runGit(repoRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=all",
    "--no-renames",
    "--",
    `:(top,literal)${scope.relativeRoot}`,
  ]);
  const changedPaths: string[] = [];
  const unmergedPaths: string[] = [];
  for (const record of output.split("\0").filter(Boolean)) {
    if (record.length < 4 || record[2] !== " ") {
      throw new Error(`${scope.label}: malformed Git status record`);
    }
    const status = record.slice(0, 2);
    const relativePath = record.slice(3);
    if (!isWithinRoot(relativePath, scope.relativeRoot)) {
      throw new Error(
        `${scope.label}: path escaped checkpoint root: ${relativePath}`,
      );
    }
    changedPaths.push(relativePath);
    if (
      status.includes("U")
      || ["AA", "DD", "AU", "UA", "DU", "UD"].includes(status)
    ) {
      unmergedPaths.push(relativePath);
    }
  }
  return {
    changedPaths: normalizeChangedPaths(changedPaths, scope),
    unmergedPaths: normalizeChangedPaths(unmergedPaths, scope),
  };
};

const sameStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length
  && left.every((value, index) => value === right[index]);

const sameReceipt = (
  expected: GitCheckpointReceipt,
  actual: GitCheckpointReceipt,
): boolean =>
  expected.schemaVersion === 1
  && expected.branch === actual.branch
  && expected.headSha === actual.headSha
  && expected.digest === actual.digest
  && expected.sourceIdentity === actual.sourceIdentity
  && sameStrings(expected.changedPaths, actual.changedPaths);

const literalPathspecs = (paths: readonly string[]): string[] =>
  paths.map((relativePath) => `:(top,literal)${relativePath}`);

export function prepareGitCheckpoint(
  options: PrepareGitCheckpointOptions,
): GitCheckpointReceipt {
  validateScope(options.scope);
  const repoRoot = path.resolve(options.repoRoot);
  const branch = currentBranch(repoRoot, options.scope.label);
  if (
    protectedBranches(repoRoot, options.protectedBranches ?? []).has(branch)
  ) {
    throw new Error(
      `${options.scope.label}: protected branch is not committable: ${branch}`,
    );
  }
  const headSha = resolveCommit(repoRoot, "HEAD", options.scope.label);
  if (
    options.expectedHeadSha !== undefined
    && headSha !== options.expectedHeadSha
  ) {
    throw new Error(`${options.scope.label}: expected source commit is stale`);
  }

  const inspection = options.scope.inspectWorktree(repoRoot);
  const digest = checkpointValue(
    options.scope,
    inspection.digest,
    "worktree digest",
  );
  if (
    options.expectedDigest !== undefined
    && digest !== options.expectedDigest
  ) {
    throw new Error(`${options.scope.label}: expected worktree digest is stale`);
  }
  if (
    options.expectedSourceIdentity !== undefined
    && inspection.sourceIdentity !== options.expectedSourceIdentity
  ) {
    throw new Error(`${options.scope.label}: expected worktree source is stale`);
  }

  const status = statusPaths(repoRoot, options.scope);
  if (status.unmergedPaths.length > 0) {
    throw new Error(
      `${options.scope.label}: unresolved conflicts: `
      + status.unmergedPaths.join(", "),
    );
  }
  if (options.expectedChangedPaths !== undefined) {
    const expected = normalizeChangedPaths(
      options.expectedChangedPaths,
      options.scope,
    );
    if (!sameStrings(expected, status.changedPaths)) {
      throw new Error(
        `${options.scope.label}: checkpoint path selection is stale`,
      );
    }
  }

  return {
    schemaVersion: 1,
    branch,
    headSha,
    digest,
    ...(inspection.sourceIdentity === undefined
      ? {}
      : { sourceIdentity: inspection.sourceIdentity }),
    changedPaths: status.changedPaths,
  };
}

export function commitGitCheckpoint(
  options: CommitGitCheckpointOptions,
): GitCheckpointResult {
  const repoRoot = path.resolve(options.repoRoot);
  const actor = checkpointValue(options.scope, options.actor, "actor");
  const requestId = checkpointValue(
    options.scope,
    options.requestId,
    "requestId",
  );
  const now = checkpointValue(options.scope, options.now, "now");
  const taskId = options.taskId === undefined
    ? undefined
    : checkpointValue(options.scope, options.taskId, "taskId");
  const current = prepareGitCheckpoint(options);
  if (!sameReceipt(options.receipt, current)) {
    throw new Error(`${options.scope.label}: receipt is stale`);
  }
  if (current.changedPaths.length === 0) {
    return {
      status: "noop",
      branch: current.branch,
      beforeHeadSha: current.headSha,
      commitSha: current.headSha,
      digest: current.digest,
      changedPaths: [],
    };
  }

  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "vibehub-checkpoint-index-"),
  );
  const indexPath = path.join(temp, "index");
  const indexEnv = { GIT_INDEX_FILE: indexPath };
  try {
    runGit(repoRoot, ["read-tree", current.headSha], { env: indexEnv });
    runGit(
      repoRoot,
      ["add", "-A", "--", ...literalPathspecs(current.changedPaths)],
      { env: indexEnv },
    );
    const tree = runGit(repoRoot, ["write-tree"], { env: indexEnv }).trim();
    const message = [
      options.scope.commitSubject,
      "",
      `VibeHub-Actor: ${actor}`,
      ...(taskId === undefined ? [] : [`VibeHub-Task: ${taskId}`]),
      `VibeHub-Request: ${requestId}`,
      `${options.scope.digestTrailer}: ${current.digest}`,
      `VibeHub-Checkpoint-At: ${now}`,
      "",
    ].join("\n");
    const commitSha = runGit(
      repoRoot,
      ["commit-tree", tree, "-p", current.headSha],
      { env: indexEnv, input: message },
    ).trim();
    if (!COMMIT_ID.test(commitSha)) {
      throw new Error(`${options.scope.label}: Git returned an invalid candidate commit`);
    }

    const candidate = options.scope.inspectCommit(repoRoot, commitSha);
    if (
      candidate.digest !== current.digest
      || candidate.sourceIdentity !== current.sourceIdentity
    ) {
      throw new Error(
        `${options.scope.label}: candidate commit source mismatch`,
      );
    }
    const ready = prepareGitCheckpoint(options);
    if (!sameReceipt(current, ready)) {
      throw new Error(
        `${options.scope.label}: worktree changed during checkpoint`,
      );
    }

    runGit(repoRoot, [
      "update-ref",
      "-m",
      options.scope.reflogMessage,
      `refs/heads/${current.branch}`,
      commitSha,
      current.headSha,
    ]);
    const rollbackAdvance = (): void => {
      runGit(repoRoot, [
        "update-ref",
        "-m",
        `rollback failed ${options.scope.reflogMessage}`,
        `refs/heads/${current.branch}`,
        current.headSha,
        commitSha,
      ]);
    };
    try {
      if (
        currentBranch(repoRoot, options.scope.label) !== current.branch
      ) {
        rollbackAdvance();
        throw new Error(
          `${options.scope.label}: branch changed during checkpoint`,
        );
      }
    } catch (error) {
      if (
        resolveCommit(
          repoRoot,
          `refs/heads/${current.branch}`,
          options.scope.label,
        ) === commitSha
      ) {
        try {
          rollbackAdvance();
        } catch {
          throw new Error(
            `${options.scope.label}: branch changed and ref rollback failed`,
            { cause: error },
          );
        }
      }
      throw error;
    }
    try {
      runGit(repoRoot, [
        "reset",
        "-q",
        "HEAD",
        "--",
        ...literalPathspecs(current.changedPaths),
      ]);
    } catch (error) {
      try {
        rollbackAdvance();
      } catch {
        throw new Error(
          `${options.scope.label}: commit succeeded but index reconciliation `
          + "and rollback failed",
          { cause: error },
        );
      }
      throw error;
    }
    if (
      resolveCommit(repoRoot, "HEAD", options.scope.label) !== commitSha
    ) {
      try {
        rollbackAdvance();
      } catch {
        throw new Error(
          `${options.scope.label}: branch moved after checkpoint and ref rollback failed`,
        );
      }
      throw new Error(`${options.scope.label}: branch changed during checkpoint`);
    }
    return {
      status: "committed",
      branch: current.branch,
      beforeHeadSha: current.headSha,
      commitSha,
      digest: current.digest,
      changedPaths: current.changedPaths,
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
