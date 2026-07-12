/**
 * MapFixture export — the M1 ① vertical slice's read path: derive the demo
 * app's fixture shape from the team snapshot in SQLite, so the real data
 * path plugs into the existing UI unchanged (handoff: 最简展示 = 接 demo 的
 * fixture 接口).
 *
 * HONESTY RULES for teammate branches (they have no local session, so the
 * signal tier is "basic" — decision-project-021):
 * - unmerged branch  → state "stalled" (basic tier can never infer "waiting";
 *   the strongest honest claim about a remote branch is "it exists and was
 *   last touched at T"). statusDetail stays absent (basic tier contract).
 * - PR merged/closed → state "done" (a git/gh fact).
 * - stateSince / lastEventAt = the branch tip's committer date (a git fact).
 *
 * ZERO DISTILLATION YET: every footprint lands in the one honest
 * "Uncategorized" territory (same sentinel idea as install-types.ts's
 * UNCATEGORIZED_TERRITORY_ID — "every file lives here until the repo is
 * mapped"). Its demoLayout is presentation-only, computed here, replaced by
 * the real layout pass (treemap spike) later.
 */
import type {
  Conflict,
  MapFixture,
  ScopeDeclaration,
  Task,
  Territory,
  TerritoryOccupancy,
} from "./contract/map-types.js";
import type { Db } from "./db.js";
import {
  listTasks,
  readFootprints,
  readScopes,
  type TaskRow,
} from "./activity-store.js";
import {
  listTerritories,
  readTerritoryLayouts,
} from "./graph-store.js";
import { layoutTerritories } from "./treemap.js";
import {
  getRepoByRoot,
  readBranchFiles,
  readConflicts,
  readSyncState,
  readTeamBranches,
} from "./team-store.js";

import { UNCATEGORIZED_TERRITORY_ID } from "./contract/install-types.js";

const taskId = (branch: string): string => `branch:${branch}`;
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

