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
import path from "node:path";

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

/* ── plain-fact shapes ──────────────────────────────────────────────────── */

export interface RemoteBranch {
  /** Branch name without the remote prefix, e.g. "feat/foo". */
  name: string;
  headSha: string;
  /** Committer date of the tip (ISO 8601). */
  lastCommitAt: string;
  lastAuthor: string;
}

export interface BranchFile {
  path: string;
  /** git --name-status letter: A/M/D/R/C/T (renames keep the new path). */
  changeKind: string;
}

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

  /** All remote branches except origin/HEAD, newest commit first. */
  listRemoteBranches(): RemoteBranch[] {
    const out = this.git([
      "for-each-ref",
      "refs/remotes/origin",
      "--sort=-committerdate",
      "--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)%09%(authorname)",
    ]);
    const branches: RemoteBranch[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [ref, sha, date, author] = line.split("\t");
      if (!ref || !sha || !date) continue;
      if (ref === "origin/HEAD" || ref === "origin") continue;
      branches.push({
        name: ref.replace(/^origin\//, ""),
        headSha: sha,
        lastCommitAt: date,
        lastAuthor: author ?? "",
      });
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
