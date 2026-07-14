import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { RuntimeService } from "../src/runtime-service.js";
import { resolveWorkbenchRepoRef } from "../src/runtime-service.js";
import { upsertRepo, writeSyncState } from "../src/team-store.js";
import { git, makeScratchRepo } from "./helpers.js";

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
