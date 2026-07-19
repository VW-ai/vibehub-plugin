/**
 * Task-scoped periodic knowledge checkpoint (intent-workbench-003).
 *
 * The hook owns WHEN only: it counts deduplicated user prompts per
 * (repo, task) and, once enough turns pass without a new canonical
 * knowledge write, reminds the agent — once — to review the conversation
 * for durable knowledge. Whether durable knowledge exists, how it is
 * classified, and what gets written stay with the model and the
 * vibehub-ingest skill (decision-workbench-010); nothing here parses
 * transcripts, estimates tokens, or classifies semantics.
 *
 * Reset evidence = kb_provenance_events: the append-only ledger written
 * ONLY inside successful canonical KB mutations. Failed mutations roll
 * back their rows, idempotent replays return cached receipts without
 * writing, and distillation never writes it, so a monotonic per-task
 * high-water mark over its rowids says, mechanically, "a canonical write
 * attributed to this task happened since we last looked". Writes without
 * a task attribution (e.g. `vibehub kb promote` without --task) do not
 * reset a task-scoped counter: an unattributed write proves nothing about
 * THIS task's conversation.
 *
 * Every statement here must be total over untrusted data — a throw would
 * roll back the entire hook ingest transaction (events, footprints,
 * injection claims). Callers guard promptId to a non-empty string.
 *
 * Compact boundaries are not counted in v1: cadence is task-scoped and
 * already survives compact/clear/session restarts; the intent's
 * "compact 补点" refinement stays a deliberate deferral.
 */
import type { Db } from "./db.js";
import { getSetting } from "./graph-store.js";

/**
 * Default user-turn cadence between checkpoint reminders. Tunable, awaits
 * dogfood benchmark — no empirical basis yet. Seed reasoning: the session
 * protocol already asks for ingest-at-decision-time, so the checkpoint is
 * a safety net; a handful of turns approximates one work phase without
 * nagging every exchange. Override per repo or globally via the settings
 * key below; invalid or non-positive values fall back here ("0" is not a
 * disable switch — disabling would be an explicit product decision).
 */
export const DEFAULT_CHECKPOINT_CADENCE_TURNS = 8;

/** Settings override key (repo row shadows the repo_id 0 global row). */
export const CHECKPOINT_CADENCE_SETTING_KEY = "checkpoint.cadence.user_turns";

/**
 * The one place cadence configuration is resolved; never throws. Accepted
 * grammar is an explicit positive decimal integer (surrounding whitespace
 * tolerated) — "1e3"/"0x10" style Number() leniency is not configuration.
 */
export function resolveCheckpointCadence(db: Db, repoId: number): number {
  const raw = getSetting(db, CHECKPOINT_CADENCE_SETTING_KEY, repoId);
  if (raw === null) return DEFAULT_CHECKPOINT_CADENCE_TURNS;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_CHECKPOINT_CADENCE_TURNS;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CHECKPOINT_CADENCE_TURNS;
}

export type CheckpointStatus = "counted" | "duplicate" | "fired" | "deferred";

export interface CheckpointCadenceFacts {
  status: CheckpointStatus;
  /** Deduplicated user prompts counted for this task since tracking began. */
  countedTurns: number;
  /** countedTurns - lastWriteTurn; never negative. */
  turnsSinceLastWrite: number;
  threshold: number;
}

export interface CheckpointTurnInput {
  repoId: number;
  /** The hook-resolved task id (honors legacy-row fallback); never recomputed. */
  taskId: string;
  /** Stable host prompt identity; caller has type/empty-guarded it. */
  promptId: string;
  now: string;
  /** True when this same hook fire is delivering claimed interventions. */
  deliveringInterventions: boolean;
}

/**
 * Record one UserPromptSubmit turn and decide whether the checkpoint
 * reminder fires. MUST be called inside the hook's open transaction, after
 * the task row is upserted (FKs). Rules, in order:
 * 1. mechanical reset — new provenance rows attributed to this task move
 *    last_write_turn to the current count;
 * 2. replay dedup — a prompt_id seen before never counts and never fires,
 *    so duplicated hook registrations are inert;
 * 3. strict priority — an eligible turn that is delivering claimed
 *    interventions defers (reminder turn untouched) and retries on the
 *    next quiet turn; a pause instruction is never contradicted.
 */
