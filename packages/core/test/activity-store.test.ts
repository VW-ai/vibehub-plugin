import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db.js";
import { upsertRepo } from "../src/team-store.js";
import {
  addFootprint,
  appendEvent,
  claimPendingInjections,
  distinctEditedFileCount,
  enqueueInjection,
  hasEvent,
  insertConflict,
  lastHookEventAt,
  listTasks,
  notificationCountSince,
  readConflict,
  readDiagnosis,
  readScopes,
  readTask,
  readTimeline,
  recordNotification,
  saveDiagnosis,
  sessionIdentity,
  setScopes,
  upsertSession,
  upsertTask,
  type TaskRow,
} from "../src/activity-store.js";
import { addAnchor, upsertFeature } from "../src/graph-store.js";
import type { TimelineEvent } from "../src/contract/panel-types.js";
import type { Conflict } from "../src/contract/map-types.js";

const T = (m: number): string =>
  `2026-07-12T10:${String(m).padStart(2, "0")}:00.000Z`;

const task = (id: string, over: Partial<TaskRow> = {}): TaskRow => ({
  id,
  repoId: 1,
  title: `task ${id}`,
  state: "running",
  signalTier: "hooks",
  branch: `vibehub/${id}`,
  worktreePath: null,
  prNumber: null,
  prState: null,
  stateSince: T(0),
  lastEventAt: T(0),
  statusDetail: null,
  createdAt: T(0),
  ...over,
});

