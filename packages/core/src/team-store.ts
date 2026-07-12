/**
 * Team-visibility store — read/write for the team snapshot tables.
 * Pure persistence; every value in = a git/gh fact collected by GitFacade,
 * every value out = exactly what was stored (zero derivation here).
 */
import type { Db } from "./db.js";

export interface RepoRow {
  id: number;
  rootPath: string;
  slug: string | null;
  defaultBranch: string;
}

export interface SyncStateRow {
  lastFetchAt: string | null;
  lastFetchOk: boolean | null;
  ghAvailable: boolean;
  repoFiles: number | null;
  lastSyncedAt: string | null;
}

export interface TeamBranchRow {
  name: string;
  headSha: string;
  lastCommitAt: string;
  lastAuthor: string;
  ahead: number;
  behind: number;
  merged: boolean;
  prNumber: number | null;
  prState: "open" | "merged" | "closed" | null;
  prTitle: string | null;
}

export interface TeamConflictRow {
  branchA: string;
  branchB: string;
  path: string;
  firstDetectedAt: string;
  lastSeenAt: string;
}

export function upsertRepo(
  db: Db,
  rootPath: string,
  slug: string | null,
  defaultBranch: string,
  now: string,
): RepoRow {
  db.prepare(
    `INSERT INTO repos (root_path, slug, default_branch, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(root_path) DO UPDATE SET
       slug = excluded.slug, default_branch = excluded.default_branch`,
  ).run(rootPath, slug, defaultBranch, now);
  const row = db
    .prepare(`SELECT id, root_path, slug, default_branch FROM repos WHERE root_path = ?`)
    .get(rootPath) as { id: number; root_path: string; slug: string | null; default_branch: string };
  return {
    id: row.id,
    rootPath: row.root_path,
    slug: row.slug,
    defaultBranch: row.default_branch,
  };
}

export function getRepoByRoot(db: Db, rootPath: string): RepoRow | null {
  const row = db
    .prepare(`SELECT id, root_path, slug, default_branch FROM repos WHERE root_path = ?`)
    .get(rootPath) as
    | { id: number; root_path: string; slug: string | null; default_branch: string }
    | undefined;
  return row
    ? { id: row.id, rootPath: row.root_path, slug: row.slug, defaultBranch: row.default_branch }
    : null;
}

export function writeSyncState(
  db: Db,
  repoId: number,
  s: SyncStateRow,
): void {
  db.prepare(
    `INSERT INTO sync_state (repo_id, last_fetch_at, last_fetch_ok, gh_available, repo_files, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id) DO UPDATE SET
       last_fetch_at = excluded.last_fetch_at,
       last_fetch_ok = excluded.last_fetch_ok,
       gh_available = excluded.gh_available,
       repo_files = excluded.repo_files,
       last_synced_at = excluded.last_synced_at`,
  ).run(
    repoId,
    s.lastFetchAt,
    s.lastFetchOk === null ? null : s.lastFetchOk ? 1 : 0,
    s.ghAvailable ? 1 : 0,
    s.repoFiles,
    s.lastSyncedAt,
  );
}

export function readSyncState(db: Db, repoId: number): SyncStateRow | null {
  const r = db
    .prepare(
      `SELECT last_fetch_at, last_fetch_ok, gh_available, repo_files, last_synced_at
       FROM sync_state WHERE repo_id = ?`,
    )
    .get(repoId) as
    | {
        last_fetch_at: string | null;
        last_fetch_ok: number | null;
        gh_available: number;
        repo_files: number | null;
        last_synced_at: string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    lastFetchAt: r.last_fetch_at,
    lastFetchOk: r.last_fetch_ok === null ? null : r.last_fetch_ok === 1,
    ghAvailable: r.gh_available === 1,
    repoFiles: r.repo_files,
    lastSyncedAt: r.last_synced_at,
  };
}

