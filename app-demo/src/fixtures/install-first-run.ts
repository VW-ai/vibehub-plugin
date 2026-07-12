/**
 * install-first-run — the 8 approved S2 variants of the empty/first-run
 * screen (static/empty-install-s2.html) as data. Content is the S2
 * static's, verbatim: same repo, same paths, same task titles, same ages
 * (capturedAt fixed so every relative age reproduces S2 exactly).
 *
 * Facts only: footprint geometry is NOT stored — packFootprints
 * (install-derive.ts) derives it. Where the derived rects differ from the
 * S2 hand-placed ones, S4 reconciles (documented in notes/empty-install.md).
 */
import type { Task } from "../types";
import type {
  InstallFixture,
  InstallStep,
  UncategorizedFootprint,
} from "../install-types";
import { UNCATEGORIZED_TERRITORY_ID } from "../install-types";

/** The snapshot "now" — same clock as the map fixtures. */
const NOW = "2026-07-12T10:22:00-07:00";

/**
 * decision-project-025's three install steps — the canonical checklist.
 * Moment A renders these as the pre-install checklist (all pending).
 */
export const PRISTINE_INSTALL_STEPS: InstallStep[] = [
  { id: "hooks", label: "Installs hooks for Claude Code", status: "pending" },
  { id: "mcp", label: "Registers the MCP server", status: "pending" },
  { id: "db", label: "Creates a local database", status: "pending" },
];

/**
 * The S2 150-char stress path (exactly 150 chars — leading-ellipsis
 * truncation must stay exercised at both viewports).
 */
const LONG_REPO_PATH =
  "/Users/mirabelle/work/clients/meridian-holdings/engineering/platform-monorepo/services-and-infrastructure/deployment-pipelines-and-observability-stack";

/* ── connected-repo shared facts (Moments B/C) ──────────────────────────── */

const GREENFIELD_PATH = "/Users/mirabelle/dev/greenfield";

/**
 * `git ls-files` count at connect — the packing denominator (iter-15 rule:
 * "120 of ~640 files → sqrt-damped ~18.5% area"). With 640, the 3-file
 * footprint sits on the floor exactly as S1/S2 drew it.
 */
const GREENFIELD_FILES = 640;

const GREENFIELD_REPO = {
  slug: "acme/greenfield",
  defaultBranch: "main",
  branchCount: 1,
};

/** Moments B: "Synced just now" — fetch landed this second, no hooks yet. */
const SYNC_JUST_NOW = {
  lastFetchAt: NOW,
  lastHookEventAt: null,
  stale: false,
};

/** Moments C: "Synced 12s ago" — last fetch + hook event 12s back. */
const SYNC_12S = {
  lastFetchAt: "2026-07-12T10:21:48-07:00",
  lastHookEventAt: "2026-07-12T10:21:48-07:00",
  stale: false,
};

/* ── the pre-mapping tasks (S2 rail cards, verbatim) ────────────────────── */

/** "Add health-check endpoint" — running 4m, picked up by hooks. */
const taskHealthCheck: Task = {
  id: "install-task-health",
  title: "Add health-check endpoint",
  state: "running",
  signalTier: "hooks",
  conflictIds: [],
  scopes: [
    {
      mode: "write",
      territoryId: UNCATEGORIZED_TERRITORY_ID,
      label: "health-endpoint",
      filesTouched: 3,
    },
  ],
  git: {
    branch: "vibehub/health-check-endpoint",
    worktreePath: "~/dev/greenfield",
  },
  stateSince: "2026-07-12T10:18:00-07:00", // 4m
  lastEventAt: "2026-07-12T10:21:48-07:00",
};

/** "Wire request tracing through services" — running 11m, launched here. */
const taskRequestTracing: Task = {
  id: "install-task-tracing",
  title: "Wire request tracing through services",
  state: "running",
  signalTier: "hooks",
  conflictIds: [],
  scopes: [
    {
      mode: "write",
      territoryId: UNCATEGORIZED_TERRITORY_ID,
      label: "request-tracing",
      filesTouched: 120,
    },
  ],
  git: {
    branch: "vibehub/request-tracing",
    worktreePath: "~/dev/greenfield",
  },
  stateSince: "2026-07-12T10:11:00-07:00", // 11m
  lastEventAt: "2026-07-12T10:21:30-07:00",
};

/** "Migrate codebase to strict TypeScript" — running 18m, 200 files. */
const taskStrictTs: Task = {
  id: "install-task-strict-ts",
  title: "Migrate codebase to strict TypeScript",
  state: "running",
  signalTier: "hooks",
  conflictIds: [],
  scopes: [
    {
      mode: "write",
      territoryId: UNCATEGORIZED_TERRITORY_ID,
      label: "repo-wide",
      filesTouched: 200,
    },
  ],
  git: {
    branch: "vibehub/strict-typescript-migration",
    worktreePath: "~/dev/greenfield",
  },
  stateSince: "2026-07-12T10:04:00-07:00", // 18m
  lastEventAt: "2026-07-12T10:21:48-07:00",
};

/* ── the footprints (facts; geometry derived by packFootprints) ─────────── */

