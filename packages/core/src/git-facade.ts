/**
 * GitFacade — the ONLY place that shells out to `git` / `gh`
 * (decision-project-025 module list; decision-github-002: 团队可见通路 =
 * 纯 git + gh CLI,零服务端).
 *
 * Boundary rules implemented here:
 * - Worktrees resolve to their main repo via `git rev-parse --git-common-dir`
 *   (decision-github-004: N worktrees = 1 repo domain).
 * - `gh` absent or unauthenticated is an explicit degraded tier, not an
 *   error: pure-git facts keep flowing, PR facts come back as null
 *   (decision-github-004).
 * - Zero LLM, zero invention: every return value is a verbatim git/gh fact.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CommitEvent } from "./contract/panel-types.js";

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`);
  }
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runBuffer(
  cmd: string,
  args: string[],
  cwd: string,
): { status: number | null; stdout: Buffer; stderr: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr?.toString("utf8") ?? "" };
}

/* ── plain-fact shapes ──────────────────────────────────────────────────── */

export interface RemoteBranch {
  /** Branch name without the remote prefix, e.g. "feat/foo". */
  name: string;
  headSha: string;
  /** Committer date of the tip (ISO 8601). */
  lastCommitAt: string;
  lastAuthor: string;
  /**
   * Commits ahead/behind of the compare ref, when listRemoteBranches was
   * given one AND git supports %(ahead-behind) (≥ 2.41). ahead === 0 ⇔ the
   * tip is contained in the compare ref (merged). Absent on older git —
   * callers fall back to per-branch queries.
   */
  ahead?: number;
  behind?: number;
}

export interface BranchFile {
  path: string;
  /** git --name-status letter: A/M/D/R/C/T (renames keep the new path). */
  changeKind: string;
}

export interface CommitInventoryRow {
  path: string;
  changeKind: "added" | "modified" | "renamed" | "deleted" | "unchanged";
  previousPath?: string;
  contentHash?: string;
}

export interface GitTreeFile {
  path: string;
  mode: string;
  objectType: string;
  objectId: string;
  sizeBytes: number | null;
}

export interface GitStatusPath {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  originalPath?: string;
  unmerged: boolean;
}

export interface GitWorktreeSourceSnapshot {
  headSha: string;
  branch: string | null;
  sourceDigest: string;
  changedPaths: string[];
}

interface GitIndexEntry {
  mode: string;
  objectId: string;
}

interface GitIndexSnapshot {
  entries: Map<string, GitIndexEntry>;
  unmergedPaths: Set<string>;
}

const compareRepoPaths=(a:string,b:string):number=>Buffer.compare(Buffer.from(a,"utf8"),Buffer.from(b,"utf8"));

const canonicalJson = (value: unknown): string => {
  const canonicalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => compareRepoPaths(left, right))
          .map(([key, child]) => [key, canonicalize(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(canonicalize(value));
};

const hashRegularFile = (absolutePath: string): {
  byteLength: number;
  digest: string;
  mode: number;
} => {
  const before = fs.lstatSync(absolutePath);
  if (!before.isFile()) {
    throw new GitError(
      ["status", absolutePath],
      null,
      "worktree source entry is not a regular file",
    );
  }
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(
    absolutePath,
    fs.constants.O_RDONLY | noFollow,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      throw new GitError(
        ["status", absolutePath],
        null,
        "worktree source entry changed identity while opening",
      );
    }
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const count = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.byteLength, opened.size - offset),
        offset,
      );
      if (count === 0) {
        throw new GitError(
          ["status", absolutePath],
          null,
          "worktree source entry ended during hashing",
        );
      }
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
    ) {
      throw new GitError(
        ["status", absolutePath],
        null,
        "worktree source entry changed during hashing",
      );
    }
    return {
      byteLength: opened.size,
      digest: hash.digest("hex"),
      mode: opened.mode & 0o7777,
    };
  } finally {
    fs.closeSync(descriptor);
  }
};

