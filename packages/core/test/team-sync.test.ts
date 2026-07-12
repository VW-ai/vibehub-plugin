import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db.js";
import { selectConflictCandidates, syncTeamSnapshot } from "../src/team-sync.js";
import type { TeamBranchRow } from "../src/team-store.js";
import {
  readBranchFiles,
  readConflicts,
  readSyncState,
  readTeamBranches,
} from "../src/team-store.js";
import { git, makeScratchRepo, type ScratchRepo } from "./helpers.js";

const T1 = new Date("2026-07-12T10:00:00.000Z");
const T2 = new Date("2026-07-12T11:00:00.000Z");

describe("selectConflictCandidates (并发才算撞, decision-project-020)", () => {
  const b = (name: string, over: Partial<TeamBranchRow> = {}): TeamBranchRow => ({
    name,
    headSha: "a".repeat(40),
    lastCommitAt: "2026-07-12T10:00:00.000Z",
    lastAuthor: "x",
    ahead: 1,
    behind: 0,
    merged: false,
    prNumber: null,
    prState: null,
    prTitle: null,
    ...over,
  });

  it("keeps unmerged branches with no PR or an open PR", () => {
    const picked = selectConflictCandidates([
      b("no-pr"),
      b("open-pr", { prNumber: 1, prState: "open" }),
    ]);
    expect(picked.map((x) => x.name)).toEqual(["no-pr", "open-pr"]);
  });

  it("drops merged branches and concluded PRs (closed/merged = not concurrent)", () => {
    const picked = selectConflictCandidates([
      b("merged", { merged: true }),
      b("pr-merged", { prNumber: 2, prState: "merged" }),
      b("pr-closed", { prNumber: 3, prState: "closed" }),
    ]);
    expect(picked).toEqual([]);
  });
});

describe("syncTeamSnapshot end-to-end on a scratch repo", () => {
  let repo: ScratchRepo;
  let dir: string;
  let db: Db;
  let repoId: number;

  beforeAll(() => {
    repo = makeScratchRepo();
    repo.pushBranch("feat/clean", [{ file: "src/clean.ts", content: "clean\n" }]);
    repo.pushBranch("feat/left", [{ file: "src/shared.ts", content: "left\n" }]);
    repo.pushBranch("feat/right", [{ file: "src/shared.ts", content: "right\n" }]);
    repo.pushBranch("feat/merged", [{ file: "docs/note.md", content: "note\n" }]);
    git(repo.work, "merge", "--no-ff", "feat/merged", "-m", "merge feat/merged");
    git(repo.work, "push", "origin", "main");

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-sync-"));
    db = openDb(path.join(dir, "test.db"));
  });
  afterAll(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    repo.cleanup();
  });

  it("writes the full snapshot in one pass (real fetch from local origin)", () => {
    const result = syncTeamSnapshot(db, repo.work, { now: () => T1 });
    repoId = result.repoId;

    expect(result.repoRoot).toBe(repo.work);
    expect(result.fetchOk).toBe(true);
    // scratch origin is a local path — gh has no GitHub repo to query, so PR
    // facts must degrade explicitly, never error (decision-github-004)
    expect(result.ghAvailable).toBe(false);
    expect(result.branches).toBe(4); // clean/left/right/merged (main excluded)
    expect(result.unmergedBranches).toBe(3);
    expect(result.conflictPairs).toBe(1); // left × right only
  });

  it("stores branch facts queryably", () => {
    const rows = readTeamBranches(db, repoId);
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("feat/merged")!.merged).toBe(true);
    expect(byName.get("feat/left")!.merged).toBe(false);
    expect(byName.get("feat/left")!.ahead).toBe(1);
    expect(byName.get("feat/left")!.lastAuthor).toBe("Test Author");
  });

  it("stores footprints for unmerged branches only", () => {
    expect(readBranchFiles(db, repoId, "feat/left")).toEqual([
      { path: "src/shared.ts", changeKind: "M" },
    ]);
    expect(readBranchFiles(db, repoId, "feat/merged")).toEqual([]);
  });

  it("stores the conflict pair in normalized order", () => {
    const rows = readConflicts(db, repoId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      branchA: "feat/left",
      branchB: "feat/right",
      path: "src/shared.ts",
    });
  });

  it("re-sync preserves conflict first_detected_at (age is honest)", () => {
    syncTeamSnapshot(db, repo.work, { now: () => T2 });
    const rows = readConflicts(db, repoId);
    expect(rows[0]!.firstDetectedAt).toBe(T1.toISOString());
    expect(rows[0]!.lastSeenAt).toBe(T2.toISOString());
  });

  it("a worktree path lands in the same repo domain (decision-github-004)", () => {
    const wt = path.join(repo.root, "sync-wt");
    git(repo.work, "worktree", "add", wt, "feat/clean");
    const result = syncTeamSnapshot(db, wt, { now: () => T2, skipFetch: true });
    expect(result.repoRoot).toBe(repo.work);
    expect(result.repoId).toBe(repoId);
  });

  it("records skipFetch honestly (no fake freshness)", () => {
    syncTeamSnapshot(db, repo.work, { now: () => T2, skipFetch: true });
    const state = readSyncState(db, repoId)!;
    expect(state.lastFetchAt).toBeNull();
    expect(state.lastFetchOk).toBeNull();
    expect(state.repoFiles).toBeGreaterThanOrEqual(2);
  });
});
