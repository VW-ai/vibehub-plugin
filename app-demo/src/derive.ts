/**
 * derive.ts — pure view-model derivations from a MapFixture.
 *
 * HARD RULE (task brief): zero hardcoded CONTENT in JSX. Everything the
 * screen shows is either fixture data or a mechanical join of fixture data
 * computed here. The only literals allowed are UI copy that explains state
 * semantics (pill words, legend words, empty-state guidance) — those are
 * chrome, not data, and are honest per LOOP.md guideline 4.
 */
import type {
  Conflict,
  MapFixture,
  ScopeDeclaration,
  SubBlock,
  Task,
  TaskState,
  Territory,
  TerritoryOccupancy,
} from "./types";

/* ── formatting primitives ─────────────────────────────────────────────── */

/** Relative age vs capturedAt: "42s", "12m", "3h" (deterministic). */
export function relAge(iso: string, capturedAt: string): string {
  const s = Math.max(
    0,
    Math.round((Date.parse(capturedAt) - Date.parse(iso)) / 1000),
  );
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

/**
 * Wall-clock "09:40" straight from the ISO string's own local part —
 * no Date/timezone involvement, so demos render identically everywhere.
 */
export function clockTime(iso: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}` : iso;
}

/**
 * NUMBER-huge rung (scale-extremes): abbreviate ≥1000 to "8.4k" / "100k";
 * the exact value always travels in the tooltip (exactCount).
 */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) {
    const k = Math.round(n / 100) / 10;
    return `${Number.isInteger(k) ? k.toFixed(0) : k}k`;
  }
  return `${Math.round(n / 1000)}k`;
}

export function exactCount(n: number): string {
  return n.toLocaleString("en-US");
}

/* ── pills (state = text first, color reinforces) ──────────────────────── */

export type PillKind = "need" | "clash" | "alive" | "idle" | "done";

export interface PillView {
  kind: PillKind;
  text: string;
  tip: string;
}

const STATE_PILL: Record<TaskState, { kind: PillKind; text: string; ui: string }> = {
  queued: { kind: "idle", text: "QUEUED", ui: "Created, not launched yet." },
  running: {
    kind: "alive",
    text: "RUNNING",
    ui: "Agent actively producing — nothing needed from you.",
  },
  waiting: {
    kind: "need",
    text: "WAITING",
    ui: "Agent stopped and asked a question. Parked until you answer.",
  },
  stalled: {
    kind: "idle",
    text: "STALLED",
    ui: "Alive but silent. Probably stuck — worth a look.",
  },
  done: { kind: "done", text: "DONE", ui: "Session ended. Click for the timeline." },
};

export function pillView(task: Task): PillView {
  // Conflict is an attribute, but it takes the pill (v8): the pill answers
  // "what should I do right now", and adjudicating beats everything else.
  if (task.conflictIds.length > 0) {
    return {
      kind: "clash",
      text: "CONFLICT",
      tip: task.statusDetail ?? "Writing the same symbol as another task. Click to adjudicate.",
    };
  }
  const base = STATE_PILL[task.state];
  let tip = task.statusDetail ?? base.ui;
  if (task.signalTier === "basic") {
    // Honesty: weak tier — label the reduced perception, never fake detail.
    tip += " Reduced perception: basic signal (file watcher + process liveness only).";
  }
  return { kind: base.kind, text: base.text, tip };
}

/** Rail age column: done shows wall-clock, everything else relative. */
export function taskAge(task: Task, fx: MapFixture): string {
  return task.state === "done"
    ? clockTime(task.stateSince)
    : relAge(task.stateSince, fx.capturedAt);
}

/* ── rail grouping ─────────────────────────────────────────────────────── */

export interface TaskGroup {
  title: string;
  tasks: Task[];
}

/**
 * v8 grouping rule: a conflict "needs you" exactly once — the pair's first
 * task (conflict.taskIds[0], the earlier writer) sits in "Needs you", the
 * other side stays in its state group. Waiting always needs you.
 */
export function groupTasks(fx: MapFixture): TaskGroup[] {
  const primaryConflictTask = new Set(fx.conflicts.map((c) => c.taskIds[0]));
  const needsYou: Task[] = [];
  const running: Task[] = [];
  const queued: Task[] = [];
  const done: Task[] = [];
  for (const t of fx.tasks) {
    if (t.state === "waiting" || primaryConflictTask.has(t.id)) needsYou.push(t);
    else if (t.state === "running" || t.state === "stalled") running.push(t);
    else if (t.state === "queued") queued.push(t);
    else done.push(t);
  }
  return [
    { title: "Needs you", tasks: needsYou },
    { title: "Running", tasks: running },
    { title: "Queued", tasks: queued },
    { title: "Done today", tasks: done },
  ].filter((g) => g.tasks.length > 0);
}

/* ── chips (one line, overflow collapses to +N) ────────────────────────── */

export type ChipKind = "w" | "r" | "n" | "more";

export interface ChipView {
  kind: ChipKind;
  label: string;
  tip: string;
}

const MAX_CHIPS = 3; // v8: a card never shows more than 3 chips on its line

function scopeTargetName(s: ScopeDeclaration, fx: MapFixture): string {
  const terr = fx.territories.find((t) => t.id === s.territoryId);
  if (!terr) return s.label;
  if (s.subBlockId) {
    const sub = terr.subBlocks.find((b) => b.id === s.subBlockId);
    if (sub) return sub.name;
  }
  return terr.name;
}

function scopeChip(s: ScopeDeclaration, fx: MapFixture): ChipView {
  const name = scopeTargetName(s, fx);
  const files =
    s.filesTouched !== undefined
      ? ` · ${s.filesTouched} file${s.filesTouched === 1 ? "" : "s"} touched`
      : "";
  return {
    kind: s.mode === "write" ? "w" : "r",
    label: `${s.mode === "write" ? "w" : "r"} ${s.label}`,
    tip: `Declared ${s.mode} scope: ${name}${files}`,
  };
}

export function taskChips(task: Task, fx: MapFixture): ChipView[] {
  // Done + merged PR: git facts replace scope chips entirely (v8).
  if (task.state === "done" && task.git.prNumber && task.git.prState === "merged") {
    return [
      {
        kind: "n",
        label: `PR #${task.git.prNumber} merged`,
        tip: `Merged via PR #${task.git.prNumber} · branch ${task.git.branch}`,
      },
    ];
  }
  const branchChip: ChipView = {
    kind: "n",
    label: task.git.branch.split("/").pop() ?? task.git.branch,
    tip: `branch ${task.git.branch}${task.git.worktreePath ? ` · worktree ${task.git.worktreePath}` : ""}`,
  };
  const all: ChipView[] = [...task.scopes.map((s) => scopeChip(s, fx)), branchChip];
  if (all.length <= MAX_CHIPS) return all;
  // Collapse: keep the first two scope chips, fold the rest (incl. branch)
  // into +N whose tooltip spells everything out (v8 "+3" behavior).
  const visible = all.slice(0, MAX_CHIPS - 1);
  const hiddenScopes = task.scopes.slice(MAX_CHIPS - 1);
  const reads = hiddenScopes
    .filter((s) => s.mode === "read")
    .map((s) => scopeTargetName(s, fx));
  const writes = hiddenScopes
    .filter((s) => s.mode === "write")
    .map((s) => scopeTargetName(s, fx));
  const parts = [`branch ${task.git.branch}`];
  if (writes.length) parts.push(`writes ${writes.join(", ")}`);
  if (reads.length) parts.push(`reads ${reads.join(", ")}`);
  return [
    ...visible,
    { kind: "more", label: `+${all.length - visible.length}`, tip: parts.join(" · ") },
  ];
}

