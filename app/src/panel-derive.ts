/**
 * panel-derive.ts — pure derivations from a TaskPanelSnapshot.
 * Same hard rule as derive.ts: no stored view flags, everything the panel
 * shows is snapshot data or a mechanical join computed here.
 */
import type {
  SessionIdentity,
  TaskPanelSnapshot,
  TimelineEvent,
} from "@vibehub/core/contracts";
import type { MapSnapshot, ScopeDeclaration, Task, TaskState } from "@vibehub/core/contracts";
import { clockTime } from "./derive";

/**
 * Milestone tier — DERIVED, never stored (decision-project-023).
 *
 * The whitelist is mechanical, zero LLM/semantic judgment:
 *   - commit            → 最强锚点 ("commit 为锚")
 *   - state_transition  → 转折为节 (021 transitions)
 *   - launch / user_injection / user_intervention → user actions, MUST always show (023
 *     constraint: 用户的介入动作必入时间线, both tiers)
 *   - question          → carrier of the →waiting transition (every question
 *     flips the task to waiting per 021, so it IS a whitelisted transition;
 *     hiding it would hide the reason the panel is open)
 *
 * Everything else (self_report, agent_ack, file_change, file_read, test_run,
 * cross_read_notice) shows only under "All".
 *
 * NOTE: this is intentionally COARSER than the S2 static's hand-tagged .ms
 * set (which kept self-reports + file bursts) — 023's milestone档 wins over
 * the mock. Fork logged: DECISIONS-NEEDED iter-6.
 */
export function isMilestone(e: TimelineEvent): boolean {
  switch (e.type) {
    case "commit":
    case "state_transition":
    case "launch":
    case "user_injection":
    case "user_intervention":
    case "question":
      return true;
    default:
      return false;
  }
}

/** The Milestones-tier view of a timeline (order preserved). */
export function milestoneEvents(timeline: TimelineEvent[]): TimelineEvent[] {
  return timeline.filter(isMilestone);
}

/**
 * Dot/tint channel per entry (S2 classes): who authored the entry.
 *   - "user"  → blue dot + tinted body (launch, injection)
 *   - "ask"   → red dot + need-tinted body (question)
 *   - "cross" → outline dot, quietest (cross-read notice)
 *   - "agent" → green dot (everything the agent/git did)
 * One visual channel per job (LOOP.md guideline 6).
 */
export type EventVoice = "user" | "ask" | "cross" | "agent";

export function eventVoice(e: TimelineEvent): EventVoice {
  switch (e.type) {
    case "launch":
    case "user_injection":
    case "user_intervention":
      return "user";
    case "question":
      return "ask";
    case "cross_read_notice":
      return "cross";
    default:
      return "agent";
  }
}

/**
 * Mechanical (quiet gray fs-2) entries per S2: tool-level noise.
 * Distinct from the milestone tier: mech styles the entry, tier filters it.
 */
export function isMechanical(e: TimelineEvent): boolean {
  return e.type === "test_run" || e.type === "file_read";
}

/* ── S4 view helpers (chrome copy that explains state semantics — same
      license as derive.ts: templates are chrome, every value is data) ──── */

/**
 * Timestamp-column tooltip: "10:02 — agent self-report via hook event".
 * Copy per event type verbatim from the approved S2 static.
 */
export function timeTip(e: TimelineEvent): string {
  const c = clockTime(e.at);
  switch (e.type) {
    case "launch":
      return `${c} — from the launch dialog`;
    case "self_report":
    case "agent_ack":
      return `${c} — agent self-report via hook event`;
    case "test_run":
    case "file_read":
      return `${c} — from tool-call hook events`;
    case "file_change":
      return `${c} — file edits aggregated from git status between self-reports`;
    case "user_injection":
      return e.mode === "inject"
        ? `${c} — queued injection claimed by a hook for its response`
        : `${c} — queued pause request claimed by a hook for its response`;
    case "user_intervention":
      return e.action === "inject"
        ? `${c} — injection queued from this panel; delivery not yet proven`
        : e.action === "pause"
          ? `${c} — pause requested from this panel; delivery not yet proven`
          : `${c} — conflict pair ignored from the adjudication card`;
    case "question":
      return `${c} — the moment the task flipped to WAITING`;
    case "cross_read_notice":
      return `${c} — from scope-overlap watch (git facts, not inference)`;
    case "commit":
      return `${c} — git commit on the task's branch`;
    case "state_transition":
      return `${c} — state change, mapped mechanically from hook signals`;
  }
}

/* ── identity header ───────────────────────────────────────────────────── */

export interface PanelChipView {
  kind: "w" | "r" | "more";
  label: string;
  tip: string;
}

