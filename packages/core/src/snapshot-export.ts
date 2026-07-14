/**
 * MapSnapshot export — derive the app's canonical read-model snapshot
 * from SQLite (team snapshot + hook-captured 运行域 + distilled 图域), so
 * the real data plugs into the existing UI unchanged. This is the shape the
 * Tauri shell will read.
 *
 * HONESTY RULES for teammate branches (no local session → "basic" tier,
 * decision-project-021):
 * - unmerged branch  → "stalled" (basic tier can never infer "waiting");
 *   statusDetail stays absent (never synthesized).
 * - PR merged/closed → "done" (a git/gh fact).
 * - stateSince / lastEventAt = the branch tip's committer date.
 *
 * Local hook-captured tasks are the "hooks" tier and WIN over the remote
 * row for the same branch (the join key, decision-project-024); the remote
 * row only contributes PR facts.
 *
 * Pre-distillation, everything lands on the one honest "Uncategorized"
 * territory; once the graph domain has territories they get the squarified
 * layout (cached at distillation time; the gray joins on the fly).
 */
import type {
  Conflict,
  MapSnapshot,
  ScopeDeclaration,
  Task,
  Territory,
  TerritoryOccupancy,
} from "./contract/map-types.js";
import type { Db } from "./db.js";
import {
  distinctEditedFileCount,
  lastHookEventAt,
  listActiveConflicts,
  listTasks,
  readScopes,
  readTaskForBranch,
  taskIdForBranch,
  type TaskRow,
} from "./activity-store.js";
import {
  countAnchoredFiles,
  listTerritories,
  readTerritoryLayouts,
} from "./graph-store.js";
import { layoutTerritories } from "./treemap.js";
import { isConflictPairIgnored } from "./conflict-ignore.js";
import {
  getRepoByRoot,
  readBranchFiles,
  readConflicts,
  readSyncState,
  readTeamBranches,
  type TeamBranchRow,
} from "./team-store.js";

import { UNCATEGORIZED_TERRITORY_ID } from "./contract/install-types.js";

const conflictId = (a: string, b: string): string => `conflict:${a}|${b}`;

/**
 * Same calendar day, UTC. The map frame only shows TODAY's finished work
 * (the rail's done group and occupancy.doneTodayTaskIds both mean "today"
 * literally — Wayne verdict 2026-07-12: stale done tasks don't enter the
 * frame at all). UTC as the day boundary is the simple deterministic
 * choice; a local-tz boundary is a presentation question for the app shell.
 */
const sameUtcDay = (aIso: string, bIso: string): boolean => {
  const a = new Date(aIso);
  const b = new Date(bIso);
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
};

/**
 * The one rule for scope-less tasks: their footprint speaks for itself on
 * the honest gray (same idea as install-types.ts UncategorizedFootprint).
 */
const uncategorizedWriteScope = (filesTouched: number): ScopeDeclaration => ({
  mode: "write",
  territoryId: UNCATEGORIZED_TERRITORY_ID,
  label: "uncategorized",
  filesTouched,
});