/* ── titlebar ──────────────────────────────────────────────────────────── */

export interface StatView {
  kind: "need" | "clash" | "alive";
  text: string;
  tip: string;
}

export function titlebarStats(fx: MapFixture): StatView[] {
  const waiting = fx.tasks.filter((t) => t.state === "waiting").length;
  const conflicts = fx.conflicts.length;
  const running = fx.tasks.filter((t) => t.state === "running").length;
  const stats: StatView[] = [];
  if (waiting > 0)
    stats.push({
      kind: "need",
      text: `${waiting} waiting`,
      tip:
        waiting === 1
          ? "One task is waiting on your input — click to jump to it"
          : `${waiting} tasks are waiting on your input — click to jump to them`,
    });
  if (conflicts > 0)
    stats.push({
      kind: "clash",
      text: `${conflicts} conflict${conflicts === 1 ? "" : "s"}`,
      tip: "Two tasks are writing the same symbol — click to open the conflict",
    });
  if (running > 0)
    stats.push({
      kind: "alive",
      text: `${running} running`,
      tip: "Tasks making progress. Nothing needed from you",
    });
  return stats;
}

export interface FreshView {
  text: string;
  tip: string;
  stale: boolean;
}

export function freshness(fx: MapFixture): FreshView {
  if (fx.sync.lastFetchAt === null) {
    return {
      text: "Never synced",
      tip: "No git fetch has happened yet · click to sync now",
      stale: true,
    };
  }
  return {
    text: `Synced ${relAge(fx.sync.lastFetchAt, fx.capturedAt)} ago`,
    tip: "Last git fetch + hook event · click to sync now",
    stale: fx.sync.stale,
  };
}

