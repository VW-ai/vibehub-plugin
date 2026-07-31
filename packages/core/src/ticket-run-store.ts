import crypto from "node:crypto";
import type { Db } from "./db.js";

export const MIN_TICKET_RUN_LEASE_SECONDS = 15;
export const MAX_TICKET_RUN_LEASE_SECONDS = 60 * 60;

export type TicketRunReleaseReason =
  | "lease_released"
  | "stale_binding"
  | "superseded"
  | "operator_cancelled";

export type TicketRunLeaseErrorCode =
  | "invalid_input"
  | "claim_conflict"
  | "run_not_found"
  | "stale_generation"
  | "invalid_token"
  | "lease_expired"
  | "lease_released"
  | "release_conflict";

export class TicketRunLeaseError extends Error {
  readonly code: TicketRunLeaseErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: TicketRunLeaseErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "TicketRunLeaseError";
    this.code = code;
    this.details = details;
  }
}

export interface TicketRunLease {
  repoId: number;
  worktreeIdentity: string;
  runId: string;
  ticketId: string;
  ticketRevision: string;
  contextBindingId: string;
  contextBindingDigest: string;
  actor: string;
  startSourceDigest: string;
  startBranch: string;
  startHeadSha: string;
  generation: number;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt: string | null;
  releaseReason: TicketRunReleaseReason | "expired_takeover" | null;
}

export interface ClaimTicketRunInput {
  repoId: number;
  worktreeIdentity: string;
  ticketId: string;
  ticketRevision: string;
  contextBindingId: string;
  contextBindingDigest: string;
  actor: string;
  startSourceDigest: string;
  startBranch: string;
  startHeadSha: string;
  leaseSeconds: number;
  now: string;
}

export interface ClaimedTicketRun extends TicketRunLease {
  /**
   * Random bearer capability returned once. Only its SHA-256 digest is stored.
   * A higher layer that needs idempotent claim replay must own that response.
   */
  leaseToken: string;
}

export interface HeartbeatTicketRunInput {
  repoId: number;
  runId: string;
  generation: number;
  leaseToken: string;
  leaseSeconds: number;
  now: string;
}

export interface ReleaseTicketRunInput {
  repoId: number;
  runId: string;
  generation: number;
  leaseToken: string;
  reason: TicketRunReleaseReason;
  now: string;
}

export interface ListCurrentTicketRunsInput {
  repoId: number;
  now: string;
  worktreeIdentity?: string;
  ticketId?: string;
  ticketRevision?: string;
}

export interface GetTicketRunInput {
  repoId: number;
  runId: string;
  generation: number;
}

export interface AuthorizeTicketRunInput extends GetTicketRunInput {
  leaseToken: string;
  now: string;
}

export interface ReleasedTicketRun {
  run: TicketRunLease;
  alreadyReleased: boolean;
}

interface TicketRunRow {
  repo_id: number;
  worktree_identity: string;
  run_id: string;
  ticket_id: string;
  ticket_revision: string;
  context_binding_id: string;
  context_binding_digest: string;
  actor: string;
  start_source_digest: string;
  start_branch: string;
  start_head_sha: string;
  lease_generation: number;
  token_hash: string;
  claimed_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  release_reason: TicketRunLease["releaseReason"];
}

const PUBLIC_COLUMNS = `
  repo_id,worktree_identity,run_id,ticket_id,ticket_revision,
  context_binding_id,context_binding_digest,actor,start_source_digest,
  start_branch,start_head_sha,lease_generation,token_hash,claimed_at,
  heartbeat_at,expires_at,released_at,release_reason
`;

/**
 * Disposable coordination over an already validated Ticket execution
 * binding. This store never reads Git, derives eligibility, or records a
 * Ticket outcome. Its whole authority is the short-lived bearer lease.
 */
export class TicketRunStore {
  constructor(private readonly db: Db) {}

