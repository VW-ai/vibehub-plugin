import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db.js";
import {
  getRepoByRoot,
  readBranchFiles,
  readConflicts,
  readSyncState,
  readTeamBranches,
  reconcileConflicts,
  replaceBranchFiles,
  replaceTeamBranches,
  upsertRepo,
  writeSyncState,
} from "../src/team-store.js";

const T1 = "2026-07-12T10:00:00.000Z";
const T2 = "2026-07-12T11:00:00.000Z";

describe("team-store", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-store-"));
    db = openDb(path.join(dir, "test.db"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("upserts a repo idempotently and updates mutable facts", () => {
    const a = upsertRepo(db, "/repo", "owner/name", "main", T1);
    const b = upsertRepo(db, "/repo", "owner/renamed", "trunk", T2);
    expect(b.id).toBe(a.id);
    expect(getRepoByRoot(db, "/repo")).toEqual({
      id: a.id,
      rootPath: "/repo",
      slug: "owner/renamed",
      defaultBranch: "trunk",
    });
  });

  it("returns null for an unknown repo", () => {
    expect(getRepoByRoot(db, "/nope")).toBeNull();
  });

  it("round-trips sync state including nulls", () => {
    const { id } = upsertRepo(db, "/repo", null, "main", T1);
    const state = {
      lastFetchAt: null,
      lastFetchOk: null,
      ghAvailable: false,
      repoFiles: null,
      lastSyncedAt: T1,
    };
    writeSyncState(db, id, state);
    expect(readSyncState(db, id)).toEqual(state);

    const state2 = {
      lastFetchAt: T2,
      lastFetchOk: true,
      ghAvailable: true,
      repoFiles: 42,
      lastSyncedAt: T2,
    };
    writeSyncState(db, id, state2);
    expect(readSyncState(db, id)).toEqual(state2);
  });

  const branch = (name: string, over: object = {}) => ({
    name,
    headSha: "a".repeat(40),
    lastCommitAt: T1,
    lastAuthor: "someone",
    ahead: 1,
    behind: 0,
    merged: false,
    prNumber: null,
    prState: null,
    prTitle: null,
    ...over,
  });

  it("replaces the branch set wholesale", () => {
    const { id } = upsertRepo(db, "/repo", null, "main", T1);
    replaceTeamBranches(db, id, [branch("feat/a"), branch("feat/b")]);
    replaceTeamBranches(db, id, [
      branch("feat/b", { prNumber: 7, prState: "open", prTitle: "B!" }),
    ]);
    const rows = readTeamBranches(db, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "feat/b", prNumber: 7, prState: "open", prTitle: "B!" });
  });

  it("keeps repos separate (decision-project-025: 按 repo 分域)", () => {
    const r1 = upsertRepo(db, "/repo1", null, "main", T1);
    const r2 = upsertRepo(db, "/repo2", null, "main", T1);
    replaceTeamBranches(db, r1.id, [branch("feat/a")]);
    replaceTeamBranches(db, r2.id, [branch("feat/z")]);
    expect(readTeamBranches(db, r1.id).map((b) => b.name)).toEqual(["feat/a"]);
    expect(readTeamBranches(db, r2.id).map((b) => b.name)).toEqual(["feat/z"]);
  });

  it("round-trips branch files", () => {
    const { id } = upsertRepo(db, "/repo", null, "main", T1);
    replaceBranchFiles(db, id, [
      { branch: "feat/a", path: "src/x.ts", changeKind: "M" },
      { branch: "feat/a", path: "src/y.ts", changeKind: "A" },
      { branch: "feat/b", path: "src/x.ts", changeKind: "D" },
    ]);
    expect(readBranchFiles(db, id, "feat/a")).toEqual([
      { path: "src/x.ts", changeKind: "M" },
      { path: "src/y.ts", changeKind: "A" },
    ]);
    expect(readBranchFiles(db, id, "feat/b")).toEqual([
      { path: "src/x.ts", changeKind: "D" },
    ]);
  });

  it("preserves first_detected_at across re-syncs and prunes resolved pairs", () => {
    const { id } = upsertRepo(db, "/repo", null, "main", T1);
    reconcileConflicts(
      db,
      id,
      [
        { branchA: "feat/a", branchB: "feat/b", path: "src/x.ts" },
        { branchA: "feat/a", branchB: "feat/c", path: "src/y.ts" },
      ],
      T1,
    );
    // second sync: a×b still conflicts, a×c resolved
    reconcileConflicts(
      db,
      id,
      [{ branchA: "feat/a", branchB: "feat/b", path: "src/x.ts" }],
      T2,
    );
    const rows = readConflicts(db, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      branchA: "feat/a",
      branchB: "feat/b",
      path: "src/x.ts",
      firstDetectedAt: T1, // survived the re-sync
      lastSeenAt: T2,
    });
  });
});
