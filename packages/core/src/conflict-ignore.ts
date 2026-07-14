import type { Db } from "./db.js";

export interface CanonicalConflictPair {
  taskIds: [string, string];
  sides: [string, string];
}

function canonicalSide(db: Db, taskId: string): string {
  const task = db.prepare(`SELECT branch FROM tasks WHERE id = ?`).get(taskId) as
    | { branch: string | null }
    | undefined;
  if (task?.branch) return `branch:${task.branch}`;
  return taskId.startsWith("branch:") ? taskId : `task:${taskId}`;
}

export function canonicalConflictPair(db: Db, taskIds: [string, string]): CanonicalConflictPair {
  const sides = taskIds.map((id) => canonicalSide(db, id)).sort() as [string, string];
  return { taskIds, sides };
}

export function isConflictPairIgnored(db: Db, repoId: number, taskIds: [string, string]): boolean {
  const { sides } = canonicalConflictPair(db, taskIds);
  return db.prepare(
    `SELECT 1 FROM ignored_conflict_pairs WHERE repo_id = ? AND side_a = ? AND side_b = ?`,
  ).get(repoId, sides[0], sides[1]) !== undefined;
}

export function persistIgnoredConflictPair(
  db: Db, repoId: number, taskIds: [string, string], now: string,
): CanonicalConflictPair {
  const pair = canonicalConflictPair(db, taskIds);
  db.prepare(
    `INSERT INTO ignored_conflict_pairs (repo_id, side_a, side_b, ignored_at)
     VALUES (?, ?, ?, ?) ON CONFLICT(repo_id, side_a, side_b) DO NOTHING`,
  ).run(repoId, pair.sides[0], pair.sides[1], now);
  return pair;
}

/** Resolve either a rich local id or a merge-tree summary id to one pair. */
export function resolveConflictPair(db: Db, repoId: number, conflictId: string): CanonicalConflictPair | null {
  const local = db.prepare(
    `SELECT task_a AS taskA, task_b AS taskB FROM conflicts WHERE repo_id = ? AND id = ?`,
  ).get(repoId, conflictId) as { taskA: string; taskB: string } | undefined;
  if (local) return canonicalConflictPair(db, [local.taskA, local.taskB]);
  const rows = db.prepare(
    `SELECT DISTINCT branch_a AS branchA, branch_b AS branchB FROM team_conflicts WHERE repo_id = ?`,
  ).all(repoId) as Array<{ branchA: string; branchB: string }>;
  for (const row of rows) {
    if (`conflict:${row.branchA}|${row.branchB}` === conflictId) {
      const taskId = (branch: string): string => {
        const local = db.prepare(
          `SELECT id FROM tasks WHERE repo_id = ? AND branch = ? ORDER BY created_at LIMIT 1`,
        ).get(repoId, branch) as { id: string } | undefined;
        return local?.id ?? `branch:${branch}`;
      };
      return canonicalConflictPair(db, [taskId(row.branchA), taskId(row.branchB)]);
    }
  }
  return null;
}
