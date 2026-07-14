import {
  GitFacade,
  getRepoByRoot,
  openDb,
  readTaskForBranch,
  taskIdForBranch,
  upsertRepo,
  upsertTask,
  type Db,
} from "@vibehub/core";
import type { CapabilityContext } from "./capabilities.js";

export interface RuntimeContext {
  context: CapabilityContext;
  close(): void;
}

/** Derive the MCP domain from the project cwd; no parallel repo/task config. */
export function openRuntimeContext(
  cwd: string,
  dbPath: string,
  now: () => string = () => new Date().toISOString(),
): RuntimeContext {
  const db: Db = openDb(dbPath);
  try {
    const session = GitFacade.sessionContextAt(cwd);
    const git = new GitFacade(cwd);
    const at = now();
    const repo = getRepoByRoot(db, session.repoRoot) ?? upsertRepo(
      db,
      session.repoRoot,
      git.remoteSlug(),
      git.defaultBranchOr("main"),
      at,
    );
    const branch = session.branch ?? "detached";
    const existing = readTaskForBranch(db, repo.id, branch);
    const taskId = existing?.id ?? taskIdForBranch(repo.id, branch);
    if (!existing) {
      upsertTask(db, {
        id: taskId,
        repoId: repo.id,
        title: branch,
        state: "queued",
        signalTier: "basic",
        branch,
        worktreePath: session.toplevel === session.repoRoot ? null : session.toplevel,
        prNumber: null,
        prState: null,
        stateSince: at,
        lastEventAt: at,
        statusDetail: null,
        createdAt: at,
        startHeadSha: GitFacade.headShaAt(session.toplevel),
      });
    }
    return {
      context: { db, repoId: repo.id, taskId },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
