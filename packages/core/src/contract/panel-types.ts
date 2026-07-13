/**
 * Contract types — canonical home in core (decision-project-012; same
 * treatment as map-types.ts). VERBATIM from workbench/app-demo/src/panel-types.ts
 * except the ./types import path is retargeted to ./map-types.js. The demo
 * keeps its copy until M1 slice ④; edits must be mirrored until then.
 */
/**
 * Task-panel data types — everything the panel (static/task-panel-s2.html,
 * the approved S2 artifact) renders. EXTENDS the map's types (./types.ts);
 * shared concepts (Task, TaskState, scopes, git facts) are imported, never
 * duplicated.
 *
 * SIGNAL DISCIPLINE (same hard rule as types.ts): every field must be
 * derivable from the signal inventory only —
 *   1. Claude Code hook events — each event type below is annotated with its
 *      source hook: UserPromptSubmit / PostToolUse / Notification / Stop.
 *      Hook payloads include timestamps, tool names + inputs, and
 *      transcript_path (the raw session transcript on disk).
 *   2. git facts — branch, worktree list, status/diff between hook events,
 *      commit log.                                     → decision-github-002
 *   3. gh CLI queries — PR/issue state.                → decision-github-002
 *   4. user's own declarations at launch (scope r/w).  → decision-project-020
 *   5. the user's own panel actions (launch prompt, injections) — these are
 *      inputs we forward, so we hold them verbatim.
 *
 * NO invented fields: no sentiment, no confidence, no progress-%. Honesty
 * beats pretty (LOOP.md guideline 4).
 *
 * MILESTONE TIER IS DERIVED, NEVER STORED. decision-project-023 defines the
 * milestone档 as a mechanical whitelist (commit + state transition + user
 * actions; zero LLM judgment). Storing a flag would let fixtures lie about
 * it. See isMilestone() in ./panel-derive.ts for the single derivation.
 */
import type { Task, TaskState } from "./map-types.js";

/* ── timeline events ────────────────────────────────────────────────────── */

/** Every timeline entry: stable id + the hook/git timestamp (ISO 8601). */
export interface TimelineEventBase {
  id: string;
  /** When the source signal fired (hook event timestamp / git commit time). */
  at: string;
}

/**
 * The user's founding instruction — shown verbatim, tinted as human-authored.
 * SOURCE: UserPromptSubmit hook (the first prompt of session 1 on this
 * task's branch). The prompt text travels in the hook payload.
 */
export interface LaunchEvent extends TimelineEventBase {
  type: "launch";
  /** Verbatim prompt. Never truncated in data — clamping is a UI concern. */
  prompt: string;
  /**
   * Claude Code's own prompt UUID (hook payload `prompt_id`) — full-chain
   * traceability back to the exact input (decision-workbench-001). Absent
   * on older Claude Code versions.
   */
  promptId?: string;
}

/**
 * Agent narrates its own plan/progress (decision-project-022) — the backbone
 * of the timeline.
 * SOURCE: Stop hook → transcript_path; the report is the agent's own final
 * assistant text for that turn, taken verbatim. Never synthesized by us.
 */
export interface SelfReportEvent extends TimelineEventBase {
  type: "self_report";
  /** Leading bolded word from the report itself ("Started." / "Update."). */
  kicker?: string;
  /** Verbatim narrative sentence(s). */
  text: string;
  /**
   * Mechanical corroboration: when the git footprint at report time also
   * shows off-scope files, the system notes that the agent's story and the
   * facts agree (rendered as the quiet "system flagged the same thing" sub).
   * SOURCE: git status/diff vs declared scopes — a fact, not inference.
   */
  footprintCorroboration?: { offScopeFiles: string[] };
}

/** One file inside an aggregated change burst. */
export interface ChangedFile {
  /** Repo-relative path (git fact). */
  path: string;
  /**
   * True when the file matches no declared WRITE scope (decision-project-020
   * declarations × distillation anchor mapping) — rendered in clash ink.
   */
  offScope: boolean;
}

/**
 * File edits aggregated into one entry per work burst (023: 文件变动折叠) —
 * collapsed to "N files changed", expandable.
 * SOURCE: PostToolUse hook events (Edit/Write/MultiEdit tool calls), grouped
 * between consecutive self-reports; paths cross-checked against git status.
 */
