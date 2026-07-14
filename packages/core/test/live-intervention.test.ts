import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  addFootprint,
  appendEvent,
  enqueueInjection,
  insertConflict,
  openDb,
  pendingInjections,
  readConflict,
  readTimeline,
  replaceScopePatterns,
  RuntimeService,
  upsertRepo,
  upsertTask,
} from "../src/index.js";
import { writeSyncState } from "../src/team-store.js";
import { makeScratchRepo } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const scratch = makeScratchRepo();
  roots.push(scratch.root);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-live-"));
  roots.push(state);
  const dbPath = path.join(state, "workbench.db");
  const db = openDb(dbPath);
  const now = "2026-07-12T12:00:00.000Z";
  const repo = upsertRepo(db, scratch.work, "scratch/repo", "main", now);
  writeSyncState(db, repo.id, {
    lastFetchAt: now, lastFetchOk: true, ghAvailable: false, repoFiles: 2, lastSyncedAt: now,
  });
  const task = (id: string, branch: string, state: "running" | "waiting" = "running") => upsertTask(db, {
    id, repoId: repo.id, title: id, state, signalTier: "hooks", branch,
    worktreePath: null, prNumber: null, prState: null, stateSince: now,
    lastEventAt: now, statusDetail: null, createdAt: now, startHeadSha: null,
  });
  task("task-a", "a"); task("task-b", "b");
  insertConflict(db, repo.id, {
    id: "conflict-1", taskIds: ["task-a", "task-b"], territoryId: "territory",
    sharedSymbols: ["shared"], severity: "red", detectedAt: now,
  }, ["src/shared.ts"]);
  addFootprint(db, repo.id, { taskId: "task-a", sessionId: null, path: "src/shared.ts", action: "edit", at: now });
  addFootprint(db, repo.id, { taskId: "task-b", sessionId: null, path: "src/shared.ts", action: "edit", at: now });
  db.close();
  return { dbPath, repo: { repoKey: "scratch/repo", repoRoot: scratch.work }, now };
}

