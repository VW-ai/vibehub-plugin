import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import {
  addFootprint,
  appendEvent,
  setScopes,
  upsertSession,
  upsertTask,
} from "../src/activity-store.js";
import { RuntimeService } from "../src/runtime-service.js";
import { resolveWorkbenchRepoRef } from "../src/runtime-service.js";
import { resolveLiveShellRepoRef } from "../src/runtime-service.js";
import { upsertRepo, writeSyncState } from "../src/team-store.js";
import { git, makeScratchRepo } from "./helpers.js";
import { replaceScopePatterns } from "../src/scope-registry.js";

const roots: string[] = [];
const makeRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-runtime-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("RuntimeService.readWorkbenchSnapshot", () => {
  it("reports a missing database without creating it", () => {
    const root = makeRoot();
    const dbPath = path.join(root, "missing.db");
    const result = new RuntimeService({ dbPath }).readWorkbenchSnapshot({
      repoKey: "example",
      repoRoot: "/repos/example",
    });

    expect(result.status).toBe("db_missing");
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("distinguishes an uninitialized repo from an unsynced repo", () => {
    const root = makeRoot();
    const dbPath = path.join(root, "workbench.db");
    const db = openDb(dbPath);
    db.close();
    const service = new RuntimeService({ dbPath });

    expect(
      service.readWorkbenchSnapshot({ repoKey: "example", repoRoot: "/repos/example" })
        .status,
    ).toBe("repo_uninitialized");

    const seeded = openDb(dbPath);
    upsertRepo(seeded, "/repos/example", "org/example", "main", new Date().toISOString());
    seeded.close();

    expect(
      service.readWorkbenchSnapshot({ repoKey: "example", repoRoot: "/repos/example" })
        .status,
    ).toBe("unsynced");
  });

  it("returns the real SQLite snapshot after sync", () => {
    const root = makeRoot();
    const dbPath = path.join(root, "workbench.db");
    const db = openDb(dbPath);
    const repo = upsertRepo(
      db,
      "/repos/example",
      "org/example",
      "main",
      "2026-07-12T00:00:00.000Z",
    );
    writeSyncState(db, repo.id, {
      lastFetchAt: "2026-07-12T00:00:00.000Z",
      lastFetchOk: true,
      ghAvailable: false,
      repoFiles: 3,
      lastSyncedAt: "2026-07-12T00:00:00.000Z",
    });
    db.close();

    const result = new RuntimeService({ dbPath }).readWorkbenchSnapshot({
      repoKey: "example",
      repoRoot: "/repos/example",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.repo.slug).toBe("org/example");
      expect(result.data.territories[0]?.name).toBe("Uncategorized");
    }
  });

  it("turns database/export failures into internal_error", () => {
    const root = makeRoot();
    const dbPath = path.join(root, "workbench.db");
    fs.writeFileSync(dbPath, "not sqlite");
    const result = new RuntimeService({ dbPath }).readWorkbenchSnapshot({
      repoKey: "example",
      repoRoot: "/repos/example",
    });
    expect(result.status).toBe("internal_error");
  });

  it("canonicalizes an explicit relative dot before reading an initialized repo", () => {
    const scratch = makeScratchRepo();
    roots.push(scratch.root);
    const stateRoot = makeRoot();
    const dbPath = path.join(stateRoot, "workbench.db");
    const db = openDb(dbPath);
    const repo = upsertRepo(
      db,
      scratch.work,
      "scratch/repo",
      "main",
      "2026-07-12T00:00:00.000Z",
    );
    writeSyncState(db, repo.id, {
      lastFetchAt: "2026-07-12T00:00:00.000Z",
      lastFetchOk: true,
      ghAvailable: false,
      repoFiles: 2,
      lastSyncedAt: "2026-07-12T00:00:00.000Z",
    });
    db.close();

    const previousCwd = process.cwd();
    try {
      process.chdir(scratch.work);
      const ref = resolveWorkbenchRepoRef(".", "relative-dot");
      expect(ref).toEqual({ repoKey: "relative-dot", repoRoot: scratch.work });
      expect(new RuntimeService({ dbPath }).readWorkbenchSnapshot(ref).status).toBe(
        "ok",
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("canonicalizes worktree and symlink paths to the initialized main repo", () => {
    const scratch = makeScratchRepo();
    roots.push(scratch.root);
    const worktree = path.join(scratch.root, "linked-worktree");
    git(scratch.work, "worktree", "add", "-b", "feat/linked", worktree);
    const symlink = path.join(scratch.root, "repo-link");
    fs.symlinkSync(worktree, symlink);

    const stateRoot = makeRoot();
    const dbPath = path.join(stateRoot, "workbench.db");
    const db = openDb(dbPath);
    const repo = upsertRepo(
      db,
      scratch.work,
      "scratch/repo",
      "main",
      "2026-07-12T00:00:00.000Z",
    );
    writeSyncState(db, repo.id, {
      lastFetchAt: "2026-07-12T00:00:00.000Z",
      lastFetchOk: true,
      ghAvailable: false,
      repoFiles: 2,
      lastSyncedAt: "2026-07-12T00:00:00.000Z",
    });
    db.close();

    const ref = resolveWorkbenchRepoRef(symlink);
    expect(ref.repoRoot).toBe(scratch.work);
    expect(new RuntimeService({ dbPath }).readWorkbenchSnapshot(ref).status).toBe(
      "ok",
    );
  });
});

describe("RuntimeService.readLiveShell", () => {
  it("returns identity while degrading missing activation and database sections", () => {
    const scratch = makeScratchRepo();
    roots.push(scratch.root);
    const root = makeRoot();
    const dbPath = path.join(root, "missing.db");
    const result = new RuntimeService({ dbPath }).readLiveShell({
      repoKey: "example",
      repoRoot: scratch.work,
      checkoutRoot: scratch.work,
      host: "codex",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.identity.data).toEqual({
        repoKey: "example",
        repoRoot: scratch.work,
        checkoutRoot: scratch.work,
        host: "codex",
      });
      expect(result.data.activation.availability).toBe("unavailable");
      expect(result.data.workspace.availability).toBe("unavailable");
      expect(fs.existsSync(dbPath)).toBe(false);
    }
  });

  it("reads task-scoped browser models and canonical receipts from SQLite", () => {
    const scratch = makeScratchRepo();
    roots.push(scratch.root);
    const root = makeRoot();
    const dbPath = path.join(root, "workbench.db");
    const db = openDb(dbPath);
    const repo = upsertRepo(
      db,
      scratch.work,
      "org/example",
      "main",
      "2026-07-19T10:00:00.000Z",
    );
    writeSyncState(db, repo.id, {
      lastFetchAt: "2026-07-19T11:59:00.000Z",
      lastFetchOk: true,
      ghAvailable: false,
      repoFiles: 2,
      lastSyncedAt: "2026-07-19T11:59:00.000Z",
    });
    upsertTask(db, {
      id: "task-live",
      repoId: repo.id,
      title: "Live task",
      state: "running",
      signalTier: "hooks",
      branch: "feat/live",
      worktreePath: scratch.work,
      prNumber: null,
      prState: null,
      stateSince: "2026-07-19T11:00:00.000Z",
      lastEventAt: "2026-07-19T11:30:00.000Z",
      statusDetail: null,
      createdAt: "2026-07-19T11:00:00.000Z",
      startHeadSha: null,
    });
    upsertSession(db, {
      id: "session-old",
      repoId: repo.id,
      taskId: "task-live",
      agent: "Codex",
      transcriptPath: null,
      startedAt: "2026-07-19T10:00:00.000Z",
      endedAt: "2026-07-19T10:30:00.000Z",
      endReason: "context_limit",
    });
    upsertSession(db, {
      id: "session-live",
      repoId: repo.id,
      taskId: "task-live",
      agent: "Codex",
      transcriptPath: null,
      startedAt: "2026-07-19T11:00:00.000Z",
      endedAt: "2026-07-19T11:45:00.000Z",
      endReason: "completed",
    });
    setScopes(db, repo.id, "task-live", [{
      mode: "write",
      territoryId: "uncategorized",
      label: "legacy-territory-scope",
    }]);
    replaceScopePatterns(db, repo.id, "task-live", "active", [{
      mode: "write",
      glob: "packages/core/src/**",
      label: "canonical-core",
    }]);
    addFootprint(db, repo.id, {
      taskId: "task-live",
      sessionId: "session-live",
      path: "packages/core/src/index.ts",
      action: "edit",
      at: "2026-07-19T11:20:00.000Z",
    });
    appendEvent(db, repo.id, "task-live", "session-live", {
      id: "event-1",
      type: "self_report",
      at: "2026-07-19T11:30:00.000Z",
      text: "Implemented the contract.",
    });
    const outcome = {
      ok: true,
      data: { healthy: true },
      meta: {
        operation: "kb.status",
        repoId: repo.id,
        requestId: "request-1",
        at: "2026-07-19T11:40:00.000Z",
      },
    };
    db.prepare(
      `INSERT INTO operation_request_receipts
       (repo_id, request_id, operation, payload_hash, outcome_kind, outcome, created_at)
       VALUES (?, ?, ?, ?, 'success', ?, ?)`,
    ).run(repo.id, "request-1", "kb.status", "hash", JSON.stringify(outcome), outcome.meta.at);
    db.close();

    const result = new RuntimeService({
      dbPath,
      now: () => new Date("2026-07-19T12:00:00.000Z"),
    }).readLiveShell({
      repoKey: "example",
      repoRoot: scratch.work,
      checkoutRoot: scratch.work,
      host: "codex",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.workspace.availability).toBe("partial");
      expect(result.data.workspace.data?.currentTask?.id).toBe("task-live");
      expect(result.data.workspace.data?.currentSession?.identity.agent).toBe("Codex");
      expect(result.data.workspace.data?.currentSession).toMatchObject({
        id: "session-live",
        lifecycle: "ended",
        endedAt: "2026-07-19T11:45:00.000Z",
        endReason: "completed",
        identity: {
          sessionOrdinal: 2,
          sessionCount: 2,
          previousEndReason: "context_limit",
        },
      });
      expect(result.data.workspace.data?.declaredScope).toEqual([{
        mode: "write",
        glob: "packages/core/src/**",
        label: "canonical-core",
      }]);
      expect(result.data.workspace.data?.observedFootprint).toEqual([{
        path: "packages/core/src/index.ts",
        access: "write",
        observedAt: "2026-07-19T11:20:00.000Z",
      }]);
      expect(result.data.workspace.data?.timeline).toHaveLength(1);
      expect(result.data.contextFeedback.data?.[0]?.kind).toBe("retrieval");
      expect(result.data.contextFeedback.data?.[0]?.receipt.outcome).toBe("returned");
      expect(result.data.contextFeedback.recovery[0]?.code).toBe("inspect_receipt_coverage");
    }
  });

  it("resolves symlinked worktrees and rejects mismatched repository identity", () => {
    const scratch = makeScratchRepo();
    roots.push(scratch.root);
    const worktree = path.join(scratch.root, "live-worktree");
    git(scratch.work, "worktree", "add", "-b", "feat/live-shell", worktree);
    const symlink = path.join(scratch.root, "live-link");
    fs.symlinkSync(worktree, symlink);

    expect(resolveLiveShellRepoRef(symlink, "codex", "example")).toEqual({
      repoKey: "example",
      repoRoot: scratch.work,
      checkoutRoot: worktree,
      host: "codex",
    });
    const result = new RuntimeService({
      dbPath: path.join(makeRoot(), "missing.db"),
    }).readLiveShell({
      repoKey: "example",
      repoRoot: worktree,
      checkoutRoot: worktree,
      host: "codex",
    });
    expect(result.status).toBe("internal_error");
  });
});
