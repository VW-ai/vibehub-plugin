import type { TimelineEvent } from "./contract/panel-types.js";
import type { Db } from "./db.js";
import { readTask, readTimeline } from "./activity-store.js";
import { GitFacade } from "./git-facade.js";

/**
 * Materialize a panel timeline from stored hook facts plus current git facts.
 * Commits are deliberately not copied into SQLite: each read derives exactly
 * start_head_sha..task-branch, so old branch history cannot leak into a task.
 */
export function readTaskTimeline(
  db: Db,
  taskId: string,
  repoRoot: string,
): TimelineEvent[] {
  const stored = readTimeline(db, taskId);
  const task = readTask(db, taskId);
  if (!task?.branch || !task.startHeadSha) return stored;

  let commits: TimelineEvent[] = [];
  try {
    commits = new GitFacade(repoRoot).commitEventsSince(task.startHeadSha, task.branch);
  } catch {
    // A deleted/unfetched branch must not make the stored session history unreadable.
    return stored;
  }
  const byId = new Map<string, TimelineEvent>();
  for (const event of [...stored, ...commits]) byId.set(event.id, event);
  return [...byId.values()].sort(
    (a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id),
  );
}
