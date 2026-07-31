import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import {
  MAX_TICKET_RUN_LEASE_SECONDS,
  MIN_TICKET_RUN_LEASE_SECONDS,
  TicketRunLeaseError,
  TicketRunStore,
  type ClaimTicketRunInput,
} from "../src/ticket-run-store.js";

const T0 = "2026-07-30T20:00:00.000Z";

function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1_000).toISOString();
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(TicketRunLeaseError);
    expect(error).toMatchObject({ code });
  }
}

describe("TicketRunStore — disposable exact-binding leases", () => {
  let dir: string;
  let db: Db;
  let store: TicketRunStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-ticket-run-"));
    db = openDb(path.join(dir, "runtime.db"));
    db.prepare(`
      INSERT INTO repos(id,root_path,slug,default_branch,created_at)
      VALUES(1,?,'one','main',?),(2,?,'two','main',?)
    `).run(path.join(dir, "one"), T0, path.join(dir, "two"), T0);
    store = new TicketRunStore(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const input = (
    overrides: Partial<ClaimTicketRunInput> = {},
  ): ClaimTicketRunInput => ({
    repoId: 1,
    worktreeIdentity: "worktree-one",
    ticketId: "ticket-runtime",
    ticketRevision: "sha256:ticket-revision-one",
    contextBindingId: "context-binding-one",
    contextBindingDigest: "sha256:context-binding-one",
    actor: "codex",
    startSourceDigest: "sha256:source-one",
    startBranch: "feature/ticket-runtime",
    startHeadSha: "a".repeat(40),
    leaseSeconds: 60,
    now: T0,
    ...overrides,
  });

  it("stores only the bearer hash and rejects a concurrent exact claim", () => {
    const claim = store.claim(input());

    expect(claim).toMatchObject({
      repoId: 1,
      worktreeIdentity: "worktree-one",
      ticketId: "ticket-runtime",
      ticketRevision: "sha256:ticket-revision-one",
      contextBindingId: "context-binding-one",
      actor: "codex",
      generation: 1,
      claimedAt: T0,
      heartbeatAt: T0,
      expiresAt: at(60),
      releasedAt: null,
      releaseReason: null,
    });
    expect(claim.runId).toMatch(/^trn-[0-9a-f]{64}$/);
    expect(claim.leaseToken).toMatch(/^vht_[A-Za-z0-9_-]{43}$/);

    const stored = db.prepare(`
      SELECT token_hash tokenHash,* FROM ticket_runs
      WHERE repo_id=1 AND run_id=?
    `).get(claim.runId) as Record<string, unknown>;
    expect(stored["tokenHash"]).toBe(
      crypto.createHash("sha256").update(claim.leaseToken).digest("hex"),
    );
    expect(Object.values(stored)).not.toContain(claim.leaseToken);
    expect(Object.keys(stored)).not.toEqual(
      expect.arrayContaining(["status", "outcome", "evidence", "acceptance"]),
    );

    expectCode(
      () => store.claim(input({ actor: "another-agent", now: at(1) })),
      "claim_conflict",
    );
    expect(store.listCurrent({ repoId: 1, now: at(1) })).toHaveLength(1);
  });

  it("takes over only after expiry, increments generation, and retires the old bearer", () => {
    const first = store.claim(input());
    const second = store.claim(input({ actor: "recovery-agent", now: at(60) }));

    expect(second.generation).toBe(2);
    expect(second.runId).not.toBe(first.runId);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(db.prepare(`
      SELECT released_at releasedAt,release_reason releaseReason
      FROM ticket_runs WHERE repo_id=1 AND run_id=?
    `).get(first.runId)).toEqual({
      releasedAt: at(60),
      releaseReason: "expired_takeover",
    });

    expectCode(() => store.heartbeat({
      repoId: 1,
      runId: first.runId,
      generation: first.generation,
      leaseToken: first.leaseToken,
      leaseSeconds: 60,
      now: at(61),
    }), "lease_released");
    expectCode(() => store.heartbeat({
      repoId: 1,
      runId: second.runId,
      generation: second.generation,
      leaseToken: first.leaseToken,
      leaseSeconds: 60,
      now: at(61),
    }), "invalid_token");
    expect(store.listCurrent({ repoId: 1, now: at(61) }))
      .toEqual([expect.objectContaining({ runId: second.runId, generation: 2 })]);
  });

  it("heartbeats atomically with bounded duration and rejects stale credentials", () => {
    const claim = store.claim(input());
    const renewed = store.heartbeat({
      repoId: 1,
      runId: claim.runId,
      generation: claim.generation,
      leaseToken: claim.leaseToken,
      leaseSeconds: 90,
      now: at(30),
    });
    expect(renewed).toMatchObject({
      heartbeatAt: at(30),
      expiresAt: at(120),
    });
    expect(store.authorize({
      repoId: 1,
      runId: claim.runId,
      generation: claim.generation,
      leaseToken: claim.leaseToken,
      now: at(31),
    })).toMatchObject({
      heartbeatAt: at(30),
      expiresAt: at(120),
    });

    expectCode(() => store.heartbeat({
      repoId: 1,
      runId: claim.runId,
      generation: claim.generation + 1,
      leaseToken: claim.leaseToken,
      leaseSeconds: 60,
      now: at(31),
    }), "stale_generation");
    expectCode(() => store.heartbeat({
      repoId: 1,
      runId: claim.runId,
      generation: claim.generation,
      leaseToken: "vht_wrong",
      leaseSeconds: 60,
      now: at(31),
    }), "invalid_token");
    expectCode(() => store.heartbeat({
      repoId: 1,
      runId: claim.runId,
      generation: claim.generation,
      leaseToken: claim.leaseToken,
      leaseSeconds: 60,
      now: at(120),
    }), "lease_expired");

    expectCode(
      () => store.claim(input({
        leaseSeconds: MIN_TICKET_RUN_LEASE_SECONDS - 1,
        ticketRevision: "sha256:too-short",
      })),
      "invalid_input",
    );
    expectCode(
      () => store.claim(input({
        leaseSeconds: MAX_TICKET_RUN_LEASE_SECONDS + 1,
        ticketRevision: "sha256:too-long",
      })),
      "invalid_input",
    );
  });

  it("releases stale bindings idempotently but conflicts on a changed replay", () => {
    const claim = store.claim(input());
    const release = {
      repoId: 1,
      runId: claim.runId,
      generation: claim.generation,
      leaseToken: claim.leaseToken,
      reason: "stale_binding" as const,
      now: at(10),
    };
    expect(store.release(release)).toMatchObject({
      alreadyReleased: false,
      run: {
        releasedAt: at(10),
        releaseReason: "stale_binding",
      },
    });
    expect(store.release({ ...release, now: at(11) })).toMatchObject({
      alreadyReleased: true,
      run: { releasedAt: at(10), releaseReason: "stale_binding" },
    });
    expect(store.get({
      repoId: 1,
      runId: claim.runId,
      generation: claim.generation,
    })).toMatchObject({
      runId: claim.runId,
      releasedAt: at(10),
      releaseReason: "stale_binding",
    });
    expectCode(() => store.get({
      repoId: 1,
      runId: claim.runId,
      generation: claim.generation + 1,
    }), "stale_generation");
    expectCode(() => store.release({
      ...release,
      reason: "operator_cancelled",
      now: at(11),
    }), "release_conflict");
    expectCode(() => store.heartbeat({
      repoId: 1,
      runId: claim.runId,
      generation: claim.generation,
      leaseToken: claim.leaseToken,
      leaseSeconds: 60,
      now: at(11),
    }), "lease_released");

    const replacement = store.claim(input({ now: at(11) }));
    expect(replacement.generation).toBe(2);
  });

  it("isolates sibling worktrees, Ticket revisions, and repositories", () => {
    const one = store.claim(input());
    const sibling = store.claim(input({
      worktreeIdentity: "worktree-two",
      actor: "sibling-agent",
    }));
    const revision = store.claim(input({
      ticketRevision: "sha256:ticket-revision-two",
      actor: "next-revision-agent",
    }));
    const otherRepo = store.claim(input({
      repoId: 2,
      actor: "other-repo-agent",
    }));

    expect(new Set([one.runId, sibling.runId, revision.runId, otherRepo.runId]).size)
      .toBe(4);
    expect(store.listCurrent({ repoId: 1, now: at(1) })).toHaveLength(3);
    expect(store.listCurrent({
      repoId: 1,
      worktreeIdentity: "worktree-one",
      now: at(1),
    })).toHaveLength(2);
    expect(store.listCurrent({ repoId: 2, now: at(1) }))
      .toEqual([expect.objectContaining({ runId: otherRepo.runId })]);
  });

  it("listCurrent never projects released or expired ownership", () => {
    const expired = store.claim(input({ leaseSeconds: 15 }));
    const released = store.claim(input({
      ticketRevision: "sha256:released",
      leaseSeconds: 120,
    }));
    store.release({
      repoId: 1,
      runId: released.runId,
      generation: released.generation,
      leaseToken: released.leaseToken,
      reason: "lease_released",
      now: at(5),
    });

    expect(store.listCurrent({ repoId: 1, now: at(15) })).toEqual([]);
    expect(db.prepare(`
      SELECT released_at releasedAt FROM ticket_runs
      WHERE repo_id=1 AND run_id=?
    `).get(expired.runId)).toEqual({ releasedAt: null });
  });
});