export function recordUserPromptTurn(
  db: Db,
  input: CheckpointTurnInput,
): CheckpointCadenceFacts {
  const { repoId, taskId, promptId, now } = input;
  const threshold = resolveCheckpointCadence(db, repoId);
  db.prepare(
    `INSERT INTO task_prompt_cadence (repo_id, task_id, provenance_high_water, updated_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(id), 0) FROM kb_provenance_events WHERE repo_id = ? AND task_id = ?), ?)
     ON CONFLICT(repo_id, task_id) DO NOTHING`,
  ).run(repoId, taskId, repoId, taskId, now);
  const row = db.prepare(
    `SELECT counted_turns AS countedTurns, last_write_turn AS lastWriteTurn,
            last_reminder_turn AS lastReminderTurn, provenance_high_water AS provenanceHighWater
     FROM task_prompt_cadence WHERE repo_id = ? AND task_id = ?`,
  ).get(repoId, taskId) as {
    countedTurns: number;
    lastWriteTurn: number;
    lastReminderTurn: number;
    provenanceHighWater: number;
  };

  let { countedTurns, lastWriteTurn, lastReminderTurn, provenanceHighWater } = row;
  const maxProvenance = (db.prepare(
    `SELECT COALESCE(MAX(id), 0) AS id FROM kb_provenance_events WHERE repo_id = ? AND task_id = ?`,
  ).get(repoId, taskId) as { id: number }).id;
  if (maxProvenance > provenanceHighWater) {
    lastWriteTurn = countedTurns;
    provenanceHighWater = maxProvenance;
  }

  const isNew = db.prepare(
    `INSERT INTO task_prompt_seen (repo_id, task_id, prompt_id, seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(task_id, prompt_id) DO NOTHING`,
  ).run(repoId, taskId, promptId, now).changes === 1;
  if (isNew) countedTurns += 1;

  const eligible =
    isNew && countedTurns - Math.max(lastWriteTurn, lastReminderTurn) >= threshold;
  const status: CheckpointStatus = !isNew
    ? "duplicate"
    : eligible
      ? input.deliveringInterventions
        ? "deferred"
        : "fired"
      : "counted";
  if (status === "fired") lastReminderTurn = countedTurns;

  db.prepare(
    `UPDATE task_prompt_cadence
     SET counted_turns = ?, last_write_turn = ?, last_reminder_turn = ?,
         provenance_high_water = ?, updated_at = ?
     WHERE repo_id = ? AND task_id = ?`,
  ).run(countedTurns, lastWriteTurn, lastReminderTurn, provenanceHighWater, now, repoId, taskId);

  return {
    status,
    countedTurns,
    turnsSinceLastWrite: countedTurns - lastWriteTurn,
    threshold,
  };
}

/**
 * The injected reminder. It asks for judgment, never mandates a write —
 * "no durable knowledge" must stay a first-class outcome (no filler
 * records). The task id is embedded because the reset evidence is
 * task-attributed: a capture written without `--task <this id>` (the CLI
 * skill route) would never close the remind→capture→reset loop, and the
 * agent has no other way to learn the opaque id. Wording is a product
 * surface; changes need a spec trace.
 */
export function formatCheckpointReminder(
  facts: CheckpointCadenceFacts,
  taskId: string,
): string {
  const captured = facts.countedTurns > facts.turnsSinceLastWrite;
  const opening = captured
    ? `[Vibehub] Knowledge checkpoint: ${facts.turnsSinceLastWrite} user turns on this task since the last captured knowledge write. ` +
      "Review the conversation since then"
    : `[Vibehub] Knowledge checkpoint: ${facts.turnsSinceLastWrite} user turns on this task with no knowledge captured yet. ` +
      "Review the conversation";
  return (
    `${opening} for durable knowledge — new intent, decisions, constraints, contracts, conventions, context, or changes. ` +
    `If any exist, use the vibehub-ingest skill now and attribute the write to task ${taskId}. ` +
    "If none, continue working — do not create filler records."
  );
}