const repositoryRelativePath = (value: string, label: string): string => {
  if (
    value.length === 0
    || value.includes("\0")
    || value.includes("\n")
    || value.includes("\r")
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value.split("/").includes("..")
  ) {
    throw new GitError([label, value], null, "invalid repository-relative path");
  }
  return value;
};

/**
 * Read the current worktree's own index through Git plumbing.
 *
 * Running from the worktree top level is important: linked worktrees share an
 * object store and common Git directory, but each has its own index.
 */
const indexEntriesAt = (worktreeRoot: string): GitIndexSnapshot => {
  const args = [
    "ls-files",
    "--stage",
    "-z",
    "--full-name",
    "--",
    ".",
  ];
  const result = runBuffer("git", args, worktreeRoot);
  if (result.status !== 0) {
    throw new GitError(args, result.status, result.stderr);
  }
  const entries = new Map<string, GitIndexEntry>();
  const unmergedPaths = new Set<string>();
  for (const record of result.stdout.toString("utf8").split("\0")) {
    if (record.length === 0) continue;
    const separator = record.indexOf("\t");
    if (separator < 0) {
      throw new GitError(args, result.status, "malformed ls-files entry");
    }
    const metadata = record.slice(0, separator);
    const filePath = repositoryRelativePath(
      record.slice(separator + 1),
      "ls-files",
    );
    const match = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/.exec(
      metadata,
    );
    if (!match) {
      throw new GitError(args, result.status, "malformed ls-files metadata");
    }
    const [, mode, objectId, stage] = match;
    if (stage !== "0") {
      unmergedPaths.add(filePath);
      continue;
    }
    if (entries.has(filePath)) {
      throw new GitError(
        args,
        result.status,
        "duplicate stage-0 index entry cannot form an execution source",
      );
    }
    entries.set(filePath, { mode: mode!, objectId: objectId! });
  }
  return { entries, unmergedPaths };
};

const exactCommit = (value: string): boolean =>
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);

const statusIsUnmerged = (indexStatus: string, worktreeStatus: string): boolean =>
  indexStatus === "U"
  || worktreeStatus === "U"
  || ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(
    `${indexStatus}${worktreeStatus}`,
  );

export interface PrFact {
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  headRefName: string;
}

