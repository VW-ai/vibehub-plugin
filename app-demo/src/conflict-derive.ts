/**
 * conflict-derive.ts — pure view derivations from a ConflictCardFixture.
 * Same hard rule as derive.ts / panel-derive.ts: zero hardcoded CONTENT in
 * JSX. Every string here is either fixture data or chrome copy that explains
 * state semantics (ported verbatim from the approved S2 static where the S2
 * text was generic; where the S2 text was hand-written prose about specific
 * fixtures — e.g. "the batching rewrite edited…" — the derivation uses the
 * mechanical equivalent built from task titles/timestamps, documented as a
 * tooltip-copy delta in notes/conflict-card.md).
 */
import type { Task, TaskState } from "./types";
import type {
  ConflictCardFixture,
  ConflictDiagnosis,
  SharedSymbolEvidence,
} from "./conflict-types";
import { clockTime, exactCount, formatCount, relAge } from "./derive";

/* ── header ────────────────────────────────────────────────────────────── */

/** Long-form age for tooltips ("8 minutes ago"), same rounding as relAge. */
export function longAge(iso: string, capturedAt: string): string {
  const s = Math.max(
    0,
    Math.round((Date.parse(capturedAt) - Date.parse(iso)) / 1000),
  );
  if (s < 60) return `${s} second${s === 1 ? "" : "s"} ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export const CONFLICT_PILL_TIP =
  "Two concurrent tasks’ footprints intersect on the same symbols. Conflict is an attribute of the pair — neither task is blocked yet.";

export const CLOSE_TIP = "Close the card and return to the map";

export const SCRIM_TIP = "Click anywhere on the map to close the conflict card";

export function titleTip(f: ConflictCardFixture): string {
  return `${f.crumb.resourceName} — the shared resource where the two footprints intersect. Long names truncate; the full text always lives here.`;
}

export interface AgeView {
  text: string;
  tip: string;
}

/** Header age + the notification-budget honesty tooltip (S2 verbatim). */
export function detectedAge(f: ConflictCardFixture): AgeView {
  return {
    text: relAge(f.conflict.detectedAt, f.capturedAt),
    tip: `Intersection first detected at ${clockTime(f.conflict.detectedAt)} — ${longAge(
      f.conflict.detectedAt,
      f.capturedAt,
    )}. Repeat hits on this pair merge here; no re-alerts.`,
  };
}

export interface CrumbSeg {
  text: string;
  tip: string;
  mono: boolean;
}

export function crumbSegs(f: ConflictCardFixture): CrumbSeg[] {
  const segs: CrumbSeg[] = [
    { text: f.crumb.territoryName, tip: "Territory on the map", mono: false },
  ];
  if (f.crumb.subBlockName) {
    segs.push({
      text: f.crumb.subBlockName,
      tip: "Sub-block inside the territory — the finer anchor cluster both tasks are inside",
      mono: false,
    });
  }
  segs.push({
    text: f.crumb.anchorFile,
    tip: `${f.crumb.anchorFile} — the file that anchors this cluster`,
    mono: true,
  });
  return segs;
}

/* ── grading strip ─────────────────────────────────────────────────────── */

export interface GradeView {
  /** CSS class: "red" | "yellow". */
  cls: "red" | "yellow";
  /** Mono kicker: "W × W" / "W × R". */
  kicker: string;
  text: string;
  tip: string;
}

export function gradeView(f: ConflictCardFixture): GradeView {
  if (f.conflict.severity === "red") {
    return {
      cls: "red",
      kicker: "W × W",
      text: "Both tasks declared writes here, and both footprints have edited the same symbols. Double-write is the only grade that can notify you.",
      tip: "The grading ladder: same file, different symbols → nothing. Write × read on one symbol → yellow, passive. Write × write → red — the only grade allowed to push a notification, once per pair per day.",
    };
  }
  return {
    cls: "yellow",
    kicker: "W × R",
    text: "One task is writing symbols the other is reading. Passively visible — this grade never pushes.",
    tip: "The grading ladder: same file, different symbols → nothing. Write × read on one symbol → yellow — passively visible, never pushes a notification. Write × write → red.",
  };
}

/* ── zone a1: the two task rows ────────────────────────────────────────── */

export const BETWEEN_TIP =
  "The pair whose footprints intersect. One agent straddling many features never appears here — it takes two concurrent tasks.";

export const SIDE_ROW_TIP =
  "Opens this task’s panel — timeline, transcript, interventions";

/**
 * The card shows the pair's REAL state pill — conflict stays an attribute
 * (020/021), so this deliberately does NOT reuse derive.ts pillView (which
 * promotes conflicted tasks to a CONFLICT pill on the rail). Tips are the
 * S2 card's copy.
 */
const CARD_STATE_PILL: Record<TaskState, { kind: string; text: string; tip: string }> = {
  queued: { kind: "idle", text: "QUEUED", tip: "Created, not launched yet." },
  running: {
    kind: "alive",
    text: "RUNNING",
    tip: "Agent actively producing — tool calls and edits flowing",
  },
  waiting: {
    kind: "need",
    text: "WAITING",
    tip: "Agent stopped and asked a question. Parked until you answer.",
  },
  stalled: {
    kind: "idle",
    text: "STALLED",
    tip: "Alive but silent. Probably stuck — worth a look.",
  },
  done: { kind: "done", text: "DONE", tip: "Session ended. Click for the timeline." },
};

export interface SideChipView {
  kind: "w" | "r" | "n";
  label: string;
  tip: string;
}

export interface SideView {
  task: Task;
  pill: { kind: string; text: string; tip: string };
  chips: SideChipView[];
}

export function sideViews(f: ConflictCardFixture): SideView[] {
  return f.tasks.map((task) => {
    const chips: SideChipView[] = [];
    // The declared scope ON THIS RESOURCE (the conflict's territory/sub-block).
    const scope = task.scopes.find(
      (s) =>
        s.territoryId === f.conflict.territoryId &&
        (f.conflict.subBlockId === undefined || s.subBlockId === f.conflict.subBlockId),
    );
    if (scope) {
      const files =
        scope.filesTouched !== undefined
          ? ` · ${scope.filesTouched} file${scope.filesTouched === 1 ? "" : "s"} touched here so far`
          : " — no writes declared";
      chips.push({
        kind: scope.mode === "write" ? "w" : "r",
        label: `${scope.mode === "write" ? "w" : "r"} ${scope.label}`,
        tip: `Declared ${scope.mode} scope on this resource: ${f.crumb.resourceName}${files}`,
      });
    }
    chips.push({
      kind: "n",
      label: task.git.branch.split("/").pop() ?? task.git.branch,
      tip: `branch ${task.git.branch}${
        task.git.worktreePath ? ` · worktree ${task.git.worktreePath}` : ""
      }`,
    });
    return { task, pill: CARD_STATE_PILL[task.state], chips };
  });
}

/* ── zone a2: shared symbols ───────────────────────────────────────────── */

/** S2: 3 rows shown, the rest fold behind "+N more". */
export const VISIBLE_SYMBOLS = 3;

export interface SymbolCountView {
  text: string;
  tip: string;
}

/** h4 count: NUMBER-huge rule — abbreviate past 999, exact in the tooltip. */
export function symbolCount(f: ConflictCardFixture): SymbolCountView {
  const n = f.symbols.length;
  const base =
    "The concrete symbols where the two footprints intersect — counted from hook file-edit events mapped onto anchors, zero inference";
  return {
    text: formatCount(n),
    tip: n >= 1000 ? `${base} · ${exactCount(n)} symbols exactly` : base,
  };
}

function taskTitle(f: ConflictCardFixture, taskId: string): string {
  return f.tasks.find((t) => t.id === taskId)?.title ?? taskId;
}

export interface SymbolRowView {
  name: string;
  nameTip: string;
  /** Right annotation — DERIVED from the two touches, never stored. */
  who: string;
  whoTip: string;
}

export function symbolRow(f: ConflictCardFixture, s: SharedSymbolEvidence): SymbolRowView {
  const [a, b] = s.touches;
  const bothEdited = a.action === "edit" && b.action === "edit";
  const nameTip = bothEdited
    ? `${s.name} — ${s.file} · both footprints edited this symbol`
    : `${s.name} — ${s.file} · written by one footprint, read by the other`;
  const whoTip = bothEdited
    ? `Edited by '${taskTitle(f, a.taskId)}' at ${clockTime(a.at)} and by '${taskTitle(
        f,
        b.taskId,
      )}' at ${clockTime(b.at)}`
    : `'${taskTitle(f, a.taskId)}' ${a.action === "edit" ? "edited" : "read"} at ${clockTime(
        a.at,
      )} · '${taskTitle(f, b.taskId)}' ${
        b.action === "edit" ? "edited" : "read"
      } at ${clockTime(b.at)}`;
  return {
    name: s.name,
    nameTip,
    who: bothEdited ? "both edited" : "w × r",
    whoTip,
  };
}