/** S2 shows at most 2 scope chips; the rest fold into +N (tooltip spells them). */
const MAX_PANEL_SCOPE_CHIPS = 2;

function scopeName(s: ScopeDeclaration, map: MapSnapshot): string {
  return map.territories.find((t) => t.id === s.territoryId)?.name ?? s.label;
}

export function panelScopeChips(task: Task, map: MapSnapshot): PanelChipView[] {
  const chip = (s: ScopeDeclaration): PanelChipView => ({
    kind: s.mode === "write" ? "w" : "r",
    label: `${s.mode === "write" ? "w" : "r"} ${s.label}`,
    tip: `Declared ${s.mode} scope: ${scopeName(s, map)}${
      s.filesTouched !== undefined
        ? ` · ${s.filesTouched} file${s.filesTouched === 1 ? "" : "s"} touched so far`
        : ""
    }`,
  });
  if (task.scopes.length <= MAX_PANEL_SCOPE_CHIPS) return task.scopes.map(chip);
  const visible = task.scopes.slice(0, MAX_PANEL_SCOPE_CHIPS).map(chip);
  const hidden = task.scopes.slice(MAX_PANEL_SCOPE_CHIPS);
  const writes = hidden.filter((s) => s.mode === "write");
  const reads = hidden.filter((s) => s.mode === "read");
  const parts: string[] = [];
  if (writes.length)
    parts.push(`write ${writes.map((s) => scopeName(s, map)).join(", ")}`);
  if (reads.length)
    parts.push(`read ${reads.map((s) => scopeName(s, map)).join(", ")}`);
  const kind = writes.length === 0 ? "read " : reads.length === 0 ? "write " : "";
  return [
    ...visible,
    {
      kind: "more",
      label: `+${hidden.length}`,
      tip: `${hidden.length} more declared ${kind}scope${hidden.length === 1 ? "" : "s"}: ${parts
        .map((p) => p.replace(/^(write|read) /, ""))
        .join(" · ")}`,
    },
  ];
}

/** "session 2 of 2" meta entry + its handoff-fact tooltip. */
export function sessionMeta(s: SessionIdentity): { text: string; tip: string } {
  const text = `session ${s.sessionOrdinal} of ${s.sessionCount}`;
  if (!s.previousEndedAt) {
    return { text, tip: "First session on this task's branch." };
  }
  const when = clockTime(s.previousEndedAt);
  const prev = s.sessionOrdinal - 1;
  const reason =
    s.previousEndReason === "context_limit"
      ? `Session ${prev} hit its context limit at ${when} and handed off.`
      : s.previousEndReason === "user_ended"
        ? `Session ${prev} was ended by you at ${when}.`
        : `Session ${prev} completed at ${when}.`;
  return {
    text,
    tip: `${reason} This is the continuation, same branch and worktree.`,
  };
}

export interface TwistView {
  text: string;
  tip: string;
}

/** Header off-scope marker — evidence, not accusation (S2 copy shape). */
export function twistView(p: TaskPanelSnapshot): TwistView | null {
  if (!p.twist || p.twist.offScopeFiles.length === 0) return null;
  const files = p.twist.offScopeFiles;
  const writeLabels = p.task.scopes
    .filter((s) => s.mode === "write")
    .map((s) => `w ${s.label}`)
    .join(", ");
  const ack = p.twist.acknowledgedByEventId
    ? p.timeline.find((e) => e.id === p.twist!.acknowledgedByEventId)
    : undefined;
  const ackPart = ack
    ? `The agent self-reported why at ${clockTime(ack.at)} — evidence, not an alarm.`
    : "The agent has not mentioned it yet — evidence, not an alarm.";
  return {
    text: `touched ${files.length} file${files.length === 1 ? "" : "s"} outside declared scope`,
    tip: `Footprint left the declared scope: ${files.join(" and ")} ${
      files.length === 1 ? "was" : "were"
    } edited but sit${files.length === 1 ? "s" : ""} outside '${writeLabels}'. ${ackPart}`,
  };
}

/* ── intervention deck ─────────────────────────────────────────────────── */

export type DeckMode = "inject" | "pause";

/** Placeholder narrates the contract of the selected mode (S2 behavior). */
export function deckPlaceholder(state: TaskState, mode: DeckMode): string {
  if (mode === "pause")
    return "Queue a pause request with your thoughts — a hook can claim it at the next turn boundary…";
  return state === "waiting"
    ? "Answer its question, or give a new instruction — queue it for the next hook or turn boundary…"
    : "Give a new instruction — it folds in at the agent's next turn boundary…";
}

export function deckTextareaTip(state: TaskState): string {
  return state === "waiting"
    ? "Free-form reply. It is queued immediately; a later hook records pickup separately."
    : "Free-form message. This action queues the selected mode; it does not prove delivery.";
}