export function exportTeamMapSnapshot(
  db: Db,
  repoRoot: string,
  opts: { now?: () => Date } = {},
): MapSnapshot {
  const repo = getRepoByRoot(db, repoRoot);
  if (!repo) {
    throw new Error(
      `no team snapshot for ${repoRoot} — run syncTeamSnapshot first`,
    );
  }
  const repoId = repo.id;
  const taskIdForRepoBranch = (branch: string): string =>
    readTaskForBranch(db, repoId, branch)?.id ?? taskIdForBranch(repoId, branch);
  const capturedAt = (opts.now?.() ?? new Date()).toISOString();
  const sync = readSyncState(db, repoId);
  const branches = readTeamBranches(db, repoId);

  // Distilled territories (graph domain), when a mapping pass has run.
  const distilled = listTerritories(db, repoId).filter(
    (t) => t.anchoredFileCount > 0,
  );
  const distilledIds = new Set(distilled.map((t) => t.id));

  /* ── conflicts: rows (one per path) → one Conflict per branch pair ────── */

  const byPair = new Map<
    string,
    { a: string; b: string; paths: string[]; firstAt: string }
  >();
  for (const c of readConflicts(db, repoId)) {
    // Ignore-pair storage intentionally canonicalizes by branch metadata so
    // pre-opaque rows and new opaque task ids share one durable decision.
    if (isConflictPairIgnored(db, repoId, [`branch:${c.branchA}`, `branch:${c.branchB}`])) continue;
    const key = `${c.branchA}\t${c.branchB}`;
    const entry = byPair.get(key);
    if (entry) {
      entry.paths.push(c.path);
      if (c.firstDetectedAt < entry.firstAt) entry.firstAt = c.firstDetectedAt;
    } else {
      byPair.set(key, {
        a: c.branchA,
        b: c.branchB,
        paths: [c.path],
        firstAt: c.firstDetectedAt,
      });
    }
  }

  const conflictIdsByTaskId = new Map<string, string[]>();
  const teamConflictSummaries: Conflict[] = [...byPair.values()].map((p) => {
    const id = conflictId(p.a, p.b);
    return {
      id,
      taskIds: [taskIdForRepoBranch(p.a), taskIdForRepoBranch(p.b)],
      territoryId: UNCATEGORIZED_TERRITORY_ID,
      // Pre-distillation there are no symbol anchors; the conflicted FILE
      // paths from merge-tree are the honest shared resources.
      sharedSymbols: p.paths,
      // Two concurrent writers on the same file = W×W (decision-project-020).
      severity: "red",
      detectedAt: p.firstAt,
    };
  });
  const localConflicts = listActiveConflicts(db, repoId);
  const localIds = new Set(localConflicts.map((conflict) => conflict.id));
  const conflicts = [...localConflicts, ...teamConflictSummaries.filter((conflict) => !localIds.has(conflict.id))];
  for (const conflict of conflicts) {
    for (const taskId of conflict.taskIds) {
      conflictIdsByTaskId.set(taskId, [...(conflictIdsByTaskId.get(taskId) ?? []), conflict.id]);
    }
  }

  /* ── tasks: one merged list (local hooks tier ∪ remote basic tier) ────── */

  function localTask(
    t: TaskRow,
    pr: { prNumber: number | null; prState: TeamBranchRow["prState"] },
  ): Task {
    // Declared scopes (MCP registration) when present — kept when they
    // point at a distilled territory, coerced to the gray otherwise;
    // no declaration → the footprint speaks (uncategorizedWriteScope).
    let scopes = readScopes(db, t.id).map((s) =>
      distilledIds.has(s.territoryId) ||
      s.territoryId === UNCATEGORIZED_TERRITORY_ID
        ? s
        : { ...s, territoryId: UNCATEGORIZED_TERRITORY_ID },
    );
    if (scopes.length === 0) {
      const edited = distinctEditedFileCount(db, t.id);
      if (edited > 0) scopes = [uncategorizedWriteScope(edited)];
    }
    return {
      id: t.id,
      title: t.title,
      state: t.state,
      signalTier: "hooks",
      conflictIds: conflictIdsByTaskId.get(t.id) ?? [],
      scopes,
      git: {
        branch: t.branch!,
        ...(t.worktreePath ? { worktreePath: t.worktreePath } : {}),
        ...(pr.prNumber !== null && pr.prState !== null
          ? { prNumber: pr.prNumber, prState: pr.prState }
          : {}),
      },
      stateSince: t.stateSince,
      lastEventAt: t.lastEventAt,
      ...(t.statusDetail ? { statusDetail: t.statusDetail } : {}),
    };
  }

  function teamTask(b: TeamBranchRow): Task {
    const files = readBranchFiles(db, repoId, b.name);
    const done = b.merged || b.prState === "merged" || b.prState === "closed";
    return {
      id: taskIdForRepoBranch(b.name),
      title: b.prTitle ?? b.name,
      state: done ? "done" : "stalled",
      signalTier: "basic",
      conflictIds: conflictIdsByTaskId.get(taskIdForRepoBranch(b.name)) ?? [],
      scopes: files.length ? [uncategorizedWriteScope(files.length)] : [],
      git: {
        branch: b.name,
        ...(b.prNumber !== null && b.prState !== null
          ? { prNumber: b.prNumber, prState: b.prState }
          : {}),
      },
      stateSince: b.lastCommitAt,
      lastEventAt: b.lastCommitAt,
    };
  }

  const localByBranch = new Map(
    listTasks(db, repoId)
      .filter((t) => t.branch !== null)
      .map((t) => [t.branch!, t] as const),
  );
  const remoteBranchNames = new Set(branches.map((b) => b.name));

  const tasks: Task[] = [
    // remote branches (local hooks-tier row wins where the names collide)
    ...branches
      .filter((b) => !b.merged || b.prState === "merged")
      .map((b) => {
        const local = localByBranch.get(b.name);
        return local
          ? localTask(local, { prNumber: b.prNumber, prState: b.prState })
          : teamTask(b);
      }),
    // local tasks on unpushed branches — hooks see them first
    ...[...localByBranch.entries()]
      .filter(([branch]) => !remoteBranchNames.has(branch))
      .map(([, t]) => localTask(t, { prNumber: t.prNumber, prState: t.prState })),
  ].filter(
    // done work only enters the frame the day it finished (sameUtcDay doc)
    (t) => t.state !== "done" || sameUtcDay(t.lastEventAt, capturedAt),
  );

  /* ── territories + occupancy ──────────────────────────────────────────── */

  /** A task lives where its scopes point; scope-less = the honest gray. */
  const taskTerritoryIds = (t: Task): string[] => {
    const ids = [...new Set(t.scopes.map((s) => s.territoryId))];
    return ids.length > 0 ? ids : [UNCATEGORIZED_TERRITORY_ID];
  };

  let territories: Territory[];
  if (distilled.length > 0) {
    // A mapping pass has run: real territories, squarified layout
    // (weights = anchoredFileCount — the same derived fact the map labels).
    const unanchored = Math.max(
      (sync?.repoFiles ?? 0) - countAnchoredFiles(db, repoId),
      0,
    );
    const grayReferenced =
      unanchored > 0 ||
      conflicts.length > 0 ||
      tasks.some((t) => taskTerritoryIds(t).includes(UNCATEGORIZED_TERRITORY_ID));

    const items = distilled.map((t) => ({ id: t.id, weight: t.anchoredFileCount }));
    if (grayReferenced) {
      // The gray joins the treemap weighted by what it honestly holds (the
      // unanchored files), floored at one file-equivalent: when something
      // references it, it must stay visible even if every file is anchored.
      items.push({
        id: UNCATEGORIZED_TERRITORY_ID,
        weight: Math.max(unanchored, 1),
      });
    }
    // Cached layout covers distilled features only; whenever the gray joins
    // the frame we lay out afresh. (Caching a rect for the gray needs the
    // real TerritoryBuilder pass — M2 question, noted in the change spec.)
    const cached = readTerritoryLayouts(db, repoId);
    const layouts =
      grayReferenced || cached.size === 0 ? layoutTerritories(items) : cached;

    territories = [
      ...distilled.map((t) => ({ ...t, layout: layouts.get(t.id) })),
      ...(grayReferenced
        ? [
            {
              id: UNCATEGORIZED_TERRITORY_ID,
              name: "Uncategorized",
              anchoredFileCount: unanchored,
              subBlocks: [],
              layout: layouts.get(UNCATEGORIZED_TERRITORY_ID),
            },
          ]
        : []),
    ];
  } else {
    // Pre-distillation: the one honest gray. A one-item treemap IS the
    // margin box, so both frames share DEFAULT_LAYOUT's geometry.
    territories = [
      {
        id: UNCATEGORIZED_TERRITORY_ID,
        name: "Uncategorized",
        anchoredFileCount: sync?.repoFiles ?? 0,
        subBlocks: [],
        layout: layoutTerritories([
          { id: UNCATEGORIZED_TERRITORY_ID, weight: 1 },
        ]).get(UNCATEGORIZED_TERRITORY_ID),
      },
    ];
  }

  const activeIdsOn = (terrId: string, mode: "write" | "read"): string[] =>
    tasks
      .filter(
        (t) =>
          t.state !== "done" &&
          t.scopes.some((s) => s.mode === mode && s.territoryId === terrId),
      )
      .map((t) => t.id);

  const occupancy: TerritoryOccupancy[] = territories.map((terr) => ({
    territoryId: terr.id,
    writingTaskIds: activeIdsOn(terr.id, "write"),
    readingTaskIds: activeIdsOn(terr.id, "read"),
    doneTodayTaskIds: tasks
      .filter((t) => t.state === "done" && taskTerritoryIds(t).includes(terr.id))
      .map((t) => t.id),
  }));

  return {
    capturedAt,
    repo: {
      slug: repo.slug ?? repo.rootPath.split("/").pop() ?? repo.rootPath,
      defaultBranch: repo.defaultBranch,
      branchCount: branches.length + 1, // + the default branch itself
    },
    sync: {
      lastFetchAt: sync?.lastFetchAt ?? null,
      lastHookEventAt: lastHookEventAt(db, repoId),
      stale: !(sync?.lastFetchOk ?? false),
    },
    tasks,
    territories,
    occupancy,
    conflicts,
  };
}