export interface FileChangeEvent extends TimelineEventBase {
  type: "file_change";
  /** Deduped files of the burst, in first-touch order. */
  files: ChangedFile[];
}

/**
 * Aggregated read burst ("Read 3 files in Storage Layer") — mechanical,
 * All-tier only.
 * SOURCE: PostToolUse hook events (Read tool calls), grouped per burst;
 * territory attribution via the distillation anchor map.
 */
export interface FileReadEvent extends TimelineEventBase {
  type: "file_read";
  /** Distinct files read in the burst. */
  count: number;
  /** Territory name the reads clustered in (distillation output). */
  territoryName: string;
  /** True when the territory is covered by a declared read scope. */
  inDeclaredScope: boolean;
}

/**
 * A test-suite run — mechanical, All-tier only.
 * SOURCE: PostToolUse hook (Bash tool running the project's test command);
 * pass/fail counts parsed from the tool result, exit code from the hook.
 */
export interface TestRunEvent extends TimelineEventBase {
  type: "test_run";
  passed: number;
  failed: number;
  /**
   * The agent's own stated purpose for the run, verbatim from the tool
   * call's description field (agent-authored, hook-carried) — e.g.
   * "baseline before edits". Absent when the agent gave none.
   */
  note?: string;
}

/**
 * The user's mid-flight message from the intervention deck (023: 介入必入史,
 * both tiers, never hidden — constraint "用户的介入动作必入时间线").
 * SOURCE: the panel's own Send action; delivered through the next hook that
 * carries guidance. Stop uses decision:block + reason as the fast lane and
 * wakes the conversation; UserPromptSubmit/PostToolUse/SessionStart deliver
 * additionalContext as fallback boundaries.
 */
export interface UserInjectionEvent extends TimelineEventBase {
  type: "user_injection";
  /** Which deck mode sent it: continue-current-task guidance vs stop-first. */
  mode: "inject" | "pause";
  /** Verbatim message. */
  text: string;
  /** Claude Code prompt UUID when the injection was typed in the terminal
   *  (UserPromptSubmit hook); absent for deck-queued injections. */
  promptId?: string;
  /**
   * Milestone-tier verdict (decision-workbench-001): terminal-typed prompts
   * get the precision-first mechanical heuristic (only strong signals reach
   * milestone tier; all others remain in the default timeline). Absent
   * for deck injections — a deliberate intervention is always milestone
   * (decision-project-023: 介入必入两档).
   */
  classification?: "milestone" | "default";
}

/**
 * Agent confirms how it absorbed an injection.
 * SOURCE: Stop hook → transcript_path (the first self-report following the
 * injection); linked to the injection mechanically by order, not semantics.
 */
export interface AgentAckEvent extends TimelineEventBase {
  type: "agent_ack";
  kicker?: string;
  text: string;
  /** The user_injection this responds to (id into the same timeline). */
  ackOfEventId: string;
}

/**
 * Agent stopped and asked — the waiting cause, the panel's loudest entry.
 * SOURCE: Notification hook (agent awaiting input) + Stop hook; the question
 * text verbatim from the hook payload / transcript tail.
 * A question ALWAYS flips the task to waiting (decision-project-021), so it
 * carries the transition — which is what makes it milestone-tier (023: the
 * transition is whitelisted; this event is its carrier).
 */
export interface QuestionEvent extends TimelineEventBase {
  type: "question";
  /** Verbatim question. */
  text: string;
  /** The state transition this question caused. */
  transitionTo: Extract<TaskState, "waiting">;
}

/**
 * Read/read overlap with a concurrent task — NOT a conflict (020: read/write
 * grading), rendered deliberately quiet, All-tier only.
 * SOURCE: PostToolUse Read events of both sessions intersected on the same
 * path (scope-overlap watch over git facts + hooks — mechanical, no inference).
 */
export interface CrossReadNoticeEvent extends TimelineEventBase {
  type: "cross_read_notice";
  /** The shared file (repo-relative). */
  file: string;
  /** The other concurrent task (id into MapFixture.tasks). */
  otherTaskId: string;
  /** Its title, denormalized so the panel renders standalone. */
  otherTaskTitle: string;
}

/**
 * A commit landed on the task's branch — the strongest milestone anchor
 * (023: commit 为锚).
 * SOURCE: PostToolUse hook (Bash `git commit` success), confirmed against
 * `git log` on the branch. sha/message/stat are pure git facts.
 */