/** Replace the branch set wholesale — the snapshot IS the remote state. */
export function replaceTeamBranches(
  db: Db,
  repoId: number,
  branches: TeamBranchRow[],
): void {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM team_branches WHERE repo_id = ?`).run(repoId);
    const ins = db.prepare(
      `INSERT INTO team_branches
       (repo_id, name, head_sha, last_commit_at, last_author, ahead, behind, merged, pr_number, pr_state, pr_title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const b of branches) {
      ins.run(
        repoId,
        b.name,
        b.headSha,
        b.lastCommitAt,
        b.lastAuthor,
        b.ahead,
        b.behind,
        b.merged ? 1 : 0,
        b.prNumber,
        b.prState,
        b.prTitle,
      );
    }
  });
  tx();
}

export function readTeamBranches(db: Db, repoId: number): TeamBranchRow[] {
  const rows = db
    .prepare(
      `SELECT name, head_sha, last_commit_at, last_author, ahead, behind, merged,
              pr_number, pr_state, pr_title
       FROM team_branches WHERE repo_id = ? ORDER BY last_commit_at DESC`,
    )
    .all(repoId) as Array<{
    name: string;
    head_sha: string;
    last_commit_at: string;
    last_author: string;
    ahead: number;
    behind: number;
    merged: number;
    pr_number: number | null;
    pr_state: string | null;
    pr_title: string | null;
  }>;
  return rows.map((r) => ({
    name: r.name,
    headSha: r.head_sha,
    lastCommitAt: r.last_commit_at,
    lastAuthor: r.last_author,
    ahead: r.ahead,
    behind: r.behind,
    merged: r.merged === 1,
    prNumber: r.pr_number,
    prState: (r.pr_state as TeamBranchRow["prState"]) ?? null,
    prTitle: r.pr_title,
  }));
}

export function replaceBranchFiles(
  db: Db,
  repoId: number,
  files: Array<{ branch: string; path: string; changeKind: string }>,
): void {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM team_branch_files WHERE repo_id = ?`).run(repoId);
    const ins = db.prepare(
      `INSERT INTO team_branch_files (repo_id, branch, path, change_kind)
       VALUES (?, ?, ?, ?)`,
    );
    for (const f of files) ins.run(repoId, f.branch, f.path, f.changeKind);
  });
  tx();
}

export function readBranchFiles(
  db: Db,
  repoId: number,
  branch: string,
): Array<{ path: string; changeKind: string }> {
  return db
    .prepare(
      `SELECT path, change_kind AS changeKind FROM team_branch_files
       WHERE repo_id = ? AND branch = ? ORDER BY path`,
    )
    .all(repoId, branch) as Array<{ path: string; changeKind: string }>;
}

/**
 * Upsert the conflict set for this sync. first_detected_at survives re-syncs
 * (the map's Conflict.detectedAt is "when first detected", not "last seen");
 * pairs that no longer conflict are pruned — resolved is resolved.
 */
export function reconcileConflicts(
  db: Db,
  repoId: number,
  seen: Array<{ branchA: string; branchB: string; path: string }>,
  now: string,
): void {
  const tx = db.transaction(() => {
    const ins = db.prepare(
      `INSERT INTO team_conflicts (repo_id, branch_a, branch_b, path, first_detected_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, branch_a, branch_b, path) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    );
    for (const c of seen) ins.run(repoId, c.branchA, c.branchB, c.path, now, now);
    db.prepare(
      `DELETE FROM team_conflicts WHERE repo_id = ? AND last_seen_at != ?`,
    ).run(repoId, now);
  });
  tx();
}

export function readConflicts(db: Db, repoId: number): TeamConflictRow[] {
  const rows = db
    .prepare(
      `SELECT branch_a, branch_b, path, first_detected_at, last_seen_at
       FROM team_conflicts WHERE repo_id = ?
       ORDER BY branch_a, branch_b, path`,
    )
    .all(repoId) as Array<{
    branch_a: string;
    branch_b: string;
    path: string;
    first_detected_at: string;
    last_seen_at: string;
  }>;
  return rows.map((r) => ({
    branchA: r.branch_a,
    branchB: r.branch_b,
    path: r.path,
    firstDetectedAt: r.first_detected_at,
    lastSeenAt: r.last_seen_at,
  }));
}
