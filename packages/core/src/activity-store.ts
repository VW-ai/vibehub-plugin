/**
 * ActivityStore — 运行域 read/write (decision-project-025: 事/session/事件/
 * 足迹; plus scopes/injections/conflicts/notifications, the rest of the run
 * domain).
 *
 * Typed door over migration 002. Contract rule enforced here: DERIVED IS
 * NEVER STORED — session ordinals, filesTouched, staleness counters are
 * computed at read time from the stored facts.
 */
import type {
  Conflict,
  ScopeDeclaration,
  SignalTier,
  TaskState,
  PrState,
} from "./contract/map-types.js";
import type {
  SessionIdentity,
  TimelineEvent,
} from "./contract/panel-types.js";
import type {
  ConflictDiagnosis,
  DiagnosisSide,
} from "./contract/conflict-types.js";
import type { Db } from "./db.js";
import { isConflictPairIgnored } from "./conflict-ignore.js";
import crypto from "node:crypto";

/* ── tasks ──────────────────────────────────────────────────────────────── */

/**
 * Stable opaque identity for the repository-local branch join key
 * (decision-project-024). Branch remains separate source/display metadata;
 * callers must never recover repository or branch facts by parsing this id.
 */
export const taskIdForBranch = (repoId: number, branch: string): string =>
  `task:${crypto.createHash("sha256").update(`${repoId}\0${branch}`).digest("hex").slice(0, 32)}`;

export interface TaskRow {
  id: string;
  repoId: number;
  title: string;
  state: TaskState;
  signalTier: SignalTier;
  branch: string | null;
  worktreePath: string | null;
  prNumber: number | null;
  prState: PrState | null;
  stateSince: string;
  lastEventAt: string;
  statusDetail: string | null;
  createdAt: string;
  /** HEAD when the task was first captured; bounds read-side commit events. */
  startHeadSha: string | null;
}

export function upsertTask(db: Db, t: TaskRow): void {
  db.prepare(
    `INSERT INTO tasks (id, repo_id, title, state, signal_tier, branch, worktree_path,
       pr_number, pr_state, state_since, last_event_at, status_detail, created_at,
       start_head_sha)
     VALUES (@id, @repoId, @title, @state, @signalTier, @branch, @worktreePath,
       @prNumber, @prState, @stateSince, @lastEventAt, @statusDetail, @createdAt,
       @startHeadSha)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, state = excluded.state,
       signal_tier = excluded.signal_tier, branch = excluded.branch,
       worktree_path = excluded.worktree_path, pr_number = excluded.pr_number,
       pr_state = excluded.pr_state, state_since = excluded.state_since,
       last_event_at = excluded.last_event_at, status_detail = excluded.status_detail,
       start_head_sha = COALESCE(tasks.start_head_sha, excluded.start_head_sha)`,
  ).run(t as unknown as Record<string, unknown>);
}

export function readTask(db: Db, id: string): TaskRow | null {
  const r = db
    .prepare(
      `SELECT id, repo_id AS repoId, title, state, signal_tier AS signalTier,
              branch, worktree_path AS worktreePath, pr_number AS prNumber,
              pr_state AS prState, state_since AS stateSince,
              last_event_at AS lastEventAt, status_detail AS statusDetail,
              created_at AS createdAt, start_head_sha AS startHeadSha
       FROM tasks WHERE id = ?`,
    )
    .get(id) as TaskRow | undefined;
  return r ?? null;
}

/**
 * Repository-scoped branch lookup used at capture boundaries. The fallback
 * to an existing non-canonical id is deliberately read-only compatibility:
 * legacy rows keep their identity and ownership; new rows use the opaque id.
 */
export function readTaskForBranch(
  db: Db,
  repoId: number,
  branch: string,
): TaskRow | null {
  const canonicalId = taskIdForBranch(repoId, branch);
  const r = db
    .prepare(
      `SELECT id, repo_id AS repoId, title, state, signal_tier AS signalTier,
              branch, worktree_path AS worktreePath, pr_number AS prNumber,
              pr_state AS prState, state_since AS stateSince,
              last_event_at AS lastEventAt, status_detail AS statusDetail,
              created_at AS createdAt, start_head_sha AS startHeadSha
       FROM tasks
       WHERE repo_id = ? AND branch = ?
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at, id
       LIMIT 1`,
    )
    .get(repoId, branch, canonicalId) as TaskRow | undefined;
  return r ?? null;
}

