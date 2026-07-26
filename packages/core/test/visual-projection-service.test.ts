import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  addFootprint,
  coordinationPromptFor,
  defaultCornerSignalProjectionPath,
  insertConflict,
  openDb,
  RuntimeService,
  selectCornerSignalConflict,
  selectExactCheckoutTask,
  upsertRepo,
  upsertTask,
  VisualProjectionService,
  type Conflict,
  type Task,
} from "../src/index.js";
import { writeSyncState } from "../src/team-store.js";
import { makeScratchRepo } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-corner-signal-"));
  roots.push(root);
  return root;
}

function task(id: string, branch: string): Task {
  return {
    id,
    title: `Task ${id}`,
    state: "running",
    signalTier: "hooks",
    conflictIds: [],
    scopes: [],
    git: { branch },
    stateSince: "2026-07-25T12:00:00.000Z",
    lastEventAt: "2026-07-25T12:00:00.000Z",
  };
}

function conflict(
  id: string,
  severity: Conflict["severity"],
  detectedAt: string,
  taskIds: [string, string],
): Conflict {
  return {
    id,
    severity,
    detectedAt,
    taskIds,
    territoryId: "uncategorized",
    sharedSymbols: ["src/shared.ts"],
  };
}

describe("Corner Signal projection contract", () => {
  it("selects only a task bound to the exact checkout root", () => {
    const exact = { ...task("exact", "feat/exact"), git: { branch: "feat/exact", worktreePath: "/repo/wt" } };
    const other = { ...task("other", "feat/other"), git: { branch: "feat/other", worktreePath: "/repo/other" } };
    expect(selectExactCheckoutTask([other, exact], "/repo/wt")?.id).toBe("exact");
    expect(selectExactCheckoutTask([other], "/repo/wt")).toBeNull();
  });

  it("derives the default projection path from the effective-user home, not HOME", () => {
    const previous = process.env["HOME"];
    process.env["HOME"] = "/tmp/spoofed-home";
    try {
      expect(defaultCornerSignalProjectionPath()).toBe(path.join(
        os.userInfo().homedir,
        "Library",
        "Application Support",
        "VibeHub",
        "corner-signal-v1.json",
      ));
    } finally {
      if (previous === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previous;
    }
  });

  it("selects checkout-related, red, recent, then stable-id conflict evidence", () => {
    const conflicts = [
      conflict("yellow-current", "yellow", "2026-07-25T12:03:00.000Z", ["current", "b"]),
      conflict("red-other", "red", "2026-07-25T12:04:00.000Z", ["a", "b"]),
      conflict("red-current-old", "red", "2026-07-25T12:01:00.000Z", ["current", "a"]),
      conflict("red-current-new", "red", "2026-07-25T12:02:00.000Z", ["current", "b"]),
    ];
    expect(selectCornerSignalConflict(conflicts, "current")?.id).toBe("red-current-new");
    expect(selectCornerSignalConflict(conflicts, null)?.id).toBe("red-other");
  });

  it("builds deterministic prompt bytes only from canonical task and conflict facts", () => {
    const selected = conflict(
      "conflict-1",
      "red",
      "2026-07-25T12:00:00.000Z",
      ["task-a", "task-b"],
    );
    const pair = [task("task-a", "feat/a"), task("task-b", "feat/b")] as const;
    const first = coordinationPromptFor(selected, pair);
    expect(coordinationPromptFor(selected, pair)).toBe(first);
    expect(first).toContain("Task A: Task task-a [feat/a]");
    expect(first).toContain("- src/shared.ts");
    expect(first).not.toMatch(/[a-f0-9]{40}/u);
  });

  it("copies a real initialized-repo conflict and canonical ConflictCard atomically", () => {
    const scratch = makeScratchRepo();
    roots.push(scratch.root);
    const state = tempRoot();
    const dbPath = path.join(state, "workbench.db");
    const projectionPath = path.join(state, "Application Support", "corner-signal-v1.json");
    const now = "2026-07-25T12:00:00.000Z";
    const db = openDb(dbPath);
    const repo = upsertRepo(db, scratch.work, "scratch/repo", "main", now);
    writeSyncState(db, repo.id, {
      lastFetchAt: now,
      lastFetchOk: true,
      ghAvailable: false,
      repoFiles: 1,
      lastSyncedAt: now,
    });
    const branch = taskBranch(scratch.work);
    for (const input of [
      { id: "task-a", branch, worktreePath: scratch.work },
      { id: "task-b", branch: "feat/other", worktreePath: null },
    ]) {
      upsertTask(db, {
        id: input.id,
        repoId: repo.id,
        title: input.id === "task-a" ? "Current checkout" : "Other task",
        state: "running",
        signalTier: "hooks",
        branch: input.branch,
        worktreePath: input.worktreePath,
        prNumber: null,
        prState: null,
        stateSince: now,
        lastEventAt: now,
        statusDetail: null,
        createdAt: now,
        startHeadSha: null,
      });
    }
    insertConflict(db, repo.id, {
      id: "conflict-real",
      taskIds: ["task-a", "task-b"],
      territoryId: "uncategorized",
      sharedSymbols: ["shared"],
      severity: "red",
      detectedAt: now,
    }, ["src/shared.ts"]);
    addFootprint(db, repo.id, {
      taskId: "task-a",
      sessionId: null,
      path: "src/shared.ts",
      action: "edit",
      at: now,
    });
    addFootprint(db, repo.id, {
      taskId: "task-b",
      sessionId: null,
      path: "src/shared.ts",
      action: "edit",
      at: now,
    });
    db.close();

    const service = new VisualProjectionService({
      runtime: new RuntimeService({ dbPath, now: () => new Date(now) }),
      projectionPath,
      platform: "darwin",
      now: () => new Date(now),
      generation: () => "generation-real",
    });
    const first = service.refresh({ repoPath: scratch.work, host: "codex" });
    expect(first).toMatchObject({
      ok: true,
      changed: true,
      copied: true,
      snapshot: {
        schemaVersion: 1,
        generation: "generation-real",
        selectionMode: "last_writer_selected",
        availability: "partial",
        freshness: "live",
        identity: {
          data: {
            repoRoot: scratch.work,
            checkoutRoot: scratch.work,
            host: "codex",
            branch,
          },
        },
        signal: {
          data: {
            state: "conflict",
            conflict: { id: "conflict-real" },
            detail: {
              availability: "available",
              data: { symbols: [{ name: "shared", file: "src/shared.ts" }] },
            },
          },
        },
      },
    });
    expect(JSON.parse(fs.readFileSync(projectionPath, "utf8"))).toEqual(first.snapshot);
    expect(fs.statSync(projectionPath).mode & 0o777).toBe(0o600);
    expect(
      fs.readdirSync(path.dirname(projectionPath)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    expect(service.refresh({ repoPath: scratch.work, host: "codex" })).toMatchObject({
      ok: true,
      changed: false,
      copied: true,
    });
  });

  it("writes honest unavailable recovery instead of fixture content when runtime is missing", () => {
    const scratch = makeScratchRepo();
    roots.push(scratch.root);
    const state = tempRoot();
    const projectionPath = path.join(state, "corner-signal-v1.json");
    const now = "2026-07-25T12:00:00.000Z";
    const result = new VisualProjectionService({
      runtime: new RuntimeService({ dbPath: path.join(state, "missing.db") }),
      projectionPath,
      platform: "darwin",
      now: () => new Date(now),
    }).refresh({ repoPath: scratch.work, host: "claude-code" });

    expect(result).toMatchObject({
      ok: true,
      copied: true,
      snapshot: {
        availability: "partial",
        freshness: "unknown",
        signal: {
          availability: "unavailable",
          data: null,
          recovery: [{ code: "initialize_runtime" }],
        },
      },
    });
    expect(fs.existsSync(path.join(state, "missing.db"))).toBe(false);
  });

  it("reports a durability warning after rename without denying the committed copy", () => {
    const scratch = makeScratchRepo();
    roots.push(scratch.root);
    const state = tempRoot();
    const projectionPath = path.join(state, "corner-signal-v1.json");
    const result = new VisualProjectionService({
      runtime: new RuntimeService({ dbPath: path.join(state, "missing.db") }),
      projectionPath,
      platform: "darwin",
      generation: () => "generation-committed",
      writeFault: (phase) => {
        if (phase === "after_rename") throw new Error("fsync unavailable");
      },
    }).refresh({ repoPath: scratch.work, host: "codex" });
    expect(result).toMatchObject({
      ok: true,
      copied: true,
      warnings: [{ code: "durability_warning" }],
      snapshot: { generation: "generation-committed" },
    });
    expect(JSON.parse(fs.readFileSync(projectionPath, "utf8"))).toMatchObject({
      generation: "generation-committed",
    });
  });

  it("does not claim a copy when failure happens before rename", () => {
    const scratch = makeScratchRepo();
    roots.push(scratch.root);
    const state = tempRoot();
    const projectionPath = path.join(state, "corner-signal-v1.json");
    const result = new VisualProjectionService({
      runtime: new RuntimeService({ dbPath: path.join(state, "missing.db") }),
      projectionPath,
      platform: "darwin",
      writeFault: (phase) => {
        if (phase === "before_rename") throw new Error("rename denied");
      },
    }).refresh({ repoPath: scratch.work, host: "codex" });
    expect(result).toMatchObject({
      ok: false,
      copied: false,
      error: { code: "projection_write_failed" },
    });
    expect(fs.existsSync(projectionPath)).toBe(false);
  });

  it("rejects insecure projection targets and symlink ancestors", () => {
    const scratch = makeScratchRepo();
    roots.push(scratch.root);
    const state = tempRoot();
    const runtime = new RuntimeService({ dbPath: path.join(state, "missing.db") });

    const loose = path.join(state, "loose.json");
    fs.writeFileSync(loose, "{}\n", { mode: 0o644 });
    const looseResult = new VisualProjectionService({
      runtime, projectionPath: loose, platform: "darwin",
    }).refresh({ repoPath: scratch.work, host: "codex" });
    expect(looseResult).toMatchObject({
      ok: false,
      copied: false,
      error: { code: "projection_write_failed" },
    });

    const symlinkTarget = path.join(state, "target.json");
    fs.writeFileSync(symlinkTarget, "unchanged\n", { mode: 0o600 });
    const symlinkProjection = path.join(state, "projection-link.json");
    fs.symlinkSync(symlinkTarget, symlinkProjection);
    const symlinkResult = new VisualProjectionService({
      runtime, projectionPath: symlinkProjection, platform: "darwin",
    }).refresh({ repoPath: scratch.work, host: "codex" });
    expect(symlinkResult).toMatchObject({
      ok: false,
      copied: false,
      error: { code: "projection_write_failed" },
    });
    expect(fs.readFileSync(symlinkTarget, "utf8")).toBe("unchanged\n");

    const realDirectory = path.join(state, "real");
    fs.mkdirSync(realDirectory);
    const linkedDirectory = path.join(state, "linked");
    fs.symlinkSync(realDirectory, linkedDirectory, "dir");
    const linkedResult = new VisualProjectionService({
      runtime,
      projectionPath: path.join(linkedDirectory, "projection.json"),
      platform: "darwin",
    }).refresh({ repoPath: scratch.work, host: "codex" });
    expect(linkedResult).toMatchObject({
      ok: false,
      copied: false,
      error: { code: "projection_write_failed" },
    });
  });

  it("serializes writers with a bounded global projection lock", () => {
    const scratch = makeScratchRepo();
    roots.push(scratch.root);
    const state = tempRoot();
    const projectionPath = path.join(state, "corner-signal-v1.json");
    const lock = new Database(`${projectionPath}.coordination.sqlite`);
    lock.exec("BEGIN IMMEDIATE");
    try {
      const result = new VisualProjectionService({
        runtime: new RuntimeService({ dbPath: path.join(state, "missing.db") }),
        projectionPath,
        platform: "darwin",
        lockTimeoutMs: 1,
      }).refresh({ repoPath: scratch.work, host: "codex" });
      expect(result).toMatchObject({
        ok: false,
        copied: false,
        error: { code: "projection_write_failed" },
      });
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
  });
});

function taskBranch(repo: string): string {
  return spawnSync("git", ["branch", "--show-current"], {
    cwd: repo,
    encoding: "utf8",
    shell: false,
  }).stdout.trim();
}