  claim(input: ClaimTicketRunInput): ClaimedTicketRun {
    validateClaimInput(input);
    const now = canonicalTimestamp(input.now, "now");
    const expiresAt = leaseExpiry(now, input.leaseSeconds);
    const runId = `trn-${crypto.randomBytes(32).toString("hex")}`;
    const leaseToken = `vht_${crypto.randomBytes(32).toString("base64url")}`;
    const tokenHash = hashToken(leaseToken);

    return this.db.transaction(() => {
      const unreleased = this.db.prepare(`
        SELECT ${PUBLIC_COLUMNS}
        FROM ticket_runs
        WHERE repo_id=? AND worktree_identity=? AND ticket_id=?
          AND ticket_revision=? AND released_at IS NULL
      `).get(
        input.repoId,
        input.worktreeIdentity,
        input.ticketId,
        input.ticketRevision,
      ) as TicketRunRow | undefined;

      if (unreleased && unreleased.expires_at > now) {
        throw new TicketRunLeaseError(
          "claim_conflict",
          "an unexpired executor already holds this exact Ticket revision",
          {
            runId: unreleased.run_id,
            actor: unreleased.actor,
            generation: unreleased.lease_generation,
            expiresAt: unreleased.expires_at,
          },
        );
      }

      if (unreleased) {
        const retired = this.db.prepare(`
          UPDATE ticket_runs
          SET released_at=?, release_reason='expired_takeover'
          WHERE repo_id=? AND run_id=? AND released_at IS NULL
            AND expires_at<=?
        `).run(now, input.repoId, unreleased.run_id, now);
        if (retired.changes !== 1) {
          throw new TicketRunLeaseError(
            "claim_conflict",
            "the prior lease changed while the expired takeover was being recorded",
          );
        }
      }

      const previous = this.db.prepare(`
        SELECT COALESCE(MAX(lease_generation),0) AS generation
        FROM ticket_runs
        WHERE repo_id=? AND worktree_identity=? AND ticket_id=?
          AND ticket_revision=?
      `).get(
        input.repoId,
        input.worktreeIdentity,
        input.ticketId,
        input.ticketRevision,
      ) as { generation: number };
      const generation = previous.generation + 1;

      this.db.prepare(`
        INSERT INTO ticket_runs(
          repo_id,worktree_identity,run_id,ticket_id,ticket_revision,
          context_binding_id,context_binding_digest,actor,start_source_digest,
          start_branch,start_head_sha,lease_generation,token_hash,claimed_at,
          heartbeat_at,expires_at,released_at,release_reason
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)
      `).run(
        input.repoId,
        input.worktreeIdentity,
        runId,
        input.ticketId,
        input.ticketRevision,
        input.contextBindingId,
        input.contextBindingDigest,
        input.actor,
        input.startSourceDigest,
        input.startBranch,
        input.startHeadSha,
        generation,
        tokenHash,
        now,
        now,
        expiresAt,
      );

      const row = this.readRequired(input.repoId, runId);
      return { ...toPublic(row), leaseToken };
    }).immediate();
  }

  heartbeat(input: HeartbeatTicketRunInput): TicketRunLease {
    validateRepoRunCredentials(input);
    validateLeaseSeconds(input.leaseSeconds);
    const now = canonicalTimestamp(input.now, "now");
    const expiresAt = leaseExpiry(now, input.leaseSeconds);

    return this.db.transaction(() => {
      const row = this.readRequired(input.repoId, input.runId);
      assertCredentials(row, input.generation, input.leaseToken);
      if (row.released_at !== null) {
        throw new TicketRunLeaseError(
          "lease_released",
          "the Ticket run lease has already been released",
          { releasedAt: row.released_at, releaseReason: row.release_reason },
        );
      }
      if (row.expires_at <= now) {
        throw new TicketRunLeaseError(
          "lease_expired",
          "the Ticket run lease has expired",
          { expiresAt: row.expires_at },
        );
      }

      const changed = this.db.prepare(`
        UPDATE ticket_runs
        SET heartbeat_at=?, expires_at=?
        WHERE repo_id=? AND run_id=? AND lease_generation=?
          AND released_at IS NULL AND expires_at>?
      `).run(
        now,
        expiresAt,
        input.repoId,
        input.runId,
        input.generation,
        now,
      );
      if (changed.changes !== 1) {
        throw new TicketRunLeaseError(
          "claim_conflict",
          "the Ticket run lease changed while its heartbeat was being recorded",
        );
      }
      return toPublic(this.readRequired(input.repoId, input.runId));
    }).immediate();
  }