export function listTasks(db: Db, repoId: number): TaskRow[] {
  return db
    .prepare(
      `SELECT id, repo_id AS repoId, title, state, signal_tier AS signalTier,
              branch, worktree_path AS worktreePath, pr_number AS prNumber,
              pr_state AS prState, state_since AS stateSince,
              last_event_at AS lastEventAt, status_detail AS statusDetail,
              created_at AS createdAt, start_head_sha AS startHeadSha
       FROM tasks WHERE repo_id = ? ORDER BY created_at`,
    )
    .all(repoId) as TaskRow[];
}

export interface TaskReport {
  status: string;
  done: string | null;
  reportedAt: string;
}

export function saveTaskReport(
  db: Db,
  taskId: string,
  report: TaskReport,
): TaskReport {
  db.prepare(
    `INSERT INTO task_reports (task_id, status, done, reported_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       status = excluded.status, done = excluded.done, reported_at = excluded.reported_at`,
  ).run(taskId, report.status, report.done, report.reportedAt);
  return report;
}

export function readTaskReport(db: Db, taskId: string): TaskReport | null {
  return (db.prepare(
    `SELECT status, done, reported_at AS reportedAt FROM task_reports WHERE task_id = ?`,
  ).get(taskId) as TaskReport | undefined) ?? null;
}

/* ── sessions ───────────────────────────────────────────────────────────── */

export interface SessionRow {
  id: string;
  repoId: number;
  taskId: string | null;
  agent: string;
  transcriptPath: string | null;
  startedAt: string;
  endedAt: string | null;
  endReason: "context_limit" | "user_ended" | "completed" | null;
}

export function upsertSession(db: Db, s: SessionRow): void {
  db.prepare(
    `INSERT INTO sessions (id, repo_id, task_id, agent, transcript_path, started_at, ended_at, end_reason)
     VALUES (@id, @repoId, @taskId, @agent, @transcriptPath, @startedAt, @endedAt, @endReason)
     ON CONFLICT(id) DO UPDATE SET
       task_id = excluded.task_id, transcript_path = excluded.transcript_path,
       ended_at = excluded.ended_at, end_reason = excluded.end_reason`,
  ).run(s as unknown as Record<string, unknown>);
}

/**
 * SessionIdentity (contract panel-types.ts) — ordinal/count DERIVED by
 * counting the task's sessions in start order; previousEnded* read from the
 * predecessor row. Null when the session is not on this task.
 */
export function sessionIdentity(
  db: Db,
  taskId: string,
  sessionId: string,
): SessionIdentity | null {
  const rows = db
    .prepare(
      `SELECT id, agent, ended_at AS endedAt, end_reason AS endReason
       FROM sessions WHERE task_id = ? ORDER BY started_at`,
    )
    .all(taskId) as Array<{
    id: string;
    agent: string;
    endedAt: string | null;
    endReason: SessionRow["endReason"];
  }>;
  const idx = rows.findIndex((r) => r.id === sessionId);
  if (idx < 0) return null;
  const prev = idx > 0 ? rows[idx - 1] : undefined;
  return {
    agent: rows[idx]!.agent,
    sessionOrdinal: idx + 1,
    sessionCount: rows.length,
    ...(prev?.endedAt ? { previousEndedAt: prev.endedAt } : {}),
    ...(prev?.endReason ? { previousEndReason: prev.endReason } : {}),
  };
}

/* ── timeline events ────────────────────────────────────────────────────── */

/**
 * Append one contract TimelineEvent verbatim (payload = the whole event, so
 * reads round-trip exactly; type/at doubled as columns for querying).
 */
export function appendEvent(
  db: Db,
  repoId: number,
  taskId: string | null,
  sessionId: string | null,
  event: TimelineEvent,
): void {
  db.prepare(
    `INSERT INTO events (repo_id, task_id, session_id, type, at, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(repoId, taskId, sessionId, event.type, event.at, JSON.stringify(event));
}

/**
 * Whether the task has ever emitted an event of this type — an indexed
 * lookup on the `type` column, NOT a timeline parse (the hook path asks
 * this on every prompt submit).
 */
export function hasEvent(
  db: Db,
  taskId: string,
  type: TimelineEvent["type"],
): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM events WHERE task_id = ? AND type = ? LIMIT 1`)
      .get(taskId, type) !== undefined
  );
}

