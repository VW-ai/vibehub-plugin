/**
 * Map-screen data types — everything the map view renders.
 *
 * SIGNAL DISCIPLINE (hard rule): every field must be derivable from the
 * signal inventory only —
 *   1. Claude Code hook events   (Notification / Stop / tool-call heartbeat,
 *      file-edit reports)                     → decision-project-016 / 021
 *   2. git facts                 (branch list, diff, merge-tree, worktree,
 *      fetch time)                            → decision-github-002
 *   3. gh CLI queries            (PR / issue state)      → decision-github-002
 *   4. local distillation output (territories = semantic anchor clusters)
 *                                             → decision-github-001 row 2
 *   5. user's own declarations at task launch (scope r/w registration via MCP)
 *                                             → decision-project-020
 *
 * NO invented fields: no "confidence", no "progress %", no ETA — those are
 * not capturable and honesty beats pretty (LOOP.md guideline 4).
 */

/* ── task state ─────────────────────────────────────────────────────────── */

/**
 * The five states — CAPPED at five forever (decision-project-021).
 * Defined by "what should the user do right now", not by agent internals.
 * Conflict is deliberately NOT a state — it is an attribute (see Task.conflictIds).
 */
export type TaskState =
  | "queued" // created, not launched yet          → user may launch
  | "running" // output flowing (tool calls / file edits) → leave it alone
  | "waiting" // agent stopped and needs a human    → go handle it
  | "stalled" // alive but silent for N minutes     → take a look
  | "done"; // session ended (success or abandoned) → accept / archive

/**
 * Evidence tier behind the state (decision-project-021).
 * - "hooks": strong signal — Claude Code hook events, transitions are precise.
 * - "basic": weak signal — file-watcher + process liveness only. This tier
 *   CANNOT infer "waiting"; the UI must honestly label reduced perception.
 */
export type SignalTier = "hooks" | "basic";

/* ── scope declarations ─────────────────────────────────────────────────── */

export type ScopeMode = "write" | "read";

/**
 * One declared scope entry, registered by the agent via MCP at task launch
 * (decision-project-020). A task may declare any number of scopes across any
 * territories — breadth is not punished.
 */
export interface ScopeDeclaration {
  mode: ScopeMode;
  /** Territory the declaration points at (id into MapFixture.territories). */
  territoryId: string;
  /** Optional sub-block within the territory (id into Territory.subBlocks). */
  subBlockId?: string;
  /** Short chip label, e.g. "auth", "orders/osm". Truncation is a UI concern. */
  label: string;
  /**
   * Files actually touched inside this scope so far — counted from hook
   * file-edit events (the "footprint"). Absent when nothing touched yet
   * or on the basic signal tier.
   */
  filesTouched?: number;
}

/* ── git / gh facts ─────────────────────────────────────────────────────── */

/** PR state as reported by `gh pr view --json state`. */
export type PrState = "open" | "merged" | "closed";

/** Facts about the task's branch — pure git + gh, zero invention. */
export interface TaskGit {
  /** Branch name (git fact; every launched task runs on its own branch). */
  branch: string;
  /** Local worktree path if the session runs in one (git worktree list). */
  worktreePath?: string;
  /** PR number if one exists (gh pr list). */
  prNumber?: number;
  prState?: PrState;
}

/* ── task ───────────────────────────────────────────────────────────────── */

export interface Task {
  id: string;
  /** Human title of the "thing" (user-entered at launch, or PR/issue title). */
  title: string;
  state: TaskState;
  signalTier: SignalTier;
  /**
   * Conflict is an ATTRIBUTE, not a sixth state (decision-project-020/021).
   * Ids into MapFixture.conflicts. Empty array = no conflict.
   */
  conflictIds: string[];
  /** Declared scopes, in declaration order. UI collapses overflow to +N. */
  scopes: ScopeDeclaration[];
  git: TaskGit;
  /**
   * When the current state was entered (ISO 8601). From hook event
   * timestamps (strong tier) or watcher timestamps (basic tier).
   * The rail's "12m" / "09:40" ages derive from this vs. capturedAt.
   */
  stateSince: string;
  /** Timestamp of the most recent signal of any kind (ISO 8601). */
  lastEventAt: string;
  /**
   * One human sentence about why the task is in this state — verbatim from
   * the hook payload (e.g. the Notification question text, or the merge
   * fact from gh). Never synthesized. Absent on the basic tier.
   */
  statusDetail?: string;
}

/* ── territories (semantic map) ─────────────────────────────────────────── */

/**
 * A named sub-block inside a territory (finer anchor cluster from
 * distillation), e.g. "Order state machine" inside "Payments & Orders".
 */
export interface SubBlock {
  id: string;
  /** Human name from distillation. */
  name: string;
  /** File count of the anchors clustered under this sub-block. */
  anchoredFileCount: number;
}

