/**
 * conflict-derive.ts — pure view derivations from a ConflictCardSnapshot.
 * Same hard rule as derive.ts / panel-derive.ts: zero hardcoded CONTENT in
 * JSX. Every string here is either snapshot data or chrome copy that explains
 * state semantics (ported verbatim from the approved S2 static where the S2
 * text was generic; where the S2 text was hand-written prose about specific
 * snapshots — e.g. "the batching rewrite edited…" — the derivation uses the
 * mechanical equivalent built from task titles/timestamps, documented as a
 * tooltip-copy delta in notes/conflict-card.md).
 */
import type { Task, TaskState } from "@vibehub/core/contracts";
import type {
  ConflictCardSnapshot,
  ConflictDiagnosis,
  SharedSymbolEvidence,
} from "@vibehub/core/contracts";
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

export function titleTip(f: ConflictCardSnapshot): string {
  return `${f.crumb.resourceName} — the shared resource where the two footprints intersect. Long names truncate; the full text always lives here.`;
}

export interface AgeView {
  text: string;
  tip: string;
}

/** Header age + the notification-budget honesty tooltip (S2 verbatim). */
export function detectedAge(f: ConflictCardSnapshot): AgeView {
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

export function crumbSegs(f: ConflictCardSnapshot): CrumbSeg[] {
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

export function gradeView(f: ConflictCardSnapshot): GradeView {
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

export function sideViews(f: ConflictCardSnapshot): SideView[] {
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
export function symbolCount(f: ConflictCardSnapshot): SymbolCountView {
  const n = f.symbols.length;
  const base =
    "The concrete symbols where the two footprints intersect — counted from hook file-edit events mapped onto anchors, zero inference";
  return {
    text: formatCount(n),
    tip: n >= 1000 ? `${base} · ${exactCount(n)} symbols exactly` : base,
  };
}

function taskTitle(f: ConflictCardSnapshot, taskId: string): string {
  return f.tasks.find((t) => t.id === taskId)?.title ?? taskId;
}

export interface SymbolRowView {
  name: string;
  nameTip: string;
  /** Right annotation — DERIVED from the two touches, never stored. */
  who: string;
  whoTip: string;
}

export function symbolRow(f: ConflictCardSnapshot, s: SharedSymbolEvidence): SymbolRowView {
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
export function symbolToggle(f: ConflictCardSnapshot): SymbolToggleView | null {
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
 * over what window — read from the snapshot's own touch evidence. The stored
 * counter is authoritative for N (touches keep only the latest per side, so
 * counting touches would undercount — iter-11 fork #3).
 */
export function provenanceView(
  f: ConflictCardSnapshot,
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
export function noteView(f: ConflictCardSnapshot): NoteView {
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
  "Queue a pause request for one task at its next hook boundary. Pick which below.";

export interface PauseRowView {
  task: Task;
  name: string;
  /** "running 31m" / "waiting 5m" — real state + age vs capturedAt. */
  st: string;
  /** Honest no-op: pausing an already-waiting task does nothing (iter-9/10). */
  noop: boolean;
  tip: string;
}

export function pauseRows(f: ConflictCardSnapshot): PauseRowView[] {
  return f.tasks.map((task) => {
    const age = relAge(task.stateSince, f.capturedAt);
    const noop = task.state === "waiting";
    return {
      task,
      name: task.title,
      st: `${task.state} ${age}`,
      noop,
      tip: noop
        ? `Already waiting after asking you a question at ${clockTime(
            task.stateSince,
          )}. Another pause request would be a no-op.`
        : `Queues a pause request for ‘${task.title}’ at its next hook boundary; pickup is recorded separately.`,
    };
  });
}

export function ignoreTip(_f: ConflictCardSnapshot): string {
  return `Permanently silences this canonical task/branch pair across local and merge-tree conflict sources in this repository.`;
}

/* ── zone c: adjudication feedback (S5, preview stub) ─────────────────────────
   Clicking an action swaps the footer for an optimistic feedback band:
   text pill first (SENT / PAUSING / IGNORED), one plain sentence, a visible
   mono "preview" marker whose tooltip is the honesty disclosure (this card
   renders a snapshot — no live session received anything), and a focused
   quiet Close button (keyboard-reachable outcome; closing returns focus to
   the opener via the normal close path). No fake progress, no invented
   agent responses — the band narrates what WOULD land, in future tense
   where the real action is asynchronous ("at its next turn boundary"). */

export const PREVIEW_TIP =
  "Preview — this card renders a snapshot; no live session received this. In the app the action lands at the agents’ next turn boundary.";

export const FEEDBACK_CLOSE = {
  label: "Close card",
  tip: "Close the card and return to the map",
};

export interface FeedbackView {
  /** Text pill — state's first channel. */
  pill: "SENT" | "PAUSING" | "QUEUED" | "REQUESTED" | "IGNORED";
  /** CSS kind for the pill's redundant color channel (neutral family only —
   *  feedback is not a task state; the three semantic colors stay reserved). */
  kind: "done" | "idle";
  text: string;
  tip: string;
}

/**
 * Inject feedback. Empty note + diagnosis ⇒ the send-time default (the
 * Suggested line, marked AI-suggested — iter-10 fork #3). Empty note with
 * NO diagnosis never reaches here: the button focuses the textarea instead
 * (there is nothing to default to — S5 fork).
 */
export function injectFeedback(note: string): FeedbackView {
  const defaulted = note.trim() === "";
  return {
    pill: "SENT",
    kind: "done",
    text: defaulted
      ? "The Suggested line above is queued to both tasks, marked as AI-suggested. Hook pickup and delivery remain separate later facts."
      : "Coordination note queued to both tasks. Hook pickup and delivery remain separate later facts; neither side is interrupted.",
    tip: defaulted
      ? "Empty note ⇒ the diagnosis’s Suggested line is queued verbatim, labeled as AI-suggested (never as your words)."
      : "Both queue rows carry the same note; later hook evidence determines pickup — nothing is paused or interrupted.",
  };
}

export function pauseFeedback(f: ConflictCardSnapshot, task: Task): FeedbackView {
  const other = f.tasks.find((t) => t.id !== task.id);
  return {
    pill: "REQUESTED",
    kind: "idle",
    text: `Pause requested for ‘${task.title}’ at its next hook boundary; pickup is not yet proven.${
      other ? ` No pause was requested for ‘${other.title}’.` : ""
    }`,
    tip: "This receipt records a queued boundary request, not a stopped process or completed delivery.",
  };
}

export function ignoreFeedback(_f: ConflictCardSnapshot): FeedbackView {
  return {
    pill: "IGNORED",
    kind: "idle",
    text: `This task/branch pair is silenced — equivalent conflicts between these two sides won’t surface again.`,
    tip: "Scoped to this canonical pair in this repository, across local and merge-tree conflict sources.",
  };
}

/** Inline ignore confirm (permanence gate — one modest confirm, in place). */
export const IGNORE_CONFIRM = {
  q: "Silence this pair permanently?",
  confirm: "Ignore permanently",
  confirmTip:
    "Yes — never surface this canonical task/branch pair together again in this repository. There is no un-ignore.",
  keep: "Keep",
  keepTip: "Cancel — the pair stays visible.",
};

/* ── zone b: diagnosis run/re-run stub (S5, preview honesty) ───────────────────
   The preview cannot run `claude -p`, and inventing a fresh verdict would be
   fabrication — so the buttons toggle an honest inline note instead of any
   fake progress state. Backticks render mono via the card's codeSpans. */

export const RERUN_STUB =
  "Preview — nothing ran. In the app this is one `claude -p` pass on your machine, and the verdict above refreshes in place.";

export const RUN_STUB =
  "Preview — nothing ran. In the app this is one `claude -p` pass on your machine, and the diagnosis fills in here.";