/**
 * Most recent event timestamp in the repo (ISO), null when hooks have never
 * fired — the honest source of SyncFreshness.lastHookEventAt.
 */
export function lastHookEventAt(db: Db, repoId: number): string | null {
  const r = db
    .prepare(`SELECT MAX(at) AS m FROM events WHERE repo_id = ?`)
    .get(repoId) as { m: string | null };
  return r.m;
}

/** The task's timeline, chronological (contract: ascending \`at\`). */
export function readTimeline(db: Db, taskId: string): TimelineEvent[] {
  const rows = db
    .prepare(`SELECT payload FROM events WHERE task_id = ? ORDER BY at, id`)
    .all(taskId) as Array<{ payload: string }>;
  return rows.map((r) => JSON.parse(r.payload) as TimelineEvent);
}

/* ── footprints ─────────────────────────────────────────────────────────── */

export interface FootprintRow {
  taskId: string;
  sessionId: string | null;
  path: string;
  action: "edit" | "read";
  at: string;
}

export function addFootprint(db: Db, repoId: number, f: FootprintRow): void {
  db.prepare(
    `INSERT INTO footprints (repo_id, task_id, session_id, path, action, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(repoId, f.taskId, f.sessionId, f.path, f.action, f.at);
}

/** Distinct files the task has EDITED — counted in SQL, never materialized. */
export function distinctEditedFileCount(db: Db, taskId: string): number {
  const r = db
    .prepare(
      `SELECT COUNT(DISTINCT path) AS n FROM footprints
       WHERE task_id = ? AND action = 'edit'`,
    )
    .get(taskId) as { n: number };
  return r.n;
}

export function readFootprints(db: Db, taskId: string): FootprintRow[] {
  return db
    .prepare(
      `SELECT task_id AS taskId, session_id AS sessionId, path, action, at
       FROM footprints WHERE task_id = ? ORDER BY at, id`,
    )
    .all(taskId) as FootprintRow[];
}

/* ── scopes ─────────────────────────────────────────────────────────────── */

/** Replace the task's declarations (seq = declaration order, contract). */
export function setScopes(
  db: Db,
  repoId: number,
  taskId: string,
  scopes: Omit<ScopeDeclaration, "filesTouched">[],
): void {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM scopes WHERE task_id = ?`).run(taskId);
    const ins = db.prepare(
      `INSERT INTO scopes (repo_id, task_id, seq, mode, territory_id, sub_block_id, label)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    scopes.forEach((s, i) =>
      ins.run(repoId, taskId, i, s.mode, s.territoryId, s.subBlockId ?? null, s.label),
    );
  });
  tx();
}

/**
 * Declarations in declaration order. filesTouched DERIVED: distinct edited
 * paths of the task attributed to the scope's territory via the anchor map
 * (anchors.file → feature/sub-block); absent when nothing touched yet
 * (contract: "Absent when nothing touched yet").
 */
export function readScopes(db: Db, taskId: string): ScopeDeclaration[] {
  const rows = db
    .prepare(
      `SELECT mode, territory_id AS territoryId, sub_block_id AS subBlockId, label
       FROM scopes WHERE task_id = ? ORDER BY seq`,
    )
    .all(taskId) as Array<{
    mode: "write" | "read";
    territoryId: string;
    subBlockId: string | null;
    label: string;
  }>;
  const touched = db.prepare(
    `SELECT COUNT(DISTINCT f.path) AS n
     FROM footprints f
     JOIN repo_active_mapping active ON active.repo_id = f.repo_id
     JOIN mapping_version_anchors a ON a.repo_id = active.repo_id
       AND a.version_id = active.version_id AND a.file = f.path
     WHERE f.task_id = ? AND f.action = 'edit' AND a.feature_id = ?`,
  );
  return rows.map((r) => {
    const n = (
      touched.get(taskId, r.subBlockId ?? r.territoryId) as { n: number }
    ).n;
    return {
      mode: r.mode,
      territoryId: r.territoryId,
      ...(r.subBlockId ? { subBlockId: r.subBlockId } : {}),
      label: r.label,
      ...(n > 0 ? { filesTouched: n } : {}),
    };
  });
}

/* ── injections ─────────────────────────────────────────────────────────── */

export function enqueueInjection(
  db: Db,
  repoId: number,
  taskId: string,
  mode: "inject" | "pause",
  text: string,
  now: string,
  context?: string,
): number {
  const r = db
    .prepare(
      `INSERT INTO injections (repo_id, task_id, mode, text, context, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(repoId, taskId, mode, text, context ?? null, now);
  return Number(r.lastInsertRowid);
}

export interface ClaimedInjection {
  id: number;
  mode: "inject" | "pause";
  text: string;
  context: string | null;
  createdAt: string;
}

/**
 * Claim every pending injection for the task, FIFO — the hook 触发点回查
 * (decision-project-018). Atomic: claiming twice returns nothing the second
 * time, so two racing hooks can never both emit. Important crash boundary:
 * `claimed_at` proves ownership, not that stdout reached Claude. A process
 * dying after this UPDATE but before emission leaves an intentionally
 * ambiguous at-most-once receipt; no daemon exists to infer/replay delivery.
 */
export function claimPendingInjections(
  db: Db,
  taskId: string,
  now: string,
): ClaimedInjection[] {
  return db
    .prepare(
      `UPDATE injections SET claimed_at = ?
       WHERE claimed_at IS NULL AND task_id = ?
       RETURNING id, mode, text, context, created_at AS createdAt`,
    )
    .all(now, taskId) as ClaimedInjection[];
}

export interface PendingInjection {
  id: number;
  mode: "inject" | "pause";
  text: string;
  context: string | null;
  createdAt: string;
}

/**
 * Read-side view of not-yet-delivered notes — the delivery-timeout story.
 * claimed_at is the claim receipt (the actual emission can remain ambiguous
 * if that short-lived process crashes), and with no daemon there is nothing to
 * fire a timeout: "stuck" is DERIVED at read time from createdAt age (the
 * UI decides the threshold — e.g. session ended, or no hook fire since),
 * never stored (same discipline as "stalled" in state-machine.ts).
 */
export function pendingInjections(db: Db, taskId: string): PendingInjection[] {
  return db
    .prepare(
      `SELECT id, mode, text, context, created_at AS createdAt FROM injections
       WHERE claimed_at IS NULL AND task_id = ?
       ORDER BY created_at, id`,
    )
    .all(taskId) as PendingInjection[];
}

/* ── conflicts ──────────────────────────────────────────────────────────── */

/** Persist a contract Conflict + the anchoring file per shared symbol. */
export function insertConflict(
  db: Db,
  repoId: number,
  c: Conflict,
  symbolFiles: string[],
): void {
  if (symbolFiles.length !== c.sharedSymbols.length) {
    throw new Error(
      `symbolFiles must align 1:1 with sharedSymbols (${symbolFiles.length} vs ${c.sharedSymbols.length})`,
    );
  }
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO conflicts (id, repo_id, task_a, task_b, territory_id, sub_block_id, severity, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      c.id,
      repoId,
      c.taskIds[0],
      c.taskIds[1],
      c.territoryId,
      c.subBlockId ?? null,
      c.severity,
      c.detectedAt,
    );
    const ins = db.prepare(
      `INSERT INTO conflict_symbols (conflict_id, seq, name, file) VALUES (?, ?, ?, ?)`,
    );
    c.sharedSymbols.forEach((name, i) => ins.run(c.id, i, name, symbolFiles[i]));
  });
  tx();
}