/** Parse an origin URL into "owner/name"; null when unparseable. */
export function parseRemoteSlug(url: string): string | null {
  const m = url
    .trim()
    .match(/(?:[/:])([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export class GitFacade {
  /** Main-repo working dir (worktrees already resolved to their main repo). */
  readonly repoRoot: string;

  constructor(repoPath: string) {
    this.repoRoot = GitFacade.resolveRepoRoot(repoPath);
  }

  /**
   * decision-github-004: a path inside any worktree resolves to the MAIN
   * repo's root, so N worktrees land in one repo domain.
   */
  static resolveRepoRoot(anyPath: string): string {
    const r = run(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      anyPath,
    );
    if (r.status !== 0) {
      throw new GitError(["rev-parse", "--git-common-dir"], r.status, r.stderr);
    }
    return path.dirname(r.stdout.trim());
  }

  /** Canonical common Git directory shared by every linked worktree. */
  static commonDirAt(anyPath: string): string {
    const args = [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ];
    const r = run("git", args, anyPath);
    if (r.status !== 0) throw new GitError(args, r.status, r.stderr);
    const result = r.stdout.trim();
    if (
      result.length === 0
      || result.includes("\n")
      || result.includes("\r")
      || !path.isAbsolute(result)
    ) {
      throw new GitError(args, r.status, "git returned an invalid common directory");
    }
    return path.normalize(result);
  }

  /**
   * Resolve a path inside this checkout's Git administrative directory.
   *
   * Unlike `--git-common-dir`, `--git-path` is worktree-aware: linked
   * worktrees receive their own administrative path under
   * `.git/worktrees/<name>`. Callers use this for operational state that must
   * neither be tracked in the worktree nor shared by sibling worktrees.
   */
  static gitPathAt(anyPath: string, relativePath: string): string {
    if (
      typeof relativePath !== "string"
      || relativePath.length === 0
      || relativePath.includes("\0")
      || relativePath.includes("\n")
      || relativePath.includes("\r")
      || path.isAbsolute(relativePath)
      || relativePath.split(/[\\/]/u).includes("..")
    ) {
      throw new GitError(
        ["rev-parse", "--git-path", relativePath],
        null,
        "invalid relative Git administrative path",
      );
    }
    const args = [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      relativePath,
    ];
    const r = run("git", args, anyPath);
    if (r.status !== 0) throw new GitError(args, r.status, r.stderr);
    const result = r.stdout.trim();
    if (
      result.length === 0
      || result.includes("\n")
      || result.includes("\r")
      || !path.isAbsolute(result)
    ) {
      throw new GitError(args, r.status, "git returned an invalid path");
    }
    return path.normalize(result);
  }

  private git(args: string[]): string {
    const r = run("git", args, this.repoRoot);
    if (r.status !== 0) throw new GitError(args, r.status, r.stderr);
    return r.stdout;
  }

  private tryGit(args: string[]): string | null {
    const r = run("git", args, this.repoRoot);
    return r.status === 0 ? r.stdout : null;
  }

  /** "owner/name" from the origin remote; null when there is no remote. */
  remoteSlug(): string | null {
    const url = this.tryGit(["remote", "get-url", "origin"]);
    return url ? parseRemoteSlug(url) : null;
  }

  hasRemote(): boolean {
    return this.tryGit(["remote", "get-url", "origin"]) !== null;
  }

  /**
   * Default branch: origin/HEAD when known, else main/master if they exist
   * on the remote. Pure git fact — no invention.
   */
  defaultBranch(): string {
    const head = this.tryGit(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    if (head) return head.trim().replace("refs/remotes/origin/", "");
    for (const cand of ["main", "master"]) {
      if (this.tryGit(["rev-parse", "--verify", `refs/remotes/origin/${cand}`]))
        return cand;
    }
    throw new GitError(["symbolic-ref", "refs/remotes/origin/HEAD"], 1,
      "cannot determine default branch (no origin/HEAD, no origin/main|master)");
  }

  /** `git fetch --prune origin`. Failure is a fact (offline), not a throw. */
  fetch(): { ok: boolean; stderr: string } {
    const r = run("git", ["fetch", "--prune", "origin"], this.repoRoot);
    return { ok: r.status === 0, stderr: r.stderr };
  }

  /**
   * All remote branches except origin/HEAD, newest commit first. With
   * `aheadBehindVs` (a branch name on origin), each entry also carries
   * ahead/behind vs that branch in the SAME spawn (%(ahead-behind), git ≥
   * 2.41) — one call instead of 2 per branch; silently falls back to the
   * plain listing on older git.
   */
  listRemoteBranches(aheadBehindVs?: string): RemoteBranch[] {
    const base =
      "%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)%09%(authorname)";
    let out: string | null = null;
    let withCounts = false;
    if (aheadBehindVs) {
      out = this.tryGit([
        "for-each-ref",
        "refs/remotes/origin",
        "--sort=-committerdate",
        `--format=${base}%09%(ahead-behind:origin/${aheadBehindVs})`,
      ]);
      withCounts = out !== null;
    }
    out ??= this.git([
      "for-each-ref",
      "refs/remotes/origin",
      "--sort=-committerdate",
      `--format=${base}`,
    ]);
    const branches: RemoteBranch[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [ref, sha, date, author, counts] = line.split("\t");
      if (!ref || !sha || !date) continue;
      if (ref === "origin/HEAD" || ref === "origin") continue;
      const branch: RemoteBranch = {
        name: ref.replace(/^origin\//, ""),
        headSha: sha,
        lastCommitAt: date,
        lastAuthor: author ?? "",
      };
      if (withCounts && counts) {
        const [ahead, behind] = counts.trim().split(/\s+/).map(Number);
        if (Number.isFinite(ahead) && Number.isFinite(behind)) {
          branch.ahead = ahead;
          branch.behind = behind;
        }
      }
      branches.push(branch);
    }
    return branches;
  }

  /** True when `sha` is already contained in origin/<defaultBranch>. */
  isMerged(sha: string, defaultBranch: string): boolean {
    const r = run(
      "git",
      ["merge-base", "--is-ancestor", sha, `origin/${defaultBranch}`],
      this.repoRoot,
    );
    return r.status === 0;
  }

  /** Commits ahead/behind of origin/<defaultBranch> (merge-base三点语义). */
  aheadBehind(
    branch: string,
    defaultBranch: string,
  ): { ahead: number; behind: number } {
    const out = this.git([
      "rev-list",
      "--left-right",
      "--count",
      `origin/${defaultBranch}...origin/${branch}`,
    ]);
    const [behind, ahead] = out.trim().split(/\s+/).map(Number);
    return { ahead: ahead ?? 0, behind: behind ?? 0 };
  }

  /**
   * The branch's footprint: files it changed vs the merge-base with the
   * default branch (`git diff --name-status A...B` = three-dot merge-base
   * semantics) — 队友足迹 diff (decision-github-002).
   */
  branchFiles(branch: string, defaultBranch: string): BranchFile[] {
    const out = this.git([
      "diff",
      "--name-status",
      "--no-renames",
      `origin/${defaultBranch}...origin/${branch}`,
    ]);
    const files: BranchFile[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [kind, ...rest] = line.split("\t");
      const p = rest[rest.length - 1];
      if (!kind || !p) continue;
      files.push({ path: p, changeKind: kind.charAt(0) });
    }
    return files;
  }

  /**
   * merge-tree conflict warning between two branches (decision-github-002:
   * 跨 branch 冲突预警,fetch 后全本地).
   *
   * Returns the conflicted paths, [] for a clean merge, or null when git
   * cannot simulate the merge at all (e.g. no common ancestor) — unknown is
   * reported as unknown, never as "clean".
   */
  mergeTreeConflicts(refA: string, refB: string): string[] | null {
    const r = run(
      "git",
      ["merge-tree", "--write-tree", "--name-only", refA, refB],
      this.repoRoot,
    );
    if (r.status === 0) return [];
    if (r.status !== 1) return null;
    // Exit 1 = conflicts. Output: <tree-oid>\n<conflicted files...>\n\n<messages>
    const lines = r.stdout.split("\n");
    const paths: string[] = [];
    for (const line of lines.slice(1)) {
      if (line === "") break;
      paths.push(line);
    }
    return paths;
  }

  /**
   * Current branch AT a given path — deliberately static: the facade's own
   * commands run at the main-repo root (the repo DOMAIN), but a session in
   * a worktree has its own HEAD, which lives at the session's cwd.
   * Null on detached HEAD.
   */
  static currentBranchAt(anyPath: string): string | null {
    const r = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], anyPath);
    const name = r.status === 0 ? r.stdout.trim() : "";
    return name && name !== "HEAD" ? name : null;
  }

  /** Working-tree top level at a path (a worktree's own root, not the domain's). */
  static toplevelAt(anyPath: string): string | null {
    const r = run("git", ["rev-parse", "--show-toplevel"], anyPath);
    return r.status === 0 ? r.stdout.trim() : null;
  }

  /**
   * The three session facts the hook path needs, in ONE spawn — `vibehub
   * hook` fires on every tool use and must stay milliseconds, so per-fact
   * subprocesses are the budget's biggest enemy. rev-parse emits the
   * answers line-by-line in argument order.
   */
  static sessionContextAt(anyPath: string): {
    repoRoot: string;
    toplevel: string;
    branch: string | null;
  } {
    const r = run(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--show-toplevel",
        "--abbrev-ref",
        "HEAD",
      ],
      anyPath,
    );
    if (r.status !== 0) {
      throw new GitError(["rev-parse", "(session context)"], r.status, r.stderr);
    }
    const [commonDir, toplevel, head] = r.stdout.trim().split("\n");
    if (!commonDir || !toplevel || !head) {
      throw new GitError(["rev-parse", "(session context)"], r.status, r.stdout);
    }
    return {
      repoRoot: path.dirname(commonDir),
      toplevel,
      branch: head !== "HEAD" ? head : null,
    };
  }

  /** Current commit at a session path; called once when a task is captured. */
  static headShaAt(anyPath: string): string {
    const r = run("git", ["rev-parse", "--verify", "HEAD"], anyPath);
    if (r.status !== 0) throw new GitError(["rev-parse", "HEAD"], r.status, r.stderr);
    return r.stdout.trim();
  }

  /** Resolve an arbitrary ref to one exact commit without changing checkout state. */
  static resolveCommitAt(anyPath: string, ref: string): string {
    if (
      typeof ref !== "string"
      || ref.trim().length === 0
      || ref.includes("\0")
      || ref.includes("\n")
      || ref.includes("\r")
    ) {
      throw new GitError(
        ["rev-parse", "--verify", String(ref)],
        null,
        "invalid Git ref",
      );
    }
    const args = [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ];
    const r = run("git", args, anyPath);
    if (r.status !== 0) throw new GitError(args, r.status, r.stderr);
    const commit = r.stdout.trim();
    if (!exactCommit(commit)) {
      throw new GitError(args, r.status, "git returned an invalid commit id");
    }
    return commit;
  }

  /** List every tree entry below one literal path at an already-resolved commit. */
  static listTreeFilesAt(
    anyPath: string,
    commit: string,
    pathspec: string,
  ): GitTreeFile[] {
    if (!exactCommit(commit) || !GitFacade.hasCommitAt(anyPath, commit)) {
      throw new GitError(["ls-tree", commit], 1, "commit not found");
    }
    const relative = repositoryRelativePath(pathspec, "ls-tree");
    const args = [
      "ls-tree",
      "-r",
      "-l",
      "-z",
      "--full-tree",
      commit,
      "--",
      `:(top,literal)${relative}`,
    ];
    const r = runBuffer("git", args, anyPath);
    if (r.status !== 0) throw new GitError(args, r.status, r.stderr);
    const files: GitTreeFile[] = [];
    for (const record of r.stdout.toString("utf8").split("\0").filter(Boolean)) {
      const tab = record.indexOf("\t");
      if (tab < 0) throw new GitError(args, r.status, "malformed ls-tree entry");
      const [mode, objectType, objectId, rawSize] =
        record.slice(0, tab).trim().split(/\s+/u);
      const filePath = record.slice(tab + 1);
      const sizeBytes = rawSize === "-" ? null : Number(rawSize);
      if (
        !mode
        || !objectType
        || !objectId
        || !rawSize
        || !filePath
        || (sizeBytes !== null
          && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0))
      ) {
        throw new GitError(args, r.status, "malformed ls-tree entry");
      }
      files.push({ path: filePath, mode, objectType, objectId, sizeBytes });
    }
    return files.sort((left, right) => compareRepoPaths(left.path, right.path));
  }

  /** Read one repository-relative blob from an exact commit. */
  static readFileAtCommit(
    anyPath: string,
    commit: string,
    repositoryRelativeFile: string,
  ): Buffer {
    if (!exactCommit(commit) || !GitFacade.hasCommitAt(anyPath, commit)) {
      throw new GitError(["cat-file", commit], 1, "commit not found");
    }
    const relative = repositoryRelativePath(
      repositoryRelativeFile,
      "cat-file",
    );
    const object = `${commit}:${relative}`;
    const args = ["cat-file", "blob", object];
    const r = runBuffer("git", args, anyPath);
    if (r.status !== 0) throw new GitError(args, r.status, r.stderr);
    return r.stdout;
  }

  /**
   * Return tracked, untracked, deleted, renamed, and conflicted paths below
   * one literal worktree path. The call is scoped to `anyPath` rather than the
   * common repository root so sibling worktrees cannot leak into the result.
   */
  static statusPathsAt(anyPath: string, pathspec: string): GitStatusPath[] {
    const relative = repositoryRelativePath(pathspec, "status");
    const args = [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=all",
      "--",
      relative === "." ? "." : `:(top,literal)${relative}`,
    ];
    const r = runBuffer("git", args, anyPath);
    if (r.status !== 0) throw new GitError(args, r.status, r.stderr);
    const records = r.stdout.toString("utf8").split("\0");
    const paths: GitStatusPath[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (record.length === 0) continue;
      if (record.length < 4 || record[2] !== " ") {
        throw new GitError(args, r.status, "malformed porcelain status entry");
      }
      const indexStatus = record[0]!;
      const worktreeStatus = record[1]!;
      const filePath = record.slice(3);
      const renamed =
        indexStatus === "R"
        || indexStatus === "C"
        || worktreeStatus === "R"
        || worktreeStatus === "C";
      const originalPath = renamed ? records[index + 1] : undefined;
      if (renamed) index += 1;
      if (filePath.length === 0 || (renamed && !originalPath)) {
        throw new GitError(args, r.status, "malformed porcelain rename entry");
      }
      paths.push({
        path: filePath,
        indexStatus,
        worktreeStatus,
        ...(originalPath === undefined ? {} : { originalPath }),
        unmerged: statusIsUnmerged(indexStatus, worktreeStatus),
      });
    }
    return paths.sort((left, right) =>
      compareRepoPaths(left.path, right.path)
      || compareRepoPaths(left.originalPath ?? "", right.originalPath ?? ""));
  }

  /**
   * Exact execution-start identity for one worktree.
   *
   * HEAD covers every clean tracked file. The digest adds both the worktree
   * bytes/modes and the exact stage-0 index blob/mode for staged, unstaged,
   * and untracked paths, while callers may exclude separately governed
   * semantic trees such as `.vibehub/tickets`. Two matching captures are
   * required so a changing worktree or index never receives a falsely stable
   * identity.
   */
  static worktreeSourceSnapshotAt(
    anyPath: string,
    excludedPrefixes: readonly string[] = [],
  ): GitWorktreeSourceSnapshot {
    const session = GitFacade.sessionContextAt(anyPath);
    const worktreeRoot = session.toplevel;
    const normalizedExclusions = excludedPrefixes.map((prefix) => {
      const normalized = prefix.endsWith("/")
        ? prefix
        : `${prefix}/`;
      repositoryRelativePath(
        normalized.slice(0, -1),
        "worktree source exclusion",
      );
      return normalized;
    });
    const excluded = (candidate: string): boolean =>
      normalizedExclusions.some((prefix) =>
        candidate === prefix.slice(0, -1)
        || candidate.startsWith(prefix));

    const capture = (): GitWorktreeSourceSnapshot => {
      const headSha = GitFacade.headShaAt(worktreeRoot);
      const branch = GitFacade.currentBranchAt(worktreeRoot);
      const status = GitFacade.statusPathsAt(worktreeRoot, ".")
        .filter((entry) => {
          const paths = entry.originalPath === undefined
            ? [entry.path]
            : [entry.path, entry.originalPath];
          return paths.some((candidate) => !excluded(candidate));
        });
      if (status.some((entry) => entry.unmerged)) {
        throw new GitError(
          ["status", "--porcelain=v1"],
          null,
          "unmerged paths cannot form an execution source",
        );
      }
      const index = indexEntriesAt(worktreeRoot);
      if (status.some((entry) =>
        index.unmergedPaths.has(entry.path)
        || (
          entry.originalPath !== undefined
          && index.unmergedPaths.has(entry.originalPath)
        ))) {
        throw new GitError(
          ["ls-files", "--stage"],
          null,
          "unmerged index entries cannot form an execution source",
        );
      }
      const entries = status.map((entry) => {
        const absolutePath = path.join(
          worktreeRoot,
          ...entry.path.split("/"),
        );
        let content:
          | { kind: "missing" }
          | {
              kind: "file";
              byteLength: number;
              digest: string;
              mode: number;
            }
          | { kind: "symlink"; target: string; mode: number };
        let stat: fs.Stats | null;
        try {
          stat = fs.lstatSync(absolutePath);
        } catch (error) {
          if (
            typeof error === "object"
            && error !== null
            && "code" in error
            && error.code === "ENOENT"
          ) {
            stat = null;
          } else {
            throw error;
          }
        }
        if (stat === null) {
          content = { kind: "missing" };
        } else if (stat.isSymbolicLink()) {
          content = {
            kind: "symlink",
            target: fs.readlinkSync(absolutePath),
            mode: stat.mode & 0o7777,
          };
        } else if (stat.isFile()) {
          content = { kind: "file", ...hashRegularFile(absolutePath) };
        } else {
          throw new GitError(
            ["status", entry.path],
            null,
            "worktree source contains an unsupported special path",
          );
        }
        return {
          path: entry.path,
          indexStatus: entry.indexStatus,
          worktreeStatus: entry.worktreeStatus,
          ...(entry.originalPath === undefined
            ? {}
            : { originalPath: entry.originalPath }),
          index: index.entries.get(entry.path) ?? { kind: "missing" },
          ...(entry.originalPath === undefined
            ? {}
            : {
                originalIndex:
                  index.entries.get(entry.originalPath)
                  ?? { kind: "missing" },
              }),
          content,
        };
      });
      return {
        headSha,
        branch,
        sourceDigest: `sha256:${crypto.createHash("sha256")
          .update(canonicalJson({
            format: "vibehub.worktree-source.v2",
            headSha,
            branch,
            entries,
          }))
          .digest("hex")}`,
        changedPaths: [...new Set(entries.flatMap((entry) =>
          entry.originalPath === undefined
            ? [entry.path]
            : [entry.path, entry.originalPath]))].sort(compareRepoPaths),
      };
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const first = capture();
      const second = capture();
      if (canonicalJson(first) === canonicalJson(second)) return second;
    }
    throw new GitError(
      ["status", "--porcelain=v1"],
      null,
      "worktree changed during execution source capture",
    );
  }

  /** True only when the exact object id names a commit reachable in this repo's object store. */
  static hasCommitAt(anyPath: string, commitSha: string): boolean {
    if (!exactCommit(commitSha)) return false;
    const r = run("git", ["cat-file", "-e", `${commitSha}^{commit}`], anyPath);
    return r.status === 0;
  }

  /** Exact tracked-tree denominator and delta between two resolved commits. */
  static commitInventory(anyPath: string, baseCommit: string, targetCommit: string): CommitInventoryRow[] {
    const root = GitFacade.resolveRepoRoot(anyPath);
    for (const commit of [baseCommit, targetCommit]) if (!GitFacade.hasCommitAt(root, commit)) throw new GitError(["cat-file", commit], 1, "commit not found");
    const tree = runBuffer("git", ["ls-tree", "-r", "-z", targetCommit], root);
    if (tree.status !== 0) throw new GitError(["ls-tree", targetCommit], tree.status, tree.stderr);
    const targetEntries = tree.stdout.toString("utf8").split("\0").filter(Boolean).map(record=>{const tab=record.indexOf("\t");if(tab<0)throw new GitError(["ls-tree",targetCommit],1,"malformed tree entry");const [mode,type,object]=record.slice(0,tab).split(" ");return {mode:mode!,type:type!,object:object!,path:record.slice(tab+1)};}).sort((a,b)=>compareRepoPaths(a.path,b.path));
    const diff = runBuffer("git", ["diff", "--name-status", "-z", "-M", baseCommit, targetCommit, "--"], root);
    if (diff.status !== 0) throw new GitError(["diff", baseCommit, targetCommit], diff.status, diff.stderr);
    const delta = new Map<string, Omit<CommitInventoryRow,"path">>(), parts=diff.stdout.toString("utf8").split("\0").filter(Boolean);
    for(let i=0;i<parts.length;){const status=parts[i++]!;if(status.startsWith("R")){const previousPath=parts[i++]!,nextPath=parts[i++]!;delta.set(nextPath,{changeKind:"renamed",previousPath});}else{const relative=parts[i++]!;delta.set(relative,{changeKind:status.startsWith("A")?"added":status.startsWith("D")?"deleted":"modified"});}}
    const rows:CommitInventoryRow[]=[];
    for(const entry of targetEntries){const content=entry.type==="blob"?runBuffer("git",["cat-file","blob",entry.object],root):{status:0,stdout:Buffer.from(entry.object,"utf8"),stderr:""};if(content.status!==0)throw new GitError(["cat-file",entry.object],content.status,content.stderr);rows.push({path:entry.path,...(delta.get(entry.path)??{changeKind:"unchanged"}),contentHash:crypto.createHash("sha256").update(content.stdout).digest("hex")});}
    for(const [relative,change] of delta)if(change.changeKind==="deleted")rows.push({path:relative,...change});
    return rows.sort((a,b)=>compareRepoPaths(a.path,b.path));
  }

  /** Read-side commit events bounded by the task's captured HEAD. */
  commitEventsSince(startHeadSha: string, headRef: string): CommitEvent[] {
    const out = this.git([
      "log",
      "--reverse",
      "--format=%x1e%H%x1f%cI%x1f%s",
      "--name-only",
      `${startHeadSha}..${headRef}`,
    ]);
    return out
      .split("\x1e")
      .filter((block) => block.trim())
      .map((block) => {
        const lines = block.trim().split("\n");
        const [fullSha, at, message] = lines.shift()!.split("\x1f");
        if (!fullSha || !at || message === undefined) {
          throw new Error("malformed git log record");
        }
        const files = new Set(lines.map((line) => line.trim()).filter(Boolean));
        return {
          id: `git:${fullSha}`,
          at,
          type: "commit" as const,
          sha: fullSha.slice(0, 7),
          message,
          filesChanged: files.size,
        };
      });
  }

  /**
   * Default branch, tolerant variant for hook ingestion: falls back to
   * "main" when there is no remote at all (a hook must never fail a
   * session over repo shape).
   */
  defaultBranchOr(fallback: string): string {
    try {
      return this.defaultBranch();
    } catch {
      return fallback;
    }
  }

  /** Tracked-file count — the honest denominator for the unmapped gray. */
  lsFilesCount(): number {
    const out = this.git(["ls-files"]);
    return out.split("\n").filter((l) => l.length > 0).length;
  }
}

/* ── gh (PR facts) — explicit degraded tier when absent ─────────────────── */

export class GhFacade {
  constructor(readonly repoRoot: string) {}

  /**
   * PR list via `gh pr list` (decision-github-002). Returns null when gh is
   * missing or unauthenticated — the explicit degraded tier of
   * decision-github-004: pure-git facts keep flowing, the UI labels the gap.
   */
  listPrs(): PrFact[] | null {
    const r = run(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "all",
        "--limit",
        "200",
        "--json",
        "number,title,state,headRefName",
      ],
      this.repoRoot,
    );
    if (r.status !== 0) return null;
    try {
      const rows = JSON.parse(r.stdout) as Array<{
        number: number;
        title: string;
        state: string;
        headRefName: string;
      }>;
      return rows.map((p) => ({
        number: p.number,
        title: p.title,
        state: p.state.toLowerCase() as PrFact["state"],
        headRefName: p.headRefName,
      }));
    } catch {
      return null;
    }
  }
}
