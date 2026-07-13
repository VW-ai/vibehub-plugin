import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db.js";
import {
  canonicalRepoPath,
  claimOffScopeReminder,
  matchesScopePattern,
  readScopePatterns,
  replaceScopePatterns,
} from "../src/scope-registry.js";
import { upsertRepo } from "../src/team-store.js";
import { upsertTask, type TaskRow } from "../src/activity-store.js";

const T0 = "2026-07-12T10:00:00.000Z";

const task: TaskRow = {
  id: "branch:feat/query", repoId: 1, title: "query", state: "running",
  signalTier: "hooks", branch: "feat/query", worktreePath: null,
  prNumber: null, prState: null, stateSince: T0, lastEventAt: T0,
  statusDetail: null, createdAt: T0, startHeadSha: "abc123",
};

describe("ScopeRegistry raw pattern facts", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-scope-"));
    db = openDb(path.join(dir, "t.db"));
    upsertRepo(db, "/repo", null, "main", T0);
    upsertTask(db, task);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stores canonical repo-relative globs and replaces atomically", () => {
    replaceScopePatterns(db, 1, task.id, "working on query", [
      { mode: "write", glob: "./workbench/packages/core/src/**", label: "core" },
      { mode: "read", glob: "META/21-workbench/*.md" },
    ]);
    expect(readScopePatterns(db, task.id)).toEqual([
      { mode: "write", glob: "workbench/packages/core/src/**", label: "core" },
      { mode: "read", glob: "META/21-workbench/*.md", label: null },
    ]);

    replaceScopePatterns(db, 1, task.id, "moved", [
      { mode: "write", glob: "workbench/packages/mcp/**" },
    ]);
    expect(readScopePatterns(db, task.id)).toHaveLength(1);
  });

  it("rejects absolute and parent-escaping patterns", () => {
    expect(() => canonicalRepoPath("/etc/passwd")).toThrow(/repo-relative/);
    expect(() => canonicalRepoPath("../outside.ts")).toThrow(/outside/);
    expect(canonicalRepoPath("./src\\查询.ts")).toBe("src/查询.ts");
  });

  it("matches *, ** and ? with one canonical implementation", () => {
    expect(matchesScopePattern("src/**/*.ts", "src/auth/login.ts")).toBe(true);
    expect(matchesScopePattern("src/*.ts", "src/auth/login.ts")).toBe(false);
    expect(matchesScopePattern("src/?.ts", "src/a.ts")).toBe(true);
    expect(matchesScopePattern("src/?.ts", "src/ab.ts")).toBe(false);
  });

  it("claims one off-scope reminder per declaration and resets on replace", () => {
    expect(claimOffScopeReminder(db, task.id, "src/other.ts", T0)).toBe(false);
    replaceScopePatterns(db, 1, task.id, "auth", [
      { mode: "write", glob: "src/auth/**" },
      { mode: "read", glob: "src/**" },
    ]);
    expect(claimOffScopeReminder(db, task.id, "src/auth/login.ts", T0)).toBe(false);
    expect(claimOffScopeReminder(db, task.id, "src/other.ts", T0)).toBe(true);
    expect(claimOffScopeReminder(db, task.id, "src/another.ts", T0)).toBe(false);

    replaceScopePatterns(db, 1, task.id, "expanded", [
      { mode: "write", glob: "src/auth/**" },
    ]);
    expect(claimOffScopeReminder(db, task.id, "src/other.ts", T0)).toBe(true);
  });
});