/**
 * Presentation-only layout rect (percent of canvas). NOT a captured signal —
 * it is computed by the app's layout pass; fixtures carry the v8 hand-tuned
 * values so S4 can hit screenshot-parity with the frozen baseline.
 */
export interface DemoLayout {
  left: number; // percent
  top: number; // percent
  width: number; // percent
  height: number; // percent
}

/**
 * Presentation-only sub-block offset INSIDE its territory, in px — v8 anchors
 * sub-blocks with fixed px offsets (viewport-independent), so the fixture
 * carries them verbatim for screenshot-parity. Same caveat as DemoLayout:
 * NOT a captured signal; a real layout pass replaces this later.
 * (S4 reconciliation of the S3 percent approximation — see notes/map-main.md.)
 */
export interface DemoSubOffset {
  left?: number; // px from territory left edge
  top?: number; // px from territory top edge
  right?: number; // px from territory right edge
  bottom?: number; // px from territory bottom edge
}

/** A semantic territory: an anchor cluster from local distillation. */
export interface Territory {
  id: string;
  /** Human name from distillation, e.g. "Auth & Sessions". */
  name: string;
  /** Number of files anchored to this territory (distillation output). */
  anchoredFileCount: number;
  subBlocks: SubBlock[];
  /** v8 hand-tuned rect; later replaced by a real layout algorithm. */
  demoLayout?: DemoLayout;
  /** Sub-block px offsets keyed by sub-block id (same caveat as demoLayout). */
  demoSubLayout?: Record<string, DemoSubOffset>;
}

/* ── occupancy rollups (derived, but shipped in the fixture so the map is
      renderable without re-deriving; each entry is a pure join of tasks ×
      scope declarations × footprints) ─────────────────────────────────── */

export interface TerritoryOccupancy {
  territoryId: string;
  /** Tasks with an active write footprint/declaration here. */
  writingTaskIds: string[];
  /** Tasks reading here. */
  readingTaskIds: string[];
  /** Tasks that finished today and had touched this territory. */
  doneTodayTaskIds: string[];
}

/* ── conflicts ──────────────────────────────────────────────────────────── */

/**
 * Conflict grading (decision-project-020):
 * - "red": two concurrent writers on the same symbol (or same spec-level
 *   convention) — the only grade eligible to push a notification.
 * - "yellow": read/write intersection on the same symbol — passively
 *   visible, never pushes.
 * Same-file-different-symbol does NOT produce a Conflict record at all.
 */
export type ConflictSeverity = "red" | "yellow";

/**
 * A detected footprint intersection between exactly two concurrent tasks
 * (the SOLE trigger condition — one agent straddling N features is silent).
 */
export interface Conflict {
  id: string;
  /** The pair of concurrent tasks whose footprints intersect. */
  taskIds: [string, string];
  territoryId: string;
  subBlockId?: string;
  /**
   * The concrete shared resources (symbols / anchors / files) where the
   * two footprints intersect — mechanically derived from hook file-edit
   * events mapped onto anchors (and, for teammate branches, from
   * `git merge-tree` / diff-hunk→anchor mapping).
   */
  sharedSymbols: string[];
  severity: ConflictSeverity;
  /** When the intersection was first detected (ISO 8601). */
  detectedAt: string;
}

/* ── sync freshness ─────────────────────────────────────────────────────── */

/**
 * Honesty header for the titlebar "Synced Ns ago" (decision-github-002:
 * offline / unfetched data must be labeled stale, never faked as live).
 */
export interface SyncFreshness {
  /** Last successful `git fetch --prune` (ISO 8601), null if never. */
  lastFetchAt: string | null;
  /** Last hook event received from any local session (ISO 8601), null if none. */
  lastHookEventAt: string | null;
  /** True when data must be presented as stale (offline / fetch too old). */
  stale: boolean;
}

/* ── repo header ────────────────────────────────────────────────────────── */

export interface RepoInfo {
  /** "owner/name" — from git remote. */
  slug: string;
  /** Default branch — from git. */
  defaultBranch: string;
  /** Count of remote branches — `git for-each-ref refs/remotes`. */
  branchCount: number;
}

/* ── fixture root ───────────────────────────────────────────────────────── */

/** Everything the map screen needs to render one frame. */
export interface MapFixture {
  /**
   * The "now" this snapshot was taken (ISO 8601). All relative ages
   * ("12m", "42s ago") are computed against this, keeping demos
   * deterministic.
   */
  capturedAt: string;
  repo: RepoInfo;
  sync: SyncFreshness;
  tasks: Task[];
  territories: Territory[];
  occupancy: TerritoryOccupancy[];
  conflicts: Conflict[];
}