export interface CommitEvent extends TimelineEventBase {
  type: "commit";
  /** Abbreviated sha (git fact). */
  sha: string;
  /** Commit subject line, verbatim. */
  message: string;
  /** Files in the commit (git show --stat). */
  filesChanged?: number;
}

/**
 * The task changed state (decision-project-021's five states; milestone-tier
 * per 023: 转折为节).
 * SOURCE: the same hook mapping that drives the map's state machine —
 * Notification (→waiting), Stop (→done), heartbeat silence (→stalled),
 * tool-call resumption (→running). `cause` is the verbatim hook detail.
 */
export interface StateTransitionEvent extends TimelineEventBase {
  type: "state_transition";
  from: TaskState;
  to: TaskState;
  /** One verbatim sentence from the hook payload. Never synthesized. */
  cause?: string;
}

/**
 * Everything the S2 timeline renders, as a discriminated union on `type`.
 * (file_read is an addition over the original 10-member brief list — the S2
 * 10:28 "Read 3 files…" row is covered by no other member; see
 * DECISIONS-NEEDED iter-6.)
 */
export type TimelineEvent =
  | LaunchEvent
  | SelfReportEvent
  | FileChangeEvent
  | FileReadEvent
  | TestRunEvent
  | UserInjectionEvent
  | AgentAckEvent
  | QuestionEvent
  | CrossReadNoticeEvent
  | CommitEvent
  | StateTransitionEvent;

/* ── session identity (panel header meta row) ───────────────────────────── */

/**
 * Who/where is running this task. Branch + worktree live on Task.git
 * (types.ts) — NOT duplicated here.
 */
export interface SessionIdentity {
  /** Runtime driving the task, e.g. "Claude Code" — from hook metadata. */
  agent: string;
  /**
   * "session 2 of 2": 1-based position + total count of sessions on this
   * task's branch. SOURCE: counting session transcripts (transcript_path
   * roots) associated with the branch — a filesystem/git fact.
   */
  sessionOrdinal: number;
  sessionCount: number;
  /**
   * When the previous session ended and how, for the meta tooltip
   * ("Session 1 hit its context limit at 09:55 and handed off").
   * SOURCE: previous session's Stop hook timestamp + its transcript's
   * terminal state. Absent for session 1.
   */
  previousEndedAt?: string;
  previousEndReason?: "context_limit" | "user_ended" | "completed";
}

/* ── twist evidence (header off-scope marker) ───────────────────────────── */

/**
 * Declared scope vs observed footprint diff — the header's amber marker.
 * The DECLARED side already lives in Task.scopes (types.ts); this carries
 * only the observed delta, so the diff is a pure join of the two.
 * SOURCE: hook file-edit events (footprint) minus declared write scopes
 * mapped through distillation anchors. Evidence, not accusation.
 */
export interface TwistEvidence {
  /** Footprint files matching no declared write scope (repo-relative). */
  offScopeFiles: string[];
  /**
   * The self_report event where the agent itself acknowledged the twist,
   * when one exists — the tooltip cross-references it so the marker reads
   * as corroborated evidence. Linked by id, mechanically.
   */
  acknowledgedByEventId?: string;
}

/* ── fixture root ───────────────────────────────────────────────────────── */

/** Everything the task panel needs to render one frame. */
export interface TaskPanelFixture {
  /**
   * The "now" of the snapshot (ISO 8601). All ages ("12m", "3h", "2d")
   * derive from timestamps vs this — deterministic, no Date.now.
   * Formatting rule: relAge() in ./derive.ts (s → m → h → d rungs).
   */
  capturedAt: string;
  /** The task itself — the map's own type, unchanged. */
  task: Task;
  session: SessionIdentity;
  /** Absent = footprint fully inside declared scope (no marker). */
  twist?: TwistEvidence;
  /** Chronological (ascending `at`). Milestone tier is DERIVED, see panel-derive. */
  timeline: TimelineEvent[];
  /**
   * Read-only raw tail behind the "View transcript" toggle, one line per
   * entry. SOURCE: tail of the transcript file at the session's
   * transcript_path (hook-provided). Empty = nothing emitted yet.
   */
  transcriptTail: string[];
}