/* ── territories ───────────────────────────────────────────────────────── */

export interface SubView {
  sub: SubBlock;
  kind: "clash" | "w" | "plain";
  /** Breathing counter text for clash subs, e.g. "2 writing". */
  cnt?: string;
  tip: string;
  style: { left?: number; top?: number; right?: number; bottom?: number };
}

export interface FootView {
  text: string;
  tip?: string | undefined;
  needInk: boolean;
}

export interface TerritoryView {
  terr: Territory;
  /** Extra CSS classes on .terr: "w", "r", "quiet" (v8 semantics). */
  classes: string[];
  labelText: string;
  tip: string;
  foot?: FootView | undefined;
  subs: SubView[];
  /** SPACE-tiny rung: abbreviated foot for small rects. */
  compact: boolean;
}

function taskById(fx: MapFixture, id: string): Task | undefined {
  return fx.tasks.find((t) => t.id === id);
}

/**
 * Effective occupancy. v8 rule: a task both writing and reading the same
 * territory counts as a WRITER only — its read does not tint the territory
 * "r" (t-pay stays green although its writer also reads Reconciliation).
 */
function occupancyOf(fx: MapFixture, territoryId: string): TerritoryOccupancy {
  const raw = fx.occupancy.find((o) => o.territoryId === territoryId) ?? {
    territoryId,
    writingTaskIds: [],
    readingTaskIds: [],
    doneTodayTaskIds: [],
  };
  return {
    ...raw,
    readingTaskIds: raw.readingTaskIds.filter(
      (id) => !raw.writingTaskIds.includes(id),
    ),
  };
}

function conflictsIn(fx: MapFixture, territoryId: string): Conflict[] {
  return fx.conflicts.filter((c) => c.territoryId === territoryId);
}

