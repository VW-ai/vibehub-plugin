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
  Task,
  TerritoryOccupancy,
} from "./contract/map-types.js";
import type { Db } from "./db.js";
import {
  getRepoByRoot,
  readBranchFiles,
  readConflicts,
  readSyncState,
  readTeamBranches,
} from "./team-store.js";

export const UNCATEGORIZED_TERRITORY_ID = "uncategorized";

const taskId = (branch: string): string => `branch:${branch}`;
const conflictId = (a: string, b: string): string => `conflict:${a}|${b}`;

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
  const capturedAt = (opts.now?.() ?? new Date()).toISOString();
  const sync = readSyncState(db, repo.id);
  const branches = readTeamBranches(db, repo.id);
  const conflictRows = readConflicts(db, repo.id);

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

  const tasks: Task[] = branches
    .filter((b) => !b.merged || b.prState === "merged")
    .map((b) => {
      const files = readBranchFiles(db, repo.id, b.name);
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
    });

  const occupancy: TerritoryOccupancy[] = [
    {
      territoryId: UNCATEGORIZED_TERRITORY_ID,
      writingTaskIds: tasks
        .filter((t) => t.state !== "done" && t.scopes.length > 0)
        .map((t) => t.id),
      readingTaskIds: [],
      doneTodayTaskIds: tasks
        .filter(
          (t) =>
            t.state === "done" &&
            t.lastEventAt.slice(0, 10) === capturedAt.slice(0, 10),
        )
        .map((t) => t.id),
    },
  ];

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
    territories: [
      {
        id: UNCATEGORIZED_TERRITORY_ID,
        name: "Uncategorized",
        anchoredFileCount: sync?.repoFiles ?? 0,
        subBlocks: [],
        // Presentation-only full-bleed rect (see file header).
        demoLayout: { left: 2, top: 4, width: 96, height: 88 },
      },
    ],
    occupancy,
    conflicts,
  };
}
