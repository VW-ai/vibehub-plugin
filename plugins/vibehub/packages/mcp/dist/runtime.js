import { GitFacade, getRepoByRoot, openDb, readTaskForBranch, taskIdForBranch, upsertRepo, upsertTask, } from "@vibehub/core";
import { fileURLToPath } from "node:url";
/** Derive the MCP domain from the project cwd; no parallel repo/task config. */
export function openRuntimeContext(cwd, dbPath, now = () => new Date().toISOString()) {
    const db = openDb(dbPath);
    try {
        const session = GitFacade.sessionContextAt(cwd);
        const git = new GitFacade(cwd);
        const at = now();
        const repo = getRepoByRoot(db, session.repoRoot) ?? upsertRepo(db, session.repoRoot, git.remoteSlug(), git.defaultBranchOr("main"), at);
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
            context: { db, repoId: repo.id, taskId, repoRoot: session.toplevel },
            close: () => db.close(),
        };
    }
    catch (error) {
        db.close();
        throw error;
    }
}
export function openRuntimeContextFromRoots(roots, dbPath, now = () => new Date().toISOString()) {
    const candidates = new Map();
    for (const root of roots) {
        try {
            const path = fileURLToPath(root.uri);
            const session = GitFacade.sessionContextAt(path);
            candidates.set(session.toplevel, path);
        }
        catch {
            // Non-file and non-Git roots cannot establish repository identity.
        }
    }
    if (candidates.size !== 1) {
        throw new Error(`VibeHub MCP requires exactly one Git workspace root; found ${candidates.size}`);
    }
    return openRuntimeContext([...candidates.values()][0], dbPath, now);
}
export async function openRuntimeContextForClient(input) {
    let roots;
    try {
        roots = await input.listRoots();
    }
    catch (error) {
        // Codex 0.144.1 responds to roots/list without advertising the roots
        // capability. Preserve that host behavior, and fall back only for an
        // older client that both omits the capability and explicitly reports
        // JSON-RPC MethodNotFound. Timeouts, transport closure, and internal
        // errors must never silently bind the launch cwd.
        const code = (typeof error === "object" &&
            error !== null &&
            "code" in error) ? error.code : undefined;
        if (!input.supportsRoots && code === -32601) {
            return openRuntimeContext(input.cwd, input.dbPath, input.now);
        }
        throw error;
    }
    return roots.length > 0
        ? openRuntimeContextFromRoots(roots, input.dbPath, input.now)
        : openRuntimeContext(input.cwd, input.dbPath, input.now);
}