export interface SymbolToggleView {
  /** Collapsed label, e.g. "+9 more". */
  moreLabel: string;
  tip: string;
}

/** null when the list fits (N ≤ 3 — the N=1 rung renders no toggle). */
export function symbolToggle(f: ConflictCardFixture): SymbolToggleView | null {
  const hidden = f.symbols.length - VISIBLE_SYMBOLS;
  if (hidden <= 0) return null;
  return {
    moreLabel: `+${exactCount(hidden)} more`,
    tip: `${exactCount(hidden)} more shared symbol${
      hidden === 1 ? "" : "s"
    } — click to expand the full list`,
  };
}

/* ── zone b: AI diagnosis ──────────────────────────────────────────────── */

export const DIAG_H4_TIP =
  "Static evidence above is mechanical and always on. Diagnosis is on-demand: one pass of your local claude reads both sessions and says whether this is a real conflict.";

export const SIDE_LABEL_TIP =
  "What this side is doing, read from its session transcript";

export const SUGGESTED_TIP =
  "The diagnosis’s suggested resolution — a suggestion, not an action. The buttons below are yours.";

export const DIAG_EMPTY = {
  p: "Static evidence only — no AI diagnosis yet.",
  capBefore: "Everything above is mechanical. Whether it is a ",
  capEm: "real",
  capAfter: " conflict takes reading both sessions.",
  button: "Run AI diagnosis",
  buttonTip:
    "Runs one headless pass with your local claude (`claude -p`) — your machine, your account, no extra API key. Reads both sessions and reports what each side is doing and whether the edits actually collide.",
};