  release(input: ReleaseTicketRunInput): ReleasedTicketRun {
    validateRepoRunCredentials(input);
    validateReleaseReason(input.reason);
    const now = canonicalTimestamp(input.now, "now");

    return this.db.transaction(() => {
      const row = this.readRequired(input.repoId, input.runId);
      assertCredentials(row, input.generation, input.leaseToken);
      if (row.released_at !== null) {
        if (row.release_reason !== input.reason) {
          throw new TicketRunLeaseError(
            "release_conflict",
            "the Ticket run lease was already released for a different reason",
            {
              releasedAt: row.released_at,
              releaseReason: row.release_reason,
            },
          );
        }
        return { run: toPublic(row), alreadyReleased: true };
      }

      const changed = this.db.prepare(`
        UPDATE ticket_runs
        SET released_at=?, release_reason=?
        WHERE repo_id=? AND run_id=? AND lease_generation=?
          AND released_at IS NULL
      `).run(
        now,
        input.reason,
        input.repoId,
        input.runId,
        input.generation,
      );
      if (changed.changes !== 1) {
        throw new TicketRunLeaseError(
          "claim_conflict",
          "the Ticket run lease changed while it was being released",
        );
      }
      return {
        run: toPublic(this.readRequired(input.repoId, input.runId)),
        alreadyReleased: false,
      };
    }).immediate();
  }

  /** Exact binding lookup for outcome/closeout verification, including released runs. */
  get(input: GetTicketRunInput): TicketRunLease {
    validatePositiveInteger(input.repoId, "repoId");
    validateRequiredString(input.runId, "runId");
    validatePositiveInteger(input.generation, "generation");
    const row = this.readRequired(input.repoId, input.runId);
    if (row.lease_generation !== input.generation) {
      throw new TicketRunLeaseError(
        "stale_generation",
        "Ticket run lease generation is stale",
        {
          expectedGeneration: row.lease_generation,
          actualGeneration: input.generation,
        },
      );
    }
    return toPublic(row);
  }

  /** Validate a still-live bearer without extending or otherwise mutating it. */
  authorize(input: AuthorizeTicketRunInput): TicketRunLease {
    validateRepoRunCredentials(input);
    const now = canonicalTimestamp(input.now, "now");
    const row = this.readRequired(input.repoId, input.runId);
    assertCredentials(row, input.generation, input.leaseToken);
    if (row.released_at !== null) {
      throw new TicketRunLeaseError(
        "lease_released",
        "the Ticket run lease has already been released",
        { releasedAt: row.released_at, releaseReason: row.release_reason },
      );
    }
    if (row.expires_at <= now) {
      throw new TicketRunLeaseError(
        "lease_expired",
        "the Ticket run lease has expired",
        { expiresAt: row.expires_at },
      );
    }
    return toPublic(row);
  }

  /**
   * Validate the bearer and generation without requiring the lease to remain
   * active. Release uses this narrower primitive so an exact retry can return
   * the original terminal lease instead of failing before idempotency is
   * checked.
   */
  authenticate(
    input: Omit<AuthorizeTicketRunInput, "now">,
  ): TicketRunLease {
    validateRepoRunCredentials(input);
    const row = this.readRequired(input.repoId, input.runId);
    assertCredentials(row, input.generation, input.leaseToken);
    return toPublic(row);
  }

  listCurrent(input: ListCurrentTicketRunsInput): TicketRunLease[] {
    validatePositiveInteger(input.repoId, "repoId");
    const now = canonicalTimestamp(input.now, "now");
    const clauses = [
      "repo_id=?",
      "released_at IS NULL",
      "expires_at>?",
    ];
    const values: Array<string | number> = [input.repoId, now];
    for (const [column, value, name] of [
      ["worktree_identity", input.worktreeIdentity, "worktreeIdentity"],
      ["ticket_id", input.ticketId, "ticketId"],
      ["ticket_revision", input.ticketRevision, "ticketRevision"],
    ] as const) {
      if (value !== undefined) {
        validateRequiredString(value, name);
        clauses.push(`${column}=?`);
        values.push(value);
      }
    }
    const rows = this.db.prepare(`
      SELECT ${PUBLIC_COLUMNS}
      FROM ticket_runs
      WHERE ${clauses.join(" AND ")}
      ORDER BY worktree_identity,ticket_id,ticket_revision,claimed_at,run_id
    `).all(...values) as TicketRunRow[];
    return rows.map(toPublic);
  }

