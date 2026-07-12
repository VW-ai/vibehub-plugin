import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db.js";
import { exportTeamMapFixture } from "../src/fixture-export.js";
import { UNCATEGORIZED_TERRITORY_ID } from "../src/contract/install-types.js";
import {
  reconcileConflicts,
  replaceBranchFiles,
  replaceTeamBranches,
  upsertRepo,
  writeSyncState,
  type TeamBranchRow,
} from "../src/team-store.js";

const T0 = "2026-07-11T09:00:00.000Z";
const T1 = "2026-07-12T10:00:00.000Z";
const NOW = new Date("2026-07-12T12:00:00.000Z");

const branch = (name: string, over: Partial<TeamBranchRow> = {}): TeamBranchRow => ({
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

describe("exportTeamMapFixture", () => {
  let dir: string;
  let db: Db;
  let repoId: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-fx-"));
    db = openDb(path.join(dir, "test.db"));
    repoId = upsertRepo(db, "/repo", "owner/name", "main", T1).id;
    writeSyncState(db, repoId, {
      lastFetchAt: T1,
      lastFetchOk: true,
      ghAvailable: true,
      repoFiles: 321,
      lastSyncedAt: T1,
    });
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws before any sync", () => {
    expect(() => exportTeamMapFixture(db, "/never-synced")).toThrow(/syncTeamSnapshot/);
  });

  it("maps unmerged branches to honest basic-tier stalled tasks", () => {
    replaceTeamBranches(db, repoId, [branch("feat/a")]);
    replaceBranchFiles(db, repoId, [
      { branch: "feat/a", path: "src/x.ts", changeKind: "M" },
      { branch: "feat/a", path: "src/y.ts", changeKind: "A" },
    ]);
    const fx = exportTeamMapFixture(db, "/repo", { now: () => NOW });

    expect(fx.capturedAt).toBe(NOW.toISOString());
    expect(fx.tasks).toHaveLength(1);
    const t = fx.tasks[0]!;
    expect(t).toMatchObject({
      id: "branch:feat/a",
      title: "feat/a",
      state: "stalled",
      signalTier: "basic",
      git: { branch: "feat/a" },
      stateSince: T1,
      lastEventAt: T1,
    });
    // basic tier: statusDetail must be absent, never synthesized
    expect(t.statusDetail).toBeUndefined();
    expect(t.scopes).toEqual([
      {
        mode: "write",
        territoryId: UNCATEGORIZED_TERRITORY_ID,
        label: "uncategorized",
        filesTouched: 2,
      },
    ]);
  });

  it("uses the PR title and marks merged PRs done", () => {
    replaceTeamBranches(db, repoId, [
      branch("feat/done", { merged: true, prNumber: 9, prState: "merged", prTitle: "Ship it" }),
    ]);
    const fx = exportTeamMapFixture(db, "/repo", { now: () => NOW });
    expect(fx.tasks[0]).toMatchObject({
      title: "Ship it",
      state: "done",
      git: { branch: "feat/done", prNumber: 9, prState: "merged" },
    });
  });

  it("hides merged branches that have no PR fact", () => {
    replaceTeamBranches(db, repoId, [branch("old/merged", { merged: true })]);
    const fx = exportTeamMapFixture(db, "/repo", { now: () => NOW });
    expect(fx.tasks).toHaveLength(0);
  });

  it("wires conflicts into both tasks and one Conflict record", () => {
    replaceTeamBranches(db, repoId, [branch("feat/a"), branch("feat/b")]);
    reconcileConflicts(
      db,
      repoId,
      [
        { branchA: "feat/a", branchB: "feat/b", path: "src/x.ts" },
        { branchA: "feat/a", branchB: "feat/b", path: "src/y.ts" },
      ],
      T0,
    );
    const fx = exportTeamMapFixture(db, "/repo", { now: () => NOW });

    expect(fx.conflicts).toHaveLength(1);
    expect(fx.conflicts[0]).toEqual({
      id: "conflict:feat/a|feat/b",
      taskIds: ["branch:feat/a", "branch:feat/b"],
      territoryId: UNCATEGORIZED_TERRITORY_ID,
      sharedSymbols: ["src/x.ts", "src/y.ts"],
      severity: "red",
      detectedAt: T0,
    });
    for (const t of fx.tasks) {
      expect(t.conflictIds).toEqual(["conflict:feat/a|feat/b"]);
    }
  });

  it("builds the one honest Uncategorized territory and occupancy", () => {
    replaceTeamBranches(db, repoId, [
      branch("feat/a"),
      branch("feat/done", { merged: true, prNumber: 9, prState: "merged", prTitle: "done today" }),
    ]);
    replaceBranchFiles(db, repoId, [
      { branch: "feat/a", path: "src/x.ts", changeKind: "M" },
    ]);
    const fx = exportTeamMapFixture(db, "/repo", { now: () => NOW });

    expect(fx.territories).toHaveLength(1);
    expect(fx.territories[0]).toMatchObject({
      id: UNCATEGORIZED_TERRITORY_ID,
      name: "Uncategorized",
      anchoredFileCount: 321,
      subBlocks: [],
    });
    expect(fx.territories[0]!.demoLayout).toBeDefined();

    expect(fx.occupancy).toHaveLength(1);
    const occ = fx.occupancy[0]!;
    expect(occ.writingTaskIds).toEqual(["branch:feat/a"]);
    // done same day as capturedAt → doneToday
    expect(occ.doneTodayTaskIds).toEqual(["branch:feat/done"]);
    expect(occ.readingTaskIds).toEqual([]);
  });

  it("labels staleness honestly from fetch state", () => {
    replaceTeamBranches(db, repoId, []);
    writeSyncState(db, repoId, {
      lastFetchAt: null,
      lastFetchOk: false,
      ghAvailable: false,
      repoFiles: 1,
      lastSyncedAt: T1,
    });
    const fx = exportTeamMapFixture(db, "/repo", { now: () => NOW });
    expect(fx.sync.stale).toBe(true);
    expect(fx.sync.lastHookEventAt).toBeNull();
  });

  it("hooks-tier local task WINS over the remote row for the same branch (024 join key)", async () => {
    const { upsertTask, addFootprint } = await import("../src/activity-store.js");
    replaceTeamBranches(db, repoId, [
      branch("feat/a", { prNumber: 5, prState: "open", prTitle: "PR title" }),
    ]);
    upsertTask(db, {
      id: "branch:feat/a", repoId, title: "feat/a",
      state: "waiting", signalTier: "hooks", branch: "feat/a",
      worktreePath: "/wt/feat-a", prNumber: null, prState: null,
      stateSince: T1, lastEventAt: T1,
      statusDetail: "Which retry pattern?", createdAt: T0,
    });
    addFootprint(db, repoId, { taskId: "branch:feat/a", sessionId: null, path: "src/x.ts", action: "edit", at: T1 });

    const fx = exportTeamMapFixture(db, "/repo", { now: () => NOW });
    expect(fx.tasks).toHaveLength(1);
    expect(fx.tasks[0]).toMatchObject({
      id: "branch:feat/a",
      state: "waiting", // the REAL hook state, not the basic-tier shim
      signalTier: "hooks",
      statusDetail: "Which retry pattern?",
      git: { branch: "feat/a", worktreePath: "/wt/feat-a", prNumber: 5, prState: "open" },
    });
    // footprint fallback scope (no MCP declaration yet)
    expect(fx.tasks[0]!.scopes).toEqual([
      { mode: "write", territoryId: UNCATEGORIZED_TERRITORY_ID, label: "uncategorized", filesTouched: 1 },
    ]);
  });

  it("local tasks on unpushed branches appear (hooks see them first)", async () => {
    const { upsertTask } = await import("../src/activity-store.js");
    replaceTeamBranches(db, repoId, []);
    upsertTask(db, {
      id: "branch:vibehub/local-only", repoId, title: "vibehub/local-only",
      state: "running", signalTier: "hooks", branch: "vibehub/local-only",
      worktreePath: null, prNumber: null, prState: null,
      stateSince: T1, lastEventAt: T1, statusDetail: null, createdAt: T0,
    });
    const fx = exportTeamMapFixture(db, "/repo", { now: () => NOW });
    expect(fx.tasks).toHaveLength(1);
    expect(fx.tasks[0]).toMatchObject({
      id: "branch:vibehub/local-only",
      state: "running",
      signalTier: "hooks",
      scopes: [], // no declaration, no footprint — nothing claimed
    });
  });

  it("reports repo header facts", () => {
    replaceTeamBranches(db, repoId, [branch("feat/a"), branch("feat/b")]);
    const fx = exportTeamMapFixture(db, "/repo", { now: () => NOW });
    expect(fx.repo).toEqual({
      slug: "owner/name",
      defaultBranch: "main",
      branchCount: 3, // 2 team branches + the default branch
    });
  });
});