function footFor(
  fx: MapFixture,
  occ: TerritoryOccupancy,
  compact: boolean,
): FootView | undefined {
  const writers = occ.writingTaskIds
    .map((id) => taskById(fx, id))
    .filter((t): t is Task => !!t);
  const nW = writers.length;
  const nR = occ.readingTaskIds.length;
  const nD = occ.doneTodayTaskIds.length;
  const waitingWriter = writers.find((t) => t.state === "waiting");
  const allStalled = nW > 0 && writers.every((t) => t.state === "stalled");

  if (compact) {
    // Degradation ladder rung 2: abbreviated foot ("1w · 2r"); tooltip = full.
    const parts: string[] = [];
    if (nW) parts.push(`${nW}w`);
    if (nR) parts.push(`${nR}r`);
    if (nD) parts.push(`${nD} done`);
    if (!parts.length) parts.push("quiet");
    const full: string[] = [];
    if (nW) full.push(`${nW} writing${allStalled ? " (stalled)" : ""}`);
    if (nR) full.push(`${nR} reading`);
    if (nD) full.push(`${nD} done today`);
    if (!full.length) full.push("quiet today");
    return {
      text: parts.join(" · "),
      tip: full.join(" · "),
      needInk: !!waitingWriter,
    };
  }

  const parts: string[] = [];
  if (nW) parts.push(`${nW} writing${allStalled ? " (stalled)" : ""}`);
  if (waitingWriter) parts.push("waiting on you");
  if (nR) parts.push(`${nR} reading`);
  if (nW === 0 && nR === 0) {
    parts.push("quiet");
    if (nD) parts.push(`${nD} done today`);
  } else if (nD) {
    parts.push(`${nD} done today`);
  }
  if (!parts.length) return undefined;

  let tip: string | undefined;
  if (waitingWriter) {
    tip = `'${waitingWriter.title}' — ${waitingWriter.statusDetail ?? "waiting on your input."} Waiting ${relAge(waitingWriter.stateSince, fx.capturedAt)} — click to answer.`;
  } else if (nW || nR) {
    const bits: string[] = [];
    if (nW) bits.push(`Writing: ${writers.map((t) => t.title).join(", ")}`);
    if (nR)
      bits.push(
        `Reading: ${occ.readingTaskIds
          .map((id) => taskById(fx, id)?.title ?? id)
          .join(", ")}`,
      );
    tip = bits.join(" · ");
  } else if (nD) {
    tip = `Finished today: ${occ.doneTodayTaskIds
      .map((id) => taskById(fx, id)?.title ?? id)
      .join(", ")}`;
  }
  return { text: parts.join(" · "), tip, needInk: !!waitingWriter };
}

function subViews(fx: MapFixture, terr: Territory): SubView[] {
  return terr.subBlocks.map((sub) => {
    const conflict = fx.conflicts.find(
      (c) => c.territoryId === terr.id && c.subBlockId === sub.id,
    );
    const writers = fx.tasks.filter((t) =>
      t.scopes.some(
        (s) => s.mode === "write" && s.territoryId === terr.id && s.subBlockId === sub.id,
      ),
    );
    const style = terr.demoSubLayout?.[sub.id] ?? {};
    if (conflict) {
      return {
        sub,
        kind: "clash" as const,
        cnt: `${writers.length || conflict.taskIds.length} writing`,
        tip: `${sub.name} — both tasks declared writes on ${conflict.sharedSymbols.length} shared symbols. Click for evidence + AI diagnosis.`,
        style,
      };
    }
    if (writers.length) {
      return {
        sub,
        kind: "w" as const,
        tip: `${sub.name} — ${writers.map((t) => `'${t.title}'`).join(", ")} writing`,
        style,
      };
    }
    return { sub, kind: "plain" as const, tip: `${sub.name} · quiet today`, style };
  });
}

/**
 * SPACE-tiny threshold: below this rect size the foot switches to the
 * abbreviated rung. Tuned against extreme-forty-territories (11.4%×17.8%
 * rects at 1280×800 ≈ 106×126 px) — tunable, awaits real layout algorithm.
 */
const COMPACT_W_PCT = 14;
const COMPACT_H_PCT = 22;

