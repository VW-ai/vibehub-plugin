/**
 * Menubar-summary view types (m5, S3) — a PURE ROLLUP over MapFixture.
 *
 * There is deliberately NO menubar fixture shape: the dropdown is the same
 * repo snapshot the map renders, summarized. Every field below is derived by
 * `deriveMenubar` (menubar-derive.ts) from MapFixture alone — tasks, conflicts
 * and sync freshness — so the menubar can never disagree with the map
 * (one source of truth; see notes/menubar.md S3 open question 1).
 *
 * SIGNAL DISCIPLINE: inherited wholesale from src/types.ts — these are view
 * models over already-typed signals, they introduce zero new captured fields.
 */

/* ── the waiting badge on the menubar item ──────────────────────────────── */

/**
 * The item's top-right count. Counts everything that NEEDS YOU: waiting
 * tasks + conflict PAIRS — a pair counts once, matching its single
 * needs-you row (rev-2, Wayne verdict ⑦ / decision-workbench-003; REVOKES
 * iter-20's waiting-only badge). The tip enumerates both sides
 * ("1 waiting · 1 conflict"). null = nothing needs you (no fake urgency).
 */
export interface MenubarBadgeView {
  /** Rendered text: "1" … "99", then "99+" (cap per iter-19 fork). */
  text: string;
  /** The uncapped waiting + conflict-pair total — travels in tips. */
  exact: number;
  /**
   * True when repo data is stale (SyncFreshness.stale): the badge renders
   * gray + static — a last-known count must not claim live urgency (iter-19).
   */
  stale: boolean;
  tip: string;
}

/* ── counts row (v8 titlebar stat-pill language, zeros hidden) ──────────── */

export interface MenubarStatView {
  kind: "need" | "clash" | "alive";
  /** e.g. "1 waiting" / "2 conflicts" / "3 running". */
  text: string;
  tip: string;
}

/* ── "Needs you" rows ───────────────────────────────────────────────────── */

/**
 * One row = one decision needed from the user. Waiting tasks and conflict
 * PAIRS interleave into a single list, OLDEST FIRST (S1 open question 4,
 * encoded here):
 *   - waiting row age basis = Task.stateSince (how long it has been parked);
 *   - conflict row age basis = Conflict.detectedAt (how long the pair has
 *     needed adjudication — NOT the older writer's runtime; fork iter-20).
 * A conflict is ONE row labeled by its contested subject ("Order state
 * machine — 2 writing"), never two task rows (iter-2/iter-19: a conflict
 * demands attention exactly once).
 */
export interface NeedsYouRowView {
  /** Stable key: the task id (waiting) or conflict id (conflict). */
  key: string;
  kind: "waiting" | "conflict";
  /** Pill token class + text (state = text first, color reinforces). */
  pill: "need" | "clash";
  pillText: "WAITING" | "CONFLICT";
  /** Task title, or "<subject> — N writing" for a conflict pair. */
  title: string;
  /** relAge vs capturedAt — one unit only (derive.ts age rule). */
  age: string;
  /** The sort basis (ISO) — kept so tests can assert the interleave. */
  basisIso: string;
  /** Click intent + the row's full story (title never truncates here). */
  tip: string;
}

export interface NeedsYouView {
  /** waiting tasks + conflict pairs (a pair counts ONCE). */
  total: number;
  /** Top rows, oldest first, capped at MAX_NEEDS_YOU_ROWS. */
  rows: NeedsYouRowView[];
  /** How many rows the cap hid (0 when everything fits). */
  moreCount: number;
  /**
   * Overflow line: "and 9 more waiting…" when everything hidden is waiting,
   * "and 142 more…" when a conflict is among them. null when moreCount = 0.
   */
  moreText: string | null;
  moreTip: string | null;
}

/* ── freshness / staleness ──────────────────────────────────────────────── */

/** "● Synced 42s ago" — same language as the app titlebar, menubar tips. */
export interface MenubarFreshView {
  text: string;
  tip: string;
  stale: boolean;
}

/** The stale honesty line (decision-github-002) — null unless sync.stale. */
export interface StaleNoteView {
  text: string;
  /** Separates the two channels honestly: hooks live, git facts need fetch. */
  tip: string;
}

/* ── the whole dropdown + item, one derived object ──────────────────────── */

export interface MenubarSummary {
  repoSlug: string;
  repoTip: string;
  fresh: MenubarFreshView;
  staleNote: StaleNoteView | null;
  /** Zero counts are HIDDEN, not rendered (iter-14 precedent). */
  stats: MenubarStatView[];
  badge: MenubarBadgeView | null;
  needsYou: NeedsYouView;
  /** The all-quiet line — null whenever anything needs you. */
  quiet: { text: string; tip: string } | null;
  /** The menubar item's own tooltip — restates what the badge knows. */
  itemTip: string;
  /**
   * Desktop clock text derived from capturedAt (context scaffolding kept
   * consistent with every age in the dropdown — deterministic demos).
   */
  clockText: string;
}