export interface ProvenanceView {
  stale: boolean;
  text: string;
  tip: string;
  /** The "· N edits since" marker — null while fresh. */
  edits: { text: string; tip: string } | null;
  rerunTip: string;
}

/**
 * Provenance line + staleness honesty (iter-10 fork #1). The stale tooltip
 * is built mechanically: which sides edited shared symbols after the pass,
 * over what window — read from the fixture's own touch evidence. The stored
 * counter is authoritative for N (touches keep only the latest per side, so
 * counting touches would undercount — iter-11 fork #3).
 */
export function provenanceView(
  f: ConflictCardFixture,
  d: ConflictDiagnosis,
): ProvenanceView {
  const at = clockTime(d.provenance.diagnosedAt);
  const stale = d.stalenessEditsSince > 0;
  const base = `Ran headlessly as \`claude -p\` with both sessions’ context — your machine, your account, no extra API key`;
  if (!stale) {
    return {
      stale: false,
      text: `diagnosed by your local claude · ${at}`,
      tip: `${base}. No edits have landed on these symbols since.`,
      edits: null,
      rerunTip: "Run a fresh pass. Costs one local model call.",
    };
  }
  const n = d.stalenessEditsSince;
  // Evidence window from the touches that postdate the pass (edit only).
  const after = f.symbols
    .flatMap((s) => s.touches)
    .filter((t) => t.action === "edit" && t.at > d.provenance.diagnosedAt)
    .map((t) => t.at)
    .sort();
  const window =
    after.length > 1
      ? ` (${clockTime(after[0]!)} → ${clockTime(after[after.length - 1]!)})`
      : after.length === 1
        ? ` (${clockTime(after[0]!)})`
        : "";
  const editors = [
    ...new Set(
      f.symbols
        .flatMap((s) => s.touches)
        .filter((t) => t.action === "edit" && t.at > d.provenance.diagnosedAt)
        .map((t) => t.taskId),
    ),
  ];
  const who =
    editors.length === 1
      ? `'${taskTitle(f, editors[0]!)}'`
      : "both sides";
  return {
    stale: true,
    text: `diagnosed by your local claude · ${at}`,
    tip: base,
    edits: {
      text: `· ${exactCount(n)} edit${n === 1 ? "" : "s"} since`,
      tip: `${exactCount(n)} shared-symbol edit${
        n === 1 ? "" : "s"
      } — by ${who} — landed after this diagnosis ran${window}. The verdict may no longer hold — Re-run for a fresh pass.`,
    },
    rerunTip: `Run a fresh pass — ${exactCount(n)} edit${
      n === 1 ? "" : "s"
    } landed after this one. Costs one local model call.`,
  };
}