describe("live read models", () => {
  it("reads empty task panels without fabricating a session", () => {
    const fx = setup();
    const result = new RuntimeService({ dbPath: fx.dbPath, now: () => new Date(fx.now) })
      .readTaskPanel(fx.repo, "task-a");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.session).toBeUndefined();
      expect(result.data.timeline).toEqual([]);
      expect(result.data.transcriptTail).toEqual([]);
    }
  });

  it("does not report an in-scope edit as twist evidence", () => {
    const fx = setup();
    const db = openDb(fx.dbPath);
    db.prepare(`DELETE FROM footprints WHERE task_id = ?`).run("task-a");
    replaceScopePatterns(db, 1, "task-a", "auth", [
      { mode: "write", glob: "src/auth/**" },
    ]);
    addFootprint(db, 1, {
      taskId: "task-a", sessionId: null, path: "src/auth/login.ts", action: "edit", at: fx.now,
    });
    addFootprint(db, 1, {
      taskId: "task-a", sessionId: null, path: "src/other.ts", action: "edit", at: fx.now,
    });
    db.close();

    const result = new RuntimeService({ dbPath: fx.dbPath, now: () => new Date(fx.now) })
      .readTaskPanel(fx.repo, "task-a");

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.twist?.offScopeFiles).toEqual(["src/other.ts"]);
    }
  });

  it("returns real two-sided symbol evidence without generating a diagnosis", () => {
    const fx = setup();
    const result = new RuntimeService({ dbPath: fx.dbPath, now: () => new Date(fx.now) })
      .readConflictDetail(fx.repo, "conflict-1");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.symbols[0]?.touches.map((touch) => touch.taskId)).toEqual(["task-a", "task-b"]);
      expect(result.data.diagnosis).toBeUndefined();
    }
  });

  it("returns large timelines intact and missing task ids as fatal not_found", () => {
    const fx = setup();
    const db = openDb(fx.dbPath);
    for (let i = 0; i < 1_100; i++) {
      appendEvent(db, 1, "task-a", null, {
        id: `event-${i}`, at: `2026-07-12T12:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
        type: "self_report", text: `event ${i}`,
      });
    }
    db.close();
    const service = new RuntimeService({ dbPath: fx.dbPath, now: () => new Date(fx.now) });
    const large = service.readTaskPanel(fx.repo, "task-a");
    expect(large.status === "ok" && large.data.timeline).toHaveLength(1_100);
    expect(service.readTaskPanel(fx.repo, "missing").status).toBe("not_found");
  });
});

describe("transactional interventions", () => {
  it("injects both sides atomically and makes requestId retries idempotent", () => {
    const fx = setup();
    const service = new RuntimeService({ dbPath: fx.dbPath, now: () => new Date(fx.now) });
    const intervention = { kind: "inject_both" as const, conflictId: "conflict-1", text: "Coordinate first." };
    const first = service.applyIntervention(fx.repo, "request-1", intervention);
    const second = service.applyIntervention(fx.repo, "request-1", intervention);
    expect(first.status).toBe("ok"); expect(second.status).toBe("ok");
    if (first.status === "ok" && second.status === "ok") {
      expect(first.data.outcome).toBe("applied");
      expect(first.data.injectionIds).toHaveLength(2);
      expect(second.data).toMatchObject({ outcome: "already_applied", injectionIds: first.data.injectionIds });
    }
    const db = openDb(fx.dbPath);
    expect(pendingInjections(db, "task-a")).toHaveLength(1);
    expect(pendingInjections(db, "task-b")).toHaveLength(1);
    expect(readTimeline(db, "task-a")).toEqual([
      expect.objectContaining({ type: "user_intervention", action: "inject" }),
    ]);
    expect(readTimeline(db, "task-b")).toEqual([
      expect.objectContaining({ type: "user_intervention", action: "inject" }),
    ]);
    db.close();
  });

  it("persists ignore deterministically, records both histories, and filters the pair", () => {
    const fx = setup();
    const result = new RuntimeService({ dbPath: fx.dbPath, now: () => new Date(fx.now) })
      .applyIntervention(fx.repo, "request-ignore", { kind: "ignore_pair", conflictId: "conflict-1" });
    expect(result.status).toBe("ok");
    const db = openDb(fx.dbPath);
    expect(readConflict(db, "conflict-1")).toBeNull();
    expect(readTimeline(db, "task-a")[0]).toMatchObject({ type: "user_intervention", action: "ignore" });
    expect(readTimeline(db, "task-b")[0]).toMatchObject({ type: "user_intervention", action: "ignore" });
    db.close();
  });

  it("scopes the same requestId independently to each repository", () => {
    const fx = setup();
    const db = openDb(fx.dbPath);
    const secondRoot = "/repos/second";
    const second = upsertRepo(db, secondRoot, "scratch/second", "main", fx.now);
    writeSyncState(db, second.id, { lastFetchAt: fx.now, lastFetchOk: true, ghAvailable: false, repoFiles: 1, lastSyncedAt: fx.now });
    upsertTask(db, {
      id: "task-second", repoId: second.id, title: "second", state: "running", signalTier: "hooks",
      branch: "second", worktreePath: null, prNumber: null, prState: null, stateSince: fx.now,
      lastEventAt: fx.now, statusDetail: null, createdAt: fx.now, startHeadSha: null,
    });
    db.close();
    const service = new RuntimeService({ dbPath: fx.dbPath, now: () => new Date(fx.now) });
    const first = service.applyIntervention(fx.repo, "same-request", { kind: "inject", taskId: "task-a", text: "first" });
    const otherRepo = { repoKey: "scratch/second", repoRoot: secondRoot };
    const secondResult = service.applyIntervention(otherRepo, "same-request", { kind: "inject", taskId: "task-second", text: "second" });
    expect(first.status === "ok" && first.data.outcome).toBe("applied");
    expect(secondResult.status === "ok" && secondResult.data.outcome).toBe("applied");
    const check = openDb(fx.dbPath);
    expect(check.prepare(`SELECT COUNT(*) AS n FROM intervention_requests WHERE request_id = 'same-request'`).get()).toEqual({ n: 2 });
    check.close();
  });

  it("returns a typed conflict when an intervention request changes action, target, or text", () => {
    const fx = setup();
    const service = new RuntimeService({ dbPath: fx.dbPath, now: () => new Date(fx.now) });
    const first = service.applyIntervention(fx.repo, "bound-intervention", { kind: "inject", taskId: "task-a", text: "first" });
    expect(first.status === "ok" && first.data.outcome).toBe("applied");
    expect(service.applyIntervention(fx.repo, "bound-intervention", { kind: "pause", taskId: "task-a", text: "first" })).toMatchObject({ status: "idempotency_conflict" });
    expect(service.applyIntervention(fx.repo, "bound-intervention", { kind: "inject", taskId: "task-b", text: "first" })).toMatchObject({ status: "idempotency_conflict" });
    expect(service.applyIntervention(fx.repo, "bound-intervention", { kind: "inject", taskId: "task-a", text: "changed" })).toMatchObject({ status: "idempotency_conflict" });
    expect(service.applyIntervention(fx.repo, "bound-intervention", { kind: "inject", taskId: "task-a", text: "first", contextLocus: "src/a.ts" })).toMatchObject({ status: "idempotency_conflict" });
    const check = openDb(fx.dbPath);
    expect(pendingInjections(check, "task-a")).toHaveLength(1);
    expect(pendingInjections(check, "task-b")).toHaveLength(0);
    check.close();
  });

  it("ignores a canonical branch pair across rich and basic equivalent conflicts", () => {
    const fx = setup();
    const db = openDb(fx.dbPath);
    db.prepare(
      `INSERT INTO team_conflicts (repo_id, branch_a, branch_b, path, first_detected_at, last_seen_at)
       VALUES (1, 'a', 'b', 'src/shared.ts', ?, ?)`,
    ).run(fx.now, fx.now);
    db.close();
    const service = new RuntimeService({ dbPath: fx.dbPath, now: () => new Date(fx.now) });
    const before = service.readWorkbenchSnapshot(fx.repo);
    expect(before.status === "ok" && before.data.conflicts.map((conflict) => conflict.id).sort())
      .toEqual(["conflict-1", "conflict:a|b"]);
    expect(before.status === "ok" && before.data.conflicts.find(
      (conflict) => conflict.id === "conflict:a|b",
    )?.taskIds).toEqual(["task-a", "task-b"]);
    const ignored = service.applyIntervention(fx.repo, "ignore-basic", { kind: "ignore_pair", conflictId: "conflict:a|b" });
    expect(ignored.status === "ok" && ignored.data.outcome).toBe("applied");
    const after = service.readWorkbenchSnapshot(fx.repo);
    expect(after.status === "ok" && after.data.conflicts).toEqual([]);
    expect(service.readConflictDetail(fx.repo, "conflict-1").status).toBe("not_found");
    expect(service.readConflictDetail(fx.repo, "conflict:a|b").status).toBe("not_found");
    const histories = openDb(fx.dbPath);
    expect(readTimeline(histories, "task-a")[0]).toMatchObject({ type: "user_intervention", action: "ignore" });
    expect(readTimeline(histories, "task-b")[0]).toMatchObject({ type: "user_intervention", action: "ignore" });
    histories.close();
  });

  it("returns explicit no-op and unsupported outcomes without queue writes", () => {
    const fx = setup();
    const db = openDb(fx.dbPath);
    const task = db.prepare(`UPDATE tasks SET state = 'waiting' WHERE id = 'task-a'`).run();
    expect(task.changes).toBe(1); db.close();
    const service = new RuntimeService({ dbPath: fx.dbPath, now: () => new Date(fx.now) });
    const paused = service.applyIntervention(fx.repo, "request-pause", { kind: "pause", taskId: "task-a", text: "wait" });
    const diagnosis = service.applyIntervention(fx.repo, "request-diag", { kind: "generate_diagnosis", conflictId: "conflict-1" });
    expect(paused.status === "ok" && paused.data.outcome).toBe("no_op");
    expect(diagnosis.status === "ok" && diagnosis.data.outcome).toBe("unsupported");
    const check = openDb(fx.dbPath);
    expect(pendingInjections(check, "task-a")).toHaveLength(0);
    check.close();
  });
});

describe("injection claim boundary", () => {
  it("has one successful emitter under overlapping worker-thread SQLite contention", async () => {
    const fx = setup();
    execFileSync("git", ["checkout", "-b", "a"], { cwd: fx.repo.repoRoot });
    const writer = openDb(fx.dbPath);
    enqueueInjection(writer, 1, "task-a", "inject", "once", fx.now);
    writer.close();
    const barrier = new SharedArrayBuffer(4);
    // Compile the current source into the test's scratch directory so worker
    // threads exercise this checkout, never an ignored/stale package dist.
    const workerDist = fs.mkdtempSync(path.join(import.meta.dirname, ".worker-core-"));
    roots.push(workerDist);
    execFileSync(process.execPath, [
      createRequire(import.meta.url).resolve("typescript/bin/tsc"),
      "-p", path.resolve(import.meta.dirname, "../tsconfig.build.json"),
      "--outDir", workerDist,
      "--declaration", "false",
    ]);
    const coreUrl = pathToFileURL(path.join(workerDist, "index.js")).href;
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { ingestHookEvent, openDb } = await import(workerData.coreUrl);
        const db = openDb(workerData.dbPath);
        parentPort.postMessage({ ready: true });
        Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
        const result = ingestHookEvent(db, 'PostToolUse', {
          session_id: workerData.sessionId,
          cwd: workerData.cwd,
          tool_name: 'Edit',
          tool_input: { file_path: 'src/shared.ts' },
        }, { now: () => new Date(workerData.now) });
        parentPort.postMessage({ output: result.output });
        db.close();
      })().catch((error) => {
        parentPort.postMessage({ error: error instanceof Error ? error.stack : String(error) });
      });
    `;
    const runs = [0, 1].map((index) => {
      let markReady!: () => void;
      let rejectReady!: (error: Error) => void;
      let resolveResult!: (output: unknown) => void;
      let rejectRun!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        markReady = resolve;
        rejectReady = reject;
      });
      const result = new Promise<unknown>((resolve, reject) => {
        resolveResult = resolve;
        rejectRun = reject;
      });
      void result.catch(() => {});
      const worker = new Worker(source, {
        eval: true,
        workerData: {
          dbPath: fx.dbPath, now: fx.now, cwd: fx.repo.repoRoot, coreUrl, barrier,
          sessionId: `claim-worker-${index}`,
        },
      });
      worker.on("message", (message: { ready?: boolean; output?: unknown; error?: string }) => {
        if (message.ready) markReady();
        else if (message.error) {
          const error = new Error(message.error);
          rejectReady(error);
          rejectRun(error);
        }
        else resolveResult(message.output);
      });
      worker.once("error", (error) => {
        rejectReady(error);
        rejectRun(error);
      });
      return { worker, ready, result };
    });
    await Promise.all(runs.map((run) => run.ready));
    Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0, 2);
    const outputs = await Promise.all(runs.map((run) => run.result));
    expect(outputs.filter(Boolean)).toEqual([
      expect.objectContaining({
        hookSpecificOutput: expect.objectContaining({ additionalContext: expect.stringContaining("once") }),
      }),
    ]);
    await Promise.all(runs.map((run) => run.worker.terminate()));
    const check = openDb(fx.dbPath);
    expect(readTimeline(check, "task-a")).toEqual([
      expect.objectContaining({ type: "user_injection", text: "once" }),
    ]);
    check.close();
  });
});
