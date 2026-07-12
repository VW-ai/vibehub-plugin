/**
 * Conflict-card data types — everything the adjudication card
 * (static/conflict-card-s2.html, the approved S2 artifact) renders.
 * EXTENDS the map's types (./types.ts): Conflict, Task, states, scopes and
 * git facts are imported, never duplicated.
 *
 * SIGNAL DISCIPLINE (same hard rule as types.ts / panel-types.ts): every
 * field must be derivable from the signal inventory only —
 *   1. Claude Code hook events — PostToolUse Edit/Write/Read calls (with
 *      timestamps + file paths) are what "footprint" means; Notification /
 *      Stop drive the pair's task states.       → decision-project-016 / 021
 *   2. git facts — branch, worktree list.       → decision-github-002
 *   3. gh CLI queries — PR / issue state.       → decision-github-002
 *   4. local distillation output — symbol/anchor names, territory and
 *      sub-block names, anchoring files.        → decision-github-001 row 2
 *   5. user's own declarations at launch (scope r/w). → decision-project-020
 *   6. `claude -p` diagnosis output — the ONE non-mechanical source on this
 *      card. Everything from it is quoted VERBATIM and labeled with explicit
 *      provenance (engine + time + staleness); we never synthesize or edit
 *      its text. The card's zone (a) stays 100% mechanical; only zone (b)
 *      carries model output.
 *
 * NO invented fields: no severity score, no "confidence", no predicted merge
 * outcome — honesty beats pretty (LOOP.md guideline 4).
 *
 * DERIVED, NEVER STORED (same principle as the milestone tier in
 * panel-types.ts): the per-symbol "both edited" / "w × r" annotation is a
 * pure function of the two touches' actions; the ">999 → 1.2k" count
 * abbreviation reuses formatCount/exactCount from ./derive.ts (the map's
 * NUMBER-huge rule: abbreviate on the surface, exact in the tooltip).
 */
import type { Conflict, Task } from "./types";

/* ── shared-symbol evidence (zone a2) ───────────────────────────────────── */

/**
 * One side's latest touch on a shared symbol.
 * SOURCE: PostToolUse hook events — Edit/Write tool calls ⇒ "edit",
 * Read tool calls ⇒ "read" — mapped onto distillation anchors. For a
 * teammate branch with no local session, the edit fact comes from
 * `git merge-tree` / diff-hunk→anchor mapping instead (decision-github-002);
 * the shape is identical.
 */
export interface SymbolTouch {
  /** Which side (id into ConflictCardFixture.tasks / conflict.taskIds). */
  taskId: string;
  action: "edit" | "read";
  /**
   * When the LATEST touch landed (ISO 8601, hook event timestamp). Only the
   * latest per side per symbol is kept — full edit history lives in the
   * session transcript, not here.
   */
  at: string;
}

/**
 * One row of the "Shared symbols" list — the enriched view of one entry in
 * Conflict.sharedSymbols (types.ts keeps the flat name list; this adds the
 * per-symbol provenance the card's tooltips show).
 * INVARIANT (checked by fixtures, asserted in S5): symbols[i].name ===
 * conflict.sharedSymbols[i] — same names, same order, no divergence.
 */
export interface SharedSymbolEvidence {
  /** Symbol/anchor name from distillation, e.g. "OrderStateMachine.guards". */
  name: string;
  /** Repo-relative file the anchor lives in (distillation anchor map). */
  file: string;
  /**
   * Exactly one touch per side, in conflict.taskIds order. Two edits ⇒ the
   * row annotates "both edited"; edit × read ⇒ "w × r" — DERIVED from the
   * two actions, never stored (a stored label could contradict the touches).
   */
  touches: [SymbolTouch, SymbolTouch];
}

/* ── resource crumb (header) ────────────────────────────────────────────── */

/**
 * Where the intersection lives — the header title + the territory ›
 * sub-block › file crumb. Ids already live on Conflict (types.ts);
 * these are the DENORMALIZED human names so the card renders standalone
 * (same precedent as CrossReadNoticeEvent.otherTaskTitle in panel-types.ts).
 * SOURCE: distillation output (territory / sub-block / resource names,
 * anchoring file). NOT model output.
 */
export interface ResourceCrumb {
  /**
   * The shared resource's human name — the card's h2, e.g. "Order state
   * machine". Equals the sub-block name when the conflict has one, else the
   * territory name.
   */
  resourceName: string;
  /** Territory name (conflict.territoryId's name). */
  territoryName: string;
  /** Sub-block name (conflict.subBlockId's name), when one exists. */
  subBlockName?: string;
  /** Repo-relative file that anchors the cluster (mono crumb tail). */
  anchorFile: string;
}

/* ── AI diagnosis (zone b) ──────────────────────────────────────────────── */

/**
 * One "what this side is doing" row of the verdict block.
 * SOURCE: `claude -p` output — the model read both session transcripts
 * (transcript_path from the hooks) and reported per side. Verbatim.
 */