export function exportTeamMapFixture(
  db: Db,
  repoRoot: string,
  opts: { now?: () => Date } = {},
): MapFixture {
  const repo = getRepoByRoot(db, repoRoot);
  if (!repo) {
    throw new Error(
      `no team snapshot for ${repoRoot} — run syncTeamSnapshot first`,
    );
  }
  const repoId = repo.id;
  const capturedAt = (opts.now?.() ?? new Date()).toISOString();
  const sync = readSyncState(db, repo.id);
  const branches = readTeamBranches(db, repo.id);
  const conflictRows = readConflicts(db, repo.id);

  // Distilled territories (graph domain), when a mapping pass has run.
  // Declared scopes pointing at one of these keep their territory; anything
  // else lands on the honest gray (see the territories section below).
  const distilled = listTerritories(db, repoId).filter(
    (t) => t.anchoredFileCount > 0,
  );
  const distilledIds = new Set(distilled.map((t) => t.id));

  // conflict rows (one per path) → one Conflict per branch pair
  const byPair = new Map<string, { a: string; b: string; paths: string[]; firstAt: string }>();
  for (const c of conflictRows) {
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

  const conflictIdsByBranch = new Map<string, string[]>();
  const conflicts: Conflict[] = [...byPair.values()].map((p) => {
    const id = conflictId(p.a, p.b);
    for (const br of [p.a, p.b]) {
      conflictIdsByBranch.set(br, [...(conflictIdsByBranch.get(br) ?? []), id]);
    }
    return {
      id,
      taskIds: [taskId(p.a), taskId(p.b)],
      territoryId: UNCATEGORIZED_TERRITORY_ID,
      // Pre-distillation there are no symbol anchors; the conflicted FILE
      // paths from merge-tree are the honest shared resources.
      sharedSymbols: p.paths,
      // Two concurrent writers on the same file = W×W (decision-project-020).
      severity: "red",
      detectedAt: p.firstAt,
    };
  });

  // Local hook-captured tasks (运行域) — the hooks tier. Where a local task
  // and a remote branch share the branch name (the join key, 024), the
  // hooks-tier row wins: it knows the REAL state/timeline; the remote row
  // only contributes PR facts.
  const localByBranch = new Map(
    listTasks(db, repo.id)
      .filter((t) => t.branch !== null)
      .map((t) => [t.branch!, t] as const),
  );

  const localTask = (
    t: TaskRow,
    pr: { prNumber: number | null; prState: Task["git"]["prState"] | null },
  ): Task => {
    // Declared scopes (MCP registration) when present; otherwise the
    // footprint speaks for itself on the one honest gray territory —
    // same idea as install-types.ts UncategorizedFootprint.
    const declared = readScopes(db, t.id).map((s: ScopeDeclaration) =>
      distilledIds.has(s.territoryId) ||
      s.territoryId === UNCATEGORIZED_TERRITORY_ID
        ? s
        : { ...s, territoryId: UNCATEGORIZED_TERRITORY_ID },
    );
    let scopes = declared;
    if (scopes.length === 0) {
      const edited = new Set(
        readFootprints(db, t.id)
          .filter((f) => f.action === "edit")
          .map((f) => f.path),
      );
      if (edited.size > 0) {
        scopes = [
          {
            mode: "write",
            territoryId: UNCATEGORIZED_TERRITORY_ID,
            label: "uncategorized",
            filesTouched: edited.size,
          },
        ];
      }
    }
    return {
      id: t.id,
      title: t.title,
      state: t.state,
      signalTier: "hooks",
      conflictIds: conflictIdsByBranch.get(t.branch!) ?? [],
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
  };

  const remoteBranchNames = new Set(branches.map((b) => b.name));
  const tasks: Task[] = branches
    .filter((b) => !b.merged || b.prState === "merged")
    .map((b) => {
      const local = localByBranch.get(b.name);
      if (local) {
        return localTask(local, { prNumber: b.prNumber, prState: b.prState });
      }
      return teamTask(b);
    })
    // Done work only enters the frame the day it finished (sameUtcDay doc).
    .filter((t) => t.state !== "done" || sameUtcDay(t.lastEventAt, capturedAt));
  // Local tasks on unpushed branches (no remote yet) — hooks see them first.
  for (const [branch, t] of localByBranch) {
    if (!remoteBranchNames.has(branch)) {
      const built = localTask(t, { prNumber: t.prNumber, prState: t.prState });
      if (built.state !== "done" || sameUtcDay(built.lastEventAt, capturedAt)) {
        tasks.push(built);
      }
    }
  }

  function teamTask(b: (typeof branches)[number]): Task {
      const files = readBranchFiles(db, repoId, b.name);
      const done = b.merged || b.prState === "merged" || b.prState === "closed";
      return {
        id: taskId(b.name),
        title: b.prTitle ?? b.name,
        state: done ? "done" : "stalled",
        signalTier: "basic",
        conflictIds: conflictIdsByBranch.get(b.name) ?? [],
        scopes: files.length
          ? [
              {
                mode: "write",
                territoryId: UNCATEGORIZED_TERRITORY_ID,
                label: "uncategorized",
                filesTouched: files.length,
              } as const,
            ]
          : [],
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

  /** A task lives where its scopes point; scope-less = the honest gray. */
  const taskTerritoryIds = (t: Task): string[] => {
    const ids = [...new Set(t.scopes.map((s) => s.territoryId))];
    return ids.length > 0 ? ids : [UNCATEGORIZED_TERRITORY_ID];
  };

  let territories: Territory[];
  if (distilled.length > 0) {
    // A mapping pass has run: real territories, squarified layout
    // (weights = anchoredFileCount — the same derived fact the map labels).
    const anchoredFiles = (
      db
        .prepare(`SELECT COUNT(DISTINCT file) AS n FROM anchors WHERE repo_id = ?`)
        .get(repoId) as { n: number }
    ).n;
    const unanchored = Math.max((sync?.repoFiles ?? 0) - anchoredFiles, 0);
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
      ...distilled.map((t) => ({ ...t, demoLayout: layouts.get(t.id) })),
      ...(grayReferenced
        ? [
            {
              id: UNCATEGORIZED_TERRITORY_ID,
              name: "Uncategorized",
              anchoredFileCount: unanchored,
              subBlocks: [],
              demoLayout: layouts.get(UNCATEGORIZED_TERRITORY_ID),
            },
          ]
        : []),
    ];
  } else {
    // Pre-distillation: the one honest gray, full-bleed (presentation-only).
    territories = [
      {
        id: UNCATEGORIZED_TERRITORY_ID,
        name: "Uncategorized",
        anchoredFileCount: sync?.repoFiles ?? 0,
        subBlocks: [],
        demoLayout: { left: 2, top: 4, width: 96, height: 88 },
      },
    ];
  }

  const occupancy: TerritoryOccupancy[] = territories.map((terr) => ({
    territoryId: terr.id,
    writingTaskIds: tasks
      .filter(
        (t) =>
          t.state !== "done" &&
          t.scopes.some((s) => s.mode === "write" && s.territoryId === terr.id),
      )
      .map((t) => t.id),
    readingTaskIds: tasks
      .filter(
        (t) =>
          t.state !== "done" &&
          t.scopes.some((s) => s.mode === "read" && s.territoryId === terr.id),
      )
      .map((t) => t.id),
    doneTodayTaskIds: tasks
      .filter(
        (t) => t.state === "done" && taskTerritoryIds(t).includes(terr.id),
      )
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
      lastHookEventAt: null, // no hook path yet — M1 ③
      stale: !(sync?.lastFetchOk ?? false),
    },
    tasks,
    territories,
    occupancy,
    conflicts,
  };
}