const fpHealthCheck: UncategorizedFootprint = {
  taskId: taskHealthCheck.id,
  filesTouched: 3, // 3/640 < floor → floor block (S1's N=1, 24×26)
  firstSeenAt: "2026-07-12T10:18:20-07:00",
  sampleFiles: [
    "src/health/endpoint.ts",
    "src/health/checks.ts",
    "src/server/routes.ts",
  ],
};

const fpRequestTracing: UncategorizedFootprint = {
  taskId: taskRequestTracing.id,
  filesTouched: 120, // 120/640 → sqrt-damped ≈ 42% × 45%
  firstSeenAt: "2026-07-12T10:11:40-07:00",
  sampleFiles: [
    "services/gateway/src/middleware/trace.ts",
    "services/orders/src/index.ts",
    "packages/instrumentation/src/otel.ts",
  ],
};

const fpStrictTs: UncategorizedFootprint = {
  taskId: taskStrictTs.id,
  filesTouched: 200, // 200/640 → ≈ 54% × 58% (S2 hand-drew 58×58; S4 diffs)
  firstSeenAt: "2026-07-12T10:05:10-07:00",
  sampleFiles: ["tsconfig.json", "src/server/routes.ts", "src/orders/state.ts"],
};

/* ── the 8 variants ─────────────────────────────────────────────────────── */

/** Moment A — fresh install, no repo. */
export const installConnect = {
  capturedAt: NOW,
  connection: { kind: "none" },
  mapping: { kind: "none" },
  tasks: [],
  footprints: [],
} satisfies InstallFixture;

/** Moment A′ — folder picked, steps mid-flight (hooks done, MCP now). */
export const installInstalling = {
  capturedAt: NOW,
  connection: {
    kind: "connecting",
    repoPath: LONG_REPO_PATH,
    steps: [
      { id: "hooks", label: "Installs hooks for Claude Code", status: "done" },
      { id: "mcp", label: "Registers the MCP server", status: "now" },
      { id: "db", label: "Creates a local database", status: "pending" },
    ],
  },
  mapping: { kind: "none" },
  tasks: [],
  footprints: [],
} satisfies InstallFixture;

/**
 * Moment A″ — hooks step failed (settings.json unwritable), the OTHER two
 * completed: steps are independent, honest partial success (iter-15 fork).
 */
export const installFailed = {
  capturedAt: NOW,
  connection: {
    kind: "connecting",
    repoPath: LONG_REPO_PATH,
    steps: [
      {
        id: "hooks",
        label: "Installs hooks for Claude Code",
        status: "failed",
        failure: {
          reason: "isn't writable",
          codeRef: "~/.claude/settings.json",
          fix: "chmod u+w ~/.claude/settings.json",
        },
      },
      { id: "mcp", label: "Registers the MCP server", status: "done" },
      { id: "db", label: "Creates a local database", status: "done" },
    ],
  },
  mapping: { kind: "none" },
  tasks: [],
  footprints: [],
} satisfies InstallFixture;

/** Moment B — connected, nothing has happened yet. */
export const installConnected = {
  capturedAt: NOW,
  connection: {
    kind: "connected",
    repoPath: GREENFIELD_PATH,
    repoFiles: GREENFIELD_FILES,
  },
  mapping: { kind: "none" },
  repo: GREENFIELD_REPO,
  sync: SYNC_JUST_NOW,
  tasks: [],
  footprints: [],
} satisfies InstallFixture;

/** Moment B while the `claude -p` mapping pass runs (started 2m ago). */
export const installMapping = {
  capturedAt: NOW,
  connection: {
    kind: "connected",
    repoPath: GREENFIELD_PATH,
    repoFiles: GREENFIELD_FILES,
  },
  mapping: { kind: "running", startedAt: "2026-07-12T10:20:00-07:00" }, // 2m
  repo: GREENFIELD_REPO,
  sync: SYNC_JUST_NOW,
  tasks: [],
  footprints: [],
} satisfies InstallFixture;

/** Moment C — first task alive, still unmapped (floor footprint). */
export const installFirstTask = {
  capturedAt: NOW,
  connection: {
    kind: "connected",
    repoPath: GREENFIELD_PATH,
    repoFiles: GREENFIELD_FILES,
  },
  mapping: { kind: "none" },
  repo: GREENFIELD_REPO,
  sync: SYNC_12S,
  tasks: [taskHealthCheck],
  footprints: [fpHealthCheck],
} satisfies InstallFixture;

/** Two concurrent pre-mapping sessions — the packing rule's 2-case. */
export const installTwoTasks = {
  capturedAt: NOW,
  connection: {
    kind: "connected",
    repoPath: GREENFIELD_PATH,
    repoFiles: GREENFIELD_FILES,
  },
  mapping: { kind: "none" },
  repo: GREENFIELD_REPO,
  sync: SYNC_12S,
  tasks: [taskHealthCheck, taskRequestTracing],
  footprints: [fpHealthCheck, fpRequestTracing],
} satisfies InstallFixture;

/** Moment C at scale — one 200-file first session claims most of the gray. */
export const installFirstTask200 = {
  capturedAt: NOW,
  connection: {
    kind: "connected",
    repoPath: GREENFIELD_PATH,
    repoFiles: GREENFIELD_FILES,
  },
  mapping: { kind: "none" },
  repo: GREENFIELD_REPO,
  sync: SYNC_12S,
  tasks: [taskStrictTs],
  footprints: [fpStrictTs],
} satisfies InstallFixture;