describe("ActivityStore (运行域)", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-act-"));
    db = openDb(path.join(dir, "t.db"));
    upsertRepo(db, "/repo", null, "main", T(0));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a task and updates in place", () => {
    upsertTask(db, task("t1"));
    upsertTask(db, task("t1", { state: "waiting", statusDetail: "Which pattern?" }));
    const r = readTask(db, "t1")!;
    expect(r.state).toBe("waiting");
    expect(r.statusDetail).toBe("Which pattern?");
    expect(listTasks(db, 1)).toHaveLength(1);
  });

  it("rejects a sixth state at the schema level (021: five states forever)", () => {
    expect(() =>
      upsertTask(db, task("bad", { state: "conflicted" as never })),
    ).toThrow(/CHECK/);
  });

  it("derives SessionIdentity — ordinal, count, previous end (never stored)", () => {
    upsertTask(db, task("t1"));
    upsertSession(db, {
      id: "s1", repoId: 1, taskId: "t1", agent: "Claude Code",
      transcriptPath: "/tmp/s1.jsonl", startedAt: T(1),
      endedAt: T(5), endReason: "context_limit",
    });
    upsertSession(db, {
      id: "s2", repoId: 1, taskId: "t1", agent: "Claude Code",
      transcriptPath: "/tmp/s2.jsonl", startedAt: T(6),
      endedAt: null, endReason: null,
    });
    expect(sessionIdentity(db, "t1", "s2")).toEqual({
      agent: "Claude Code",
      sessionOrdinal: 2,
      sessionCount: 2,
      previousEndedAt: T(5),
      previousEndReason: "context_limit",
    });
    expect(sessionIdentity(db, "t1", "s1")).toMatchObject({
      sessionOrdinal: 1,
      sessionCount: 2,
    });
    expect(sessionIdentity(db, "t1", "nope")).toBeNull();
  });

  it("round-trips every TimelineEvent member verbatim, in `at` order", () => {
    upsertTask(db, task("t1"));
    const events: TimelineEvent[] = [
      { id: "e1", at: T(1), type: "launch", prompt: "Refactor auth." },
      { id: "e2", at: T(2), type: "self_report", kicker: "Started.", text: "Reading the module." },
      { id: "e3", at: T(3), type: "file_read", count: 3, territoryName: "Storage Layer", inDeclaredScope: true },
      { id: "e4", at: T(4), type: "file_change", files: [{ path: "src/a.ts", offScope: false }, { path: "src/b.ts", offScope: true }] },
      { id: "e5", at: T(5), type: "test_run", passed: 12, failed: 1, note: "baseline before edits" },
      { id: "e6", at: T(6), type: "user_injection", mode: "inject", text: "Skip the legacy path." },
      { id: "e7", at: T(7), type: "agent_ack", text: "Will skip it.", ackOfEventId: "e6" },
      { id: "e8", at: T(8), type: "question", text: "Env-specific retries?", transitionTo: "waiting" },
      { id: "e9", at: T(9), type: "cross_read_notice", file: "src/shared.ts", otherTaskId: "t2", otherTaskTitle: "Batching" },
      { id: "e10", at: T(10), type: "commit", sha: "abc1234", message: "feat: retry", filesChanged: 4 },
      { id: "e11", at: T(11), type: "state_transition", from: "running", to: "waiting", cause: "Agent awaiting input" },
    ];
    // insert shuffled; read must come back chronological (contract)
    for (const e of [...events].reverse()) appendEvent(db, 1, "t1", null, e);
    expect(readTimeline(db, "t1")).toEqual(events);
  });

  it("hasEvent answers via the type column without parsing payloads", () => {
    upsertTask(db, task("t1"));
    expect(hasEvent(db, "t1", "launch")).toBe(false);
    appendEvent(db, 1, "t1", null, { id: "e1", at: T(1), type: "launch", prompt: "go" });
    expect(hasEvent(db, "t1", "launch")).toBe(true);
    expect(hasEvent(db, "t1", "commit")).toBe(false);
  });

  it("lastHookEventAt = max event timestamp per repo, null before any hook", () => {
    upsertTask(db, task("t1"));
    expect(lastHookEventAt(db, 1)).toBeNull();
    appendEvent(db, 1, "t1", null, { id: "e1", at: T(1), type: "launch", prompt: "go" });
    appendEvent(db, 1, "t1", null, { id: "e2", at: T(5), type: "self_report", text: "hi" });
    expect(lastHookEventAt(db, 1)).toBe(T(5));
  });

  it("counts distinct edited files in SQL (reads and repeats excluded)", () => {
    upsertTask(db, task("t1"));
    addFootprint(db, 1, { taskId: "t1", sessionId: null, path: "a.ts", action: "edit", at: T(1) });
    addFootprint(db, 1, { taskId: "t1", sessionId: null, path: "a.ts", action: "edit", at: T(2) });
    addFootprint(db, 1, { taskId: "t1", sessionId: null, path: "b.ts", action: "read", at: T(3) });
    expect(distinctEditedFileCount(db, "t1")).toBe(1);
  });

  it("derives scope filesTouched from footprints × anchors (never stored)", () => {
    upsertTask(db, task("t1"));
    upsertFeature(db, { id: "auth", repoId: 1, name: "Auth & Sessions", now: T(0) });
    addAnchor(db, { repoId: 1, featureId: "auth", file: "src/auth/login.ts" });
    addAnchor(db, { repoId: 1, featureId: "auth", file: "src/auth/token.ts" });
    setScopes(db, 1, "t1", [
      { mode: "write", territoryId: "auth", label: "auth" },
      { mode: "read", territoryId: "orders", label: "orders" },
    ]);

    // nothing touched yet → filesTouched absent (contract)
    expect(readScopes(db, "t1")).toEqual([
      { mode: "write", territoryId: "auth", label: "auth" },
      { mode: "read", territoryId: "orders", label: "orders" },
    ]);

    addFootprint(db, 1, { taskId: "t1", sessionId: null, path: "src/auth/login.ts", action: "edit", at: T(2) });
    addFootprint(db, 1, { taskId: "t1", sessionId: null, path: "src/auth/login.ts", action: "edit", at: T(3) }); // same file twice
    addFootprint(db, 1, { taskId: "t1", sessionId: null, path: "src/auth/token.ts", action: "read", at: T(4) }); // read ≠ touch
    const scopes = readScopes(db, "t1");
    expect(scopes[0]!.filesTouched).toBe(1); // distinct edited files only
    expect(scopes[1]!.filesTouched).toBeUndefined();
  });

  it("claims pending injections FIFO exactly once (018 注入队列)", () => {
    upsertTask(db, task("t1"));
    upsertTask(db, task("t2-other"));
    enqueueInjection(db, 1, "t1", "inject", "first", T(1));
    enqueueInjection(db, 1, "t1", "pause", "second", T(2));
    enqueueInjection(db, 1, "t2-other", "inject", "not ours", T(1));

    const claimed = claimPendingInjections(db, "t1", T(5));
    expect(claimed.map((c) => c.text)).toEqual(["first", "second"]);
    expect(claimed.map((c) => c.mode)).toEqual(["inject", "pause"]);
    // second claim: nothing — no double delivery
    expect(claimPendingInjections(db, "t1", T(6))).toEqual([]);
  });

  it("round-trips a Conflict preserving symbol order (contract invariant)", () => {
    upsertTask(db, task("t1"));
    upsertTask(db, task("t2"));
    const c: Conflict = {
      id: "c1",
      taskIds: ["t1", "t2"],
      territoryId: "orders",
      subBlockId: "orders/osm",
      sharedSymbols: ["OrderStateMachine.guards", "OrderStateMachine.retry"],
      severity: "red",
      detectedAt: T(3),
    };
    insertConflict(db, 1, c, ["src/orders/osm.ts", "src/orders/osm.ts"]);
    expect(readConflict(db, "c1")).toEqual(c);
    expect(readConflict(db, "nope")).toBeNull();
  });

  it("rejects misaligned symbol files", () => {
    upsertTask(db, task("t1"));
    upsertTask(db, task("t2"));
    const c: Conflict = {
      id: "c2", taskIds: ["t1", "t2"], territoryId: "x",
      sharedSymbols: ["a", "b"], severity: "yellow", detectedAt: T(1),
    };
    expect(() => insertConflict(db, 1, c, ["only-one.ts"])).toThrow(/align/);
  });

  it("derives diagnosis staleness from edits after diagnosedAt, reads never count", () => {
    upsertTask(db, task("t1"));
    upsertTask(db, task("t2"));
    const c: Conflict = {
      id: "c1", taskIds: ["t1", "t2"], territoryId: "orders",
      sharedSymbols: ["OSM.guards"], severity: "red", detectedAt: T(1),
    };
    insertConflict(db, 1, c, ["src/orders/osm.ts"]);
    saveDiagnosis(db, "c1", {
      verdict: "Same lock, two owners.",
      sides: [
        { taskId: "t1", label: "Auto-retry", doing: "adds `retry` guard" },
        { taskId: "t2", label: "Batching", doing: "reorders guards" },
      ],
      suggested: "Land t1 first; t2 rebases.",
      provenance: { diagnosedAt: T(5), engine: "claude-p-local" },
    });

    expect(readDiagnosis(db, "c1")!.stalenessEditsSince).toBe(0);

    // edit on the shared file AFTER diagnosis → stale +1; a read must not count
    addFootprint(db, 1, { taskId: "t1", sessionId: null, path: "src/orders/osm.ts", action: "edit", at: T(6) });
    addFootprint(db, 1, { taskId: "t2", sessionId: null, path: "src/orders/osm.ts", action: "read", at: T(7) });
    // edit BEFORE diagnosis must not count either
    addFootprint(db, 1, { taskId: "t1", sessionId: null, path: "src/orders/osm.ts", action: "edit", at: T(4) });
    const d = readDiagnosis(db, "c1")!;
    expect(d.stalenessEditsSince).toBe(1);
    expect(d.verdict).toBe("Same lock, two owners.");
    expect(d.sides[0]!.doing).toBe("adds `retry` guard");
  });

  it("keeps a notification ledger for the budget (020)", () => {
    recordNotification(db, 1, "conflict_red", "c1", T(1));
    recordNotification(db, 1, "conflict_red", "c2", T(5));
    expect(notificationCountSince(db, 1, T(0))).toBe(2);
    expect(notificationCountSince(db, 1, T(3))).toBe(1);
  });
});