export function territoryView(terr: Territory, fx: MapFixture): TerritoryView {
  const occ = occupancyOf(fx, terr.id);
  const nW = occ.writingTaskIds.length;
  const nR = occ.readingTaskIds.length;
  const nD = occ.doneTodayTaskIds.length;
  const clashes = conflictsIn(fx, terr.id);
  const classes: string[] = [];
  if (nW) classes.push("w");
  if (nR) classes.push("r");
  if (!nW && !nR) classes.push("quiet");

  const compact =
    !!terr.demoLayout &&
    (terr.demoLayout.width < COMPACT_W_PCT || terr.demoLayout.height < COMPACT_H_PCT);

  const summary: string[] = [];
  if (nW && nR) summary.push(`${nW} writing, ${nR} reading`);
  else if (nW) summary.push(`${nW} task${nW === 1 ? "" : "s"} writing`);
  else if (nR) summary.push(`${nR} reading`);
  else summary.push("no active tasks");
  if (clashes.length) summary.push(`${clashes.length} conflict`);
  if (nD) summary.push(`${nD} finished today`);

  const writers = occ.writingTaskIds
    .map((id) => taskById(fx, id))
    .filter((t): t is Task => !!t);
  const stalledWriter = writers.find((t) => t.state === "stalled");
  const tipTail = stalledWriter
    ? ` · writer stalled ${relAge(stalledWriter.stateSince, fx.capturedAt)} — click the task for details`
    : "";

  // NUMBER-huge rung: abbreviate on the primary surface, exact in parens.
  const n = terr.anchoredFileCount;
  const files =
    n >= 1000
      ? `${formatCount(n)} anchored files (${exactCount(n)} exactly)`
      : `${n} anchored files`;

  return {
    terr,
    classes,
    labelText: terr.name.toUpperCase(),
    tip: `${terr.name} · ${files} · ${summary.join(", ")}${tipTail}`,
    foot: terr.subBlocks.length ? undefined : footFor(fx, occ, compact),
    subs: subViews(fx, terr),
    compact,
  };
}

/* ── correlate-hover / legend filter ───────────────────────────────────── */

export type LegendKind = "w" | "r" | "clash" | "quiet";

export interface Highlight {
  /** territory + sub-block ids to keep lit while everything else dims. */
  litIds: Set<string>;
  /** task ids to keep at full opacity while the rail dims. */
  hotTaskIds: Set<string>;
}

export function highlightForTask(task: Task, fx: MapFixture): Highlight {
  const litIds = new Set<string>();
  for (const s of task.scopes) {
    litIds.add(s.territoryId);
    if (s.subBlockId) litIds.add(s.subBlockId);
  }
  // Conflicted sub-blocks light their pair-partner's territory context too
  // (v8: hovering either conflict card lights the shared sub + territory).
  for (const cid of task.conflictIds) {
    const c = fx.conflicts.find((k) => k.id === cid);
    if (c) {
      litIds.add(c.territoryId);
      if (c.subBlockId) litIds.add(c.subBlockId);
    }
  }
  return { litIds, hotTaskIds: new Set([task.id]) };
}

export function highlightForLegend(kind: LegendKind, fx: MapFixture): Highlight {
  const litIds = new Set<string>();
  for (const terr of fx.territories) {
    const occ = occupancyOf(fx, terr.id);
    const hasClash = conflictsIn(fx, terr.id).length > 0;
    const hit =
      kind === "w"
        ? occ.writingTaskIds.length > 0
        : kind === "r"
          ? occ.readingTaskIds.length > 0
          : kind === "clash"
            ? hasClash
            : occ.writingTaskIds.length === 0 && occ.readingTaskIds.length === 0;
    if (hit) {
      litIds.add(terr.id);
      if (kind === "clash") {
        for (const c of conflictsIn(fx, terr.id)) if (c.subBlockId) litIds.add(c.subBlockId);
      }
    }
  }
  const hotTaskIds = new Set<string>();
  if (kind !== "quiet") {
    for (const t of fx.tasks) {
      if (t.scopes.some((s) => litIds.has(s.territoryId))) hotTaskIds.add(t.id);
    }
  }
  return { litIds, hotTaskIds };
}

export const LEGEND_ITEMS: { kind: LegendKind; text: string; tip: string }[] = [
  { kind: "w", text: "writing", tip: "Territories with an active writer" },
  { kind: "r", text: "reading", tip: "Territories being read" },
  { kind: "clash", text: "conflict", tip: "Two concurrent writers on the same symbol" },
  { kind: "quiet", text: "quiet", tip: "No activity today" },
];