/** Rebuild the contract Conflict (symbols in stored order — the invariant). */
export function readConflict(db: Db, id: string): Conflict | null {
  const r = db
    .prepare(
      `SELECT id, repo_id AS repoId, task_a, task_b, territory_id AS territoryId,
              sub_block_id AS subBlockId, severity, detected_at AS detectedAt
       FROM conflicts WHERE id = ? AND resolved_at IS NULL AND ignored = 0`,
    )
    .get(id) as
    | {
        id: string;
        repoId: number;
        task_a: string;
        task_b: string;
        territoryId: string;
        subBlockId: string | null;
        severity: "red" | "yellow";
        detectedAt: string;
      }
    | undefined;
  if (!r) return null;
  if (isConflictPairIgnored(db, r.repoId, [r.task_a, r.task_b])) return null;
  const symbols = db
    .prepare(`SELECT name FROM conflict_symbols WHERE conflict_id = ? ORDER BY seq`)
    .all(id) as Array<{ name: string }>;
  return {
    id: r.id,
    taskIds: [r.task_a, r.task_b],
    territoryId: r.territoryId,
    ...(r.subBlockId ? { subBlockId: r.subBlockId } : {}),
    sharedSymbols: symbols.map((s) => s.name),
    severity: r.severity,
    detectedAt: r.detectedAt,
  };
}

