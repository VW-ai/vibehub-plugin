/**
 * install-extremes — SCALE-EXTREMES fixtures for the first-run screen.
 *
 * 1. installNineFootprints — 9 concurrent pre-mapping sessions, all small
 *    (floor blocks): only 6 floors fit inside the gray (3 per shelf × 2
 *    shelves at the default insets), so the overflow ladder MUST take the
 *    "+N earlier sessions" collapse path (oldest 3).
 * 2. installTinyRepo — repoFiles = 12. Honesty note: with 12 files the
 *    smallest possible nonzero fraction (1/12 ≈ 8.3%) already EXCEEDS the
 *    6.24% floor, so the floor cannot dominate in a tiny repo — the floor
 *    rung belongs to LARGE repos (3/640 in install-first-run.ts; 3/40000
 *    in the unit tests). This fixture instead exercises what a tiny repo
 *    actually stresses: the CAP (10/12 → 83% clamps to 60% area) and the
 *    near-floor rung (1/12), plus the shrink ladder (the cap block's
 *    natural height exceeds the packable region).
 */
import type { Task } from "../types";
import type { InstallFixture, UncategorizedFootprint } from "../install-types";
import { UNCATEGORIZED_TERRITORY_ID } from "../install-types";

const NOW = "2026-07-12T10:22:00-07:00";

/* ── 9 concurrent footprints (overflow collapse path) ───────────────────── */

const NINE_TITLES = [
  "Fix flaky retry test",
  "Add rate-limit headers",
  "Bump node to 22",
  "Refactor config loader",
  "Add CSV export",
  "Patch login redirect",
  "Tighten CORS defaults",
  "Add request logging",
  "Fix off-by-one in pager",
] as const;

function nineTask(i: number): Task {
  const title = NINE_TITLES[i] ?? `Task ${i + 1}`;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  // launched oldest-first: task 0 started 54m ago, each next 6m later
  // (capturedAt 10:22 = minute 622 of the day)
  const clock = 622 - (54 - i * 6);
  const hh = String(Math.floor(clock / 60)).padStart(2, "0");
  const mm = String(clock % 60).padStart(2, "0");
  return {
    id: `install-task-nine-${i}`,
    title,
    state: "running",
    signalTier: "hooks",
    conflictIds: [],
    scopes: [
      {
        mode: "write",
        territoryId: UNCATEGORIZED_TERRITORY_ID,
        label: slug.slice(0, 18),
        filesTouched: 2 + (i % 4),
      },
    ],
    git: { branch: `vibehub/${slug}`, worktreePath: "~/dev/greenfield" },
    stateSince: `2026-07-12T${hh}:${mm}:00-07:00`,
    lastEventAt: "2026-07-12T10:21:40-07:00",
  };
}

const nineTasks: Task[] = NINE_TITLES.map((_, i) => nineTask(i));

/** All tiny (2–5 of 640 files → every block clamps to the floor). */
const nineFootprints: UncategorizedFootprint[] = nineTasks.map((t, i) => ({
  taskId: t.id,
  filesTouched: 2 + (i % 4),
  firstSeenAt: t.stateSince,
  sampleFiles: [`src/${t.git.branch.split("/")[1]}/index.ts`],
}));

export const installNineFootprints = {
  capturedAt: NOW,
  connection: {
    kind: "connected",
    repoPath: "/Users/mirabelle/dev/greenfield",
    repoFiles: 640,
  },
  mapping: { kind: "none" },
  repo: { slug: "acme/greenfield", defaultBranch: "main", branchCount: 1 },
  sync: {
    lastFetchAt: "2026-07-12T10:21:48-07:00",
    lastHookEventAt: "2026-07-12T10:21:40-07:00",
    stale: false,
  },
  tasks: nineTasks,
  footprints: nineFootprints,
} satisfies InstallFixture;

/* ── tiny repo: 12 files total (cap + near-floor + shrink ladder) ───────── */

const taskTinySweep: Task = {
  id: "install-task-tiny-sweep",
  title: "Rewrite every script for zsh",
  state: "running",
  signalTier: "hooks",
  conflictIds: [],
  scopes: [
    {
      mode: "write",
      territoryId: UNCATEGORIZED_TERRITORY_ID,
      label: "all-scripts",
      filesTouched: 10,
    },
  ],
  git: { branch: "vibehub/zsh-rewrite", worktreePath: "~/dev/tiny-scripts" },
  stateSince: "2026-07-12T10:07:00-07:00", // 15m
  lastEventAt: "2026-07-12T10:21:10-07:00",
};

const taskTinyReadme: Task = {
  id: "install-task-tiny-readme",
  title: "Fix install command in README",
  state: "running",
  signalTier: "hooks",
  conflictIds: [],
  scopes: [
    {
      mode: "write",
      territoryId: UNCATEGORIZED_TERRITORY_ID,
      label: "readme",
      filesTouched: 1,
    },
  ],
  git: { branch: "vibehub/readme-install", worktreePath: "~/dev/tiny-scripts" },
  stateSince: "2026-07-12T10:19:00-07:00", // 3m
  lastEventAt: "2026-07-12T10:21:35-07:00",
};

export const installTinyRepo = {
  capturedAt: NOW,
  connection: {
    kind: "connected",
    repoPath: "/Users/mirabelle/dev/tiny-scripts",
    repoFiles: 12,
  },
  mapping: { kind: "none" },
  repo: { slug: "mirabelle/tiny-scripts", defaultBranch: "main", branchCount: 1 },
  sync: {
    lastFetchAt: "2026-07-12T10:21:48-07:00",
    lastHookEventAt: "2026-07-12T10:21:35-07:00",
    stale: false,
  },
  tasks: [taskTinySweep, taskTinyReadme],
  footprints: [
    {
      taskId: taskTinySweep.id,
      filesTouched: 10, // 10/12 ≈ 83% → clamps to the 60% cap
      firstSeenAt: "2026-07-12T10:07:30-07:00",
      sampleFiles: ["bin/setup.sh", "bin/deploy.sh", "bin/backup.sh"],
    },
    {
      taskId: taskTinyReadme.id,
      filesTouched: 1, // 1/12 ≈ 8.3% — just above the 6.24% floor
      firstSeenAt: "2026-07-12T10:19:20-07:00",
      sampleFiles: ["README.md"],
    },
  ],
} satisfies InstallFixture;
