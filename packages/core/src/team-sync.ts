/**
 * Team-visibility sync — the M1 ① vertical slice's write path
 * (decision-github-003 ②: 端到端实证 = 硬门槛).
 *
 * One pass: git fetch → branch list → per-branch footprint diff →
 * pairwise merge-tree conflict warning → gh pr list → SQLite.
 * Pure orchestration of GitFacade facts into the store; zero LLM, zero
 * server (decision-github-002).
 */
import type { Db } from "./db.js";
import { GhFacade, GitFacade } from "./git-facade.js";
import {
  reconcileConflicts,
  replaceBranchFiles,
  replaceTeamBranches,
  upsertRepo,
  writeSyncState,
  type TeamBranchRow,
} from "./team-store.js";

export interface TeamSyncOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Skip `git fetch` (offline runs in tests; stale is recorded honestly). */
  skipFetch?: boolean;
}

export interface TeamSyncResult {
  repoId: number;
  repoRoot: string;
  fetchOk: boolean | null;
  ghAvailable: boolean;
  branches: number;
  unmergedBranches: number;
  /** Unmerged branches still able to collide (open PR or no PR). */
  conflictCandidates: number;
  conflictPairs: number;
  prsMatched: number;
}

/**
 * Which branches can still collide: unmerged AND not concluded by a PR
 * (open PR or no PR yet). Pure so the rule is testable on its own.
 */
export function selectConflictCandidates(
  branches: TeamBranchRow[],
): TeamBranchRow[] {
  return branches.filter(
    (b) => !b.merged && (b.prState === null || b.prState === "open"),
  );
}

export function syncTeamSnapshot(
  db: Db,
  repoPath: string,
  opts: TeamSyncOptions = {},
): TeamSyncResult {
  const nowIso = (opts.now?.() ?? new Date()).toISOString();
  const git = new GitFacade(repoPath);

  const fetchOk = opts.skipFetch ? null : git.fetch().ok;

  const defaultBranch = git.defaultBranch();
  const slug = git.remoteSlug();
  const repo = upsertRepo(db, git.repoRoot, slug, defaultBranch, nowIso);

  // PR facts — explicit degraded tier when gh is absent (decision-github-004).
  const prs = new GhFacade(git.repoRoot).listPrs();
  const prByBranch = new Map(
    (prs ?? []).map((p) => [p.headRefName, p] as const),
  );

  const branches: TeamBranchRow[] = [];
  const files: Array<{ branch: string; path: string; changeKind: string }> = [];
  for (const b of git.listRemoteBranches()) {
    if (b.name === defaultBranch) continue;
    const merged = git.isMerged(b.headSha, defaultBranch);
    const { ahead, behind } = merged
      ? { ahead: 0, behind: 0 }
      : git.aheadBehind(b.name, defaultBranch);
    const pr = prByBranch.get(b.name);
    branches.push({
      name: b.name,
      headSha: b.headSha,
      lastCommitAt: b.lastCommitAt,
      lastAuthor: b.lastAuthor,
      ahead,
      behind,
      merged,
      prNumber: pr?.number ?? null,
      prState: pr?.state ?? null,
      prTitle: pr?.title ?? null,
    });
    if (!merged) {
      for (const f of git.branchFiles(b.name, defaultBranch)) {
        files.push({ branch: b.name, path: f.path, changeKind: f.changeKind });
      }
    }
  }

  // Pairwise merge-tree over ACTIVE branches (decision-github-002 预警;
  // decision-project-020: 并发才算撞 — an unmerged branch whose PR is closed
  // or merged is finished work, not a concurrent writer, so it never enters
  // a warning pair).
  // O(n²) by design for v1 — cost scales with concurrently-open branches,
  // which decision-project-024's one-thing-one-branch discipline keeps small;
  // revisit with data if a real repo proves otherwise (tunable, no threshold
  // invented here).
  const unmerged = selectConflictCandidates(branches);
  const conflicts: Array<{ branchA: string; branchB: string; path: string }> = [];
  for (let i = 0; i < unmerged.length; i++) {
    for (let j = i + 1; j < unmerged.length; j++) {
      const a = unmerged[i]!.name;
      const b = unmerged[j]!.name;
      const paths = git.mergeTreeConflicts(`origin/${a}`, `origin/${b}`);
      if (paths === null) continue; // unknown ≠ clean; skip, never fake
      const [branchA, branchB] = a < b ? [a, b] : [b, a];
      for (const p of paths) conflicts.push({ branchA, branchB, path: p });
    }
  }

  replaceTeamBranches(db, repo.id, branches);
  replaceBranchFiles(db, repo.id, files);
  reconcileConflicts(db, repo.id, conflicts, nowIso);
  writeSyncState(db, repo.id, {
    lastFetchAt: opts.skipFetch ? null : nowIso,
    lastFetchOk: fetchOk,
    ghAvailable: prs !== null,
    repoFiles: git.lsFilesCount(),
    lastSyncedAt: nowIso,
  });

  const pairKeys = new Set(conflicts.map((c) => `${c.branchA}\t${c.branchB}`));
  return {
    repoId: repo.id,
    repoRoot: git.repoRoot,
    fetchOk,
    ghAvailable: prs !== null,
    branches: branches.length,
    unmergedBranches: branches.filter((b) => !b.merged).length,
    conflictCandidates: unmerged.length,
    conflictPairs: pairKeys.size,
    prsMatched: branches.filter((b) => b.prNumber !== null).length,
  };
}