/** Active local conflicts only; ignored/resolved pairs never re-enter summaries. */
export function listActiveConflicts(db: Db, repoId: number): Conflict[] {
  const ids = db.prepare(
    `SELECT id FROM conflicts
     WHERE repo_id = ? AND resolved_at IS NULL AND ignored = 0
     ORDER BY detected_at, id`,
  ).all(repoId) as Array<{ id: string }>;
  return ids.map((row) => readConflict(db, row.id)).filter((value): value is Conflict => value !== null);
}

export function saveDiagnosis(
  db: Db,
  conflictId: string,
  d: Omit<ConflictDiagnosis, "stalenessEditsSince">,
): void {
  db.prepare(
    `INSERT INTO conflict_diagnoses (conflict_id, verdict, sides, suggested, diagnosed_at, engine)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(conflict_id) DO UPDATE SET
       verdict = excluded.verdict, sides = excluded.sides,
       suggested = excluded.suggested, diagnosed_at = excluded.diagnosed_at,
       engine = excluded.engine`,
  ).run(
    conflictId,
    d.verdict,
    JSON.stringify(d.sides),
    d.suggested,
    d.provenance.diagnosedAt,
    d.provenance.engine,
  );
}

/**
 * The stored diagnosis with stalenessEditsSince DERIVED per contract: count
 * of EDIT footprints by the pair on the shared symbols' files strictly after
 * diagnosedAt (reads never count — "the verdict goes stale when the code
 * changes, not when someone looks at it").
 */
export function readDiagnosis(
  db: Db,
  conflictId: string,
): ConflictDiagnosis | null {
  const r = db
    .prepare(
      `SELECT verdict, sides, suggested, diagnosed_at AS diagnosedAt, engine
       FROM conflict_diagnoses WHERE conflict_id = ?`,
    )
    .get(conflictId) as
    | { verdict: string; sides: string; suggested: string; diagnosedAt: string; engine: "claude-p-local" }
    | undefined;
  if (!r) return null;
  const stale = db
    .prepare(
      `SELECT COUNT(*) AS n FROM footprints f
       JOIN conflicts c ON c.id = ?
       WHERE f.action = 'edit' AND f.at > ?
         AND f.task_id IN (c.task_a, c.task_b)
         AND f.path IN (SELECT file FROM conflict_symbols WHERE conflict_id = c.id)`,
    )
    .get(conflictId, r.diagnosedAt) as { n: number };
  return {
    verdict: r.verdict,
    sides: JSON.parse(r.sides) as [DiagnosisSide, DiagnosisSide],
    suggested: r.suggested,
    provenance: { diagnosedAt: r.diagnosedAt, engine: r.engine },
    stalenessEditsSince: stale.n,
  };
}

/* ── notifications ──────────────────────────────────────────────────────── */

export function recordNotification(
  db: Db,
  repoId: number,
  kind: string,
  refId: string,
  now: string,
): void {
  db.prepare(
    `INSERT INTO notifications (repo_id, kind, ref_id, created_at) VALUES (?, ?, ?, ?)`,
  ).run(repoId, kind, refId, now);
}

/** Ledger count since a timestamp — the base fact for the 通知预算 (020). */
export function notificationCountSince(
  db: Db,
  repoId: number,
  sinceIso: string,
): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM notifications WHERE repo_id = ? AND created_at >= ?`,
    )
    .get(repoId, sinceIso) as { n: number };
  return r.n;
}