/* ── zone c: adjudication ──────────────────────────────────────────────── */

export interface NoteView {
  placeholder: string;
  tip: string;
}

/**
 * Empty-note contract (iter-10 fork #3): with a diagnosis the placeholder
 * surfaces the send-time default; without one there is nothing to default to.
 */
export function noteView(f: ConflictCardFixture): NoteView {
  if (f.diagnosis) {
    return {
      placeholder:
        "Coordination note — leave empty to send the Suggested line above, verbatim…",
      tip: "The least destructive active move: both agents get the same note at their next turn boundary, without being interrupted. Empty note → the Suggested line above is sent, marked as AI-suggested.",
    };
  }
  return {
    placeholder:
      "Coordination note — one message, queued to both tasks at their next turn boundary…",
    tip: "The least destructive active move: both agents get the same note at their next turn boundary, without being interrupted.",
  };
}

export const INJECT_TIP =
  "Queues this note to both tasks at their next turn boundary. Nothing is paused, nothing is interrupted.";

export const PAUSE_TRIGGER_TIP =
  "Park one task in a waiting state until you resume it — the other side continues. Pick which below.";

export interface PauseRowView {
  task: Task;
  name: string;
  /** "running 31m" / "waiting 5m" — real state + age vs capturedAt. */
  st: string;
  /** Honest no-op: pausing an already-waiting task does nothing (iter-9/10). */
  noop: boolean;
  tip: string;
}

export function pauseRows(f: ConflictCardFixture): PauseRowView[] {
  return f.tasks.map((task) => {
    const age = relAge(task.stateSince, f.capturedAt);
    const noop = task.state === "waiting";
    return {
      task,
      name: task.title,
      st: `${task.state} ${age}`,
      noop,
      tip: noop
        ? `Already parked — it stopped to ask you a question at ${clockTime(
            task.stateSince,
          )}. Pausing a waiting task is a no-op.`
        : `Parks ‘${task.title}’ at its next turn boundary. Resume anytime from its panel.`,
    };
  });
}

export function ignoreTip(f: ConflictCardFixture): string {
  return `Permanently silences THIS pair only — these two tasks on ${f.crumb.resourceName} never surface together again. Any other overlap either task hits still will.`;
}