export interface DiagnosisSide {
  /** Which side (id into conflict.taskIds). */
  taskId: string;
  /**
   * The short side label the diagnosis itself used ("Auto-retry",
   * "Batching") — model output, verbatim, NOT derived from the task title.
   */
  label: string;
  /**
   * What the side is doing, verbatim. May contain `backtick-quoted` code
   * tokens exactly as the model emitted them — the UI renders those spans
   * in mono; the data never rewrites them.
   */
  doing: string;
}

/** Where a diagnosis came from. The only engine today is the user's own
 *  local headless claude (`claude -p` — their machine, their account, no
 *  extra API key); the literal type widens if another engine ever ships. */
export interface DiagnosisProvenance {
  /** When the pass ran (ISO 8601 — the `claude -p` process exit time). */
  diagnosedAt: string;
  engine: "claude-p-local";
}

/**
 * The completed on-demand diagnosis (zone b's filled state). Absent from the
 * fixture ⇒ the dashed "no AI diagnosis yet" empty state.
 */
export interface ConflictDiagnosis {
  /** The bold verdict line, verbatim from the model. */
  verdict: string;
  /** Exactly two "doing" rows, in conflict.taskIds order. */
  sides: [DiagnosisSide, DiagnosisSide];
  /**
   * The suggested resolution, verbatim. A suggestion, not an action — and
   * per DECISIONS-NEEDED iter-10: this exact text is what an empty-note
   * inject sends (send-time default, marked as AI-suggested).
   */
  suggested: string;
  provenance: DiagnosisProvenance;
  /**
   * How many shared-symbol EDITS landed after provenance.diagnosedAt —
   * 0 = fresh (green provenance dot); >0 = the "· N edits since" stale
   * marker (neutral dot, honest tooltip).
   * SOURCE: count of PostToolUse Edit/Write events on this pair's shared
   * symbols with timestamp > diagnosedAt. Held as its own counter (not
   * derived from `symbols`) because SymbolTouch keeps only the LATEST touch
   * per side — a symbol edited twice since the diagnosis is 2 edits here
   * but 1 touch there. Reads never count: the verdict goes stale when the
   * code changes, not when someone looks at it.
   */
  stalenessEditsSince: number;
}

/* ── adjudication actions (zone c) ──────────────────────────────────────── */

/**
 * The three moves the card offers — a discriminated union on `kind` so S4's
 * footer emits exactly one well-typed action. These are USER INPUTS we
 * forward (signal-inventory class 5 in panel-types.ts terms), not captured
 * signals.
 */
export type AdjudicationAction =
  | {
      /**
       * Least destructive: the same coordination note is queued to BOTH
       * tasks at their next turn boundary. Nothing pauses.
       */
      kind: "inject_note";
      /**
       * The note, verbatim as typed. Empty/absent ⇒ send the diagnosis's
       * `suggested` text verbatim, marked as AI-suggested (DECISIONS-NEEDED
       * iter-10 fork #3 — send-time default, never a prefill). Only
       * meaningful when a diagnosis exists; with no diagnosis the UI
       * requires a non-empty note (there is nothing to default to).
       */
      note?: string;
    }
  | {
      /** Park ONE side in waiting until resumed; the other side continues.
       *  The UI never pre-picks the side (iter-9) — pausing an
       *  already-waiting task is accepted as an honest no-op. */
      kind: "pause_side";
      /** The side to park (one of conflict.taskIds). */
      taskId: string;
    }
  | {
      /** Permanently silence THIS pair only (this taskIds × resource
       *  combination). Any other overlap either task hits still surfaces. */
      kind: "ignore_pair";
    };

/* ── fixture root ───────────────────────────────────────────────────────── */

/** Everything the conflict card needs to render one frame, standalone. */
export interface ConflictCardFixture {
  /**
   * The "now" of the snapshot (ISO 8601). The header age ("8m") and the
   * pause-menu state ages derive from timestamps vs this — deterministic,
   * no Date.now. Formatting: relAge()/clockTime() in ./derive.ts.
   */
  capturedAt: string;
  /** The conflict record — the map's own type, unchanged. */
  conflict: Conflict;
  /**
   * The pair, denormalized in conflict.taskIds order: task rows render the
   * REAL state pill (conflict stays an attribute, 020/021), the declared
   * w/r chip on this resource comes from task.scopes, the branch chip from
   * task.git. Exactly two — the "Between" zone never scales.
   */
  tasks: [Task, Task];
  crumb: ResourceCrumb;
  /**
   * Per-symbol evidence, aligned 1:1 with conflict.sharedSymbols (same
   * names, same order). Overflow presentation (3 + "+N more", count
   * abbreviation past 999) is a UI concern — data stays complete.
   */
  symbols: SharedSymbolEvidence[];
  /** Absent ⇒ zone b renders the dashed "no AI diagnosis yet" empty state. */
  diagnosis?: ConflictDiagnosis;
}