  private readRequired(repoId: number, runId: string): TicketRunRow {
    const row = this.db.prepare(`
      SELECT ${PUBLIC_COLUMNS}
      FROM ticket_runs
      WHERE repo_id=? AND run_id=?
    `).get(repoId, runId) as TicketRunRow | undefined;
    if (!row) {
      throw new TicketRunLeaseError(
        "run_not_found",
        "Ticket run lease was not found in this repository",
        { runId },
      );
    }
    return row;
  }
}

function toPublic(row: TicketRunRow): TicketRunLease {
  return {
    repoId: row.repo_id,
    worktreeIdentity: row.worktree_identity,
    runId: row.run_id,
    ticketId: row.ticket_id,
    ticketRevision: row.ticket_revision,
    contextBindingId: row.context_binding_id,
    contextBindingDigest: row.context_binding_digest,
    actor: row.actor,
    startSourceDigest: row.start_source_digest,
    startBranch: row.start_branch,
    startHeadSha: row.start_head_sha,
    generation: row.lease_generation,
    claimedAt: row.claimed_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
  };
}

function validateClaimInput(input: ClaimTicketRunInput): void {
  validatePositiveInteger(input.repoId, "repoId");
  for (const [value, name] of [
    [input.worktreeIdentity, "worktreeIdentity"],
    [input.ticketId, "ticketId"],
    [input.ticketRevision, "ticketRevision"],
    [input.contextBindingId, "contextBindingId"],
    [input.contextBindingDigest, "contextBindingDigest"],
    [input.actor, "actor"],
    [input.startSourceDigest, "startSourceDigest"],
    [input.startBranch, "startBranch"],
    [input.startHeadSha, "startHeadSha"],
  ] as const) {
    validateRequiredString(value, name);
  }
  validateLeaseSeconds(input.leaseSeconds);
}

function validateRepoRunCredentials(input: {
  repoId: number;
  runId: string;
  generation: number;
  leaseToken: string;
}): void {
  validatePositiveInteger(input.repoId, "repoId");
  validateRequiredString(input.runId, "runId");
  validatePositiveInteger(input.generation, "generation");
  validateRequiredString(input.leaseToken, "leaseToken");
}

function validateLeaseSeconds(value: number): void {
  if (
    !Number.isInteger(value)
    || value < MIN_TICKET_RUN_LEASE_SECONDS
    || value > MAX_TICKET_RUN_LEASE_SECONDS
  ) {
    throw new TicketRunLeaseError(
      "invalid_input",
      `leaseSeconds must be an integer between ${MIN_TICKET_RUN_LEASE_SECONDS} and ${MAX_TICKET_RUN_LEASE_SECONDS}`,
      { leaseSeconds: value },
    );
  }
}

function validateReleaseReason(value: string): asserts value is TicketRunReleaseReason {
  if (![
    "lease_released",
    "stale_binding",
    "superseded",
    "operator_cancelled",
  ].includes(value)) {
    throw new TicketRunLeaseError(
      "invalid_input",
      "release reason is not an operational Ticket run reason",
      { reason: value },
    );
  }
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TicketRunLeaseError(
      "invalid_input",
      `${name} must be a positive safe integer`,
      { [name]: value },
    );
  }
}

function validateRequiredString(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) {
    throw new TicketRunLeaseError(
      "invalid_input",
      `${name} must be a non-empty string of at most 2000 characters`,
    );
  }
}

function canonicalTimestamp(value: string, name: string): string {
  validateRequiredString(value, name);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new TicketRunLeaseError(
      "invalid_input",
      `${name} must be a canonical ISO-8601 timestamp`,
      { [name]: value },
    );
  }
  return value;
}

function leaseExpiry(now: string, leaseSeconds: number): string {
  validateLeaseSeconds(leaseSeconds);
  return new Date(Date.parse(now) + leaseSeconds * 1_000).toISOString();
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function assertCredentials(
  row: TicketRunRow,
  generation: number,
  token: string,
): void {
  if (row.lease_generation !== generation) {
    throw new TicketRunLeaseError(
      "stale_generation",
      "Ticket run lease generation is stale",
      { expectedGeneration: row.lease_generation, actualGeneration: generation },
    );
  }
  const expected = Buffer.from(row.token_hash, "hex");
  const actual = Buffer.from(hashToken(token), "hex");
  if (
    expected.length !== actual.length
    || !crypto.timingSafeEqual(expected, actual)
  ) {
    throw new TicketRunLeaseError(
      "invalid_token",
      "Ticket run lease bearer is invalid",
    );
  }
}
